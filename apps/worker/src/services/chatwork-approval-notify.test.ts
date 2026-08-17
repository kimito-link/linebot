import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  shouldNotify,
  notifyApprovalCard,
  CW_APPROVAL_LABEL,
  type GithubIssuePayload,
} from './chatwork-approval-notify';
import { CW_STATES } from './chatwork-approval';

/**
 * 承認カードの往路のテスト。
 *
 * ここが緩むと「承認済みのカードがもう一度『承認して』と届く」「中身の無いカードが届く」
 * といった、人に誤った承認をさせる状態が作れてしまう。
 * 正常系より **通知してはいけないものを確実に弾くか** を重点的に見る。
 */

const pushFlexMessage = vi.fn();

vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    pushFlexMessage = pushFlexMessage;
  },
}));

const TOKEN = 'dummy-channel-access-token';

function makeCardJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    kind: 'chatwork.message.send',
    target: { roomId: '444679566', roomName: 'AI社員デモ7' },
    draft: { text: 'お世話になっております。', sha256: 'dummy', revision: 1 },
    context: { triggerExcerpt: '見積もりの件いかがでしょうか' },
    approval: { nonce: 'f3a91b2c4d5e6f708192a3b4c5d6e7f8' },
    ...over,
  }, null, 2);
}

function makeBody(over?: Record<string, unknown>) {
  return ['## 承認待ちカード', '', '```json approval-card', makeCardJson(over), '```', ''].join('\n');
}

function makePayload(over: Partial<GithubIssuePayload> = {}): GithubIssuePayload {
  return {
    action: 'labeled',
    issue: {
      number: 123,
      state: 'open',
      body: makeBody(),
      labels: [{ name: CW_APPROVAL_LABEL }, { name: CW_STATES.PENDING }],
    },
    ...over,
  };
}

beforeEach(() => {
  pushFlexMessage.mockReset();
  pushFlexMessage.mockResolvedValue({});
});

describe('shouldNotify', () => {
  it('cw-approval + cw:pending の labeled は通知する', () => {
    expect(shouldNotify(makePayload())).toBe(true);
  });

  it('action が labeled 以外なら通知しない（opened だけでは送らない）', () => {
    expect(shouldNotify(makePayload({ action: 'opened' }))).toBe(false);
    expect(shouldNotify(makePayload({ action: 'edited' }))).toBe(false);
    expect(shouldNotify(makePayload({ action: 'closed' }))).toBe(false);
  });

  it('cw-approval ラベルが無ければ通知しない（別系統のIssueに反応しない）', () => {
    const p = makePayload();
    p.issue!.labels = [{ name: CW_STATES.PENDING }, { name: 'ai-shain-task' }];
    expect(shouldNotify(p)).toBe(false);
  });

  it('cw:pending が無ければ通知しない', () => {
    const p = makePayload();
    p.issue!.labels = [{ name: CW_APPROVAL_LABEL }];
    expect(shouldNotify(p)).toBe(false);
  });

  it('★承認済み・却下済み・期限切れが同居していたら通知しない', () => {
    for (const done of [CW_STATES.APPROVED, CW_STATES.REJECTED, CW_STATES.EXPIRED]) {
      const p = makePayload();
      p.issue!.labels = [
        { name: CW_APPROVAL_LABEL },
        { name: CW_STATES.PENDING },
        { name: done },
      ];
      expect(shouldNotify(p)).toBe(false);
    }
  });

  it('closed のIssueには通知しない', () => {
    const p = makePayload();
    p.issue!.state = 'closed';
    expect(shouldNotify(p)).toBe(false);
  });

  it('壊れたペイロード（issue無し・番号無し）で落ちない', () => {
    expect(shouldNotify({})).toBe(false);
    expect(shouldNotify({ action: 'labeled' })).toBe(false);
    expect(shouldNotify({ action: 'labeled', issue: {} })).toBe(false);
    expect(shouldNotify({ action: 'labeled', issue: { number: 1, labels: undefined } })).toBe(false);
  });
});

describe('notifyApprovalCard', () => {
  it('承認待ちカードを本人のLINEへ push する', async () => {
    const res = await notifyApprovalCard(TOKEN, makePayload());

    expect(res.notified).toBe(true);
    expect(res.issueNumber).toBe(123);
    expect(pushFlexMessage).toHaveBeenCalled();

    // altText に宛先が入っていること（通知欄で何の承認か分かる）
    const [, altText] = pushFlexMessage.mock.calls[0];
    expect(String(altText)).toContain('AI社員デモ7');
  });

  it('★送信先はペイロードではなく許可リストから取る', async () => {
    // Issue本文に別のLINE User IDを紛れ込ませても、そこへは送らない
    const p = makePayload();
    p.issue!.body = makeBody({ approval: { nonce: 'x', lineUserId: 'U-attacker' } });

    await notifyApprovalCard(TOKEN, p);

    const recipients = pushFlexMessage.mock.calls.map((call) => call[0]);
    expect(recipients.length).toBeGreaterThan(0);
    for (const to of recipients) {
      expect(to).not.toBe('U-attacker');
      expect(String(to)).toMatch(/^U[0-9a-f]{32}$/);
    }
  });

  it('カードJSONが読めないIssueには通知しない', async () => {
    const p = makePayload();
    p.issue!.body = '## 承認待ちカード\n\n(JSONが壊れている)';

    const res = await notifyApprovalCard(TOKEN, p);

    expect(res.notified).toBe(false);
    expect(res.reason).toBe('card-json-not-found');
    expect(pushFlexMessage).not.toHaveBeenCalled();
  });

  it('対象外のイベントでは何もしない', async () => {
    const res = await notifyApprovalCard(TOKEN, makePayload({ action: 'opened' }));

    expect(res.notified).toBe(false);
    expect(res.reason).toBe('not-a-pending-approval-card');
    expect(pushFlexMessage).not.toHaveBeenCalled();
  });

  it('LINEトークン未設定なら送らず理由を返す（例外を投げない）', async () => {
    const res = await notifyApprovalCard(undefined, makePayload());

    expect(res.notified).toBe(false);
    expect(res.reason).toBe('line-token-not-configured');
    expect(pushFlexMessage).not.toHaveBeenCalled();
  });

  it('push が全部失敗しても例外を投げず、理由を返す', async () => {
    pushFlexMessage.mockRejectedValue(new Error('LINE 429'));

    const res = await notifyApprovalCard(TOKEN, makePayload());

    expect(res.notified).toBe(false);
    expect(res.reason).toContain('line-push-failed');
  });

  it('片方の宛先が失敗しても、もう片方に届けば成功とする', async () => {
    pushFlexMessage
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValueOnce({});

    const res = await notifyApprovalCard(TOKEN, makePayload());

    expect(res.notified).toBe(true);
  });
});
