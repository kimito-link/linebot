# 仕様書 — 「GPTお引越しパック（仮称）」: knowledge-packs方式を商品化する

> 設計=Fable(claude-fable-5) ／ 地図・裏取り=司令塔Claude ／ 2026-08-17
> 地図: [GPTS-CONVERSION-OPPORTUNITY-MAP.md](GPTS-CONVERSION-OPPORTUNITY-MAP.md)（司令塔が実コードを読んで作成・コード変更なし）
> 根拠は地図に記載の事実のみ。地図にない事実は末尾「未解決の質問」「Assumption List」に隔離。

## 司令塔による裏取り結果（採用前チェック）

Fableが仕様内で挙げた事実・ファイルパスは以下の通り実コードで確認済み：

- `apps/worker/src/services/{ai-shain,soushin-suggest,henshin-hisho,web-health-check}-knowledge-content.ts` は実在し、いずれも `export const PERSONA_MD = \`...\`; export const GUARDRAILS_MD = \`...\`;` という単純なテンプレートリテラル定数構造（[groq-knowledge-content.ts:1-66](apps/worker/src/services/groq-knowledge-content.ts)で構造確認）。**Fableの4-2「生成スクリプトは既存構造に一致させる」は機械的に十分実現可能** — mdファイルの内容をそのままテンプレートリテラルに埋め込むだけで足りる。Assumption A4（生成で二重管理コストが解消する）は裏取りにより「妥当」に格上げする。
- `apps/worker/src/routes/webhook.ts:677,761` の `groq_reply_enabled` 判定コメントは実在確認済み。
- ルートの `vitest.config.ts` は `scripts/**/*.test.ts` のみを拾う設定（[vitest.config.ts:1-9](vitest.config.ts)）。`apps/worker` は別途 `apps/worker/vitest.config.ts` を持つ。既存の `scripts/*.test.ts`（例: `check-migrations.test.ts`）という命名慣行が既にあるため、**新規生成スクリプトのテストは `tools/generate-knowledge-content.test.ts` としてルート vitest 対象に置くのが既存慣行と整合する**（Fable 5-2 の「実装時に確認」を解決）。
- `apps/lp/` は現在 `index.html` 1枚構成（`assets/` `robots.txt` `sitemap.xml` `vercel.json` のみ）。Fable案の「gpt-hikkoshi.html を1枚追加」は既存構成と衝突しない。
- `tools/` ディレクトリは既に存在し中身は `recording/` のみ。新規スクリプト追加先として問題なし。

以下、Fableの設計をそのまま採用する。

---

## 1. Problem Statement

**何が問題か**: ChatGPT個人アカウント（Free/Go/Plus/Pro）は新規GPTの作成・GPT Storeへの公開ができなくなった。個人が「自作GPTを不特定多数に配って顧客接点・収益にする」導線が閉じ、配布基盤を失った個人クリエイター（GPT職人）が代替インフラを必要としている。

**なぜ我々の問題か（機会か）**: line-botリポジトリには、この需要の受け皿になる資産が**既に稼働実績つきで**存在する。

- LINE Harness本体: MIT License・Cloudflare無料枠で0円運用できるLINE公式アカウントCRM（README.md:7-8）
- knowledge-packs方式: 「LINE公式アカウント1つ＋knowledge-packs 1セット」で製品ごとのAI応答Botを立ち上げる型。**ai-shain・soushin-suggest・henshin-hisho・web-health-check の4製品で横展開実証済み**
- Groq自由文応答＋fail-closed運用＋Conversation Inboxエスカレーション（README.md:113-121）というコスト管理済みの応答基盤

**問題の本質**: 資産はあるが「商品」の形をしていない。knowledge-packs方式は現在、自社製品の購入後サポート専用の内部パターンであり、外部の第三者が自分のGPT相当物を載せるための入口（テンプレート・構築手順・LP・価格）が存在しない。

---

## 2. Solution

**採用アプローチ**: knowledge-packs方式をテンプレート化し、「あなたのGPTをLINE公式アカウント上のAI Botとしてお引越し構築する」**受託構築パッケージ商品**として売る。新規のプロダクト開発はせず、既存OSS＋実証済みパターンの商品化に徹する。

地図第6章の5つの質問への設計判断:

### Q1. 誰に売るか → **(a) GPT職人個人事業主**を主対象とする

**判断**: (a)を主対象、(c)受託収益化はその**提供形態**として吸収する（「LINE Harness導入支援」を単体商品にはせず、GPTお引越しという文脈のついた受託にする）。(b)法人向けは今回やらない。

