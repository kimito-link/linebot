import { describe, expect, test, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const lineClientMocks = vi.hoisted(() => ({
  getProfile: vi.fn(),
  replyMessage: vi.fn(),
  pushMessage: vi.fn(),
}));

// Stub the DB graph — these tests focus on webhook guard behavior and the
// first-contact friend registration path without touching real D1/LINE.
vi.mock('@line-crm/db', () => ({
  upsertFriend: vi.fn(),
  updateFriendFollowStatus: vi.fn(),
  getFriendByLineUserId: vi.fn(),
  getScenarios: vi.fn(),
  enrollFriendInScenario: vi.fn(),
  getScenarioSteps: vi.fn(),
  advanceFriendScenario: vi.fn(),
  completeFriendScenario: vi.fn(),
  upsertChatOnMessage: vi.fn(),
  getLineAccounts: vi.fn().mockResolvedValue([]),
  jstNow: vi.fn(),
  computeNextDeliveryAt: vi.fn(),
  resolveStepContent: vi.fn(),
  addTagToFriend: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getMessageTemplateById: vi.fn(),
  getTemplateById: vi.fn(),
}));

vi.mock('@line-crm/line-sdk', async () => {
  const actual = await vi.importActual<typeof import('@line-crm/line-sdk')>('@line-crm/line-sdk');
  return {
    ...actual,
    verifySignature: vi.fn(),
    LineClient: vi.fn().mockImplementation(() => lineClientMocks),
  };
});

vi.mock('../services/event-bus.js', () => ({
  fireEvent: vi.fn().mockResolvedValue(undefined),
  logOutgoingMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/local-line-proxy.js', () => ({
  dispatchLineProxyLocally: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
}));

vi.mock('../services/step-delivery.js', () => ({
  buildMessage: vi.fn(),
  expandVariables: vi.fn(),
  resolveMetadata: vi.fn(),
  messageToLogPayload: vi.fn(),
}));

const fetchAndStoreIncomingImageMock = vi.fn();
vi.mock('../services/incoming-image.js', () => ({
  fetchAndStoreIncomingImage: (...args: unknown[]) => fetchAndStoreIncomingImageMock(...args),
}));

const describeImageMock = vi.fn();
vi.mock('../services/vision-describe.js', () => ({
  describeImage: (...args: unknown[]) => describeImageMock(...args),
}));

const runGroqSupportPipelineMock = vi.fn();
vi.mock('../services/groq-pipeline.js', () => ({
  runGroqSupportPipeline: (...args: unknown[]) => runGroqSupportPipelineMock(...args),
}));

const getGroqReplyConfigMock = vi.fn();
const buildGroqHistoryMock = vi.fn().mockResolvedValue([]);
vi.mock('../services/groq-reply.js', () => ({
  ESCALATION_MARKER: '[ESCALATE]',
  getGroqReplyConfig: (...args: unknown[]) => getGroqReplyConfigMock(...args),
  buildGroqHistory: (...args: unknown[]) => buildGroqHistoryMock(...args),
}));

const isGroqBudgetExceededMock = vi.fn();
vi.mock('../services/kb-search.js', () => ({
  isGroqBudgetExceeded: (...args: unknown[]) => isGroqBudgetExceededMock(...args),
}));

const botConfigMock = vi.fn();
vi.mock('../services/groq-config.js', () => ({
  getBotConfig: () => botConfigMock(),
}));

const extractFirstUrlMock = vi.fn();
const fetchUrlContextMock = vi.fn();
vi.mock('../services/url-context.js', () => ({
  extractFirstUrl: (...args: unknown[]) => extractFirstUrlMock(...args),
  fetchUrlContext: (...args: unknown[]) => fetchUrlContextMock(...args),
}));

vi.mock('../services/bot-project.js', () => ({
  resolveBotProject: vi.fn().mockResolvedValue('ai-shain-link'),
}));

const fetchAndStoreIncomingMediaMock = vi.fn();
// fetchIncomingMediaPreview も出しておく（動画のpHash判定が呼ぶ）。
// 出し忘れると「No export is defined」で実際とは違う経路に落ち、
// テストは通るのに実装を検証できていない状態になる。
const fetchIncomingMediaPreviewMock = vi.fn().mockResolvedValue(null);
vi.mock('../services/incoming-media.js', () => ({
  fetchAndStoreIncomingMedia: (...args: unknown[]) => fetchAndStoreIncomingMediaMock(...args),
  fetchIncomingMediaPreview: (...args: unknown[]) => fetchIncomingMediaPreviewMock(...args),
}));

const describeAudioMock = vi.fn();
const describeVideoMock = vi.fn();
vi.mock('../services/media-describe.js', () => ({
  describeAudio: (...args: unknown[]) => describeAudioMock(...args),
  describeVideo: (...args: unknown[]) => describeVideoMock(...args),
}));

// 音声合成そのものはvoice-reply.test.tsが担当するので、ここでは
// 「webhookが音声分岐に入り、合成役を渡しているか」だけを見る。
const createSynthesizerMock = vi.fn();
const replyWithVoiceMock = vi.fn();
vi.mock('../services/voice-reply.js', async () => {
  const actual = await vi.importActual<typeof import('../services/voice-reply.js')>(
    '../services/voice-reply.js',
  );
  return {
    ...actual,
    createSynthesizer: (...args: unknown[]) => createSynthesizerMock(...args),
    replyWithVoice: (...args: unknown[]) => replyWithVoiceMock(...args),
  };
});

import { verifySignature } from '@line-crm/line-sdk';
import {
  addTagToFriend,
  advanceFriendScenario,
  completeFriendScenario,
  computeNextDeliveryAt,
  enrollFriendInScenario,
  getEntryRouteByRefCode,
  getFriendByLineUserId,
  getLineAccounts,
  getMessageTemplateById,
  getScenarioSteps,
  getScenarios,
  jstNow,
  resolveStepContent,
  updateFriendFollowStatus,
  upsertChatOnMessage,
  upsertFriend,
} from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { webhook } from './webhook.js';

function setupApp() {
  const app = new Hono();
  app.route('/', webhook);
  return app;
}

const baseEnv = {
  DB: {} as D1Database,
  LINE_CHANNEL_SECRET: 'env-default-secret',
  LINE_CHANNEL_ACCESS_TOKEN: 'env-default-token',
} as Record<string, unknown>;

const baseExecutionCtx = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
  props: {},
} as unknown as ExecutionContext;

