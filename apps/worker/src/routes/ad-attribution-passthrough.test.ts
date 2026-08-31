import { describe, it, expect, vi } from 'vitest';

// 広告のクリックID・UTMが導線の途中で消えないことを固定する。
//
// /auth/line はこれらを読んでクエリ全体を /r/:ref に渡すが、/r/:ref 側は
// liffParams を**許可リストで組み直す**ので、そこに無いパラメータは黙って消える。
// QR/PC経路（qrParams）も同じ構造。
//
// 消えてもエラーは出ない。**広告費を払った分の計測だけが静かに失われる**ので、
// テストが無いと気づけない類の穴。

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
  LIFF_URL: 'https://liff.line.me/1234567890-abcdefgh',
};

const AD_PARAMS =
  'gclid=G123&fbclid=F456&twclid=T789&ttclid=TT012' +
  '&utm_source=google&utm_medium=cpc&utm_campaign=summer';

/**
 * PC（非モバイル）で /auth/line を叩き、QRが指すLIFF URLを取り出す。
 *
 * PCでは「LINEで開く」HTMLが返り、その中の QR 画像が
 * `/api/qr?...&data=<URLエンコードされたLIFF URL>` の形で目的のURLを持つ。
 * 素の https://liff.line.me/... としては現れないので、data= を復号して取る。
 */
async function pcQrUrl(query: string): Promise<string> {
  const res = await liffRoutes.fetch(
    new Request(`https://example.workers.dev/auth/line${query}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    }),
    env,
  );
  const body = await res.text();
  const m = body.match(/\/api\/qr\?[^"']*?data=([^"'&]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

describe('広告パラメータの引き継ぎ', () => {
  it('★QR/PC経路でクリックIDとUTMが落ちない', async () => {
    const url = await pcQrUrl(`?ref=kimitotalk&${AD_PARAMS}`);
    expect(url).toBeTruthy();
    // QRのURLはHTML内でエスケープされることがあるので、素の文字列で見る
    for (const [key, value] of [
      ['gclid', 'G123'], ['fbclid', 'F456'], ['twclid', 'T789'], ['ttclid', 'TT012'],
      ['utm_source', 'google'], ['utm_medium', 'cpc'], ['utm_campaign', 'summer'],
    ]) {
      expect(url, `${key} が消えている`).toContain(`${key}=${value}`);
    }
  });

  it('広告パラメータが無いときに空のキーを足さない', async () => {
    const url = await pcQrUrl('?ref=kimitotalk');
    expect(url).not.toContain('gclid=');
    expect(url).not.toContain('utm_source=');
  });

  it('既存のパラメータ（ref/liffId）は従来どおり載る', async () => {
    const url = await pcQrUrl(`?ref=kimitotalk&${AD_PARAMS}`);
    expect(url).toContain('ref=kimitotalk');
    expect(url).toContain('liffId=');
  });

  it('日本語のキャンペーン名でも落ちない（UTF-8 state修正との組み合わせ）', async () => {
    const url = await pcQrUrl(
      '?ref=kimitotalk&utm_campaign=' + encodeURIComponent('夏キャンペーン'),
    );
    expect(url).toBeTruthy();
    expect(decodeURIComponent(url)).toContain('夏キャンペーン');
  });
});
