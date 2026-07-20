import { Hono } from 'hono';
import { verifySignature, LineClient } from '@line-crm/line-sdk';
import type { WebhookRequestBody, WebhookEvent, TextEventMessage } from '@line-crm/line-sdk';
import { createStickerMessageContent } from '@line-crm/shared';
import {
  upsertFriend,
  updateFriendFollowStatus,
  getFriendByLineUserId,
  getScenarios,
  enrollFriendInScenario,
  upsertChatOnMessage,
  getLineAccounts,
  jstNow,
  getEntryRouteByRefCode,
  getMessageTemplateById,
} from '@line-crm/db';
import type { EntryRoute, Friend } from '@line-crm/db';
import { fireEvent } from '../services/event-bus.js';
import { buildMessage, expandVariables } from '../services/step-delivery.js';
import { generateLlmReply, switchToHumanMode } from '../services/llm-reply.js';
import { runGroqSupportPipeline } from '../services/groq-pipeline.js';
import { resolveBotProject } from '../services/bot-project.js';
import { getBotConfig } from '../services/groq-config.js';
import { extractFirstUrl, fetchUrlContext, type UrlContextEnv } from '../services/url-context.js';
import { describeImage } from '../services/vision-describe.js';
import { matchSelfCharacter } from '../services/self-recognition.js';
import { getGroqReplyConfig } from '../services/groq-reply.js';
import { isGroqBudgetExceeded } from '../services/kb-search.js';
import {
  isTaskMessage,
  isAuthorizedTaskSender,
  extractTaskBody,
  createAiShainTask,
} from '../services/ai-shain-worker-task.js';
import { pushImmediateFirstStep } from '../services/immediate-first-step.js';
import type { Env } from '../index.js';

const webhook = new Hono<Env>();

// LINE webhook bodies are small (events array). Cap defends against unauthenticated
// large-payload DoS before signature verification (#104). 1 MiB leaves room for
// bursty batched deliveries (~100 events × ~5 KB) while still well below the
// 128 MB Cloudflare Workers memory ceiling.
const MAX_WEBHOOK_BODY_SIZE = 1024 * 1024; // 1 MiB

/**
 * replyToken失効（発行から約60秒）対策の送信保険。45秒以内かつ未消費ならreplyMessageを
 * 試み、失敗（トークン失効・二重消費等）した場合はpushMessageに切り替える。
 * pushMessageはreplyTokenを不要でいつでも届くため、これが効くケースは従来なら
 * 「例外を握りつぶして完全に無言化」していたはずの経路（2026-07-17 Fable設計
 * 「無応答ゼロ化アーキテクチャ」）。テキスト分岐・画像分岐の両方から共用する
 * （§11地雷#5: 画像分岐にはこのヘルパーが元々無く、image messageイベントにも
 * replyTokenがある——現在未使用なだけ）。
 */
async function sendSafeText(
  lineClient: LineClient,
  replyToken: string,
  lineUserId: string,
  text: string,
  receivedAt: number,
  replyTokenConsumed: boolean,
): Promise<boolean> {
  const withinDeadline = !replyTokenConsumed && Date.now() - receivedAt < 45_000;
  if (withinDeadline) {
    try {
      await lineClient.replyMessage(replyToken, [{ type: 'text', text }]);
      return true;
    } catch (err) {
      console.warn('[safe-send] replyMessage failed, falling back to pushMessage', err instanceof Error ? err.message : String(err));
    }
  }
  await lineClient.pushMessage(lineUserId, [{ type: 'text', text }]);
  return false;
}

async function logOutgoingGroqMessage(
  db: D1Database,
  friendId: string,
  text: string,
  source: 'groq_reply' | 'groq_canned',
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', ?, ?)`,
    )
    .bind(crypto.randomUUID(), friendId, text, source, jstNow())
    .run();
}

async function ensureFriendFromWebhookUser(
  db: D1Database,
  lineClient: LineClient,
  userId: string,
  lineAccountId: string | null,
): Promise<Friend | null> {
  let friend = await getFriendByLineUserId(db, userId);

  if (!friend) {
    let profile: Awaited<ReturnType<LineClient['getProfile']>> | null = null;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      // A signed webhook already proves this user interacted with the bot.
      // If profile lookup is temporarily unavailable, keep the event processable
      // by creating the friend with the LINE userId and filling profile later.
      console.error('[webhook] Failed to get profile for unknown user', userId, err);
    }

    friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });
    console.log(`[webhook] auto-registered existing friend userId=${userId} friendId=${friend.id}`);
  }

  if (lineAccountId && friend.line_account_id !== lineAccountId) {
    const now = jstNow();
    await db
      .prepare('UPDATE friends SET line_account_id = ?, is_following = 1, updated_at = ? WHERE id = ?')
      .bind(lineAccountId, now, friend.id)
      .run();
    friend = { ...friend, line_account_id: lineAccountId, is_following: 1, updated_at: now };
  }

  return friend;
}

