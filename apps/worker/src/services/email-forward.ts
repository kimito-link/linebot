/**
 * 受け取った通知メールを LINE へ流す。
 *
 * ═══════════════════════════════════════════════════════════════
 * ★セキュリティ上いちばん大事なこと
 *
 *   送信先は getApprovalNotifyTargets()（＝運用者本人）に固定する。
 *   **メールの To / Cc / 本文から宛先を読む実装にしてはいけない。**
 *   メールの中身は送信者が自由に書けるので、偽メール1通で
 *   通知先を任意の相手にすり替えられてしまう。
 *
 *   （chatwork-approval-notify.ts に同じ禁止事項がある。理由も同じ。）
 * ═══════════════════════════════════════════════════════════════
 *
 * 【黙って捨てない】
 * ルールに当たらないメールも、解析できないメールも、記録して通知する。
 * 「届かなかったこと」に気づけないのが一番まずい。
 *
 * 【記録は送信の"後"】
 * 先に記録すると、送信に失敗したメールが「処理済み」になって永久に届かない。
 * 二重に届く方が、消えるよりましだと判断した。
 */
import PostalMime from 'postal-mime';
import { LineClient } from '@line-crm/line-sdk';
import { getEmailEventByMessageId, createEmailEvent, countTodayEvents } from '@line-crm/db';
import { getApprovalNotifyTargets } from './ai-shain-worker-task.js';
import { loadForwardRules, findRule, stripForwardPrefix } from './email-forward-rules.js';
import { resolveOriginalFrom, type FromSource } from './email-original-from.js';

/** LINE の1通の上限は5000字。余白を見て切る。 */
const MAX_BODY = 1500;
/** 未登録メールの通知は、同じ差出人・同じ件名で1日1回まで（メルマガ対策）。 */
const FALLBACK_PER_DAY = 1;

export interface EmailForwardEnv {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
}

export interface IncomingMail {
  /** エンベロープの from。★判定には使わない（転送で書き換わるため） */
  envelopeFrom: string;
  /** postal-mime が受け取れる形。Email Worker の message.raw はストリーム。 */
  raw: string | ArrayBuffer | Uint8Array | ReadableStream;
}

export interface ForwardResult {
  status: 'delivered' | 'unmatched' | 'parse_failed' | 'push_failed' | 'duplicate' | 'suppressed';
  ruleSite?: string | null;
  detail?: string;
}

/**
 * メール1通を処理する。**例外を投げない。**
 * ★throw すると Cloudflare が bounce を返し、送信元に「配送不能」が届いてしまう。
 */
export async function handleIncomingEmail(
  env: EmailForwardEnv,
  mail: IncomingMail,
): Promise<ForwardResult> {
  try {
    return await process(env, mail);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[email-forward] 予期しないエラー:', detail);
    return { status: 'parse_failed', detail };
  }
}

async function process(env: EmailForwardEnv, mail: IncomingMail): Promise<ForwardResult> {
  // ── 1. 解析 ──────────────────────────────────────────
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(mail.raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const id = `parse-failed:${await sha256(String(mail.envelopeFrom) + Date.now())}`;
    await notifyAndRecord(env, {
      messageId: id, status: 'parse_failed', detail,
      text: `解析できないメールが届きました\n差出人(封筒): ${mail.envelopeFrom}\n${detail}`,
    });
    return { status: 'parse_failed', detail };
  }

  const subjectRaw = parsed.subject ?? '(件名なし)';
  const subject = stripForwardPrefix(subjectRaw);

  // ── 2. 重複を弾く ────────────────────────────────────
  // Message-ID が無いメールも捨てない。内容から合成IDを作る。
  const messageId = parsed.messageId
    ? parsed.messageId
    : `no-msgid:${await sha256(`${mail.envelopeFrom}|${subjectRaw}|${parsed.date ?? ''}|${(parsed.text ?? '').slice(0, 512)}`)}`;

  if (await getEmailEventByMessageId(env.DB, messageId)) {
    return { status: 'duplicate' };
  }

  // ── 3. 本当の差出人を決める（★Gmail転送対策） ────────
  const origin = resolveOriginalFrom({
    from: addrOf(parsed.from),
    replyTo: addrOf(parsed.replyTo?.[0]),
    text: parsed.text ?? '',
    headers: headerMap(parsed.headers),
  });

  // ── 4. ルールに当てる ────────────────────────────────
  const rules = await loadForwardRules(env.DB);
  const rule = findRule(rules, origin.address, subject);

  if (!rule) {
    // ★捨てない。「知らない通知が来た」ことを知らせる（本文は出さない）。
    const already = await countTodayEvents(env.DB, origin.address, subject.slice(0, 40));
    if (already >= FALLBACK_PER_DAY) {
      await createEmailEvent(env.DB, {
        messageId, fromAddress: origin.address, fromSource: origin.source,
        subject, status: 'unmatched', detail: '本日は通知済みのため抑制',
      });
      return { status: 'suppressed' };
    }
    await notifyAndRecord(env, {
      messageId, status: 'unmatched',
      fromAddress: origin.address, fromSource: origin.source, subject,
      text: [
        '未登録の通知メールが届きました',
        `差出人: ${origin.address || '(不明)'}${sourceNote(origin.source)}`,
        `件名: ${subject.slice(0, 120)}`,
        '',
        'ルールを足すと、次から内容が届きます。',
      ].join('\n'),
    });
    return { status: 'unmatched' };
  }

  // ── 5. 本文を組み立てて送る ──────────────────────────
  const text = buildMessage(rule.site, rule.scope, origin, subject, parsed.text ?? '', parsed.attachments?.length ?? 0);
  return await notifyAndRecord(env, {
    messageId, status: 'delivered', ruleSite: rule.site,
    fromAddress: origin.address, fromSource: origin.source, subject, text,
  });
}

