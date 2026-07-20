# 引き継ぎプロンプト — 2026-07-21 セッション終了時点

次のチャットの冒頭にこのファイルの内容をそのまま貼るか、「`_docs/HANDOFF-RESUME-2026-07-21.md`を読んで続きから」と伝えてください。

---

## リポジトリ構成（最重要・毎回混同しやすい）

作業ディレクトリ `line-bot` には3つのリモートがある。

| リモート名 | 実体 | 用途 |
|---|---|---|
| `fork` | `kimito-link/line-harness-oss` | **本物の本番デプロイ元**。Bot本体のコード変更（`apps/worker/**`, `bot.config.json`, `packages/db/migrations/**`等）はここにpushしてから`gh workflow run deploy-cloudflare-worker.yml --repo kimito-link/line-harness-oss --ref main`でデプロイする |
| `origin` | `kimito-link/linebot` | LP（`apps/lp/`）専用の作業リポジトリ。Vercelにこちらをデプロイ |
| `shudesu` | `Shudesu/line-harness-oss` | **第三者リポジトリ。一切pushしない** |

デプロイ手順（Bot本体を直す場合）:
```bash
git push fork feat/character-loop-videos:main
gh workflow run deploy-cloudflare-worker.yml --repo kimito-link/line-harness-oss --ref main
gh run list --repo kimito-link/line-harness-oss --workflow=deploy-cloudflare-worker.yml --limit 2
gh run watch <run-id> --repo kimito-link/line-harness-oss --exit-status
```

現在の作業ブランチ: `feat/character-loop-videos`（origin/forkとも同期済み、作業ツリークリーン）

本番URL: `https://kimitolink-line.info-a40.workers.dev`

---

## 今日1日の作業の時系列（要約）

1. 前日までにキャラクター動画（りんく・こん太・たぬ姉の8秒ループ動画）をLPに実装済み
2. 実機Bot送信テストで「Botが自分の動画に対して他人事描写（三人称）しかしない」問題を発見
3. **3段構え設計フロー**（会議ハーネス→Fable設計→実装）を2周実施:
   - 1周目: 自己言及機能の設計 → `_docs/SELF-RECOGNITION-DESIGN.md`
   - 2周目: 自己言及・動画品質・安定性の3軸を統合した総合設計 → `_docs/BEST-IN-CLASS-DESIGN.md`
4. Phase 1（Worker側の決定的文字列マッチングでの自己言及判定）を実装・デプロイ・実機成功確認
5. Sprint 1（無言化解消・503限定リトライ・observability修正・構造化ログ）を実装・デプロイ
6. Sprint 2 Tier 0（送信済み動画のSHA-256完全一致判定）を実装したが**実機では未ヒット**（後述）
7. A-1追加改善（こん太のオレンジ髪判定をweight3に格上げ）→ 実機で成功確認

---

## 実装済み・デプロイ済みの内容（コミット順）

| コミット | 内容 |
|---|---|
| `491fb26` | 人格プロンプトに自己外見カード追加（効果なし、後にコードで解決） |
| `cbf6041` | Phase 1: `self-recognition.ts`の`matchSelfCharacter`実装、webhook.tsに組み込み |
| `08e29ef` | Sprint 1: C-1無言化解消／A-1 KEMOMIMI追加／C-2 503限定リトライ／C-3 wrangler.toml observability／C-4構造化ログ |
| `396a330` | Sprint 2 Tier 0: `bot_media_assets`テーブル追加、webhook.tsにSHA-256照合追加 |
| `5c2653f` | Tier 0用のseed migration（Bot送信済み動画6本のハッシュ登録） |
| `bf44e58` | A-1追加修正: こん太のオレンジ髪をweight3に格上げ |

### 主要ファイル
- `apps/worker/src/services/self-recognition.ts` — 自己言及の決定的判定ロジック（`matchSelfCharacter`）
- `apps/worker/src/services/self-recognition.test.ts` — 13ケース、全通過
- `apps/worker/src/services/media-describe.ts` — describeVideoに503限定リトライ実装
- `apps/worker/src/services/llm-providers.ts` — `callGeminiVideo`の戻り値を`VideoCallResult`判別型に変更
- `apps/worker/src/routes/webhook.ts` — Tier 0照合・Tier 1判定・fail_notice・構造化ログを699〜830行付近に実装
- `packages/db/migrations/055_bot_media_assets.sql` / `056_bot_media_assets_seed.sql`
- `apps/worker/wrangler.toml` — トップレベルにも`[observability]`追加

### 設計書（次回作業時に参照）
- `_docs/SELF-RECOGNITION-DESIGN.md` — Phase 1の設計
- `_docs/BEST-IN-CLASS-DESIGN.md` — Sprint 1/2/3の総合設計（優先順位の裁定・各案の評価一覧あり）

---

## 実機検証結果（重要）

