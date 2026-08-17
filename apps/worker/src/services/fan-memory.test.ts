import { describe, expect, test } from 'vitest';
import {
  detectNicknameRequest,
  extractRememberOffer,
  isMemoryConsent,
  isMemoryRejection,
  detectForgetRequest,
} from './fan-memory.js';

describe('detectNicknameRequest', () => {
  test('detects "〜って呼んで" pattern', () => {
    expect(detectNicknameRequest('たろちゃんって呼んで')).toBe('たろちゃん');
  });

  test('detects "〜と呼んで" pattern', () => {
    expect(detectNicknameRequest('たろうと呼んで')).toBe('たろう');
  });

  test('returns null when no nickname pattern present', () => {
    expect(detectNicknameRequest('こんにちは')).toBeNull();
    expect(detectNicknameRequest('ほんとに自分だってわかるんだ')).toBeNull();
  });

  test('returns null for empty captured group', () => {
    expect(detectNicknameRequest('って呼んで')).toBeNull();
  });

  test('trims surrounding whitespace', () => {
    expect(detectNicknameRequest(' たろちゃん って呼んで')).toBe('たろちゃん');
  });
});

describe('extractRememberOffer', () => {
  test('extracts fact and strips marker from display text', () => {
    const result = extractRememberOffer('覚えておいてもいいですか？[REMEMBER_OFFER: 来月に新曲をリリースする]');
    expect(result).toEqual({
      displayText: '覚えておいてもいいですか？',
      fact: '来月に新曲をリリースする',
    });
  });

  test('returns null when no marker present', () => {
    expect(extractRememberOffer('こんにちは')).toBeNull();
  });

  test('returns null for empty captured fact', () => {
    expect(extractRememberOffer('[REMEMBER_OFFER: ]')).toBeNull();
  });
});

describe('isMemoryConsent', () => {
  test('detects positive responses', () => {
    expect(isMemoryConsent('お願いします')).toBe(true);
    expect(isMemoryConsent('うん')).toBe(true);
    expect(isMemoryConsent('はい、覚えてください')).toBe(true);
  });

  test('rejects when negative words present even alongside positive-looking text', () => {
    expect(isMemoryConsent('いや、いいです')).toBe(false);
    expect(isMemoryConsent('覚えなくていいよ')).toBe(false);
  });

  test('returns false when neither positive nor negative', () => {
    expect(isMemoryConsent('明日は雨みたい')).toBe(false);
  });
});

describe('isMemoryRejection', () => {
  test('detects clear negative responses', () => {
    expect(isMemoryRejection('やめて')).toBe(true);
    expect(isMemoryRejection('いいえ')).toBe(true);
  });

  test('does not treat positive responses as rejection', () => {
    expect(isMemoryRejection('うん、お願い')).toBe(false);
  });

  test('returns false for unrelated text', () => {
    expect(isMemoryRejection('明日は晴れるかな')).toBe(false);
  });
});

describe('detectForgetRequest', () => {
  test('detects "忘れて"', () => {
    expect(detectForgetRequest('その話、忘れて')).toBe(true);
  });

  test('detects "覚えなくていい"', () => {
    expect(detectForgetRequest('もう覚えなくていいよ')).toBe(true);
  });

  test('returns false for unrelated text', () => {
    expect(detectForgetRequest('こんにちは')).toBe(false);
  });
});
