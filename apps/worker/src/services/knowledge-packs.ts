import * as aiShain from './groq-knowledge-content.js';
import * as talentOshikatsu from './talent-oshikatsu-knowledge-content.js';
import * as soushinSuggest from './soushin-suggest-knowledge-content.js';
import * as henshinHisho from './henshin-hisho-knowledge-content.js';
import * as webHealthCheck from './web-health-check-knowledge-content.js';
import * as dogfoodInvoiceChecker from './dogfood-invoice-checker-knowledge-content.js';
import * as yukkuriExosome from './yukkuri-exosome-knowledge-content.js';
import { getDefaultProject } from './groq-config.js';

export interface BundledKnowledgePack {
  project: string;
  buildSystemPrompt(kbContext: string): string;
  matchCannedResponse(text: string): string | null;
  matchCannedResponseWithImage?(text: string): { text: string; imageUrl: string } | null;
  getFailClosedEscalationText(): string;
}

const PACKS: Record<string, BundledKnowledgePack> = {
  // ★2026-09-02: タレント事務所さま向け。出演のお知らせ → 3択で参加表明 →
  //   当日を迎える前に人数が見える、という一連を担当する。
  //   正本は knowledge-packs/talent-oshikatsu/（md を直したら content.ts も作り直す）
  'talent-oshikatsu': {
    project: 'talent-oshikatsu',
    buildSystemPrompt: talentOshikatsu.buildSystemPrompt,
    matchCannedResponse: talentOshikatsu.matchCannedResponse,
    getFailClosedEscalationText: talentOshikatsu.getFailClosedEscalationText,
  },
  'ai-shain-link': {
    project: 'ai-shain-link',
    buildSystemPrompt: aiShain.buildSystemPrompt,
    matchCannedResponse: aiShain.matchCannedResponse,
    matchCannedResponseWithImage: aiShain.matchCannedResponseWithImage,
    getFailClosedEscalationText: aiShain.getFailClosedEscalationText,
  },
  'soushin-suggest': {
    project: 'soushin-suggest',
    buildSystemPrompt: soushinSuggest.buildSystemPrompt,
    matchCannedResponse: soushinSuggest.matchCannedResponse,
    getFailClosedEscalationText: soushinSuggest.getFailClosedEscalationText,
  },
  'henshin-hisho': {
    project: 'henshin-hisho',
    buildSystemPrompt: henshinHisho.buildSystemPrompt,
    matchCannedResponse: henshinHisho.matchCannedResponse,
    getFailClosedEscalationText: henshinHisho.getFailClosedEscalationText,
  },
  'web-health-check': {
    project: 'web-health-check',
    buildSystemPrompt: webHealthCheck.buildSystemPrompt,
    matchCannedResponse: webHealthCheck.matchCannedResponse,
    getFailClosedEscalationText: webHealthCheck.getFailClosedEscalationText,
  },
  'dogfood-invoice-checker': {
    project: 'dogfood-invoice-checker',
    buildSystemPrompt: dogfoodInvoiceChecker.buildSystemPrompt,
    matchCannedResponse: dogfoodInvoiceChecker.matchCannedResponse,
    getFailClosedEscalationText: dogfoodInvoiceChecker.getFailClosedEscalationText,
  },
  'yukkuri-exosome': {
    project: 'yukkuri-exosome',
    buildSystemPrompt: yukkuriExosome.buildSystemPrompt,
    matchCannedResponse: yukkuriExosome.matchCannedResponse,
    getFailClosedEscalationText: yukkuriExosome.getFailClosedEscalationText,
  },
};

/** Returns the bundled pack for `project`, falling back to the default project (fail-closed) if unknown. */
export function getKnowledgePack(project: string): BundledKnowledgePack {
  return PACKS[project] ?? PACKS[getDefaultProject()];
}