const DEFAULT_BOT_CONFIG = {
  llm: { vision: { enabled: false, chain: [], maxDescriptionTokens: 250 } },
  urlContext: { enabled: false, timeoutMs: 6000, maxContentBytes: 524288, maxExtractChars: 2000 },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getLineAccounts).mockResolvedValue([]);
  botConfigMock.mockReturnValue(DEFAULT_BOT_CONFIG);
  buildGroqHistoryMock.mockResolvedValue([]);
});

describe('POST /webhook — DoS defenses (#104)', () => {
  test('rejects with 413 when Content-Length declares an oversized body', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(2 * 1024 * 1024), // 2 MiB > 1 MiB cap
          'X-Line-Signature': 'whatever',
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    // Signature verification must not even be attempted on an oversized body.
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('rejects with 413 when actual body exceeds the cap even if Content-Length is absent', async () => {
    const app = setupApp();
    const oversizedBody = 'x'.repeat(1024 * 1024 + 1);
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'whatever',
        },
        body: oversizedBody,
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(413);
    expect(verifySignature).not.toHaveBeenCalled();
  });

  test('verifies signature before parsing JSON — malformed body with invalid signature never reaches the parser', async () => {
    vi.mocked(verifySignature).mockResolvedValue(false);

    const app = setupApp();
    // 44-char signature (valid HMAC-SHA256 base64 length) so it clears the
    // length pre-check and reaches verifySignature. Malformed JSON body: if
    // signature were verified *after* parse (old behavior), we'd hit the
    // parser-failure branch first. With signature-first, we get the invalid-
    // signature branch and never attempt to parse.
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: '{not valid json',
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // verifySignature must run; rejection happens before any parse attempt.
    expect(verifySignature).toHaveBeenCalled();
    expect(verifySignature).toHaveBeenCalledWith('env-default-secret', '{not valid json', validShapedSignature);
  });

  test('rejects unsigned or malformed-signature requests without hitting verifySignature or D1', async () => {
    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Missing X-Line-Signature header entirely.
        },
        body: JSON.stringify({ events: [] }),
      },
      baseEnv,
      baseExecutionCtx,
    );
    expect(res.status).toBe(200);
    // Fast-rejected before any crypto / DB work.
    expect(verifySignature).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — postback events', () => {
  test('fires postback_received with postback.data so IF-THEN automations run on rich menu taps', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-07-19T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-19T12:00:00.000+09:00',
      updated_at: '2026-07-19T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }), // no auto_reply match
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data: 'tag:premium' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    // No auto-reply matched — the reply token must be handed to the event bus
    // so automations can still use it for free reply delivery.
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'postback_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'tag:premium', matched: false },
        replyToken: 'reply-token-postback',
      },
      'env-default-token',
      null,
    );
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
  });

  test('silent auto-reply rule suppresses the reply but still fires postback_received as matched', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(jstNow).mockReturnValue('2026-07-19T12:00:00.000+09:00');
    vi.mocked(getFriendByLineUserId).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: null,
      status_message: null,
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      created_at: '2026-07-19T12:00:00.000+09:00',
      updated_at: '2026-07-19T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({
        results: [
          {
            id: 'rule-1',
            keyword: 'tag:premium',
            match_type: 'exact',
            response_type: 'silent',
            response_content: '',
            template_id: null,
          },
        ],
      }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'postback',
              replyToken: 'reply-token-postback',
              postback: { data: 'tag:premium' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-postback-2',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    // Silent rule: no reply sent, but matched=true and the unconsumed reply
    // token still reaches the event bus (rich menu tap → silent + add_tag flow).
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'postback_received',
      {
        friendId: 'friend-1',
        eventData: { text: 'tag:premium', matched: true },
        replyToken: 'reply-token-postback',
      },
      'env-default-token',
      null,
    );
  });
});

