import { ESCALATION_MARKER, type GroqReplyResult } from './groq-reply.js';

/**
 * LLMプロバイダの共通呼び出し層。GROQ/Gemini/Cloudflare Workers AI をチェーンで
 * 順に試す設計（HANDOFF: 2026-07-17 Fable設計「無応答ゼロ化アーキテクチャ」）。
 *
 * fail-closed: いずれのプロバイダも例外を投げない。fetch失敗/429/非200/JSON不正/
 * 空文字のいずれも { kind: 'fail_closed' } を返し、呼び出し側（llm-chain.ts）が
 * 次の段へ進む判断材料にする。
 */

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallParams {
  systemPrompt: string;
  messages: ChatMessage[];
  incomingText: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

function stripThinking(text: string): string {
  // qwen系等のthinkingモデルが<think>...</think>を混ぜるケースの保険（groq-reply.tsと同等仕様）。
  if (!text) return text;
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  if (/<think>/i.test(t)) {
    const close = t.lastIndexOf('</think>');
    t = close >= 0 ? t.slice(close + 8) : t.replace(/<think>[\s\S]*$/i, '');
  }
  return t.trim() || text.trim();
}

function parseReplyText(rawText: string): GroqReplyResult {
  const trimmed = rawText.trim();
  if (!trimmed) return { kind: 'fail_closed' };

  const cleaned = stripThinking(trimmed);
  if (cleaned.includes(ESCALATION_MARKER)) {
    const withoutMarker = cleaned.replace(ESCALATION_MARKER, '').trim();
    return { kind: 'escalate', text: withoutMarker || undefined };
  }
  return { kind: 'reply', text: cleaned };
}

/** OpenAI互換 chat/completions を叩く（Groq・Gemini両対応の共通実装）。 */
async function callOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  params: LlmCallParams,
): Promise<GroqReplyResult> {
  const { systemPrompt, messages, incomingText, maxOutputTokens, timeoutMs } = params;
  // messages（DB履歴）の末尾には「今回受信した行」がそのまま入っている（buildGroqHistoryが
  // messages_logをmessage_type IN ('text','image')でLIMIT取得するため、直前にINSERT/UPDATE
  // 済みの今回分も含まれる）。テキストの場合はincomingTextと同一文字列なので実害が無いが、
  // 画像の場合は履歴側が`[画像: 客観描写]`という素っ気ない別テキストになり、
  // 「あなたらしく反応してください」という指示を含むincomingTextと食い違う。
  // 履歴に何が入っていてもincomingText（今回LLMに伝えたい実際の指示）は必ず最後のuser発言
  // として届くよう、常にmessages配列の末尾に追加する（2026-07-19 実障害: 画像に無機質な
  // 客観描写だけを返す不具合の修正）。
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...messages,
    { role: 'user', content: incomingText },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        temperature: 0.3,
        messages: chatMessages,
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[llm-providers] fetch failed', err);
    return { kind: 'fail_closed' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    console.warn('[llm-providers] rate limited (429)');
    return { kind: 'fail_closed' };
  }
  if (!response.ok) {
    console.warn('[llm-providers] API error', response.status, await response.text().catch(() => ''));
    return { kind: 'fail_closed' };
  }

  let data: { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
  try {
    data = await response.json();
  } catch {
    return { kind: 'fail_closed' };
  }

  const msg = data.choices?.[0]?.message;
  const rawText = msg?.content || msg?.reasoning_content || msg?.reasoning || '';
  return parseReplyText(rawText);
}

/** Groq chat/completions。 */
export async function callGroq(apiKey: string, model: string, params: LlmCallParams): Promise<GroqReplyResult> {
  return callOpenAiCompatible('https://api.groq.com/openai/v1/chat/completions', apiKey, model, params);
}

/** Gemini の OpenAI互換エンドポイント。既存のOpenAI互換パーサーをそのまま流用できる。 */
export async function callGemini(apiKey: string, model: string, params: LlmCallParams): Promise<GroqReplyResult> {
  return callOpenAiCompatible(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey,
    model,
    params,
  );
}

// vision-describe.ts専用の型（2026-07-17画像認識機能追加）。既存ChatMessageは
// 3番手Workers AI（@cf/meta/llama-3.3-70b-instruct-fp8-fast）がcontent配列を
// 解さないため絶対に触らない。vision呼び出しはこの別型・別関数に隔離する。
export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface VisionCallParams {
  /** describe指示文（人格プロンプトは不要）。 */
  prompt: string;
  /** data URI（data:image/...;base64,xxx）または公開URL。 */
  imageUrl: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * OpenAI互換chat/completionsのvision呼び出し（Groq/Gemini共用）。fail-closedでnull。
 * describe段はユーザー向け返信ではないため、ESCALATION_MARKERが混入しても無視して
 * 除去するのみ（stripThinkingは適用する）。
 */
export async function callVisionOpenAiCompatible(
  url: string,
  apiKey: string,
  model: string,
  params: VisionCallParams,
): Promise<string | null> {
  const { prompt, imageUrl, maxOutputTokens, timeoutMs } = params;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: imageUrl } },
            ] satisfies VisionContentPart[],
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[llm-providers] vision fetch failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    console.warn('[llm-providers] vision rate limited (429)');
    return null;
  }
  if (!response.ok) {
    console.warn('[llm-providers] vision API error', response.status, await response.text().catch(() => ''));
    return null;
  }

  let data: { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
  try {
    data = await response.json();
  } catch {
    return null;
  }

  const msg = data.choices?.[0]?.message;
  const rawText = (msg?.content || msg?.reasoning_content || msg?.reasoning || '').trim();
  if (!rawText) return null;

  // vision describe段はESCALATION_MARKERの意味的判定（escalate扱い）をしない（§4/§11-7）。
  // 混入した場合は単に文字列除去して無視する。
  const cleaned = stripThinking(rawText).replace(ESCALATION_MARKER, '').trim();
  return cleaned || null;
}

