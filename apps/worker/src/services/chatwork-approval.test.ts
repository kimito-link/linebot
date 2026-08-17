import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isApprovalPostback,
  buildPostbackData,
  parsePostbackData,
  parseCardFromBody,
  replaceCardInBody,
  buildApprovalFlex,
  handleApprovalPostback,
  CW_STATES,
} from './chatwork-approval';

/**
 * 承認ゲートのテスト。
 *
 * ここが緩むと「他人が承認ボタンを押せる」「修正後の本文を旧承認で送れる」に直結するので、
 * 正常系よりも**拒否されるべきものが確実に拒否されるか**を重点的に見る。
 */

const NOW = Date.parse('2026-08-17T10:00:00+09:00');
const NONCE = 'f3a91b2c4d5e6f708192a3b4c5d6e7f8';

function makeCard(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'chatwork.message.send',
    createdAt: '2026-08-17T10:00:00+09:00',
    expiresAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
    target: { roomId: '12345678', roomName: '○○様プロジェクト', roomUrl: 'https://www.chatwork.com/#!rid12345678' },
    draft: { text: 'お世話になっております。', sha256: 'dummy', replyToMid: null, revision: 1 },
    context: { triggerExcerpt: '見積もりの件', taskIssue: 118 },
    approval: { nonce: NONCE, approvedAt: null, approvedBy: null },
    execution: { attempts: 0, executedAt: null, verified: null, verifiedMid: null, failReason: null },
    ...over,
  };
}

function makeBody(card: unknown) {
  return ['## 承認待ちカード', '', '```json approval-card', JSON.stringify(card, null, 2), '```'].join('\n');
}

describe('postback dataの解釈', () => {
  it('自分のpostbackだけを拾う', () => {
    expect(isApprovalPostback(buildPostbackData('approve', 118, NONCE))).toBe(true);
    expect(isApprovalPostback('menu:top')).toBe(false);
    expect(isApprovalPostback('')).toBe(false);
  });

  it('往復できる', () => {
    const parsed = parsePostbackData(buildPostbackData('approve', 118, NONCE));
    expect(parsed).toEqual({ action: 'approve', issueNumber: 118, nonce: NONCE });
  });

  it('壊れた入力では例外を投げずnullを返す（webhook全体を落とさない）', () => {
    expect(parsePostbackData('cwapp:approve')).toBeNull();
    expect(parsePostbackData('cwapp:delete:118:' + NONCE)).toBeNull();
    expect(parsePostbackData('cwapp:approve:abc:' + NONCE)).toBeNull();
    expect(parsePostbackData('cwapp:approve:118:not-hex!!')).toBeNull();
    expect(parsePostbackData('cwapp:approve:-1:' + NONCE)).toBeNull();
  });
});

describe('カードの読み書き', () => {
  it('本文からJSONを取り出せる', () => {
    const card = makeCard();
    expect(parseCardFromBody(makeBody(card))).toMatchObject({ kind: 'chatwork.message.send' });
  });

  it('カードが無い本文はnull', () => {
    expect(parseCardFromBody('ただのコメント')).toBeNull();
  });

  it('壊れたJSONでも例外を投げない', () => {
    expect(parseCardFromBody('```json approval-card\n{壊れて\n```')).toBeNull();
  });

  it('本文中のカードだけを差し替えられる', () => {
    const body = makeBody(makeCard());
    const next = replaceCardInBody(body, makeCard({ version: 2 }));
    expect(next).toContain('## 承認待ちカード');
    expect(parseCardFromBody(next)).toMatchObject({ version: 2 });
  });
});

describe('Flexカード', () => {
  it('宛先と本文が読め、両ボタンに同じnonceが載る', () => {
    const flex = buildApprovalFlex(makeCard(), 118) as any;
    const json = JSON.stringify(flex);
    expect(json).toContain('○○様プロジェクト');
    expect(json).toContain('お世話になっております。');
    const buttons = flex.footer.contents;
    expect(buttons[0].action.data).toBe(buildPostbackData('reject', 118, NONCE));
    expect(buttons[1].action.data).toBe(buildPostbackData('approve', 118, NONCE));
  });

  it('長い本文は切り詰める（Flexの制限に引っかからないように）', () => {
    const flex = buildApprovalFlex(makeCard({ draft: { text: 'あ'.repeat(1000) } }), 118) as any;
    const preview = flex.body.contents.find((c: any) => typeof c.text === 'string' && c.text.includes('あ'));
    expect(preview.text.length).toBeLessThanOrEqual(301);
  });
});