webhook.post('/webhook', async (c) => {
  // Pre-read size guard: reject before reading the body if Content-Length is oversized.
  const contentLengthHeader = c.req.header('Content-Length');
  if (contentLengthHeader) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_SIZE) {
      return c.json({ status: 'too_large' }, 413);
    }
  }

  const rawBody = await c.req.text();

  // Post-read size guard for the case where Content-Length was absent or untrustworthy.
  // Use UTF-8 byte count: `rawBody.length` counts UTF-16 code units, so multibyte
  // payloads (Japanese/emoji) would otherwise bypass the cap.
  const rawBodyByteLength = new TextEncoder().encode(rawBody).byteLength;
  if (rawBodyByteLength > MAX_WEBHOOK_BODY_SIZE) {
    return c.json({ status: 'too_large' }, 413);
  }

  const signature = c.req.header('X-Line-Signature') ?? '';
  const db = c.env.DB;

  // Cheap pre-reject for unsigned / malformed-signature requests. LINE signatures
  // are HMAC-SHA256 + base64 = 44 chars. This avoids D1 lookups and HMAC compute
  // for junk traffic on a public endpoint.
  const LINE_SIGNATURE_LENGTH = 44;
  if (signature.length !== LINE_SIGNATURE_LENGTH) {
    console.error('Missing or malformed LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  // Verify signature BEFORE JSON.parse so attacker-controlled bodies never reach the parser.
  // Fast path: try env default secret first so malformed/unauthenticated traffic
  //   fails fast without a D1 lookup. The main account is typically also registered
  //   in line_accounts; on env match we still look it up so matchedAccountId binds
  //   correctly for downstream account-scoped filters.
  // Slow path: iterate DB-registered accounts for genuinely multi-account installs.
  let channelAccessToken = c.env.LINE_CHANNEL_ACCESS_TOKEN;
  let matchedAccountId: string | null = null;
  let valid = false;

  const envSecret = c.env.LINE_CHANNEL_SECRET;
  if (envSecret) {
    valid = await verifySignature(envSecret, rawBody, signature);
    if (valid) {
      const accounts = await getLineAccounts(db);
      const main = accounts.find(
        (a) => a.is_active && a.channel_secret === envSecret,
      );
      if (main) {
        channelAccessToken = main.channel_access_token;
        matchedAccountId = main.id;
      }
    }
  }

  if (!valid) {
    const accounts = await getLineAccounts(db);
    for (const account of accounts) {
      if (!account.is_active) continue;
      if (envSecret && account.channel_secret === envSecret) continue; // already tried via fast path
      const isValid = await verifySignature(account.channel_secret, rawBody, signature);
      if (isValid) {
        channelAccessToken = account.channel_access_token;
        matchedAccountId = account.id;
        valid = true;
        break;
      }
    }
  }

  if (!valid) {
    console.error('Invalid LINE signature');
    return c.json({ status: 'ok' }, 200);
  }

  let body: WebhookRequestBody;
  try {
    body = JSON.parse(rawBody) as WebhookRequestBody;
  } catch {
    console.error('Failed to parse webhook body');
    return c.json({ status: 'ok' }, 200);
  }

  // replyTokenの60秒失効に対する残り時間駆動（llm-chain.ts）の起点。
  const receivedAt = Date.now();
  const lineClient = new LineClient(channelAccessToken);

  // 非同期処理 — LINE は ~1s 以内のレスポンスを要求
  const processingPromise = (async () => {
    for (const event of body.events) {
      try {
        await handleEvent(
          db,
          lineClient,
          event,
          channelAccessToken,
          matchedAccountId,
          c.env.WORKER_URL || new URL(c.req.url).origin,
          c.env.LIFF_URL,
          c.env.IMAGES,
          c.env.ANTHROPIC_API_KEY,
          c.env.GROQ_API_KEY,
          c.env.GITHUB_TOKEN,
          receivedAt,
          c.env.GEMINI_API_KEY,
          c.env.AI,
          {
            WORKER_URL: c.env.WORKER_URL,
            WORKER_PUBLIC_URL: c.env.WORKER_PUBLIC_URL,
            ADMIN_PUBLIC_URL: c.env.ADMIN_PUBLIC_URL,
            LIFF_PUBLIC_URL: c.env.LIFF_PUBLIC_URL,
          },
        );
      } catch (err) {
        console.error('Error handling webhook event:', err instanceof Error ? err.stack : String(err));
      }
    }
  })();

  c.executionCtx.waitUntil(processingPromise);

  return c.json({ status: 'ok' }, 200);
});