describe('POST /webhook — first-contact existing friends', () => {
  test('auto-registers an unknown text-message sender without firing friend_add handling', async () => {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(null);
    vi.mocked(jstNow).mockReturnValue('2026-06-18T12:00:00.000+09:00');
    lineClientMocks.getProfile.mockResolvedValue({
      userId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    vi.mocked(upsertFriend).mockResolvedValue({
      id: 'friend-1',
      line_user_id: 'U-existing',
      display_name: 'Existing Friend',
      picture_url: 'https://example.com/profile.jpg',
      status_message: 'hello',
      is_following: 1,
      user_id: null,
      line_account_id: null,
      metadata: '{}',
      first_tracked_link_id: null,
      ai_reply_mode: 'bot',
      ref_code: null,
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });
    vi.mocked(upsertChatOnMessage).mockResolvedValue({
      id: 'chat-1',
      friend_id: 'friend-1',
      operator_id: null,
      status: 'unread',
      notes: null,
      last_message_at: '2026-06-18T12:00:00.000+09:00',
      created_at: '2026-06-18T12:00:00.000+09:00',
      updated_at: '2026-06-18T12:00:00.000+09:00',
    });

    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
    };
    stmt.bind.mockReturnValue(stmt);
    const db = { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': validShapedSignature,
        },
        body: JSON.stringify({
          destination: 'bot',
          events: [
            {
              type: 'message',
              replyToken: 'reply-token',
              message: { type: 'text', id: 'message-1', text: 'こんにちは' },
              timestamp: Date.now(),
              source: { type: 'user', userId: 'U-existing' },
              webhookEventId: 'event-1',
              deliveryContext: { isRedelivery: false },
              mode: 'active',
            },
          ],
        }),
      },
      { ...baseEnv, DB: db },
      executionCtx,
    );

    expect(res.status).toBe(200);
    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;

    expect(lineClientMocks.getProfile).toHaveBeenCalledWith('U-existing');
    expect(upsertFriend).toHaveBeenCalledWith(db, {
      lineUserId: 'U-existing',
      displayName: 'Existing Friend',
      pictureUrl: 'https://example.com/profile.jpg',
      statusMessage: 'hello',
    });
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
    expect(fireEvent).toHaveBeenCalledWith(
      db,
      'message_received',
      expect.objectContaining({ friendId: 'friend-1' }),
      'env-default-token',
      null,
    );
    expect(getScenarios).not.toHaveBeenCalled();
    expect(enrollFriendInScenario).not.toHaveBeenCalled();

    // Keep the unrelated DB stubs quiet but type-checked as mocked imports.
    expect(updateFriendFollowStatus).not.toHaveBeenCalled();
    expect(getScenarioSteps).not.toHaveBeenCalled();
    expect(advanceFriendScenario).not.toHaveBeenCalled();
    expect(completeFriendScenario).not.toHaveBeenCalled();
    expect(computeNextDeliveryAt).not.toHaveBeenCalled();
    expect(resolveStepContent).not.toHaveBeenCalled();
    expect(addTagToFriend).not.toHaveBeenCalled();
    expect(getEntryRouteByRefCode).not.toHaveBeenCalled();
    expect(getMessageTemplateById).not.toHaveBeenCalled();
  });
});

