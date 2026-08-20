# 実装ハンドオフ — 「GPTお引越しパック（仮称）」

> この1枚だけで着手できる。地図: [GPTS-CONVERSION-OPPORTUNITY-MAP.md](GPTS-CONVERSION-OPPORTUNITY-MAP.md) ／ 仕様: [GPTS-CONVERSION-OPPORTUNITY-SPEC.md](GPTS-CONVERSION-OPPORTUNITY-SPEC.md)
> 2026-08-17 ／ 実装は本ハンドオフを次チャット/別モデルに渡すか、ユーザーから明示的な指示があるまで着手しない。

## スコープ（MVPだけ）

仕様書4章のとおり、新規に作るのは3点のみ:

1. `knowledge-packs/_template/`（persona.md / guardrails.md / docs/ / canned/ の雛形＋README記入ガイド）
2. `apps/lp/gpt-hikkoshi.html`（新規LP1枚）
3. `tools/generate-knowledge-content.mjs`（md正本→TS定数の生成スクリプト＋テスト1本）

**やらないこと**（仕様書6章 Out of Scope）: アフィリエイトASP単体商品化、法人向け訴求、既存4製品の生成スクリプト移行、GPTエクスポート自動化、新規ダッシュボード、他Harnessシリーズとの連携。

## 着手前に必ず決めること（実装者への質問・仕様書では未確定）

着手する前に、以下をユーザーと1回相談して確定させる。ここを飛ばすと手戻りになる:

1. **テストファイルの配置**（仕様4-1注記）: `scripts/generate-knowledge-content.test.ts` に置いてルートvitest([vitest.config.ts:8](vitest.config.ts))の既存includeパターンに乗せるか、`vitest.config.ts`のincludeに`tools/**/*.test.ts`を追加するか。前者が既存慣行に忠実、後者が構成として素直。**どちらでもよいが、実装前に1つ選ぶ**。
2. **価格金額と判定基準**（未解決の質問1・2）: 仕様書は「¥980超〜ai-shain個別見積り未満」という帯までしか決めていない。具体額と「何件・何週間で継続/撤退を判断するか」をユーザーと相談して数値を確定してからLPに書く。

## 着手手順

1. ブランチを切る（例: `feat/gpt-hikkoshi-pack`）
2. **段階0（ドッグフーディング）を最初に実施**（仕様5-1）: 自社の何らかのGPT相当コンテンツを1つ選び、実際に`_template/`をコピー→移植→生成スクリプトで動かしてみる。ここでA3（instructions移植の工数が現実的か）が検証される。**この段階を飛ばして段階1（LP公開）に進まない**——利用者視点で最大のリスクは「移植作業が思ったより重い」ことなので、他人（顧客）に見せる前に自分で1回通す。
3. TDDで`tools/generate-knowledge-content.mjs`から着手（仕様5-2: 入力md→期待TS出力のスナップショットテスト、既存4製品名を指定した場合のエラー終了テスト）
4. `_template/`一式を作成（仕様4-1）
5. 段階0のドッグフーディング対象で生成スクリプトを実走させ、`apps/worker`のビルドが通ることを確認（仕様5-2）
6. `apps/lp/gpt-hikkoshi.html`を作成（仕様4-3の6項目構成。文体は`_template/persona.md`のデフォルト人格と一致させる——仕様Further Notes #2）

## 実装ステップの参照先

各ステップの詳細は仕様書の該当章を参照:
- ディレクトリ構成・ファイル内容 → 仕様4-1
- 生成スクリプト仕様 → 仕様4-2
- LP構成 → 仕様4-3
- 顧客案件の増設手順（デリバリー手順） → 仕様4-4
- テスト方針 → 仕様5-2

## 機械的な完了判定

- [ ] `tools/generate-knowledge-content.mjs` が既存4製品名（ai-shain/soushin-suggest/henshin-hisho/web-health-check）を拒否する
- [ ] `_template/`をコピーして作った1案件で、生成スクリプト実行後に `apps/worker` のビルド（`pnpm -F worker build` 等、実装時に既存コマンドを確認）が通る
- [ ] 生成されたTSファイル冒頭に `// GENERATED from knowledge-packs/<product>/ — do not edit by hand` が入っている
- [ ] `apps/lp/gpt-hikkoshi.html` にGPTs停止の事実（新規作成・公開の停止のみ。既存GPTは編集・利用継続可、Business/Enterprise除外）が地図1-1の範囲を超えずに書かれている
- [ ] LPに「今だけ」「必ず」等の煽り語が無い（guardrails.mdの禁止語リストと同水準でセルフチェック）
- [ ] 段階0のドッグフーディングが実際に1件通っている（スクリプトが動く、だけでなく移植作業を人手で1回やってみた記録が残っている）

## 地雷（仕様書Further Notesから再掲・優先度順）

1. **vitest配置を先に決める**（着手前チェック1）。決めずに書き始めると生成スクリプトのテストが孤立する。
2. **二重管理の混在**: 新規案件＝生成スクリプト経由、既存4製品＝手書きのまま。生成スクリプトが誤って既存4製品を上書きしないよう、除外リストのテストを最優先で書く。
3. **fail-closedを弱めない**: 「Botが答えられない」を理由にClaudeフォールバック等のコスト増改修をしない。README.md:120の設計を顧客案件にも適用する。
4. **`ai-shain-worker-task.ts`の開発者専用機能を顧客案件に混入させない**（同ファイル:20-25の送信者チェックは商品化対象外）。
5. **fan_memory機能はデフォルト無効で引き渡す**（有効化する場合は同意・削除フロー`migrations/061`が前提）。

## 実装する場合の検証

- 実装後は**reality-checkerに検証を委任**（自己採点しない）。仕様書5-2「コードの検証」を検証依頼の土台にする。
- 変異テスト: 生成スクリプトの除外リスト判定を一時的に外し、既存4製品名でもテストが赤くならないことを確認 → 復元。
- プロジェクトの出荷ゲート（`package.json`のscriptsを確認し、lint/typecheck/testを通す）を通してからcommit。

---

## 次にやること

**次チャットで本ハンドオフを読ませ、ブランチを切って実装**してください。実装は本セッションでは行いません。着手前チェック2点（テスト配置・価格帯の具体額）は実装開始前にユーザーと相談して確定させてください。