**根拠**:
- GPTs停止の影響を直接受けたのは個人アカウント層であり、Business/Enterpriseは引き続き作成可能（地図1-1）。つまり「困っている」のは(a)であり、(b)法人はそもそも困っていない。
- (b)の文脈は既にai-shain（法人向け・個別見積り）が担っており、新商品で重複させると自社商品同士が競合する。
- (c)を単体で売るには「LINE CRMが欲しい」という既需要が必要だが、LINE Harness本体の導入数・知名度は未確認（地図5-3）。文脈なしの受託は集客根拠がない。GPTs停止という明確な文脈がある(a)に絞るのが、確認済みの事実から最も筋が通る。

### Q2. 何を「新商品」として切り出すか → **knowledge-packs方式のテンプレート化＋構築受託**

**判断**: 「GPTのinstructions・ナレッジを persona.md / guardrails.md / docs/ / canned/ の4点セットに移植し、顧客のLINE公式アカウント上でBotとして稼働させるまで」を1商品とする。アフィリエイトASP機能は単体商品にせず、**オプション訴求（差別化材料）**に留める。

**根拠**:
- knowledge-packs方式は4製品で横展開実証済み（地図2章）。「新製品1つ＝LINE公式アカウント1つ＋packs1セット」という増設コストの低さが商品の原価構造そのもの。
- アフィリエイトASPは他OSS LINE CRMに無い独自機能（地図1-3-2）だが、「GPT職人がアフィリエイト報酬設計を必要とするか」は未確認。主商品にすると仮説が2段重なる。まず引越し需要で顧客を得て、その顧客の中の収益化ニーズにASPを提案する順序が安全。

### Q3. GPTs停止との接続をどう訴求するか → **事実提示型・煽り禁止**

**判断**: 煽り訴求は行わない。「個人アカウントでは新規GPTの作成・公開ができなくなりました（出典明記）。既存GPTは要件を満たせば編集・利用継続可能です。LINEという別の配布先があります」という**事実＋選択肢提示**の文体に統一する。

**根拠**:
- ai-shain・soushin-suggestのguardrailsは一貫して「煽らない・誇張しない」方針（地図6-3）。既存2商品とLPトーンが乖離すると、「persona.mdとLPの文体を一致させる」運用ルール（soushin-suggest/persona.md:23-25の型）と矛盾する。
- 地図5-2のとおり、既存GPTの今後の扱い（強制非公開化の有無・時期）は未確認。「あなたのGPTは消えます」系の断定コピーは事実に反するリスクがあり、fail-closed（不確かなら言わない）の設計思想とも整合しない。

### Q4. MVPの技術スコープ → **新規エンジン開発ゼロ。テンプレート＋LP＋バンドル生成スクリプトの3点のみ**

**判断**: 応答エンジン・配信基盤は既存のまま使う。新規に作るのは以下の3点だけ。

1. `knowledge-packs/_template/` — 顧客案件の雛形（persona.md / guardrails.md / docs/ / canned/ の空テンプレート＋記入ガイド）
2. `apps/lp/` 配下の新LP1枚 — 商品説明・事実提示型コピー・申込導線
3. `tools/` 配下のバンドル生成スクリプト — knowledge-packsのmd正本から `apps/worker/src/services/<product>-knowledge-content.ts` を生成し、二重管理（地図4章）を「手作業の二重編集」から「正本→生成」に変える

**根拠**: 地図6-4の問いへの答えは「使い方ガイド化だけでほぼ売れる。ただし二重管理だけは案件数に比例して効くコスト要因（地図4章に明記）なので、そこだけ薄く自動化する」。案件1件ごとの限界コストを下げることが受託商品の利益率を決めるため。**（司令塔裏取り: 既存knowledge-content.tsの単純な構造から、この生成は機械的に実現可能と確認済み）**

### Q5. 価格帯 → **soushin-suggest型（買い切り）に寄せた、中間帯の定額構築費**

**判断**: 価格**モデル**は「初期構築費の定額買い切り＋月額なし（運用は顧客自身のCloudflare無料枠・0円）」とする。ai-shain型の個別見積りは採らない。具体金額は本仕様では決めず、検証項目とする（5章）。