describe('POST /webhook — image message vision pipeline', () => {
  function makeDb() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
  }

  const EXISTING_FRIEND = {
    id: 'friend-1',
    line_user_id: 'U-existing',
    display_name: 'Existing Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    ai_reply_mode: 'bot',
    ref_code: null,
    created_at: '2026-07-17T00:00:00.000+09:00',
    updated_at: '2026-07-17T00:00:00.000+09:00',
  };

  function imageWebhookBody() {
    return JSON.stringify({
      destination: 'bot',
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          message: { type: 'image', id: 'msg-image-1' },
          timestamp: Date.now(),
          source: { type: 'user', userId: 'U-existing' },
          webhookEventId: 'event-1',
          deliveryContext: { isRedelivery: false },
          mode: 'active',
        },
      ],
    });
  }

  async function sendImageWebhook(db: D1Database, env: Record<string, unknown> = {}) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(EXISTING_FRIEND as never);
    vi.mocked(jstNow).mockReturnValue('2026-07-17T12:00:00.000+09:00');
    vi.mocked(upsertChatOnMessage).mockResolvedValue({} as never);

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const validShapedSignature = 'A'.repeat(43) + '=';
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': validShapedSignature },
        body: imageWebhookBody(),
      },
      {
        ...baseEnv,
        DB: db,
        GROQ_API_KEY: 'gsk-test',
        WORKER_URL: 'https://worker.example.workers.dev',
        IMAGES: {} as R2Bucket,
        ...env,
      },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;
    return res;
  }

  test('vision disabled: records the image and marks unread, no describe/pipeline call', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: { vision: { enabled: false, chain: [], maxDescriptionTokens: 250 } },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });

    const db = makeDb();
    const res = await sendImageWebhook(db);

    expect(res.status).toBe(200);
    expect(describeImageMock).not.toHaveBeenCalled();
    expect(runGroqSupportPipelineMock).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('vision enabled + describe succeeds + pipeline replies: sends reply and skips unread', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: {
        vision: {
          enabled: true,
          chain: [{ provider: 'groq', model: 'qwen/qwen3.6-27b', timeoutMs: 10000 }],
          maxDescriptionTokens: 250,
        },
      },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });
    getGroqReplyConfigMock.mockResolvedValue({ enabled: true });
    isGroqBudgetExceededMock.mockResolvedValue(false);
    describeImageMock.mockResolvedValue('猫が写っている写真です。');
    runGroqSupportPipelineMock.mockResolvedValue({ kind: 'reply', text: 'かわいい猫ちゃんですね！', cacheable: false });

    const db = makeDb();
    const res = await sendImageWebhook(db);

    expect(res.status).toBe(200);
    expect(describeImageMock).toHaveBeenCalledTimes(1);
    expect(runGroqSupportPipelineMock).toHaveBeenCalledWith(
      expect.objectContaining({
        incomingText: expect.stringContaining('猫が写っている写真です。'),
        cachePolicy: 'skip',
      }),
    );
    // メタ記法「[ユーザーが画像を送信...]」だとLLMがpersonaを離れて客観描写タスクだと
    // 誤認識する事故があったため、会話的な文面になっていることを明示的に確認する。
    const calledIncomingText = runGroqSupportPipelineMock.mock.calls[0][0].incomingText as string;
    expect(calledIncomingText).not.toMatch(/^\[ユーザーが画像を送信/);
    expect(calledIncomingText).toContain('あなたらしく反応してください');
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: 'かわいい猫ちゃんですね！' },
    ]);
    // AI応答成功 → unread化はスキップされる（§7.3）。
    expect(upsertChatOnMessage).not.toHaveBeenCalled();
  });

  test('vision enabled but groq_reply_enabled=false: skips describe entirely (§11 地雷#14)', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: {
        vision: {
          enabled: true,
          chain: [{ provider: 'groq', model: 'qwen/qwen3.6-27b', timeoutMs: 10000 }],
          maxDescriptionTokens: 250,
        },
      },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });
    getGroqReplyConfigMock.mockResolvedValue({ enabled: false });

    const db = makeDb();
    const res = await sendImageWebhook(db);

    expect(res.status).toBe(200);
    expect(describeImageMock).not.toHaveBeenCalled();
    expect(runGroqSupportPipelineMock).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('vision enabled but daily budget exceeded: skips describe (cost guard)', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: {
        vision: {
          enabled: true,
          chain: [{ provider: 'groq', model: 'qwen/qwen3.6-27b', timeoutMs: 10000 }],
          maxDescriptionTokens: 250,
        },
      },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });
    getGroqReplyConfigMock.mockResolvedValue({ enabled: true });
    isGroqBudgetExceededMock.mockResolvedValue(true);

    const db = makeDb();
    const res = await sendImageWebhook(db);

    expect(res.status).toBe(200);
    expect(describeImageMock).not.toHaveBeenCalled();
    expect(runGroqSupportPipelineMock).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('describe returns null (chain fully failed): falls back to current behavior (record + unread, no reply)', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: {
        vision: {
          enabled: true,
          chain: [{ provider: 'groq', model: 'qwen/qwen3.6-27b', timeoutMs: 10000 }],
          maxDescriptionTokens: 250,
        },
      },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });
    getGroqReplyConfigMock.mockResolvedValue({ enabled: true });
    isGroqBudgetExceededMock.mockResolvedValue(false);
    describeImageMock.mockResolvedValue(null);

    const db = makeDb();
    const res = await sendImageWebhook(db);

    expect(res.status).toBe(200);
    expect(describeImageMock).toHaveBeenCalledTimes(1);
    expect(runGroqSupportPipelineMock).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).not.toHaveBeenCalled();
    expect(lineClientMocks.pushMessage).not.toHaveBeenCalled();
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('pipeline escalates: sends escalation notice, switches to human mode, still marks unread', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: {
        vision: {
          enabled: true,
          chain: [{ provider: 'groq', model: 'qwen/qwen3.6-27b', timeoutMs: 10000 }],
          maxDescriptionTokens: 250,
        },
      },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });
    getGroqReplyConfigMock.mockResolvedValue({ enabled: true });
    isGroqBudgetExceededMock.mockResolvedValue(false);
    describeImageMock.mockResolvedValue('不適切な内容の画像です。');
    runGroqSupportPipelineMock.mockResolvedValue({ kind: 'escalate', text: undefined });

    const db = makeDb();
    const res = await sendImageWebhook(db);

    expect(res.status).toBe(200);
    expect(lineClientMocks.replyMessage).toHaveBeenCalledWith('reply-token', [
      { type: 'text', text: 'ちょっと待っててね、中の人につなぐね。' },
    ]);
    // エスカレーションは人間対応が必要 → unread化する。
    expect(upsertChatOnMessage).toHaveBeenCalledWith(db, 'friend-1');
  });

  test('image bytes are never persisted to messages_log content JSON', async () => {
    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: { vision: { enabled: false, chain: [], maxDescriptionTokens: 250 } },
    });
    fetchAndStoreIncomingImageMock.mockResolvedValue({
      originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      previewImageUrl: 'https://worker.example.workers.dev/images/incoming-x.jpg',
      bytes: new ArrayBuffer(10),
      contentType: 'image/jpeg',
    });

    const db = makeDb();
    await sendImageWebhook(db);

    const prepareCalls = vi.mocked(db.prepare).mock.calls;
    const insertCall = prepareCalls.find(([sql]) => sql.includes('INSERT INTO messages_log') && sql.includes("'incoming'"));
    expect(insertCall).toBeDefined();
    const stmt = vi.mocked(db.prepare).mock.results[prepareCalls.indexOf(insertCall!)].value;
    const boundArgs = stmt.bind.mock.calls[0];
    const contentArg = boundArgs[3] as string;
    expect(() => JSON.parse(contentArg)).not.toThrow();
    const parsed = JSON.parse(contentArg);
    expect(parsed.bytes).toBeUndefined();
    expect(parsed.originalContentUrl).toBe('https://worker.example.workers.dev/images/incoming-x.jpg');
  });
});

