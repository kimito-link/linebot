# 実装ハンドオフ — Kimito Link 価値提案の再定義（LPコピー修正）

> このファイル1枚で着手できます。設計の全文は [`KIMITO-LINK-VALUE-PROPOSITION-DESIGN.md`](KIMITO-LINK-VALUE-PROPOSITION-DESIGN.md) 参照（読む必要があるのはD-1・E章だけで十分）。
> 3段構えワークフロー（council-fable）の手順3の産物。ユーザー承認済み（2026-07-21）。

## スコープ（今回やるのはこれだけ）

`apps/lp/index.html` のコピー修正のみ。**コード（Bot本体）は一切変更しない**。設計書のB章・C章（料金体系・
アーキ）は将来構想であり、今回は実装しない。

## 方針（設計書より要約）

- 「言葉で人格を自由に作れる」訴求を**削除**。人格カスタマイズ機能は実装しない。
- 「自分を認識してもらえる」体験（dHash自己認識）を**主軸**に据える。
- 偲び・グリーフケア用途は**訴求に含めない**（今後も扱わない、設計書A-3参照）。
- 既存のREAL DEMOセクション（今回のセッションで追加したdHashデモ動画埋め込み）は**そのまま活用**。

## 修正箇所（`apps/lp/index.html`、実在確認済み）

| 行 | 現状 | 修正方針 |
|---|---|---|
| 7 (meta description) | 「性格も口調も距離感も自由に設計できるAI人格を、いつものLINEで。使い方は無限大。」 | 「公式動画・画像を見分けて、"それ、わたしだ"って気づいてくれるAIキャラと、いつものLINEで。」系に差し替え |
| 11 (og:description) | 同上 | 同上 |
| 18 (twitter:description) | 同上 | 同上 |
| 243 (hero-sub) | 「性格も、口調も、距離感も、ぜんぶあなたが決める。あなたが言葉で生んだ"その人"が、いつものLINEで待っています。」 | 「送った動画や写真に、"それ、わたしだ"って気づいてくれる。3人のキャラが、いつものLINEで待っています。」系 |
| 255 (trio-bubble link) | 「口調も、距離感も、呼び方も。言葉で伝えるだけで、ちゃんとその通りに話してくれるのだ。恋人みたいな距離感にも、コンサルみたいな話し方にもできるのだ。」 | 認識体験の実演台詞へ差し替え（例:「わたしが写ってる動画を送ってみて。ちゃんと"わたしだ"って気づくのだ。」） |
| 269 (multimodal section-lead) | 「口調も、価値観も、あなたとの関係も。人格は自分で決められます。」 | 削除、または「送った写真や動画を、キャラがちゃんと見て、覚えていてくれます。」に差し替え |
| 274 | 「おかえりを言ってくれる、デート気分の会話。距離感も口調もあなた好みに。」 | このカード自体、「使い方は無限大」6カードの中で人格カスタマイズ前提のものは書き直しか削除を検討（6カード全体を読んで整合性を見ること） |
| 419 (FAQ) | 「口調・価値観・呼び方・関係性など、言葉で伝える形で自由に設計できます。恋人的な距離感にも、フラットな相談相手にもできます。」 | 「今は3人のキャラ（りんく・こん太・たぬ姉）から選んでトークできます。」等、真実の記述へ |

**注意**: 269・274・419周辺は「使い方は無限大」6カードセクション全体に影響する可能性がある。修正時は
このセクション全体を読んで、人格カスタマイズを前提にした文言が他にも無いか確認すること（grep推奨:
`性格|口調|距離感|人格.*決め|言葉で.*設計`）。

## 着手手順

1. `git status`で現在のブランチ・変更状況を確認（このリポジトリは`feat/character-loop-videos`ブランチで
   作業中の可能性がある。LP変更は`origin`リモートのmainに反映する運用）。
2. `apps/lp/index.html`を上記表の方針に沿って編集。
3. ローカルで静的サーバーを立てて目視確認（`python -m http.server <port>`をapps/lp配下で実行し、
   claude-in-chrome等で確認）。
4. 修正差分だけを`origin`（`kimito-link/linebot`）のmainに反映。前回セッションで確立した手順:
   ```bash
   git fetch origin main
   git worktree add <scratchpad>/lp-worktree origin/main
   cd <scratchpad>/lp-worktree
   git checkout -b feat/value-prop-copy-fix
   # index.htmlの差分だけを適用
   git add apps/lp/index.html
   git commit -m "fix(lp): 未実装の人格カスタマイズ訴求を削除し、実装済みの自己認識体験に一本化"
   git push origin feat/value-prop-copy-fix:main
   git worktree remove <path> --force
   ```
5. `apps/lp`ディレクトリで`npx vercel --prod --yes`を実行（GitHub連携の自動デプロイは信用しない）。
6. 本番URL（`https://lp-eight-dusky.vercel.app/`）で修正が反映されているか確認。

## 完了判定（機械的に確認できる基準）

- [ ] `curl -s https://lp-eight-dusky.vercel.app/ | grep "性格も口調も距離感も自由"` が**ヒットしない**
- [ ] `curl -s https://lp-eight-dusky.vercel.app/ | grep "気づいて"` が**ヒットする**
- [ ] `curl -s https://lp-eight-dusky.vercel.app/ | grep "REAL DEMO"` が引き続きヒットする（dHashデモは残す）

## 地雷

- **リポジトリ混同注意**: LP変更は`origin`（kimito-link/linebot）のmainへ。Bot本体の`fork`と取り違えない。
- **Vercel自動デプロイは信用しない**: 必ず`npx vercel --prod`で手動確認する。
- **coding変更は不要**: この作業はコピー修正のみ。Bot本体（`apps/worker`）には触れない。
- **「使い方は無限大」6カード全体の整合性確認を忘れない**: 269・274行だけ直して他のカードに矛盾する
  記述が残ると中途半端な修正になる。
