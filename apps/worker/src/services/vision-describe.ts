/**
 * 画像バイナリ→説明文（2026-07-17 Fable設計「画像認識・URL認識機能」§2.1/§4/§8）。
 *
 * 2段方式の1段目: visionモデル（groq→gemini）に「画像の内容を客観的に説明せよ」
 * とだけ指示し、人格・KBを含まない説明文を得る。この説明文は呼び出し側が
 * 既存のテキストパイプライン（runGroqSupportPipeline）にincomingText相当として
 * 渡し、人格・KB・履歴・エスカレーション判定は既存チェーンにそのまま委ねる。
 *
 * fail-closed: チェーン全滅・タイムアウト・バイナリ変換失敗はすべてnull。
 * 例外は外に投げない（incoming-image.ts/url-context.tsと同じ流儀）。
 */

import { callGroqVision, callGeminiVision } from './llm-providers.js';
import { remainingMs } from './llm-chain.js';
import type { BotVisionConfig } from './groq-config.js';

// Groqのdata URI(base64)上限は4MB。LINEのオリジナル画像は10MB近くあり得るため、
// 上限以下ならdata URIをそのまま渡し、超えたら公開URL方式にフォールバックする
// （§11地雷#2）。
const MAX_DATA_URI_BYTES = 3 * 1024 * 1024; // 3MB（4MB上限に安全マージン）

// テキストチェーン最低1段+送信の余裕を残すため、この秒数を切ったらdescribe自体を
// 諦める（§8: stage.timeoutMs + 15秒を下回ったら当該段をスキップ）。
const POST_DESCRIBE_MARGIN_MS = 15_000;

export interface DescribeImageParams {
  /** 画像バイナリ（R2保存後もメモリに保持したものをそのまま渡す）。 */
  bytes: ArrayBuffer;
  contentType: string;
  /** 3MB超過時のフォールバック用公開URL（例: `${workerUrl}/images/${key}`）。 */
  publicImageUrl?: string;
  /** ローカル開発等、publicImageUrlが外部APIから到達不能な場合はtrueにして3MB超をfail-closedにする。 */
  publicUrlUnreachable?: boolean;
  vision: BotVisionConfig;
  groqApiKey?: string;
  geminiApiKey?: string;
  receivedAt: number;
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

function resolveImageUrl(params: DescribeImageParams): string | null {
  const { bytes, contentType, publicImageUrl, publicUrlUnreachable } = params;
  if (bytes.byteLength <= MAX_DATA_URI_BYTES) {
    return `data:${contentType};base64,${bytesToBase64(bytes)}`;
  }
  if (publicImageUrl && !publicUrlUnreachable) {
    return publicImageUrl;
  }
  // 3MB超 かつ 公開URLが無い/到達不能（ローカル開発等）→ describeを諦める。
  return null;
}

const DESCRIBE_PROMPT = 'この画像の内容を日本語で2〜3文で客観的に説明してください。返信文や挨拶は不要です。';

/**
 * visionチェーン（groq→gemini）を残り時間駆動で試行し、説明文を返す。
 * 全段失敗・画像サイズ超過・チェーン未設定はnull（fail-closed）。
 */
export async function describeImage(params: DescribeImageParams): Promise<string | null> {
  const { vision, groqApiKey, geminiApiKey, receivedAt } = params;
  if (!vision.enabled) return null;

  const imageUrl = resolveImageUrl(params);
  if (!imageUrl) {
    console.warn('[vision-describe] image too large and no reachable public URL fallback');
    return null;
  }

  for (const stage of vision.chain) {
    const remaining = remainingMs(receivedAt);
    if (remaining < stage.timeoutMs + POST_DESCRIBE_MARGIN_MS) {
      console.warn(`[vision-describe] skip stage=${stage.provider} reason=deadline remainingMs=${remaining}`);
      continue;
    }

    const callParams = {
      prompt: DESCRIBE_PROMPT,
      imageUrl,
      maxOutputTokens: vision.maxDescriptionTokens,
      timeoutMs: stage.timeoutMs,
    };

    let result: string | null;
    if (stage.provider === 'groq') {
      if (!groqApiKey) continue;
      result = await callGroqVision(groqApiKey, stage.model, callParams);
    } else if (stage.provider === 'gemini') {
      if (!geminiApiKey) continue;
      result = await callGeminiVision(geminiApiKey, stage.model, callParams);
    } else {
      // Workers AIはvisionチェーンに入れない（§6: 品質・提供状況の理由で使用禁止）。
      continue;
    }

    if (result) return result;
  }

  return null;
}
