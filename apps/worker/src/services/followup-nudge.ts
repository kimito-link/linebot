// Cron handler: 自発的フォローアップ（OpenClaw方式、2026-07-21）。
// 過去に会話履歴があるfriendのうち、最終ユーザー発言から一定時間経過し、
// かつ一度もフォローアップを送っていない相手に、会話履歴を踏まえたAI生成の
// 一言をpushで送る。ai_reply_mode='human'（オペレーター引き継ぎ中）の相手には送らない。

import { jstNow } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';
import { buildGroqHistory, getGroqReplyConfig } from './groq-reply.js';
import { generateLlmReplyWithFallback } from './llm-chain.js';
import { getKnowledgePack } from './knowledge-packs.js';
import { resolveBotProject } from './bot-project.js';
import { isGroqBudgetExceeded, incrementGroqUsage } from './kb-search.js';

const FOLLOWUP_AFTER_HOURS = 24;
const MAX_PER_RUN = 50;

interface CandidateRow {
  id: string;
  line_user_id: string;
  ref_code: string | null;
  line_account_id: string | null;
  channel_access_token: string;
}

export interface FollowupSenderDeps {
  groqApiKey?: string;
  geminiApiKey?: string;
  workersAi?: Ai;
}

export interface RunFollowupNudgeParams {
  now: Date;
  deps: FollowupSenderDeps;
}

function buildFollowupSystemPrompt(basePrompt: string): string {
  return `${basePrompt}\n\n今回はユーザーからの新しい発言ではなく、しばらく返信が無いユーザーへあなたから自発的に送る一言を考える場面です。これまでの会話履歴を踏まえ、押しつけがましくならない自然な一言（催促や質問攻めにしない、1〜2文程度）を生成してください。`;
}

async function logOutgoingFollowup(db: D1Database, friendId: string, text: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'groq_followup', ?)`,
    )
    .bind(crypto.randomUUID(), friendId, text, jstNow())
    .run();
}

export async function processDueFollowups(
  db: D1Database,
  params: RunFollowupNudgeParams,
): Promise<{ sent: number; skipped: number }> {
  const cutoff = new Date(params.now.getTime() - FOLLOWUP_AFTER_HOURS * 3600_000).toISOString();

  const candidates = await db
    .prepare(
      `SELECT f.id, f.line_user_id, f.ref_code, f.line_account_id,
              la.channel_access_token
         FROM friends f
         INNER JOIN line_accounts la ON la.id = f.line_account_id
        WHERE f.is_following = 1
          AND f.ai_reply_mode != 'human'
          AND f.last_followup_sent_at IS NULL
          AND EXISTS (
            SELECT 1 FROM messages_log ml
             WHERE ml.friend_id = f.id AND ml.direction = 'incoming'
          )
          AND (
            SELECT MAX(ml2.created_at) FROM messages_log ml2
             WHERE ml2.friend_id = f.id AND ml2.direction = 'incoming'
          ) < ?
        LIMIT ?`,
    )
    .bind(cutoff, MAX_PER_RUN)
    .all<CandidateRow>();

  let sent = 0;
  let skipped = 0;

  for (const row of candidates.results) {
    const replyConfig = await getGroqReplyConfig(db, row.line_account_id);
    if (!replyConfig.enabled) {
      skipped++;
      continue;
    }

    if (await isGroqBudgetExceeded(db, row.line_account_id)) {
      skipped++;
      continue;
    }

    const project = await resolveBotProject(db, { ref_code: row.ref_code });
    const pack = getKnowledgePack(project);
    const history = await buildGroqHistory(db, row.id);
    if (history.length === 0) {
      skipped++;
      continue;
    }

    await incrementGroqUsage(db, row.line_account_id, 'groq_calls');

    const result = await generateLlmReplyWithFallback({
      systemPrompt: buildFollowupSystemPrompt(pack.buildSystemPrompt('')),
      messages: history,
      incomingText: '',
      receivedAt: Date.now(),
      groqApiKey: params.deps.groqApiKey,
      geminiApiKey: params.deps.geminiApiKey,
      workersAi: params.deps.workersAi,
    });

    // AI生成失敗(fail_closed)はここではスキップのみ。last_followup_sent_atは
    // まだ書き込まない — 一時的なAPI障害で「一生送られない」を防ぎ、次回cronで再試行させる。
    if (result.kind !== 'reply' && result.kind !== 'escalate' || !result.text) {
      skipped++;
      continue;
    }
    const text = result.text;

    // 条件付きUPDATE: 送信を試みる直前にマーキングを確定させる（同じ相手への
    // 二重送信を防ぐ）。以降の送信失敗はリトライせず諦める — pushそのものの
    // 再試行はLINE側のuser_idが無効等の恒久失敗もあり得るため、リトライして
    // 迷惑メッセージ化するより1回で打ち切るほうが安全。
    const upd = await db
      .prepare(
        `UPDATE friends SET last_followup_sent_at = ?, updated_at = ? WHERE id = ? AND last_followup_sent_at IS NULL`,
      )
      .bind(jstNow(), jstNow(), row.id)
      .run();
    if ((upd.meta?.changes ?? 0) === 0) {
      skipped++;
      continue;
    }

    try {
      const client = new LineClient(row.channel_access_token);
      await client.pushMessage(row.line_user_id, [{ type: 'text', text }]);
      await logOutgoingFollowup(db, row.id, text);
      sent++;
    } catch (err) {
      console.error('[followup-nudge] push failed', err instanceof Error ? err.message : String(err));
      skipped++;
    }
  }

  return { sent, skipped };
}
