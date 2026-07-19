/**
 * LINE Content APIから受信動画・音声バイナリを取得しR2に保存する
 * （2026-07-19動画・音声認識機能追加。incoming-image.tsと同じ設計）。
 */

const LINE_CONTENT_API_BASE = 'https://api-data.line.me/v2/bot/message';

const VIDEO_CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
};

const AUDIO_CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

export interface FetchAndStoreMediaOptions {
  r2: R2Bucket;
  /** workers 環境では globalThis.fetch を使う。テスト時に注入する。 */
  fetch?: typeof fetch;
  /** 公開 URL のベース (例: https://your-worker.your-subdomain.workers.dev) */
  workerUrl: string;
  channelAccessToken: string;
  accountId: string;
  messageId: string;
  /** LINE Content APIはmessage.typeを返さないため、拡張子解決テーブルの選択に呼び出し側から渡す。 */
  kind: 'video' | 'audio';
}

export interface IncomingMediaRefs {
  originalContentUrl: string;
  /** describe用にR2二度読みを避けるため、取得済みバイナリをそのまま返す。 */
  bytes: ArrayBuffer;
  contentType: string;
}

export interface IncomingMediaResult {
  refs: IncomingMediaRefs | null;
  /**
   * 失敗理由を人間可読な短文で返す（例: "unsupported content-type: audio/x-foo"）。
   * 呼び出し元がmessages_logの content フォールバックラベルに含められるようにし、
   * console.errorしか見られない環境でもD1クエリだけで実測値を確認できるようにする
   * （2026-07-20: 音声だけ無反応になる不具合の原因調査用）。
   */
  failureReason: string | null;
}

interface TranscodingStatusResponse {
  status?: 'processing' | 'succeeded' | 'failed';
}

// 動画・音声はLINE側でトランスコード処理が挟まり、webhook受信直後は
// status='processing'（未完了）のことがある（画像には無い、動画・音声特有の仕様。
// https://developers.line.biz/en/reference/messaging-api/#get-content-transcoding）。
// 完了を待たずgetMessageContentを呼ぶと404等で失敗するため、事前に状態を確認して
// 短時間ポーリングする。webhook全体の応答時間制約(REPLY_DEADLINE_MS=45秒)に収まるよう、
// 待機は控えめに抑える（2026-07-19実障害: 動画に一切反応しない不具合の調査で発覚）。
const TRANSCODING_POLL_INTERVAL_MS = 1500;
const TRANSCODING_POLL_MAX_ATTEMPTS = 6; // 最大 約9秒待つ

async function waitForTranscoding(
  fetcher: typeof fetch,
  messageId: string,
  channelAccessToken: string,
  kind: 'video' | 'audio',
): Promise<boolean> {
  for (let attempt = 0; attempt < TRANSCODING_POLL_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetcher(`${LINE_CONTENT_API_BASE}/${messageId}/content/transcoding`, {
        headers: { Authorization: `Bearer ${channelAccessToken}` },
      });
    } catch (err) {
      // トランスコード状態確認自体の失敗はfail-openにする（このAPIが無い/失敗しても
      // 本体取得を試す価値はあるため、ここでnullを返さずtrueとして先に進ませる）。
      console.warn('incoming-media: transcoding status fetch failed, proceeding anyway', { err, messageId, kind });
      return true;
    }

    if (!res.ok) {
      // 404等は「この機能が存在しない/対象外」の可能性もあるため、
      // fail-openで本体取得を試す（従来の非200ハンドリングに委ねる）。
      console.warn('incoming-media: transcoding status non-200, proceeding anyway', { status: res.status, messageId, kind });
      return true;
    }

    let body: TranscodingStatusResponse;
    try {
      body = await res.json();
    } catch {
      return true;
    }

    if (body.status === 'succeeded') return true;
    if (body.status === 'failed') {
      console.error('incoming-media: transcoding failed', { messageId, kind });
      return false;
    }
    // processing → 次の試行まで待つ（最後の試行では待たずループを抜ける）。
    if (attempt < TRANSCODING_POLL_MAX_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, TRANSCODING_POLL_INTERVAL_MS));
    }
  }
  console.warn('incoming-media: transcoding still processing after max attempts, proceeding anyway', { messageId, kind });
  return true;
}

/**
 * LINE Content API から incoming 動画/音声バイナリを取得し R2 に保存して URL を返す。
 * 失敗時は refs=null を返し、呼び出し元は `[動画]`/`[音声]` ラベルフォールバックを使う。
 * failureReason は診断用（messages_logのcontentフォールバックに残せる、2026-07-20追加）。
 */
export async function fetchAndStoreIncomingMedia(
  opts: FetchAndStoreMediaOptions,
): Promise<IncomingMediaResult> {
  const fetcher = opts.fetch ?? fetch;
  const extTable = opts.kind === 'video' ? VIDEO_CONTENT_TYPE_TO_EXT : AUDIO_CONTENT_TYPE_TO_EXT;

  const transcodingOk = await waitForTranscoding(fetcher, opts.messageId, opts.channelAccessToken, opts.kind);
  if (!transcodingOk) return { refs: null, failureReason: 'transcoding failed' };

  let res: Response;
  try {
    res = await fetcher(`${LINE_CONTENT_API_BASE}/${opts.messageId}/content`, {
      headers: { Authorization: `Bearer ${opts.channelAccessToken}` },
    });
  } catch (err) {
    console.error('incoming-media: fetch failed', { err, messageId: opts.messageId, accountId: opts.accountId, kind: opts.kind });
    return { refs: null, failureReason: 'content fetch threw' };
  }

  if (!res.ok) {
    console.error('incoming-media: non-200', { status: res.status, messageId: opts.messageId, accountId: opts.accountId, kind: opts.kind });
    return { refs: null, failureReason: `content fetch HTTP ${res.status}` };
  }

  const contentType = res.headers.get('Content-Type')?.split(';')[0].trim() ?? 'application/octet-stream';
  console.log('incoming-media: fetched content-type', { contentType, messageId: opts.messageId, kind: opts.kind });
  const ext = extTable[contentType];
  if (!ext) {
    console.error('incoming-media: unsupported content-type', { contentType, messageId: opts.messageId, accountId: opts.accountId, kind: opts.kind });
    return { refs: null, failureReason: `unsupported content-type: ${contentType}` };
  }
  const safeAccountId = opts.accountId.replace(/[^a-zA-Z0-9-]/g, '_');
  const safeMessageId = opts.messageId.replace(/[^a-zA-Z0-9-]/g, '_');
  const key = `incoming-${safeAccountId}-${safeMessageId}.${ext}`;

  let data: ArrayBuffer;
  try {
    data = await res.arrayBuffer();
  } catch (err) {
    console.error('incoming-media: arrayBuffer failed', { err, messageId: opts.messageId, accountId: opts.accountId, kind: opts.kind });
    return { refs: null, failureReason: 'arrayBuffer threw' };
  }

  try {
    await opts.r2.put(key, data, { httpMetadata: { contentType } });
  } catch (err) {
    console.error('incoming-media: R2 put failed', { err, messageId: opts.messageId, accountId: opts.accountId, kind: opts.kind });
    return { refs: null, failureReason: 'R2 put threw' };
  }

  const base = opts.workerUrl.replace(/\/$/, '');
  const url = `${base}/images/${key}`;
  return { refs: { originalContentUrl: url, bytes: data, contentType }, failureReason: null };
}
