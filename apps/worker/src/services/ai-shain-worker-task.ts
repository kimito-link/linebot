/**
 * "個人AI社員"のタスクキュー入口。LINEメッセージが "タスク:" で始まると、
 * kimito-link/ai-shain-worker に GitHub Issue を作成する。そちらのリポジトリの
 * poll-and-run.ps1（Windowsタスクスケジューラーで5分おき起動）が拾い、
 * claude -p で非対話実行する。
 *
 * 設計の背景: ai-shain.link/docs/ARCHITECTURE-personal-ai-employee-first.md
 *
 * セキュリティ上重要: これは開発者本人のPC上で claude -p を非対話実行させる
 * トリガーであり、送信者チェックを外すと「ゆっくりサポートAI社員りんく」の
 * 友だち全員（不特定多数の顧客）が任意のプロンプトでローカルコード実行を
 * トリガーできてしまう（リモートコード実行の入口になる）。
 * ALLOWED_LINE_USER_IDS に含まれる送信者以外は必ず無視すること。
 */

const TASK_PREFIX = 'タスク:';
const TASK_REPO = 'kimito-link/ai-shain-worker';
const TASK_LABEL = 'ai-shain-task';

// 開発者本人のLINE User ID（アカウントごとに異なるIDが割り当てられるため複数）。
// 2026-07-15 時点で messages_log の表示名 "tk" (tkjp1@me.com) から本人確認済み。
const ALLOWED_LINE_USER_IDS = new Set([
  'Uc21d97ee9238cff7c59a644c6b165c84', // Kimito-Link Project アカウント上の本人ID
  'U27f1afe4ba1893c313168f1c482f3ce8', // ゆっくりサポートAI社員りんく アカウント上の本人ID
]);

export interface TaskCreationResult {
  created: boolean;
  issueUrl?: string;
  error?: string;
}

/** "タスク:" で始まるメッセージかどうかを判定する。 */
export function isTaskMessage(text: string): boolean {
  return text.trim().startsWith(TASK_PREFIX);
}

/**
 * 送信者が本人（開発者自身のLINEアカウント）かどうかを判定する。
 * これを通らない送信者からの "タスク:" メッセージは、タスク登録せず
 * 通常のGROQ会話として処理させること（無視するのではなく黙ってフォールバック）。
 */
export function isAuthorizedTaskSender(lineUserId: string): boolean {
  return ALLOWED_LINE_USER_IDS.has(lineUserId);
}

/** プレフィックスを除いたタスク本文を取り出す。 */
export function extractTaskBody(text: string): string {
  return text.trim().slice(TASK_PREFIX.length).trim();
}

/**
 * GitHub Issue を作成する。GITHUB_TOKEN が未設定の場合は何もせず
 * { created: false } を返す（この機能はオプトインの個人利用機能のため）。
 *
 * 呼び出し元は必ず isAuthorizedTaskSender() の確認を先に行うこと。
 * このヘルパー自体は送信者チェックを行わない。
 */
export async function createAiShainTask(
  githubToken: string | undefined,
  taskBody: string,
  fromDisplayName: string | null,
): Promise<TaskCreationResult> {
  if (!githubToken) {
    return { created: false, error: 'GITHUB_TOKEN not configured' };
  }

  const title = taskBody.length > 80 ? `${taskBody.slice(0, 80)}…` : taskBody;
  const body = [
    taskBody,
    '',
    '---',
    `LINE経由で登録（送信者: ${fromDisplayName ?? '不明'}）`,
  ].join('\n');

  const response = await fetch(`https://api.github.com/repos/${TASK_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'ai-shain-worker-task-creator',
    },
    body: JSON.stringify({
      title,
      body,
      labels: [TASK_LABEL],
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return { created: false, error: `GitHub API ${response.status}: ${errText.slice(0, 200)}` };
  }

  const data = (await response.json()) as { html_url?: string };
  return { created: true, issueUrl: data.html_url };
}
