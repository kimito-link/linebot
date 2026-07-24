/**
 * Gemini客観描写テキストから、りんく/こん太/たぬ姉のいずれかが写っているかを
 * 決定的な文字列マッチングで判定する。LLM推論には一切依存しない（fail-open:
 * 判定不能・両義的な場合はnullを返し、呼び出し側は現状のincomingText文面に
 * フォールバックする）。
 *
 * 設計背景: persona.mdへの外見カード追加だけでは、Groqがdescriptionと自分の
 * 外見を照合する判定を行えず、常に三人称描写のままだった（2026-07-20実機確認）。
 * _docs/SELF-RECOGNITION-DESIGN.md参照。
 */

export type SelfMatchCharacter = 'りんく' | 'こん太' | 'たぬ姉';

export interface SelfMatchResult {
  character: SelfMatchCharacter;
  confidence: 'high' | 'probable';
  matchedFeatures: string[];
}

interface FeatureGroup {
  weight: 1 | 2 | 3;
  pattern: RegExp;
  label: string;
}

// 「Xのような耳」「獣耳」系の表現は、主体がXそのものでは*ない*（=獣耳キャラである）ことを
// 含意する。本物の動物の動画なら「猫が…」と書かれ「猫のような耳」とは書かれないため、
// 実在動物の描写と衝突しない安全な特徴として使える（2026-07-20 Fable設計書 §2.3参照）。
// どちらのキャラの動物か特定できない汎用表現（「獣耳」「けも耳」等）のみ、ここに残す。
// 「猫耳」「狐耳」のような動物種を特定できる表現は、キャラ固有の特徴として各キャラの
// FEATURE_TABLEに直接持たせる（両キャラ同点でnullに落ちるのを防ぐため。2026-07-24実機:
// 「猫耳がとても可愛い」がこん太・たぬ姉の共通KEMOMIMIパターンにしかマッチせず、
// 両者同点で判定不能になっていた）。
const KEMOMIMI_GENERIC = /獣耳|けも(の)?耳|ケモ耳|アニマル(風の)?耳/;
const KEMOMIMI_FOX = /(狐|きつね|キツネ)のような耳|(狐|きつね|キツネ)耳/;
const KEMOMIMI_CAT = /(猫|ねこ|ネコ)のような耳|(猫|ねこ|ネコ)耳/;
const KEMOMIMI_TANUKI = /(狸|たぬき|タヌキ)のような耳|(狸|たぬき|タヌキ)耳/;

const FEATURE_TABLE: Record<SelfMatchCharacter, FeatureGroup[]> = {
  りんく: [
    { weight: 2, pattern: /ヘッドホン|ヘッドフォン/, label: 'headphones' },
    { weight: 1, pattern: /金髪|ブロンド|金色の髪|黄色い髪/, label: 'blonde_hair' },
    { weight: 1, pattern: /オレンジ(色)?の?リボン|リボン/, label: 'ribbon' },
  ],
  こん太: [
    { weight: 2, pattern: /狐|きつね|キツネ/, label: 'fox' },
    { weight: 2, pattern: KEMOMIMI_FOX, label: 'kemomimi_fox' },
    // こん太のモチーフ動物は狐だが、LP素材の見た目（茶系の丸耳）をGeminiが
    // 「猫」と描写することが実機で確認できた（2026-07-24: 「猫耳がとても可愛い」）。
    // 汎用KEMOMIMIパターンだとたぬ姉と同点になるため、こん太固有の手がかりとして扱う。
    { weight: 2, pattern: KEMOMIMI_CAT, label: 'kemomimi_cat' },
    { weight: 1, pattern: KEMOMIMI_GENERIC, label: 'kemomimi_generic' },
    // オレンジ髪はりんく(金髪)・たぬ姉(茶髪)と衝突しないこん太固有の色。単独でも
    // probableに届くようweight3に格上げ（2026-07-20実機: 耳に触れない描写で
    // オレンジ髪だけが唯一の手がかりになるケースを確認したため）。
    { weight: 3, pattern: /オレンジ(色)?の?髪/, label: 'orange_hair' },
    { weight: 1, pattern: /尻尾|しっぽ|シッポ/, label: 'tail' },
    { weight: 1, pattern: /耳/, label: 'ears' },
  ],
  たぬ姉: [
    { weight: 2, pattern: /狸|たぬき|タヌキ/, label: 'tanuki' },
    { weight: 2, pattern: KEMOMIMI_TANUKI, label: 'kemomimi_tanuki' },
    { weight: 1, pattern: KEMOMIMI_GENERIC, label: 'kemomimi_generic' },
    { weight: 1, pattern: /茶髪|茶色(い|の)髪/, label: 'brown_hair' },
    { weight: 1, pattern: /尻尾|しっぽ|シッポ/, label: 'tail' },
    { weight: 1, pattern: /耳/, label: 'ears' },
  ],
};

function scoreCharacter(normalized: string, groups: FeatureGroup[]): { score: number; matchedFeatures: string[] } {
  let score = 0;
  const matchedFeatures: string[] = [];
  for (const group of groups) {
    if (group.pattern.test(normalized)) {
      score += group.weight;
      matchedFeatures.push(group.label);
    }
  }
  return { score, matchedFeatures };
}

/** マッチなし・複数キャラ同点はnull（現状動作へフォールバック）。 */
export function matchSelfCharacter(description: string): SelfMatchResult | null {
  const normalized = description.normalize('NFKC').toLowerCase();

  const scored = (Object.keys(FEATURE_TABLE) as SelfMatchCharacter[]).map((character) => ({
    character,
    ...scoreCharacter(normalized, FEATURE_TABLE[character]),
  }));

  const candidates = scored.filter((s) => s.score >= 3);
  if (candidates.length === 0) return null;

  const maxScore = Math.max(...candidates.map((c) => c.score));
  const top = candidates.filter((c) => c.score === maxScore);
  if (top.length !== 1) return null;

  const winner = top[0];
  return {
    character: winner.character,
    confidence: winner.score >= 4 ? 'high' : 'probable',
    matchedFeatures: winner.matchedFeatures,
  };
}
