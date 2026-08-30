#!/usr/bin/env node
/**
 * LP のリンク切れ検知。
 *
 * 背景: 2026-08-30、両LPの「LINEで相談する」ボタンが href="#" のまま公開されていた
 * ことに、誰も気づかないまま時間が過ぎていた。**押しても何も起きない**状態が
 * 実害として存在したのに、それを検出する仕組みが無かった。
 * URLをHTMLに直書きする以上、切れたことに気づく手段を同時に持つ必要がある。
 *
 * 検知する異常:
 *   1. CTA が href="#" のまま（＝プレースホルダを消し忘れた）
 *   2. LINE の友だち追加URLが応答しない（＝アカウントが消えた・IDが変わった）
 *   3. 内部リンクの参照先が存在しない（＝ページを消したのにリンクが残った）
 *   4. 画像・動画の参照先が存在しない
 *
 * 使い方:
 *   node scripts/check-lp-links.mjs
 *   node scripts/check-lp-links.mjs --offline   # 外部への通信をしない（CI用）
 *
 * exit codes: 0=異常なし / 1=異常あり / 2=検査自体に失敗（沈黙を「問題なし」と誤読させない）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LP_DIR = resolve(__dirname, '..', 'apps', 'lp');
const OFFLINE = process.argv.includes('--offline');

const problems = [];
const notes = [];

/** LP配下の index.html を全部見つける（一覧を手書きしない）。 */
function findPages(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) findPages(p, acc);
    else if (e.name === 'index.html') acc.push(p);
  }
  return acc;
}

function rel(p) {
  return p.replace(LP_DIR, 'apps/lp').replace(/\\/g, '/');
}

if (!existsSync(LP_DIR)) {
  console.error(`検査対象が見つからない: ${LP_DIR}`);
  process.exit(2);
}

const pages = findPages(LP_DIR);
if (pages.length === 0) {
  console.error('index.html が1つも見つからない（検査できていない可能性が高い）');
  process.exit(2);
}

const lineUrls = new Set();

for (const page of pages) {
  const html = readFileSync(page, 'utf8');
  const label = rel(page);

  // 1. プレースホルダのまま残っているCTA
  //    href="#" 単体はアンカーとして意味を成さない（#section は正常なので除外）。
  const placeholders = [...html.matchAll(/<a[^>]*class="[^"]*btn-primary[^"]*"[^>]*href="#"[^>]*>/g)];
  for (const m of placeholders) {
    problems.push(`${label}: CTAが href="#" のまま（押しても何も起きない）\n    ${m[0].slice(0, 90)}`);
  }

  // 2. LINE の友だち追加URL を集める（後でまとめて疎通確認）
  for (const m of html.matchAll(/https:\/\/(line\.me\/R\/ti\/p\/[^"'\s]+|lin\.ee\/[^"'\s]+)/g)) {
    lineUrls.add(m[0]);
  }

  // 3. 内部リンク（/xxx 形式）の参照先が存在するか
  for (const m of html.matchAll(/href="(\/[^"#?]*)"/g)) {
    const href = m[1];
    // 拡張子付き（画像など）は 4 で見るのでここでは飛ばす
    if (/\.[a-z0-9]{2,5}$/i.test(href)) continue;
    // ルートは _redirects / vercel.json で /kimitotalk にリライトされる。
    // ここを異常にすると「常に赤い検査器」になり、無視されるようになる。
    if (href === '/' || href === '') continue;
    const candidates = [
      join(LP_DIR, href, 'index.html'),
      join(LP_DIR, `${href}.html`),
    ];
    if (!candidates.some(existsSync)) {
      problems.push(`${label}: 内部リンクの参照先が無い → ${href}`);
    }
  }

  // 4. 画像・動画の参照先が存在するか
  for (const m of html.matchAll(/(?:src|href|poster)="(\/[^"]+\.(?:png|jpe?g|gif|webp|svg|ico|mp4|webm|m4a|mp3))"/gi)) {
    const p = join(LP_DIR, m[1]);
    if (!existsSync(p)) {
      problems.push(`${label}: アセットが無い → ${m[1]}`);
    }
  }
}

notes.push(`検査したページ: ${pages.length}枚`);

// 5. ルートのリライト設定が実在するか。
//    上で `/` へのリンクを異常扱いしないのは、この設定があるからこそ。
//    設定が消えるとトップページが404になるので、除外の根拠ごと検査する。
{
  const redirectsPath = join(LP_DIR, '_redirects');
  const vercelPath = join(LP_DIR, 'vercel.json');
  const hasRedirects =
    existsSync(redirectsPath) && /^\s*\/\s+\S/m.test(readFileSync(redirectsPath, 'utf8'));
  let hasVercelRewrite = false;
  if (existsSync(vercelPath)) {
    try {
      const v = JSON.parse(readFileSync(vercelPath, 'utf8'));
      hasVercelRewrite = (v.rewrites ?? []).some((r) => r.source === '/');
    } catch {
      problems.push('vercel.json が壊れている（JSONとして読めない）');
    }
  }
  if (!hasRedirects && !hasVercelRewrite) {
    problems.push(
      'ルート(/)のリライト設定が無い。トップページが404になる' +
        '（_redirects か vercel.json のどちらかに必要）',
    );
  } else {
    notes.push(
      `ルートのリライト: ${[hasRedirects && '_redirects', hasVercelRewrite && 'vercel.json']
        .filter(Boolean)
        .join(' / ')}`,
    );
  }
}

// LINEのURLを実際に叩く。書式が正しくてもアカウントが消えていれば意味がない。
if (lineUrls.size === 0) {
  notes.push('LINE友だち追加URL: 0件（CTAが未接続の可能性）');
} else if (OFFLINE) {
  notes.push(`LINE友だち追加URL: ${lineUrls.size}件（--offline のため疎通は未確認）`);
} else {
  for (const url of lineUrls) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      // LINEは存在しないIDでも200を返すことがあるため、本文も見る。
      const body = await res.text();
      const looksMissing = /存在しません|見つかりません|not found/i.test(body);
      if (!res.ok || looksMissing) {
        problems.push(`LINE友だち追加URLが無効 → ${url}（status=${res.status}）`);
      } else {
        notes.push(`OK: ${url}`);
      }
    } catch (err) {
      // 通信できなかったことを「異常なし」に倒さない
      problems.push(
        `LINE友だち追加URLの確認に失敗 → ${url}（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  }
}

for (const n of notes) console.log(`  ${n}`);

if (problems.length > 0) {
  console.error(`\n★ ${problems.length}件の異常:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('\n✓ LPのリンクに異常なし');
process.exit(0);
