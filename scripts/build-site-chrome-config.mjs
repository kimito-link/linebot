#!/usr/bin/env node
/**
 * site-chrome.config.json → site-chrome.config.js を生成する。
 *
 * 【なぜ要るか】
 * 生成物の先頭に「generated from site-chrome.config.json. Do not edit by hand.」と
 * 書いてあるのに、**生成する側が存在しなかった**（2026-09-05 に確認）。
 * つまり実際は2つを手で揃える運用になっていて、片方だけ直すと必ずずれる。
 * ナビの項目がページによって違う、という形で出る。
 *
 * 使い方: node scripts/build-site-chrome-config.mjs [--check]
 *   --check … 生成せず、ずれていたら exit 1（CIで使える）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jsonPath = join(root, 'apps/lp/site-chrome.config.json');
const jsPath = join(root, 'apps/lp/site-chrome.config.js');

const cfg = JSON.parse(readFileSync(jsonPath, 'utf8'));

// 画面側が使うキーだけを出す（schemaVersion などは持ち込まない）
const out = {
  brandName: cfg.brandName,
  brandCopyright: cfg.brandCopyright,
  logoSrc: cfg.logoSrc,
  homeLabel: cfg.homeLabel,
  navItems: cfg.navItems,
};

const body =
  '// site-chrome.config.js — generated from site-chrome.config.json. Do not edit by hand.\n' +
  '// 生成: node scripts/build-site-chrome-config.mjs\n' +
  `window.SITE_CHROME_CONFIG = ${JSON.stringify(out, null, 2)};\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(jsPath, 'utf8');
  if (current.trim() !== body.trim()) {
    console.error('✗ site-chrome.config.js が .json とずれている');
    console.error('  直すには: node scripts/build-site-chrome-config.mjs');
    process.exit(1);
  }
  console.log('✓ site-chrome.config.js は .json と一致している');
  process.exit(0);
}

writeFileSync(jsPath, body, 'utf8');
console.log(`✓ 生成した: apps/lp/site-chrome.config.js（ナビ ${out.navItems.length}項目）`);
