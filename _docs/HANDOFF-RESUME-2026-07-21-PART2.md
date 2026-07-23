# 引き継ぎプロンプト — 2026-07-21 セッション（Part 2）終了時点

次のチャットの冒頭にこのファイルの内容をそのまま貼るか、「`_docs/HANDOFF-RESUME-2026-07-21-PART2.md`を読んで続きから」と伝えてください。
前回の引き継ぎ（`_docs/HANDOFF-RESUME-2026-07-21.md`）の続きのセッションです。

---

## リポジトリ構成（毎回混同しやすいので再掲）

| リモート名 | 実体 | 用途 |
|---|---|---|
| `fork` | `kimito-link/line-harness-oss` | **Bot本体の本番デプロイ元**。`apps/worker/**`等の変更はここにpush後、`gh workflow run deploy-cloudflare-worker.yml --repo kimito-link/line-harness-oss --ref main`でデプロイ |
| `origin` | `kimito-link/linebot` | **LP（`apps/lp/`）専用**。Vercel（`lp-eight-dusky.vercel.app`）がここをデプロイ対象にしている |
| `shudesu` | `Shudesu/line-harness-oss` | 第三者リポジトリ。**一切pushしない** |

現在の作業ブランチ: `feat/character-loop-videos`

Cloudflareアカウント: `ca40e10bfbfdda12a70fbff91f4e1089`（アカウントID）。本番Worker名は`kimitolink-line`。
本番URL: `https://kimitolink-line.info-a40.workers.dev`

---

## このセッションでやったこと（時系列）

1. **Gemini動画APIの429（レート制限）対応**: `describeVideo`の戻り値を`{ text, rateLimited }`の判別型に変更し、429のときだけユーザーに専用の案内文を返すよう実装・デプロイ（コミット`94bad46`）。テスト21件全通過。

2. **Gemini APIが429→403（PERMISSION_DENIED）に悪化**: 調査の結果、Google Cloud側の請求先アカウント未設定が原因と判明。「請求先アカウント1」は既に存在していたが、`gen-lang-client-0184028160`プロジェクトにはリンクされていなかった。

3. **ディープリサーチ + 3段構え設計フロー**: Qwen-VL・MiniMax・Doubao等の代替動画認識APIを調査したが、いずれも決定打にならず（Qwen-VLはbase64直送10MB制限、日本からの実績情報が乏しい等）。星野ロミ氏（@romi_hoshino）のX投稿から「動画は静止画に変換してから見せる」という発想を着想源として得た。

4. **Fable設計 → dHash（知覚ハッシュ）によるTier 0.5を実装**:
   - LINEの`GET /content/preview`エンドポイント（動画のサムネイルJPEGだけを取得）を発見・実装
   - dHash（差分ハッシュ、9x8グレースケール→64bit）で、AI不要の決定的な近似一致判定を実装
   - ローカル実測: 3キャラ（りんく・こん太・たぬ姉）でintra-class距離0〜8、inter-class距離18〜28、ギャップ10で分離可能と確認
   - **実機検証（LINE経由）でも確認**: たぬ姉のLINE経由プレビュー画像のdHashが、ローカルオリジナルのたぬ姉フレームと距離2〜8（intra範囲）、他キャラとは距離18〜26（inter範囲）で一致
   - Tier 0（SHA-256完全一致）→**Tier 0.5（dHash近似一致、新規）**→Tier 1（Gemini describe）の順で判定するよう`webhook.ts`に組み込み（コミット`08c144e`, `e26e835`）
   - **実機で成功確認**: Gemini APIが403で完全に死んでいる状態でも、たぬ姉の動画を送ると「わー！たぬ姉が動画に出てきてる！」という正しい返信が`selfMatchTier:"t0_5_phash"`で返ることを確認

5. **dHashの検証レポートページを作成・公開**: `apps/lp/dhash-report.html`として作成し、Vercel（`origin`リポジトリ経由、CLI手動デプロイ）で公開。URL: `https://lp-eight-dusky.vercel.app/dhash-report`
   - 自動デプロイ（GitHub連携）が反応しなかったため、`npx vercel --prod`で手動デプロイした（`apps/lp`ディレクトリで実行）
   - ロミ氏へこの内容をXでリプライ済み。「既知の動画の再認識であってゼロショット判定ではない、Gemini APIとは用途が違うのでは」という的確な指摘を受け、その通りである旨を返信済み

