/**
 * 「本当の差出人」を決める。
 *
 * 【なぜ要るか】
 * Gmail の自動転送は From: を**転送した本人**に書き換える。
 * つまりヘッダの From をそのまま信じると、noreply@lancers.co.jp を待っている
 * ルールに一生当たらない（全ルールが外れる）。
 *
 * 別リポジトリ resend.kimito-link.com の ImapConnector.php:276-295 が
 * 同じ問題を実運用で解いており、その判定順を移植した（PHPなのでコードは流用不可）。
 *
 * 【★セキュリティ上の限界を明記する】
 * ここで得た差出人は「どのルールに当てるか」と「LINEに何と表示するか」にしか使わない。
 * **宛先の決定には絶対に使わない。** 本文もヘッダも送信者が自由に書けるので、
 * これを信用して宛先を決めると、偽メール1通で通知先を乗っ取られる。
 */

export type FromSource =
  | 'x-forwarded-for'
  | 'reply-to'
  | 'body-forwarded-block'
  | 'header-from';

export interface OriginalFrom {
  address: string;
  source: FromSource;
}

/** メールアドレスらしき最初の1つを取り出す。 */
function firstAddress(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0] : null;
}

export interface MailLike {
  headers?: Record<string, string | undefined>;
  from?: string | null;
  replyTo?: string | null;
  text?: string | null;
}

/**
 * 優先順に見て、最初に取れたものを採用する。
 *
 * 1. 転送を示すヘッダ … 転送サービスが明示的に残したもの。最も確か
 * 2. Reply-To      … ランサーズ等は元アドレスが残ることが多い
 * 3. 本文の転送ブロック … Gmailが本文先頭に引用する元ヘッダ
 * 4. ヘッダの From  … 直送（転送を経由しない）ときのフォールバック
 */
export function resolveOriginalFrom(mail: MailLike): OriginalFrom {
  const h = mail.headers ?? {};

  // 1) 転送を示すヘッダ
  for (const key of ['x-original-from', 'x-original-sender', 'x-forwarded-for', 'x-forwarded-sender']) {
    const addr = firstAddress(h[key]);
    if (addr) return { address: addr, source: 'x-forwarded-for' };
  }

  // 2) Reply-To（ヘッダの From と違うときだけ意味がある）
  const replyTo = firstAddress(mail.replyTo ?? h['reply-to']);
  const headerFrom = firstAddress(mail.from ?? h['from']);
  if (replyTo && replyTo.toLowerCase() !== (headerFrom ?? '').toLowerCase()) {
    return { address: replyTo, source: 'reply-to' };
  }

  // 3) 本文先頭の転送ブロック。★日本語Gmailは見出しも項目名も日本語になる
  const fromBody = extractFromForwardedBlock(mail.text ?? '');
  if (fromBody) return { address: fromBody, source: 'body-forwarded-block' };

  // 4) 直送
  if (headerFrom) return { address: headerFrom, source: 'header-from' };
  return { address: '', source: 'header-from' };
}

/**
 * Gmail が本文先頭に入れる転送ブロックから差出人を取る。
 *
 *   ---------- Forwarded message ---------
 *   From: 名前 <addr@example.com>
 *
 * 日本語UIだと:
 *
 *   ---------- 転送されたメッセージ ----------
 *   差出人: 名前 <addr@example.com>
 */
export function extractFromForwardedBlock(body: string): string | null {
  if (!body) return null;
  // 転送ブロックの開始位置を探す（無ければ本文全体を対象にしない＝誤検出を避ける）
  const marker = body.search(/-{3,}\s*(Forwarded message|転送されたメッセージ)\s*-{3,}/i);
  if (marker < 0) return null;

  // ブロック直後の1000字だけを見る。遠くにある無関係なアドレスを拾わないため。
  const window = body.slice(marker, marker + 1000);
  const line = window.match(/^\s*(?:From|差出人|送信元)\s*[:：]\s*(.+)$/mi);
  return line ? firstAddress(line[1]) : null;
}
