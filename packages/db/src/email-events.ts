/**
 * email_events テーブルのヘルパー。
 *
 * 受け取った通知メールの処理記録。stripe_events と同じ考え方で、
 * 外部ID（Message-ID）に UNIQUE を張り、処理の前に一度引いて重複を弾く。
 */
import { jstNow } from './utils.js';

export interface EmailEventRow {
  id: string;
  message_id: string;
  from_address: string | null;
  from_source: string | null;
  subject: string | null;
  rule_site: string | null;
  status: string;
  detail: string | null;
  received_at: string;
}

/** 同じメールを既に処理していないかを見る。あれば二度目は何もしない。 */
export async function getEmailEventByMessageId(
  db: D1Database,
  messageId: string,
): Promise<EmailEventRow | null> {
  return db
    .prepare(`SELECT * FROM email_events WHERE message_id = ?`)
    .bind(messageId)
    .first<EmailEventRow>();
}

export async function createEmailEvent(
  db: D1Database,
  input: {
    messageId: string;
    fromAddress?: string | null;
    fromSource?: string | null;
    subject?: string | null;
    ruleSite?: string | null;
    status: 'delivered' | 'unmatched' | 'parse_failed' | 'push_failed';
    detail?: string | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO email_events (id, message_id, from_address, from_source, subject, rule_site, status, detail, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (message_id) DO NOTHING`,
    )
    .bind(
      crypto.randomUUID(),
      input.messageId,
      input.fromAddress ?? null,
      input.fromSource ?? null,
      // ★件名は先頭200字まで。全文は保存しない
      input.subject ? input.subject.slice(0, 200) : null,
      input.ruleSite ?? null,
      input.status,
      input.detail ?? null,
      jstNow(),
    )
    .run();
}

/**
 * 同じ差出人・同じ件名で今日すでに通知したかを見る。
 * ★メルマガ1本で通知が溢れて本当の連絡が埋もれるのを防ぐため。
 */
export async function countTodayEvents(
  db: D1Database,
  fromAddress: string,
  subjectPrefix: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM email_events
        WHERE from_address = ? AND subject LIKE ? AND received_at >= ?`,
    )
    .bind(fromAddress, `${subjectPrefix}%`, `${jstNow().slice(0, 10)}T00:00:00.000`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
