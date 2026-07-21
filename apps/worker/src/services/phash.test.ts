import { describe, expect, it } from 'vitest';
import { encode as encodeJpeg } from 'jpeg-js';
import { computeDHash, hammingDistance, findClosestPhashMatch, PHASH_MATCH_THRESHOLD, type PhashRow } from './phash.js';

/** width x height の単色/パターンJPEGを合成生成する（テスト用、実写真は使わない）。 */
function makeJpeg(width: number, height: number, pixelFn: (x: number, y: number) => [number, number, number]): ArrayBuffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  const encoded = encodeJpeg({ data, width, height }, 90);
  return encoded.data.buffer.slice(encoded.data.byteOffset, encoded.data.byteOffset + encoded.data.byteLength) as ArrayBuffer;
}

// 左半分が暗く右半分が明るい、縦方向のグラデーション画像。dHashが横方向の
// 明暗差分を拾えているかを確認する基本パターン。
function halfSplitImage(width: number, height: number): ArrayBuffer {
  return makeJpeg(width, height, (x) => (x < width / 2 ? [20, 20, 20] : [230, 230, 230]));
}

// 明暗を反転させた画像（左が明るく右が暗い）。
function invertedHalfSplitImage(width: number, height: number): ArrayBuffer {
  return makeJpeg(width, height, (x) => (x < width / 2 ? [230, 230, 230] : [20, 20, 20]));
}

function solidColorImage(width: number, height: number, gray: number): ArrayBuffer {
  return makeJpeg(width, height, () => [gray, gray, gray]);
}

describe('computeDHash', () => {
  it('returns a 16-character hex string for a valid JPEG', () => {
    const jpeg = halfSplitImage(64, 64);
    const hash = computeDHash(jpeg);
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns null for invalid/corrupt JPEG bytes', () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]).buffer;
    expect(computeDHash(garbage)).toBeNull();
  });

  it('produces the same hash for the same image (determinism)', () => {
    const jpeg = halfSplitImage(64, 64);
    const h1 = computeDHash(jpeg);
    const h2 = computeDHash(jpeg);
    expect(h1).toBe(h2);
  });

  it('produces similar hashes for the same image re-encoded at different quality (re-encode tolerance)', () => {
    const data = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const idx = (y * 64 + x) * 4;
        const v = x < 32 ? 20 : 230;
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
    const high = encodeJpeg({ data, width: 64, height: 64 }, 95);
    const low = encodeJpeg({ data, width: 64, height: 64 }, 40);
    const hashHigh = computeDHash(high.data.buffer.slice(high.data.byteOffset, high.data.byteOffset + high.data.byteLength) as ArrayBuffer);
    const hashLow = computeDHash(low.data.buffer.slice(low.data.byteOffset, low.data.byteOffset + low.data.byteLength) as ArrayBuffer);
    expect(hammingDistance(hashHigh, hashLow)).toBeLessThanOrEqual(4);
  });
});

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingDistance('abcd1234abcd1234', 'abcd1234abcd1234')).toBe(0);
  });

  it('returns Infinity when either hash is null', () => {
    expect(hammingDistance(null, 'abcd1234abcd1234')).toBe(Infinity);
    expect(hammingDistance('abcd1234abcd1234', null)).toBe(Infinity);
  });

  it('returns Infinity for mismatched lengths', () => {
    expect(hammingDistance('ab', 'abcd1234abcd1234')).toBe(Infinity);
  });

  it('returns a small distance for near-identical images (intra-class)', () => {
    const jpeg1 = solidColorImage(64, 64, 100);
    const jpeg2 = solidColorImage(64, 64, 105); // わずかな明度差
    const h1 = computeDHash(jpeg1);
    const h2 = computeDHash(jpeg2);
    expect(hammingDistance(h1, h2)).toBeLessThanOrEqual(4);
  });

  it('returns a large distance for clearly different images (inter-class)', () => {
    const jpeg1 = halfSplitImage(64, 64);
    const jpeg2 = invertedHalfSplitImage(64, 64);
    const h1 = computeDHash(jpeg1);
    const h2 = computeDHash(jpeg2);
    // dHashは「隣接ピクセル間の明暗比較」なので、単色ブロック内の隣接同士は
    // 反転しても差分ビットは変わらない。実際に反転するのは列境界をまたぐ
    // 8bit（縦8行）のみ（実測値: 16/64bit）。
    expect(hammingDistance(h1, h2)).toBeGreaterThanOrEqual(8);
  });

  it('separates intra-class distance from inter-class distance with a clear gap', () => {
    const original = solidColorImage(64, 64, 100);
    const reencoded = solidColorImage(64, 64, 103);
    const different = invertedHalfSplitImage(64, 64);

    const hOriginal = computeDHash(original);
    const hReencoded = computeDHash(reencoded);
    const hDifferent = computeDHash(different);

    const intraDistance = hammingDistance(hOriginal, hReencoded);
    const interDistance = hammingDistance(hOriginal, hDifferent);

    expect(intraDistance).toBeLessThan(interDistance);
  });
});

describe('findClosestPhashMatch', () => {
  // 2026-07-21実機検証で確認した実測値に基づく登録データ（migration 059相当）。
  const registered: PhashRow[] = [
    { phash: 'c6d4c8c48e96c442', character: 'たぬ姉' },
    { phash: 'd2f0eabc9e9e9e24', character: 'りんく' },
    { phash: '649290d8cade6824', character: 'こん太' },
  ];

  it('matches within threshold to the correct character', () => {
    // 実機実測: LINE経由たぬ姉プレビュー、距離2
    const lineObserved = 'd6d4c8c48e96c4c2';
    const result = findClosestPhashMatch(lineObserved, registered);
    expect(result).not.toBeNull();
    expect(result?.character).toBe('たぬ姉');
    expect(result?.distance).toBeLessThanOrEqual(PHASH_MATCH_THRESHOLD);
  });

  it('returns null when the closest match exceeds the threshold (unrelated video)', () => {
    // 全ビット反転 = 距離64、閾値を大きく超える
    const unrelated = registered[0].phash
      .split('')
      .map((c) => (0xf ^ parseInt(c, 16)).toString(16))
      .join('');
    const result = findClosestPhashMatch(unrelated, registered);
    expect(result).toBeNull();
  });

  it('returns null when two different characters tie at the same minimum distance (fail-open)', () => {
    const rowsForTie: PhashRow[] = [
      { phash: '0000000000000000', character: 'りんく' },
      { phash: '000000000000000f', character: 'こん太' },
    ];
    // target=...05: vs A(...00)は popcount(5)=2、vs B(...0f)は popcount(f^5=a)=2 → 同距離のtie
    const midpoint = '0000000000000005';
    const result = findClosestPhashMatch(midpoint, rowsForTie);
    expect(result).toBeNull();
  });

  it('returns null for empty registry', () => {
    expect(findClosestPhashMatch('c6d4c8c48e96c442', [])).toBeNull();
  });
});
