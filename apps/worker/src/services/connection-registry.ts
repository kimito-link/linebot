// =============================================================================
// 接続レジストリ — この Worker が何と繋がっているかの唯一の正本
// =============================================================================
//
// 【なぜこれがあるのか】
// 「どこがどうつながっているか分からない」という問題が実際に起きた。
// 原因は、接続の多くが**未設定でも静かにスキップする**設計だから。
// 設定を忘れても何も言わずに動き続けるので、欠けていることに気づけない。
//
// 【100年後に楽をするための約束】
// 1. 一覧をここ以外に書かない。管理画面もチェックスクリプトもここを読む。
// 2. 接続を足したら、ここに1行足す。足し忘れたら check-connections が落ちる
//    （Env型と突き合わせているので、人が覚えておく必要がない）。
// 3. **「測れなかった」を緑にしない**。未設定・確認手段なしは unknown であって
//    ok ではない。既存の3値exit規約（web-ios-android の instrument-core.mjs）と同じ思想。
//
// 【絶対にやらないこと】
// シークレットの値そのものを外に出さない。**設定されているか否か**だけを扱う。

/**
 * 接続の状態。「測れなかった」を「正常」と混ぜないための3値
 * （+ 未設定を別扱いにした4値）。
 */
export type ConnectionStatus =
  /** 実際に疎通を確認できた。**実測したときだけ** */
  | 'ok'
  /** 確認したうえで失敗した */
  | 'ng'
  /** 設定はされているが、疎通は確認していない。**緑ではない** */
  | 'unverified'
  /** 必要な設定が欠けている */
  | 'unconfigured';

/** 接続が使えないときに何が起きるか。運用者が「放置してよいか」を判断する材料。 */
export type DegradeMode =
  /** 未設定でも静かに動き続ける（＝欠けていても気づけない。要注意） */
  | 'silent-skip'
  /** 別の手段に自動で切り替わる */
  | 'fallback'
  /** その機能が止まる */
  | 'feature-off'
  /** 閉じる（fail-closed）。安全側に倒れる */
  | 'fail-closed'
  /** これが無いと Worker 自体が成り立たない */
  | 'required';

export interface ConnectionSpec {
  /** 安定した識別子。画面のキーにも使うので変えない。 */
  id: string;
  /** 人が読むラベル。 */
  label: string;
  /** どの分類か（画面のグルーピング用）。 */
  group: 'line' | 'llm' | 'storage' | 'integration' | 'ops';
  /**
   * この接続に必要な Env のキー。全部揃って初めて configured になる。
   * ここに書いた名前は check-connections が Env 型と突き合わせる。
   */
  envKeys: string[];
  /** 未設定・切断時の挙動。 */
  degrade: DegradeMode;
  /** 未設定だと何が起きるかを人の言葉で。画面にそのまま出す。 */
  whenMissing: string;
  /** 実装がどこにあるか（追いかけるときの入口）。 */
  source: string;
}

/**
 * 接続の一覧。**ここが唯一の正本**。
 *
 * 並び順は画面の表示順を兼ねる（重要なものから）。
 */
