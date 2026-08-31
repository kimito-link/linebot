import { describe, it, expect, vi, afterEach } from 'vitest';
import { callGroq } from './llm-providers.js';

// 単体テスト(safe-log.test.ts)が緑でも、**配線先が違えば漏れる**。
// 実際に safe-log.test.ts が全通過している状態で、この経路を通したら
// 秘密が素通りしていた（"message" という秘密らしくないキー名に埋まっていたため）。
// だから経路そのものを通して確かめる。
describe('配線の実地確認 — LLMのエラー本文がログに漏れない', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function run(secret: string, message: string) {
    const logged: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a) => { logged.push(a.map(String).join(' ')); });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: 'authentication_error', message } }), { status: 401 })));
    await callGroq(secret, 'llama-x', {
      systemPrompt: 's', messages: [], incomingText: 'u', maxOutputTokens: 100, timeoutMs: 5000,
    });
    return logged.join('\n');
  }

  it('★秘密らしくないキー名(message)に埋まった鍵も漏れない', async () => {
    const SECRET = 'gsk_LEAKEDSECRETVALUE1234567890';
    const all = await run(SECRET, `invalid api key: ${SECRET}`);
    expect(all).not.toContain(SECRET);
    expect(all).toContain('authentication_error'); // 原因は読めたまま
  });

  it('★接頭辞が未知の鍵でも、呼び出し側が渡していれば消える', async () => {
    const SECRET = 'totally-custom-key-format-99999';
    const all = await run(SECRET, `bad credentials: ${SECRET}`);
    expect(all).not.toContain(SECRET);
  });

  it('★形だけでも消える（extraに渡し忘れた場合の保険）', async () => {
    // 呼び出しに使う鍵とは別の鍵が本文に現れるケース
    const OTHER = 'sk-ant-api03-SOMEONEELSES-KEY-9999';
    const all = await run('unrelated-key-value-000', `see also ${OTHER}`);
    expect(all).not.toContain(OTHER);
  });
});
