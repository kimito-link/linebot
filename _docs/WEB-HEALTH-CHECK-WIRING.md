# web健診 LINE窓口の配線手順 (2026-08-07)

コード側は完了。**残りは Cloudflare 権限が要る2手順だけ**。

## 済んでいること

| | コミット |
|---|---|
| knowledge-pack 一式 (persona/guardrails/canned/docs) | `470d14e` |
| Workers バンドル定数 + `knowledge-packs.ts` 登録 | `470d14e` |
| `bot.config.json` の projects に `web-health-check` を登録 | `db8b104` |
| 登録漏れを検出する回帰テスト | `db8b104` |

`apps/worker`: vitest 887件全緑 / `tsc --noEmit` 通過。

## 残り1: デプロイ

このリポの `CLOUDFLARE_API_TOKEN` は `wrangler whoami` は通るが、
Workers/D1 の操作で `Authentication error [code: 10000]` になる
（トークンの権限スコープが足りない）。

さらに `apps/worker/wrangler.toml` の `account_id` が
`YOUR_ACCOUNT_ID` / `YOUR_DEV_ACCOUNT_ID` のままなので、
実アカウントIDを入れる必要がある。

```bash
cd "C:\Users\info\OneDrive\デスクトップ\Resilio\github\line-bot\apps\worker"; npx wrangler deploy --env production
```

## 残り2: entry_routes に ref_code を登録

**これが無いと web健診の友だちに AI社員の人格が応答する。**

`resolveBotProject` の解決順（`apps/worker/src/services/bot-project.ts`）:

```
friend.ref_code なし          → defaultProject (ai-shain-link)
ref_code に entry_routes 無し → defaultProject
entry_routes.project が NULL  → defaultProject
project が未登録              → defaultProject (+warn)
上記以外                      → その project
```

つまり **ref_code 付きの友だち追加URL** と、
**`entry_routes.project = 'web-health-check'`** の両方が要る。

管理画面（`apps/web`）の流入経路（entry routes）から登録するか、D1 に直接:

```sql
INSERT INTO entry_routes (id, ref_code, name, project, is_active)
VALUES ('<uuid>', 'whc', 'web健診LP', 'web-health-check', 1);
```

登録後、LP の LINE リンクを ref_code 付きに差し替える。
現在 LP が指しているのは以下の2本（`web-health-check.link/src/pages/index.astro`）:

- 風評: `https://lin.ee/X2aWSFO`
- IT: `https://lin.ee/lrjVHvH`

## ★運用上の約束（LPに書いてしまった以上、守る必要がある）

LP `#next-step` に明記済み:

- 担当者が **24時間以内** に返事をする
- 必要なら **電話・Zoom** でも話せる
- **売り込みの連絡はしない**
- 見積りを見てから決めてよい。断っても、その後の連絡はしない

canned の `greeting` / `escalation` もこの文面に揃えてある。
**ステップ配信の自動応答は1通目として出してよいが、それで「返信した」ことにはならない。**
守れなくなった場合は、LP側の記載を先に直すこと。

## 分岐の全体像

`matchCannedResponse`（`web-health-check-knowledge-content.ts`）は
**上から順に判定し、当たった時点で止まる**。並び順が効いている。

1. 結果の見方（健全/注意/要対応・検出ゼロの3つの意味）
2. 何を頼めるか（口コミは1件から・金額は答えない）
3. はじめの挨拶（4ステップ・売り込みしない）

※ 1 を 2 より先に置くこと。逆にすると「結果の**見方**」が
2 側の正規表現（`料金|費用|できること`）に吸われる。

いずれにも当たらない場合のみ LLM が応答し、
見積り・依頼・電話希望・法的対応・判断不能なら `[ESCALATE]` で担当者へ回る。
