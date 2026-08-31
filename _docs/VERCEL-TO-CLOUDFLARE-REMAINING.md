# Vercel を止める前にやること（2026-08-31 時点）

`kimitotalk.link` の Cloudflare Pages 移行は**ほぼ完了**しているが、
**`www` だけまだ Vercel を経由している**。Vercel を止める前にここを直す。

作業は**人がやるしかない**（理由は末尾）。所要は数分。

---

## いま何が起きているか（実測）

```
www.kimitotalk.link → [Vercel] 308 → kimitotalk.link → [Cloudflare] 302 → /kimitotalk/ → 200
                       ↑ ここだけ Vercel に依存
```

見分け方は**レスポンスヘッダの `x-vercel-id`**:

```bash
curl -sI https://www.kimitotalk.link/ | grep -i 'x-vercel-id\|^location'
```

- `x-vercel-id` が出る → **まだ Vercel を通っている**
- 出ない → Cloudflare だけで完結している

> `Server: cloudflare` は判断材料にならない。Vercel の前段に Cloudflare が
> 入っていても `Server: cloudflare` になる。**`x-vercel-id` を見る。**

**いま Vercel を止めると `www.kimitotalk.link` が壊れる。**
apex（`kimitotalk.link`）は Cloudflare 上で完結しているので影響しない。

---

## 手順

### 1. Cloudflare で `www` のDNSを差し替える

ダッシュボード → `kimitotalk.link` → DNS → Records

| | いまの値 | 変える先 |
|---|---|---|
| Type | CNAME | CNAME |
| Name | `www` | `www` |
| Content | `cname.vercel-dns.com` | **`kimitotalk-lp.pages.dev`** |
| Proxy | — | **Proxied（オレンジ雲ON）** |

**★ A と CNAME は同じホスト名で共存できない。**
`www` に A レコードもある場合は**先に消してから** CNAME を作る
（順序を逆にすると `An A, AAAA, or CNAME record with that host already exists`）。

### 2. Pages 側にカスタムドメインを登録する

Workers & Pages → `kimitotalk-lp` → Custom domains → Set up a custom domain
→ `www.kimitotalk.link`

**DNSだけ向けても Pages 側に登録が無いと 404 になる。** 両方要る。

### 3. 証明書が出るまで待つ

切り替え直後は **522（接続タイムアウト）** が出る。**これは正常**で、
証明書の発行待ち。`status: pending → active` になれば解消する（実測で約90秒）。

**慌てて戻さないこと。** 前回の移行でここで戻しかけた。

### 4. 確認する

```bash
curl -sI -L https://www.kimitotalk.link/ | grep -Ei '^HTTP/|^location|x-vercel-id'
```

- `x-vercel-id` が**出ない**こと ← これが本命
- 最終的に `200` に着地すること

apex も一緒に確認する（壊していないこと）:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -L https://kimitotalk.link/
```

### 5. ここまで通ってから Vercel を止める

順序を逆にすると `www` が落ちる。**必ず 4 の確認を先に。**

---

## 戻すとき

```
CNAME  www  ->  cname.vercel-dns.com   （Proxy OFF / DNS only）
```

apex を戻す場合は:

```
A  @  ->  76.76.21.21
```

---

## なぜ人がやるしかないのか

- **Cloudflareダッシュボードはブラウザ自動化を受け付けない**。
  DNS編集のドロップダウンやアクションメニューがクリックに反応しない（bot対策と思われる）
- **APIトークンにZone権限が無い**。実測で `zones?name=kimitotalk.link` が
  `count: 0` を返す（権限が無いとエラーではなく**空**が返るので紛らわしい）。
  Pages権限も無く `wrangler pages project list` は `Authentication error [code: 10000]`

権限のあるトークンを新しく発行すれば自動化できるが、
**この作業のためだけに鍵を1本増やして管理し続けるのは割に合わない**
（数分の手作業 vs 恒久的に持ち回る秘密が1つ増える）。

---

## 済んだら消していい

このファイルは「Vercelを止めるまでの申し送り」なので、
`x-vercel-id` が消えて Vercel プロジェクトを削除したら**このファイルごと消す**。
残っていると「まだやることがある」と誤解される。
