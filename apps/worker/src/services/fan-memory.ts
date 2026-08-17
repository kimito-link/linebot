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

/**
 * friendの記憶を取得し、応答生成のsystem promptに注入する短いコンテキスト文字列を返す。
 * confirmed=0（同意待ちの記憶申し出、下記「記憶の同意フロー」参照）は含めない。
 * まだ確定していない記憶をシステムプロンプトに載せてしまうと、ユーザーが同意する前から
 * 「覚えている」ふりをすることになり、同意フローの意味が壊れるため。
 */
export async function buildFanMemoryContext(
  db: D1Database,
  friendId: string,
): Promise<string | null> {
  const rows = await db
    .prepare(
      `SELECT id, category, fact FROM fan_memory WHERE friend_id = ? AND confirmed = 1 ORDER BY created_at DESC LIMIT 20`,
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

/**
 * 記憶の同意フロー（2026-07-24 追加、_docs/MEMORY-KIMITOLINK-DEMO-DESIGN.md）。
 * 呼び名のような明示指定と異なり、個人的な打ち明け話は同意なしに保存しない。
 *
 * 流れ:
 * 1. LLMが「覚えておいてもいいですか？」と申し出るとき、応答に[REMEMBER_OFFER: 要約]
 *    マーカーを含める（llm-providers.tsのparseReplyTextがマーカーを抽出しテキストから除去、
 *    GroqReplyResult.rememberOfferとして呼び出し元に渡す）。
 * 2. webhook.tsが申し出を受け取った時点でconfirmed=0の行をINSERT（savePendingMemory）。
 *    まだ「覚えた」ことにはしない。
 * 3. 次のユーザー発言でwebhook.tsがisMemoryConsentを判定し、同意ならconfirmPendingMemory
 *    （confirmed=1に更新）、明確な拒否ならrejectPendingMemory（削除）を呼ぶ。
 *    肯定でも否定でもない発言のときは何もしない（confirmed=0のまま残るが、
 *    buildFanMemoryContextはconfirmed=1のみ拾うため実害はない。将来的に一定期間後の
 *    自動失効が必要なら別途cronで掃除する）。
 */

const REMEMBER_OFFER_PATTERN = /\[REMEMBER_OFFER:\s*(.+?)\]/;

/** LLM応答から記憶申し出マーカーを抽出する。無ければnull。表示用テキストからはマーカーを取り除く。 */
export function extractRememberOffer(replyText: string): { displayText: string; fact: string } | null {
  const match = replyText.match(REMEMBER_OFFER_PATTERN);
  if (!match) return null;
  const fact = match[1].trim();
  if (!fact) return null;
  const displayText = replyText.replace(REMEMBER_OFFER_PATTERN, '').trim();
  return { displayText, fact };
}

const MEMORY_NEGATIVE_PATTERN = /(いや|やめ|やだ|覚えなくて|結構です|いいえ)/;
const MEMORY_POSITIVE_PATTERN = /(お願い|いいよ|うん|覚えて|ぜひ|はい|OK|オッケー)/i;

/**
 * ユーザーの発言が記憶への同意かをルールベースで判定する。
 * 明確な否定語を含む場合はfalse、含まず肯定語を含む場合はtrue。
 * fail-closed: 判定に迷う（否定語も肯定語も無い）場合はfalse（未確定のまま残す）。
 */
export function isMemoryConsent(text: string): boolean {
  if (MEMORY_NEGATIVE_PATTERN.test(text)) return false;
  return MEMORY_POSITIVE_PATTERN.test(text);
}

/** ユーザーの発言が記憶申し出への明確な拒否かをルールベースで判定する。 */
export function isMemoryRejection(text: string): boolean {
  return MEMORY_NEGATIVE_PATTERN.test(text) && !MEMORY_POSITIVE_PATTERN.test(text);
}

/** りんくが記憶を申し出た時点で、未確定（confirmed=0）の記憶を作る。categoryは'topic'固定。 */
export async function savePendingMemory(
  db: D1Database,
  friendId: string,
  fact: string,
  sourceMessageId?: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fan_memory (id, friend_id, category, fact, confirmed, source_message_id)
       VALUES (?, ?, 'topic', ?, 0, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, fact, sourceMessageId ?? null)
    .run();
}

/** friendの直近の未確定記憶を確定させる（confirmed=1に更新）。無ければ何もしない。 */
export async function confirmPendingMemory(db: D1Database, friendId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM fan_memory WHERE friend_id = ? AND confirmed = 0 ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(friendId)
    .first<{ id: string }>();
  if (!row) return false;
  await db.prepare(`UPDATE fan_memory SET confirmed = 1 WHERE id = ?`).bind(row.id).run();
  return true;
}

/** friendの直近の未確定記憶を削除する（拒否時）。無ければ何もしない。 */
export async function rejectPendingMemory(db: D1Database, friendId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM fan_memory WHERE friend_id = ? AND confirmed = 0 ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(friendId)
    .first<{ id: string }>();
  if (!row) return false;
  await db.prepare(`DELETE FROM fan_memory WHERE id = ?`).bind(row.id).run();
  return true;
}

/**
 * 「忘れて」コマンドをルールベースで検出する。特定の記憶を指定しない全体忘却要求
 * （例:「その話、忘れて」「今の、忘れて」）を対象とする。今回のスコープは
 * 直近1件（確定済み）の削除のみ（複数記憶からの選択削除は将来拡張）。
 */
export function detectForgetRequest(text: string): boolean {
  return /(忘れて|覚えなくて(いい|良い))/.test(text);
}

/** friendの直近の確定済み記憶を1件削除する。記憶が無ければ何もしない。 */
export async function forgetLatestMemory(db: D1Database, friendId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT id FROM fan_memory WHERE friend_id = ? AND confirmed = 1 ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(friendId)
    .first<{ id: string }>();
  if (!row) return false;
  await db.prepare(`DELETE FROM fan_memory WHERE id = ?`).bind(row.id).run();
  return true;
}