/** Groq visionモデル向けchat/completions。 */
export async function callGroqVision(apiKey: string, model: string, params: VisionCallParams): Promise<string | null> {
  return callVisionOpenAiCompatible('https://api.groq.com/openai/v1/chat/completions', apiKey, model, params);
}

/** Gemini visionモデル向け（OpenAI互換エンドポイント）。 */
export async function callGeminiVision(apiKey: string, model: string, params: VisionCallParams): Promise<string | null> {
  return callVisionOpenAiCompatible(
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    apiKey,
    model,
    params,
  );
}

// media-describe.ts専用の型（2026-07-19動画・音声認識機能追加）。動画・音声はGeminiのみ
// 対応（Groq/Workers AIはこの入力形式に対応していない）。

export interface AudioCallParams {
  /** describe指示文（人格プロンプトは不要）。 */
  prompt: string;
  /** base64エンコード済み音声データ（data URIのprefixは含まない）。 */
  audioBase64: string;
  /** OpenAI互換input_audioのformat値。'wav'|'mp3'等（LINEはm4a/aacが多いがGemini側はmp3扱いで通ることを実機検証、非対応時はfail-closed）。 */
  format: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

/**
 * Gemini音声モデル向け（OpenAI互換エンドポイントのinput_audio content type）。
 * 実機検証済み: video_urlと違いinput_audioはOpenAI互換層で正しく受理される
 * （2026-07-19、フォーマット不正なら400、受理されればクォータ制限時も429が返ることで確認）。
 * fail-closedでnull。
 */
export async function callGeminiAudio(apiKey: string, model: string, params: AudioCallParams): Promise<string | null> {
  const { prompt, audioBase64, format, maxOutputTokens, timeoutMs } = params;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxOutputTokens,
        temperature: 0.3,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'input_audio', input_audio: { data: audioBase64, format } },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[llm-providers] audio fetch failed', err);
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    console.warn('[llm-providers] audio rate limited (429)');
    return null;
  }
  if (!response.ok) {
    console.warn('[llm-providers] audio API error', response.status, await response.text().catch(() => ''));
    return null;
  }

  let data: { choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }> };
  try {
    data = await response.json();
  } catch {
    return null;
  }

  const msg = data.choices?.[0]?.message;
  const rawText = (msg?.content || msg?.reasoning_content || msg?.reasoning || '').trim();
  if (!rawText) return null;
  const cleaned = stripThinking(rawText).replace(ESCALATION_MARKER, '').trim();
  return cleaned || null;
}

