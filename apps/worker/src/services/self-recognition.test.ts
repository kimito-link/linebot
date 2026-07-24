import { describe, expect, it } from 'vitest';
import { matchSelfCharacter } from './self-recognition.js';

describe('matchSelfCharacter', () => {
  it('matches りんく with high confidence on real Gemini description text', () => {
    const result = matchSelfCharacter(
      '金髪でヘッドホンをつけ、オレンジのリボンをした可愛らしいキャラクターが、まばたきをしながら笑っています。',
    );
    expect(result).not.toBeNull();
    expect(result?.character).toBe('りんく');
    expect(result?.confidence).toBe('high');
  });

  it('matches りんく with probable confidence on headphones + blonde hair only', () => {
    const result = matchSelfCharacter('金髪でヘッドホンをつけたキャラクターが映っています。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('りんく');
    expect(result?.confidence).toBe('probable');
  });

  it('returns null for weak features only (orange ribbon on a cat)', () => {
    const result = matchSelfCharacter('オレンジのリボンをつけた猫が座っています。');
    expect(result).toBeNull();
  });

  it('matches こん太 on fox ears + orange hair', () => {
    const result = matchSelfCharacter('狐の耳とオレンジ色の髪を持つキャラクターが笑っています。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('こん太');
  });

  it('picks こん太 when りんく and こん太 both score (no tie, orange_hair is weight 2)', () => {
    // headphones(2)+blonde(1) for りんく = 3, fox(2)+orange_hair(2) for こん太 = 4 → こん太 wins
    const result = matchSelfCharacter('ヘッドホンをつけ金髪の狐がオレンジ色の髪をなびかせています。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('こん太');
  });

  it('returns null for unrelated description (landscape)', () => {
    const result = matchSelfCharacter('青い空と緑の山が広がる、静かな田園風景です。');
    expect(result).toBeNull();
  });

  it('handles NFKC normalization (fullwidth/halfwidth mixed)', () => {
    const result = matchSelfCharacter('金髪でヘッドホンをつけた、オレンジのリボンのキャラクターです。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('りんく');
  });

  it('matches こん太 on the actual Gemini paraphrase "猫のような耳" + orange hair (2026-07-20実機再現)', () => {
    const result = matchSelfCharacter(
      'オレンジ色の髪と猫のような耳がついたキャラクターの笑顔が、本当に愛らしいです！',
    );
    expect(result).not.toBeNull();
    expect(result?.character).toBe('こん太');
    expect(result?.confidence).toBe('high');
  });

  it('matches こん太 with probable confidence on "猫のような耳" alone (2026-07-24: cat-ear phrasing is こん太-specific, no longer shared with たぬ姉)', () => {
    const result = matchSelfCharacter('猫のような耳がついたキャラクターです。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('こん太');
    expect(result?.confidence).toBe('probable');
  });

  it('matches たぬ姉 with high confidence on "狸のような耳" alone (the word 狸 itself already carries the tanuki signal)', () => {
    const result = matchSelfCharacter('狸のような耳がついたキャラクターです。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('たぬ姉');
    expect(result?.confidence).toBe('high');
  });

  it('returns null for a real cat description (no "のような耳" paraphrase)', () => {
    const result = matchSelfCharacter('オレンジ色の猫が毛づくろいをしながら、耳をぴくぴくさせています。');
    expect(result).toBeNull();
  });

  it('matches たぬ姉 on kemomimi + brown hair', () => {
    const result = matchSelfCharacter('獣耳と茶色い髪を持つキャラクターがしっぽを揺らしています。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('たぬ姉');
  });

  it('matches こん太 on orange hair alone, no ear mention (2026-07-20実機再現: 耳に触れない描写)', () => {
    const result = matchSelfCharacter(
      'オレンジ色の髪と大きな黒い目が、本当に素敵なアクセントになっています！頬の赤みがかったチークが、本当に愛らしいです！',
    );
    expect(result).not.toBeNull();
    expect(result?.character).toBe('こん太');
    expect(result?.confidence).toBe('probable');
  });

  it('does not confuse りんく orange ribbon with こん太 orange hair', () => {
    const result = matchSelfCharacter('ヘッドホンをつけ金髪でオレンジのリボンをしたキャラクターが笑っています。');
    expect(result).not.toBeNull();
    expect(result?.character).toBe('りんく');
  });

  it('matches こん太 on the direct phrase "猫耳" (2026-07-24実機再現)', () => {
    const result = matchSelfCharacter(
      'わー！かわいいキャラクターですね！猫耳がとても可愛い！まばたきも繰り返していて、なんだか安心するような感じがしますね。穏やかな表情が素敵です！',
    );
    expect(result).not.toBeNull();
    expect(result?.character).toBe('こん太');
  });

  it('still returns null for a real cat with ears described separately (no "猫耳"/"猫のような耳" phrase)', () => {
    const result = matchSelfCharacter('オレンジ色の猫が毛づくろいをしながら、耳をぴくぴくさせています。');
    expect(result).toBeNull();
  });
});