async function handleEvent(
  db: D1Database,
  lineClient: LineClient,
  event: WebhookEvent,
  lineAccessToken: string,
  lineAccountId: string | null = null,
  workerUrl?: string,
  liffUrl?: string,
  r2?: R2Bucket,
  anthropicApiKey?: string,
  groqApiKey?: string,
  githubToken?: string,
  receivedAt: number = Date.now(),
  geminiApiKey?: string,
  workersAi?: Ai,
  urlContextEnv: UrlContextEnv = {},
): Promise<void> {
  if (event.type === 'follow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    console.log(`[follow] userId=${userId} lineAccountId=${lineAccountId}`);

    // プロフィール取得 & 友だち登録/更新
    let profile;
    try {
      profile = await lineClient.getProfile(userId);
    } catch (err) {
      console.error('Failed to get profile for', userId, err);
    }

    console.log(`[follow] profile=${profile?.displayName ?? 'null'}`);

    const friend = await upsertFriend(db, {
      lineUserId: userId,
      displayName: profile?.displayName ?? null,
      pictureUrl: profile?.pictureUrl ?? null,
      statusMessage: profile?.statusMessage ?? null,
    });

    console.log(`[follow] friend.id=${friend.id} friend.line_account_id=${(friend as any).line_account_id}`);

    // Set line_account_id for multi-account tracking (always update on follow)
    if (lineAccountId) {
      await db.prepare('UPDATE friends SET line_account_id = ?, updated_at = ? WHERE id = ?')
        .bind(lineAccountId, jstNow(), friend.id).run();
      console.log(`[follow] line_account_id set to ${lineAccountId} for friend ${friend.id}`);
    }

    // Resolve referral link (entry_route) for this friend.
    // /auth/callback (OAuth path) writes friends.ref_code in parallel with
    // this follow webhook, so the field can briefly be NULL when LINE
    // delivers the event. Retry a few times (~1s total) before giving up,
    // otherwise override mode and intro pushes silently fall back to the
    // account default whenever the webhook wins the race.
    const { getFriendById } = await import('@line-crm/db');
    let friendRefCode = (friend as { ref_code?: string | null }).ref_code ?? null;
    if (!friendRefCode) {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const refreshed = await getFriendById(db, friend.id);
        const refreshedRef = (refreshed as { ref_code?: string | null } | null)?.ref_code ?? null;
        if (refreshedRef) {
          friendRefCode = refreshedRef;
          break;
        }
      }
    }
    const referralRoute: EntryRoute | null = friendRefCode
      ? await getEntryRouteByRefCode(db, friendRefCode)
      : null;
    const runAccountScenarios =
      !referralRoute || referralRoute.run_account_friend_add_scenarios !== 0;

    // friend_add シナリオに登録（このアカウントのシナリオのみ）
    // Skip entirely when a referral link explicitly overrides (run_account_friend_add_scenarios=0).
    const scenarios = runAccountScenarios ? await getScenarios(db) : [];
    for (const scenario of scenarios) {
      // Only trigger scenarios belonging to this account (or unassigned for backward compat)
      const scenarioAccountMatch = !scenario.line_account_id || !lineAccountId || scenario.line_account_id === lineAccountId;
      if (scenario.trigger_type === 'friend_add' && scenario.is_active && scenarioAccountMatch) {
        try {
          // INSERT OR IGNORE handles dedup via UNIQUE(friend_id, scenario_id)
          const friendScenario = await enrollFriendInScenario(db, friend.id, scenario.id);
          if (!friendScenario) continue; // already enrolled

          // Immediate delivery: step1 が「now 以前」にスケジュールされる場合のみ
          // replyMessage で即時送信する (reply token は無料・push 枠を消費しない)。
          // - relative + delay_minutes=0 → 即時
          // - elapsed + offset_days=0 + offset_minutes=0 → 即時
          // - absolute_time で過去時刻 → computeNextDeliveryAt が now に clamp するので即時
          // reply 失敗時 (2つ目のシナリオで token 消費済み等) は claim が解放され
          // cron が push で配信する。
          // skipCooldown: 60秒以内の再フォロー (前の enrollment が completed 済み)
          // でも必ず welcome を返す — 旧 webhook 実装のセマンティクスを維持。
          const sent = await pushImmediateFirstStep(
            db,
            friend.id,
            scenario.id,
            { defaultAccessToken: lineAccessToken, workerUrl },
            {
              enrollment: friendScenario,
              reply: { client: lineClient, replyToken: event.replyToken },
              skipCooldown: true,
            },
          );
          if (sent) console.log(`Immediate delivery: sent scenario ${scenario.id} step 1 to ${userId}`);
        } catch (err) {
          console.error('Failed to enroll friend in scenario', scenario.id, err);
        }
      }
    }

    // Referral link side-effects (intro push + dedicated scenario)
    if (referralRoute) {
      // Intro push from referral link
      if (referralRoute.intro_template_id) {
        try {
          const template = await getMessageTemplateById(db, referralRoute.intro_template_id);
          if (template) {
            const message = buildMessage(template.message_type, template.message_content);
            await lineClient.pushMessage(userId, [message]);
            console.log(`[follow] referral intro push sent route=${referralRoute.id}`);
          }
        } catch (err) {
          console.error('[follow] referral intro push failed', err);
        }
      }

      // Dedicated scenario enrollment from referral link. A delay-0 first
      // step is pushed immediately (same instant-welcome semantics as
      // friend_add / tag_added enrollments — previously this path always
      // waited for the next cron tick). pushMessage, not reply: the reply
      // token may already be consumed by an account friend_add scenario
      // above, and the intro push on this path uses pushMessage too.
      if (referralRoute.scenario_id) {
        try {
          const enrollment = await enrollFriendInScenario(db, friend.id, referralRoute.scenario_id);
          console.log(`[follow] referral scenario enrolled scenario=${referralRoute.scenario_id}`);
          if (enrollment) {
            await pushImmediateFirstStep(
              db,
              friend.id,
              referralRoute.scenario_id,
              { defaultAccessToken: lineAccessToken, workerUrl },
              { enrollment },
            );
          }
        } catch (err) {
          console.error('[follow] referral scenario enrollment failed', err);
        }
      }
    }

    // イベントバス発火: friend_add（replyToken は Step 0 で使用済みの可能性あり）
    await fireEvent(db, 'friend_add', { friendId: friend.id, eventData: { displayName: friend.display_name } }, lineAccessToken, lineAccountId);
    return;
  }

  if (event.type === 'unfollow') {
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    await updateFriendFollowStatus(db, userId, false);
    return;
  }

  // Postback events — triggered by Flex buttons with action.type: "postback"
  // Uses the same auto_replies matching but without displaying text in chat
  if (event.type === 'postback') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const postbackData = (event as unknown as { postback: { data: string } }).postback.data;

    // Match postback data against auto_replies (exact match on keyword)
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
      }>();

    // postback の incoming 自体を messages_log に記録する。Rich Menu のタップで
     // 利用者が "コスト比較" などのアクションを起こした事実を chat 履歴で可視化する。
     // delivery_type='push' は厳密には push ではないが、incoming/non-test として
     // 既存 chat list / 詳細 SQL のフィルタを通すための妥当な値 (auto_reply text 同様)。
    try {
      await db
        .prepare(
          `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, line_account_id, created_at)
           VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'postback', ?, ?)`,
        )
        .bind(crypto.randomUUID(), friend.id, postbackData, lineAccountId ?? null, jstNow())
        .run();
    } catch (err) {
      console.error('Failed to log incoming postback', err);
    }

    for (const rule of autoReplies.results) {
      const isMatch = rule.match_type === 'exact'
        ? postbackData === rule.keyword
        : postbackData.includes(rule.keyword);

      if (isMatch) {
        try {
          const { resolveMetadata } = await import('../services/step-delivery.js');
          const resolvedMeta = await resolveMetadata(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta } as Parameters<typeof expandVariables>[1], workerUrl, resolved.messageType);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);

          // 送信ログ — Rich Menu 経由の Flex 応答もチャット詳細に残るようにする。
          // テキスト auto_reply (line ~390) と同じパターン。
          const { messageToLogPayload: logPayload } = await import('../services/step-delivery.js');
          const replyPayload = logPayload(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, line_account_id, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?, ?)`,
            )
            .bind(crypto.randomUUID(), friend.id, replyPayload.messageType, replyPayload.content, lineAccountId ?? null, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send postback reply', err);
        }
        break;
      }
    }
    return;
  }

  // 非テキストの受信メッセージ（スタンプ/画像/音声/動画/ファイル/位置情報等）もログに残す。
  // ここで早期 return することで、テキスト用の auto_reply / scenario 判定には進まない
  // （スタンプ単体に対するキーワードマッチは意味を持たないため）。inbox 抜けだけ防ぐ。
  if (event.type === 'message' && event.message.type !== 'text') {
    const userId = event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;
    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const msg = event.message as {
      id: string;
      type: string;
      fileName?: string;
      title?: string;
      packageId?: string | number;
      package_id?: string | number;
      stickerId?: string | number;
      sticker_id?: string | number;
      stickerResourceType?: string | number;
      sticker_resource_type?: string | number;
    };
    const labels: Record<string, string> = {
      sticker: '[スタンプ]',
      image: '[画像]',
      audio: '[音声]',
      video: '[動画]',
      file: msg.fileName ? `[ファイル: ${msg.fileName}]` : '[ファイル]',
      location: msg.title ? `[位置情報: ${msg.title}]` : '[位置情報]',
    };
    const content = labels[msg.type] ?? `[${msg.type}]`;

    // image の場合は LINE Content API でバイナリを取得 → R2 → JSON URL に置換。
    // 失敗時は labels[msg.type] のラベル文字列のまま (フォールバック)。
    let finalContent = content;
    // vision describe用（§7.1: INSERTは先に行い、describe完了後にUPDATEする）。
    let imageBytes: ArrayBuffer | undefined;
    let imageContentType: string | undefined;
    let imageOriginalContentUrl: string | undefined;
    let imagePreviewImageUrl: string | undefined;
    if (msg.type === 'sticker') {
      const stickerContent = createStickerMessageContent(msg);
      if (stickerContent) {
        finalContent = JSON.stringify(stickerContent);
      }
    }
    if (msg.type === 'image' && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingImage } = await import('../services/incoming-image.js');
      const refs = await fetchAndStoreIncomingImage({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
      });
      if (refs) {
        // bytesはDBに保存しない（R2二度読み回避のためメモリ内でのみ引き回す）。
        imageOriginalContentUrl = refs.originalContentUrl;
        imagePreviewImageUrl = refs.previewImageUrl;
        finalContent = JSON.stringify({
          originalContentUrl: imageOriginalContentUrl,
          previewImageUrl: imagePreviewImageUrl,
        });
        imageBytes = refs.bytes;
        imageContentType = refs.contentType;
      }
    }

    // video/audio も image と同じ形で LINE Content API → R2 → JSON URL に置換する
    // （2026-07-19動画・音声認識機能追加）。失敗時は labels[msg.type] のラベル文字列のまま。
    let mediaBytes: ArrayBuffer | undefined;
    let mediaContentType: string | undefined;
    let mediaOriginalContentUrl: string | undefined;
    if ((msg.type === 'video' || msg.type === 'audio') && r2 && workerUrl) {
      const lineMessageId = msg.id;
      const { fetchAndStoreIncomingMedia } = await import('../services/incoming-media.js');
      const { refs, failureReason } = await fetchAndStoreIncomingMedia({
        r2,
        workerUrl,
        channelAccessToken: lineAccessToken,
        accountId: lineAccountId ?? 'unknown',
        messageId: lineMessageId,
        kind: msg.type,
      });
      if (refs) {
        mediaOriginalContentUrl = refs.originalContentUrl;
        finalContent = JSON.stringify({ originalContentUrl: mediaOriginalContentUrl });
        mediaBytes = refs.bytes;
        mediaContentType = refs.contentType;
      } else if (failureReason) {
        // 失敗理由をmessages_logのcontentフォールバックに残す（ユーザーには見えない
        // DB上のログのみ）。console.errorしか見られない環境でもD1クエリだけで
        // 実測content-type等を確認できるようにする（2026-07-20原因調査用の一時計装）。
        finalContent = `${content} (${failureReason})`;
      }
    }

    const imageLogId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', ?, ?, NULL, NULL, 'user', ?)`,
      )
      .bind(imageLogId, friend.id, msg.type, finalContent, jstNow())
      .run();

    // 画像認識（2026-07-17 Fable設計「画像認識・URL認識機能」§2.1）。
    // groq_reply_enabled/予算超過ゲートはdescribe（コスト発生点）の前に通す
    // （§11地雷#14: 順序を間違えるとAI応答無効アカウントでもvision APIが叩かれる）。
    let imageLlmHandled = false;
    const visionConfig = getBotConfig().llm.vision;
    if (msg.type === 'image' && imageBytes && imageContentType && groqApiKey && visionConfig?.enabled) {
      const groqConfig = await getGroqReplyConfig(db, lineAccountId);
      const budgetExceeded = groqConfig.enabled && (await isGroqBudgetExceeded(db, lineAccountId));
      if (groqConfig.enabled && !budgetExceeded) {
        try {
          const description = await describeImage({
            bytes: imageBytes,
            contentType: imageContentType,
            publicImageUrl: imageOriginalContentUrl,
            publicUrlUnreachable: !!workerUrl && /localhost|127\.0\.0\.1/.test(workerUrl),
            vision: visionConfig,
            groqApiKey,
            geminiApiKey,
            receivedAt,
          });

          if (description) {
            try {
              await db
                .prepare(`UPDATE messages_log SET content = ? WHERE id = ?`)
                .bind(
                  JSON.stringify({
                    originalContentUrl: imageOriginalContentUrl,
                    previewImageUrl: imagePreviewImageUrl,
                    visionSummary: description,
                  }),
                  imageLogId,
                )
                .run();
            } catch (err) {
              console.error('[webhook] visionSummary UPDATE failed', err);
            }

            const project = await resolveBotProject(db, friend);
            const groqResult = await runGroqSupportPipeline({
              db,
              apiKey: groqApiKey,
              geminiApiKey,
              workersAi,
              receivedAt,
              lineAccountId,
              friendId: friend.id,
              // 「画像の内容を報告せよ」という指示に読めるメタ記法を避け、ユーザーが
              // 画像を見せてきたという会話的な状況として渡す。カギ括弧のメタ記法だと
              // LLMがpersonaを離れて客観描写タスクだと誤認識し、素っ気ない説明文を
              // そのまま返す事故が起きた（2026-07-18 実障害）。
              incomingText: `（画像を送ってきました。写っているのは次の内容です: ${description}）この画像を見て、あなたらしく反応してください。`,
              project,
              cachePolicy: 'skip',
              // 履歴の最後に今回の画像行(imageLogId)自体が`[画像: 客観描写]`という
              // 素っ気ない別テキストで混入し、上のincomingText（人格指示込み）と
              // 食い違ったまま履歴側が優先される事故を防ぐ（2026-07-19 実障害）。
              excludeLogId: imageLogId,
            });

            if (groqResult.kind === 'canned' || groqResult.kind === 'reply') {
              await sendSafeText(lineClient, event.replyToken, friend.line_user_id, groqResult.text, receivedAt, false);
              await logOutgoingGroqMessage(db, friend.id, groqResult.text, groqResult.kind === 'canned' ? 'groq_canned' : 'groq_reply');
              imageLlmHandled = true;
            } else if (groqResult.kind === 'escalate') {
              await switchToHumanMode(db, friend.id);
              const escalationNotice = groqResult.text || 'ちょっと待っててね、中の人につなぐね。';
              await sendSafeText(lineClient, event.replyToken, friend.line_user_id, escalationNotice, receivedAt, false);
              await logOutgoingGroqMessage(db, friend.id, escalationNotice, 'groq_reply');
              // エスカレーションは人間対応が必要なのでimageLlmHandledはfalseのまま
              // （下のunread化に進ませる）。
            } else if (groqResult.kind === 'fail_closed') {
              await sendSafeText(lineClient, event.replyToken, friend.line_user_id, groqResult.escalationText, receivedAt, false);
              await logOutgoingGroqMessage(db, friend.id, groqResult.escalationText, 'groq_reply');
            }
          }
          // description === null（チェーン全滅・画像サイズ超過等）→ 現状動作
          // （記録済み+unread、返信なし）に静かに戻る。fail-closed。
        } catch (err) {
          console.error('[webhook] image vision pipeline failed', err instanceof Error ? err.stack : String(err));
        }
      }
    }

    // 動画・音声認識（2026-07-19追加）。imageと同じ2段方式・同じ順序ガード
    // （groq_reply_enabled/予算超過ゲートをdescribe前に通す）。visionと違いGeminiのみ対応
    // （groq-config.ts BotMediaConfig参照）なのでチェーンではなく単発呼び出し。
    if ((msg.type === 'video' || msg.type === 'audio') && mediaBytes && mediaContentType && geminiApiKey) {
      const mediaConfig = msg.type === 'video' ? getBotConfig().llm.video : getBotConfig().llm.audio;
      if (mediaConfig?.enabled) {
        const groqConfig = await getGroqReplyConfig(db, lineAccountId);
        const budgetExceeded = groqConfig.enabled && (await isGroqBudgetExceeded(db, lineAccountId));
        // サイズ超過はdescribe呼び出し前に検出し一言だけ返す。以前はdescribe内部の
        // fail-closedにそのまま従い完全に無言だったが、画面録画動画のように15MBを
        // 超えやすい動画で「既読無視された」ように見える実障害が発生した(2026-07-20)。
        const mediaTooLarge = mediaBytes.byteLength > mediaConfig.maxInputBytes;
        if (mediaTooLarge && groqConfig.enabled && !budgetExceeded) {
          const mediaLabel = msg.type === 'video' ? '動画' : '音声';
          const tooLargeNotice = `ごめんね、この${mediaLabel}ファイルが大きすぎて中身を確認できなかったよ。もう少し短い${mediaLabel}なら見れるはず！`;
          await sendSafeText(lineClient, event.replyToken, friend.line_user_id, tooLargeNotice, receivedAt, false);
          await logOutgoingGroqMessage(db, friend.id, tooLargeNotice, 'groq_reply');
          imageLlmHandled = true;
        } else if (groqConfig.enabled && !budgetExceeded) {
          // 診断用の構造化ログ（2026-07-20 BEST-IN-CLASS-DESIGN.md C-4）。今日「たぬ姉は503か
          // 未確定」で終わった反省から、outcome/describe理由を1行のJSONで必ず残す。
          // sha256はSprint 2で検討するBot送信済み動画との完全一致判定（Tier 0）の実験データも兼ねる。
          let mediaOutcome: 'replied' | 'fail_notice' = 'fail_notice';
          let describeOutcome: 'ok' | 'null' = 'null';
          let mediaSelfMatchLog: string | null = null;
          let mediaSha256 = '';
          try {
            const digest = await crypto.subtle.digest('SHA-256', mediaBytes);
            mediaSha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
          } catch (err) {
            console.warn('[webhook] media sha256 hash failed', err);
          }

          try {
            const { describeVideo, describeAudio } = await import('../services/media-describe.js');
            const description =
              msg.type === 'video'
                ? await describeVideo({ bytes: mediaBytes, contentType: mediaContentType, config: mediaConfig, geminiApiKey, receivedAt })
                : await describeAudio({ bytes: mediaBytes, contentType: mediaContentType, config: mediaConfig, geminiApiKey, receivedAt });
            describeOutcome = description ? 'ok' : 'null';

            if (description) {
              try {
                await db
                  .prepare(`UPDATE messages_log SET content = ? WHERE id = ?`)
                  .bind(
                    JSON.stringify({ originalContentUrl: mediaOriginalContentUrl, visionSummary: description }),
                    imageLogId,
                  )
                  .run();
              } catch (err) {
                console.error('[webhook] media visionSummary UPDATE failed', err);
              }

              const project = await resolveBotProject(db, friend);
              const mediaLabel = msg.type === 'video' ? '動画' : '音声';
              // 動画のみ自己言及判定（キャラの外見特徴は動画にしか乗らない）。判定はWorker側の
              // 決定的な文字列マッチングで行い、LLMの推論には委ねない（_docs/SELF-RECOGNITION-DESIGN.md参照）。
              const selfMatch = msg.type === 'video' ? matchSelfCharacter(description) : null;
              if (selfMatch) {
                console.log('[self-recognition] matched', JSON.stringify(selfMatch));
                mediaSelfMatchLog = selfMatch.character;
              }
              let mediaIncomingText: string;
              if (selfMatch?.character === 'りんく' && selfMatch.confidence === 'high') {
                mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}に写っているのは、あなた自身（りんく）です。ファンが作ってくれたあなたの${mediaLabel}を見せてもらった場面として、一人称で、照れ・喜び・ツッコミなど自分の姿を見たときの感情を素直に伝えてください。${mediaLabel}の中の動き（まばたき・笑顔など）に1つだけ具体的に触れてください。`;
              } else if (selfMatch?.character === 'りんく') {
                mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}に写っているのは、おそらくあなた自身（りんく）です。「わたし…だよね？」と軽く確かめつつ、一人称で嬉しさを伝えてください。`;
              } else if (selfMatch) {
                mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}に写っているのは、あなたの仲間の${selfMatch.character}です。仲間が${mediaLabel}に登場して嬉しい、というあなたらしい反応をしてください。`;
              } else {
                // imageと同じくメタ記法（客観描写タスクだと誤認識させる書き方）を避け、
                // ユーザーが動画/音声を見せてきたという会話的状況として渡す（2026-07-18実障害の教訓）。
                mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}を見て、あなたらしく反応してください。`;
              }
              const groqResult = await runGroqSupportPipeline({
                db,
                apiKey: groqApiKey,
                geminiApiKey,
                workersAi,
                receivedAt,
                lineAccountId,
                friendId: friend.id,
                incomingText: mediaIncomingText,
                project,
                cachePolicy: 'skip',
                excludeLogId: imageLogId,
              });

              if (groqResult.kind === 'canned' || groqResult.kind === 'reply') {
                await sendSafeText(lineClient, event.replyToken, friend.line_user_id, groqResult.text, receivedAt, false);
                await logOutgoingGroqMessage(db, friend.id, groqResult.text, groqResult.kind === 'canned' ? 'groq_canned' : 'groq_reply');
                imageLlmHandled = true;
                mediaOutcome = 'replied';
              } else if (groqResult.kind === 'escalate') {
                await switchToHumanMode(db, friend.id);
                const escalationNotice = groqResult.text || 'ちょっと待っててね、中の人につなぐね。';
                await sendSafeText(lineClient, event.replyToken, friend.line_user_id, escalationNotice, receivedAt, false);
                await logOutgoingGroqMessage(db, friend.id, escalationNotice, 'groq_reply');
                mediaOutcome = 'replied';
              } else if (groqResult.kind === 'fail_closed') {
                await sendSafeText(lineClient, event.replyToken, friend.line_user_id, groqResult.escalationText, receivedAt, false);
                await logOutgoingGroqMessage(db, friend.id, groqResult.escalationText, 'groq_reply');
                mediaOutcome = 'replied';
              }
            } else {
              // description === null（Gemini障害・タイムアウト予算切れ・未対応フォーマット等）。
              // 以前は完全に無言だったが、「既読無視された」ように見える実害があるため、
              // tooLargeNoticeと同じ流儀（LLM非経由の定型文）で一言返す（2026-07-20 BEST-IN-CLASS-DESIGN.md C-1）。
              const mediaLabel = msg.type === 'video' ? '動画' : '音声';
              const failNotice = `ごめんね、いまこの${mediaLabel}をうまく見られなかったみたい…。少し時間をおいてもう一回送ってみてくれる？`;
              await sendSafeText(lineClient, event.replyToken, friend.line_user_id, failNotice, receivedAt, false);
              await logOutgoingGroqMessage(db, friend.id, failNotice, 'groq_reply');
              imageLlmHandled = true;
              mediaOutcome = 'fail_notice';
            }
          } catch (err) {
            console.error('[webhook] media describe pipeline failed', err instanceof Error ? err.stack : String(err));
          } finally {
            console.log('[media-pipeline]', JSON.stringify({
              type: msg.type,
              bytes: mediaBytes.byteLength,
              sha256: mediaSha256,
              outcome: mediaOutcome,
              describe: describeOutcome,
              selfMatch: mediaSelfMatchLog,
              elapsedMs: Date.now() - receivedAt,
            }));
          }
        }
      }
    }

    // text と同様、非 text の自発メッセージ (画像/スタンプ等) でも chat を unread に戻す。
    // これが無いと resolved 除外 (unanswered-inbox CANDIDATES_SQL) が「解決済み後に
    // 画像だけ送ってきた友だち」をバッジ・未対応一覧から永久に落としてしまう。
    // 非 text は auto_reply keyword にマッチし得ないので常に要対応扱いで正しい。
    // 画像へのAI返信が成功した場合はテキスト経路のllmHandled=trueと同じ扱いで
    // unread化をスキップする（§7.3）。
    if (!imageLlmHandled) {
      await upsertChatOnMessage(db, friend.id);
    }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const textMessage = event.message as TextEventMessage;
    const userId =
      event.source.type === 'user' ? event.source.userId : undefined;
    if (!userId) return;

    const friend = await ensureFriendFromWebhookUser(db, lineClient, userId, lineAccountId);
    if (!friend) return;

    const incomingText = textMessage.text;
    const now = jstNow();
    const logId = crypto.randomUUID();

    // 受信メッセージをログに記録
    await db
      .prepare(
        `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, source, created_at)
         VALUES (?, ?, 'incoming', 'text', ?, NULL, NULL, 'user', ?)`,
      )
      .bind(logId, friend.id, incomingText, now)
      .run();

    // Cross-account trigger: send message from another account via UUID
    if (incomingText === '体験を完了する' && lineAccountId) {
      try {
        const friendRecord = await db.prepare('SELECT user_id FROM friends WHERE id = ?').bind(friend.id).first<{ user_id: string | null }>();
        if (friendRecord?.user_id) {
          // Find the same user on other accounts
          const otherFriends = await db.prepare(
            'SELECT f.line_user_id, la.channel_access_token FROM friends f INNER JOIN line_accounts la ON la.id = f.line_account_id WHERE f.user_id = ? AND f.line_account_id != ? AND f.is_following = 1'
          ).bind(friendRecord.user_id, lineAccountId).all<{ line_user_id: string; channel_access_token: string }>();

          for (const other of otherFriends.results) {
            const otherClient = new LineClient(other.channel_access_token);
            const { buildMessage: bm } = await import('../services/step-delivery.js');
            await otherClient.pushMessage(other.line_user_id, [bm('flex', JSON.stringify({
              type: 'bubble', size: 'giga',
              header: { type: 'box', layout: 'vertical', paddingAll: '20px', backgroundColor: '#fffbeb',
                contents: [{ type: 'text', text: `${friend.display_name || ''}さんへ`, size: 'lg', weight: 'bold', color: '#1e293b' }],
              },
              body: { type: 'box', layout: 'vertical', paddingAll: '20px',
                contents: [
                  { type: 'text', text: '別アカウントからのアクションを検知しました。', size: 'sm', color: '#06C755', weight: 'bold', wrap: true },
                  { type: 'text', text: 'アカウント連携が正常に動作しています。体験ありがとうございました。', size: 'sm', color: '#1e293b', wrap: true, margin: 'md' },
                  { type: 'separator', margin: 'lg' },
                  { type: 'text', text: 'ステップ配信・フォーム即返信・アカウント連携・リッチメニュー・自動返信 — 全て無料、全てOSS。', size: 'xs', color: '#64748b', wrap: true, margin: 'lg' },
                ],
              },
              footer: { type: 'box', layout: 'vertical', paddingAll: '16px',
                contents: [
                  { type: 'button', action: { type: 'message', label: '導入について相談する', text: '導入支援を希望します' }, style: 'primary', color: '#06C755' },
                  ...(liffUrl ? [{ type: 'button', action: { type: 'uri', label: 'フィードバックを送る', uri: `${liffUrl}?page=form` }, style: 'secondary', margin: 'sm' }] : []),
                ],
              },
            }))]);
          }

          // Reply on Account ② confirming
          await lineClient.replyMessage(event.replyToken, [buildMessage('flex', JSON.stringify({
            type: 'bubble',
            body: { type: 'box', layout: 'vertical', paddingAll: '20px',
              contents: [
                { type: 'text', text: 'Account ① にメッセージを送りました', size: 'sm', color: '#06C755', weight: 'bold', align: 'center' },
                { type: 'text', text: 'Account ① のトーク画面を確認してください', size: 'xs', color: '#64748b', align: 'center', margin: 'md' },
              ],
            },
          }))]);
          return;
        }
      } catch (err) {
        console.error('Cross-account trigger error:', err);
      }
    }

    // 自動返信チェック（このアカウントのルール + グローバルルールのみ）
    // NOTE: Auto-replies use replyMessage (free, no quota) instead of pushMessage
    // The replyToken is only valid for ~1 minute after the message event
    const autoReplyQuery = lineAccountId
      ? `SELECT * FROM auto_replies WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`
      : `SELECT * FROM auto_replies WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at ASC`;
    const autoReplyStmt = db.prepare(autoReplyQuery);
    const autoReplies = await (lineAccountId ? autoReplyStmt.bind(lineAccountId) : autoReplyStmt)
      .all<{
        id: string;
        keyword: string;
        match_type: 'exact' | 'contains';
        response_type: string;
        response_content: string;
        template_id: string | null;
        is_active: number;
        created_at: string;
      }>();

    let matched = false;
    let replyTokenConsumed = false;
    for (const rule of autoReplies.results) {
      const isMatch =
        rule.match_type === 'exact'
          ? incomingText === rule.keyword
          : incomingText.includes(rule.keyword);

      if (isMatch) {
        // silent タイプ: 返信しないが matched=true にして unread / push を抑止する
        if (rule.response_type === 'silent') {
          matched = true;
          break;
        }

        try {
          const { resolveMetadata: resolveMeta2 } = await import('../services/step-delivery.js');
          const resolvedMeta2 = await resolveMeta2(db, { user_id: (friend as unknown as Record<string, string | null>).user_id, metadata: (friend as unknown as Record<string, string | null>).metadata });
          const resolved = await resolveAutoReplyContent(db, {
            template_id: rule.template_id,
            response_type: rule.response_type,
            response_content: rule.response_content,
          });
          const expandedContent = expandVariables(resolved.content, { ...friend, metadata: resolvedMeta2 } as Parameters<typeof expandVariables>[1], workerUrl, resolved.messageType);
          const replyMsg = buildMessage(resolved.messageType, expandedContent);
          await lineClient.replyMessage(event.replyToken, [replyMsg]);
          replyTokenConsumed = true;

          // 送信ログ（replyMessage = 無料）— derive content from the built
          // reply message so any cleanEmptyNodes / parse-failure fallback is
          // reflected in the dashboard.
          const outLogId = crypto.randomUUID();
          const { messageToLogPayload: logPayload2 } = await import('../services/step-delivery.js');
          const wbAutoReplyPayload = logPayload2(replyMsg);
          await db
            .prepare(
              `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
               VALUES (?, ?, 'outgoing', ?, ?, NULL, NULL, 'reply', 'auto_reply', ?)`,
            )
            .bind(outLogId, friend.id, wbAutoReplyPayload.messageType, wbAutoReplyPayload.content, jstNow())
            .run();
        } catch (err) {
          console.error('Failed to send auto-reply', err);
        }

        matched = true;
        break;
      }
    }

    // auto_replies にマッチしなかった = 自発メッセージ
    // オペレーターが引き継ぎ済み(ai_reply_mode='human')でなければ、LLM フォールバックを試みる。
    // llmHandled=true は「人間の unread 対応が不要になった」ことを意味する
    // （エスカレーション自体は unread が必要なので false のまま扱う）。
    let llmHandled = false;
    const aiReplyMode = (friend as unknown as { ai_reply_mode?: string }).ai_reply_mode;
    if (!matched && aiReplyMode !== 'human') {
      const logOutgoingGroq = (text: string, source: 'groq_reply' | 'groq_canned') =>
        logOutgoingGroqMessage(db, friend.id, text, source);

      const safeSendText = async (text: string): Promise<void> => {
        const replied = await sendSafeText(lineClient, event.replyToken, friend.line_user_id, text, receivedAt, replyTokenConsumed);
        if (replied) replyTokenConsumed = true;
      };

      // "個人AI社員" タスクキュー入口: "タスク:" で始まるメッセージは、
      // 許可された送信者（開発者本人）からのものだけ GitHub Issue 化する。
      // 未許可の送信者からの同一文言は素通りさせ、下の通常GROQフローに委ねる
      // （＝顧客が偶然「タスク:」と打っても何も特別なことは起きない）。
      if (isTaskMessage(incomingText) && isAuthorizedTaskSender(userId)) {
        try {
          const taskBody = extractTaskBody(incomingText);
          const result = await createAiShainTask(githubToken, taskBody, friend.display_name);
          const replyText = result.created
            ? `タスクを登録しました。\n${result.issueUrl}`
            : `タスク登録に失敗しました: ${result.error ?? '不明なエラー'}`;
          await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: replyText }]);
          replyTokenConsumed = true;
          await logOutgoingGroq(replyText, 'groq_reply');
          llmHandled = true;
        } catch (err) {
          console.error('ai-shain-worker task creation failed', err instanceof Error ? err.stack : String(err));
          if (!replyTokenConsumed) {
            try {
              const fallbackText = 'すみません、タスク登録処理でエラーが発生しました。';
              await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: fallbackText }]);
              replyTokenConsumed = true;
              await logOutgoingGroq(fallbackText, 'groq_reply');
            } catch (replyErr) {
              console.error('Task creation failure fallback reply also failed', replyErr instanceof Error ? replyErr.stack : String(replyErr));
            }
          }
        }
      } else if (groqApiKey) {
        try {
          const project = await resolveBotProject(db, friend);

          // URL認識（2026-07-17 Fable設計「画像認識・URL認識機能」§2.2）: ガード不通過・
          // fetch失敗・タイムアウトはすべてnullになり、通常のテキスト応答に静かに
          // フォールバックする（fail-closed。URLを知らないふりをして応答する）。
          const urlContextConfig = getBotConfig().urlContext;
          let externalContext: string | undefined;
          if (urlContextConfig.enabled) {
            const firstUrl = extractFirstUrl(incomingText);
            if (firstUrl) {
              const extracted = await fetchUrlContext(firstUrl, urlContextEnv, {
                timeoutMs: urlContextConfig.timeoutMs,
                maxContentBytes: urlContextConfig.maxContentBytes,
                maxExtractChars: urlContextConfig.maxExtractChars,
              });
              if (extracted) externalContext = extracted;
            }
          }

          const groqResult = await runGroqSupportPipeline({
            db,
            apiKey: groqApiKey,
            geminiApiKey,
            workersAi,
            receivedAt,
            lineAccountId,
            friendId: friend.id,
            incomingText,
            project,
            externalContext,
            cachePolicy: externalContext ? 'skip' : 'normal',
            // 履歴の最後に今回のテキスト行(logId)自体が紛れ込むのを防ぐ。テキストの
            // 場合は履歴側とincomingTextが同一文字列なので実害は無いが、画像経路と
            // 同じ扱いに揃えて一貫させる（2026-07-19 実障害の修正、groq-reply.ts参照）。
            excludeLogId: logId,
          });

          if (groqResult.kind === 'canned' || groqResult.kind === 'reply') {
            const replyText = groqResult.text;
            const imageKey = groqResult.kind === 'canned' ? groqResult.imageUrl : undefined;
            if (imageKey && workerUrl) {
              // 画像付き返信はsafeSendTextの対象外（テキスト専用ヘルパーのため）。
              // 失敗時は従来通り例外を投げさせ、下のcatchの詫び文言フォールバックに委ねる。
              const imageUrl = `${workerUrl}/images/${imageKey}`;
              await lineClient.replyMessage(event.replyToken, [
                { type: 'text', text: replyText },
                { type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl },
              ]);
              replyTokenConsumed = true;
            } else {
              await safeSendText(replyText);
            }
            await logOutgoingGroq(replyText, groqResult.kind === 'canned' ? 'groq_canned' : 'groq_reply');
            llmHandled = true;
          } else if (groqResult.kind === 'escalate') {
            await switchToHumanMode(db, friend.id);
            // エスカレーション時は無言にしない。groqResult.text（[ESCALATE]除去後の本文）が
            // 空でも、ユーザーには必ず「担当者につなぐ」ことが分かる一言を返す。
            // これが無いと human モードへの切替えだけが起きて「既読無視」に見える
            // （2026-07-16 実障害: 著作権相談の会話が続いた末にテキスト無しでエスカレートし、
            // 以降そのユーザーへのAI応答が完全に止まった）。safeSendTextによりreplyToken
            // 失効時もpushMessageで確実に届く。
            const escalationNotice = groqResult.text || 'ちょっと待っててね、中の人につなぐね。';
            await safeSendText(escalationNotice);
            await logOutgoingGroq(escalationNotice, 'groq_reply');
          } else if (groqResult.kind === 'fail_closed') {
            await safeSendText(groqResult.escalationText);
            await logOutgoingGroq(groqResult.escalationText, 'groq_reply');
          }
        } catch (err) {
          // runGroqSupportPipeline自体が想定外の例外を投げた場合（ネットワーク断・D1エラー・
          // コードバグ等）。ここまでの各分岐(canned/reply/escalate/fail_closed)はすべて
          // pipeline内部で吸収済みの正常系なので、この catch に来るのは本当に予期しない失敗のみ。
          // 何も返さずに終わるとユーザーには「既読無視」に見えるため、最終防波堤として
          // 固定の詫び文言だけは必ず返す（safeSendTextがreplyToken失効時もpushで届ける）。
          console.error('Groq support pipeline failed', err instanceof Error ? err.stack : String(err));
          if (!replyTokenConsumed) {
            try {
              const fallbackText = 'すみません、うまく応答できませんでした。少し時間をおいて、もう一度お試しください。';
              await safeSendText(fallbackText);
              await logOutgoingGroq(fallbackText, 'groq_reply');
            } catch (replyErr) {
              console.error('Groq failure fallback reply also failed', replyErr instanceof Error ? replyErr.stack : String(replyErr));
            }
          }
        }
      } else if (anthropicApiKey) {
        try {
          const llmResult = await generateLlmReply({
            db,
            apiKey: anthropicApiKey,
            lineAccountId,
            friendId: friend.id,
            incomingText,
          });

          if (llmResult.kind === 'reply' && llmResult.text) {
            await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: llmResult.text }]);
            replyTokenConsumed = true;
            await db
              .prepare(
                `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
                 VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', 'llm_reply', ?)`,
              )
              .bind(crypto.randomUUID(), friend.id, llmResult.text, jstNow())
              .run();
            llmHandled = true;
          } else if (llmResult.kind === 'escalate') {
            await switchToHumanMode(db, friend.id);
            if (llmResult.text) {
              await lineClient.replyMessage(event.replyToken, [{ type: 'text', text: llmResult.text }]);
              replyTokenConsumed = true;
              await db
                .prepare(
                  `INSERT INTO messages_log (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id, delivery_type, source, created_at)
                   VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'reply', 'llm_reply', ?)`,
                )
                .bind(crypto.randomUUID(), friend.id, llmResult.text, jstNow())
                .run();
            }
          }
        } catch (err) {
          console.error('LLM reply failed', err);
        }
      }
    }

    // auto_replies にも LLM 通常応答にもマッチ/対応しなかった = 人間対応が必要 → unread にする
    // (LLM がエスカレーションした場合もここを通る。upsertChatOnMessage は冪等なので二重呼び出し安全)
    if (!matched && !llmHandled) {
      await upsertChatOnMessage(db, friend.id);
    }

    // イベントバス発火: message_received
    // Pass replyToken only when auto_reply / LLM reply didn't actually consume it
    await fireEvent(db, 'message_received', {
      friendId: friend.id,
      eventData: { text: incomingText, matched: matched || llmHandled },
      replyToken: replyTokenConsumed ? undefined : event.replyToken,
    }, lineAccessToken, lineAccountId);

    return;
  }
}

/**
 * auto_reply 行の content/type を resolve する。template_id が set なら templates
 * から取得、参照切れや NULL のときは inline response_content/response_type を使う。
 */
async function resolveAutoReplyContent(
  db: D1Database,
  rule: { template_id: string | null; response_type: string; response_content: string },
): Promise<{ messageType: string; content: string }> {
  if (rule.template_id) {
    const { getTemplateById } = await import('@line-crm/db');
    const tpl = await getTemplateById(db, rule.template_id);
    if (tpl) {
      return { messageType: tpl.message_type, content: tpl.message_content };
    }
  }
  return { messageType: rule.response_type, content: rule.response_content };
}

export { webhook };
