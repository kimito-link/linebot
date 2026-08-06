import { describe, expect, it } from 'vitest';
import { getKnowledgePack } from './knowledge-packs.js';

describe('getKnowledgePack', () => {
  it('returns the ai-shain pack for ai-shain-link', () => {
    const pack = getKnowledgePack('ai-shain-link');
    expect(pack.project).toBe('ai-shain-link');
  });

  it('returns the soushin-suggest pack for soushin-suggest', () => {
    const pack = getKnowledgePack('soushin-suggest');
    expect(pack.project).toBe('soushin-suggest');
  });

  it('returns the henshin-hisho pack for henshin-hisho', () => {
    const pack = getKnowledgePack('henshin-hisho');
    expect(pack.project).toBe('henshin-hisho');
  });

  it('returns the web-health-check pack for web-health-check', () => {
    const pack = getKnowledgePack('web-health-check');
    expect(pack.project).toBe('web-health-check');
  });

  it('falls back to the default project pack for an unknown project id (fail-closed)', () => {
    const pack = getKnowledgePack('nonexistent-project');
    expect(pack.project).toBe('ai-shain-link');
  });
});

describe('web-health-check knowledge pack guardrails', () => {
  const pack = () => getKnowledgePack('web-health-check');

  it('never promises deletion (結果を保証しない)', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('「必ず消せます」「確実に削除できます」等の結果の保証');
  });

  it('does not claim the site owner is always identifiable (.com は伏せられている)', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('「運営者が必ず分かります」');
    expect(prompt).toContain('.jp は組織名が公開されている場合がある');
  });

  it('uses only the three approved severity words (健全/注意/要対応)', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('「健全 / 注意 / 要対応」のみ');
    // 「危険」等への言い換えを明示的に禁じている
    expect(prompt).toContain('煽る語に言い換えない');
  });

  it('treats zero detections as ambiguous, not as proof of safety', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('「検出ゼロ」には3つの意味がある');
  });

  it('does not let the bot fix a price (金額はエスカレーション)', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('見積り金額の確定、契約、返金の判断をBotが代行しない');
  });

  it('keeps the LP promise of a 24h human reply', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('担当者が24時間以内に返事をする');
    expect(pack().getFailClosedEscalationText()).toContain('24時間以内');
  });

  it('offers phone/Zoom as an option (人がいる感)', () => {
    const prompt = pack().buildSystemPrompt('');
    expect(prompt).toContain('電話・Zoom');
    expect(pack().getFailClosedEscalationText()).toContain('電話・Zoom');
  });

  it('answers the services question with the 1-review entry point', () => {
    const answer = pack().matchCannedResponse('何を頼めるの？');
    expect(answer).toContain('口コミへの対応');
    expect(answer).toContain('1件からご相談いただけます');
  });

  it('answers the result question with the three-tier guide', () => {
    const answer = pack().matchCannedResponse('結果の見方を教えて');
    expect(answer).toContain('健全');
    expect(answer).toContain('要対応');
  });

  it('greets with the four-step flow that matches the LP', () => {
    const answer = pack().matchCannedResponse('はじめまして');
    expect(answer).toContain('24時間以内');
    expect(answer).toContain('電話・Zoom');
    expect(answer).toContain('売り込みのご連絡はいたしません');
  });
});

describe('henshin-hisho knowledge pack guardrails', () => {
  it('answers with usage overview for "使い方を教えて"', () => {
    const pack = getKnowledgePack('henshin-hisho');
    const answer = pack.matchCannedResponse('使い方を教えて');
    expect(answer).toContain('Chrome拡張');
  });

  it('does not claim Android is usable now (未配信を「使える」と言わない)', () => {
    const pack = getKnowledgePack('henshin-hisho');
    const prompt = pack.buildSystemPrompt('');
    expect(prompt).toContain('審査中');
    expect(prompt).toContain('未配信のプラットフォームを「使える」と案内しない');
  });

  it('states that sending is always done by the user (代行禁止)', () => {
    const pack = getKnowledgePack('henshin-hisho');
    const prompt = pack.buildSystemPrompt('');
    expect(prompt).toContain('送信は必ずユーザー本人が行う');
  });

  it('distinguishes bot role from acting on behalf of the user\'s customers (立場の区別)', () => {
    const pack = getKnowledgePack('henshin-hisho');
    const prompt = pack.buildSystemPrompt('');
    expect(prompt).toContain('利用者の顧客');
  });

  it('provides a fail-closed escalation text', () => {
    const pack = getKnowledgePack('henshin-hisho');
    expect(pack.getFailClosedEscalationText()).toContain('担当者');
  });
});
