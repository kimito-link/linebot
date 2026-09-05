#!/usr/bin/env node
/**
 * 転送仕様の xlsx（18ルール）を automations 用のJSONに変換する。
 *
 * 【なぜスクリプトにするか】
 * xlsx を手で写すと必ず抜ける・化ける。件名に <取引相手名> のような可変部分が
 * あり、目視での転記は事故る。正本(xlsx)から機械的に作る。
 *
 * 【★機密を持ち出さない】
 * xlsx の「設定」シートには Chatwork APIトークンが平文で入っている。
 * このスクリプトは**転送仕様シートだけ**を読み、設定シートには触れない。
 * 出力にトークンが混ざっていないことを最後に検査する。
 *
 * 【★件名は完全一致では当たらない】
 * 「[ランサーズ] <取引相手名> さんから <案件名> のコメントが届いています」のように
 * 可変部分を含む。<...> と (トークルームNo:XXXXXXXX) を除いた**固定部分**を
 * 前方一致/部分一致のキーとして持たせる。
 *
 * 使い方:
 *   node scripts/import-forward-rules.mjs <xlsx> [--out rules.json]
 *
 * exit: 0=成功 / 1=異常（黙って空を出さない）
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;

if (!src) {
  console.error('使い方: node scripts/import-forward-rules.mjs <xlsx> [--out rules.json]');
  process.exit(1);
}

// ── xlsx を開く（zip） ─────────────────────────────────
// ★PowerShell の Expand-Archive は日本語パスで落ちる（実測）。unzip を使う。
const dir = mkdtempSync(join(tmpdir(), 'fwrules-'));
try {
  execFileSync('unzip', ['-o', '-q', src, '-d', dir], { stdio: 'ignore' });
} catch (err) {
  console.error(`xlsx を展開できない: ${err instanceof Error ? err.message : String(err)}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

const decode = (t) =>
  t.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const shared = (() => {
  const xml = readFileSync(join(dir, 'xl/sharedStrings.xml'), 'utf8');
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
})();

// 転送仕様は先頭シート（sheet1）。★設定シート(sheet2)は読まない。
const sheet = readFileSync(join(dir, 'xl/worksheets/sheet1.xml'), 'utf8');
rmSync(dir, { recursive: true, force: true });

const rows = [...sheet.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map(([, rn, body]) => {
  const cells = {};
  for (const c of body.matchAll(/<c[^>]*r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const v = (c[3].match(/<v>([\s\S]*?)<\/v>/) || [])[1];
    if (v === undefined) continue;
    cells[c[1]] = /t="s"/.test(c[2]) ? (shared[Number(v)] ?? '') : v;
  }
  return { rn: Number(rn), cells };
});

/**
 * 件名から可変部分を除いた「固定部分」を取り出す。
 * 例: "[ランサーズ] <取引相手名> さんから <案件名> のコメントが届いています"
 *   → ["[ランサーズ]", "さんから", "のコメントが届いています"]
 * ★この全部を含むことを条件にする（部分一致のAND）。
 *   1つだけだと別の通知にも当たる（「[ランサーズ]」は全部に付く）。
 */
function fixedParts(subject) {
  return subject
    .replace(/<[^>]*>/g, '\u0000')                       // <取引相手名> 等
    .replace(/[（(]トークルームNo[:：][^）)]*[）)]/g, '\u0000')  // (トークルームNo:XXXXXXXX)
    .split('\u0000')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

const rules = [];
for (const { rn, cells } of rows) {
  if (rn === 1) continue;                       // 見出し
  const site = (cells.A ?? '').trim();
  const from = (cells.B ?? '').trim();
  const subject = (cells.C ?? '').trim();
  const group = (cells.D ?? '').trim();
  const scope = (cells.E ?? '').trim();
  if (!site || !from || !subject) continue;     // 空行

  rules.push({
    site, from, subject, group, scope,
    match: { from, subjectContainsAll: fixedParts(subject) },
  });
}

if (rules.length === 0) {
  console.error('ルールが1件も読めなかった（シートの形が変わった可能性）');
  process.exit(1);
}

// ★機密が混ざっていないか検査してから出す
const json = JSON.stringify({ generatedFrom: 'xlsx 転送仕様シート', rules }, null, 2);
for (const re of [/[0-9a-f]{32}/i, /APIトークン/, /Chatwork/i]) {
  if (re.test(json)) {
    console.error(`★機密らしき文字列が混ざっている (${re}) — 出力を中止した`);
    process.exit(1);
  }
}

const bySite = rules.reduce((a, r) => ((a[r.site] = (a[r.site] ?? 0) + 1), a), {});
const byScope = rules.reduce((a, r) => ((a[r.scope] = (a[r.scope] ?? 0) + 1), a), {});
console.log(`読めたルール: ${rules.length}件`);
console.log('  サイト別:', Object.entries(bySite).map(([k, v]) => `${k}=${v}`).join(' '));
console.log('  転送範囲別:', Object.entries(byScope).map(([k, v]) => `${k}=${v}`).join(' '));

if (outPath) {
  writeFileSync(outPath, json, 'utf8');
  console.log(`書き出した: ${outPath}`);
} else {
  console.log('\n--- 先頭2件 ---');
  console.log(JSON.stringify(rules.slice(0, 2), null, 2));
}
