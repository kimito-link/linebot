export const ESCALATION_MARKER = '[ESCALATE]';

export type GroqReplyKind = 'reply' | 'escalate' | 'fail_closed';

export interface GroqReplyResult {
  kind: GroqReplyKind;
  text?: string;
  /**
   * 記憶の同意フロー（2026-07-24追加、fan-memory.ts参照）。りんくが「覚えておいて
   * もいいですか？」と申し出た応答から抽出した要約。ユーザーへの表示テキスト(text)
   * からは既に除去済み。呼び出し元がconfirmed=0の記憶行を作る材料に使う。
   */
  rememberOfferFact?: string;
}

// Groq単体へのHTTP呼び出し本体は llm-providers.ts の callGroq() に統合済み
// （2026-07-17 Fable設計「無応答ゼロ化アーキテクチャ」。旧 generateGroqReply は
// llm-chain.ts の generateLlmReplyWithFallback がGroq/Gemini/Workers AIの
// チェーンとして置き換えた）。このファイルには ESCALATION_MARKER 定数と
// account_settings 由来の設定関数のみ残す。

export interface GroqReplyConfig {
  enabled: boolean;
}

/** Per-account Groq opt-in via account_settings (mirrors llm-reply pattern). */
export async function getGroqReplyConfig(
  db: D1Database,
  lineAccountId: string | null,
): Promise<GroqReplyConfig> {
  if (!lineAccountId) return { enabled: false };

  const row = await db
    .prepare(
      `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'groq_reply_enabled'`,
    )
    .bind(lineAccountId)
    .first<{ value: string }>();

  return { enabled: row?.value === 'true' };
}

const MAX_HISTORY_MESSAGES = 6;

/**
 * image行のcontent JSONを履歴用テキストに変換する（2026-07-17画像認識機能追加、§7.2）。
 * visionSummaryがあれば`[画像: <説明>]`、無ければ（describe失敗行・旧ラベル文字列行）
 * `[画像]`にフォールバックする。
 */
function imageRowToHistoryText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { visionSummary?: string };
    return parsed.visionSummary ? `[画像: ${parsed.visionSummary}]` : '[画像]';
  } catch {
    return '[画像]';
  }
}

export async function buildGroqHistory(
  db: D1Database,
  friendId: string,
  excludeLogId?: string,
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  // excludeLogId: 呼び出し元がこの受信を処理する前にmessages_logへ既にINSERT/UPDATE
  // 済みの「今回自身の行」のid。指定しないと直近履歴の末尾に今回分が紛れ込み、
  // 呼び出し側が別途渡すincomingText（画像のvision説明+人格指示などの実際の
  // LLM向けテキスト）と食い違ったまま履歴の方が優先されてしまう
  // （2026-07-19 実障害: 画像に無機質な客観描写だけを返す不具合の根本原因）。
  const rows = excludeLogId
    ? await db
        .prepare(
          `SELECT direction, content, message_type FROM messages_log
           WHERE friend_id = ? AND message_type IN ('text', 'image') AND id != ?
           ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(friendId, excludeLogId, MAX_HISTORY_MESSAGES)
        .all<{ direction: string; content: string; message_type: string }>()
    : await db
        .prepare(
          `SELECT direction, content, message_type FROM messages_log
           WHERE friend_id = ? AND message_type IN ('text', 'image')
           ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(friendId, MAX_HISTORY_MESSAGES)
        .all<{ direction: string; content: string; message_type: string }>();

  return rows.results
    .reverse()
    .map((row) => ({
      role: row.direction === 'incoming' ? ('user' as const) : ('assistant' as const),
      content: row.message_type === 'image' ? imageRowToHistoryText(row.content) : row.content,
    }));
}
