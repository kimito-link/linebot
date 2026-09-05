import { describe, it, expect } from 'vitest';
import {
  matches,
  findRule,
  normalizeSubject,
  stripForwardPrefix,
  validateRules,
  type ForwardRule,
} from './email-forward-rules.js';
import { resolveOriginalFrom, extractFromForwardedBlock } from './email-original-from.js';

/** xlsx から実際に抽出された形（import-forward-rules.mjs の出力と同じ構造）。 */
const rule = (site: string, from: string, parts: string[], scope = '件名'): ForwardRule => ({
  site, from, subject: '', group: '', scope,
  match: { from, subjectContainsAll: parts },
});

const RULES: ForwardRule[] = [
  rule('ランサーズ/コメント届', 'noreply@lancers.co.jp', ['[ランサーズ]', 'さんから', 'のコメントが届いています']),
  rule('ランサーズ/コメントした', 'noreply@lancers.co.jp', ['[ランサーズ]', 'さんが', 'にコメントしました']),
  rule('ランサーズ/振込', 'noreply@lancers.co.jp', ['[ランサーズ] 振込報酬額確定のお知らせ'], '全文'),
  rule('ココナラ/メッセージ', 'no-reply@mail.coconala.com', ['[ココナラ]', 'さんからメッセージが届いています']),
  rule('ココナラ/承諾', 'no-reply@mail.coconala.com', ['[ココナラ]【承諾】が選択されました']),
  // ランサーズ・ココナラ以外も同じ仕組みで動くことの固定
  rule('BASE/購入', 'no-reply@thebase.in', ['【BASE】', 'が購入されました'], '全文'),
  rule('Stripe/入金', 'notifications@stripe.com', ['You received a payment of']),
];

describe('normalizeSubject', () => {
  it('全角空白・連続空白・大文字小文字をならす', () => {
    expect(normalizeSubject('  A　B   C ')).toBe('a b c');
  });
  it('NFKCで全角英数を半角にする', () => {
    expect(normalizeSubject('ＢＡＳＥ')).toBe('base');
  });
});

describe('stripForwardPrefix', () => {
  it('Fwd: と 転送: を落とす', () => {
    expect(stripForwardPrefix('Fwd: [ランサーズ] お知らせ')).toBe('[ランサーズ] お知らせ');
    expect(stripForwardPrefix('転送: 件名')).toBe('件名');
  });
  it('入れ子の Fwd: も落とす', () => {
    expect(stripForwardPrefix('Fwd: Fw: 件名')).toBe('件名');
  });
  it('接頭辞が無ければそのまま', () => {
    expect(stripForwardPrefix('[ココナラ] 通知')).toBe('[ココナラ] 通知');
  });
});

describe('matches / findRule — 実際に届く件名で当たること', () => {
  const cases: [string, string, string][] = [
    ['noreply@lancers.co.jp', '[ランサーズ] 山田太郎 さんから LP制作 のコメントが届いています', 'ランサーズ/コメント届'],
    ['noreply@lancers.co.jp', '[ランサーズ] 山田太郎 さんが LP制作 にコメントしました', 'ランサーズ/コメントした'],
    ['noreply@lancers.co.jp', '[ランサーズ] 振込報酬額確定のお知らせ', 'ランサーズ/振込'],
    ['no-reply@mail.coconala.com', '[ココナラ] 佐藤花子さんからメッセージが届いています', 'ココナラ/メッセージ'],
    ['no-reply@mail.coconala.com', '[ココナラ]【承諾】が選択されました（トークルームNo:12345678）', 'ココナラ/承諾'],
    ['no-reply@thebase.in', '【BASE】ハンドメイドピアス が購入されました', 'BASE/購入'],
    ['notifications@stripe.com', 'You received a payment of ¥12,000', 'Stripe/入金'],
  ];
  for (const [from, subject, want] of cases) {
    it(`${want}`, () => {
      const hit = RULES.filter((r) => matches(r, from, subject));
      expect(hit).toHaveLength(1);
      expect(hit[0].site).toBe(want);
    });
  }

  it('★似ている2つを取り違えない（さんから…届いています / さんが…しました）', () => {
    const a = findRule(RULES, 'noreply@lancers.co.jp', '[ランサーズ] A さんから B のコメントが届いています');
    const b = findRule(RULES, 'noreply@lancers.co.jp', '[ランサーズ] A さんが B にコメントしました');
    expect(a?.site).toBe('ランサーズ/コメント届');
    expect(b?.site).toBe('ランサーズ/コメントした');
  });

  it('★送信元が違えば当たらない（件名が同じでも）', () => {
    expect(findRule(RULES, 'noreply@stores.jp', '【BASE】ピアス が購入されました')).toBeNull();
  });

  it('未登録の通知は null（＝捨てずに未登録として通知する合図）', () => {
    expect(findRule(RULES, 'info@unknown.example', 'なにかのお知らせ')).toBeNull();
  });

  it('Fwd: が付いていても当たる（部分一致ANDなので）', () => {
    const hit = findRule(RULES, 'noreply@lancers.co.jp', 'Fwd: [ランサーズ] 振込報酬額確定のお知らせ');
    expect(hit?.site).toBe('ランサーズ/振込');
  });
});