/** LINEへ送り、結果を記録する。★記録は送信の後（消えるより二重の方がまし）。 */
async function notifyAndRecord(
  env: EmailForwardEnv,
  p: {
    messageId: string;
    status: 'delivered' | 'unmatched' | 'parse_failed';
    text: string;
    ruleSite?: string | null;
    fromAddress?: string;
    fromSource?: FromSource;
    subject?: string;
    detail?: string;
  },
): Promise<ForwardResult> {
  // ★宛先は固定リストのみ。メールの中身は一切見ない。
  const targets = getApprovalNotifyTargets();
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;

  let delivered = 0;
  const failures: string[] = [];
  if (targets.length === 0) failures.push('通知先が未設定');
  else if (!token) failures.push('チャネルトークンが未設定');
  else {
    const client = new LineClient(token);
    for (const to of targets) {
      try {
        await client.pushTextMessage(to, p.text);
        delivered += 1;
      } catch (err) {
        failures.push(err instanceof Error ? err.message : String(err));
      }
    }
  }

  const failed = delivered === 0;
  const status = failed ? 'push_failed' : p.status;
  await createEmailEvent(env.DB, {
    messageId: p.messageId,
    fromAddress: p.fromAddress ?? null,
    fromSource: p.fromSource ?? null,
    subject: p.subject ?? null,
    ruleSite: p.ruleSite ?? null,
    status,
    detail: failed ? failures.join('; ') : (p.detail ?? `${delivered}件に配信`),
  });

  if (failed) console.error('[email-forward] LINEへ送れなかった:', failures.join('; '));
  return { status, ruleSite: p.ruleSite ?? null, detail: failures.join('; ') || undefined };
}

/** LINEに出す本文。scope が「全文」のときだけ本文を載せる。 */
function buildMessage(
  site: string,
  scope: string,
  origin: { address: string; source: FromSource },
  subject: string,
  body: string,
  attachments: number,
): string {
  const lines = [`【${site}】`, subject.slice(0, 200)];

  if (scope === '全文' && body.trim()) {
    const clean = body.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    lines.push('', clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY)}\n…(以下省略)` : clean);
  }

  const foot: string[] = [];
  if (attachments > 0) foot.push(`添付${attachments}件`);
  // ★推定で差出人を決めたときは、その旨を必ず出す（鵜呑みにさせない）
  if (origin.source === 'body-forwarded-block') foot.push('差出人は本文から推定');
  if (foot.length) lines.push('', `― ${foot.join(' / ')}`);

  return lines.join('\n');
}

function sourceNote(source: FromSource): string {
  return source === 'body-forwarded-block' ? '（本文から推定）' : '';
}

function addrOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  const o = v as { address?: string };
  return o.address ?? null;
}

function headerMap(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers as { key?: string; value?: string }[]) {
    if (h?.key) out[h.key.toLowerCase()] = String(h.value ?? '');
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
