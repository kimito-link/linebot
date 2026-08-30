import { describe, test, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { adminConnections } from './admin-connections.js';

/** D1のスタブ。prepare().bind().all() の形を満たす。 */
function makeDb(rows: unknown[] = [], opts: { throwOn?: 'all' } = {}) {
  const stmt = {
    bind: vi.fn(() => stmt),
    all: vi.fn(async () => {
      if (opts.throwOn === 'all') throw new Error('D1 down');
      return { results: rows };
    }),
  };
  return { prepare: vi.fn(() => stmt) } as unknown as D1Database;
}

function makeApp() {
  const app = new Hono();
  app.route('/', adminConnections);
  return app;
}

const SECRET = 'super-secret-token-value-do-not-leak';

describe('GET /api/admin/connections', () => {
  test('接続一覧を返す', async () => {
    const res = await makeApp().request('/api/admin/connections', {}, { DB: makeDb() });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { success: boolean; data: { connections: unknown[] } };
    expect(j.success).toBe(true);
    expect(j.data.connections.length).toBeGreaterThan(0);
  });

  test('★シークレットの値を一切返さない（漏洩防止）', async () => {
    const env = {
      DB: makeDb(),
      LINE_CHANNEL_ACCESS_TOKEN: SECRET,
      LINE_CHANNEL_SECRET: SECRET,
      GROQ_API_KEY: SECRET,
      GEMINI_API_KEY: SECRET,
      GITHUB_TOKEN: SECRET,
      VOICE_SYNTH_TOKEN: SECRET,
      CF_API_TOKEN: SECRET,
      ADMIN_API_KEY: SECRET,
    };
    const res = await makeApp().request('/api/admin/connections', {}, env);
    const body = await res.text();
    expect(body).not.toContain(SECRET);
  });

  test('未設定の接続は unconfigured になり、欠けているキー名が分かる', async () => {
    const res = await makeApp().request('/api/admin/connections', {}, { DB: makeDb() });
    const j = (await res.json()) as {
      data: { connections: Array<{ id: string; status: string; missingKeys: string[] }> };
    };
    const groq = j.data.connections.find((c) => c.id === 'llm-groq')!;
    expect(groq.status).toBe('unconfigured');
    expect(groq.missingKeys).toEqual(['GROQ_API_KEY']);
  });

  test('設定済みでも疎通未確認なら unverified（緑にしない）', async () => {
    const res = await makeApp().request(
      '/api/admin/connections', {}, { DB: makeDb(), GROQ_API_KEY: 'gsk-x' },
    );
    const j = (await res.json()) as {
      data: { connections: Array<{ id: string; status: string }> };
    };
    expect(j.data.connections.find((c) => c.id === 'llm-groq')!.status).toBe('unverified');
  });

  test('★「静かにスキップする」未設定の接続を別枠で数える（気づきにくい欠落）', async () => {
    const res = await makeApp().request('/api/admin/connections', {}, { DB: makeDb() });
    const j = (await res.json()) as {
      data: { silentlyMissing: Array<{ id: string; whenMissing: string }> };
    };
    const ids = j.data.silentlyMissing.map((s) => s.id);
    // Gemini未設定は「動画・音声の理解が静かに無効化される」ので必ず挙がるべき
    expect(ids).toContain('llm-gemini');
    expect(ids).toContain('github-issues');
    // 何が起きるかの説明が付いている
    for (const s of j.data.silentlyMissing) {
      expect(s.whenMissing.length).toBeGreaterThan(0);
    }
  });

  test('LINEはban-monitorの記録がdangerゼロなら ok になる', async () => {
    const db = makeDb([
      { line_account_id: 'a1', risk_level: 'normal', created_at: '2026-08-30T12:00:00.000+09:00' },
    ]);
    const res = await makeApp().request(
      '/api/admin/connections', {},
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'x', LINE_CHANNEL_SECRET: 'y' },
    );
    const j = (await res.json()) as {
      data: { connections: Array<{ id: string; status: string }> };
    };
    expect(j.data.connections.find((c) => c.id === 'line-messaging')!.status).toBe('ok');
  });

  test('dangerが1件でもあれば ng', async () => {
    const db = makeDb([
      { line_account_id: 'a1', risk_level: 'danger', created_at: '2026-08-30T12:00:00.000+09:00' },
    ]);
    const res = await makeApp().request(
      '/api/admin/connections', {},
      { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'x', LINE_CHANNEL_SECRET: 'y' },
    );
    const j = (await res.json()) as {
      data: { connections: Array<{ id: string; status: string }> };
    };
    expect(j.data.connections.find((c) => c.id === 'line-messaging')!.status).toBe('ng');
  });

  test('★測定記録が無ければ ok にしない（沈黙を正常と読み替えない）', async () => {
    const res = await makeApp().request(
      '/api/admin/connections', {},
      { DB: makeDb([]), LINE_CHANNEL_ACCESS_TOKEN: 'x', LINE_CHANNEL_SECRET: 'y' },
    );
    const j = (await res.json()) as {
      data: { connections: Array<{ id: string; status: string }> };
    };
    expect(j.data.connections.find((c) => c.id === 'line-messaging')!.status).toBe('unverified');
  });

  test('★D1が落ちても ok にせず、理由を返す', async () => {
    const res = await makeApp().request(
      '/api/admin/connections', {},
      { DB: makeDb([], { throwOn: 'all' }), LINE_CHANNEL_ACCESS_TOKEN: 'x', LINE_CHANNEL_SECRET: 'y' },
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      data: { probeError: string | null; connections: Array<{ id: string; status: string }> };
    };
    expect(j.data.probeError).toContain('D1 down');
    expect(j.data.connections.find((c) => c.id === 'line-messaging')!.status).toBe('unverified');
  });
});

