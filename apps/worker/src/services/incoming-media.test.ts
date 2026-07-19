import { describe, test, expect, vi } from 'vitest';
import { fetchAndStoreIncomingMedia } from './incoming-media.js';

function makeR2Stub() {
  const store = new Map<string, { data: ArrayBuffer; contentType: string }>();
  return {
    put: vi.fn(async (key: string, data: ArrayBuffer, opts: { httpMetadata?: { contentType?: string } }) => {
      store.set(key, { data, contentType: opts.httpMetadata?.contentType ?? '' });
      return null;
    }),
    _store: store,
  };
}

// transcoding状態確認→本体取得の2段fetchを模したモック。
// url に /content/transcoding が含まれるかで呼び分ける。
function makeTranscodingAwareFetch(status: 'succeeded' | 'processing' | 'failed', contentType: string, bodySize = 100) {
  let processingCallCount = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/content/transcoding')) {
      if (status === 'processing') {
        processingCallCount++;
        // 2回目の問い合わせでsucceededに遷移する（ポーリングが機能することを確認）。
        return new Response(JSON.stringify({ status: processingCallCount >= 2 ? 'succeeded' : 'processing' }), { status: 200 });
      }
      return new Response(JSON.stringify({ status }), { status: 200 });
    }
    return new Response(new ArrayBuffer(bodySize), { status: 200, headers: { 'Content-Type': contentType } });
  });
}

describe('fetchAndStoreIncomingMedia (video)', () => {
  test('Content API 成功時に R2 PUT して URL を返す', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(100), {
        status: 200,
        headers: { 'Content-Type': 'video/mp4' },
      }),
    );

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-xyz',
      kind: 'video',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-xyz/content',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } }),
    );
    expect(r2.put).toHaveBeenCalled();
    const [key, , opts] = r2.put.mock.calls[0];
    expect(key).toBe('incoming-acc-1-msg-xyz.mp4');
    expect(opts.httpMetadata?.contentType).toBe('video/mp4');
    expect(result.refs?.originalContentUrl).toBe('https://worker.example.com/images/incoming-acc-1-msg-xyz.mp4');
    expect(result.refs?.contentType).toBe('video/mp4');
    expect(result.refs?.bytes.byteLength).toBe(100);
    expect(result.failureReason).toBeNull();
  });

  test('未対応のcontent-typeはrefs=nullかつfailureReasonに実測値を含む', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), { status: 200, headers: { 'Content-Type': 'video/unknown' } }),
    );

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-y',
      kind: 'video',
    });

    expect(result.refs).toBeNull();
    expect(result.failureReason).toBe('unsupported content-type: video/unknown');
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('transcoding=succeeded なら即座に本体を取得する', async () => {
    const r2 = makeR2Stub();
    const fetchMock = makeTranscodingAwareFetch('succeeded', 'video/mp4');

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-succeeded',
      kind: 'video',
    });

    expect(result.refs?.contentType).toBe('video/mp4');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-data.line.me/v2/bot/message/msg-succeeded/content/transcoding',
      expect.anything(),
    );
  });

  test('transcoding=processing はポーリングして succeeded になったら本体を取得する', async () => {
    const r2 = makeR2Stub();
    const fetchMock = makeTranscodingAwareFetch('processing', 'video/mp4');

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-processing',
      kind: 'video',
    });

    expect(result.refs?.contentType).toBe('video/mp4');
    // transcoding確認が2回(processing→succeeded)+本体取得1回=3回呼ばれる。
    const transcodingCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/content/transcoding'));
    expect(transcodingCalls.length).toBe(2);
  }, 10000);

  test('transcoding=failed は本体取得を試みずrefs=null', async () => {
    const r2 = makeR2Stub();
    const fetchMock = makeTranscodingAwareFetch('failed', 'video/mp4');

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-failed',
      kind: 'video',
    });

    expect(result.refs).toBeNull();
    expect(result.failureReason).toBe('transcoding failed');
    expect(r2.put).not.toHaveBeenCalled();
    // 本体取得(GET .../content 、transcodingで終わらないURL)は呼ばれていないこと。
    const contentCalls = fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith('/content/transcoding'));
    expect(contentCalls.length).toBe(0);
  });
});

describe('fetchAndStoreIncomingMedia (audio)', () => {
  test('Content-Type から拡張子を判定 (m4a)', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), { status: 200, headers: { 'Content-Type': 'audio/mp4' } }),
    );

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'a',
      messageId: 'm-m4a',
      kind: 'audio',
    });

    const [key] = r2.put.mock.calls[0];
    expect(key).toBe('incoming-a-m-m4a.m4a');
    expect(result.refs?.contentType).toBe('audio/mp4');
  });

  test('Content API が非 200 を返したらrefs=nullかつfailureReasonにHTTPステータスを含む', async () => {
    const r2 = makeR2Stub();
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-bad',
      accountId: 'acc-1',
      messageId: 'msg-y',
      kind: 'audio',
    });

    expect(result.refs).toBeNull();
    expect(result.failureReason).toBe('content fetch HTTP 401');
    expect(r2.put).not.toHaveBeenCalled();
  });

  test('R2 PUT が throw したらrefs=null', async () => {
    const r2 = makeR2Stub();
    r2.put.mockRejectedValueOnce(new Error('R2 down'));
    const fetchMock = vi.fn(async () =>
      new Response(new ArrayBuffer(50), { status: 200, headers: { 'Content-Type': 'audio/wav' } }),
    );

    const result = await fetchAndStoreIncomingMedia({
      r2: r2 as unknown as R2Bucket,
      fetch: fetchMock,
      workerUrl: 'https://worker.example.com',
      channelAccessToken: 'token-abc',
      accountId: 'acc-1',
      messageId: 'msg-z',
      kind: 'audio',
    });

    expect(result.refs).toBeNull();
    expect(result.failureReason).toBe('R2 put threw');
  });
});
