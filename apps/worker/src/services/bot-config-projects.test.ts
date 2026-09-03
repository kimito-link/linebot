import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * bot.config.json の projects 登録と、実在する knowledge-pack の整合を守る。
 *
 * なぜ必要か: resolveBotProject は未登録の project を「不明」として黙って
 * defaultProject (ai-shain-link) にフォールバックする。つまり登録を忘れると、
 * web健診の友だちに AI社員の人格が応答する——エラーにならないので気づけない。
 * bot-project.test.ts は isKnownProject をモックしているためこの漏れを検出できない。
 */

const ROOT = resolve(__dirname, '../../../..');
const config = JSON.parse(readFileSync(resolve(ROOT, 'bot.config.json'), 'utf8'));

describe('bot.config.json projects', () => {
  it('registers every knowledge pack bundled into the worker', () => {
    // Workers 実行時に使うバンドル定数が存在する project は、必ず config にも登録が要る。
    for (const project of ['ai-shain-link', 'soushin-suggest', 'henshin-hisho', 'web-health-check']) {
      expect(config.projects, `${project} が bot.config.json の projects に無い`).toHaveProperty(project);
    }
  });

  // ai-shain の正本は kimito-link/ai-shain-worker の knowledge-pack/ に移動済み。
  // こちらにはリダイレクト用の README だけを残しているので .md の実在は要求しない
  // （移動の経緯は knowledge-packs/ai-shain/README.md）。
  const MOVED_OUT = new Set(['ai-shain-link']);

  it('points each project at a knowledge pack directory that exists on disk', () => {
    for (const [project, entry] of Object.entries<{ knowledgePack: string }>(config.projects)) {
      const dir = resolve(ROOT, entry.knowledgePack);
      expect(existsSync(dir), `${project} の knowledgePack が存在しない: ${entry.knowledgePack}`).toBe(true);
      if (MOVED_OUT.has(project)) {
        expect(
          existsSync(resolve(dir, 'README.md')),
          `${project} は正本を外部リポジトリへ移したので、案内用の README.md が要る`,
        ).toBe(true);
        continue;
      }
      for (const required of ['persona.md', 'guardrails.md']) {
        expect(existsSync(resolve(dir, required)), `${project} に ${required} が無い`).toBe(true);
      }
    }
  });

  it('keeps defaultProject itself registered (fail-closed の受け皿)', () => {
    expect(config.projects).toHaveProperty(config.defaultProject);
  });
});
