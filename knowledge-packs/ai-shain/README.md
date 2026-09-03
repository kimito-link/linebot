# ai-shain（設定は ai-shain-worker に移動しました）

このパックの正本は `kimito-link/ai-shain-worker` に移動しました。
**ここには設定ファイルを置かないでください。**

- リポジトリ: https://github.com/kimito-link/ai-shain-worker
- 正本の場所: `knowledge-pack/`
- ローカル: `C:\Users\info\OneDrive\デスクトップ\Resilio\github\ai-shain-worker`

## 文面を変えるときの手順

Cloudflare Workers はファイルシステムを持たないため、本番が実際に読むのは
`apps/worker/src/services/groq-knowledge-content.ts` に埋め込まれた文字列定数です。
この `.ts` は**自動生成物**なので直接編集しないでください。

```
cd ../ai-shain-worker
# knowledge-pack/ の .md / .txt を編集してから
node scripts/sync-knowledge-pack.mjs
```

生成された `.ts` の差分を line-bot 側でコミットしてデプロイします。

## 経緯

以前は `.md`（人が読む用）と `.ts`（本番用）を手で二重更新する運用でしたが、
2026-07-17 のエスカレーション修正（`9b30812`）が `.md` にしか入らず、
本番プロンプトには一度も反映されないまま約6週間放置されていました。
同じ事故を防ぐため、正本を1つにして生成に切り替えています。
