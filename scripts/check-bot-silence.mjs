#!/usr/bin/env node
/**
 * LINE bot 無応答検知（AI社員の日課）。
 *
 * 背景: ai_reply_mode='human'のまま放置される、またはGROQパイプラインが例外を吐いて
 * 無言のまま止まる、という実障害が繰り返し起きた（2026-07-16, 2026-07-17）。
 * 毎回ユーザーからの「反応しなくなった」報告で気づき、手動でD1を調査していたのを
 * 自動検知に置き換える。
 *
 * 検知する異常（fail-closed: D1取得自体が失敗したら「異常あり」として報告し、
 * 沈黙を「問題なし」と誤読させない）:
 *   1. ai_reply_mode='human' のまま SILENCE_HUMAN_MINUTES 分以上放置されている友だち
 *      （エスカレーション後、誰も手動でbotに戻し忘れているケース）
 *   2. 直近の incoming に対し、SILENCE_REPLY_MINUTES 分以内に outgoing が続いていない友だち
 *      （GROQパイプラインが無言のまま失敗しているケース）
 *
 * 使い方:
 *   CLOUDFLARE_API_TOKEN=... node scripts/check-bot-silence.mjs
 *   node scripts/check-bot-silence.mjs --dry-run   # 出力のみ、exit codeは常に0
 *
 * exit codes: 0=異常なし / 1=異常あり（scheduled task側がここで気づいて報告する） / 2=D1取得自体に失敗
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || 'ca40e10bfbfdda12a70fbff91f4e1089';
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || 'b111428f-2572-4c56-85b2-6477ddb86031';

// .env を常に優先する（シェルに古い/別プロジェクト用の CLOUDFLARE_API_TOKEN が export
// されたまま残っているセッションで、そちらを誤って使ってしまう事故を避けるため。
// scheduled task は毎回新しいプロセスで動くので、汚染されたシェル変数の影響を受けない）。
let CF_TOKEN;
try {
  const envPath = join(REPO_ROOT, '.env');
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('CLOUDFLARE_API_TOKEN='));
  if (line) CF_TOKEN = line.slice('CLOUDFLARE_API_TOKEN='.length).trim();
} catch { /* .env が無ければ env 頼み */ }
if (!CF_TOKEN) CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const SILENCE_HUMAN_MINUTES = Number(process.env.SILENCE_HUMAN_MINUTES) || 60;
const SILENCE_REPLY_MINUTES = Number(process.env.SILENCE_REPLY_MINUTES) || 10;

async function d1Query(sql) {
  if (!CF_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN が未設定（envにも.envにも見つからない）');
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + CF_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`D1 API HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(`D1 query failed: ${JSON.stringify(json.errors)}`);
  return json.result[0].results;
}

function minutesAgo(isoString) {
  const then = new Date(isoString).getTime();
  return (Date.now() - then) / 60000;
}

async function main() {
  let humanStuck = [];
  let silentFriends = [];
  let queryError = null;

  try {
    // 1. human モードのまま長時間放置されている友だち
    humanStuck = await d1Query(
      `SELECT id, line_user_id, display_name, updated_at FROM friends WHERE ai_reply_mode = 'human'`,
    );
    humanStuck = humanStuck.filter((f) => minutesAgo(f.updated_at) >= SILENCE_HUMAN_MINUTES);

    // 2. 直近 incoming があるのに、その後 outgoing が続いていない友だち。
    //    friends × messages_log を突き合わせ、is_following=1 の友だちごとに最新のincoming/outgoingを見る。
    const rows = await d1Query(`
      SELECT
        f.id, f.line_user_id, f.display_name, f.ai_reply_mode,
        (SELECT MAX(created_at) FROM messages_log WHERE friend_id = f.id AND direction = 'incoming') AS last_incoming,
        (SELECT MAX(created_at) FROM messages_log WHERE friend_id = f.id AND direction = 'outgoing') AS last_outgoing
      FROM friends f
      WHERE f.is_following = 1
    `);
    silentFriends = rows.filter((r) => {
      if (!r.last_incoming) return false; // 一度も話しかけられていない友だちは対象外
      if (r.ai_reply_mode === 'human') return false; // 1.で別途検知済み（二重報告しない）
      const incomingAge = minutesAgo(r.last_incoming);
      if (incomingAge < SILENCE_REPLY_MINUTES) return false; // まだ返信猶予内
      // outgoingが無い、またはoutgoingがincomingより古い(＝incomingに未応答)場合が異常
      if (!r.last_outgoing) return true;
      return new Date(r.last_outgoing).getTime() < new Date(r.last_incoming).getTime();
    });
  } catch (e) {
    queryError = String(e.message || e);
  }

  const hasAnomaly = queryError || humanStuck.length > 0 || silentFriends.length > 0;

  const lines = [];
  lines.push(`# LINE bot 無応答チェック — ${new Date().toISOString()}`, '');

  if (queryError) {
    lines.push(`## ⚠ D1取得に失敗（＝「問題なし」ではなく確認不能）`, queryError, '');
  } else {
    lines.push(`## ai_reply_mode='human' で ${SILENCE_HUMAN_MINUTES}分以上放置`);
    if (humanStuck.length === 0) {
      lines.push('- なし');
    } else {
      for (const f of humanStuck) {
        lines.push(`- ${f.display_name || f.line_user_id}（id: ${f.id}） — ${Math.round(minutesAgo(f.updated_at))}分放置。'bot'に戻すべきか確認要`);
      }
    }
    lines.push('', `## 直近 ${SILENCE_REPLY_MINUTES}分以内のメッセージに未応答`);
    if (silentFriends.length === 0) {
      lines.push('- なし');
    } else {
      for (const f of silentFriends) {
        lines.push(`- ${f.display_name || f.line_user_id}（id: ${f.id}） — 最終incoming: ${f.last_incoming}、最終outgoing: ${f.last_outgoing || '(一度も無し)'}`);
      }
    }
  }

  const report = lines.join('\n') + '\n';
  console.log(report);

  if (DRY_RUN) process.exit(0);
  if (queryError) process.exit(2);
  process.exit(hasAnomaly ? 1 : 0);
}

main();
