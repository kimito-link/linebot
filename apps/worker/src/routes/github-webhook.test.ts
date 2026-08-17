import { describe, it, expect } from 'vitest';
import { verifyGithubSignature } from './github-webhook';

/**
 * GitHub webhook の署名検証テスト。
 *
 * この検証が緩むと、外部から偽の承認カードを開発者のスマホへ送り込めてしまう
 * （＝人に承認ボタンを押させる経路が作れる）。**通るべきでないものが通らないか**を見る。
 */

const SECRET = 'whsec_test_1234567890';
const BODY = '{"action":"labeled","issue":{"number":1}}';

/** テスト用に正しい署名を作る（実装と同じ手順を、独立に書く） */
async function sign(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hex}`;
}

describe('verifyGithubSignature', () => {
  it('正しい署名を受理する', async () => {
    const sig = await sign(SECRET, BODY);
    expect(await verifyGithubSignature(SECRET, BODY, sig)).toBe(true);
  });

  it('シークレットが違えば拒否する', async () => {
    const sig = await sign('whsec_другой', BODY);
    expect(await verifyGithubSignature(SECRET, BODY, sig)).toBe(false);
  });

  it('★本文が1文字でも改ざんされていれば拒否する', async () => {
    const sig = await sign(SECRET, BODY);
    const tampered = BODY.replace('"number":1', '"number":2');
    expect(await verifyGithubSignature(SECRET, tampered, sig)).toBe(false);
  });

  it('sha256= 接頭辞が無ければ拒否する（sha1は受け付けない）', async () => {
    const sig = await sign(SECRET, BODY);
    const bare = sig.slice('sha256='.length);
    expect(await verifyGithubSignature(SECRET, BODY, bare)).toBe(false);
    expect(await verifyGithubSignature(SECRET, BODY, `sha1=${bare}`)).toBe(false);
  });

  it('ヘッダが空・欠落でも落ちずに拒否する', async () => {
    expect(await verifyGithubSignature(SECRET, BODY, '')).toBe(false);
    expect(await verifyGithubSignature(SECRET, BODY, 'sha256=')).toBe(false);
  });

  it('長さの違う署名を拒否する（比較で例外を出さない）', async () => {
    expect(await verifyGithubSignature(SECRET, BODY, 'sha256=abc')).toBe(false);
    expect(await verifyGithubSignature(SECRET, BODY, `sha256=${'0'.repeat(64)}`)).toBe(false);
  });

  it('空の本文でも一貫して検証できる', async () => {
    const sig = await sign(SECRET, '');
    expect(await verifyGithubSignature(SECRET, '', sig)).toBe(true);
    expect(await verifyGithubSignature(SECRET, 'x', sig)).toBe(false);
  });
});
