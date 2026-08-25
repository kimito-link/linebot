// =============================================================================
// 音声返信 — テキスト応答を「キャラクターの声」でLINEに返す
// =============================================================================
//
// 【なぜこの形なのか】
// LINEの音声メッセージは m4a(AAC) しか受理しない（mp3/wav不可、HTTPS必須、
// duration=ミリ秒）。一方 Cloudflare Workers 上では AAC エンコードができない
// （ffmpeg.wasmは約31MBでバンドル上限10MBを超え、実行時WASM取得も禁止、
// メモリ128MB/CPU時間の制約もある）。
// つまり「声を作ってm4aにする」役はWorkerの外に置くほかない。
//
// そこで合成役を VoiceSynthesizer というインターフェースの裏に隠してある。
// 今はどの実装を選んでも、10年後に別の手段へ乗り換えても、呼び出し側
// （webhook.ts）は一切書き換えなくてよい。差し替えたいときは
// createSynthesizer() に実装を1つ足すだけで済む。
//
// 【ユーザー体験の原則】
// 音声化は"おまけ"であって、届くことの方が大事。合成が失敗・遅延・未設定でも
// 必ずテキストで返す（無言で放置しない）。この判断は呼び出し側ではなく
// replyWithVoice() の中で完結させ、呼び忘れによる無言化を構造的に防ぐ。

import type { LineClient } from '@line-crm/line-sdk';

/** 合成結果。m4aのバイト列と、LINEに渡す再生時間(ミリ秒)。 */
export interface SynthesizedVoice {
  /** m4a(AAC)のバイト列。LINEはこれ以外を受理しない。 */
  m4a: ArrayBuffer;
  /** 再生時間(ミリ秒)。LINEの audio message の duration にそのまま渡す。 */
  durationMs: number;
}

/**
 * 音声合成の抽象。実装を差し替えても呼び出し側は変えなくてよい。
 *
 * 実装を足すときの約束:
 * - 返すのは必ず m4a(AAC)。mp3/wav/PCMをそのまま返さない（LINEが弾く）。
 * - 失敗は null を返す（例外を投げない）。呼び出し側はテキストへフォールバックする。
 * - 目安として15秒以内に返す。超えるならnullを返して諦める方がユーザーには親切
 *   （黙って待たされるより、テキストで早く届く方がよい）。
 */
export interface VoiceSynthesizer {
  /** 実装の識別子。ログに残して「どの経路で合成したか」を後から追えるようにする。 */
  readonly name: string;
  synthesize(text: string, speakerId: number): Promise<SynthesizedVoice | null>;
}

/**
 * 外部の合成サーバーを叩く実装。
 *
 * サーバー側に求める契約はごく小さい（POST 1本）ので、VOICEVOX+ffmpegでも、
 * クラウドTTS+変換でも、将来の別物でも、この契約さえ満たせば差し替えられる:
 *
 *   POST {endpoint}
 *   Content-Type: application/json
 *   { "text": "...", "speakerId": 14 }
 *   →  200 audio/mp4 (m4aのバイト列)
 *      ヘッダ X-Duration-Ms に再生時間(ミリ秒)
 *
 * 認証はBearerトークン。エンドポイントを公開する以上、無認証にはしない。
 */
