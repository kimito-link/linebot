/**
 * 動画・音声バイナリ→説明文（2026-07-19動画・音声認識機能追加）。
 *
 * vision-describe.tsと同じ2段方式の1段目: Geminiモデルに「内容を客観的に説明せよ」
 * とだけ指示し、人格・KBを含まない説明文を得る。呼び出し側が既存のテキストパイプライン
 * （runGroqSupportPipeline）にincomingText相当として渡し、人格・KB・履歴・エスカレーション
 * 判定は既存チェーンにそのまま委ねる。
 *
 * visionと異なりGeminiのみ対応（Groq/Workers AIは動画・音声inputに対応していない）。
 * 動画はネイティブgenerateContent API、音声はOpenAI互換chat/completionsのinput_audio
 * （llm-providers.ts参照、両方式の違いは実機検証で確定）。
 *
 * fail-closed: サイズ超過・タイムアウト・API失敗はすべてnull。例外は外に投げない
 * （incoming-image.ts/vision-describe.tsと同じ流儀）。
 */

import { callGeminiAudio, callGeminiVideo } from './llm-providers.js';
import { remainingMs } from './llm-chain.js';
import type { BotMediaConfig } from './groq-config.js';

const POST_DESCRIBE_MARGIN_MS = 15_000;
// Gemini動画APIの503（過負荷）は一時的な事象であることが多く、本Botのトラフィック規模
// （個人運用・低頻度）では追い打ちリトライが429クォータを誘発するリスクは無い。
// 429（クォータ超過）へは絶対にリトライしない。予算チェックがタイムアウト後の
// 危険な再試行を自動的に締め出すため、バックオフより先に残り時間を見る
// （2026-07-20 BEST-IN-CLASS-DESIGN.md C-2）。
const RETRY_BACKOFF_MS = 2000;
const RETRY_BACKOFF_JITTER_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    binary += String.fromCharCode(...arr.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const DESCRIBE_VIDEO_PROMPT = 'この動画の内容を日本語で2〜3文で客観的に説明してください。返信文や挨拶は不要です。';
const DESCRIBE_AUDIO_PROMPT = 'この音声の内容を日本語で2〜3文で客観的に説明してください。話者の発言内容が聞き取れる場合は要約に含めてください。返信文や挨拶は不要です。';

export interface DescribeVideoParams {
  bytes: ArrayBuffer;
  contentType: string;
  config: BotMediaConfig;
  geminiApiKey?: string;
  receivedAt: number;
}

/** サイズ超過・GEMINI_API_KEY未設定・disabledはnull（fail-closed）。 */
export async function describeVideo(params: DescribeVideoParams): Promise<string | null> {
  const { bytes, contentType, config, geminiApiKey, receivedAt } = params;
  if (!config.enabled) return null;
  if (!geminiApiKey) return null;
  if (bytes.byteLength > config.maxInputBytes) {
    console.warn('[media-describe] video too large', { bytes: bytes.byteLength, max: config.maxInputBytes });
    return null;
  }

  const remaining = remainingMs(receivedAt);
  if (remaining < config.timeoutMs + POST_DESCRIBE_MARGIN_MS) {
    console.warn(`[media-describe] skip video reason=deadline remainingMs=${remaining}`);
    return null;
  }

  const callParams = {
    prompt: DESCRIBE_VIDEO_PROMPT,
    videoBase64: bytesToBase64(bytes),
    mimeType: contentType,
    maxOutputTokens: config.maxDescriptionTokens,
    timeoutMs: config.timeoutMs,
  };

  const first = await callGeminiVideo(geminiApiKey, config.model, callParams);
  if (first.ok) return first.text;

  // 503のみ最大1回リトライ。429・timeout・fetch失敗・空応答は即座にnull（追い打ちしない）。
  if (first.reason === 'http' && first.status === 503) {
    const remainingAfterFirst = remainingMs(receivedAt);
    if (remainingAfterFirst >= config.timeoutMs + POST_DESCRIBE_MARGIN_MS + RETRY_BACKOFF_MS) {
      console.warn('[media-describe] video 503, retrying once');
      await sleep(RETRY_BACKOFF_MS + Math.random() * RETRY_BACKOFF_JITTER_MS);
      const second = await callGeminiVideo(geminiApiKey, config.model, callParams);
      if (second.ok) return second.text;
      console.warn('[media-describe] video retry also failed', second.reason);
      return null;
    }
    console.warn('[media-describe] video 503 but insufficient budget to retry');
  }

  return null;
}

export interface DescribeAudioParams {
  bytes: ArrayBuffer;
  contentType: string;
  config: BotMediaConfig;
  geminiApiKey?: string;
  receivedAt: number;
}

// LINEのaudio contentTypeはm4a/aacが主。GeminiのOpenAI互換input_audio.formatは
// wav/mp3等の識別子を期待するため、既知のcontentTypeをformat識別子にマップする。
// 未知のcontentTypeはfail-closed（describeを諦める）。
const CONTENT_TYPE_TO_AUDIO_FORMAT: Record<string, string> = {
  // 2026-07-20実機検証で確定: LINEアプリの音声メッセージは audio/x-m4a を返す
  // （audio/mp4ではない）。これが欠けていたため全件unsupported content-typeで
  // fail-closedし、音声にだけ一切反応しない実障害が発生した。
  'audio/x-m4a': 'mp3',
  'audio/mp4': 'mp3', // 一部クライアント/将来のLINE側変更向けの保険として残す
  'audio/m4a': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
};

/** サイズ超過・GEMINI_API_KEY未設定・disabled・未対応contentTypeはnull（fail-closed）。 */
export async function describeAudio(params: DescribeAudioParams): Promise<string | null> {
  const { bytes, contentType, config, geminiApiKey, receivedAt } = params;
  if (!config.enabled) return null;
  if (!geminiApiKey) return null;
  if (bytes.byteLength > config.maxInputBytes) {
    console.warn('[media-describe] audio too large', { bytes: bytes.byteLength, max: config.maxInputBytes });
    return null;
  }

  const format = CONTENT_TYPE_TO_AUDIO_FORMAT[contentType];
  if (!format) {
    console.warn('[media-describe] unsupported audio content-type', { contentType });
    return null;
  }

  const remaining = remainingMs(receivedAt);
  if (remaining < config.timeoutMs + POST_DESCRIBE_MARGIN_MS) {
    console.warn(`[media-describe] skip audio reason=deadline remainingMs=${remaining}`);
    return null;
  }

  return callGeminiAudio(geminiApiKey, config.model, {
    prompt: DESCRIBE_AUDIO_PROMPT,
    audioBase64: bytesToBase64(bytes),
    format,
    maxOutputTokens: config.maxDescriptionTokens,
    timeoutMs: config.timeoutMs,
  });
}