describe('POST /webhook — 音声メッセージへの音声返信', () => {
  function makeDb() {
    const stmt = {
      bind: vi.fn(),
      run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
  }

  const FRIEND = {
    id: 'friend-1',
    line_user_id: 'U-existing',
    display_name: 'Existing Friend',
    picture_url: null,
    status_message: null,
    is_following: 1,
    user_id: null,
    line_account_id: null,
    metadata: '{}',
    first_tracked_link_id: null,
    ai_reply_mode: 'bot',
    ref_code: null,
    created_at: '2026-07-17T00:00:00.000+09:00',
    updated_at: '2026-07-17T00:00:00.000+09:00',
  };

  const AUDIO_CONFIG = {
    enabled: true,
    model: 'gemini-3.1-flash-lite',
    timeoutMs: 20000,
    maxDescriptionTokens: 250,
    maxInputBytes: 15 * 1024 * 1024,
  };

  function mediaWebhookBody(type: 'audio' | 'video') {
    return JSON.stringify({
      destination: 'bot',
      events: [
        {
          type: 'message',
          replyToken: 'reply-token',
          message: { type, id: `msg-${type}-1` },
          timestamp: Date.now(),
          source: { type: 'user', userId: 'U-existing' },
          webhookEventId: 'event-1',
          deliveryContext: { isRedelivery: false },
          mode: 'active',
        },
      ],
    });
  }

  async function sendMediaWebhook(type: 'audio' | 'video', env: Record<string, unknown> = {}) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(FRIEND as never);
    vi.mocked(jstNow).mockReturnValue('2026-07-17T12:00:00.000+09:00');
    vi.mocked(upsertChatOnMessage).mockResolvedValue({} as never);

    botConfigMock.mockReturnValue({
      ...DEFAULT_BOT_CONFIG,
      llm: { ...DEFAULT_BOT_CONFIG.llm, audio: AUDIO_CONFIG, video: AUDIO_CONFIG },
    });
    getGroqReplyConfigMock.mockResolvedValue({ enabled: true });
    isGroqBudgetExceededMock.mockResolvedValue(false);
    fetchAndStoreIncomingMediaMock.mockResolvedValue({
      refs: {
        originalContentUrl: 'https://worker.example.workers.dev/images/incoming-x.m4a',
        bytes: new ArrayBuffer(1024),
        contentType: type === 'audio' ? 'audio/m4a' : 'video/mp4',
      },
      failureReason: null,
    });
    describeAudioMock.mockResolvedValue('落ち込んでいる相談');
    describeVideoMock.mockResolvedValue({ text: '動画の内容', rateLimited: false });
    runGroqSupportPipelineMock.mockResolvedValue({ kind: 'reply', text: 'それ、気にしすぎよ。' });

    const executionCtx = {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    const app = setupApp();
    const res = await app.request(
      '/webhook',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Line-Signature': 'A'.repeat(43) + '=',
        },
        body: mediaWebhookBody(type),
      },
      {
        ...baseEnv,
        DB: makeDb(),
        GROQ_API_KEY: 'gsk-test',
        GEMINI_API_KEY: 'gemini-test',
        WORKER_URL: 'https://worker.example.workers.dev',
        IMAGES: {} as R2Bucket,
        ...env,
      },
      executionCtx,
    );

    const processing = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await processing;
    return res;
  }

  test('音声メッセージは replyWithVoice を通る（声で話しかけられたら声で返す）', async () => {
    await sendMediaWebhook('audio', {
      VOICE_SYNTH_ENDPOINT: 'https://synth.example/tts',
      VOICE_SYNTH_TOKEN: 'secret',
    });

    expect(replyWithVoiceMock).toHaveBeenCalledTimes(1);
    const params = replyWithVoiceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.text).toBe('それ、気にしすぎよ。');
    expect(params.lineUserId).toBe('U-existing');
  });

  test('VOICE_CHARACTER で誰の声かを切り替えられる', async () => {
    await sendMediaWebhook('audio', {
      VOICE_SYNTH_ENDPOINT: 'https://synth.example/tts',
      VOICE_SYNTH_TOKEN: 'secret',
      VOICE_CHARACTER: 'konta',
    });

    const params = replyWithVoiceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.character).toBe('konta');
  });

  test('VOICE_CHARACTER 未設定なら既定のたぬ姉になる', async () => {
    await sendMediaWebhook('audio', {
      VOICE_SYNTH_ENDPOINT: 'https://synth.example/tts',
      VOICE_SYNTH_TOKEN: 'secret',
    });

    const params = replyWithVoiceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.character).toBe('tanunee');
  });

  test('未知の VOICE_CHARACTER でも落ちずに既定へ倒す', async () => {
    await sendMediaWebhook('audio', {
      VOICE_SYNTH_ENDPOINT: 'https://synth.example/tts',
      VOICE_SYNTH_TOKEN: 'secret',
      VOICE_CHARACTER: 'nonexistent-character',
    });

    const params = replyWithVoiceMock.mock.calls[0][0] as Record<string, unknown>;
    expect(params.character).toBe('tanunee');
  });

  test('音声機能が未設定でも音声分岐は通る（replyWithVoiceの中でテキストに落ちる）', async () => {
    await sendMediaWebhook('audio');

    // 未設定なら createSynthesizer が null を返し、replyWithVoice がテキストで返す。
    // webhook側で分岐を止めてしまうと「設定した瞬間に別経路になる」ので、
    // 常に同じ道を通ることを固定しておく。
    expect(replyWithVoiceMock).toHaveBeenCalledTimes(1);
    expect(createSynthesizerMock).toHaveBeenCalled();
  });

  test('動画メッセージは音声で返さない（テキストのまま）', async () => {
    await sendMediaWebhook('video', {
      VOICE_SYNTH_ENDPOINT: 'https://synth.example/tts',
      VOICE_SYNTH_TOKEN: 'secret',
    });

    expect(replyWithVoiceMock).not.toHaveBeenCalled();
    expect(lineClientMocks.replyMessage).toHaveBeenCalled();
  });
});

