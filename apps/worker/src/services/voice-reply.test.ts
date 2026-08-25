import { describe, test, expect, vi } from 'vitest';
import {
  replyWithVoice,
  createSynthesizer,
  estimateDurationMs,
  CHARACTER_SPEAKER_ID,
  type VoiceSynthesizer,
} from './voice-reply.js';

type SentMessages = Array<Record<string, unknown>>;

function makeLineClientStub() {
  return {
    replyMessage: vi.fn(async (_token: string, _messages: SentMessages) => ({})),
    pushMessage: vi.fn(async (_to: string, _messages: SentMessages) => ({})),
  };
}

function makeR2Stub() {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  return {
    put: vi.fn(async (key: string, data: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { data, contentType: opts?.httpMetadata?.contentType ?? '' });
      return null;
    }),
    _store: store,
  };
}

/** 常に成功する合成役。 */
function okSynthesizer(durationMs = 3000): VoiceSynthesizer {
  return {
    name: 'stub-ok',
    synthesize: vi.fn(async () => ({ m4a: new ArrayBuffer(128), durationMs })),
  };
}

/** 常に失敗する（nullを返す）合成役。 */
function ngSynthesizer(): VoiceSynthesizer {
  return {
    name: 'stub-ng',
    synthesize: vi.fn(async () => null),
  };
}

function baseParams(overrides: Record<string, unknown> = {}) {
  return {
    lineClient: makeLineClientStub() as never,
    replyToken: 'token-1',
    lineUserId: 'U123',
    text: 'それ、気にしすぎな気がするわ。',
    character: 'tanunee' as const,
    synthesizer: okSynthesizer(),
    r2: makeR2Stub() as never,
    workerUrl: 'https://worker.example.workers.dev',
    accountId: 'acct-1',
    receivedAt: Date.now(),
    replyTokenConsumed: false,
    ...overrides,
  };
}

describe('replyWithVoice — 音声で返せるとき', () => {
  test('音声とテキストの両方を送る（音声のみにしない）', async () => {
    const lineClient = makeLineClientStub();
    const r2 = makeR2Stub();
    const params = baseParams({ lineClient: lineClient as never, r2: r2 as never });

    const result = await replyWithVoice(params as never);

    expect(result.sentAsVoice).toBe(true);
    expect(lineClient.replyMessage).toHaveBeenCalledTimes(1);
    const messages = lineClient.replyMessage.mock.calls[0][1];
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ type: 'audio', duration: 3000 });
    expect(messages[1]).toMatchObject({ type: 'text', text: params.text });
  });

  test('R2にaudio/mp4として保存し、/images/配信URLを渡す', async () => {
    const lineClient = makeLineClientStub();
    const r2 = makeR2Stub();
    await replyWithVoice(baseParams({ lineClient: lineClient as never, r2: r2 as never }) as never);

    expect(r2.put).toHaveBeenCalledTimes(1);
    const [key, , opts] = r2.put.mock.calls[0];
    expect(key).toMatch(/^voice-acct-1-[0-9a-f-]+\.m4a$/);
    expect(opts?.httpMetadata?.contentType).toBe('audio/mp4');

    const messages = lineClient.replyMessage.mock.calls[0][1];
    // 既存の GET /images/:key に相乗りする。:key はスラッシュを含められないので
    // キーがフラットであることが送信URLの前提になっている。
    expect(messages[0].originalContentUrl).toBe(
      `https://worker.example.workers.dev/images/${key}`,
    );
  });

  test('キャラクターに対応する話者IDで合成する', async () => {
    const synth = okSynthesizer();
    await replyWithVoice(baseParams({ synthesizer: synth, character: 'konta' }) as never);
    expect(synth.synthesize).toHaveBeenCalledWith(expect.any(String), CHARACTER_SPEAKER_ID.konta);
  });
});

