import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXISTING_HANDWRITTEN_PRODUCTS,
  generateKnowledgeContent,
  KnownProductError,
} from './generate-knowledge-content.mjs';

describe('generateKnowledgeContent', () => {
  let packDir: string;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'gen-kc-'));
    packDir = path.join(root, 'knowledge-packs', 'test-product');
    mkdirSync(path.join(packDir, 'canned'), { recursive: true });
    writeFileSync(path.join(packDir, 'persona.md'), '# 人格・トーン\n\nテスト用の人格です。');
    writeFileSync(path.join(packDir, 'guardrails.md'), '# ガードレール\n\nテスト用の禁止事項です。');
    writeFileSync(path.join(packDir, 'canned', 'usage-overview.txt'), '使い方はこちらです。');
    writeFileSync(path.join(packDir, 'canned', 'escalation.txt'), '担当者におつなぎします。');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ハードコードした期待値のリスト。SUTのEXISTING_HANDWRITTEN_PRODUCTSをそのまま反復すると、
  // その配列を誤って空にする変異が起きてもループが0回実行され黙って緑になる（vacuous pass）。
  // このリストは独立して保持し、SUTとの一致は別テストで検証する。
  const EXPECTED_HANDWRITTEN_PRODUCTS = [
    'ai-shain',
    'soushin-suggest',
    'henshin-hisho',
    'web-health-check',
  ];

  it('rejects each known existing hand-written product', () => {
    expect.assertions(EXPECTED_HANDWRITTEN_PRODUCTS.length);
    for (const product of EXPECTED_HANDWRITTEN_PRODUCTS) {
      expect(() => generateKnowledgeContent(product, root)).toThrow(KnownProductError);
    }
  });

  it('keeps EXISTING_HANDWRITTEN_PRODUCTS in sync with the expected list', () => {
    expect([...EXISTING_HANDWRITTEN_PRODUCTS].sort()).toEqual([...EXPECTED_HANDWRITTEN_PRODUCTS].sort());
  });

  it('generates a TS file with PERSONA_MD and GUARDRAILS_MD from the md sources', () => {
    const output = generateKnowledgeContent('test-product', root);
    expect(output).toContain('export const PERSONA_MD = `# 人格・トーン');
    expect(output).toContain('テスト用の人格です。');
    expect(output).toContain('export const GUARDRAILS_MD = `# ガードレール');
    expect(output).toContain('テスト用の禁止事項です。');
  });

  it('generates a CANNED_<UPPER_SNAKE> constant per canned/*.txt file', () => {
    const output = generateKnowledgeContent('test-product', root);
    expect(output).toContain('export const CANNED_USAGE_OVERVIEW = `使い方はこちらです。`;');
    expect(output).toContain('export const CANNED_ESCALATION = `担当者におつなぎします。`;');
  });

  it('marks the output as generated and not hand-editable', () => {
    const output = generateKnowledgeContent('test-product', root);
    expect(output).toContain('GENERATED from knowledge-packs/test-product/');
    expect(output).toContain('do not edit by hand');
  });

  it('emits a matchCannedResponse stub the developer must fill in by hand', () => {
    const output = generateKnowledgeContent('test-product', root);
    expect(output).toContain('export function matchCannedResponse(text: string): string | null {');
    expect(output).toContain('TODO');
  });

  it('emits buildSystemPrompt and getFailClosedEscalationText matching the shared pattern', () => {
    const output = generateKnowledgeContent('test-product', root);
    expect(output).toContain('export function buildSystemPrompt(kbContext: string): string {');
    expect(output).toContain('export function getFailClosedEscalationText(): string {');
    expect(output).toContain('return CANNED_ESCALATION;');
  });

  it('throws if persona.md is missing', () => {
    rmSync(path.join(packDir, 'persona.md'));
    expect(() => generateKnowledgeContent('test-product', root)).toThrow(/persona\.md/);
  });

  it('throws if guardrails.md is missing', () => {
    rmSync(path.join(packDir, 'guardrails.md'));
    expect(() => generateKnowledgeContent('test-product', root)).toThrow(/guardrails\.md/);
  });

  it('does not throw when canned/ is empty', () => {
    rmSync(path.join(packDir, 'canned'), { recursive: true, force: true });
    mkdirSync(path.join(packDir, 'canned'), { recursive: true });
    expect(() => generateKnowledgeContent('test-product', root)).not.toThrow();
  });

  it('throws if the product directory does not exist', () => {
    expect(() => generateKnowledgeContent('does-not-exist', root)).toThrow(/knowledge-packs\/does-not-exist/);
  });

  it('escapes backtick and ${ sequences in source content so the generated template literal stays valid', () => {
    writeFileSync(
      path.join(packDir, 'persona.md'),
      '# 人格\n\nバッククォート ` と ${danger} を含む本文。',
    );
    const output = generateKnowledgeContent('test-product', root);
    expect(output).toContain('\\`');
    expect(output).toContain('\\${danger}');
    // Reading it back as a JS template literal must not throw.
    expect(() => new Function(`return \`${readGeneratedTemplateBody(output, 'PERSONA_MD')}\`;`)()).not.toThrow();
  });
});

function readGeneratedTemplateBody(output: string, constName: string): string {
  const marker = `export const ${constName} = \``;
  const start = output.indexOf(marker) + marker.length;
  const end = output.indexOf('`;', start);
  return output.slice(start, end);
}
