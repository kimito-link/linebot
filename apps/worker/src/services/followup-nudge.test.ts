import { describe, expect, test, vi, beforeEach } from 'vitest';
import { processDueFollowups } from './followup-nudge.js';

const pushMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ pushMessage })),
}));

vi.mock('@line-crm/db', () => ({
  jstNow: () => '2026-07-22T00:00:00.000',
}));

const getGroqReplyConfig = vi.fn().mockResolvedValue({ enabled: true });
vi.mock('./groq-reply.js', () => ({
  buildGroqHistory: vi.fn().mockResolvedValue([{ role: 'user', content: 'こんにちは' }]),
  getGroqReplyConfig: (...args: unknown[]) => getGroqReplyConfig(...args),
}));

const generateLlmReplyWithFallback = vi.fn();
vi.mock('./llm-chain.js', () => ({
  generateLlmReplyWithFallback: (...args: unknown[]) => generateLlmReplyWithFallback(...args),
}));

vi.mock('./knowledge-packs.js', () => ({
  getKnowledgePack: () => ({
    buildSystemPrompt: () => 'system prompt',
  }),
}));

vi.mock('./bot-project.js', () => ({
  resolveBotProject: vi.fn().mockResolvedValue('ai-shain-link'),
}));

const isGroqBudgetExceeded = vi.fn().mockResolvedValue(false);
const incrementGroqUsage = vi.fn().mockResolvedValue(undefined);
vi.mock('./kb-search.js', () => ({
  isGroqBudgetExceeded: (...args: unknown[]) => isGroqBudgetExceeded(...args),
  incrementGroqUsage: (...args: unknown[]) => incrementGroqUsage(...args),
}));

interface CandidateRow {
  id: string;
  line_user_id: string;
  ref_code: string | null;
  line_account_id: string | null;
  channel_access_token: string;
}

function stubDB(candidates: CandidateRow[]) {
  const updates: Array<{ sql: string; bound: unknown[] }> = [];
  const inserts: Array<{ sql: string; bound: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async all() {
          if (sql.includes('FROM friends f')) {
            return { results: candidates };
          }
          return { results: [] };
        },
        async run() {
          if (sql.startsWith('INSERT INTO messages_log')) {
            inserts.push({ sql, bound });
            return { success: true, meta: { changes: 1 } };
          }
          updates.push({ sql, bound });
          return { success: true, meta: { changes: 1 } };
        },
        async first() {
          return null;
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, updates, inserts };
}

const NOW = new Date('2026-07-22T00:00:00Z');
const ROW: CandidateRow = {
  id: 'F1',
  line_user_id: 'U1',
  ref_code: null,
  line_account_id: 'ACC1',
  channel_access_token: 'tok',
};

beforeEach(() => {
  vi.clearAllMocks();
  pushMessage.mockResolvedValue(undefined);
  getGroqReplyConfig.mockResolvedValue({ enabled: true });
  isGroqBudgetExceeded.mockResolvedValue(false);
});

describe('processDueFollowups', () => {
  test('AI応答をpush送信し、last_followup_sent_atを更新する', async () => {
    generateLlmReplyWithFallback.mockResolvedValue({ kind: 'reply', text: 'お元気ですか？' });
    const { db, updates, inserts } = stubDB([ROW]);

    const result = await processDueFollowups(db, { now: NOW, deps: {} });

    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
    expect(pushMessage).toHaveBeenCalledWith('U1', [{ type: 'text', text: 'お元気ですか？' }]);
    expect(updates.some((u) => u.sql.includes('last_followup_sent_at = ?'))).toBe(true);
    expect(inserts.some((i) => i.sql.includes("'groq_followup'"))).toBe(true);
  });

  test('Groq返信が無効なアカウントはスキップする', async () => {
    getGroqReplyConfig.mockResolvedValue({ enabled: false });
    const { db } = stubDB([ROW]);

    const result = await processDueFollowups(db, { now: NOW, deps: {} });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(generateLlmReplyWithFallback).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('日次予算超過のアカウントはスキップする', async () => {
    isGroqBudgetExceeded.mockResolvedValue(true);
    const { db } = stubDB([ROW]);

    const result = await processDueFollowups(db, { now: NOW, deps: {} });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(generateLlmReplyWithFallback).not.toHaveBeenCalled();
  });

  test('LLMがfail_closedならlast_followup_sent_atを更新せずスキップする（次回再試行可能）', async () => {
    generateLlmReplyWithFallback.mockResolvedValue({ kind: 'fail_closed' });
    const { db, updates } = stubDB([ROW]);

    const result = await processDueFollowups(db, { now: NOW, deps: {} });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(updates.some((u) => u.sql.includes('last_followup_sent_at = ?'))).toBe(false);
    expect(pushMessage).not.toHaveBeenCalled();
  });

  test('push送信が失敗しても例外を投げず、その相手はスキップ扱いになる', async () => {
    generateLlmReplyWithFallback.mockResolvedValue({ kind: 'reply', text: 'お元気ですか？' });
    pushMessage.mockRejectedValue(new Error('LINE 500'));
    const { db } = stubDB([ROW]);

    const result = await processDueFollowups(db, { now: NOW, deps: {} });

    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
