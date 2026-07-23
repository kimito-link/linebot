import { describe, expect, test } from 'vitest';
import { detectNicknameRequest } from './fan-memory.js';

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
