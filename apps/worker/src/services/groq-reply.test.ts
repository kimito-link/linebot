import { describe, expect, it } from 'vitest';
import { getGroqReplyConfig, buildGroqHistory } from './groq-reply.js';

function fakeDb(settings: Array<{ value: string }> = []): D1Database {
  return {
    prepare(sql: string) {
      const isSettings = sql.includes('account_settings');
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async first<T>(): Promise<T | null> {
          if (isSettings) return (settings[0] as T) ?? null;
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: [] };
        },
        async run(): Promise<unknown> {
          return { success: true };
        },
      };
    },
  } as unknown as D1Database;
}

describe('getGroqReplyConfig', () => {
  it('returns disabled without lineAccountId', async () => {
    const config = await getGroqReplyConfig(fakeDb(), null);
    expect(config.enabled).toBe(false);
  });

  it('returns enabled when groq_reply_enabled=true', async () => {
    const db = fakeDb([{ value: 'true' }]);
    const config = await getGroqReplyConfig(db, 'acc1');
    expect(config.enabled).toBe(true);
  });
});

// Groq本体へのHTTP呼び出しテストは llm-providers.test.ts に移設済み
// （2026-07-17: generateGroqReply を llm-providers.ts の callGroq() に統合したため）。

function fakeHistoryDb(rows: Array<{ direction: string; content: string; message_type: string }>): D1Database {
  return {
    prepare(_sql: string) {
      return {
        bind(..._args: unknown[]) {
          return this;
        },
        async all<T>(): Promise<{ results: T[] }> {
          return { results: rows as unknown as T[] };
        },
      };
    },
  } as unknown as D1Database;
}

describe('buildGroqHistory', () => {
  it('maps text rows directly and reverses to chronological order', async () => {
    // DB returns DESC (newest first); function should reverse to oldest-first.
    const db = fakeHistoryDb([
      { direction: 'outgoing', content: '2番目のメッセージ', message_type: 'text' },
      { direction: 'incoming', content: '1番目のメッセージ', message_type: 'text' },
    ]);
    const history = await buildGroqHistory(db, 'friend-1');
    expect(history).toEqual([
      { role: 'user', content: '1番目のメッセージ' },
      { role: 'assistant', content: '2番目のメッセージ' },
    ]);
  });

  it('converts an image row with visionSummary to a bracketed history entry', async () => {
    const db = fakeHistoryDb([
      {
        direction: 'incoming',
        content: JSON.stringify({
          originalContentUrl: 'https://x/images/a.jpg',
          previewImageUrl: 'https://x/images/a.jpg',
          visionSummary: '猫が写っている写真です。',
        }),
        message_type: 'image',
      },
    ]);
    const history = await buildGroqHistory(db, 'friend-1');
    expect(history).toEqual([{ role: 'user', content: '[画像: 猫が写っている写真です。]' }]);
  });

  it('falls back to [画像] when the image row has no visionSummary', async () => {
    const db = fakeHistoryDb([
      {
        direction: 'incoming',
        content: JSON.stringify({ originalContentUrl: 'https://x/images/a.jpg', previewImageUrl: 'https://x/images/a.jpg' }),
        message_type: 'image',
      },
    ]);
    const history = await buildGroqHistory(db, 'friend-1');
    expect(history).toEqual([{ role: 'user', content: '[画像]' }]);
  });

  it('falls back to [画像] when the image row content is the legacy label string (not JSON)', async () => {
    const db = fakeHistoryDb([{ direction: 'incoming', content: '[画像]', message_type: 'image' }]);
    const history = await buildGroqHistory(db, 'friend-1');
    expect(history).toEqual([{ role: 'user', content: '[画像]' }]);
  });
});
