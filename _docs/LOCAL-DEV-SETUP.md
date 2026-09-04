# ローカルで画面を触れるようにする（2026-09-04 確立・実測）

管理画面(apps/web)を、本番のD1やCloudflareの資格情報なしに、手元だけで動かして
実際にクリックして確かめるための手順。**Cloudflareのアカウントは要らない。**

## なぜ要るか

これが無いと、画面の変更を「型が通った」「ビルドが通った」までしか確かめられない。
実際に押して動くかは本番に出すまで分からず、事故を本番で発見することになる。

## 1回だけの準備

### (a) worker のローカル秘密
`apps/worker/.dev.vars` を作る（★.gitignore 済み。本番の値は絶対に入れない）:
```
API_KEY = "localdev"
LINE_CHANNEL_ACCESS_TOKEN = "dummy-local-token"
LINE_CHANNEL_SECRET = "dummy-local-secret"
ADMIN_AUTH_SAME_SITE = "Lax"
```
`API_KEY` が管理画面のログインキーになる（`middleware/auth.ts` の env フォールバック）。

### (b) web の向き先
`apps/web/.env.local`（★.gitignore 済み）:
```
NEXT_PUBLIC_API_URL=http://127.0.0.1:8787
```

## 毎回の起動

```bash
# 1) ローカル用の wrangler 設定を作る（正本から生成。手書きコピーを作らない）
node apps/worker/scripts/make-dev-config.mjs

# 2) worker（ローカルD1つき）
cd apps/worker
npx wrangler dev --config wrangler.dev.toml --local --port 8787 --persist-to .wrangler/state

# 3) web（別ターミナル）
cd apps/web && npx next dev --port 3001
```

http://127.0.0.1:3001/login を開き、APIキーに `localdev` を入れる。

## ★踏んだ地雷（同じところで止まらないために）

1. **`npx vite dev` は使えない**
   `Failed to start the remote proxy session` で落ちる。`[ai]`（Workers AI）に
   ローカル実装が無く、常にリモートへ繋ごうとするため。Cloudflareの資格情報が
   無い環境では詰む。→ `wrangler dev --local` を使う。

2. **素の wrangler.toml でも落ちる**
   `Cannot apply deleted_classes migration to non-existent class TenantScheduler`。
   本番に焼き付いた Durable Object を消すための宣言だが、ローカルにその class は無い。
   → `make-dev-config.mjs` が `[ai]` と `[[migrations]]` を落とした設定を生成する。

3. **一覧が空に見えるのはバグではないことがある**
   アカウント未選択時は**先頭のアカウント**が選ばれる。友だちが別アカウント配下だと
   正しく除外されて0件になる。→ 検証データは選ばれるアカウント配下に置く。

4. **`credentials: 'include'` があるので偽APIでは代用できない**
   CORS の `Access-Control-Allow-Origin: *` は credentialed リクエストでは拒否される。
   スタブでログインを回避しようとすると、結局ログイン画面に飛ばされる。
   → 本物の worker を上げるほうが早い。

## スキーマと検証データ

```bash
cd apps/worker
# スキーマ（既にあれば "already exists" で止まる。それでよい）
npx wrangler d1 execute line-harness --config wrangler.dev.toml --local \
  --persist-to .wrangler/state --file ../../packages/db/bootstrap.sql

# 中身を見る
npx wrangler d1 execute line-harness --config wrangler.dev.toml --local \
  --persist-to .wrangler/state --command "SELECT id, display_name, ai_reply_mode FROM friends" --json
```

## これで確かめられたこと（2026-09-04 実測）

- chats 一覧が3件描画され、画像だけの受信が「📷 画像」と出る
- 「自動応答: 停止中 / Botに戻す」が出て、押すと表示が「動作中」に変わり、
  **D1の `friends.ai_reply_mode` が human → bot に実際に変わる**
- サイドバーの「未対応 1」と `/api/inbox/unanswered` の total が一致する

★**ここで `lastMessageDirection` が使えないことも実測できた**:
3件すべてが `dir=incoming` を返す（手動返信済みの相手を含む）。
未返信の判定に使うと全員が未返信になる。詳細は MAP-CHATS-LEDGER-REDESIGN.md の訂正1。
