# 顧客案件テンプレート（記入ガイド）

このディレクトリをコピーして `knowledge-packs/<customer-product>/` を作り、
顧客のGPT instructions・ナレッジをここに移植する。

## 増設手順

1. このディレクトリを `knowledge-packs/<customer-product>/` にコピーする
2. `persona.md` — 顧客のGPTの instructions（人格・トーン指示）をベースに書き換える。
   下部の「削除不可: 基本方針」セクションは残したまま、その上のキャラクター・トーン部分だけ書き換える
3. `guardrails.md` — 顧客のGPTが対応できないこと・代行してはいけないことを書く。
   「削除不可」セクションは全案件共通で必ず残す（`_template/guardrails.md`参照）
4. `docs/` — 顧客のナレッジ文書（FAQ・製品説明等）を `.md` で追加する。空でも成立する
5. `canned/` — よくある質問への定型応答を `.txt` で追加する（1ファイル1応答）。
   ファイル名は生成される定数名になる（例: `usage-overview.txt` → `CANNED_USAGE_OVERVIEW`）。
   `escalation.txt` は「担当者へのエスカレーション文言」として特別に扱われる
   （`getFailClosedEscalationText()`が参照する）ので、必ず1つ用意する
6. 生成スクリプトを実行する:
   ```bash
   node tools/generate-knowledge-content.mjs <customer-product>
   ```
   `apps/worker/src/services/<customer-product>-knowledge-content.ts` が生成される
7. 生成されたファイルの `matchCannedResponse` 関数は **TODOスタブ**（常に`null`を返す）。
   顧客のFAQに応じたキーワード判定ロジックを人手で書く
   （既存4製品の `apps/worker/src/services/*-knowledge-content.ts` を参考にする）
8. `apps/worker/src/services/knowledge-packs.ts` の `PACKS` に新しい製品を登録する
9. `apps/worker` のビルドが通ることを確認する

## GPTのinstructionsをpersona.mdへ移植するときのコツ

- GPTのinstructionsは英語混じり・箇条書きでも構わない。持ち込んだ後で日本語の丁寧な文体に整える
- 「絶対」「必ず」「完全自動」等の誇張表現は移植時に削る（guardrails方針と矛盾するため）
- 長いinstructionsは無理に全部移すより、**よく聞かれる上位5パターン**を`canned/`に、
  それ以外は`docs/`にナレッジとして渡し、Groq自由文フォールバックに任せる方が現実的

## docsが空でも成立する

`persona.md`と`guardrails.md`とcanned/1つだけでもBotとして成立する。
`docs/`はナレッジが豊富な案件でのみ追加すればよい。
