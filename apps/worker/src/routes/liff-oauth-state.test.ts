import { describe, it, expect, vi } from 'vitest';

// OAuth state の符号化が日本語で壊れないことを、**実際のルートを叩いて**固定する。
//
// btoa() は Latin-1 しか受け取らない。日本語を含むクエリが1つでも混ざると
// InvalidCharacterError を投げ、/auth/line が500になって**導線ごと落ちる**。
// 日本語のキャンペーン名を使えば確実に踏む。
//
// ヘルパ関数を複製して単体で確かめる書き方もあるが、それだと**実装を変えても
// テストは緑のまま**になる。ここでは liff.ts の実物を通す。

const dbMocks = {
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
  getLineAccountByChannelId: vi.fn().mockResolvedValue(null),
  getLineAccountById: vi.fn().mockResolvedValue(null),
  getEntryRouteByRefCode: vi.fn().mockResolvedValue(null),
  getTrafficPoolBySlug: vi.fn().mockResolvedValue(null),
};
vi.mock('@line-crm/db', () => dbMocks);

const { liffRoutes } = await import('./liff.js');

const env = {
  DB: {} as never,
  LINE_LOGIN_CHANNEL_ID: '1234567890',
  LINE_LOGIN_CHANNEL_SECRET: 'test-secret',
  WORKER_PUBLIC_URL: 'https://example.workers.dev',
  // /auth/line は LIFF URL からIDを取り出すので、無いと別の理由で500になる
  // （この修正とは無関係の失敗で赤くなるのを防ぐ）
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

/**
 * /auth/line を叩き、OAuthリダイレクト先の state を取り出す。
 *
 * state が実際に載るのは **モバイルUA かつ account 指定** の分岐
 * （cross-account リンクは OAuth へ直行する）。PCだと「LINEで開く」HTMLが返り、
 * モバイルで ref だけだと /r/:ref へ飛ぶので、いずれも state が見えない。
 */
async function getStateFrom(query: string): Promise<{ status: number; state: string | null }> {
  const res = await liffRoutes.fetch(
    new Request(`https://example.workers.dev/auth/line${query}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
    }),
    env,
  );
  const loc = res.headers.get('location');
  if (!loc) return { status: res.status, state: null };
  return { status: res.status, state: new URL(loc).searchParams.get('state') };
}

/** 実装と同じ復号（state を読む側の互換性を確かめるため） */
function decodeState(encoded: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(encoded), (ch) => ch.charCodeAt(0)));
}

describe('/auth/line — OAuth state の符号化', () => {
  it('★日本語のUTMパラメータで500にならない（修正前はここで落ちた）', async () => {
    const { status } = await getStateFrom(
      '?account=%40kimitolink&ref=kimitotalk&utm_campaign=' + encodeURIComponent('夏キャンペーン'),
    );
    expect(status).not.toBe(500);
  });

  it('★日本語を含む state が正しく復号できる', async () => {
    const { state } = await getStateFrom(
      '?account=%40kimitolink&ref=kimitotalk&utm_campaign=' + encodeURIComponent('夏キャンペーン') +
      '&utm_medium=' + encodeURIComponent('広告'),
    );
    expect(state).toBeTruthy();
    const parsed = JSON.parse(decodeState(state as string));
    expect(parsed.utmCampaign).toBe('夏キャンペーン');
    expect(parsed.utmMedium).toBe('広告');
    expect(parsed.ref).toBe('kimitotalk');
  });

  it('絵文字（サロゲートペア）でも壊れない', async () => {
    const { status, state } = await getStateFrom(
      '?account=%40kimitolink&ref=a&utm_campaign=' + encodeURIComponent('🎉夏祭り🎊'),
    );
    expect(status).not.toBe(500);
    expect(JSON.parse(decodeState(state as string)).utmCampaign).toBe('🎉夏祭り🎊');
  });

  it('ASCIIのみの state も従来どおり動く（回帰がない）', async () => {
    const { status, state } = await getStateFrom('?account=%40kimitolink&ref=kimitotalk&utm_source=x');
    expect(status).not.toBe(500);
    const parsed = JSON.parse(decodeState(state as string));
    expect(parsed.ref).toBe('kimitotalk');
    expect(parsed.utmSource).toBe('x');
  });

  it('★修正前の符号化で作られた state も復号できる（発行済みリンクを壊さない）', () => {
    const state = JSON.stringify({ ref: 'kimitotalk', redirect: '/thanks' });
    expect(decodeState(btoa(state))).toBe(state); // btoa = 修正前の符号化
  });
});
