import { describe, it, expect, vi, beforeEach } from 'vitest';

/** 送ったLINEメッセージを覚えておく（宛先の検証に使う）。 */
const sent: { to: string; text: string }[] = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    async pushTextMessage(to: string, text: string) { sent.push({ to, text }); }
  },
}));

/** 通知先の固定リスト。★本文から宛先を読んでいないことを確かめるために使う。 */
const ALLOWED = ['Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'];
vi.mock('./ai-shain-worker-task.js', () => ({
  getApprovalNotifyTargets: () => ALLOWED,
}));

const RULES = [
  { site: 'ランサーズ', from: 'noreply@lancers.co.jp', subject: '', group: '', scope: '件名',
    match: { from: 'noreply@lancers.co.jp', subjectContainsAll: ['[ランサーズ]', 'のコメントが届いています'] } },
  { site: 'ランサーズ/振込', from: 'noreply@lancers.co.jp', subject: '', group: '', scope: '全文',
    match: { from: 'noreply@lancers.co.jp', subjectContainsAll: ['振込報酬額確定'] } },
];

let rows: Record<string, unknown>[] = [];
let todayCount = 0;
vi.mock('@line-crm/db', () => ({
  getEmailEventByMessageId: async (_db: unknown, id: string) =>
    rows.find((r) => r.message_id === id) ?? null,
  createEmailEvent: async (_db: unknown, input: Record<string, unknown>) => {
    rows.push({ ...input, message_id: input.messageId });
  },
  countTodayEvents: async () => todayCount,
  getAccountSetting: async () => JSON.stringify({ version: 1, rules: RULES }),
  setAccountSetting: async () => {},
  jstNow: () => '2026-09-05T12:00:00.000',
}));

import { handleIncomingEmail } from './email-forward.js';

const db = {
  prepare: () => ({ bind: () => ({ first: async () => ({ id: 'acc-1' }) }), first: async () => ({ id: 'acc-1' }) }),
} as unknown as D1Database;

const env = { DB: db, LINE_CHANNEL_ACCESS_TOKEN: 'token' };

