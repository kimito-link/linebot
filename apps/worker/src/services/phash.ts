/**
 * 知覚ハッシュ（dHash、差分ハッシュ）— Tier 0.5の実験実装（2026-07-21）。
 *
 * 目的: LINEの再エンコードでSHA-256完全一致（Tier 0）が失敗する問題に対し、
 * AI（Gemini/Groq）を一切使わずに「送られてきた動画のサムネイルが、Bot自身の
 * 動画のサムネイルと近似一致するか」を決定的に判定する。動画本体ではなく、
 * LINEのプレビュー画像API（/content/preview、JPEG静止画）を対象とする。
 *
 * アルゴリズム: 9x8グレースケールに縮小し、隣接ピクセルの明暗比較で64bitを作る。
 * pHash（DCT）と比べて実装が単純（純JS、依存はJPEGデコードのみ）で、
 * リサイズ・軽微な再圧縮に強い。回転・切り抜き耐性は無いが今回の用途では不要。
 *
 * 較正前の暫定実装。実機で同一動画間(intra)と異キャラ間(inter)の距離を
 * 観測してから閾値を決める（Fable設計書 Phase C 参照）。
 */

import { decode as decodeJpeg } from 'jpeg-js';

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

/** JPEGバイト列から64bit dHashを16進文字列（16文字）で返す。デコード失敗はnull。 */
export function computeDHash(jpegBytes: ArrayBuffer): string | null {
  let decoded: { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
  try {
    decoded = decodeJpeg(new Uint8Array(jpegBytes), { useTArray: true });
  } catch (err) {
    console.warn('[phash] jpeg decode failed', err instanceof Error ? err.message : String(err));
    return null;
  }

  const gray = resizeToGrayscale(decoded, HASH_WIDTH, HASH_HEIGHT);

  let bits = '';
  let nibble = 0;
  let bitCount = 0;
  for (let y = 0; y < HASH_HEIGHT; y++) {
    for (let x = 0; x < HASH_WIDTH - 1; x++) {
      const left = gray[y * HASH_WIDTH + x];
      const right = gray[y * HASH_WIDTH + x + 1];
      const bit = left > right ? 1 : 0;
      nibble = (nibble << 1) | bit;
      bitCount++;
      if (bitCount === 4) {
        bits += nibble.toString(16);
        nibble = 0;
        bitCount = 0;
      }
    }
  }
  return bits;
}

/**
 * RGBA(またはRGB)ピクセル配列を面積平均法で targetW x targetH のグレースケールに縮小する。
 * ffmpeg等の高品質リサイズではないが、64bit程度の粗いハッシュ用途には十分。
 */
function resizeToGrayscale(
  src: { width: number; height: number; data: Uint8Array | Uint8ClampedArray },
  targetW: number,
  targetH: number,
): Float64Array {
  const { width: srcW, height: srcH, data } = src;
  const channels = data.length / (srcW * srcH);
  const out = new Float64Array(targetW * targetH);

  for (let ty = 0; ty < targetH; ty++) {
    const y0 = Math.floor((ty * srcH) / targetH);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * srcH) / targetH));
    for (let tx = 0; tx < targetW; tx++) {
      const x0 = Math.floor((tx * srcW) / targetW);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * srcW) / targetW));

      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const idx = (sy * srcW + sx) * channels;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          count++;
        }
      }
      out[ty * targetW + tx] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** 2つの64bit hex dHash間のハミング距離（0〜64）。片方null/長さ不一致ならInfinity。 */
export function hammingDistance(a: string | null, b: string | null): number {
  if (!a || !b || a.length !== b.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    distance += popcount4(diff);
  }
  return distance;
}

function popcount4(nibble: number): number {
  let n = nibble;
  let count = 0;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}

/**
 * intra-class(同一キャラ、LINE再エンコード込み)実測: 距離2〜8。
 * inter-class(別キャラ)実測: 距離18〜28。ギャップ10あり(2026-07-21実機検証、
 * _docs/HANDOFF-RESUME-2026-07-21.md参照)。保守的に閾値10を採用し、
 * 迷ったら不一致(Tier 1のGeminiへfail-open)扱いにする。
 */
export const PHASH_MATCH_THRESHOLD = 10;

export interface PhashRow {
  phash: string;
  character: 'りんく' | 'こん太' | 'たぬ姉';
}

export interface PhashMatchResult {
  character: 'りんく' | 'こん太' | 'たぬ姉';
  distance: number;
}

/**
 * 登録済みハッシュ群の中から最小距離のものを探す。閾値以下かつ
 * 唯一のキャラに絞れた場合のみマッチとする（複数キャラが同着最小距離の
 * 場合はfail-open、誤って自己/仲間言及をさせない）。
 */
export function findClosestPhashMatch(target: string, registered: PhashRow[]): PhashMatchResult | null {
  let best: PhashMatchResult | null = null;
  let bestIsUnique = true;
  for (const row of registered) {
    const distance = hammingDistance(target, row.phash);
    if (best === null || distance < best.distance) {
      best = { character: row.character, distance };
      bestIsUnique = true;
    } else if (distance === best.distance && row.character !== best.character) {
      bestIsUnique = false;
    }
  }
  if (!best || best.distance > PHASH_MATCH_THRESHOLD || !bestIsUnique) return null;
  return best;
}
