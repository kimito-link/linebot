#!/usr/bin/env node
/**
 * 転送ルールのJSONから、本番D1へ入れるSQLを組み立てる。
 *
 * 【なぜスクリプトにするか】
 * workflow の中にインラインで書くと、シェルとNodeとSQLの3重クォートになり
 * 必ず壊れる（実際に壊れた）。ファイルに出せば素直に書ける。
 *
 * 【★機密を通さない】
 * 元のxlsxの設定シートに Chatwork APIトークンが平文である。
 * 手で貼るときに紛れ込む事故を防ぐため、出す前に検査して混入があれば止める。
 *
 * 使い方: node scripts/build-forward-rules-sql.mjs <rules.json> <out.sql>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , src, out] = process.argv;
if (!src || !out) {
  console.error('使い方: node scripts/build-forward-rules-sql.mjs <rules.json> <out.sql>');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(src, 'utf8'));
const rules = Array.isArray(parsed) ? parsed : parsed.rules;

if (!Array.isArray(rules) || rules.length === 0) {
  console.error('✗ rules が空です');
  process.exit(1);
}

// ★形が壊れているものを本番に入れない
for (let i = 0; i < rules.length; i++) {
  const r = rules[i];
  if (!r?.match?.from) {
    console.error(`✗ ${i + 1}件目に match.from がありません`);
    process.exit(1);
  }
  if (!Array.isArray(r.match.subjectContainsAll) || r.match.subjectContainsAll.length === 0) {
    console.error(`✗ ${i + 1}件目の subjectContainsAll が空です（全メールに当たってしまいます）`);
    process.exit(1);
  }
}

const payload = JSON.stringify({ version: 1, rules });

// ★APIトークンらしき文字列が混ざっていないか
if (/[0-9a-f]{32}/i.test(payload)) {
  console.error('✗ APIトークンらしき32桁hexが混ざっています。中止しました。');
  process.exit(1);
}

// SQLの文字列リテラル用に ' を '' へ
const escaped = payload.split("'").join("''");

writeFileSync(
  out,
  `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
VALUES (
  'efr-1',
  (SELECT id FROM line_accounts ORDER BY created_at ASC LIMIT 1),
  'email_forward_rules',
  '${escaped}',
  datetime('now'),
  datetime('now')
)
ON CONFLICT (line_account_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');
`,
  'utf8',
);

const bySite = rules.reduce((a, r) => ((a[r.site] = (a[r.site] ?? 0) + 1), a), {});
console.log(`✓ ${rules.length}件のルールからSQLを作りました`);
console.log(`  ${Object.entries(bySite).map(([k, v]) => `${k}=${v}`).join(' ')}`);