describe('replyWithVoice — 無言にしないこと', () => {
  test('合成が失敗したらテキストで返す', async () => {
    const lineClient = makeLineClientStub();
    const result = await replyWithVoice(
      baseParams({ lineClient: lineClient as never, synthesizer: ngSynthesizer() }) as never,
    );

    expect(result.sentAsVoice).toBe(false);
    const messages = lineClient.replyMessage.mock.calls[0][1];
    expect(messages).toEqual([{ type: 'text', text: 'それ、気にしすぎな気がするわ。' }]);
  });

  test('合成役が未設定でもテキストで返す', async () => {
    const lineClient = makeLineClientStub();
    const result = await replyWithVoice(
      baseParams({ lineClient: lineClient as never, synthesizer: null }) as never,
    );

    expect(result.sentAsVoice).toBe(false);
    expect(lineClient.replyMessage).toHaveBeenCalledTimes(1);
  });

  test('R2が未設定でもテキストで返す', async () => {
    const lineClient = makeLineClientStub();
    const result = await replyWithVoice(
      baseParams({ lineClient: lineClient as never, r2: undefined }) as never,
    );

    expect(result.sentAsVoice).toBe(false);
    expect(lineClient.replyMessage).toHaveBeenCalledTimes(1);
  });

  test('R2への保存が失敗してもテキストで返す', async () => {
    const lineClient = makeLineClientStub();
    const r2 = { put: vi.fn(async () => { throw new Error('R2 down'); }) };
    const result = await replyWithVoice(
      baseParams({ lineClient: lineClient as never, r2: r2 as never }) as never,
    );

    expect(result.sentAsVoice).toBe(false);
    const messages = lineClient.replyMessage.mock.calls[0][1];
    expect(messages).toEqual([{ type: 'text', text: 'それ、気にしすぎな気がするわ。' }]);
  });

  test('合成役が例外を投げてもテキストで返す（例外を外に漏らさない）', async () => {
    const lineClient = makeLineClientStub();
    const throwing: VoiceSynthesizer = {
      name: 'stub-throw',
      synthesize: vi.fn(async () => { throw new Error('boom'); }),
    };
    // synthesizeの例外はHTTP実装側で握るのが約束だが、自前実装が破った場合でも
    // 呼び出し側を巻き込まないことを確認する。
    await expect(
      replyWithVoice(baseParams({ lineClient: lineClient as never, synthesizer: throwing }) as never),
    ).rejects.toThrow();
  });
});

describe('replyWithVoice — replyToken失効時', () => {
  test('replyMessageが失敗したらpushMessageで送る', async () => {
    const lineClient = makeLineClientStub();
    lineClient.replyMessage.mockRejectedValueOnce(new Error('Invalid reply token'));

    const result = await replyWithVoice(baseParams({ lineClient: lineClient as never }) as never);

    expect(result.usedReplyToken).toBe(false);
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
    const messages = lineClient.pushMessage.mock.calls[0][1];
    expect(messages[0]).toMatchObject({ type: 'audio' });
  });

  test('45秒を過ぎていたらreplyMessageを試さずpushMessageで送る', async () => {
    const lineClient = makeLineClientStub();
    const result = await replyWithVoice(
      baseParams({ lineClient: lineClient as never, receivedAt: Date.now() - 60_000 }) as never,
    );

    expect(result.usedReplyToken).toBe(false);
    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
  });

  test('replyTokenが消費済みならpushMessageで送る', async () => {
    const lineClient = makeLineClientStub();
    await replyWithVoice(
      baseParams({ lineClient: lineClient as never, replyTokenConsumed: true }) as never,
    );

    expect(lineClient.replyMessage).not.toHaveBeenCalled();
    expect(lineClient.pushMessage).toHaveBeenCalledTimes(1);
  });
});

describe('createSynthesizer', () => {
  test('未設定ならnull（音声機能オフとして静かに無効化される）', () => {
    expect(createSynthesizer({})).toBeNull();
    expect(createSynthesizer({ VOICE_SYNTH_ENDPOINT: 'https://x.example' })).toBeNull();
    expect(createSynthesizer({ VOICE_SYNTH_TOKEN: 'secret' })).toBeNull();
  });

  test('両方設定されていれば合成役を返す', () => {
    const synth = createSynthesizer({
      VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
      VOICE_SYNTH_TOKEN: 'secret',
    });
    expect(synth).not.toBeNull();
    expect(synth?.name).toBe('http');
  });
});