**根拠**:
- 対象が個人事業主（Q1）である以上、個別見積り・商談フローは重い。soushin-suggestの「¥980買い切り・サブスクなし」（地図1-2）が同じ個人層で成立している実績に寄せる。
- ただし¥980は既製ソフトの価格であり、本商品は1件ごとに構築作業が発生する受託。¥980より上・ai-shain個別見積りより下の中間定額、という**帯**までを設計判断とし、具体額はテスト販売で決める（金額の根拠になる事実が地図にないため、ここで数字を断定しない）。

---

## 3. User Stories

本お題は事業設計＋少量の実装（テンプレート・LP・生成スクリプト）のため、機能実装が絡む範囲のみ具体化し、該当しない種別は「該当なし」と明記する。

**正常系**
- GPT職人として、自分のGPTのinstructionsとナレッジ文書を渡すと、自分のLINE公式アカウント上で同等の応答をするBotが稼働する。応答はknowledge-packsの定型（canned）→未マッチ時Groq自由文フォールバック、という既存の流れ（地図2章）に乗る。
- 構築担当（自分）として、`_template/` をコピーして顧客名のpackを作り、生成スクリプトを1回実行するとworker用のknowledge-content定数が生成される。

**空の状態**
- 顧客のGPTにナレッジ文書が無い（instructionsのみ）場合: docs/ が空でもpersona.md＋canned/だけでBotが成立することをテンプレート記入ガイドに明記する。生成スクリプトはdocs/が空でもエラーにせず、空配列相当の定数を生成する。

**読み込み中**
- LPは静的HTML（apps/lp/の既存方式に準拠）のため、該当なし。

**失敗と再試行**
- Groq応答失敗時: 既存のfail-closed運用（Claudeへフォールバックせず、Conversation Inboxへエスカレーション。README.md:120）を**そのまま顧客案件にも適用**する。顧客への説明資料に「AIが答えられない場合はあなたの受信箱に届く」ことを商品仕様として明記する。
- 生成スクリプト失敗時: 正本mdのパースに失敗したら**生成物を書き換えず**終了コード非0で止まる（fail-closed。壊れた定数でworkerのビルドを壊さない）。

**権限不足**
- Botに送信代行・データ削除・OAuth等をさせない方針は、既存guardrails（ai-shain/guardrails.md:16-18）を`_template/guardrails.md`の**削除不可セクション**として全顧客案件に継承させる。顧客が「Botに◯◯を代行させたい」と言った場合の断り方までテンプレートに含める。

**古いデータとの互換性**
- 既存4製品のknowledge-content.tsは手書きの現行構造のまま動いている。生成スクリプトは**新規案件のみに適用**し、既存4製品の移行は行わない（6章 Out of Scope）。生成物の型は既存の手書き定数と同一構造にする。

**Undo/Cancel/Back**
- 顧客が解約・撤退する場合: LINE公式アカウントもCloudflareアカウントも顧客自身の所有（Q5の設計）なので、こちら側の作業は該当packの削除のみ。記憶機能（fan_memory）を有効化していた案件では、同意・削除フロー（migrations/061）が既に存在することを撤退手順書に記載する。

**別画面・別ウィンドウとの競合**
- 該当なし（事業設計。Bot側の同時接続はLINE/worker既存基盤の責務であり本仕様で変更しない）。

---

## 4. Implementation Decisions

### 4-1. ディレクトリ・ファイル構成（新規）

```
knowledge-packs/
  _template/                      ← 新規。先頭 "_" で製品packと視覚的に区別
    README.md                     ← 記入ガイド（GPT instructions→persona.mdへの移植手順）
    persona.md                    ← 雛形。LPと文体一致の運用ルールを冒頭コメントで明記
    guardrails.md                 ← 雛形。代行禁止セクションは「削除不可」と明記
    docs/
      .gitkeep                    ← docs空でも成立することの表明
    canned/
      example.txt                 ← 定型応答の書式サンプル

apps/lp/
  gpt-hikkoshi.html               ← 新規LP（1枚・静的・既存index.htmlと同方式）

tools/
  generate-knowledge-content.mjs  ← 新規。md正本→TS定数の生成スクリプト
  generate-knowledge-content.test.ts  ← 新規。ルートvitest対象（scripts/**/*.test.tsパターンに準拠する場合はscripts/配下も検討）
```

**司令塔注記**: ルート`vitest.config.ts`は`scripts/**/*.test.ts`のみを対象にする（[vitest.config.ts:8](vitest.config.ts)）。`tools/`配下に置く場合はvitest.config.tsのinclude修正が必要になる。実装時は「`scripts/generate-knowledge-content.test.ts`として置き、生成スクリプト本体は`tools/`に置いてscriptsからrequireする」か「vitest.config.tsのincludeに`tools/**/*.test.ts`を追加する」のどちらかを選ぶ（後者の方が構成として素直）。

