/**
 * 承認カードの「往路」— GitHub Issue が cw:pending になったことを検知して、
 * 開発者本人のLINEに Flex Message（承認/却下ボタン付き）を push する。
 *
 * 復路（ボタンを押した後の postback）は chatwork-approval.ts が担当する。
 * 2026-08-17 時点で復路のみ実装されており、この往路が無いため
 * 「Issueを作ってもLINEに何も届かない」状態だった。本ファイルがその穴を埋める。
 *
 * 設計の正本: ai-shain.link/FABLE-DESIGN-chatwork-approval-gate.md §2, §3
 *
 * セキュリティ上重要:
 *   - この口は**公開エンドポイント**から呼ばれる。呼び出し元(routes/github-webhook.ts)で
 *     HMAC署名を必ず検証すること。本ファイルは署名検証を行わない。
 *   - 送信先は ALLOWED_LINE_USER_IDS（開発者本人）に固定する。
 *     Issue本文から宛先を読むような実装にしてはいけない（GitHub側を書き換えられると
 *     任意の相手に承認カードを送りつけられるため）。
 */

import { LineClient, type FlexContainer } from '@line-crm/line-sdk';
import { buildApprovalFlex, parseCardFromBody, CW_STATES } from './chatwork-approval.js';
import { getApprovalNotifyTargets } from './ai-shain-worker-task.js';

/** 承認カードIssueに付くラベル（このラベルが無いものは対象外） */
export const CW_APPROVAL_LABEL = 'cw-approval';

export interface GithubIssuePayload {
  action?: string;
  issue?: {
    number?: number;
    body?: string;
    state?: string;
    labels?: Array<{ name?: string }>;
  };
  label?: { name?: string };
}

export interface NotifyResult {
  notified: boolean;
  /** 送れなかった理由。運用時にログで追えるよう、必ず埋める。 */
  reason?: string;
  issueNumber?: number;
}

/**
 * webhook ペイロードが「承認カードが承認待ちになった」ものかを判定する。
 *
 * 通知するのは次を**すべて**満たすときだけ:
 *   - action が labeled（open だけでは通知しない。ラベルが付いて初めてカードになる）
 *   - cw-approval ラベルが付いている
 *   - cw:pending ラベルが付いている（approved/rejected/expired では通知しない）
 *   - Issue が open
 *
 * 迷ったら通知しない = fail-closed。通知漏れは再送口で拾えるが、
 * 誤通知（承認済みのカードが再び「承認して」と届く）は誤送信の誘因になる。
 */
export function shouldNotify(payload: GithubIssuePayload): boolean {
  if (payload.action !== 'labeled') return false;

  const issue = payload.issue;
  if (!issue || typeof issue.number !== 'number') return false;
  if (issue.state && issue.state !== 'open') return false;

  const labels = new Set(
    (issue.labels ?? [])
      .map((l) => l?.name)
      .filter((n): n is string => typeof n === 'string'),
  );

  if (!labels.has(CW_APPROVAL_LABEL)) return false;
  if (!labels.has(CW_STATES.PENDING)) return false;

  // 承認済み・却下済み・期限切れが同時に付いている異常な状態では通知しない。
  // 状態ラベルは常にちょうど1個であるべき（設計書 §3.3）。
  if (labels.has(CW_STATES.APPROVED)) return false;
  if (labels.has(CW_STATES.REJECTED)) return false;
  if (labels.has(CW_STATES.EXPIRED)) return false;

  return true;
}

/**
 * 承認カードのFlexを開発者本人のLINEへ push する。
 *
 * 失敗しても例外は投げない。GitHub の webhook は失敗すると再送されるが、
 * ここで500を返し続けると GitHub 側で webhook が無効化されるため、
 * 呼び出し元が200を返せるよう理由付きの結果を返す。
 */
export async function notifyApprovalCard(
  channelAccessToken: string | undefined,
  payload: GithubIssuePayload,
): Promise<NotifyResult> {
  if (!shouldNotify(payload)) {
    return { notified: false, reason: 'not-a-pending-approval-card' };
  }

  const issueNumber = payload.issue!.number!;

  if (!channelAccessToken) {
    return { notified: false, reason: 'line-token-not-configured', issueNumber };
  }

  const card = parseCardFromBody(payload.issue?.body ?? '');
  if (!card) {
    // カードJSONが読めないIssueに cw-approval が付いている＝人が手で付けたか壊れている。
    // 通知すると中身の無いカードが届くので送らない。
    return { notified: false, reason: 'card-json-not-found', issueNumber };
  }

  const targets = getApprovalNotifyTargets();
  if (targets.length === 0) {
    return { notified: false, reason: 'no-authorized-recipient', issueNumber };
  }

  // buildApprovalFlex は unknown を返す（Flexの構造をSDK型に依存させないため）。
  // 送信直前でSDKの型に寄せる。
  const flex = buildApprovalFlex(card, issueNumber) as FlexContainer;
  const roomName = String(
    (card as { target?: { roomName?: string } }).target?.roomName ?? '(宛先不明)',
  );
  const altText = `[承認待ち] ${roomName} への返信`;

  const client = new LineClient(channelAccessToken);

  // 本人のLINE User ID は複数アカウント分ある。どれか1つでも届けば成功とする
  // （片方のアカウントを友だち解除していても通知が消えないようにするため）。
  let delivered = 0;
  const failures: string[] = [];
  for (const to of targets) {
    try {
      await client.pushFlexMessage(to, altText, flex);
      delivered += 1;
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (delivered === 0) {
    return {
      notified: false,
      reason: `line-push-failed: ${failures.join('; ') || 'unknown'}`,
      issueNumber,
    };
  }

  return { notified: true, issueNumber };
}