### 成功したこと
- **りんく**: 自分の動画送信→「わたし…だよね？」の一人称反応、成功
- **こん太**: A-1修正後、「こん太くんが動画に登場しているようですね！」の仲間言及、成功（オレンジ髪のみの描写でも判定成功）
- **C-1無言化解消**: describe失敗時に「ごめんね、いまこの動画をうまく見られなかったみたい…」の定型返信が実際に返ることを確認（以前は完全無言だった）
- **C-4構造化ログ**: `[media-pipeline]`ログでsha256・outcome・describe結果・selfMatchが可視化され、原因診断が即座にできるようになった

### 未解決の問題（次回引き継ぎ事項）

**1. Tier 0（ハッシュ完全一致判定）が実機で機能していない**
- ローカルのオリジナルファイル（例: `link-bot-test.mp4`）をそのまま送信しても、`exact_hash`にマッチせずTier 1にフォールバックしている
- 原因未確定（ログでの確定確認ができていない）。最有力仮説はLINEアプリが動画送信時に必ず何らかの再エンコード・圧縮を行い、バイト列が変わること
- 設計書§2.2の実験プロトコル（3経路でのrecall測定）は未実施
- 対応方針: ユーザーの判断で「Tier 0は保留し、A-1（特徴語）の強化に集中」と決定済み。Tier 0のコード自体はデプロイ済みで実害はない（ヒットしないだけでfail-openにフォールバックする設計なので問題ない）が、優先度は下げてよい

**2. たぬ姉が4回連続でfail_noticeになった（セッション終了直前）**
- りんく・こん太は成功したのに、たぬ姉だけ`tanunee-bot-test.mp4`と`tanunee-hero.mp4`の両方で連続してGemini describeが失敗し続けた
- 503の可能性が高いが、4回連続は偶然にしては多い。Gemini側の一時的な障害か、たぬ姉の動画ファイル特有の問題（サイズ・エンコード）かは未確定
- **次回まずやること**: たぬ姉動画を再送信し、Cloudflareダッシュボードの`[media-pipeline]`ログで`describe`の失敗理由（`http_503`か`timeout`か等）を確認する

**3. Cloudflare Observabilityのログ確認が本セッションでは不安定だった**
- Chrome拡張（`mcp__claude-in-chrome__*`）でCloudflareダッシュボードにアクセスしようとすると、ログイン切れになることが頻発した
- 確実にログを見るには、ユーザーの実際のブラウザ（既にログイン済み）で開いてもらうか、`wrangler tail`のCloudflare認証を別途設定する必要がある

---

## 実行環境の注意点（今回判明した制約）

- **`Textinputhost`という見えないプロセスが繰り返し前面に居座り、クリック操作をブロックする**ことがあった。ユーザーに何かクリックしてもらうと解消した。原因不明だが、コンピュータ操作でクリックが`Textinputhost is not in the allowed applications`エラーになったら、ユーザーに一度何かクリックしてもらうよう頼むとよい
- **LINEデスクトップアプリはウィンドウが頻繁にフォーカスを失う**。`open_application`で毎回明示的に前面化してからクリックする必要がある
- **LINEの動画アップロード圧縮が非常に強力**。16.8MB・24.7MB・72MBのいずれの動画も問題なくアップロードされ、`tooLargeNotice`（15MB超過用の既存メッセージ）を意図的に再現するのが困難だった（72MBのノイズ動画でも通った）
- **Bandicam録画**: `mcp__computer-use__request_access`で許可後、`open_application`で起動できるが、RECボタンクリックが`Textinputhost`にブロックされることがあった。ユーザーに直接RECボタンを押してもらうことで解決した
- Cloudflare Workersのobservability設定は`wrangler.toml`の`[env.production.observability]`だけでなく、**トップレベルの`[observability]`にも必要**（テスト環境用）。ダッシュボードのUIトグルで有効化しても次のデプロイで消える（wrangler.tomlの設定が優先されるため）
- GitHub Actionsのmigrationステップで、まれに`_migrations`テーブルへのINSERT時に`UNIQUE constraint failed`が発生することがあった（レースコンディションらしき挙動）。ワークフローを再実行すれば直る

---

## 次にやること（優先順位）

1. **たぬ姉のfail_notice連発の原因調査**（最優先）: Cloudflareログで`describe`失敗理由を確認。503なら様子見、それ以外なら`self-recognition.ts`や`media-describe.ts`のたぬ姉固有のバグを疑う
2. 3キャラ全員が実機で一人称/仲間言及に成功することを確認（りんく・こん太は済み、たぬ姉のみ未確認）
3. Sprint 3（動画品質: poster画像・previewImageUrl等）は、A/C軸が安定してから着手（`_docs/BEST-IN-CLASS-DESIGN.md`§4参照）
4. Tier 0のrecall実験（設計書§2.2）は優先度低、余裕があれば実施

## ユーザーの意向（重要な文脈）

- 「最高のものを作りたい」「みんなが使える良いプロダクトを作るがすべて」という強い要望があり、時間をかけて実機検証・修正を繰り返すことを歓迎している
- 動画が読み込めなかったパターンでも無言にならない、という今回の改善を高く評価している
- 3段構え（会議ハーネス→Fable→実装）のワークフローに慣れており、次回も複雑な設計判断が必要な場面ではこの手順を使うとよい