6. **Gemini 403の根本原因調査（未解決）**:
   - Google Cloud Consoleで確認したところ、`gen-lang-client-0184028160`プロジェクトは実は「請求先アカウント1」に**既にリンクされていた**（プロジェクト一覧で確認済み）
   - しかし**Gemini API（Generative Language API）自体が「有効にする」前の状態だった** → プロジェクトを正しく選択した上で有効化操作を実施（ステータス「有効」に変わったことを確認）
   - **それでも403 PERMISSION_DENIEDは解消しなかった**。エラーメッセージは通常の設定不足とは異なる文言:
     ```
     { "error": { "code": 403, "message": "Your project has been denied access. Please contact support.", "status": "PERMISSION_DENIED" } }
     ```
   - ディープリサーチで、この正確な文言のケースがGoogle公式フォーラム（discuss.ai.google.dev）で15件以上報告されていることが判明。Googleスタッフが「アカウントにフラグが設定された」「Trust & Safetyチームによる一時停止」と回答している例があり、**セルフサービスの設定変更では解決できない、Google側の個別ブロックの可能性が高い**。フォーラムで明確に「解決した」という報告は見つからなかった。

7. **別Googleアカウントでの新規プロジェクト作成（進行中、途中で中断）**:
   - `streamerfunch@gmail.com`で試したが「Failed to create project, The request is suspicious. Please try again.」というエラーで新規プロジェクト作成に失敗
   - **メインアカウント（`info@best-trust.biz`）で新規プロジェクト`line-bot-video`（プロジェクト番号262965285236）の作成に成功**。ブロック済みの`gen-lang-client-0184028160`とは完全に別のクリーンなプロジェクト
   - このプロジェクトで新しいAPIキーを発行済み（`AQ.Ab8RN6Lq69-...`、値は本文に残さない。ユーザーがコピー済み、`read_clipboard`で取得済み）
   - **★次にやるべきこと**: このAPIキーを本番Cloudflare Workerのシークレット`GEMINI_API_KEY`に設定する作業の**直前で中断**。Cloudflareダッシュボード（`https://dash.cloudflare.com/ca40e10bfbfdda12a70fbff91f4e1089/workers/services/view/kimitolink-line/production/settings`）の「変数とシークレット」→`GEMINI_API_KEY`の「編集」→「ローテート」→新しい値を貼り付け→「デプロイ」の手順（前回セッションでも実施済みの手順、動作確認済みのフロー）

---

## 中断中の未完成作業（今回は触らないこと）

- `packages/db/schema.sql`の変更（`friends.last_followup_sent_at`列の追加）
- `packages/db/migrations/057_followup_nudge.sql`（新規ファイル、未コミット）
- これらは「OpenClaw方式」（ユーザーが一定時間返信しないとBotが自発的にAI生成フォローアップを送る機能）の設計途中の断片。ロミ氏のX投稿がきっかけで話題に出たが、実装は着手直後（migration作成のみ）で止まっている。次回、この機能を進めるかどうかはユーザーの意向を確認すること。**今回のGemini API修復作業とは無関係なので、コミット時に混在させないよう注意**（これまでも意図的に分離してコミットしてきた）。

---

## 次にやること（優先順位）

1. **最優先**: 新しく発行したGemini APIキー（`streamerfunch`ではなく`info@best-trust.biz`の`line-bot-video`プロジェクトのもの）を、Cloudflareダッシュボードで`GEMINI_API_KEY`シークレットに設定する
   - ユーザーが既にクリップボードにコピー済み（`read_clipboard`で値を取得可能なはず、ただし新しいセッションではクリップボードの中身は失われている可能性が高いので、再度Google AI Studioの当該キー詳細画面を開いて「鍵をコピー」からやり直す必要があるかもしれない）
   - Cloudflareダッシュボードの「編集」ボタンクリックが不安定になることがある（過去2回、真っ白スクリーンショット問題が発生。`scroll_to` → 少し待つ → 座標クリックで安定することが多かった）
2. 新キー設定後、動画を送って403が解消されたか実機検証する（未登録動画でGeminiのTier 1が機能するか確認。dHashのTier 0.5だけでは既知動画にしか効かない）
3. 消費期限・予算アラートの設定を検討する（同じ429→403の轍を踏まないため）
4. 中断中の「OpenClaw方式」機能をどう扱うか、ユーザーに確認する

## ユーザーの意向（重要な文脈）

- 「最高のものを作りたい」という強い要望があり、時間をかけて実機検証・修正を繰り返すことを歓迎している
- dHashの技術検証自体をロミ氏と交流するコンテンツとして楽しんでいる（Xでの技術系のやり取りを積極的に行っている）
- 3段構え（会議ハーネス→Fable→実装）のワークフローに慣れており、次回も複雑な設計判断が必要な場面ではこの手順を使うとよい
- Google Cloud関連の操作（ログイン、支払い情報、プロジェクト作成）は必ずユーザー自身に行ってもらう方針を徹底している（Claude側はブラウザのread-only確認やCloudflare側の設定変更のみ担当）
