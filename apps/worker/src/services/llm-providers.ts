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
  const chatMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(messages.length > 0 ? messages : [{ role: 'user' as const, content: incomingText }]),
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
