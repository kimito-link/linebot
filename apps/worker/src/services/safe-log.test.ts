import { describe, it, expect } from 'vitest';
import { redactForLog, readBodyForLog } from './safe-log.js';

// マスクは「効いているつもり」が一番危ない。
// 実際に漏れうる形を並べて、伏せられることを固定する。

describe('redactForLog — 秘密を伏せる', () => {
  it('JSONのclient_secretを伏せる', () => {
    const body = '{"error":"invalid_request","client_secret":"abcdef1234567890"}';
    const out = redactForLog(body);
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('invalid_request'); // 原因は読めたままにする
  });

  it('キャメルケースのchannelSecretも伏せる', () => {
    const out = redactForLog('{"channelSecret":"s3cr3tvalue12345"}');
    expect(out).not.toContain('s3cr3tvalue12345');
  });

  it('access_token / id_token を伏せる', () => {
    const body = '{"access_token":"tok_live_abcdefghijk","id_token":"idtok_zzzzzzzzzz"}';
    const out = redactForLog(body);
    expect(out).not.toContain('tok_live_abcdefghijk');
    expect(out).not.toContain('idtok_zzzzzzzzzz');
  });

  it('クエリ文字列形式のclient_secretを伏せる', () => {
    const body = 'grant_type=authorization_code&client_secret=verysecretvalue123&code=xyz';
    const out = redactForLog(body);
    expect(out).not.toContain('verysecretvalue123');
    expect(out).toContain('grant_type=authorization_code'); // 秘密でないものは残す
  });

  it('裸のBearerトークンを伏せる', () => {
    const out = redactForLog('missing scope for Bearer sk-ant-api03-XXXXXXXXXXXX');
    expect(out).not.toContain('sk-ant-api03-XXXXXXXXXXXX');
  });

  it('JWTらしき文字列を伏せる', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    const out = redactForLog(`{"detail":"bad token ${jwt}"}`);
    expect(out).not.toContain(jwt);
  });

  it('★こちらが送った秘密が反射されても消す（キー名に頼らない）', () => {
    const secret = 'my-channel-secret-value-9999';
    // キー名が秘密らしくない形で返されるのが最も危ない
    const body = `{"message":"invalid parameter: ${secret}","field":"foo"}`;
    const out = redactForLog(body, [secret]);
    expect(out).not.toContain(secret);
    expect(out).toContain('invalid parameter'); // 何が悪いかは残る
  });

  it('短すぎる値では誤爆しない（extraに短い文字列が来ても壊さない）', () => {
    const out = redactForLog('{"error":"code is required"}', ['code']);
    expect(out).toContain('code is required');
  });

  it('秘密でないフィールドは読めるまま残す', () => {
    const body = '{"error":"invalid_grant","error_description":"code expired","status":400}';
    const out = redactForLog(body);
    expect(out).toContain('invalid_grant');
    expect(out).toContain('code expired');
    expect(out).toContain('400');
  });

  it('長すぎる本文は切り詰める（1行でログを埋めない）', () => {
    const out = redactForLog('x'.repeat(5000));
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain('切り詰め');
  });

  it('空文字・undefined混じりでも落ちない', () => {
    expect(redactForLog('')).toBe('');
    expect(() => redactForLog('{"a":1}', [undefined, ''])).not.toThrow();
  });

  it('マスク後も「どの鍵か」の見当はつく（調査できる形を保つ）', () => {
    const out = redactForLog('{"client_secret":"abcdefgh12345678"}');
    expect(out).toContain('abcd'); // 先頭は残す
    expect(out).not.toContain('abcdefgh12345678');
  });
});

describe('readBodyForLog — 本文の読み出し', () => {
  it('レスポンス本文を伏せて返す', async () => {
    const res = new Response('{"client_secret":"topsecretvalue123"}');
    const out = await readBodyForLog(res);
    expect(out).not.toContain('topsecretvalue123');
  });

  it('★本文を読めなくても例外を投げない（ログ出力で落ちるのが一番困る）', async () => {
    const broken = {
      text: () => Promise.reject(new Error('stream already consumed')),
    } as unknown as Response;
    await expect(readBodyForLog(broken)).resolves.toBe('(本文を読めなかった)');
  });
});