export interface VideoCallParams {
  /** describe指示文（人格プロンプトは不要）。 */
  prompt: string;
  /** base64エンコード済み動画データ（data URIのprefixは含まない）。 */
  videoBase64: string;
  mimeType: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

// media-describe.ts側で503限定リトライを行うため、失敗理由を判別できる型で返す
// （2026-07-20 BEST-IN-CLASS-DESIGN.md C-2）。'http'のときのみstatusを持つ。
export type VideoCallResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'http' | 'fetch' | 'timeout' | 'empty' | 'parse'; status?: number };

/**
 * Gemini動画モデル向け（ネイティブgenerateContent APIのinline_data）。
 * OpenAI互換chat/completionsはvideo_url content typeを拒否する（400 Invalid content
 * part type）ことを実機検証済みのため、動画のみこのネイティブAPI経路を使う
 * （2026-07-19動画・音声認識機能追加）。レスポンス形式がOpenAI互換と異なるため
 * 専用パーサーを持つ。fail-closedで{ok: false}（例外は投げない）。
 */
export async function callGeminiVideo(apiKey: string, model: string, params: VideoCallParams): Promise<VideoCallResult> {
  const { prompt, videoBase64, mimeType, maxOutputTokens, timeoutMs } = params;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inline_data: { mime_type: mimeType, data: videoBase64 } },
            ],
          },
        ],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.3,
        },
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    console.warn('[llm-providers] video fetch failed', err);
    return { ok: false, reason: timedOut ? 'timeout' : 'fetch' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    console.warn('[llm-providers] video rate limited (429)');
    return { ok: false, reason: 'http', status: 429 };
  }
  if (!response.ok) {
    console.warn('[llm-providers] video API error', response.status, await response.text().catch(() => ''));
    return { ok: false, reason: 'http', status: response.status };
  }

  let data: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    data = await response.json();
  } catch {
    return { ok: false, reason: 'parse' };
  }

  const rawText = (data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '').trim();
  if (!rawText) return { ok: false, reason: 'empty' };
  const cleaned = stripThinking(rawText).replace(ESCALATION_MARKER, '').trim();
  if (!cleaned) return { ok: false, reason: 'empty' };
  return { ok: true, text: cleaned };
}

/** Cloudflare Workers AI（Workerバインディング経由。外部ネットワークegressが無く障害ドメインが独立）。 */
export async function callWorkersAi(
  ai: Ai,
  model: string,
  params: LlmCallParams,
): Promise<GroqReplyResult> {
  const { systemPrompt, messages, incomingText, maxOutputTokens, timeoutMs } = params;
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(messages.length > 0 ? messages : [{ role: 'user' as const, content: incomingText }]),
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Workers AI の run() は AbortSignal を直接受け取らないため、Promise.race で
    // タイムアウトを模擬する（他の2プロバイダと挙動を揃えるため）。
    const runPromise = ai.run(model as never, {
      messages: chatMessages,
      max_tokens: maxOutputTokens,
      temperature: 0.3,
    } as never) as Promise<{ response?: string }>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('workers-ai timeout')));
    });
    const result = await Promise.race([runPromise, timeoutPromise]);
    const rawText = result?.response || '';
    return parseReplyText(rawText);
  } catch (err) {
    console.warn('[llm-providers] Workers AI call failed', err);
    return { kind: 'fail_closed' };
  } finally {
    clearTimeout(timer);
  }
}
