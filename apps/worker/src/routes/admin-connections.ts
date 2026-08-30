// =============================================================================
// 接続状態の可視化 — 「どこがどう繋がっているか分からない」を潰すためのAPI
// =============================================================================
//
// 【背景】
// このWorkerは外部接続の多くが「未設定でも静かにスキップ」する設計になっている
// （Groq/Gemini/GITHUB_TOKEN/VOICE_SYNTH_* など）。安全側の設計だが、
// 裏返すと**設定を忘れても何も言わずに動き続ける**。実際にLINE導線が切れていたのに
// 誰も気づけなかった。ここはその可視化に徹する。
//
// 【出さないもの】
// シークレットの値は一切返さない。返すのは「設定されているか」と「未設定なら何が起きるか」。
// テスト（admin-connections.test.ts）で漏洩しないことを固定してある。
//
// 【緑にしない原則】
// 実際に疎通を確認していないものを 'ok' にしない。設定済みでも 'unverified'。
// 疎通まで見るのは、そのための仕組みが既にある LINE だけ（ban-monitor が毎分記録）。

import { Hono } from 'hono';
import { buildConnectionStates, type ConnectionState } from '../services/connection-registry.js';
import { getBotConfig } from '../services/groq-config.js';
import type { Env } from '../index.js';

const adminConnections = new Hono<Env>();

interface AccountHealthRow {
  line_account_id: string;
  risk_level: string;
  created_at: string;
}

/**
 * GET /api/admin/connections
 *
 * 接続の設定状況と、分かる範囲の疎通結果を返す。
 * 認証は middleware/auth.ts の staff 認証（/api/* に既定で掛かる）。
 */
adminConnections.get('/api/admin/connections', async (c) => {
  const states: ConnectionState[] = buildConnectionStates(
    c.env as unknown as Record<string, unknown>,
  );

  // LINEだけは実測値がある。ban-monitor が毎分 /v2/bot/info を叩いて
  // account_health_logs に残しているので、その最新を状態に反映する。
  // （このリクエストの中で外部APIを叩くことはしない。遅くなるうえ、
  //   管理画面を開くたびにレート制限を消費するため）
  let lineProbe: { checkedAt: string | null; danger: number; warning: number; total: number } = {
    checkedAt: null, danger: 0, warning: 0, total: 0,
  };
  let probeError: string | null = null;

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT h.line_account_id, h.risk_level, h.created_at
         FROM account_health_logs h
         INNER JOIN (
           SELECT line_account_id, MAX(created_at) AS latest
             FROM account_health_logs
            GROUP BY line_account_id
         ) m ON m.line_account_id = h.line_account_id AND m.latest = h.created_at`,
    ).all<AccountHealthRow>();

    const rows = results ?? [];
    lineProbe = {
      checkedAt: rows.reduce<string | null>(
        (max, r) => (max === null || r.created_at > max ? r.created_at : max),
        null,
      ),
      danger: rows.filter((r) => r.risk_level === 'danger').length,
      warning: rows.filter((r) => r.risk_level === 'warning').length,
      total: rows.length,
    };
  } catch (err) {
    // 取れなかったことを黙って隠さない。'ok' に倒さず、理由を返す。
    probeError = err instanceof Error ? err.message : String(err);
  }

  const withProbe = states.map((s) => {
    if (s.id !== 'line-messaging' || !s.configured) return s;
    if (probeError !== null || lineProbe.total === 0) {
      // 実測できていないので unverified のまま（緑にしない）
      return s;
    }
    return {
      ...s,
      status: lineProbe.danger > 0 ? ('ng' as const) : ('ok' as const),
      probe: {
        checkedAt: lineProbe.checkedAt,
        danger: lineProbe.danger,
        warning: lineProbe.warning,
        accounts: lineProbe.total,
        source: 'account_health_logs（ban-monitorが毎分更新）',
      },
    };
  });

  return c.json({
    success: true,
    data: {
      connections: withProbe,
      // 「静かにスキップする」接続のうち未設定のもの＝気づきにくい欠落。
      // 画面で最初に目に入るよう、別枠で数えておく。
      silentlyMissing: states
        .filter((s) => !s.configured && s.degrade === 'silent-skip')
        .map((s) => ({ id: s.id, label: s.label, missingKeys: s.missingKeys, whenMissing: s.whenMissing })),
      probeError,
      generatedAt: new Date().toISOString(),
    },
  });
});

interface UsageRow {
  line_account_id: string | null;
  usage_date: string;
  groq_calls: number;
  cache_hits: number;
  escalations: number;
}

/**
 * GET /api/admin/llm-usage
 *
 * LLMの当日使用量と予算残。予算は bot.config.json の llm.dailyCallBudget。
 * 予算超過時は fail-closed（無言にはならず定型文で返す）。
 */
adminConnections.get('/api/admin/llm-usage', async (c) => {
  // JSTの当日。groq_usage_daily の usage_date と揃える必要がある。
  const jstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const budget = getBotConfig().llm.dailyCallBudget;

  try {
    const { results } = await c.env.DB.prepare(
      `SELECT line_account_id, usage_date, groq_calls, cache_hits, escalations
         FROM groq_usage_daily
        WHERE usage_date = ?
        ORDER BY groq_calls DESC`,
    ).bind(jstDate).all<UsageRow>();

    const rows = results ?? [];
    return c.json({
      success: true,
      data: {
        date: jstDate,
        budget,
        accounts: rows.map((r) => ({
          lineAccountId: r.line_account_id,
          calls: r.groq_calls,
          cacheHits: r.cache_hits,
          escalations: r.escalations,
          remaining: Math.max(0, budget - r.groq_calls),
          exceeded: r.groq_calls >= budget,
        })),
        totalCalls: rows.reduce((sum, r) => sum + r.groq_calls, 0),
      },
    });
  } catch (err) {
    // ここも「取れなかった」を成功に混ぜない。
    return c.json(
      {
        success: false,
        error: 'usage_query_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

export { adminConnections };
