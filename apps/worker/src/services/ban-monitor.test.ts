<<<<<<< HEAD
import { describe, it, expect } from 'vitest';
import { shouldRunAccountHealthCheck } from './ban-monitor.js';

// checkAccountHealth を 5 分間隔に絞るゲートの固定テスト。
// 2026-09-02: 毎分 tick 全てで実行していたため D1 rows_read（messages_log SELECT +
// account_health_logs SELECT + LINE API 実リクエスト）が急増し、Workers Free プランの
// D1 日次上限 500万 rows_read を数時間で使い切った実測を受けての間引き。

describe('shouldRunAccountHealthCheck', () => {
  it('分が5の倍数（UTC）なら true', () => {
    const t = Date.UTC(2026, 8, 2, 3, 0, 0);
    expect(shouldRunAccountHealthCheck(t)).toBe(true);
  });

  it('分が5の倍数でなければ false', () => {
    const t = Date.UTC(2026, 8, 2, 3, 1, 0);
    expect(shouldRunAccountHealthCheck(t)).toBe(false);
  });

  it('0分（時の変わり目）は true', () => {
    const t = Date.UTC(2026, 8, 2, 4, 0, 0);
    expect(shouldRunAccountHealthCheck(t)).toBe(true);
  });

  it('55分は true（5の倍数の境界値）', () => {
    const t = Date.UTC(2026, 8, 2, 3, 55, 0);
    expect(shouldRunAccountHealthCheck(t)).toBe(true);
  });

  it('59分は false', () => {
    const t = Date.UTC(2026, 8, 2, 3, 59, 0);
    expect(shouldRunAccountHealthCheck(t)).toBe(false);
  });

  it('60分間で5回（毎分1440回/日から5分の1に減る）', () => {
    const base = Date.UTC(2026, 8, 2, 0, 0, 0);
    let count = 0;
    for (let m = 0; m < 60; m += 1) {
      if (shouldRunAccountHealthCheck(base + m * 60_000)) count += 1;
    }
    expect(count).toBe(12);
=======
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

const getLineAccounts = vi.fn();
const createAccountHealthLog = vi.fn();
const getAccountHealthLogs = vi.fn();

vi.mock('@line-crm/db', () => ({
  getLineAccounts: (...args: unknown[]) => getLineAccounts(...args),
  createAccountHealthLog: (...args: unknown[]) => createAccountHealthLog(...args),
  getAccountHealthLogs: (...args: unknown[]) => getAccountHealthLogs(...args),
}));

const getLinePlanQuotaShortfall = vi.fn();
const notifyQuotaAlert = vi.fn();
const countDeliverableAudience = vi.fn(async (..._args: unknown[]) => 0);
vi.mock('./quota-alert.js', () => ({
  getLinePlanQuotaShortfall: (...args: unknown[]) => getLinePlanQuotaShortfall(...args),
  notifyQuotaAlert: (...args: unknown[]) => notifyQuotaAlert(...args),
  countDeliverableAudience: (...args: unknown[]) => countDeliverableAudience(...args),
}));

const { checkAccountHealth } = await import('./ban-monitor.js');

/** messages_log の集計だけを返す最小の D1 スタブ。 */
function dbStub(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({ first: async () => ({ count: 0 }) }),
    }),
  } as unknown as D1Database;
}

function log(riskLevel: string, errorCode: number | null) {
  return {
    id: 'log-1',
    line_account_id: 'acc-1',
    error_code: errorCode,
    error_count: errorCode === null ? 0 : 1,
    check_period: '2026-08-26T13:00:00.000+09:00',
    risk_level: riskLevel,
    created_at: '2026-08-26T13:00:00.000+09:00',
  };
}

describe('checkAccountHealth', () => {
  beforeEach(() => {
    getLineAccounts.mockReset();
    createAccountHealthLog.mockReset();
    getAccountHealthLogs.mockReset();
    getLinePlanQuotaShortfall.mockReset().mockResolvedValue(null);
    notifyQuotaAlert.mockReset().mockResolvedValue(true);
    countDeliverableAudience.mockClear();
    getLineAccounts.mockResolvedValue([
      { id: 'acc-1', channel_access_token: 'token', is_active: 1 },
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('状態が前回から変わっていなければログを書かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).not.toHaveBeenCalled();
  });

  test('403 が出て risk が変わったらログを書く', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      lineAccountId: 'acc-1',
      errorCode: 403,
      riskLevel: 'danger',
    });
  });

  test('403 が続いている間は最初の1回しか書かない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    getAccountHealthLogs.mockResolvedValue([log('danger', 403)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).not.toHaveBeenCalled();
  });

  test('履歴が1件も無ければ現在の状態を記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      riskLevel: 'normal',
      errorCode: undefined,
    });
  });

  test('risk は同じでもエラーコードが変わったら記録する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      errorCode: 500,
      riskLevel: 'normal',
    });
  });

  test('checkQuota 無し (5分 tick) はクォータチェックをスキップする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub());

    expect(getLinePlanQuotaShortfall).not.toHaveBeenCalled();
  });

  test('クォータ残0 → danger で記録しオペレーターへ通知する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);
    getLinePlanQuotaShortfall.mockResolvedValue({
      limit: 200, consumption: 200, remaining: 0, audience: 150,
    });

    await checkAccountHealth(dbStub(), { checkQuota: true });

    expect(createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({ riskLevel: 'danger' });
    expect(notifyQuotaAlert).toHaveBeenCalledTimes(1);
    expect(notifyQuotaAlert.mock.calls[0][1]).toMatchObject({
      lineAccountId: 'acc-1',
      source: 'health-check',
    });
  });

  test('クォータ残があるが配信対象に足りない → warning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);
    getLinePlanQuotaShortfall.mockResolvedValue({
      limit: 1000, consumption: 900, remaining: 100, audience: 500,
    });

    await checkAccountHealth(dbStub(), { checkQuota: true });

    expect(createAccountHealthLog.mock.calls[0][1]).toMatchObject({ riskLevel: 'warning' });
    expect(notifyQuotaAlert).toHaveBeenCalledTimes(1);
  });

  test('クォータ warning が継続中でもヘルスログは重複記録しない (通知 dedup は notifyQuotaAlert 側)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    getAccountHealthLogs.mockResolvedValue([log('warning', null)]);
    getLinePlanQuotaShortfall.mockResolvedValue({
      limit: 1000, consumption: 900, remaining: 100, audience: 500,
    });

    await checkAccountHealth(dbStub(), { checkQuota: true });

    expect(createAccountHealthLog).not.toHaveBeenCalled();
    // 通知の呼び出し自体は毎 tick 行われ、月次 dedup は notifyQuotaAlert が持つ
    expect(notifyQuotaAlert).toHaveBeenCalledTimes(1);
  });

  test('bot/info が失敗しているときはクォータチェックをスキップする', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    getAccountHealthLogs.mockResolvedValue([log('normal', null)]);

    await checkAccountHealth(dbStub(), { checkQuota: true });

    expect(getLinePlanQuotaShortfall).not.toHaveBeenCalled();
    expect(notifyQuotaAlert).not.toHaveBeenCalled();
>>>>>>> upstream/main
  });
});
