-- 063_email_events.sql
--
-- 受け取った通知メールの処理記録。★目的は2つ。
--   1. 同じメールを二度LINEへ流さない（message_id の UNIQUE が要）
--   2. 届かなかったもの・当たらなかったものを後から追える（黙って捨てない）
--
-- 設計: stripe_events と同型（外部IDに UNIQUE を張り、処理前に SELECT する）。
-- ★本文は保存しない。件名も先頭だけ。個人情報をD1に溜めないため。
CREATE TABLE IF NOT EXISTS email_events (
  id           TEXT PRIMARY KEY,
  -- Message-ID。無いメールは 'no-msgid:<hash>' を入れる（捨てない）
  message_id   TEXT NOT NULL UNIQUE,
  from_address TEXT,
  -- どこから差出人を判定したか。'header-from' / 'reply-to' / 'body-forwarded-block' 等。
  -- ★Gmail転送は From を書き換えるので、誤判定の追跡にこれが要る
  from_source  TEXT,
  subject      TEXT,
  -- 当たったルールの表示名。当たらなければ NULL
  rule_site    TEXT,
  -- 'delivered' | 'unmatched' | 'parse_failed' | 'push_failed'
  status       TEXT NOT NULL,
  detail       TEXT,
  received_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_email_events_status ON email_events (status);
CREATE INDEX IF NOT EXISTS idx_email_events_received ON email_events (received_at);
