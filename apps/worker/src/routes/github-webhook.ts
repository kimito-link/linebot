/**
 * GitHub webhook レシーバー（承認カードの往路）。
 *
 * kimito-link/ai-shain-worker のIssueに cw:pending ラベルが付いたら、
 * 開発者本人のLINEへ承認カード(Flex)を push する。
 *
 * 設計の正本: ai-shain.link/FABLE-DESIGN-chatwork-approval-gate.md §1, §2
 *
 * ★Stripeレシーバー(routes/stripe.ts)と意図的に違う点:
 *   Stripeは「シークレット未設定なら署名検証をスキップ」する開発向けフォールバックを
 *   持つが、この口は**持たない**。理由は、この口が通ると開発者のスマホに
 *   「承認して送信」ボタン付きのカードが届くため。偽のカードを送り込めると、
 *   人が承認ボタンを押してしまう経路（＝誤送信）が外部から作れてしまう。
 *   シークレット未設定なら 503 で閉じる = fail-closed。
 */

import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  notifyApprovalCard,
  type GithubIssuePayload,
} from '../services/chatwork-approval-notify.js';

const githubWebhook = new Hono<Env>();

/**
 * GitHub の x-hub-signature-256 を検証する。
 *
 * タイミング安全な比較を行う。長さが違う時点で false を返すが、
 * 同じ長さなら全バイトを走査してから結果を返す（早期returnしない）。
 */
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  sigHeader: string,
): Promise<boolean> {
  if (!sigHeader.startsWith('sha256=')) return false;
  const provided = sigHeader.slice('sha256='.length);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  if (expected.length !== provided.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

githubWebhook.post('/api/integrations/github/webhook', async (c) => {
  const secret = (c.env as unknown as Record<string, string | undefined>)
    .GITHUB_WEBHOOK_SECRET;

  // fail-closed: シークレットが無いなら誰の署名も検証できない＝受け付けない。
  if (!secret) {
    console.error('GITHUB_WEBHOOK_SECRET not configured; refusing webhook');
    return c.json({ success: false, error: 'Webhook not configured' }, 503);
  }

  const sigHeader = c.req.header('x-hub-signature-256') ?? '';
  const rawBody = await c.req.text();

  const valid = await verifyGithubSignature(secret, rawBody, sigHeader);
  if (!valid) {
    return c.json({ success: false, error: 'Signature verification failed' }, 401);
  }

  // ここから先は署名済み＝GitHubからの本物のイベント。
  const event = c.req.header('x-github-event') ?? '';
  if (event === 'ping') {
    return c.json({ success: true, data: { message: 'pong' } });
  }
  if (event !== 'issues') {
    // 他のイベントは購読していないが、届いても200で受け流す
    // （4xxを返し続けると GitHub 側で webhook が無効化されるため）。
    return c.json({ success: true, data: { message: 'ignored', event } });
  }

  let payload: GithubIssuePayload;
  try {
    payload = JSON.parse(rawBody) as GithubIssuePayload;
  } catch {
    return c.json({ success: false, error: 'Invalid JSON' }, 400);
  }

  try {
    const result = await notifyApprovalCard(c.env.LINE_CHANNEL_ACCESS_TOKEN, payload);
    if (!result.notified && result.reason && result.reason !== 'not-a-pending-approval-card') {
      // 通知すべきだったのに送れなかったケースは運用で追えるようにする。
      console.error('approval card notify skipped:', result.reason, result.issueNumber);
    }
    return c.json({ success: true, data: result });
  } catch (err) {
    console.error('POST /api/integrations/github/webhook error:', err);
    // 200を返す: GitHub側の再送で直る類の失敗ではないため
    // （再送してもLINE側が落ちていれば同じ結果になる）。
    return c.json({ success: true, data: { notified: false, reason: 'internal-error' } });
  }
});

export { githubWebhook };