/** 最小のRFC822メールを組み立てる。 */
function eml(o: { from: string; subject: string; messageId?: string; body?: string; replyTo?: string }): string {
  // ★ヘッダと本文は空行1つで区切る。ここを filter(Boolean) で潰すと
  //   本文ごと消えて「本文が載らない」と誤検知する（実際に踏んだ）。
  const headers = [
    `From: ${o.from}`,
    `To: notify@example.com`,
    `Subject: ${o.subject}`,
    `Message-ID: ${o.messageId ?? '<test@example.com>'}`,
    ...(o.replyTo ? [`Reply-To: ${o.replyTo}`] : []),
    'Content-Type: text/plain; charset=utf-8',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${o.body ?? '本文です'}`;
}

beforeEach(() => { sent.length = 0; rows = []; todayCount = 0; });

describe('handleIncomingEmail', () => {
  it('ルールに当たると、その名前でLINEへ届く', async () => {
    const r = await handleIncomingEmail(env, {
      envelopeFrom: 'noreply@lancers.co.jp',
      raw: eml({ from: 'noreply@lancers.co.jp', subject: '[ランサーズ] 山田 さんから A のコメントが届いています' }),
    });
    expect(r.status).toBe('delivered');
    expect(r.ruleSite).toBe('ランサーズ');
    expect(sent).toHaveLength(ALLOWED.length);
    expect(sent[0].text).toContain('【ランサーズ】');
  });

  it('scope=件名 のときは本文を載せない', async () => {
    await handleIncomingEmail(env, {
      envelopeFrom: 'noreply@lancers.co.jp',
      raw: eml({
        from: 'noreply@lancers.co.jp',
        subject: '[ランサーズ] 山田 さんから A のコメントが届いています',
        body: 'これは秘密の本文',
      }),
    });
    expect(sent[0].text).not.toContain('これは秘密の本文');
  });

  it('scope=全文 のときは本文も載せる', async () => {
    await handleIncomingEmail(env, {
      envelopeFrom: 'noreply@lancers.co.jp',
      raw: eml({ from: 'noreply@lancers.co.jp', subject: '振込報酬額確定のお知らせ', body: '金額は1000円です' }),
    });
    expect(sent[0].text).toContain('金額は1000円です');
  });

  it('★ルールに当たらなくても捨てない。未登録として通知する', async () => {
    const r = await handleIncomingEmail(env, {
      envelopeFrom: 'info@unknown.example',
      raw: eml({ from: 'info@unknown.example', subject: '知らないお知らせ' }),
    });
    expect(r.status).toBe('unmatched');
    expect(sent[0].text).toContain('未登録の通知メール');
    // 本文は出さない
    expect(sent[0].text).not.toContain('本文です');
  });

  it('同じメールを二度処理しない', async () => {
    const raw = eml({ from: 'noreply@lancers.co.jp', subject: '[ランサーズ] A さんから B のコメントが届いています' });
    await handleIncomingEmail(env, { envelopeFrom: 'noreply@lancers.co.jp', raw });
    const second = await handleIncomingEmail(env, { envelopeFrom: 'noreply@lancers.co.jp', raw });
    expect(second.status).toBe('duplicate');
    expect(sent).toHaveLength(ALLOWED.length); // 増えていない
  });

  it('未登録の通知は同じ件名なら1日1回まで（メルマガ対策）', async () => {
    todayCount = 1;
    const r = await handleIncomingEmail(env, {
      envelopeFrom: 'news@spam.example',
      raw: eml({ from: 'news@spam.example', subject: '毎日のお知らせ' }),
    });
    expect(r.status).toBe('suppressed');
    expect(sent).toHaveLength(0);
  });

  it('★Gmail転送で From が書き換わっていても、本文から復元して当たる', async () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: ランサーズ <noreply@lancers.co.jp>',
      '',
      '本文',
    ].join('\n');
    const r = await handleIncomingEmail(env, {
      envelopeFrom: 'me@gmail.com',
      raw: eml({
        from: 'me@gmail.com',
        subject: 'Fwd: [ランサーズ] 山田 さんから A のコメントが届いています',
        body,
      }),
    });
    expect(r.status).toBe('delivered');
    expect(r.ruleSite).toBe('ランサーズ');
    // ★推定で決めたことを隠さない
    expect(sent[0].text).toContain('差出人は本文から推定');
  });

  // ═══ セキュリティ ═══
  it('★本文にLINE User IDを仕込まれても、そこへは送らない', async () => {
    const evil = 'Uffffffffffffffffffffffffffffffff';
    await handleIncomingEmail(env, {
      envelopeFrom: 'noreply@lancers.co.jp',
      raw: eml({
        from: 'noreply@lancers.co.jp',
        subject: '振込報酬額確定のお知らせ',
        body: `送信先: ${evil}\nto=${evil}`,
      }),
    });
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(ALLOWED).toContain(s.to);
    expect(sent.map((s) => s.to)).not.toContain(evil);
  });

  it('★To ヘッダを書き換えられても、そこへは送らない', async () => {
    const raw = [
      'From: noreply@lancers.co.jp',
      'To: Uffffffffffffffffffffffffffffffff@evil.example',
      'Subject: 振込報酬額確定のお知らせ',
      'Message-ID: <x@y>',
      '',
      '本文',
    ].join('\r\n');
    await handleIncomingEmail(env, { envelopeFrom: 'noreply@lancers.co.jp', raw });
    for (const s of sent) expect(ALLOWED).toContain(s.to);
  });

  it('解析できないメールでも例外を投げない', async () => {
    const r = await handleIncomingEmail(env, { envelopeFrom: 'x@y.z', raw: '' as unknown as string });
    expect(['parse_failed', 'unmatched', 'push_failed']).toContain(r.status);
  });

  it('LINEが未設定でも例外を投げず push_failed を返す', async () => {
    const r = await handleIncomingEmail(
      { DB: db },
      { envelopeFrom: 'noreply@lancers.co.jp', raw: eml({ from: 'noreply@lancers.co.jp', subject: '振込報酬額確定のお知らせ' }) },
    );
    expect(r.status).toBe('push_failed');
  });
});
