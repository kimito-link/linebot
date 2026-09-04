#!/usr/bin/env node
/**
 * wrangler.toml から「ローカル(--local)で動かせない設定」だけを落とした
 * wrangler.dev.toml を生成する。
 *
 * 【なぜ要るか】素の wrangler.toml では `wrangler dev --local` が2か所で止まる:
 *   1. [ai] binding … Workers AI にローカル実装が無く、常に remote proxy session を
 *      開こうとする → Cloudflareの資格情報が無い環境で "Failed to start the remote
 *      proxy session" で落ちる。
 *   2. [[migrations]] deleted_classes = ["TenantScheduler"] … 本番に焼き付いた
 *      Durable Object を消すための宣言。ローカルにはその class が存在しないので
 *      "Cannot apply deleted_classes migration to non-existent class" で落ちる。
 *
 * ★手書きでコピーを作らない。正本(wrangler.toml)を書き換えたら、この生成物も
 *   次回起動時に作り直される。コピーを別管理にすると必ずずれる。
 *
 * ★生成物は .gitignore 済み。コミットしない。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(root, 'wrangler.toml'), 'utf8');

const lines = src.split(/\r?\n/);
const out = [];
let skipping = null;

for (const line of lines) {
  const isSectionHead = /^\s*\[/.test(line);
  if (skipping && isSectionHead) skipping = null;

  // [ai] セクション全体を落とす
  if (/^\s*\[ai\]\s*$/.test(line)) { skipping = 'ai'; continue; }
  // [[migrations]] セクション全体を落とす（deleted_classes を含むため）
  if (/^\s*\[\[migrations\]\]\s*$/.test(line)) { skipping = 'migrations'; continue; }
  if (skipping) continue;

  out.push(line);
}

const header = [
  '# ★このファイルは自動生成物。直接編集しない（次の起動で上書きされる）。',
  '# 生成元: wrangler.toml / 生成: scripts/make-dev-config.mjs',
  '# ローカルで動かせない [ai] と [[migrations]] を落としてある。',
  '',
].join('\n');

writeFileSync(join(root, 'wrangler.dev.toml'), header + out.join('\n'), 'utf8');

// 落とせたことを確認する（黙って素通りさせない）
const made = readFileSync(join(root, 'wrangler.dev.toml'), 'utf8');
for (const [what, re] of [['[ai]', /^\s*\[ai\]\s*$/m], ['[[migrations]]', /^\s*\[\[migrations\]\]\s*$/m]]) {
  if (re.test(made)) {
    console.error(`✗ ${what} を落とせていない`);
    process.exit(1);
  }
}
console.log('✓ wrangler.dev.toml を生成した（[ai] と [[migrations]] を除外）');
