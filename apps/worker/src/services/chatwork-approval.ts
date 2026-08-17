/**
 * Chatwork送信の「承認ゲート」。AI社員が作った下書きを、**人がスマホで承認するまで送らせない**。
 *
 * 設計の正本: ai-shain.link/FABLE-DESIGN-chatwork-approval-gate.md
 *
 * 【この段階でやること／やらないこと】
 * ここは承認の**往復だけ**を担う。実際のChatwork送信はPC側ワーカーの仕事で、
 * このWorkerは送信コードを一切持たない。持たないことが安全装置になっている。
 *
 * 【セキュリティ上重要】
 * ai-shain-worker-task.ts と同じく、これは開発者本人のPCを動かす経路につながる。
 * 「ゆっくりサポートAI社員りんく」は不特定多数の顧客が友だち追加している共有アカウントなので、
 * **postbackの送信者チェックを外すと、他人が承認ボタンを押せてしまう**（＝勝手に送信させられる）。
 * 呼び出し元は必ず isAuthorizedTaskSender() を先に通すこと。
 *
 * 【nonceで古いカードを弾く】
 * 下書きを修正すると nonce が再発行される。古いFlexカードのボタンには古い nonce が
 * 埋まっているので、修正後にそれを押しても通らない。
 * これにより「修正後の本文を、修正前の承認で送る」ことが構造的に起きない。
 */

const TASK_REPO = 'kimito-link/ai-shain-worker';
const APPROVAL_LABEL = 'cw-approval';

/** 状態ラベル。常にちょうど1個だけ付く。 */
export const CW_STATES = {
  PENDING: 'cw:pending',
  APPROVED: 'cw:approved',
  REJECTED: 'cw:rejected',
  EXPIRED: 'cw:expired',
} as const;

/** postback data の接頭辞。既存の auto_replies マッチと衝突しないようにする。 */
const POSTBACK_PREFIX = 'cwapp:';

/**
 * すでに処理済みのカードを押したときに人へ返す文言。
 * ラベル名（cw:approved 等）をそのまま見せない。
 */
const STATE_MESSAGES: Record<string, string> = {
  'cw:approved': 'この返信はすでに承認済みです',
  'cw:rejected': 'この返信はすでに却下しています',
  'cw:expired': 'この承認は期限切れです。もう一度AIに下書きを作らせてください',
  'cw:executing': '送信の処理中です。そのままお待ちください',
  'cw:sent': 'この返信はすでに送信済みです',
  'cw:failed': 'この返信は送信できませんでした。Chatworkを開いて確認してください',
  'cw:unverified': '送信できたか確認できていません。Chatworkを開いて確認してください',
};

export interface ApprovalPostback {
  action: 'approve' | 'reject';
  issueNumber: number;
  nonce: string;
}

export interface ApprovalResult {
  ok: boolean;
  message: string;
  issueUrl?: string;
}

/** postback data かどうか（安いチェックを先に置く） */
export function isApprovalPostback(data: string): boolean {
  return typeof data === 'string' && data.startsWith(POSTBACK_PREFIX);
}

/**
 * postback data を組み立てる。Flexボタンに埋め込む文字列。
 * 例: cwapp:approve:118:f3a9...
 */
export function buildPostbackData(action: 'approve' | 'reject', issueNumber: number, nonce: string): string {
  return `${POSTBACK_PREFIX}${action}:${issueNumber}:${nonce}`;
}

/**
 * postback data を解釈する。壊れていたら null（例外を投げない）。
 * 想定外の入力で webhook 全体を落とさないため。
 */
export function parsePostbackData(data: string): ApprovalPostback | null {
  if (!isApprovalPostback(data)) return null;
  const rest = data.slice(POSTBACK_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) return null;
  const [action, issueStr, nonce] = parts;
  if (action !== 'approve' && action !== 'reject') return null;
  const issueNumber = Number.parseInt(issueStr, 10);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return null;
  if (!/^[0-9a-f]{8,64}$/i.test(nonce)) return null;
  return { action, issueNumber, nonce };
}