### 4-2. 生成スクリプトの仕様

- 入力: `knowledge-packs/<product>/`（persona.md / guardrails.md / docs/*.md / canned/*.txt）
- 出力: `apps/worker/src/services/<product>-knowledge-content.ts`
- 実行: `node tools/generate-knowledge-content.mjs <product>`
- 出力ファイル冒頭に `// GENERATED from knowledge-packs/<product>/ — do not edit by hand` を必ず付与
- 既存4製品（ai-shain / soushin-suggest / henshin-hisho / web-health-check）の手書きファイルは**対象外**。誤って上書きしないよう、既存4製品名を指定された場合はエラーで拒否する明示的な除外リストを持つ
- 出力構造は既存の `groq-knowledge-content.ts` / `<product>-knowledge-content.ts` の現行構造に一致させる（`export const PERSONA_MD = \`...md本文...\`; export const GUARDRAILS_MD = \`...\`;` という単純なテンプレートリテラル形式。**司令塔裏取り済み**、[groq-knowledge-content.ts:1-66](apps/worker/src/services/groq-knowledge-content.ts)）

### 4-3. LP（gpt-hikkoshi.html）の内容構成

1. 事実提示（GPTs個人配布停止の内容・出典・「既存GPTは編集・利用継続可」まで正確に）
2. 提供内容（persona/guardrails/docs/cannedへの移植＋顧客のLINE公式アカウントで稼働まで）
3. 稼働後の姿（定型応答＋Groq自由文フォールバック、答えられない時は顧客のInboxへ届くこと＝fail-closedを商品仕様として正直に書く）
4. 運用費0円の根拠（Cloudflare無料枠・OSS）と、答えられない質問の人間対応は顧客自身が行うこと
5. 価格（定額買い切り。金額はテスト販売の決定後に記入）
6. オプション: アフィリエイトASP機能の存在紹介（1ブロックのみ、主訴求にしない）

### 4-4. 顧客案件の増設手順（商品のデリバリー手順そのもの）

1. `_template/` を `knowledge-packs/<customer-product>/` にコピー
2. 顧客のGPT instructions・ナレッジをREADME.mdのガイドに従って移植
3. `node tools/generate-knowledge-content.mjs <customer-product>` 実行
4. 顧客のLINE公式アカウントを接続し、`groq_reply_enabled` を既存の判定フロー（[apps/worker/src/routes/webhook.ts:677,761](apps/worker/src/routes/webhook.ts)、司令塔裏取り済み）に従って有効化
5. 顧客と一緒に応答確認 → 引き渡し

---

## 5. Testing Decisions

### 5-1. 事業仮説の検証（本仕様の主目的）

- **段階0（ドッグフーディング）**: 自社製品のうちknowledge-pack未整備のもの、または既存GPT相当の自社コンテンツを1つ、`_template/`＋生成スクリプトの新フローで実際に構築する。テンプレートと手順書がデモを兼ねる。
- **段階1（テスト販売）**: LP公開＋先着少数枠（既存ai-shainの「先行導入・個別相談」方式の型を流用）で申込を募る。**検証指標は「申込・問い合わせが発生するか」**。金額はこの段階の反応で決定する。
- **判定基準は事前に書面化する**（何件・何週間で継続/撤退を判断するか）。具体値は未解決の質問に回す（顧客数・集客力の現状値が地図から不明なため、ここで数字を置くと根拠のない断定になる）。

### 5-2. コードの検証

- 生成スクリプト: 入力md→期待するTS出力のスナップショット比較テストを1本書く。**司令塔確認**: 既存の`scripts/*.test.ts`命名慣行（例: `check-migrations.test.ts`）に沿わせ、`vitest.config.ts`のincludeパターンとの整合を実装時に取る（4-1参照）。
- 除外リストの動作: 既存4製品名を指定するとエラー終了することをテストする（既存資産の破壊防止が最重要）。
- 生成後に `apps/worker` のビルドが通ることをデリバリー手順のチェック項目に入れる（型のずれをビルドで検出する）。

---

## 6. Out of Scope

- **アフィリエイトASP機能の単体商品化**（LPの1ブロック紹介まで。専用LP・専用価格は作らない）
- **法人向け（社内GPTの受け皿）訴求**（ai-shainの領域。重複させない）
- **既存4製品のknowledge-content.tsの生成スクリプトへの移行**（動いているものを触らない。地図4章の「壊れうる箇所」）
- **GPTエクスポートの自動インポーター**（instructions→persona.mdの移植は人手＋ガイドで行う。自動化は案件数が増えてから）
- **顧客向け管理ダッシュボードの新規開発**（既存のConversation Inbox等をそのまま使う）
- **the-harness-ios / IG Harness / X Harness との連携商品**（地図5-4のとおり関係が未確認）
- **`ai-shain-worker-task.ts` の外部提供**（開発者本人専用の内部ツール。地図4章に明記のとおり提案に含めない）
- **サブスク型サポート契約の設計**（買い切りで開始。継続収益モデルはテスト販売の学び後）

---

## 7. Further Notes（実装時の地雷・注意点）

1. **二重管理の罠**: knowledge-packsのmd正本とTS定数の二重管理は運用ルールとして明文化されている（soushin-suggest/persona.md:23-25）。生成スクリプト導入後も、**既存4製品は手書き運用のまま**なので「新規案件＝生成、既存4製品＝手書き」の混在状態になる。スクリプトの除外リストとGENERATEDコメントでどちらの方式のファイルかを機械的に判別できるようにしておくこと。
2. **LPの文体**: 「persona.mdとLPの文体を一致させる」運用ルールがある。gpt-hikkoshi.htmlの文体は、`_template/persona.md` に書くデフォルト人格の文体と揃えて書く。煽り文句はguardrails違反として扱う。
3. **GPTs停止の記述精度**: LPに書く事実は地図1-1の範囲（新規作成・公開の停止、既存は編集・利用継続可、Business/Enterpriseは対象外）を超えないこと。「既存GPTも消える」等の未確認情報を書かない。
4. **fail-closedを弱めない**: 顧客案件で「答えられないことが多い」というクレームが出ても、Claudeフォールバック追加等のコスト増改修を安易にしない。README.md:120のコスト優先設計が0円運用の前提。
5. **送信者チェックの混入防止**: `ai-shain-worker-task.ts` の開発者専用トリガー（同ファイル:20-25）が顧客アカウントの設定に紛れ込まないよう、デリバリー手順書のチェックリストに「本人専用機能が無効であること」を入れる。
6. **記憶機能の同意**: 顧客案件でfan_memoryを有効化する場合は、同意・削除フロー（migrations/061）が前提。デフォルトは無効で引き渡す。
7. **（司令塔追記）vitest configの配置決定を先に行う**: 4-1の注記のとおり、テストファイルをどこに置くか（`scripts/`にリネームするか`vitest.config.ts`を編集するか）を実装着手前に決める。既存の`scripts/**/*.test.ts`パターンを崩さない方を優先。

---

## 未解決の質問

1. **具体的な価格金額**（帯: ¥980超〜個別見積り未満、はQ5で決定済み。金額はテスト販売の反応と1件あたり構築工数の実測で決める）
2. **テスト販売の継続/撤退の判定数値**（何件・何週間か。現状の集客力＝LP流入・LINE Harness知名度が未確認のため設定不能）
3. **ai-shain / soushin-suggestの現在の顧客数・売上**（新商品との共食い評価に必要。別リポジトリ・外部データ）
4. **既存個人GPTの今後の扱い**（強制非公開化の有無・時期。LPコピーの更新に影響）
5. **GPT職人層への到達経路**（LPを作っても、その層に届くチャネルが何かは地図に事実がない）

## Assumption List（仕様に根拠がない断定）

| # | 断定 | 実際の根拠状況 |
|---|---|---|
| A1 | GPT職人が配布先としてLINE公式アカウントを受け入れる | 未検証。自社製品でのLINEサポート実績はあるが、外部クリエイターの需要は仮説（段階1で検証） |
| A2 | 個人事業主は個別見積りより定額買い切りを好む | soushin-suggest（¥980買い切り）が同層で成立している事実からの類推であり、直接の裏付けなし |
| A3 | instructions→persona.mdの移植が人手＋ガイドで現実的な工数に収まる | 自社4製品での構築実績からの類推。他人のGPTでの実測なし（段階0で検証） |
| A4 | 生成スクリプトで二重管理コストが実質解消する | **司令塔裏取りにより「妥当」に格上げ**: 既存knowledge-content.tsの構造を確認済み、単純なテンプレートリテラルなので機械生成は技術的に容易 |
| A5 | アフィリエイトASPが将来のアップセル材料になる | 独自機能である事実（README比較表）のみが根拠。需要は未確認 |
