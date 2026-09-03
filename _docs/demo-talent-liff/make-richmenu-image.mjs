#!/usr/bin/env node
/**
 * リッチメニューの画像を作る（2500x843・横3分割）。
 *
 * ★talent LP が「下のボタンはいつも出ている」として見せている3つと揃える:
 *     📅出演情報 / 🎫チケット / ✉️お問い合わせ
 *   LP は「実際の画面です」と書いているので、文言が違うと嘘になる。
 *
 * 色は apps/lp/site-chrome.theme.css と同じ #667eea 系。サイトと揃える。
 *
 * 使い方:
 *   node _docs/demo-talent-liff/make-richmenu-image.mjs
 *   → richmenu.svg と richmenu.png を同じ場所に作る
 *
 * ★PNG 化について（試して分かったこと）
 *   - ffmpeg は SVG を読めない（実測で失敗）
 *   - ImageMagick は環境にある前提にしない
 *   - line-bot に playwright は入っていないので、別リポのものを借りる
 *     （_docs/demo-voice-riri/README.md にも「別ディレクトリで作業」とある）
 *   - ★SVG を file:// で開かせない。日本語パスが URL エンコードされて開けなかった。
 *     setContent で流し込めばパスを経由しないので確実。
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = 2500;
const H = 843;
const COL = W / 3;

/** playwright を借りるリポジトリ */
const PW_DIR = 'C:/Users/info/OneDrive/デスクトップ/Resilio/github/doin-challenge.com';

const ITEMS = [
  { icon: '📅', label: '出演情報' },
  { icon: '🎫', label: 'チケット' },
  { icon: '✉️', label: 'お問い合わせ' },
];

function buildSvg() {
  const cells = ITEMS.map((it, i) => {
    const cx = COL * i + COL / 2;
    return [
      `<text x="${cx}" y="${Math.round(H * 0.44)}" font-size="170" text-anchor="middle"`,
      `      font-family="Segoe UI Emoji, Apple Color Emoji, sans-serif">${it.icon}</text>`,
      `<text x="${cx}" y="${Math.round(H * 0.72)}" font-size="96" text-anchor="middle" fill="#333"`,
      `      font-family="Yu Gothic, Hiragino Sans, Meiryo, sans-serif" font-weight="600">${it.label}</text>`,
    ].join('');
  }).join('');

  // 区切り線は薄く。押せる場所が3つあると分かればよい。
  const lines = [1, 2].map((i) =>
    `<line x1="${COL * i}" y1="${Math.round(H * 0.18)}" x2="${COL * i}" y2="${Math.round(H * 0.82)}" stroke="#e5e5e5" stroke-width="3"/>`
  ).join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    cells,
    lines,
    `<rect x="0" y="0" width="${W}" height="6" fill="#667eea"/>`,
    `</svg>`,
  ].join('');
}

const svgPath = join(HERE, 'richmenu.svg');
const pngPath = join(HERE, 'richmenu.png');
writeFileSync(svgPath, buildSvg(), 'utf8');

// 撮影用スクリプトを組み立てる。
// ★ソースに \n を直接書かない（生成時に実改行へ展開されて構文が壊れる罠を4回踏んだ）。
const NL = String.fromCharCode(10);
const shot = [
  `import { chromium } from '@playwright/test';`,
  `import { readFileSync } from 'node:fs';`,
  `const svg = readFileSync(${JSON.stringify(svgPath)}, 'utf8');`,
  `const b = await chromium.launch({ headless: true });`,
  `const p = await b.newPage({ viewport: { width: ${W}, height: ${H} }, deviceScaleFactor: 1 });`,
  `await p.setContent('<style>html,body{margin:0;padding:0;overflow:hidden}</style>' + svg);`,
  `await p.waitForTimeout(700);`,
  `await p.screenshot({ path: ${JSON.stringify(pngPath)} });`,
  `await b.close();`,
].join(NL);

const shotPath = join(PW_DIR, '_richmenu-shot-tmp.mjs');
writeFileSync(shotPath, shot, 'utf8');

try {
  execFileSync('node', [shotPath], { cwd: PW_DIR, stdio: 'pipe' });
  console.log(`  作成: richmenu.png (${W}x${H})`);
} catch (e) {
  console.error('  ★PNG化に失敗:', String(e).slice(0, 220));
  process.exitCode = 1;
} finally {
  try {
    unlinkSync(shotPath);
  } catch {
    /* 消せなくても本筋には影響しない */
  }
}
