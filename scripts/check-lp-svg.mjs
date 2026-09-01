#!/usr/bin/env node
/**
 * LP に置いた SVG が、ブラウザで実際に表示できる形かを確かめる。
 *
 * 【なぜ要るか】2026-09-01 に実際に踏んだ:
 *   SVGのコメントに CSS変数名（ハイフン2つで始まる名前）を書いたら、
 *   XMLとして不正になり **画像がまるごと表示されなくなった**。
 *   ★ファイルは存在し、HTTP 200 で、Content-Type も image/svg+xml だった。
 *     それでも表示されない。ブラウザは黙って壊れた画像アイコンを出すだけで、
 *     コンソールにも何も出ない。目で見るまで気づけなかった。
 *
 *   → 「200が返る」は「表示できる」ではない。ここを機械で見る。
 *
 * 【3値で返す】web-ios-android/_docs/instruments/HANDOFF-new-app.md の規約:
 *   0 = 合格 / 1 = 測れた上での赤 / 2 = 測れなかった
 *   ★「測れなかった」を合格にも不合格にも丸めない。
 *
 * 使い方:
 *   node scripts/check-lp-svg.mjs
 *   node scripts/check-lp-svg.mjs --selftest   ← 検査自体が壊れていないかを確かめる
 */
import { readFileSync, globSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ★Windows対策: import.meta.url の pathname を自前で削ると
//   日本語パスが %E3%83%87... のまま残り、ファイルが見つからなくなる。
//   fileURLToPath を使うのが正しい（2026-09-01 実際に踏んだ）。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * SVG を XML として検査する。
 * ★依存を増やさないため、外部パーサは使わず自前で見る。
 *   見るのは「実際に表示を壊した原因」に絞る。憶測でルールを増やさない。
 */
function inspect(text) {
  const problems = [];

  // ① コメント内のハイフン2つ（実際に踏んだ地雷）
  //    XMLの仕様上、コメントの中に "--" は書けない。
  for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (m[1].includes('--')) {
      const line = text.slice(0, m.index).split('\n').length;
      problems.push(`${line}行目: コメントの中にハイフン2つがある（XMLでは書けない）`);
    }
  }

  // ② 閉じられていないコメント
  const opens = (text.match(/<!--/g) || []).length;
  const closes = (text.match(/-->/g) || []).length;
  if (opens !== closes) problems.push(`コメントの開閉が合わない（<!-- が${opens}個, --> が${closes}個）`);

  // ③ 素の & （実体参照になっていないもの）
  for (const m of text.matchAll(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`${line}行目: & がそのまま書かれている（&amp; にする）`);
  }

  // ④ svg タグが1組あるか
  if (!/<svg[\s>]/.test(text)) problems.push('<svg> が無い');
  if (!/<\/svg>/.test(text)) problems.push('</svg> が無い');

  return problems;
}

const SELFTEST = process.argv.includes('--selftest');

if (SELFTEST) {
  // ★毒を食わせて、赤が出るかを確かめる。
  //   検査が「何も見つけられない検査」になっていないことを実証する。
  const poison = [
    ['コメント内のハイフン2つ', '<svg xmlns="http://www.w3.org/2000/svg"><!-- --line bad --></svg>'],
    ['閉じないコメント', '<svg xmlns="http://www.w3.org/2000/svg"><!-- あ </svg>'],
    ['素の &', '<svg xmlns="http://www.w3.org/2000/svg"><text>A & B</text></svg>'],
    ['svgが無い', '<div>ちがう</div>'],
  ];
  let failed = 0;
  for (const [name, src] of poison) {
    const found = inspect(src);
    if (found.length === 0) { console.log(`★検査が毒を見逃した: ${name}`); failed++; }
    else console.log(`OK  毒を検出: ${name} → ${found[0]}`);
  }
  // 正常なものを誤検出しないことも確かめる
  const clean = '<svg xmlns="http://www.w3.org/2000/svg"><!-- ふつうの注釈 --><rect/></svg>';
  if (inspect(clean).length) { console.log('★正常なSVGを誤検出した'); failed++; }
  else console.log('OK  正常なSVGは通す');

  console.log(failed ? `\n✗ selftest 失敗 ${failed}件` : '\n✓ selftest 合格（この検査は実際に赤を出せる）');
  process.exit(failed ? 1 : 0);
}

let files;
try {
  files = globSync('apps/lp/**/*.svg', { cwd: ROOT }).map(f => join(ROOT, f));
} catch (e) {
  console.log(`? SVGを列挙できなかった: ${e.message}`);
  process.exit(2);   // ★測れなかった
}

if (files.length === 0) {
  console.log('? apps/lp 配下にSVGが1つも見つからない。パスが変わった可能性がある');
  process.exit(2);   // ★0件を「合格」にしない
}

const bad = [];
const unknown = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); }
  catch (e) { unknown.push([f, `読めなかった: ${e.message}`]); continue; }
  const problems = inspect(text);
  if (problems.length) bad.push([f, problems]);
}

for (const [f, problems] of bad) {
  console.log(`✗ ${relative(ROOT, f)}`);
  for (const p of problems) console.log(`    ${p}`);
}
for (const [f, why] of unknown) console.log(`? ${relative(ROOT, f)} — ${why}`);

if (bad.length) {
  console.log(`\n✗ 表示できないSVGが ${bad.length}件（${files.length}件中）`);
  console.log('  ★ブラウザは黙って壊れた画像を出すだけなので、直すまで気づけない。');
  process.exit(1);
}
if (unknown.length) {
  console.log(`\n? ${unknown.length}件が検査できなかった（${files.length}件中）`);
  process.exit(2);
}
console.log(`✓ SVG ${files.length}件、すべて表示できる形`);
process.exit(0);