describe('GET /api/admin/llm-usage', () => {
  test('当日の使用量と予算残を返す', async () => {
    const db = makeDb([
      { line_account_id: 'a1', usage_date: '2026-08-30', groq_calls: 100, cache_hits: 20, escalations: 2 },
    ]);
    const res = await makeApp().request('/api/admin/llm-usage', {}, { DB: db });
    expect(res.status).toBe(200);
    const j = (await res.json()) as {
      data: { budget: number; totalCalls: number; accounts: Array<{ remaining: number; exceeded: boolean }> };
    };
    expect(j.data.budget).toBeGreaterThan(0);
    expect(j.data.totalCalls).toBe(100);
    expect(j.data.accounts[0].remaining).toBe(j.data.budget - 100);
    expect(j.data.accounts[0].exceeded).toBe(false);
  });

  test('予算超過を検出する', async () => {
    const db = makeDb([
      { line_account_id: 'a1', usage_date: '2026-08-30', groq_calls: 99999, cache_hits: 0, escalations: 50 },
    ]);
    const res = await makeApp().request('/api/admin/llm-usage', {}, { DB: db });
    const j = (await res.json()) as {
      data: { accounts: Array<{ exceeded: boolean; remaining: number }> };
    };
    expect(j.data.accounts[0].exceeded).toBe(true);
    expect(j.data.accounts[0].remaining).toBe(0);
  });

  test('★D1が落ちたら成功に見せない（500を返す）', async () => {
    const res = await makeApp().request(
      '/api/admin/llm-usage', {}, { DB: makeDb([], { throwOn: 'all' }) },
    );
    expect(res.status).toBe(500);
    const j = (await res.json()) as { success: boolean; error: string };
    expect(j.success).toBe(false);
    expect(j.error).toBe('usage_query_failed');
  });
});

describe('認証（管理情報なので必ず保護されること）', () => {
  test('★認証スキップリストに /api/admin/ が入っていない', async () => {
    // このテストは実装ではなく「設定を壊さないこと」を守る。
    // 将来 auth.ts のスキップリストに誤って /api/admin/* を足すと、
    // 接続状況とアカウント情報が誰でも読める状態になる。
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const authSrc = readFileSync(path.resolve(here, '../middleware/auth.ts'), 'utf8');

    // スキップ判定のブロックだけを見る
    const start = authSrc.indexOf('return next();');
    const skipBlock = authSrc.slice(Math.max(0, start - 3000), start);
    expect(skipBlock).not.toContain('/api/admin');
  });
});