describe('HttpVoiceSynthesizer 経由の合成', () => {
  function withFetch(handler: typeof fetch) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    return () => { globalThis.fetch = original; };
  }

  test('m4aとX-Duration-Msを受け取る', async () => {
    const restore = withFetch(vi.fn(async () =>
      new Response(new ArrayBuffer(64), {
        status: 200,
        headers: { 'Content-Type': 'audio/mp4', 'X-Duration-Ms': '4200' },
      }),
    ) as never);
    try {
      const synth = createSynthesizer({
        VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
        VOICE_SYNTH_TOKEN: 'secret',
      })!;
      const result = await synth.synthesize('こんにちは', 14);
      expect(result?.durationMs).toBe(4200);
      expect(result?.m4a.byteLength).toBe(64);
    } finally {
      restore();
    }
  });

  test('X-Duration-Msが無ければ推定値を使う', async () => {
    const restore = withFetch(vi.fn(async () =>
      new Response(new ArrayBuffer(64), { status: 200, headers: { 'Content-Type': 'audio/mp4' } }),
    ) as never);
    try {
      const synth = createSynthesizer({
        VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
        VOICE_SYNTH_TOKEN: 'secret',
      })!;
      const result = await synth.synthesize('あいうえおかきくけこ', 14); // 10文字
      expect(result?.durationMs).toBe(estimateDurationMs('あいうえおかきくけこ'));
    } finally {
      restore();
    }
  });

  test('非OKレスポンスならnullを返す（例外を投げない）', async () => {
    const restore = withFetch(vi.fn(async () => new Response('err', { status: 500 })) as never);
    try {
      const synth = createSynthesizer({
        VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
        VOICE_SYNTH_TOKEN: 'secret',
      })!;
      expect(await synth.synthesize('こんにちは', 14)).toBeNull();
    } finally {
      restore();
    }
  });

  test('空のレスポンスならnullを返す', async () => {
    const restore = withFetch(vi.fn(async () =>
      new Response(new ArrayBuffer(0), { status: 200, headers: { 'Content-Type': 'audio/mp4' } }),
    ) as never);
    try {
      const synth = createSynthesizer({
        VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
        VOICE_SYNTH_TOKEN: 'secret',
      })!;
      expect(await synth.synthesize('こんにちは', 14)).toBeNull();
    } finally {
      restore();
    }
  });

  test('ネットワーク例外でもnullを返す（呼び出し側を巻き込まない）', async () => {
    const restore = withFetch(vi.fn(async () => { throw new Error('network down'); }) as never);
    try {
      const synth = createSynthesizer({
        VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
        VOICE_SYNTH_TOKEN: 'secret',
      })!;
      expect(await synth.synthesize('こんにちは', 14)).toBeNull();
    } finally {
      restore();
    }
  });

  test('Bearerトークンを付けて送る（エンドポイントを無認証にしない）', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(new ArrayBuffer(64), { status: 200, headers: { 'X-Duration-Ms': '1000' } }),
    );
    const restore = withFetch(fetchMock as never);
    try {
      const synth = createSynthesizer({
        VOICE_SYNTH_ENDPOINT: 'https://x.example/tts',
        VOICE_SYNTH_TOKEN: 'secret',
      })!;
      await synth.synthesize('こんにちは', 14);
      const init = fetchMock.mock.calls[0][1]!;
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret');
      expect(JSON.parse(init.body as string)).toEqual({ text: 'こんにちは', speakerId: 14 });
    } finally {
      restore();
    }
  });
});

describe('estimateDurationMs', () => {
  test('文字数に比例し、最低でも1秒を返す', () => {
    expect(estimateDurationMs('あ')).toBe(1000);
    expect(estimateDurationMs('あ'.repeat(60))).toBe(10_000);
  });
});
