/**
 * ユーザーがLINEメッセージ内で共有したURLの本文を安全に取得しLLMコンテキストに
 * 変換する（2026-07-17 Fable設計「画像認識・URL認識機能」§2.2/§5）。
 *
 * fail-closed: ガード不通過・fetch失敗・タイムアウトのいずれもnullを返す。
 * 例外は外に投げない（incoming-image.tsと同じ流儀）。
 */

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localhost'];
const BLOCKED_HOSTS = new Set(['localhost']);

const MAX_REDIRECTS = 3;

export interface UrlContextEnv {
  WORKER_URL?: string;
  WORKER_PUBLIC_URL?: string;
  ADMIN_PUBLIC_URL?: string;
  LIFF_PUBLIC_URL?: string;
}

export interface FetchUrlContextOptions {
  timeoutMs: number;
  maxContentBytes: number;
  maxExtractChars: number;
  /** テスト注入用。省略時は globalThis.fetch。 */
  fetch?: typeof fetch;
}

/** incomingText中の最初のhttp(s) URLを抽出する。無ければnull。 */
export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0] : null;
}

function selfHostnames(env: UrlContextEnv): string[] {
  const urls = [env.WORKER_URL, env.WORKER_PUBLIC_URL, env.ADMIN_PUBLIC_URL, env.LIFF_PUBLIC_URL];
  const hosts: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try {
      hosts.push(new URL(u).hostname.toLowerCase());
    } catch {
      // 不正なURL設定値は無視（自己ホスト判定の対象外になるだけで安全側に倒れる）
    }
  }
  return hosts;
}

function isSubdomainOf(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

/**
 * fetch前のSSRFガード（allowリスト思想）。すべての条件をANDで満たした場合のみtrue。
 * §5のガード仕様1〜6を実装。7(リダイレクト)は呼び出し側でホップ毎に本関数を再適用する。
 */
export function isUrlAllowed(url: string, env: UrlContextEnv): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // 1. スキーム
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;

  // 2. userinfo拒否
  if (parsed.username !== '' || parsed.password !== '') return false;

  // 3. ポート
  if (parsed.port !== '' && parsed.port !== '80' && parsed.port !== '443') return false;

  const hostname = parsed.hostname.toLowerCase();

  // 4. IPリテラル拒否（保守的ルール: 英字を1文字も含まない、またはコロンを含む
  //    ホスト名は拒否。IPv4 dot表記・10進整数・8進・16進表記・IPv6を一律弾く）。
  if (hostname.includes(':') || !/[a-z]/i.test(hostname)) return false;

  // 5. ホスト名ブロックリスト
  if (BLOCKED_HOSTS.has(hostname)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) return false;

  // 6. 自分自身の拒否
  const selfHosts = selfHostnames(env);
  if (selfHosts.some((self) => isSubdomainOf(hostname, self))) return false;

  return true;
}

function resolveRedirectLocation(location: string, base: string): string | null {
  try {
    return new URL(location, base).toString();
  } catch {
    return null;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractMetaContent(html: string, property: string): string {
  // property/name いずれの属性順にも対応する2パターンを試す（例: <meta name="..." content="...">）。
  const patterns = [
    new RegExp(`<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*(?:property|name)=["']${property}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return decodeHtmlEntities(m[1]).trim();
  }
  return '';
}

/**
 * 本文テキストを正規表現ベースで抽出する（bounded: readCappedで既に512KB上限で
 * 打ち切り済みのテキストにのみ適用するため、巨大HTMLを丸ごとメモリに載せる問題は
 * 発生しない）。script/style/head を除去したbodyからタグを剥がして抽出する。
 */
function extractBodyText(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyHtml = bodyMatch ? bodyMatch[1] : html;
  const stripped = bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  return decodeHtmlEntities(stripped).trim();
}

/** title/OGP/本文テキストを抽出する。呼び出し元でmaxContentBytes分に既に打ち切り済みの文字列を渡す。 */
function extractTextFromHtml(html: string, maxExtractChars: number): string {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : '';
  const ogTitle = extractMetaContent(html, 'og:title');
  const ogDescription = extractMetaContent(html, 'og:description');
  const bodyText = extractBodyText(html);

  const parts = [
    title && `タイトル: ${title}`,
    ogTitle && `OGタイトル: ${ogTitle}`,
    ogDescription && `OG説明: ${ogDescription}`,
    bodyText && `本文: ${bodyText}`,
  ].filter(Boolean);
  return parts.join('\n').slice(0, maxExtractChars);
}

/**
 * SSRFガードを通過したURLのみ安全にfetchし、本文を抽出して返す。
 * 失敗・タイムアウト・ガード不通過はnull（fail-closed、console.warnのみ）。
 */
export async function fetchUrlContext(
  url: string,
  env: UrlContextEnv,
  options: FetchUrlContextOptions,
): Promise<string | null> {
  const fetcher = options.fetch ?? fetch;
  let currentUrl = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isUrlAllowed(currentUrl, env)) {
      console.warn('[url-context] blocked by SSRF guard', currentUrl);
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let res: Response;
    try {
      res = await fetcher(currentUrl, {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'user-agent': 'line-harness-bot/1.0 (+URL先取得; ユーザー共有リンクのプレビュー用)',
        },
      });
    } catch (err) {
      console.warn('[url-context] fetch failed', err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('Location');
      if (!location) return null;
      const next = resolveRedirectLocation(location, currentUrl);
      if (!next) return null;
      currentUrl = next;
      continue;
    }

    if (!res.ok) {
      console.warn('[url-context] non-200 response', res.status, currentUrl);
      return null;
    }

    const contentType = res.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (contentType !== 'text/html' && contentType !== 'text/plain') {
      console.warn('[url-context] unsupported content-type', contentType, currentUrl);
      return null;
    }

    const contentLengthHeader = res.headers.get('Content-Length');
    if (contentLengthHeader) {
      const declared = Number.parseInt(contentLengthHeader, 10);
      if (Number.isFinite(declared) && declared > options.maxContentBytes) {
        console.warn('[url-context] content too large (declared)', declared, currentUrl);
        return null;
      }
    }

    try {
      const capped = await readCapped(res, options.maxContentBytes);
      if (capped === null) return null;
      if (contentType === 'text/plain') return capped.slice(0, options.maxExtractChars);
      return extractTextFromHtml(capped, options.maxExtractChars);
    } catch (err) {
      console.warn('[url-context] extraction failed', err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  console.warn('[url-context] too many redirects', url);
  return null;
}

/** レスポンスボディを累計maxBytesで打ち切りながら読む（512KB上限のストリーミング実装）。 */
async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return await res.text();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
  }
  return text;
}
