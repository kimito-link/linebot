#!/usr/bin/env node
/**
 * knowledge-packs/<product>/{persona.md,guardrails.md,canned/*.txt} から
 * apps/worker/src/services/<product>-knowledge-content.ts を生成する。
 *
 * 対象は新規案件のみ。既存4製品（ai-shain/soushin-suggest/henshin-hisho/web-health-check）は
 * 手書き運用のまま（apps/worker/src/services/knowledge-packs.ts:16-40 で束ねられている）なので、
 * 誤って上書きしないよう明示的に拒否する。
 *
 * docs/*.md や buildSystemPrompt の製品固有ロジック（matchCannedResponseの正規表現等）までは
 * 機械生成できない（既存4製品の実装を確認した結果、docsとcannedのファイル名マッピングは
 * 1:1でなく、matchCannedResponseは製品ごとにキーワード判定を書いている）。
 * そのため matchCannedResponse は TODO スタブとして出力し、人手で埋める前提。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXISTING_HANDWRITTEN_PRODUCTS = [
  'ai-shain',
  'soushin-suggest',
  'henshin-hisho',
  'web-health-check',
];

export class KnownProductError extends Error {
  constructor(product) {
    super(
      `"${product}" is an existing hand-written knowledge-content file (apps/worker/src/services/${product}-knowledge-content.ts or groq-knowledge-content.ts). ` +
        'This generator only handles new products; edit the existing file by hand instead.',
    );
    this.name = 'KnownProductError';
  }
}

function escapeForTemplateLiteral(source) {
  return source.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

function toConstantName(fileBaseName) {
  return fileBaseName
    .replace(/[-.]/g, '_')
    .toUpperCase();
}

/**
 * @param {string} product
 * @param {string} repoRoot
 * @returns {string} generated TypeScript source
 */
export function generateKnowledgeContent(product, repoRoot) {
  if (EXISTING_HANDWRITTEN_PRODUCTS.includes(product)) {
    throw new KnownProductError(product);
  }

  const packDir = path.join(repoRoot, 'knowledge-packs', product);
  if (!existsSync(packDir)) {
    throw new Error(`knowledge-packs/${product}/ does not exist (looked in ${packDir})`);
  }

  const personaPath = path.join(packDir, 'persona.md');
  const guardrailsPath = path.join(packDir, 'guardrails.md');
  if (!existsSync(personaPath)) {
    throw new Error(`knowledge-packs/${product}/persona.md is required but missing`);
  }
  if (!existsSync(guardrailsPath)) {
    throw new Error(`knowledge-packs/${product}/guardrails.md is required but missing`);
  }

  const personaMd = escapeForTemplateLiteral(readFileSync(personaPath, 'utf8').trimEnd());
  const guardrailsMd = escapeForTemplateLiteral(readFileSync(guardrailsPath, 'utf8').trimEnd());

  const cannedDir = path.join(packDir, 'canned');
  const cannedEntries = existsSync(cannedDir)
    ? readdirSync(cannedDir).filter((f) => f.endsWith('.txt')).sort()
    : [];

  const cannedConstants = cannedEntries.map((fileName) => {
    const baseName = fileName.replace(/\.txt$/, '');
    const constName = `CANNED_${toConstantName(baseName)}`;
    const body = escapeForTemplateLiteral(
      readFileSync(path.join(cannedDir, fileName), 'utf8').trimEnd(),
    );
    return { constName, body };
  });

  const hasEscalation = cannedConstants.some((c) => c.constName === 'CANNED_ESCALATION');

  const lines = [];
  lines.push(`// GENERATED from knowledge-packs/${product}/ — do not edit by hand`);
  lines.push('// Regenerate with: node tools/generate-knowledge-content.mjs ' + product);
  lines.push('');
  lines.push(`export const PERSONA_MD = \`${personaMd}\`;`);
  lines.push('');
  lines.push(`export const GUARDRAILS_MD = \`${guardrailsMd}\`;`);
  lines.push('');
  for (const { constName, body } of cannedConstants) {
    lines.push(`export const ${constName} = \`${body}\`;`);
    lines.push('');
  }

  lines.push('export function buildSystemPrompt(kbContext: string): string {');
  lines.push('  const parts = [PERSONA_MD, GUARDRAILS_MD];');
  lines.push("  if (kbContext.trim()) {");
  lines.push('    parts.push(`# 参考ナレッジ（回答の根拠として使う）\\n\\n${kbContext}`);');
  lines.push('  }');
  lines.push('  parts.push(');
  lines.push(
    "    '上記を守りつつ、ユーザーの質問に答えてください。担当者確認が必要な場合は応答末尾に [ESCALATE] を付けてください。',",
  );
  lines.push('  );');
  lines.push("  return parts.join('\\n\\n');");
  lines.push('}');
  lines.push('');

  lines.push('// TODO: 製品固有のキーワード判定をここに書く（既存4製品のknowledge-content.tsを参考にする）');
  lines.push('export function matchCannedResponse(text: string): string | null {');
  lines.push('  return null;');
  lines.push('}');
  lines.push('');

  lines.push('export function getFailClosedEscalationText(): string {');
  lines.push(
    hasEscalation
      ? '  return CANNED_ESCALATION;'
      : "  // TODO: canned/escalation.txt が無いためプレースホルダ。knowledge-packs/" +
          product +
          '/canned/escalation.txt を追加して再生成すること。',
  );
  if (!hasEscalation) {
    lines.push("  return '担当者確認が必要です。少々お待ちください。';");
  }
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

function main() {
  const product = process.argv[2];
  if (!product) {
    console.error('Usage: node tools/generate-knowledge-content.mjs <product>');
    process.exit(1);
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  let output;
  try {
    output = generateKnowledgeContent(product, repoRoot);
  } catch (err) {
    console.error(`generate-knowledge-content: ${err.message}`);
    process.exit(1);
  }

  const outPath = path.join(
    repoRoot,
    'apps',
    'worker',
    'src',
    'services',
    `${product}-knowledge-content.ts`,
  );
  writeFileSync(outPath, output, 'utf8');
  console.log(`wrote ${path.relative(repoRoot, outPath)}`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main();
}
