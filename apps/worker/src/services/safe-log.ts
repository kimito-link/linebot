// =============================================================================
// safe-log — 外部APIのレスポンスをログに出す前に、秘密らしき値を伏せる
// =============================================================================
//
// 【なぜ要るか】
// 外部APIがエラーを返したとき、原因を知るために本文をログへ出したくなる。
// だが本文には**こちらが送った値がそのまま反射されることがある**。
// 典型は OAuth のエラーで、リクエストのパラメータを含めて返す実装が珍しくない。
// そこに client_secret や Bearer トークンが載っていると、Workers Logs に
// 平文で残り、ログを読める全員に見えてしまう。
//
// 「このAPIは秘密を返さないはず」に賭けない。**出す直前に伏せる**。
// 相手の実装が変わってもこちらは壊れない。
//
// 【設計】
// - 完全性より取りこぼさないことを優先する。誤って伏せても調査は続けられるが、
//   漏れたものは取り消せない
// - 構造を壊さない。JSONらしさは残すので、どのフィールドで失敗したかは読める
// - 長さも制限する。ログの1行が数百KBになると他の行が読めなくなる

/** ログ1件に残す最大文字数。これを超える本文は切り詰める。 */
const MAX_LOG_CHARS = 800;

/**
 * 値を伏せる。先頭だけ残すのは、
 * 「どの鍵か」の見当がついた方が調査に役立つため（同じ鍵かの照合はできる）。
 */
function maskValue(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}***(${value.length})`;
}

/**
 * 秘密が入りやすいキー名。JSON・クエリ文字列の双方で使う。
 * 部分一致で見るので `client_secret` も `channelSecret` も拾う。
 */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|credential|api[-_]?key|authorization|auth|signature|private[-_]?key)/i;

/**
 * 外部APIのレスポンス本文を、ログに出して安全な形にする。
 *
 * 次を伏せる:
 * - JSON / クエリ文字列で、キー名が秘密らしいものの値
 * - 本文中に裸で現れる Bearer トークン
 * - JWT らしき文字列（ID トークンがそのまま返ることがある）
 *
 * @param body   レスポンス本文（await res.text() の結果）
 * @param extra  追加で伏せたい値（こちらが送った秘密など。反射対策）
 */
export function redactForLog(body: string, extra: readonly (string | undefined)[] = []): string {
  if (!body) return '';

  let out = body;

  // 1. こちらが送った秘密が反射されていたら、まず消す。
  //    キー名に頼らず値そのもので消せるので、これが最も確実。
  for (const secret of extra) {
    if (!secret || secret.length < 8) continue; // 短すぎる値は誤爆するので触らない
    out = out.split(secret).join(maskValue(secret));
  }

  // 2. JSON の "key": "value" 形式
  out = out.replace(
    /("(?:[^"\\]|\\.)*?"\s*:\s*)"((?:[^"\\]|\\.)*)"/g,
    (whole, prefix: string, value: string) =>
      SECRET_KEY_PATTERN.test(prefix) ? `${prefix}"${maskValue(value)}"` : whole,
  );

  // 3. クエリ文字列 / フォーム形式の key=value
  out = out.replace(
    /([A-Za-z0-9_.\-]+)=([^&\s"']+)/g,
    (whole, key: string, value: string) =>
      SECRET_KEY_PATTERN.test(key) ? `${key}=${maskValue(value)}` : whole,
  );

  // 4. 裸の Bearer トークン
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, (m) => `Bearer ${maskValue(m.slice(7))}`);

  // 4b. APIキーの体裁をした文字列。**キー名に頼らずに**消す。
  //
  // ここが無いと、こんな形で素通りする（実測で漏れた）:
  //   {"error":{"type":"authentication_error","message":"invalid api key: gsk-XXXX..."}}
  // "message" は秘密らしいキー名ではないので 2 のルールに引っかからない。
  //
  // 呼び出し側が extra に鍵を渡していれば 1 で消えるが、**渡し忘れたら漏れる**
  // 設計は脆い。値の形そのものでも捕まえる。
  // 既知の接頭辞（各社が公開しているもの）に限定するので、
  // 普通の英数字列を巻き込んで調査不能にすることはない。
  out = out.replace(
    /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9_-]{8,}|gsk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
    (m) => maskValue(m),
  );

  // 5. JWT らしき3セグメント（ID トークンがそのまま返ることがある）
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    (m) => maskValue(m),
  );

  // 6. 長さを制限する。1行が巨大だと他のログが読めなくなる。
  if (out.length > MAX_LOG_CHARS) {
    out = `${out.slice(0, MAX_LOG_CHARS)}…(${out.length}文字を切り詰め)`;
  }

  return out;
}

/**
 * レスポンスから本文を安全に読み出す。
 * 本文の読み取りに失敗してもログ出力のために例外を投げない
 * （ログを出そうとして落ちるのが一番困る）。
 */
export async function readBodyForLog(
  res: Response,
  extra: readonly (string | undefined)[] = [],
): Promise<string> {
  try {
    return redactForLog(await res.text(), extra);
  } catch {
    return '(本文を読めなかった)';
  }
}
