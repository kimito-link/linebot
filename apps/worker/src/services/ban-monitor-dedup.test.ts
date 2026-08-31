import { describe, it, expect, vi, beforeEach } from 'vitest';

// ヘルスログを毎分ぶん書き続けないことを固定する。
//
// checkAccountHealth は index.ts の scheduled から **cron分岐より前** で
// 呼ばれるので、毎分の tick ごとに走る。無条件に INSERT すると異常が
// 1件も無いアカウントでも 1日1,440行が積み上がり、古い行を消す仕組みも無い。
//
// ヘルスログは「チェックした記録」ではなく「状態が変わった履歴」。
// 同じ状態を連投すると、本当に見たい変化がその中に埋もれる。

const dbMocks = {
  getLineAccounts: vi.fn(),
  createAccountHealthLog: vi.fn().mockResolvedValue(undefined),
  getAccountHealthLogs: vi.fn().mockResolvedValue([]),
};
vi.mock('@line-crm/db', () => dbMocks);

const { checkAccountHealth } = await import('./ban-monitor.js');

/** messages_log のCOUNTを返すだけのD1スタブ */
function makeDb(sent: number, failed: number) {
  let call = 0;
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          call += 1;
          return { count: call === 1 ? sent : failed };
        },
      }),
    }),
  } as unknown as D1Database;
}

const ACCOUNT = { id: 'acc-1', channel_access_token: 'tok', is_active: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.getLineAccounts.mockResolvedValue([ACCOUNT]);
  dbMocks.createAccountHealthLog.mockResolvedValue(undefined);
  // LINE API を実際に叩く実装なので、既定は「正常応答」に固定する。
  // モックしないと fetch が失敗して errorCode が入り、risk_level が
  // normal にならず、何を試しているのか分からないテストになる。
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

describe('ヘルスログの重複抑止', () => {
  it('★直前と同じ状態なら書かない（毎分の連投を防ぐ）', async () => {
    dbMocks.getAccountHealthLogs.mockResolvedValue([
      { risk_level: 'normal', error_code: null },
    ]);
    await checkAccountHealth(makeDb(10, 0));
    expect(dbMocks.createAccountHealthLog).not.toHaveBeenCalled();
  });

  it('★記録が1件も無ければ書く（初回は残す）', async () => {
    dbMocks.getAccountHealthLogs.mockResolvedValue([]);
    await checkAccountHealth(makeDb(10, 0));
    expect(dbMocks.createAccountHealthLog).toHaveBeenCalledTimes(1);
  });

  it('★risk_level が変わったら書く（変化は取りこぼさない）', async () => {
    dbMocks.getAccountHealthLogs.mockResolvedValue([
      { risk_level: 'warning', error_code: null },
    ]);
    await checkAccountHealth(makeDb(10, 0)); // normal になる
    expect(dbMocks.createAccountHealthLog).toHaveBeenCalledTimes(1);
  });

  it('★risk_levelが同じでもerror_codeが変われば書く（別の事象として扱う）', async () => {
    dbMocks.getAccountHealthLogs.mockResolvedValue([
      { risk_level: 'normal', error_code: 429 },
    ]);
    await checkAccountHealth(makeDb(10, 0)); // error_code は null になる
    expect(dbMocks.createAccountHealthLog).toHaveBeenCalledTimes(1);
  });

  it('★危険な状態(403=BAN疑い)への変化は必ず記録される', async () => {
    dbMocks.getAccountHealthLogs.mockResolvedValue([
      { risk_level: 'normal', error_code: null },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await checkAccountHealth(makeDb(10, 0));
    expect(dbMocks.createAccountHealthLog).toHaveBeenCalledTimes(1);
    expect(dbMocks.createAccountHealthLog.mock.calls[0][1]).toMatchObject({
      riskLevel: 'danger',
      errorCode: 403,
    });
  });

  it('★danger が続いている間は連投しない（異常時も溜めない）', async () => {
    dbMocks.getAccountHealthLogs.mockResolvedValue([
      { risk_level: 'danger', error_code: 403 },
    ]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    await checkAccountHealth(makeDb(10, 0));
    expect(dbMocks.createAccountHealthLog).not.toHaveBeenCalled();
  });

  it('無効なアカウントは触らない', async () => {
    dbMocks.getLineAccounts.mockResolvedValue([{ ...ACCOUNT, is_active: 0 }]);
    await checkAccountHealth(makeDb(10, 0));
    expect(dbMocks.createAccountHealthLog).not.toHaveBeenCalled();
    expect(dbMocks.getAccountHealthLogs).not.toHaveBeenCalled();
  });
});