describe('POST /webhook — 出力ガード（危険な断定を送らない）', () => {
  function makeDb() {
    const stmt = {
      bind: vi.fn(), run: vi.fn().mockResolvedValue({}),
      all: vi.fn().mockResolvedValue({ results: [] }),
      first: vi.fn().mockResolvedValue(null),
    };
    stmt.bind.mockReturnValue(stmt);
    return { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database;
  }

  const FRIEND = {
    id: 'friend-1', line_user_id: 'U-existing', display_name: 'F',
    picture_url: null, status_message: null, is_following: 1, user_id: null,
    line_account_id: null, metadata: '{}', first_tracked_link_id: null,
    ai_reply_mode: 'bot', ref_code: null,
    created_at: '2026-07-17T00:00:00.000+09:00', updated_at: '2026-07-17T00:00:00.000+09:00',
  };

  async function sendTextWebhook(llmReply: string) {
    vi.mocked(verifySignature).mockResolvedValue(true);
    vi.mocked(getFriendByLineUserId).mockResolvedValue(FRIEND as never);
    vi.mocked(jstNow).mockReturnValue('2026-07-17T12:00:00.000+09:00');
    vi.mocked(upsertChatOnMessage).mockResolvedValue({} as never);
    getGroqReplyConfigMock.mockResolvedValue({ enabled: true });
    isGroqBudgetExceededMock.mockResolvedValue(false);
    runGroqSupportPipelineMock.mockResolvedValue({ kind: 'reply', text: llmReply });

    const executionCtx = {
      waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {},
    } as unknown as ExecutionContext;

    await setupApp().request(
      '/webhook',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Line-Signature': 'A'.repeat(43) + '=' },
        body: JSON.stringify({
          destination: 'bot',
          events: [{
            type: 'message', replyToken: 'reply-token',
            message: { type: 'text', id: 'm1', text: '頭痛が治りますか' },
            timestamp: Date.now(), source: { type: 'user', userId: 'U-existing' },
            webhookEventId: 'e1', deliveryContext: { isRedelivery: false }, mode: 'active',
          }],
        }),
      },
      { ...baseEnv, DB: makeDb(), GROQ_API_KEY: 'gsk-test', WORKER_URL: 'https://w.example' },
      executionCtx,
    );
    const p = vi.mocked(executionCtx.waitUntil).mock.calls[0]?.[0] as Promise<unknown>;
    await p;
  }

  test('★LLMが危険な断定を返しても、そのまま送らない', async () => {
    await sendTextWebhook('その頭痛はこの方法で治りますよ。');
    const sent = lineClientMocks.replyMessage.mock.calls[0]?.[1] as Array<{ text: string }>;
    expect(sent[0].text).not.toContain('治ります');
    expect(sent[0].text).toContain('お医者さん');
  });

  test('安全な返答はそのまま送る（誤検知しない）', async () => {
    const safe = '気になるなら、お医者さんに相談してみてね。';
    await sendTextWebhook(safe);
    const sent = lineClientMocks.replyMessage.mock.calls[0]?.[1] as Array<{ text: string }>;
    expect(sent[0].text).toBe(safe);
  });
});
