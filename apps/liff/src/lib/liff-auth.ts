import liff from '@line/liff';

let _liffId: string | null = null;
let _lineUserId: string | null = null;
let _idToken: string | null = null;

/**
 * ★検証用モード（VITE_LIFF_MOCK=1 のビルドでのみ有効）。
 *
 *   LIFF は LINE アプリの外で開くと LINE ログインへ飛ぶため、
 *   PC のブラウザ（自動化を含む）では画面まで到達できない。
 *   LINE 公式の @line/liff-mock は、まさにこれを避けるために用意されている
 *   （liff.init が LINE のサーバーへ問い合わせなくなる）。
 *
 *   ★ログイン画面を自動で突破するようなことはしない。規約が禁じている。
 *
 *   本番ビルドには入らない:
 *     - import.meta.env.VITE_LIFF_MOCK は build 時に定数へ畳み込まれる
 *     - 偽なら下の動的 import ごと Vite が消す（tree-shaking）
 *     - パッケージ自体も devDependencies
 */
const MOCK = import.meta.env.VITE_LIFF_MOCK === '1';

// ★$mock と init の mock は LiffMockPlugin が実行時に足すもので、SDK の型には無い。
//   any で潰すと他の liff.* まで型検査が効かなくなるので、この2つだけを局所的に宣言する。
type MockData = Record<string, unknown>;
type LiffWithMock = typeof liff & {
  $mock: { set(f: (prev: MockData) => MockData): void; clear(): void };
  init(config: { liffId: string; mock?: boolean }): Promise<void>;
};

export async function initLiff(): Promise<void> {
  const url = new URL(window.location.href);
  const liffId = url.searchParams.get('liffId') ?? import.meta.env.VITE_DEFAULT_LIFF_ID;
  if (!liffId) {
    throw new Error('liffId not provided. Append ?liffId=... to the URL.');
  }
  _liffId = liffId;

  if (MOCK) {
    const { LiffMockPlugin } = await import('@line/liff-mock');
    liff.use(new LiffMockPlugin());
    const l = liff as LiffWithMock;

    // ★既定は isLoggedIn:false / isInClient:false なので明示的に上書きする。
    l.$mock.set((p) => ({
      ...p,
      isLoggedIn: true,
      isInClient: true,
      getProfile: { displayName: '検証用', userId: 'U_mock_preview' },
      getIDToken: 'mock_id_token',
    }));

    await l.init({ liffId, mock: true });

    // ★getProfile / getIDToken はモック値ではなく「login が呼ばれたか」を見ている
    //   （liff-mock の getProfile は globalStore.isLoginCalled を確認して投げる）。
    //   $mock で isLoggedIn:true にしても、login を通さないと必ず失敗する。
    //   実測 2026-09-03: "You need to call liff.login first." で画面が出なかった。
    liff.login();
  } else {
    await liff.init({ liffId });
  }

  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  const profile = await liff.getProfile();
  _lineUserId = profile.userId;
  // id_token は Worker 側で LINE Login verify API を叩いて caller を確定するために使う。
  _idToken = liff.getIDToken();
}

export function getLiffId(): string {
  if (!_liffId) throw new Error('LIFF not initialized');
  return _liffId;
}

export function getLineUserId(): string {
  if (!_lineUserId) throw new Error('LIFF not initialized');
  return _lineUserId;
}

export function getIdToken(): string {
  if (!_idToken) throw new Error('LIFF not initialized or id_token not available');
  return _idToken;
}
