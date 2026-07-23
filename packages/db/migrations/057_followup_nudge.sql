-- 自発的フォローアップ機能（2026-07-21 追加）。
-- ユーザーの最終発言から一定時間経過し、かつBot側から一度もフォローアップを
-- 送っていないfriendに対し、cronジョブがAI生成の一言を能動的に送信する。
-- 「OpenClaw方式」（星野ロミ氏の実装例に触発）: 返信がないユーザーに、
-- 会話履歴を踏まえたAIが自然な一言を自動で送る。
ALTER TABLE friends ADD COLUMN last_followup_sent_at TEXT;

CREATE INDEX IF NOT EXISTS idx_friends_last_followup_sent_at ON friends (last_followup_sent_at);
