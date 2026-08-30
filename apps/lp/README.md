# apps/lp — 公開LP

素のHTML。ビルド不要。CSSは各HTMLの `<style>` にインライン。

| パス | 中身 |
|---|---|
| `/` | `kimitotalk/index.html` にリライト（`vercel.json` / `_redirects`） |
| `/kimitotalk` | メインLP |
| `/gpt-hikkoshi` | GPTお引越しパック |
| `/privacy` | プライバシーポリシー |

新しいページを足すときは `<slug>/index.html` を置き、`sitemap.xml` に追記する。

---

## デプロイ先の移行について（2026-08-30時点）

**いまは Vercel。Cloudflare Pages へ移す準備ができている。**

### なぜ移すか（金額ではない）

Vercelの使用量は $3.36/$20（17%）で、**移行しても金額はほぼ変わらない**。
理由は別にある:

- `apps/web`（管理画面）と `apps/liff` は**既にCloudflare Pages**。
  同じリポジトリなのに**LPだけVercelに取り残されている**
- LPには GitHub Actions が無く（VercelのGit連携頼み）、
  **どこで何が起きているかリポジトリから読めない**

### 用意してあるもの

| ファイル | 役割 |
|---|---|
| `.github/workflows/deploy-cloudflare-lp.yml` | Cloudflare Pagesへの配信 |
| `_redirects` | `/` → `/kimitotalk/index.html`（`vercel.json` の rewrites と等価） |
| `_headers` | 動画・画像の長期キャッシュ、クリックジャッキング対策 |

`vercel.json` の `cleanUrls: true` に相当する挙動は Cloudflare Pages の既定なので、
設定は不要（`/privacy/index.html` が `/privacy` でも配信される）。

必要なsecretsは既存のものと同じ（`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`）。
新規登録は要らない。プロジェクト名は変数 `LP_PAGES_PROJECT_NAME`（既定 `kimitotalk-lp`）。

### 切り替えの手順（この順で）

1. リポジトリ変数 `LINE_HARNESS_CLOUDFLARE_DEPLOY` が `true` であることを確認
2. Actionsから `Deploy Cloudflare LP` を手動実行（`workflow_dispatch`）
3. **`*.pages.dev` のURLで表示を確認する**。特に:
   - `/` がメインLPになるか（リライトが効いているか）
   - `/privacy` が開くか（拡張子なしURL）
   - 動画2本が再生できるか
4. 問題なければ独自ドメイン `kimitotalk.link` を Cloudflare Pages に向ける
5. Vercel側のプロジェクトを止める

> **3 の前に 4 をやらないこと。** 先にドメインを切り替えると、
> 何か落ちていたときに戻す先が無くなる。

### 移行後にやること

- `vercel.json` と `.vercel/` を消す
- `docs/wiki/Getting-Started.md:219` の `vercel deploy` の記述を直す

---

## 公開前に残っているTODO

- **両LPのCTAが `href="#"` のまま**（`kimitotalk/index.html` と `gpt-hikkoshi/index.html`）。
  LINE公式アカウント発行後、友だち追加URL（`https://lin.ee/xxxxx`）に差し替える。
  現在は `aria-disabled="true"` と「準備中」の表示を添えてあるので、
  押しても何も起きないのが正しい状態。