class HttpVoiceSynthesizer implements VoiceSynthesizer {
  readonly name = 'http';

  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly timeoutMs: number,
  ) {}

  async synthesize(text: string, speakerId: number): Promise<SynthesizedVoice | null> {
    // タイムアウトで必ず打ち切る。待たせ続けるくらいならテキストで返す方がよい。
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ text, speakerId }),
        signal: abort.signal,
      });
      if (!res.ok) {
        console.warn('[voice-reply] synthesizer returned non-OK', res.status);
        return null;
      }

      const m4a = await res.arrayBuffer();
      if (m4a.byteLength === 0) {
        console.warn('[voice-reply] synthesizer returned empty body');
        return null;
      }

      // durationはサーバーが返すのを正とし、無ければ実測できないので推定に落とす。
      // 推定がズレてもLINEは再生してくれるが、シークバーの表示が狂うので
      // サーバー側で正確に返すのが望ましい。
      const header = res.headers.get('x-duration-ms');
      const durationMs = header ? Number(header) : estimateDurationMs(text);
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return { m4a, durationMs: estimateDurationMs(text) };
      }
      return { m4a, durationMs: Math.round(durationMs) };
    } catch (err) {
      // AbortErrorも含めてここで飲み込む。呼び出し側はテキストで返すので実害はない。
      console.warn(
        '[voice-reply] synthesize failed',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 再生時間の推定（サーバーが実測値を返さなかったときの保険）。
 * 日本語の自然な読み上げを1秒あたり約6文字として概算する。
 */
export function estimateDurationMs(text: string): number {
  const CHARS_PER_SEC = 6;
  const seconds = Math.max(1, text.length / CHARS_PER_SEC);
  return Math.round(seconds * 1000);
}

export interface VoiceReplyEnv {
  /** 合成サーバーのURL。未設定なら音声機能はオフ。 */
  VOICE_SYNTH_ENDPOINT?: string;
  /** 合成サーバーのBearerトークン。未設定なら音声機能はオフ。 */
  VOICE_SYNTH_TOKEN?: string;
  /** 合成の打ち切り時間(ミリ秒)。既定15000。 */
  VOICE_SYNTH_TIMEOUT_MS?: string;
  /** 誰の声で返すか（'tanunee' | 'link' | 'konta'）。既定はたぬ姉。 */
  VOICE_CHARACTER?: string;
}

/**
 * 環境変数から合成役を組み立てる。未設定なら null（＝音声機能オフ）。
 * 設定漏れでいきなり壊れるのではなく、単に「テキストで返すだけ」に静かに戻る。
 */
export function createSynthesizer(env: VoiceReplyEnv): VoiceSynthesizer | null {
  const endpoint = env.VOICE_SYNTH_ENDPOINT?.trim();
  const token = env.VOICE_SYNTH_TOKEN?.trim();
  if (!endpoint || !token) return null;

  const timeoutMs = Number(env.VOICE_SYNTH_TIMEOUT_MS ?? '15000');
  return new HttpVoiceSynthesizer(
    endpoint,
    token,
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000,
  );
}

/** キャラクターごとの声。ouenmovie/whc-it/script_vertical.py の VOICE 辞書が正本。 */
export const CHARACTER_SPEAKER_ID = {
  /** たぬ姉（冥鳴ひまり） */
  tanunee: 14,
  /** りんく（春日部つむぎ） */
  link: 8,
  /** こん太（白上虎太郎・わーい） */
  konta: 32,
} as const;

export type CharacterKey = keyof typeof CHARACTER_SPEAKER_ID;

/**
 * 合成した音声をR2に置いて、LINEから取得できるHTTPS URLを返す。
 *
 * 配信は既存の GET /images/:key に相乗りする（音声専用ルートを増やさない）。
 * あのルートはR2のcontentTypeをそのまま返すので、audio/mp4でも正しく配信される。
 * :key はスラッシュを含められないため、キーはフラットに組み立てる
 * （incoming-media.ts の `incoming-...` と同じ流儀）。
 */
async function putVoiceObject(
  r2: R2Bucket,
  workerUrl: string,
  accountId: string,
  m4a: ArrayBuffer,
): Promise<string> {
  const safeAccountId = accountId.replace(/[^a-zA-Z0-9-]/g, '_');
  const key = `voice-${safeAccountId}-${crypto.randomUUID()}.m4a`;
  await r2.put(key, m4a, {
    httpMetadata: { contentType: 'audio/mp4' },
  });
  return `${workerUrl.replace(/\/$/, '')}/images/${key}`;
}

export interface ReplyWithVoiceParams {
  lineClient: LineClient;
  replyToken: string;
  lineUserId: string;
  /** 返答のテキスト。音声化に失敗したらこれがそのまま送られる。 */
  text: string;
  /** 誰の声で返すか。 */
  character: CharacterKey;
  synthesizer: VoiceSynthesizer | null;
  r2: R2Bucket | undefined;
  workerUrl: string | undefined;
  accountId: string;
  receivedAt: number;
  replyTokenConsumed: boolean;
}

export interface ReplyWithVoiceResult {
  /** 音声で返せたか。false ならテキストで返している（無言にはならない）。 */
  sentAsVoice: boolean;
  /** replyTokenを使えたか（false ならpushMessageで送っている）。 */
  usedReplyToken: boolean;
}

/**
 * 音声で返す。できなければテキストで返す。
 *
 * ここが「無言にしない」ことの保証点。音声化のどの段階でつまずいても
 * （未設定・合成失敗・R2未設定・送信失敗）最後は必ずテキスト送信に落ちる。
 */
export async function replyWithVoice(
  params: ReplyWithVoiceParams,
): Promise<ReplyWithVoiceResult> {
  const {
    lineClient, replyToken, lineUserId, text, character,
    synthesizer, r2, workerUrl, accountId, receivedAt, replyTokenConsumed,
  } = params;

  const sendText = async (): Promise<ReplyWithVoiceResult> => {
    const usedReplyToken = await sendWithFallback(
      lineClient, replyToken, lineUserId,
      [{ type: 'text', text }],
      receivedAt, replyTokenConsumed,
    );
    return { sentAsVoice: false, usedReplyToken };
  };

  if (!synthesizer || !r2 || !workerUrl) return sendText();

  const voice = await synthesizer.synthesize(text, CHARACTER_SPEAKER_ID[character]);
  if (!voice) return sendText();

  try {
    const url = await putVoiceObject(r2, workerUrl, accountId, voice.m4a);
    // 音声だけだと後から検索できず、聞き返しにも不便なので、
    // 文字も一緒に送る（アクセシビリティの観点でも音声のみにはしない）。
    const usedReplyToken = await sendWithFallback(
      lineClient, replyToken, lineUserId,
      [
        { type: 'audio', originalContentUrl: url, duration: voice.durationMs },
        { type: 'text', text },
      ],
      receivedAt, replyTokenConsumed,
    );
    console.log(JSON.stringify({
      tag: 'voice_reply', outcome: 'voice',
      synthesizer: synthesizer.name, character,
      durationMs: voice.durationMs, bytes: voice.m4a.byteLength,
    }));
    return { sentAsVoice: true, usedReplyToken };
  } catch (err) {
    console.warn(
      '[voice-reply] send failed, falling back to text',
      err instanceof Error ? err.message : String(err),
    );
    return sendText();
  }
}

/**
 * replyToken優先・失効時はpushMessageに切り替える送信（webhook.tsのsendSafeTextと同じ考え方を、
 * テキスト以外のメッセージにも使えるようにしたもの）。
 */
async function sendWithFallback(
  lineClient: LineClient,
  replyToken: string,
  lineUserId: string,
  messages: Parameters<LineClient['pushMessage']>[1],
  receivedAt: number,
  replyTokenConsumed: boolean,
): Promise<boolean> {
  const withinDeadline = !replyTokenConsumed && Date.now() - receivedAt < 45_000;
  if (withinDeadline) {
    try {
      await lineClient.replyMessage(replyToken, messages);
      return true;
    } catch (err) {
      console.warn(
        '[voice-reply] replyMessage failed, falling back to pushMessage',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  await lineClient.pushMessage(lineUserId, messages);
  return false;
}
