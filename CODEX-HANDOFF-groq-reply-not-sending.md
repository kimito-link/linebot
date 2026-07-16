# 引き継ぎ: 「Kimito-Link Project」LINE公式アカウントでGROQ AI返信が届かない

## 症状
LINE公式アカウント「Kimito-Link Project」(`@kimitolink`) にメッセージを送っても、Bot（GROQ AI）からの返信が一切来ない。友だち追加後の挨拶メッセージも来ない。

## 確認済みの事実（裏取り済み・確実）

1. **Webhook自体は届いている（一部は）**: D1の`messages_log`テーブルに`direction='incoming'`のログが複数件記録されている（「使い方教えて」「AI社員について教えて」「こんにちは」「テスト」等、2026-07-15 07:13〜10:38 JST）。Cloudflare Workers Logsでも`POST /webhook`が`status:200`, `outcome:"ok"`で記録されている。
2. **返信は一度も記録されていない**: `messages_log`に`direction='outgoing'`の行が**一件も存在しない**。
3. **11:16以降に送信したメッセージ（「あ」「z」「gg」等）は、Workers Logsに`POST /webhook`のログ自体が記録されなくなった**（最新のログはcron定期実行`*/5 * * * *`のみ）。つまり直近は**Webhook配信自体が届いていない**可能性がある（Webhook URL設定の確認は未実施のまま中断）。
4. **LINE公式アカウント管理画面（manager.line.biz）の「応答設定」を操作した**: 元々「チャット:オン」「応答方法=手動チャット+応答メッセージ」で、これが「メッセージありがとうございます！申し訳ありませんが、このアカウントでは個別のお問い合わせを受け付けておりません。次の配信までお待ちください😊」という**LINE標準の定型応答**を返していたことが判明・確認できた（このメッセージ文言はコード上のどこにも存在しない＝LINE公式アカウント標準機能由来と確定）。
5. 上記4を受けて、「チャット」をOFF、「応答メッセージ」もOFFにし、「Webhook」のみONの状態に変更・保存済み。この変更後、定型文は返らなくなったが、**GROQ側の返信も依然として来ていない**。
6. Cloudflare Worker `kimitolink-line`（`https://kimitolink-line.info-a40.workers.dev`）に対し、`GROQ_API_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET`はsecretとして設定済みであることをCloudflare API経由で確認済み。
7. D1の`account_settings`テーブルに`groq_reply_enabled=true`（line_account_id=`f0e13880-f6a7-4462-9fc4-979a2e9c5062`、Kimito-Link Projectの正しいID）が設定済みであることを確認済み。
8. `line_accounts`テーブルの当該アカウントは`is_active=1`。

## このセッションで行った変更（要注意・要検証）

1. **`apps/worker/src/routes/webhook.ts`にデバッグログを追加**（`git diff`で確認可能、`feature/ai-reply-fallback`ブランチ、未commit）:
   - GROQパイプライン呼び出し前後に`console.log('[debug] ...')`を追加
   - `catch`節のエラーログを`err.stack`まで出すよう強化
   - **この変更はロジックを一切変えていない（ログ追加のみ）**
2. **上記デバッグログ入りのコードを`wrangler deploy`で本番`kimitolink-line`に直接デプロイ済み**（GitHub Actions経由ではない、手動）。手順:
   ```
   cd apps/worker
   pnpm build  # (事前に pnpm --filter @line-crm/shared --filter @line-crm/line-sdk --filter @line-crm/db --filter @line-harness/update-engine build が必要)
   # dist/line_harness/wrangler.json の name/account_id/d1_databases を本番値にnode script でパッチ
   #   name: "kimitolink-line"
   #   account_id: (.envのCLOUDFLARE_ACCOUNT_ID)
   #   d1_databases[0].database_name: "kimitolink-line-db"
   #   d1_databases[0].database_id: "b111428f-2572-4c56-85b2-6477ddb86031"
   CLOUDFLARE_API_TOKEN=<.envの値> npx wrangler deploy --config dist/line_harness/wrangler.json
   ```
   デプロイ自体は成功（Version ID: `ef7d1a8f-fdc7-4722-9095-6f0d0aa70a9e`）。
3. **注意点**: このデプロイでWorkerの`vars`（環境変数）が開発用デフォルト値で上書きされた形跡がある。デプロイ後の出力に以下が出ていた:
   ```
   env.WORKER_NAME ("line-harness")           <- 本来は "kimitolink-line" のはず
   env.ADMIN_PAGES_PROJECT ("line-harness-admin")
   env.LIFF_PAGES_PROJECT ("line-harness-liff")
   env.D1_DATABASE_ID ("YOUR_DEV_D1_DATABASE_ID")   <- プレースホルダーのまま！
   env.WORKER_PUBLIC_URL ("https://line-harness.workers.dev")
   env.ADMIN_PUBLIC_URL ("https://line-harness-admin.pages.dev")
   env.CF_ACCOUNT_ID ("YOUR_DEV_ACCOUNT_ID")        <- プレースホルダーのまま！
   ```
   これらの`vars`は`bot.config.json`のような静的インポートとは別物で、Cloudflareダッシュボードで以前確認した値（`kimitolink-line-admin`, `kimitolink-line-liff`等）と食い違っている可能性が高い。**これが今回返信が来なくなった直接の原因である可能性がある**（特にLIFF_PAGES_PROJECT等、Worker内の他機能がこれらのvarsを参照している箇所がないか要確認）。

