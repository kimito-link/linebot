#!/usr/bin/env node
/**
 * LINE導線の地図（/line-root/）のためのデータ収集。
 *
 * ★方針: 推測を出さない。測れたものだけを出し、測れなかったものは
 *   status:'unknown' として残す。「確かめていないこと」を緑や赤に塗ると
 *   地図そのものが嘘になる。
 *
 * ★外から叩いて状態を推測しない。
 *   2026-09-03、/r/:ref を外から叩いて「entry_route 未登録」と判定したが、
 *   実際は getRandomPoolAccount（複数アカウントへのランダム振り分け）で
 *   毎回違う結果が出ていただけだった。同じ罠を仕組みに埋め込まない。
 *
 * 集めるもの:
 *   1. github/ 配下の全リポジトリから LINE 導線URL（静的走査）
 *   2. 各短縮URLが実際にどのアカウントを指すか（ページタイトルで判定）
 *   3. D1 の entry_routes / line_accounts / friends 集計（CI でのみ・任意）
 *   4. 各エンドポイントの生存
 *
 * 使い方:
 *   node scripts/collect-line-root.mjs            # 全部
 *   node scripts/collect-line-root.mjs --offline  # 疎通確認とD1を省く（速い）
 *   → scripts/.line-root-data.json に書く（★gitignore 対象。コミットしない）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const GITHUB_DIR = join(REPO, '..');
const OFFLINE = process.argv.includes('--offline');
const OUT = join(HERE, '.line-root-data.json');
// ★CIには github/ 配下の他リポジトリが無いので、静的走査は手元の結果しか
//   完全にならない。--merge-scan-from <file> で「手元の走査結果を引き継ぎ、
//   D1と疎通確認だけCIで取り直す」ができる（走査データはコミットしないので
//   CIへは actions/upload-artifact 経由で渡す）。
const mergeIdx = process.argv.indexOf('--merge-scan-from');
const MERGE_FROM = mergeIdx >= 0 ? process.argv[mergeIdx + 1] : null;

/** 走査から外す。成果物・依存・保存済みHTMLは「生きた導線」ではない。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', '.wrangler',
  'coverage', '.venv', 'venv', '__pycache__', '.cache', 'test-results',
  // ★ouenmovie の保存済みHTMLに lin.ee が185件あるが、全部よそのページを
  //   丸ごと保存したもの。導線ではないので数えない（2026-09-03 調査で判明）。
  'download', 'Cache_Data', '.takt', 'tmp',
]);

/** 参考として残すが「生きた導線」とは区別するもの */
const ARCHIVE_HINTS = ['_pending-deletion-review', '.claude/worktrees', 'legacy', 'ui-mocks'];

/** ★テストの固定値とビルド成果物は「生きた導線」ではない。地図から外す。 */
const NOT_A_ROUTE = /\.(test|spec)\.[jt]sx?$|\/dist-mock\/|\/__tests__\//;

const TEXT_EXT = /\.(html?|astro|[jt]sx?|mjs|cjs|php|json|md|ts|vue|svelte|ahk)$/i;

// ── 1. 静的走査 ──────────────────────────────────────────────

/** LINE の友だち追加URL。check-lp-links.mjs:73 と同じ形。 */
// ★URLに使える文字だけを拾う。[^"'\s] 方式だと日本語の括弧まで飲み込み、
//   「lin.ee/JelcWtx）に設定」のような偽のURLが生まれた（実測で発覚）。
// ★?ref= まで拾う。ここを落とすと「どの導線から来たか」が分からず、
//   地図の核心（ref -> project の対応）が作れない。
// ★new RegExp('...') で組み立てない。エスケープが壊れる（2回踏んだ）。
const LINE_URL_RE =
  /https:\/\/(?:line\.me\/R\/ti\/p\/[A-Za-z0-9_@.~%-]+|lin\.ee\/[A-Za-z0-9_@.~%-]+|page\.line\.me\/[A-Za-z0-9_@.~%-]+)(?:\?[A-Za-z0-9_=&.%-]*)?/g;
const LIFF_RE = /https:\/\/liff\.line\.me\/([0-9]{10}-[A-Za-z0-9]+)/g;

function walk(dir, depth = 0, acc = []) {
  if (depth > 8) return acc;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc; // 読めないディレクトリは飛ばす（権限・シンボリックリンク）
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, depth + 1, acc);
    } else if (TEXT_EXT.test(e.name)) {
      try {
        if (statSync(p).size > 800_000) continue; // 巨大ファイルは成果物
        acc.push(p);
      } catch { /* 消えた・読めない */ }
    }
  }
  return acc;
}

