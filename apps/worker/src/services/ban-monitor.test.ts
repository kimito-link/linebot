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
  });
});