## 次にやるべきこと（優先順位順）

1. **最優先**: Cloudflareダッシュボード → `kimitolink-line` → 設定 → 変数とシークレット で、現在の`vars`の値を確認し、デプロイ前の値（下記「デプロイ前の既知の値」参照）に戻す。特に`D1_DATABASE_ID`と`CF_ACCOUNT_ID`がプレースホルダーのままだと、Worker内の他ロジック（self-update等）が壊れる可能性がある。
2. LINE Developersコンソール → Kimito-Link Project → Messaging API設定 → Webhook URL が `https://kimitolink-line.info-a40.workers.dev/webhook` のままか、「検証」ボタンで疎通確認する（直近ログにPOSTが記録されなくなった原因の切り分け）。
3. Webhookが届く状態に戻ったら、再度メッセージを送り、Cloudflare Observability の `[debug]` ログ（今回追加した`console.log`）を確認して、`groqApiKey present`、`groqResult.kind`が何を返しているか特定する。
4. 原因が判明したら修正し、`feature/ai-reply-fallback`の変更を`main`にマージし、正規のGitHub Actions（`Deploy Cloudflare Worker`ワークフロー、`vars.LINE_HARNESS_CLOUDFLARE_DEPLOY == 'true'`が条件）経由でのデプロイに戻すことを検討する（今回のように手動`wrangler deploy`で`vars`を壊すリスクを避けるため）。

## デプロイ前の既知の値（Cloudflare API経由で確認済み・2026-07-15時点）

```
ADMIN_PAGES_PROJECT: kimitolink-line-admin
ADMIN_PUBLIC_URL: https://kimitolink-line-admin.pages.dev
CF_ACCOUNT_ID: ca40e10bfbfdda12a70fbff91f4e1089
D1_DATABASE_ID: b111428f-2572-4c56-85b2-6477ddb86031
LIFF_PAGES_PROJECT: kimitolink-line-liff
LIFF_PUBLIC_URL: https://kimitolink-line-liff.pages.dev
MANIFEST_URL: https://github.com/Shudesu/line-harness-oss/releases/latest/download/release-manifest.json
WORKER_NAME: kimitolink-line
WORKER_PUBLIC_URL: https://kimitolink-line.workers.dev  (注: 実際は存在しないドメイン。正しくは info-a40.workers.dev)
```

## 別件・今回のセッションで判明・解決済みの事項（このHANDOFFの本題とは別）

- LINEの「LIFF」は`ai-shain.link`LPの友だち追加ボタンには**不要**と判断し、`https://line.me/R/ti/p/@kimitolink`（公式サポートの単純なURL）に戻し、本番デプロイ済み（該当リポジトリ: `ai-shain.link`、直接この`line-harness-oss`とは別）。
- `kimitolink`というLIFFアプリ（LINEログインチャネル「Kimito-Link Login」配下、LIFF ID: `2010492622-XPBsRwnD`）のエンドポイントURLを`https://kimitolink-line.workers.dev/liff`（誤り・存在しないドメイン）から`https://kimitolink-line.info-a40.workers.dev/liff`に修正済み。ただし`/liff`というパス自体はこのWorkerに実装されておらず404。本来のLIFFエンドポイントは別Pagesプロジェクト`kimitolink-line-liff.pages.dev`（予約機能用）である可能性が高いが未修正のまま。**今回の目的（友だち追加）にはLIFF自体使わない方針にしたため、この点は優先度低（保留可）**。
- D1に`ai-shain-lp`というentry_route・専用ウェルカムシナリオ（「AI社員りんく ウェルカム」）を作成済みだが、LPのリンクをLIFF非経由に戻したため**この経路は現在使われていない**（無駄ではあるが害もない、放置可）。

## 関連ファイル
- `apps/worker/src/routes/webhook.ts` — Webhook処理本体（デバッグログ追加済み・未commit）
- `apps/worker/src/services/groq-pipeline.ts` — GROQ応答の4段ティア
- `apps/worker/src/services/groq-reply.ts` — `getGroqReplyConfig`（enabledチェック）
- `bot.config.json` — `defaultProject: "ai-shain-link"`, `dailyCallBudget: 800`
- D1データベース: `kimitolink-line-db` (`b111428f-2572-4c56-85b2-6477ddb86031`)
- Worker: `kimitolink-line` (`https://kimitolink-line.info-a40.workers.dev`)
