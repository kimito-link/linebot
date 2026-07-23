// ファン記憶（2026-07-23 追加）。会話から抽出した原子的な事実をfriend単位で保存し、
// 応答生成時にsystem promptへ注入する。顔認識等の生体情報は扱わない
// （_docs/FAN-MEMORY-DESIGN.md参照）。今回のスコープは呼び名(nickname)のみ。

export type FanMemoryCategory =
  | 'nickname'
  | 'oshi_history'
  | 'favorite'
  | 'event'
  | 'anniversary'
  | 'topic'
  | 'other';

export interface FanMemoryRow {
  id: string;
  category: FanMemoryCategory;
  fact: string;
}

/** friendの記憶を取得し、応答生成のsystem promptに注入する短いコンテキスト文字列を返す。 */
export async function buildFanMemoryContext(
  db: D1Database,
  friendId: string,
): Promise<string | null> {
  const rows = await db
    .prepare(
      `SELECT id, category, fact FROM fan_memory WHERE friend_id = ? ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(friendId)
    .all<FanMemoryRow>();

  if (rows.results.length === 0) return null;

  const lines = rows.results.map((row) => `- (${row.category}) ${row.fact}`);
  return lines.join('\n');
}

/** 参照した記憶のreference_countとlast_referenced_atを更新する。応答生成後に呼ぶ。 */
export async function markFanMemoryReferenced(
  db: D1Database,
  memoryIds: string[],
): Promise<void> {
  if (memoryIds.length === 0) return;
  const now = new Date().toISOString();
  await db.batch(
    memoryIds.map((id) =>
      db
        .prepare(
          `UPDATE fan_memory SET reference_count = reference_count + 1, last_referenced_at = ? WHERE id = ?`,
        )
        .bind(now, id),
    ),
  );
}

/** friendの呼び名(nickname)を1件だけ取得する。無ければnull。 */
export async function getNickname(db: D1Database, friendId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT fact FROM fan_memory WHERE friend_id = ? AND category = 'nickname' ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(friendId)
    .first<{ fact: string }>();
  return row?.fact ?? null;
}

/**
 * 「〜って呼んで」「〜と呼んでね」のような明示的な呼び名指定をルールベースで検出する。
 * LLM抽出は本格実装が別途必要なため、今回のスコープはこの明示パターンのみ
 * （2026-07-23、fan_memory機能の最小スコープ実装）。
 */
export function detectNicknameRequest(text: string): string | null {
  const match = text.match(/(.{1,20}?)(?:って|と)呼んで/);
  if (!match) return null;
  const nickname = match[1].trim();
  if (!nickname) return null;
  return nickname;
}

/** 呼び名を保存する（同一friendの既存nicknameは上書きせず追加。最新が優先される）。 */
export async function saveNickname(
  db: D1Database,
  friendId: string,
  nickname: string,
  sourceMessageId?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fan_memory (id, friend_id, category, fact, source_message_id)
       VALUES (?, ?, 'nickname', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, nickname, sourceMessageId ?? null)
    .run();
}
