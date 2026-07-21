-- 動画サムネイルの知覚ハッシュ（dHash）レジストリ（自己言及Tier 0.5、2026-07-21）。
-- Tier 0（SHA-256完全一致）はLINEの動画再エンコードでバイト列が変わりほぼ
-- ヒットしない実障害を確認済み。dHashは再エンコード・軽微な圧縮に強い近似一致
-- 判定で、AI（Gemini/Groq）を一切使わない決定的判定として動く。
-- 1動画につき複数のハッシュを持ちうる（エンコード経路違いで別ハッシュになるため）。
CREATE TABLE IF NOT EXISTS bot_media_phash (
  phash TEXT NOT NULL,
  hash_kind TEXT NOT NULL DEFAULT 'dhash_9x8',
  character TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (phash, hash_kind)
);
