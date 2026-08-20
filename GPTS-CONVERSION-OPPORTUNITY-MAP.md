# 地図（wayfinder）— GPTs個人配布停止を追い風に、line-bot資産で何が売れるか

> 作成: 司令塔(Claude) ／ 2026-08-17 ／ コード変更なし。
> お題の性質は「既存コードの真因調査」ではなく「既存資産の商品化余地の棚卸し」だが、
> 過大評価・過小評価を避けるため事実ベースで裏取りした（wayfinder方式の手順1を流用）。

---

## 1. 入口になる事実（今回のお題の前提確認）

### 1-1. GPTs個人配布停止の事実（Web検索で裏取り済み・2026-08-17時点）

- ChatGPT個人アカウント（Free/Go/Plus/Pro）は**新規GPTの作成・GPT Storeへの公開ができなくなった**。既存GPTは要件を満たせば編集・利用は継続可。
- Business/Enterprise/Eduワークスペースは引き続きGPT作成・共有・公開が可能。
- 出典: [「GPTsもう作れない…！」— shiritomo](https://hashout.jp/ai/6589/)、[OpenAI Help Center: GPTの共有と公開](https://help.openai.com/ja-jp/articles/8798878-sharing-and-publishing-gpts)
- **意味**: 個人が「自作GPTを無料/格安で不特定多数に配って稼ぐ」導線が閉じた。代わりに需要が向かう先は (a) 法人契約(Enterprise/Business)への集約、(b) **GPTs以外の配布基盤**（LINE公式アカウント・独自Webアプリ等）。line-bot資産は(b)の受け皿になりうる、というのが今回の仮説。

### 1-2. line-botリポジトリの実体（Grep/Read裏取り済み）

このリポジトリは**単一プロダクトではなく複数レイヤーの集合体**。裏取りの結果、少なくとも3層に分かれる。

| 層 | 実体 | マネタイズの形 |
|---|---|---|
| **A. LINE Harness本体** | LINE公式アカウント運用の完全OSS CRM（[README.md:7-8](README.md)）。MIT License・Cloudflare無料枠で0円運用。npm公開3パッケージ（`@line-harness/sdk` `@line-harness/mcp-server` `create-line-harness`、[README.md:140-147](README.md)） | 本体は無料配布・収益化なし（OSS戦略）。派生の受託・カスタマイズ・自社プロダクト運用基盤としての価値 |
| **B. ai-shain（AI社員/君斗りんく）** | ChatGPTに接続する法人向け個人秘書AI。line-bot内には**購入後サポートBot（LINE上）だけ**が実装されている（[knowledge-packs/ai-shain/persona.md](knowledge-packs/ai-shain/persona.md)、[onboarding-steps.md](knowledge-packs/ai-shain/docs/onboarding-steps.md)）。商品本体（Gmail接続・claude -p実行エンジン）は**別リポジトリ `kimito-link/ai-shain-worker`**（[apps/worker/src/services/ai-shain-worker-task.ts:3-7](apps/worker/src/services/ai-shain-worker-task.ts)） | 既に有料商品として稼働中（申込制・個別見積り、[onboarding-steps.md:7](knowledge-packs/ai-shain/docs/onboarding-steps.md)）。GPTsではなく「ChatGPTのカスタムGPT機能＋Google OAuth連携」で作られている |
| **C. soushin-suggest（送信サジェスト）** | Windows常駐ツール。¥980買い切り・サブスクなし（[knowledge-packs/soushin-suggest/persona.md:13](knowledge-packs/soushin-suggest/persona.md)）。line-bot内はこちらも**購入後サポートBotのみ** | 既に有料商品として稼働中（買い切り） |

**未確認**: ai-shain本体・soushin-suggest本体のLP（ai-shain.link / soushin-suggest.link）の現在の集客状況・売上規模。line-botリポジトリからは分からない（別リポジトリ or 外部ホスティング）。

### 1-3. line-bot内で「即座に商品化可能な機能」の棚卸し

README([README.md:64-125](README.md))とコードから確認した主要機能:

1. **ステップ配信・セグメント配信・スコアリング**（L社/U社=商用LINE CRM相当機能の無料代替、[README.md:18-35](README.md)の比較表）
2. **アフィリエイトASP機能**（[docs/wiki/27-Affiliate-ASP.md:1-33](docs/wiki/27-Affiliate-ASP.md)）— アフィリエイターがLIFF上でセルフサーブ登録・リンク発行・クリック〜CV計測・帰属計算まで内蔵。**これは他のOSS LINE CRMには無い差別化機能**（README比較表に「アフィリエイト」列自体が無い＝独自機能）
3. **Groq自由文サポートBot**（[README.md:113-121](README.md)）— knowledge-packs方式で複数プロダクトの購入後サポートに使い回している実績（ai-shain・soushin-suggest・henshin-hisho・web-health-check、[knowledge-packs/](knowledge-packs/)配下4パック確認）
4. **記憶機能（fan_memory）＋同意フロー**（[packages/db/migrations/061_fan_memory_consent.sql:1-7](packages/db/migrations/061_fan_memory_consent.sql)）— 2026-07-24に同意・削除フロー実装済み（[_docs/MEMORY-KIMITOLINK-DEMO-DESIGN.md:108](Cursor _docs/MEMORY-KIMITOLINK-DEMO-DESIGN.md)の地雷が解消され、マイグレーションが存在する＝実装済みと確認）
5. **MCP Server**（`@line-harness/mcp-server`）— Claude CodeからLINE公式アカウントを自然言語操作できる。**AI駆動ワークフローの入口として、GPTs時代に育ったAI活用ニーズの受け皿になりうる**
6. **iOS公式アプリ対応API**（`GET /api/capabilities`、[README.md:122-124](README.md)）— the-harness-iosという別プロダクトとの連携点も存在（未確認: 詳細）

---

## 2. データが流れる順番（knowledge-packs方式＝横展開の実証パターン）

「1つのLINE公式アカウント基盤に、複数の購入後サポートBotを乗せる」という横展開が**既に4製品で実証済み**という点が今回のお題の核心。

```
knowledge-packs/<product>/persona.md    ← 人格・トーン（LPと文体一致させる運用ルール）
knowledge-packs/<product>/guardrails.md ← 未対応事項・代行禁止・エスカレーション基準
knowledge-packs/<product>/docs/*.md     ← 製品固有ナレッジ（正本）
knowledge-packs/<product>/canned/*.txt  ← 定型応答
        ↓ (soushin-suggest/persona.md:23-25 に明記された運用ルール)
apps/worker/src/services/<product>-knowledge-content.ts  ← Workers実行用にバンドルされた同内容定数
        ↓
apps/worker/src/services/llm-reply.ts + groq-knowledge-content.ts
        ↓ groq_reply_enabled 判定([apps/worker/src/routes/webhook.ts:677,761])
Groq無料枠で自由文応答（未マッチ時のフォールバック）
```

**この型自体が横展開可能な資産**: 新しい製品を1つ増やすたびに「LINE公式アカウント1つ＋knowledge-packs 1セット」で購入後サポートBotが立ち上がる。ゼロからLINE Bot基盤を作り直す必要がない。

---

## 3. 既存の設計判断とその根拠

- **なぜLINE公式アカウントか（GPTsでなく）**: ai-shain・soushin-suggestとも、商品本体はChatGPT/Windowsアプリだが、**購入後サポートの窓口は一貫してLINE**。理由は明記されたコード上の記述はないが、日本の個人向け商材では顧客との継続接点としてLINEがChatGPTより定着している、という前提が伺える（[persona.md](knowledge-packs/ai-shain/persona.md)が全製品「LINE公式アカウント上で」と明記）。
- **fail-closed運用**: Groq自由文Botは「fail-closed時はClaudeにフォールバックせず、Conversation Inboxへエスカレーション（コスト優先）」（[README.md:120](README.md)）。コスト管理を優先した設計判断。
- **代行禁止の徹底**: guardrails.mdで「送信・本番反映・データ削除・OAuth認証など人間承認が必要な操作をBotが代行すると答えない」（[knowledge-packs/ai-shain/guardrails.md:16-18](knowledge-packs/ai-shain/guardrails.md)）。AI社員の自動化と、サポートBotの自動化を明確に切り分けている。

---

## 4. 変更すると壊れうる箇所（今回は商品企画のため直接該当は薄いが記録）

- knowledge-packs方式は「persona.md/guardrails.mdの正本と、TypeScript側バンドル定数の二重管理」（[soushin-suggest/persona.md:23-25](knowledge-packs/soushin-suggest/persona.md)に明記の運用ルール）。新製品を追加する営業提案をする場合、実装コストの見積りにはこの二重管理の手間を含める必要がある。
- `ai-shain-worker-task.ts`の送信者チェック（[apps/worker/src/services/ai-shain-worker-task.ts:20-25](apps/worker/src/services/ai-shain-worker-task.ts)）は開発者本人専用のリモートコード実行トリガー。これは商品化対象ではなく開発者の内部ツールなので、外部向け提案には含めない。

---

## 5. 未確認の前提・推測（明記）

1. **ai-shain / soushin-suggestの現在の売上・顧客数**: line-botリポジトリからは確認不可能（別リポジトリまたは外部管理）。**推測**: onboarding-steps.mdの文面（「先行導入・個別相談」「多くの場合、数営業日以内」）から、まだ少数顧客の手厚い個別対応フェーズと見られる。
2. **GPTs個人配布停止の対象範囲**: 検索結果は「新規作成・新規公開」の停止を確認したが、既存の個人GPTが今後どう扱われるか（強制非公開化の時期等）までは確認できていない。**追加調査が必要**。
3. **line-bot本体（LINE Harness）ユーザー数・知名度**: READMEにYouTube動画・無料体験リンクがあるが、実際の導入数・スター数等は未確認。
4. **the-harness-ios・他Harnessシリーズ（IG Harness / X Harness）との関係**: README末尾に言及があるが（[README.md:175](README.md)）、line-botリポジトリには実装が見当たらず、商品化アイデアの検討範囲に含めるべきか未確認。

---

## 6. 実装前（提案前）に決める必要がある質問

Fableへの設計依頼で必ず答えさせるべき論点:

1. **誰に売るか**: (a) GPTsで個人ボットを配っていた「GPT職人」個人事業主向けに「LINE公式アカウント+knowledge-packs方式」を代替インフラとして売るのか、(b) GPTs停止で困っている「法人が使っていた社内GPT」の受け皿としてai-shain型（Enterprise文脈)を売るのか、(c) LINE Harness本体を導入支援・カスタマイズで受託収益化するのか。この3方向は顧客層もセールスモーションも異なるため、地図の事実だけでは決め切れない。
2. **何を「新商品」として切り出すか**: knowledge-packs方式（購入後サポートBot基盤）をテンプレート化して「あなたの商品用LINEサポートBotを即日構築」のようなSaaS/受託商品にするのか。それともアフィリエイトASP機能を単体訴求するのか。
3. **GPTs停止との接続をどう訴求文脈に落とすか**: 「GPTsが使えなくなったから」という煽り訴求は避けるべきか（ai-shain/soushin-suggestのガードレールが一貫して「煽らない・誇張しない」方針、[guardrails.md](knowledge-packs/ai-shain/guardrails.md)）。この既存トーン規範と、追い風を訴求する新LPのトーンとの整合性。
4. **MVPの技術スコープ**: 新規開発が必要なのか、既存のLINE Harness OSS＋knowledge-packs方式の「使い方ガイド化」だけで売れる商品を組めるのか。
5. **価格帯**: 既存の2商品（ai-shain=個別見積り・法人向け、soushin-suggest=¥980買い切り）の間で、新商品はどちらの価格帯モデルに近いか。
