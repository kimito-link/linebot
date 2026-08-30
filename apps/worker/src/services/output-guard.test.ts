import { describe, test, expect } from 'vitest';
import { guardOutput, GUARD_RULES } from './output-guard.js';

describe('出力ガード — 止めるべきものを止める', () => {
  test('効果・治癒の断定を止める', () => {
    const r = guardOutput('これを飲めば頭痛が治りますよ。');
    expect(r.blocked).toBe(true);
    expect(r.hits[0].category).toBe('medical');
  });

  test('「効果があります」を止める', () => {
    expect(guardOutput('この施術は肩こりに効果があります。').blocked).toBe(true);
  });

  test('病名の断定を止める', () => {
    expect(guardOutput('それはおそらく逆流性食道炎ですね。').blocked).toBe(true);
  });

  test('受診不要の示唆を止める（最も危険）', () => {
    expect(guardOutput('この程度なら病院に行かなくて大丈夫だよ。').blocked).toBe(true);
  });

  test('薬の中止指示を止める', () => {
    expect(guardOutput('その薬はやめてくださいね。').blocked).toBe(true);
  });

  test('法的判断の断定を止める', () => {
    expect(guardOutput('それは違法です。').blocked).toBe(true);
    expect(guardOutput('その裁判なら勝てますよ。').blocked).toBe(true);
  });

  test('投資の断定を止める', () => {
    expect(guardOutput('この銘柄は絶対に儲かりますよ。').blocked).toBe(true);
  });
});

describe('出力ガード — 誤検知しない（ここが実用性の鍵）', () => {
  // 過剰に止めると運用者が無効化する。無効化されたガードは無いのと同じ。
  const shouldPass = [
    // 伝聞・出典ベースの言い回し（guardrails.md が推奨している形）
    'エクソソームについては、そういう報告があると本には書いてあるのよ。',
    '〜という研究が紹介されているみたい。',
    // 受診を促す（むしろ望ましい）
    '気になるなら、お医者さんに相談してみてね。',
    '実際に施術する先生に直接聞くのが確実よ。',
    '病院に行くのがいちばん確実だと思うな。',
    // 一般的な制度の説明
    '確定申告は毎年2月から3月にかけて行うものだよ。',
    '契約書は書面で残しておくと安心だね。',
    // 日常会話
    '今日は寒いから、あったかくして過ごしてね。',
    'その気持ち、わかるなあ。',
    '予約は明日の14時で承ったよ。',
    // 効果を「聞かれている」場合（疑問形は断定ではない）
    '効果がありますか、という質問はよくもらうの。',
    // 商品の説明（効能をうたっていない）
    'このサラダチキンはタンパク質が多いんだ。',
  ];

  for (const text of shouldPass) {
    test(`通す: ${text.slice(0, 24)}…`, () => {
      const r = guardOutput(text);
      expect(r.blocked, `誤検知: ${r.hits.map((h) => h.label).join(',')}`).toBe(false);
      expect(r.text).toBe(text);
    });
  }
});

describe('出力ガード — 止め方', () => {
  test('無言にせず、次の行動を示す文面に差し替える', () => {
    const r = guardOutput('その頭痛は治りますよ。');
    expect(r.blocked).toBe(true);
    expect(r.text.length).toBeGreaterThan(10);
    expect(r.text).toContain('お医者さん');
    // 元の危険な文面は残さない
    expect(r.text).not.toContain('治ります');
  });

  test('領域ごとに文面を変える', () => {
    expect(guardOutput('それは違法です。').text).toContain('弁護士');
    expect(guardOutput('絶対に儲かりますよ。').text).toContain('お金');
  });

  test('enabled=false なら素通しする（緊急時に切れる）', () => {
    const text = 'これで治りますよ。';
    const r = guardOutput(text, false);
    expect(r.blocked).toBe(false);
    expect(r.text).toBe(text);
  });

  test('空文字は素通し（無言化しない）', () => {
    expect(guardOutput('').blocked).toBe(false);
  });

  test('何に引っかかったかを返す（ログで追える）', () => {
    const r = guardOutput('それは治りますし、効果がありますよ。');
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0].label.length).toBeGreaterThan(0);
  });
});

describe('ルール定義の健全性', () => {
  test('全ルールにカテゴリとラベルがある', () => {
    for (const r of GUARD_RULES) {
      expect(r.label.length).toBeGreaterThan(0);
      expect(['medical', 'legal', 'financial']).toContain(r.category);
    }
  });

  test('正規表現が壊れていない（空文字で例外を出さない）', () => {
    for (const r of GUARD_RULES) {
      expect(() => r.pattern.test('')).not.toThrow();
    }
  });

  test('医療ルールが最初に来る（複数該当時に医療の文面が優先されるため）', () => {
    expect(GUARD_RULES[0].category).toBe('medical');
  });
});
