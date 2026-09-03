# LIFF の画面を LINE アプリ無しで見る（確立した手順・2026-09-03）

LIFF は LINE アプリの外で開くと LINE ログインへ飛ぶため、PC のブラウザでは
画面まで到達できない。**LINE 公式の `@line/liff-mock` を使えば見られる。**

★**LINE ログイン画面を自動で突破することはしない。** LINEヤフー共通利用規約が
ボット等による自動操作を禁じている。モックはまさにこれを避けるために
LINE が公式提供している仕組み（liff.init が LINE のサーバーへ問い合わせなくなる）。

## 手順

```bash
# 1) 検証用ビルド（本番の dist は壊さない）
cd apps/liff
VITE_LIFF_MOCK=1 npx vite build --outDir dist-mock

# 2) APIモック付きサーバー（dist-mock を配信する）
node _docs/demo-talent-liff/serve.mjs

# 3) 開く
#    http://localhost:5180/events/evt-talent-demo-1123?liffId=2010492622-XPBsRwnD
```

実測（2026-09-03）: 「【デモ】11月23日 〇〇ホール 舞台公演 … **3人が参加予定です**」
まで表示。JSエラー 0件。

## ★本番には入らない

| 確かめたこと | 結果 |
|---|---|
| `VITE_LIFF_MOCK` 無しでビルド | `liff-mock` / `$mock` / `mock_id_token` が **0件** |
| 本番ビルドの JS ハッシュ | `index-9ca0c5Q9.js` — **本番と同一。出荷物は1バイトも変わらない** |
| パッケージの位置 | `devDependencies` |

`import.meta.env.VITE_LIFF_MOCK` は build 時に定数へ畳み込まれ、偽なら
動的 import ごと Vite が消す（検証用ビルドでは別チャンク 19KB に分離される）。

## ★踏んだ罠

**① `$mock.set` で `isLoggedIn: true` にしても getProfile が通らない**

```
起動できませんでした You need to call liff.login first.
```

`liff-mock` の `getProfile` はモック値ではなく **`globalStore.isLoginCalled`**
を見ている（`dist/api/getProfile.js`）。`$mock` で偽装しても
**`liff.login()` を実際に一度呼ばないと必ず失敗する**。
→ `init` の直後に `liff.login()` を呼ぶ（モックなので画面遷移は起きない）。

**② モックサーバーの返す形が本番と違っていた**

`/api/liff/events/:id/slots` は配列ではなく **`{items:[...]}`**。
画面は `s.items` を読む（`lib/api.ts:142`）ので、配列だと常に空になる。
`/api/liff/events/me` も同じく `{items:[]}`。

**③ 過去に同じことを試して失敗している（`d97ca11`）**

「API をモックしても `liff.init()` が LINE のサーバーへ問い合わせるので越えられない」
という記録が残っていた。**足りなかったのは liff-mock の一手だけ**だった。

## 参考: 本番の経路（2026-09-03 実測・すべて生きている）

```
https://liff.line.me/2010492622-XPBsRwnD/events/evt-talent-demo-1123
  → Worker /liff              302 …/events/evt-talent-demo-1123
  → Pages                     200
  → API slots                 {"items":[{ … "active_count":3 … }]}
```

Worker: `https://kimitolink-line.info-a40.workers.dev`
Pages:  `https://kimitolink-line-liff.pages.dev`

## ★未解決: 未ログインの方に「白い0.5秒」が見える

外部ブラウザで未ログインだと、LINE ログインへ飛ぶまでの約0.5秒、
**何も表示されない**（`index.html` の `#root` が空、`main.tsx` は
`initLiff()` の解決前に render しない）。実測:

```
0ms    root=0          ← 真っ白
500ms  access.line.me  ← ログインへ
```

「まっしろ」という報告の正体はこれ。直すなら `index.html` に
読み込み中の表示を置く。
