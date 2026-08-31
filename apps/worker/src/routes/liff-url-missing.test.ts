import { describe, it, expect, vi } from 'vitest';

// LIFF_URL が未設定のとき、500ではなく「何が足りないか」を返すことを固定する。
//
// 実際に本番で /auth/line と /r/:ref が真っ白な500を返していた（2026-08-31 実測）。
// 原因は LIFF_URL secret の未設定で、liffUrl.match() が undefined を触っていた。
//
// connection-registry は line-login を degrade: 'feature-off' と宣言している。
// **宣言と実装が食い違っていた**のがこの問題の本質で、宣言どおり
// 「機能が無効」として振る舞わせる。設定漏れが真っ白な500になると、
// 原因に辿り着くまでが遠い。

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  getLineAccountByChannelId: vi.fn().mockResolvedValue(null),
  getLineAccountById: vi.fn().mockResolvedValue(null),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
};
vi.mock('@line-crm/db', () => dbMocks);

const { liffRoutes } = await import('./liff.js');

/** LIFF_URL を意図的に渡さない = 本番で起きていた状態 */
const envWithoutLiff = {
  DB: {} as never,
  LINE_LOGIN_CHANNEL_ID: '1234567890',
  LINE_LOGIN_CHANNEL_SECRET: 'test-secret',
  WORKER_PUBLIC_URL: 'https://example.workers.dev',
};

const envWithLiff = { ...envWithoutLiff, LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh' };

describe('/auth/line — LIFF_URL 未設定', () => {
  it('★500ではなく503を返す（真っ白なエラーにしない）', async () => {
    const res = await liffRoutes.fetch(
      new Request('https://example.workers.dev/auth/line?ref=a'),
      envWithoutLiff,
    );
    expect(res.status).toBe(503);
    expect(res.status).not.toBe(500);
  });

  it('★何が足りないかを本文で伝える', async () => {
    const res = await liffRoutes.fetch(
      new Request('https://example.workers.dev/auth/line?ref=a'),
      envWithoutLiff,
    );
    expect(await res.text()).toContain('LIFF');
  });

  it('設定されていれば従来どおり動く（回帰がない）', async () => {
    const res = await liffRoutes.fetch(
      new Request('https://example.workers.dev/auth/line?ref=a', {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' },
      }),
      envWithLiff,
    );
    expect(res.status).toBe(200);
  });

  it('モバイルUAでも500にならない', async () => {
    const res = await liffRoutes.fetch(
      new Request('https://example.workers.dev/auth/line?ref=a', {
        headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
      }),
      envWithoutLiff,
    );
    expect(res.status).not.toBe(500);
  });
});
