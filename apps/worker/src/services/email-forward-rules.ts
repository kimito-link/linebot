/**
 * 通知メールの振り分けルール。型・照合・保存先。
 *
 * 【なぜ automations に載せないか】
 * event-bus.ts の matchConditions は score_threshold / tag_id / keyword /
 * keyword_exact の4キーしか解釈せず、すべて payload.eventData.text を見る。
 * 「送信元が X かつ 件名が A と B を含む」は表現できない。だから別に持つ。
 *
 * 【なぜ新テーブルを作らないか】
 * ルールは数十件で、検索しない（毎回全件を上から評価するだけ）。編集は全置換。
 * テーブルにする利得がゼロなので account_settings の1キーにJSONで置く。
 *
 * 【★表現力を意図的に絞っている】
 * 正規表現・OR・NOT を入れない。送信元の部分一致と、件名の部分一致AND だけ。
 * automations が表現力を持て余して使われなかった失敗を繰り返さないため。
 * 足りなくなったらそのとき足す。
 */
import { getAccountSetting, setAccountSetting } from '@line-crm/db';

export const EMAIL_FORWARD_RULES_KEY = 'email_forward_rules';

export interface ForwardRule {
  /** 表示名。LINEの本文とログの見出しに使う。例: "ランサーズ" */
  site: string;
  /** xlsxのB列（元の差出人）。判定には match.from を使う */
  from: string;
  /** xlsxの原文件名。人が見て照合するためだけに持つ */
  subject: string;
  group: string;
  /** 転送範囲。'全文' | '件名' | それ以外（Phase 5 で対応） */
  scope: string;
  match: {
    /** 元差出人アドレスの部分一致キー。ドメインだけでもよい */
    from: string;
    /** 件名がこれを**全部**含むこと（AND・部分一致） */
    subjectContainsAll: string[];
  };
}

/**
 * 件名を比べる前にならす。
 * 全角空白・連続空白・NFKC の揺れで当たらなくなるのを防ぐ。
 * ★大文字小文字も畳む（英語の通知メールは件名の綴りが揺れることがある）。
 */
export function normalizeSubject(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Gmail転送が件名に付ける接頭辞を落とす。
 * 判定自体は部分一致ANDなので付いていても当たるが、表示のために剥がす。
 */
export function stripForwardPrefix(subject: string): string {
  return subject.replace(/^(\s*(fwd?|転送|fw)\s*[:：]\s*)+/i, '').trim();
}

/** 1件のルールに当たるか。送信元→件名の順で見る。 */
export function matches(rule: ForwardRule, originalFrom: string, subject: string): boolean {
  const f = originalFrom.toLowerCase();
  if (!rule.match?.from || !f.includes(rule.match.from.toLowerCase())) return false;
  const parts = rule.match.subjectContainsAll;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  const s = normalizeSubject(subject);
  return parts.every((p) => s.includes(normalizeSubject(p)));
}

/**
 * 当たった最初の1件を返す。配列の順＝優先順（並べ替えれば優先度が変わる）。
 * 当たらなければ null。★null は「捨てる」ではなく「未登録として通知する」の合図。
 */
export function findRule(
  rules: ForwardRule[],
  originalFrom: string,
  subject: string,
): ForwardRule | null {
  for (const r of rules) {
    if (matches(r, originalFrom, subject)) return r;
  }
  return null;
}

/**
 * ルールJSONの検証。壊れたものを保存させない。
 * ★沈黙するより弾く。壊れたルールを入れると全メールが未登録扱いになる。
 */
export function validateRules(input: unknown): { ok: true; rules: ForwardRule[] } | { ok: false; error: string } {
  const root = input as { rules?: unknown };
  const list = Array.isArray(input) ? input : root?.rules;
  if (!Array.isArray(list)) return { ok: false, error: 'rules が配列ではありません' };

  const out: ForwardRule[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] as Partial<ForwardRule>;
    if (!r || typeof r !== 'object') return { ok: false, error: `${i + 1}件目: オブジェクトではありません` };
    if (!r.match?.from) return { ok: false, error: `${i + 1}件目: match.from がありません` };
    if (!Array.isArray(r.match.subjectContainsAll) || r.match.subjectContainsAll.length === 0) {
      return { ok: false, error: `${i + 1}件目: match.subjectContainsAll が空です` };
    }
    // ★機密の混入を弾く。元xlsxの設定シートにChatwork APIトークンが平文であり、
    //   手で貼るときに紛れ込む事故を防ぐ。
    const asText = JSON.stringify(r);
    if (/[0-9a-f]{32}/i.test(asText)) {
      return { ok: false, error: `${i + 1}件目: APIトークンらしき文字列が含まれています` };
    }
    out.push({
      site: String(r.site ?? '通知'),
      from: String(r.from ?? r.match.from),
      subject: String(r.subject ?? ''),
      group: String(r.group ?? ''),
      scope: String(r.scope ?? '件名'),
      match: {
        from: String(r.match.from),
        subjectContainsAll: r.match.subjectContainsAll.map(String),
      },
    });
  }
  return { ok: true, rules: out };
}

/**
 * ルールを読む。
 * ★宛先が固定である以上アカウント選択に意味が無いので、先頭アカウントに紐づける。
 *   その事情を呼び出し側に漏らさないよう、ここに閉じ込める。
 */
export async function loadForwardRules(db: D1Database): Promise<ForwardRule[]> {
  const accountId = await resolveSettingsAccountId(db);
  if (!accountId) return [];
  const raw = await getAccountSetting(db, accountId, EMAIL_FORWARD_RULES_KEY);
  if (!raw) return [];
  try {
    const parsed = validateRules(JSON.parse(raw));
    return parsed.ok ? parsed.rules : [];
  } catch {
    // 壊れていても落とさない。0件として扱い、全部を未登録通知に回す（沈黙しない）。
    return [];
  }
}

export async function saveForwardRules(db: D1Database, rules: ForwardRule[]): Promise<void> {
  const accountId = await resolveSettingsAccountId(db);
  if (!accountId) throw new Error('LINEアカウントが1つも登録されていません');
  await setAccountSetting(db, accountId, EMAIL_FORWARD_RULES_KEY, JSON.stringify({ version: 1, rules }));
}

/** ルールを置くアカウント。account_settings が line_account_id NOT NULL のため要る。 */
async function resolveSettingsAccountId(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM line_accounts ORDER BY created_at ASC LIMIT 1`)
    .first<{ id: string }>();
  return row?.id ?? null;
}