/** Issue本文から承認カードのJSONを取り出す */
export function parseCardFromBody(body: string): Record<string, unknown> | null {
  const m = String(body || '').match(/```json approval-card\s*([\s\S]*?)```/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isExpired(card: Record<string, unknown>, now: number): boolean {
  const expiresAt = (card as { expiresAt?: string }).expiresAt;
  const t = Date.parse(expiresAt || '');
  // 読めない期限は「期限切れ」に倒す（fail-closed）。
  // 壊れたデータを「まだ有効」と解釈すると送信side に倒れるため。
  return Number.isFinite(t) ? now > t : true;
}

async function githubFetch(
  githubToken: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(`https://api.github.com/repos/${TASK_REPO}${path}`, {
    method: init?.method || 'GET',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'chatwork-approval-gate',
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* テキストのまま扱う */ }
  return { ok: res.ok, status: res.status, json, text };
}

/** 現在の状態ラベルを取り出す（cw:* のうち1個） */
function currentState(labels: Array<{ name?: string }> | undefined): string | null {
  const names = (labels || []).map((l) => l?.name).filter(Boolean) as string[];
  return names.find((n) => n.startsWith('cw:')) || null;
}

/**
 * 承認/却下を処理する。
 *
 * **この関数は送信しない**。GitHub Issue のラベルを付け替えるだけ。
 * 実際の送信はPC側ワーカーが `cw:approved` を見つけて行う。
 */
export async function handleApprovalPostback(
  githubToken: string | undefined,
  pb: ApprovalPostback,
  approvedBy: string,
  now: number = Date.now(),
): Promise<ApprovalResult> {
  if (!githubToken) {
    return { ok: false, message: '設定が未完了です（GITHUB_TOKEN 未設定）' };
  }

  // 1) カードを取ってくる
  const got = await githubFetch(githubToken, `/issues/${pb.issueNumber}`);
  if (!got.ok) {
    return { ok: false, message: `承認カードを取得できませんでした（${got.status}）` };
  }
  const issue = got.json as { body?: string; labels?: Array<{ name?: string }>; html_url?: string };
  const issueUrl = issue.html_url;

  // 2) 承認カード以外のIssueを操作しない（誤爆防止）
  const labelNames = (issue.labels || []).map((l) => l?.name).filter(Boolean) as string[];
  if (!labelNames.includes(APPROVAL_LABEL)) {
    return { ok: false, message: 'これは承認カードではありません', issueUrl };
  }

  const card = parseCardFromBody(issue.body || '');
  if (!card) {
    return { ok: false, message: '承認カードの中身を読み取れませんでした', issueUrl };
  }

  // 3) nonce 照合。修正後に古いカードを押しても通さない
  const cardNonce = (card as { approval?: { nonce?: string } }).approval?.nonce;
  if (!cardNonce || cardNonce !== pb.nonce) {
    return { ok: false, message: 'このカードは古いか、すでに処理済みです', issueUrl };
  }

  // 4) pending 以外は処理しない（二重承認・承認後の却下を防ぐ）
  //
  // ボタンを連打すると2回目以降がここに来る（2026-08-17 実機で発生）。
  // 状態ラベルの付け替え中に入ると state が null になるため、
  // 「状態不明」のような内部用語を人に見せず、何が起きたかを説明する。
  const state = currentState(issue.labels);
  if (state !== CW_STATES.PENDING) {
    return { ok: false, message: STATE_MESSAGES[state ?? ''] ?? 'この承認はすでに処理済みです', issueUrl };
  }

  // 5) 期限切れは承認させない
  if (isExpired(card, now)) {
    await setState(githubToken, pb.issueNumber, CW_STATES.PENDING, CW_STATES.EXPIRED);
    return { ok: false, message: '期限切れです。もう一度AIに下書きを作らせてください', issueUrl };
  }

  const nextState = pb.action === 'approve' ? CW_STATES.APPROVED : CW_STATES.REJECTED;

  // 6) 承認情報をカードに書き戻す（監査のため誰がいつ承認したかを残す）
  if (pb.action === 'approve') {
    const updated = {
      ...card,
      approval: {
        ...(card as { approval?: Record<string, unknown> }).approval,
        approvedAt: new Date(now).toISOString(),
        approvedBy: maskUserId(approvedBy),
      },
    };
    const newBody = replaceCardInBody(issue.body || '', updated);
    const patched = await githubFetch(githubToken, `/issues/${pb.issueNumber}`, {
      method: 'PATCH',
      body: { body: newBody },
    });
    if (!patched.ok) {
      return { ok: false, message: `承認の記録に失敗しました（${patched.status}）`, issueUrl };
    }
  }

  // 7) 最後にラベルを付け替える。**ここを通って初めてPC側が実行できるようになる**
  const moved = await setState(githubToken, pb.issueNumber, CW_STATES.PENDING, nextState);
  if (!moved) {
    return { ok: false, message: '状態の更新に失敗しました', issueUrl };
  }

  const roomName = (card as { target?: { roomName?: string } }).target?.roomName || '';
  return {
    ok: true,
    issueUrl,
    message: pb.action === 'approve'
      ? `承認しました。${roomName ? `「${roomName}」へ` : ''}まもなく送信します`
      : '却下しました。送信はしません',
  };
}

/** LINE User ID は生で残さない（監査ログに個人IDを平文で置かない） */
function maskUserId(userId: string): string {
  const s = String(userId || '');
  if (s.length <= 8) return 'U***';
  return `${s.slice(0, 5)}***${s.slice(-3)}`;
}

/** 本文中の承認カードJSONを差し替える */
export function replaceCardInBody(body: string, card: unknown): string {
  const json = JSON.stringify(card, null, 2);
  return String(body).replace(
    /```json approval-card\s*[\s\S]*?```/,
    '```json approval-card\n' + json + '\n```',
  );
}

/** 状態ラベルを付け替える（旧を外して新を付ける） */
async function setState(
  githubToken: string,
  issueNumber: number,
  from: string,
  to: string,
): Promise<boolean> {
  // 旧ラベルを外す（無い場合の404は許容する）
  await githubFetch(githubToken, `/issues/${issueNumber}/labels/${encodeURIComponent(from)}`, {
    method: 'DELETE',
  });
  const added = await githubFetch(githubToken, `/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: { labels: [to] },
  });
  return added.ok;
}

/**
 * 承認カードのFlex Messageを組み立てる。
 * スマホで「何を・どこに送るか」が読めて、1タップで承認できることを最優先にする。
 */
export function buildApprovalFlex(card: Record<string, unknown>, issueNumber: number): unknown {
  const target = (card as { target?: { roomName?: string } }).target || {};
  const draft = (card as { draft?: { text?: string } }).draft || {};
  const context = (card as { context?: { triggerExcerpt?: string } }).context || {};
  const nonce = (card as { approval?: { nonce?: string } }).approval?.nonce || '';

  const roomName = String(target.roomName || '(宛先不明)');
  const text = String(draft.text || '');
  const preview = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  const trigger = String(context.triggerExcerpt || '');

  const bodyContents: unknown[] = [
    {
      type: 'text', text: '送信の承認', weight: 'bold', size: 'sm', color: '#6b21a8',
    },
    {
      type: 'text', text: roomName, weight: 'bold', size: 'lg', wrap: true, margin: 'sm',
    },
  ];

  if (trigger) {
    bodyContents.push({
      type: 'text', text: `相手: ${trigger}`, size: 'xs', color: '#9ca3af', wrap: true, margin: 'md',
    });
  }

  bodyContents.push({
    type: 'separator', margin: 'md',
  });
  bodyContents.push({
    type: 'text', text: preview, size: 'sm', wrap: true, margin: 'md', color: '#1f2937',
  });
  bodyContents.push({
    type: 'text',
    text: '修正したいときは、この下に修正内容を返信してください',
    size: 'xxs', color: '#9ca3af', wrap: true, margin: 'lg',
  });

  return {
    type: 'bubble',
    body: { type: 'box', layout: 'vertical', contents: bodyContents },
    footer: {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button', style: 'secondary', height: 'sm',
          action: { type: 'postback', label: '却下', data: buildPostbackData('reject', issueNumber, nonce) },
        },
        {
          type: 'button', style: 'primary', height: 'sm', color: '#7c3aed',
          // ラベルは短く保つ。LINEのボタンは却下と横並びで幅が半分しかなく、
          // 「この内容で送信」(7文字)は実機で見切れた（2026-08-17 実機確認）。
          action: { type: 'postback', label: '送信を承認', data: buildPostbackData('approve', issueNumber, nonce) },
        },
      ],
    },
  };
}