export const CONNECTIONS: ConnectionSpec[] = [
  // ── LINE ──────────────────────────────────────────────────────────────
  {
    id: 'line-messaging',
    label: 'LINE Messaging API',
    group: 'line',
    envKeys: ['LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'],
    degrade: 'required',
    whenMissing: 'Botが応答できない。これが無いと成り立たない。',
    source: 'packages/line-sdk/src/client.ts',
  },
  {
    id: 'line-login',
    label: 'LINE Login / LIFF',
    group: 'line',
    envKeys: ['LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET', 'LIFF_URL'],
    degrade: 'feature-off',
    whenMissing: 'LIFFページのログインができない。',
    source: 'apps/worker/src/routes/liff.ts',
  },

  // ── LLM（無応答ゼロ化チェーン。1→2→3の順に落ちる） ──────────────────
  {
    id: 'llm-groq',
    label: 'Groq（LLM 1段目）',
    group: 'llm',
    envKeys: ['GROQ_API_KEY'],
    degrade: 'fallback',
    whenMissing: '1段目をスキップし、Gemini（2段目）へ落ちる。',
    source: 'apps/worker/src/services/llm-chain.ts',
  },
  {
    id: 'llm-gemini',
    label: 'Gemini（LLM 2段目・画像/動画/音声の理解も担当）',
    group: 'llm',
    envKeys: ['GEMINI_API_KEY'],
    degrade: 'silent-skip',
    whenMissing:
      '2段目をスキップ。加えて**動画・音声の内容理解が静かに無効化される**（テキスト応答は動くので気づきにくい）。',
    source: 'apps/worker/src/services/llm-chain.ts, services/media-describe.ts',
  },
  {
    id: 'llm-workers-ai',
    label: 'Cloudflare Workers AI（LLM 3段目・最後の砦）',
    group: 'llm',
    envKeys: ['AI'],
    degrade: 'fallback',
    whenMissing: '最後の砦が無くなる。全段落ちるとfail-closedの定型文を返す（無言にはならない）。',
    source: 'apps/worker/src/services/llm-chain.ts',
  },
  {
    id: 'llm-anthropic',
    label: 'Anthropic（旧経路・Groq有効時は未使用）',
    group: 'llm',
    envKeys: ['ANTHROPIC_API_KEY'],
    degrade: 'silent-skip',
    whenMissing: 'GROQ_API_KEYがあるなら影響なし（コストガードのため、そもそも呼ばれない）。',
    source: 'apps/worker/src/services/llm-reply.ts',
  },

  // ── ストレージ ────────────────────────────────────────────────────────
  {
    id: 'd1',
    label: 'D1（データベース）',
    group: 'storage',
    envKeys: ['DB'],
    degrade: 'required',
    whenMissing: '友だち・設定・ログの全てが読めない。成り立たない。',
    source: 'apps/worker/wrangler.toml [[d1_databases]]',
  },
  {
    id: 'r2',
    label: 'R2（画像・音声の保管）',
    group: 'storage',
    envKeys: ['IMAGES'],
    degrade: 'feature-off',
    whenMissing: '受信画像の保存と音声返信ができない。テキスト応答は動く。',
    source: 'apps/worker/wrangler.toml [[r2_buckets]]',
  },

  // ── 連携 ──────────────────────────────────────────────────────────────
  {
    id: 'voice-synth',
    label: '音声合成サーバー（声で返す）',
    group: 'integration',
    envKeys: ['VOICE_SYNTH_ENDPOINT', 'VOICE_SYNTH_TOKEN'],
    degrade: 'silent-skip',
    whenMissing: '音声で返せず、テキストに落ちる（無言にはならない）。',
    source: 'apps/worker/src/services/voice-reply.ts',
  },
  {
    id: 'github-issues',
    label: 'GitHub Issues（「タスク:」でIssue作成）',
    group: 'integration',
    envKeys: ['GITHUB_TOKEN'],
    degrade: 'silent-skip',
    whenMissing: '「タスク:」で始まるメッセージが**黙って捨てられる**。',
    source: 'apps/worker/src/services/ai-shain-worker-task.ts',
  },
  {
    id: 'github-webhook',
    label: 'GitHub Webhook 受信（承認カード）',
    group: 'integration',
    envKeys: ['GITHUB_WEBHOOK_SECRET'],
    degrade: 'fail-closed',
    whenMissing: '503で閉じる。承認カードが届かない（安全側）。',
    source: 'apps/worker/src/routes/github-webhook.ts',
  },
  {
    id: 'x-harness',
    label: 'X Harness 連携',
    group: 'integration',
    envKeys: ['X_HARNESS_URL'],
    degrade: 'silent-skip',
    whenMissing: 'アカウント連携が静かにスキップされる。',
    source: 'apps/worker/src/routes/liff.ts',
  },
  {
    id: 'ig-harness',
    label: 'IG Harness 連携',
    group: 'integration',
    envKeys: ['IG_HARNESS_URL', 'IG_HARNESS_LINK_SECRET'],
    degrade: 'silent-skip',
    whenMissing: 'クロスプラットフォーム連携が静かにスキップされる。',
    source: 'apps/worker/src/routes/liff.ts',
  },

  // ── 運用 ──────────────────────────────────────────────────────────────
  {
    id: 'diag',
    label: '診断ページ（/shindan）',
    group: 'ops',
    envKeys: ['DIAG_VIEW_PASSWORD'],
    degrade: 'fail-closed',
    whenMissing: '503。誰でも見られる状態を既定にしない設計。',
    source: 'apps/worker/src/routes/diag.ts',
  },
  {
    id: 'self-update',
    label: '自己更新（/admin/update）',
    group: 'ops',
    envKeys: ['ADMIN_API_KEY', 'CF_API_TOKEN', 'CF_ACCOUNT_ID'],
    degrade: 'feature-off',
    whenMissing: '401。管理画面からの更新ができない。',
    source: 'apps/worker/src/routes/admin-update.ts',
  },
];

/** 環境変数の入れ物（Envのうち、判定に使うキーだけを緩く受ける）。 */
export type EnvLike = Record<string, unknown>;

export interface ConnectionState extends ConnectionSpec {
  /** 必要なキーが全て揃っているか。 */
  configured: boolean;
  /** 揃っていないキーの名前（**値は含めない**）。 */
  missingKeys: string[];
  /** 3値の状態。 */
  status: ConnectionStatus;
}

/**
 * 設定の有無から接続状態を組み立てる。
 *
 * **ここでは実際の疎通はしない**（Workerのリクエスト内で全接続に通信すると遅く、
 * かつ外部APIのレート制限を叩く）。疎通確認が要るものは、既に専用の仕組みがある:
 * - LINE → services/ban-monitor.ts が毎分チェックし account_health_logs に記録
 * - 無応答 → GET /api/diag/bot-health
 *
 * したがってここが返すのは「設定されているか」であり、
 * **設定済み = 疎通OK ではない**。だから configured でも status は 'unknown' にする
 * （実測していないものを緑にしない、という原則）。
 */
export function buildConnectionStates(env: EnvLike): ConnectionState[] {
  return CONNECTIONS.map((spec) => {
    const missingKeys = spec.envKeys.filter((k) => {
      const v = env[k];
      if (v === undefined || v === null) return true;
      // 空文字も未設定として扱う（wrangler secret に空を入れた事故を拾う）
      if (typeof v === 'string' && v.trim() === '') return true;
      return false;
    });
    const configured = missingKeys.length === 0;
    return {
      ...spec,
      configured,
      missingKeys,
      // 設定されていても、ここでは疎通していないので 'ok' とは言い切らない。
      // 実測できる接続（LINE等）の結果は呼び出し側が 'ok'/'ng' で上書きする。
      status: configured ? 'unverified' : 'unconfigured',
    };
  });
}
