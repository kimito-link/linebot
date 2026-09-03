# LINE導線の地図（/line-root/）

`github/` 配下の全リポジトリに散らばった LINE 導線を1枚にまとめたページ。
`https://kimitotalk.link/line-root/`（パスワード **3041**）。

## ★方針: 推測を書かない

3色で出す。**「まだ確かめていない」を必ず第3の色で出す。**

| 色 | 意味 |
|---|---|
| 緑 | 確かめて繋がっている |
| 赤 | 確かめて切れている |
| 黄 | **まだ確かめていない** |

確かめていないことを緑や赤に塗ると、地図そのものが嘘になる。
各項目に「確かめ方」を必ず添える。

★**外から叩いて状態を推測しない。**
2026-09-03、`/r/:ref` を外から叩いて「entry_route 未登録」と判定したが、
実際は `getRandomPoolAccount`（複数アカウントへのランダム振り分け）で
毎回違う結果が出ていただけだった。同じ罠を仕組みに埋め込まない。

## 作り方

```bash
# 1. 集める（--offline なら疎通確認とD1を省く。速い）
node scripts/collect-line-root.mjs

# 2. 組み立てる
node scripts/build-line-root.mjs

# 3. 見る（★apps/lp をルートにする。リポジトリ直下だと /site-chrome.css が全部404）
cd apps/lp && python -m http.server 5193
#  → http://127.0.0.1:5193/line-root/
```

D1 を含めるには `D1_DATABASE_NAME` と Cloudflare の資格情報が要る。
**手元のトークンでは D1 が読めない**（`Authentication error [code: 10000]`）ので、
実データ入りは CI（`.github/workflows/build-line-root.yml`）で生成する。

## ★機密を出さない仕組み（3重）

1. **SELECT でそもそも取らない** — `line_accounts` には
   `channel_access_token` / `channel_secret` / `login_channel_secret` が入っている。
   `SELECT *` は禁止。カラムを明示指定する（`collect-line-root.mjs` の `QUERIES`）
2. **生成後に検査** — `build-line-root.mjs` が出力を走査し、混入があれば exit 1
3. **配信前にもう一度** — CI の「機密が混ざっていないか検査」step

## ★リポジトリにコミットしない

`kimito-link/linebot` は **public**。導線データを push すると誰でも読める。
- `apps/lp/line-root/` → `.gitignore`
- `scripts/.line-root-data.json` → `.gitignore`

CI は生成 → そのまま Pages へ配信し、リポジトリには残さない。

## パスワードについて

`3041`。方式は `partnership_program_website/client/public/share/line-harness.html`
と同じ（sessionStorage に記憶するフロントのゲート）。

★**本気の鍵ではない。** HTMLを読めばパスワードが分かる。
共有相手を限るためのもの。だから**外に出せない情報は載せない**。

## 走査で除外しているもの

| 除外 | 理由 |
|---|---|
| `node_modules` / `dist` / `build` 等 | 依存・成果物 |
| `*.test.ts` / `*.spec.js` / `dist-mock/` | テストの固定値。実在の導線ではない |
| `download/` / `Cache_Data/` | 保存済みHTML。ouenmovie に185件あるが全部よそのページ |
| `_pending-deletion-review` / `.claude/worktrees` / `legacy` | 旧クローン（参考として集計はする） |
| ダミーLIFF ID（`1234567890-abcdefgh` 等） | 手順書の例 |

★これらを入れると「実在する導線」と誤読される。

## CI での制約

CI では `github/` 配下の**他リポジトリが存在しない**。走査はこのリポジトリの中だけになる。
他リポジトリを含む完全版が要るときは、手元で `collect` を回してから `build` する。