function scanRepos() {
  const repos = readdirSync(GITHUB_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name);

  /** url -> { url, hits: [{repo, file, line}] } */
  const links = new Map();
  const liffIds = new Map();

  for (const repo of repos) {
    const root = join(GITHUB_DIR, repo);
    for (const file of walk(root)) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch { continue; }
      if (!text.includes('line.me') && !text.includes('lin.ee')) continue;

      const relPath = relative(GITHUB_DIR, file).replace(/\\/g, '/');
      if (NOT_A_ROUTE.test(relPath)) continue;
      const isArchive = ARCHIVE_HINTS.some((h) => relPath.includes(h));
      const lines = text.split('\n');

      for (let i = 0; i < lines.length; i++) {
        for (const m of lines[i].matchAll(LINE_URL_RE)) {
          // クエリと末尾の記号を落として正規化（?ref= 違いは同じ導線）
          const clean = m[0].replace(/[)"'`,;]+$/, '');
          const base = clean.split('?')[0];
          // 手順書中のプレースホルダ（lin.ee/... や @xxxxxxxx）は導線ではない
          const slug = base.split('/').pop();
          if (/^\.+$/.test(slug) || /^@?x{4,}$/i.test(slug) || slug.length < 3) continue;
          if (!links.has(base)) links.set(base, { url: base, hits: [], refs: new Set() });
          const rec = links.get(base);
          rec.hits.push({ repo, file: relPath, line: i + 1, archive: isArchive, raw: clean });
          const q = clean.includes('?ref=') ? clean.split('?ref=')[1].split('&')[0] : null;
          if (q) rec.refs.add(q);
        }
        for (const m of lines[i].matchAll(LIFF_RE)) {
          const id = m[1];
          // ★テストのダミーIDを地図に載せない（1234567890-abcdefgh 等）。
          //   実在のIDは 20xxxxxxxx 台で、xxxx やゾロ目の連番は使われない。
          if (/^1[0-9]{9}-/.test(id) && !/^16[0-9]{8}-/.test(id)) continue;
          if (/x{4,}|abcdefgh|DefaultAA|-Second$/i.test(id)) continue;
          if (!liffIds.has(id)) liffIds.set(id, []);
          liffIds.get(id).push({ repo, file: relPath, line: i + 1, archive: isArchive });
        }
      }
    }
  }

  return {
    links: [...links.values()].map((r) => ({ ...r, refs: [...r.refs] })),
    liffIds: [...liffIds.entries()].map(([id, hits]) => ({ id, hits })),
  };
}

// ── 2. 短縮URLの実体判定 ─────────────────────────────────────

/**
 * ★存在しないスラッグは <title> が空になる（2026-09-03 に対照実験で確認）。
 *   タイトルが取れたものだけを「実在」とし、取れなければ unknown のまま残す。
 */
async function resolveIdentity(url) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; line-root-map)' },
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const m = html.match(/<title>([^<]*)<\/title>/i);
    const title = (m ? m[1] : '').replace(/\s*\|\s*LINE Official Account\s*$/i, '').trim();
    // ★認証済みアカウント（緑バッジ）かどうか。実物の管理画面にも出る情報で、
    //   「公式はこれだけ」と示せるかに関わるので地図にも載せる。
    //   2026-09-04 実測: 認証済みのページには verified / badge が含まれ、
    //   未認証（lin.ee/zMVlevv）には含まれない。
    const verified = /verified/i.test(html);
    if (!title || title === 'Add LINE friend') {
      // 「Add LINE friend」は実体名を出さない設定のアカウント。実在はする。
      return { status: res.status, account: null, verified, note: title ? 'アカウント名非公開' : null };
    }
    return { status: res.status, account: title, verified, note: null };
  } catch (e) {
    return { status: null, account: null, note: `取得できず: ${String(e.message).slice(0, 60)}` };
  }
}

// ── 3. D1（CI でのみ。手元のトークンでは権限が足りない） ────────

/**
 * ★SELECT * は絶対にしない。line_accounts には channel_access_token /
 *   channel_secret / login_channel_secret が入っている。
 *   カラムを明示指定し、機密は1つも選ばない。
 */
const QUERIES = {
  entryRoutes:
    'SELECT ref_code, name, project, pool_id, is_active FROM entry_routes ORDER BY ref_code',
  lineAccounts:
    "SELECT id, name, CASE WHEN liff_id IS NULL OR liff_id = '' THEN 0 ELSE 1 END AS has_liff, " +
    'default_project, is_active FROM line_accounts ORDER BY name',
  friendCounts:
    'SELECT line_account_id, ref_code, COUNT(*) AS n FROM friends GROUP BY line_account_id, ref_code',
};

