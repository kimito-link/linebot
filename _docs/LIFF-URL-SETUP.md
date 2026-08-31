# LIFF_URL が未設定 — 使うときに要る設定（2026-08-31 発見）

本番の `/auth/line` と `/r/:ref` が**503**を返す。原因は `LIFF_URL` secret の未設定。

**いま困っていない**（LPのCTAはLINE公式URLへ直行するのでLIFFを経由しない）。
下の機能を使い始めるときに要る。

---

## 何が動かないか

| 機能 | LIFFが要るか |
|---|---|
| LPからの友だち追加 | **不要**（`https://line.me/R/ti/p/@kimitolink` へ直行） |
| Botの会話・音声返信 | **不要** |
| 予約・フォーム | **要る** |
| アフィリエイト導線（`/r/:ref`） | **要る** |
| 広告のクリックID計測 | **要る** |

---

## 設定のしかた

1. LINE Developers → 対象のチャネル → **LIFF** タブ
2. LIFFアプリが無ければ追加（エンドポイントURLは `https://<Workerのドメイン>/liff`）
3. 発行された **LIFF ID**（`1234567890-abcdefgh` の形）を控える
4. secret を設定する:

```bash
cd apps/worker
npx wrangler secret put LIFF_URL --name kimitolink-line
# 値: https://liff.line.me/<LIFF ID>
```

`LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` も同様に要る
（LINE Developers の **LINE Login** チャネルから取る）。

---

## 確認

```bash
curl -s -o /dev/null -w '%{http_code}\n' "https://kimitolink-line.info-a40.workers.dev/auth/line?ref=kimitotalk"
```

- **503** → まだ未設定
- **200** → 設定できた

---

## なぜ503で止まるようになっているか

以前は**真っ白な500**（Internal Server Error）だった。`liffUrl.match()` が
`undefined` を触って落ちていたため。原因に辿り着くまでが遠かった。

`connection-registry.ts` は `line-login` を `degrade: 'feature-off'`
（機能が無効になるだけ）と宣言していたのに、実装は500で落ちていた。
**宣言と実装が食い違っていた**のが本質で、宣言どおりに振る舞わせた。

設定漏れは「壊れた」ではなく「まだ使えない」として扱う。
どちらか分からない状態が一番調べにくい。

---

## 済んだら消していい

このファイルは申し送り。`LIFF_URL` を設定して `/auth/line` が200になったら、
**このファイルごと消す**。残っていると「まだやることがある」と誤解される。
