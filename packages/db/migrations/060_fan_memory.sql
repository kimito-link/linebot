-- ファン記憶機能（2026-07-23 追加）。
-- 会話から抽出した原子的な事実（呼び名・推し歴・好きなもの・話題等）をfriend単位で
-- 保存し、応答生成時にシステムプロンプトへ注入することで「覚えていてくれた」
-- 体験を実現する。顔認識等の生体情報は一切扱わない設計（_docs参照）。
-- 1事実1行（会話要約の塊は保存しない）。source_message_idで出所を追跡し、
-- 「忘れて」コマンドやメモリ帳UIからの個別削除・全削除（削除権対応）を可能にする。
CREATE TABLE IF NOT EXISTS fan_memory (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  category           TEXT NOT NULL CHECK (category IN ('nickname', 'oshi_history', 'favorite', 'event', 'anniversary', 'topic', 'other')),
  fact               TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 1.0,
  source_message_id  TEXT REFERENCES messages_log (id) ON DELETE SET NULL,
  reference_count    INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  last_referenced_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_fan_memory_friend_id ON fan_memory (friend_id);
CREATE INDEX IF NOT EXISTS idx_fan_memory_friend_category ON fan_memory (friend_id, category);