function queryD1(sql) {
  const dbName = process.env.D1_DATABASE_NAME;
  if (!dbName) return null;
  try {
    const out = execFileSync(
      'npx',
      ['wrangler', 'd1', 'execute', dbName, '--remote', '--json', '--command', sql],
      { cwd: join(REPO, 'apps/worker'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 },
    );
    // wrangler は JSON の前に案内文を出すことがあるので、最初の [ か { から読む
    const start = out.search(/[[{]/);
    if (start < 0) return null;
    const parsed = JSON.parse(out.slice(start));
    return Array.isArray(parsed) ? (parsed[0]?.results ?? []) : (parsed.results ?? []);
  } catch (e) {
    console.error(`  D1 が読めなかった: ${String(e.message).slice(0, 120)}`);
    return null;
  }
}

// ── 4. エンドポイントの生存 ──────────────────────────────────

const ENDPOINTS = [
  { label: 'Worker 本体', url: 'https://kimitolink-line.info-a40.workers.dev/', method: 'GET', ok: [200] },
  { label: 'Webhook（LINEからの受け口）', url: 'https://kimitolink-line.info-a40.workers.dev/webhook', method: 'POST', ok: [200] },
  { label: 'LIFF 転送', url: 'https://kimitolink-line.info-a40.workers.dev/liff?liff.state=%2Fevents%2Fevt-talent-demo-1123', method: 'GET', ok: [302], noRedirect: true },
  { label: 'LIFF 配信（実運用）', url: 'https://kimitolink-line-liff.pages.dev/', method: 'GET', ok: [200] },
  { label: 'LP（kimitotalk.link）', url: 'https://kimitotalk.link/talent/', method: 'GET', ok: [200] },
];

async function checkEndpoint(ep) {
  try {
    const res = await fetch(ep.url, {
      method: ep.method,
      redirect: ep.noRedirect ? 'manual' : 'follow',
      headers: ep.method === 'POST' ? { 'Content-Type': 'application/json' } : {},
      body: ep.method === 'POST' ? '{"events":[]}' : undefined,
      signal: AbortSignal.timeout(20000),
    });
    return { ...ep, status: res.status, alive: ep.ok.includes(res.status) };
  } catch (e) {
    return { ...ep, status: null, alive: null, note: String(e.message).slice(0, 60) };
  }
}

// ── main ────────────────────────────────────────────────────

console.log('LINE導線を集めています…');

let scan, identities = [];
if (MERGE_FROM && existsSync(MERGE_FROM)) {
  console.log(`  1. 走査は引き継ぐ（${MERGE_FROM}）`);
  const prev = JSON.parse(readFileSync(MERGE_FROM, 'utf8'));
  scan = prev.scan;
  identities = prev.identities ?? [];
  console.log(`     導線URL ${scan.links.length}件 / LIFF ID ${scan.liffIds.length}件（引き継ぎ）`);
} else {
  console.log('  1. github/ 配下を走査');
  scan = scanRepos();
  console.log(`     導線URL ${scan.links.length}件 / LIFF ID ${scan.liffIds.length}件`);
}

let endpoints = [];
if (!OFFLINE) {
  if (!(MERGE_FROM && existsSync(MERGE_FROM))) {
    console.log('  2. 各URLが実際にどのアカウントを指すか判定');
    for (const link of scan.links) {
      const r = await resolveIdentity(link.url);
      identities.push({ url: link.url, ...r });
      process.stdout.write('.');
    }
    console.log('');
  }

  console.log('  3. エンドポイントの生存確認');
  endpoints = await Promise.all(ENDPOINTS.map(checkEndpoint));
} else {
  console.log('  （--offline: 疎通確認とD1を省いた）');
}

let d1 = null;
if (!OFFLINE && process.env.D1_DATABASE_NAME) {
  console.log('  4. D1 を読む');
  d1 = {
    entryRoutes: queryD1(QUERIES.entryRoutes),
    lineAccounts: queryD1(QUERIES.lineAccounts),
    friendCounts: queryD1(QUERIES.friendCounts),
  };
}

const data = {
  collectedAt: new Date().toISOString(),
  offline: OFFLINE,
  scan,
  identities,
  endpoints,
  d1,
};

writeFileSync(OUT, JSON.stringify(data, null, 2), 'utf8');
console.log(`\n書いた: ${relative(REPO, OUT).replace(/\\/g, '/')}`);
