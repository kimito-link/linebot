# 段階0ドッグフーディング実測記録

> 2026-08-17実施。仕様書[GPTS-CONVERSION-OPPORTUNITY-SPEC.md](GPTS-CONVERSION-OPPORTUNITY-SPEC.md) 5-1章「段階0」の実施記録。
> 価格設計[GPTS-HIKKOSHI-PACK-PRICING-DESIGN.md](GPTS-HIKKOSHI-PACK-PRICING-DESIGN.md) 5章の`H0`実測値。

## 題材

実在の顧客案件ではなく、テンプレート移植フローの検証用に用意した架空のGPT instructions
（「請求書チェッカーくん」——フリーランス向け請求書記載漏れチェックという想定、英日混じり・GPT Builder風の原文）。
案件名`dogfood-invoice-checker`として`knowledge-packs/dogfood-invoice-checker/`に構築した。

## 工程別実測時間

| 工程 | 所要時間 |
|---|---|
| ①読み込み（架空GPT instructions作成・読解） | 21秒 |
| ②persona.md移植 | 8秒 |
| ③guardrails.md + canned/ + docs/移植 | 18秒 |
| ④生成スクリプト実行 | 瞬時 |
| ⑤matchCannedResponse手書き＋knowledge-packs.ts登録＋型チェック | 26秒 |
| **合計 H0** | **約73秒** |

## 解釈（価格設計への反映）

- この実測は「機械的な移植作業のみ」の所要時間であり、以下は含まない: 顧客ヒアリング、顧客からのGPTエクスポート待ち、
  LINE公式アカウントの実接続作業、顧客との動作確認往復。
- 価格設計書5章の懸念どおり、**自社が用意した題材＝内容既知・ヒアリング不要**のため、この値は「下限の工数」。
  他人の実際のGPT（instructions が長い・矛盾がある・散逸している等）ではこれより確実に伸びる。
- 補正係数k（初期値1.5、価格設計書5章）は、この実測だけでは検証できない。**段階1の実案件1件目で更新が必要**という
  価格設計書の記述は妥当だったと確認できた。

## 副産物として分かった地雷（実装ハンドオフに追記すべき事実）

1. **生成スクリプトの再実行は手書き部分を破壊する**: `matchCannedResponse`のTODOを手書きで埋めた後、
   `node tools/generate-knowledge-content.mjs dogfood-invoice-checker` を再実行すると、
   その手書き部分は生成テンプレートの`return null;`スタブで上書きされる（生成スクリプトは全文を毎回書き直すため）。
   運用ルール: **canned/docsを追加・修正して再生成する場合は、matchCannedResponseの手書き分を退避してから再適用する**。
   これは既存4製品の「mdとTSの二重管理」問題とは別の、新しい二重管理点（TS内の生成部分と手書き部分の混在）。
2. **`_template`という名前は生成スクリプトの拒否リストに含まれない**: `_template`自体を製品名として指定すると
   生成が通ってしまう（意図しない誤操作）。実害は小さい（`_template`ディレクトリ自体は正しい内容なので壊れたファイルは生成されない）が、
   将来的に拒否リストへ`_template`を含める改善余地がある（今回はMVPスコープ外として見送り）。

## ビルド確認

`apps/worker`の`tsc --noEmit`が通ることを確認済み（エラー出力なし）。

## 後片付けについて

このドッグフーディング成果物（`knowledge-packs/dogfood-invoice-checker/`、
`apps/worker/src/services/dogfood-invoice-checker-knowledge-content.ts`、
`knowledge-packs.ts`への登録）は、実測記録として残すか、テスト用ダミーとしてコミット前に削除するかは
ユーザー判断に委ねる。次の実装者（reality-checker含む）が生成スクリプトの動作確認に使えるため、
このセッションでは残したまま次工程（LP作成）に進む。