describe('承認の処理', () => {
  const TOKEN = 'ghp_dummy';
  let calls: Array<{ url: string; method: string; body?: any }>;

  beforeEach(() => {
    calls = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** GitHub APIのモック。issue取得→PATCH→ラベル操作を順に返す */
  function stubGithub(issue: unknown, opts: { patchOk?: boolean; labelOk?: boolean } = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
      const method = init.method || 'GET';
      calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
      if (method === 'GET') {
        return new Response(JSON.stringify(issue), { status: 200 });
      }
      if (method === 'PATCH') {
        return new Response('{}', { status: opts.patchOk === false ? 500 : 200 });
      }
      if (method === 'POST') {
        return new Response('[]', { status: opts.labelOk === false ? 500 : 200 });
      }
      return new Response('{}', { status: 200 });
    }));
  }

  it('正常に承認できる', async () => {
    stubGithub({
      body: makeBody(makeCard()),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.PENDING }],
      html_url: 'https://github.com/x/y/issues/118',
    });
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U123456789abc', NOW);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('承認しました');

    // 承認情報が書き戻されている
    const patch = calls.find((c) => c.method === 'PATCH');
    const saved = parseCardFromBody(patch!.body.body) as any;
    expect(saved.approval.approvedAt).toBeTruthy();
    // LINE User ID は生で残さない
    expect(patch!.body.body).not.toContain('U123456789abc');
    expect(saved.approval.approvedBy).toContain('***');

    // approved ラベルが付く
    const post = calls.find((c) => c.method === 'POST');
    expect(post!.body.labels).toEqual([CW_STATES.APPROVED]);
  });

  it('却下できる（カード書き戻しはしない）', async () => {
    stubGithub({
      body: makeBody(makeCard()),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.PENDING }],
    });
    const r = await handleApprovalPostback(TOKEN, { action: 'reject', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('却下');
    expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
    expect(calls.find((c) => c.method === 'POST')!.body.labels).toEqual([CW_STATES.REJECTED]);
  });

  it('★古いnonce（修正前のカード）は拒否する', async () => {
    stubGithub({
      body: makeBody(makeCard({ approval: { nonce: 'aaaaaaaabbbbbbbbccccccccdddddddd', approvedAt: null } })),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.PENDING }],
    });
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('古い');
    // ラベルを一切触っていない
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('★二重承認を拒否する（すでにapproved）', async () => {
    stubGithub({
      body: makeBody(makeCard()),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.APPROVED }],
    });
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('すでに処理済み');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('★期限切れは承認させず expired にする', async () => {
    stubGithub({
      body: makeBody(makeCard()),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.PENDING }],
    });
    const later = NOW + 25 * 60 * 60 * 1000;
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', later);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('期限切れ');
    expect(calls.find((c) => c.method === 'POST')!.body.labels).toEqual([CW_STATES.EXPIRED]);
  });

  it('★期限が壊れているカードも承認させない（fail-closed）', async () => {
    stubGithub({
      body: makeBody(makeCard({ expiresAt: 'こわれた日付' })),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.PENDING }],
    });
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('期限切れ');
  });

  it('★承認カード以外のIssueは操作しない', async () => {
    stubGithub({
      body: makeBody(makeCard()),
      labels: [{ name: 'ai-shain-task' }], // cw-approval が無い
    });
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('承認カードではありません');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });

  it('GITHUB_TOKEN未設定なら何もしない', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const r = await handleApprovalPostback(undefined, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('Issue取得に失敗しても例外を投げない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 999, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('取得できません');
  });

  it('ラベル更新に失敗したら成功扱いにしない', async () => {
    stubGithub({
      body: makeBody(makeCard()),
      labels: [{ name: 'cw-approval' }, { name: CW_STATES.PENDING }],
    }, { labelOk: false });
    const r = await handleApprovalPostback(TOKEN, { action: 'approve', issueNumber: 118, nonce: NONCE }, 'U1', NOW);
    expect(r.ok).toBe(false);
  });
});
