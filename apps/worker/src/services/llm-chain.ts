import type { GroqReplyResult } from './groq-reply.js';
import { callGroq, callGemini, callWorkersAi, type LlmCallParams } from './llm-providers.js';
import { getBotConfig, type BotLlmChainStage } from './groq-config.js';

/**
 * 無応答ゼロ化チェーン（HANDOFF: 2026-07-17 Fable設計）。
 *
 * 1番手Groq → 2番手Gemini → 3番手Cloudflare Workers AI、の順に試し、
 * 最初に fail_closed 以外を返した段の結果を採用する。全滅なら fail_closed。
 *
 * 「残り時間駆動」: webhook受信時刻(receivedAt)からの経過時間を見て、次の段の
 * タイムアウト分の余裕が無ければその段を丸ごとスキップする。前段の処理
 * （friend解決・DBクエリ等）が異常に遅延しても、必ずどこかの段（または
 * 定型文の床）まで到達し、replyTokenの60秒失効前に応答できるようにするため。
 */

export interface LlmChainParams {
  systemPrompt: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  incomingText: string;
  receivedAt: number;
  groqApiKey?: string;
  geminiApiKey?: string;
  workersAi?: Ai;
}

// webhook受信からreplyTokenが失効するまでの目安(60秒)に対し、安全マージンを
// 見込んで「この時刻を過ぎたら以降の段は試さない」という締切。
const SEND_MARGIN_MS = 15_000;
export const REPLY_DEADLINE_MS = 60_000 - SEND_MARGIN_MS; // 45秒

/** 残り時間(ms)。vision-describe.tsも同じ締切を共有する（2026-07-17画像認識機能追加）。 */
export function remainingMs(receivedAt: number): number {
  return REPLY_DEADLINE_MS - (Date.now() - receivedAt);
}

async function callStage(
  stage: BotLlmChainStage,
  params: LlmChainParams,
  callParams: LlmCallParams,
): Promise<GroqReplyResult | null> {
  switch (stage.provider) {
    case 'groq':
      if (!params.groqApiKey) return null;
      return callGroq(params.groqApiKey, stage.model, callParams);
    case 'gemini':
      if (!params.geminiApiKey) return null;
      return callGemini(params.geminiApiKey, stage.model, callParams);
    case 'workers-ai':
      if (!params.workersAi) return null;
      return callWorkersAi(params.workersAi, stage.model, callParams);
    default:
      return null;
  }
}

/**
 * チェーンを順に試す。いずれかの段が fail_closed 以外を返したら即座に採用。
 * 構成されているが必要なAPIキー/バインディングが無い段はスキップする
 * （既存の `if (G) push(...)` と同じ「無いものは静かに素通し」の流儀）。
 */
export async function generateLlmReplyWithFallback(params: LlmChainParams): Promise<GroqReplyResult> {
  const { llm } = getBotConfig();
  const callParamsBase = {
    systemPrompt: params.systemPrompt,
    messages: params.messages,
    incomingText: params.incomingText,
    maxOutputTokens: llm.maxOutputTokens,
  };

  for (const stage of llm.chain) {
    const remaining = remainingMs(params.receivedAt);
    if (remaining < stage.timeoutMs) {
      console.warn(`[llm-chain] skip stage=${stage.provider} reason=deadline remainingMs=${remaining}`);
      continue;
    }

    const t0 = Date.now();
    const result = await callStage(stage, params, { ...callParamsBase, timeoutMs: stage.timeoutMs });
    if (result === null) {
      // このプロセスにはこの段を呼ぶための鍵/バインディングが無い。ログもスキップ扱い。
      continue;
    }
    console.log(`[llm-chain] stage=${stage.provider} outcome=${result.kind} elapsedMs=${Date.now() - t0}`);
    if (result.kind !== 'fail_closed') return result;
  }

  return { kind: 'fail_closed' };
}