describe('validateRules', () => {
  it('正しいものは通す', () => {
    const r = validateRules({ rules: [RULES[0]] });
    expect(r.ok).toBe(true);
  });
  it('配列でなければ弾く', () => {
    expect(validateRules({ nope: 1 }).ok).toBe(false);
  });
  it('match.from が無ければ弾く', () => {
    const r = validateRules({ rules: [{ match: { subjectContainsAll: ['a'] } }] });
    expect(r.ok).toBe(false);
  });
  it('subjectContainsAll が空なら弾く（全メールに当たってしまうため）', () => {
    const r = validateRules({ rules: [{ match: { from: 'a@b.c', subjectContainsAll: [] } }] });
    expect(r.ok).toBe(false);
  });
  it('★APIトークンらしき32桁hexが混ざっていたら弾く', () => {
    const r = validateRules({
      rules: [{ site: '5707aa2e4c510dfa6230b52a759ecde0', match: { from: 'a@b.c', subjectContainsAll: ['x'] } }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('APIトークン');
  });
});

describe('resolveOriginalFrom — ★Gmail転送で From が書き換わる問題', () => {
  it('直送はヘッダのFromを使う', () => {
    const r = resolveOriginalFrom({ from: 'noreply@lancers.co.jp' });
    expect(r).toEqual({ address: 'noreply@lancers.co.jp', source: 'header-from' });
  });

  it('★転送されるとヘッダのFromは転送者になる。本文から元差出人を復元する', () => {
    const body = [
      '---------- Forwarded message ---------',
      'From: ランサーズ <noreply@lancers.co.jp>',
      'Date: 2026年9月5日',
      '',
      '本文',
    ].join('\n');
    const r = resolveOriginalFrom({ from: 'me@gmail.com', text: body });
    expect(r.address).toBe('noreply@lancers.co.jp');
    expect(r.source).toBe('body-forwarded-block');
  });

  it('日本語Gmailの転送ブロックも読める', () => {
    const body = '---------- 転送されたメッセージ ----------\n差出人: ココナラ <no-reply@mail.coconala.com>\n';
    expect(resolveOriginalFrom({ from: 'me@gmail.com', text: body }).address)
      .toBe('no-reply@mail.coconala.com');
  });

  it('転送ヘッダがあれば最優先', () => {
    const r = resolveOriginalFrom({
      from: 'me@gmail.com',
      headers: { 'x-forwarded-for': 'noreply@lancers.co.jp' },
    });
    expect(r.source).toBe('x-forwarded-for');
  });

  it('Reply-To が From と違えば採用する', () => {
    const r = resolveOriginalFrom({ from: 'bounce@sendgrid.net', replyTo: 'noreply@lancers.co.jp' });
    expect(r).toEqual({ address: 'noreply@lancers.co.jp', source: 'reply-to' });
  });

  it('★転送ブロックが無ければ本文中のアドレスを拾わない（誤検出を避ける）', () => {
    const r = resolveOriginalFrom({ from: 'me@gmail.com', text: 'お問い合わせは support@example.com まで' });
    expect(r.address).toBe('me@gmail.com');
    expect(r.source).toBe('header-from');
  });

  it('何も無くても落ちない', () => {
    expect(resolveOriginalFrom({}).address).toBe('');
  });
});

describe('extractFromForwardedBlock', () => {
  it('ブロックから遠い位置のアドレスは拾わない', () => {
    const body = '---------- Forwarded message ---------\nFrom: a@b.com\n' + 'x'.repeat(2000) + '\nFrom: far@away.com';
    expect(extractFromForwardedBlock(body)).toBe('a@b.com');
  });
  it('ブロックが無ければ null', () => {
    expect(extractFromForwardedBlock('ふつうの本文 a@b.com')).toBeNull();
  });
});
