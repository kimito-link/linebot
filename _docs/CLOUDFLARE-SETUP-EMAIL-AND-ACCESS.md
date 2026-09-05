# Cloudflareでやる設定（メール受信 と 配線図の鍵）

作成: 2026-09-05。**画面での操作だけ。コードの追加はもう要りません。**

★どちらも認証を伴うので、AIが代行しません。ここは作者の手が要ります。

---

# A. メール通知をLINEに転送する（10分）

## A-1. 受信用のアドレスを作る

1. https://dash.cloudflare.com を開く
2. 左の一覧から **kimitotalk.link** を選ぶ
3. 左メニューの **「Email」→「Email Routing」**
4. 初回なら **「Enable Email Routing」** を押す
   - DNSレコードを自動で足すか聞かれる → **足す**（MXレコードが要ります）
   - ★このドメインでメールを受け取ったことが無ければ、既存のメール設定は壊れません

## A-2. Workerを宛先にする

1. 同じ画面の **「Routes」** タブ
2. **「Create address」**
3. 入力:
   - **Custom address**: `notify`（＝ `notify@kimitotalk.link` になります）
   - **Action**: **「Send to a Worker」** を選ぶ
   - **Destination**: 一覧からWorkerを選ぶ
     ★名前は GitHub の Variables の `WORKER_NAME` と同じものです。
       分からなければ、Workers の一覧で「最近デプロイされたもの」を見れば分かります。
4. **Save**

★「Send to a Worker」が選べない場合、Workerがまだ `email` ハンドラを持つ版で
デプロイされていません。mainにpush済みなら数分待ってから開き直してください。

## A-3. 通知メールをそこへ流す

**どちらか一方でOKです。**

**方法1: 各サービスの通知先を変える（おすすめ）**
- ランサーズ・ココナラ等の「登録メールアドレス」を `notify@kimitotalk.link` にする
- ★確実で速い。ただしサービスによっては本人確認メールもそこへ行くので、
  最初の1つで試してから広げるのが安全

**方法2: Gmailから自動転送**
- Gmail →「設定」→「メール転送と POP/IMAP」→「転送先アドレスを追加」
- `notify@kimitotalk.link` を入れる
- ★確認コードのメールが notify@ 宛に届きます。届いたコードはLINEに
  「未登録の通知メールが届きました」として出るので、そこから読めます
- フィルタで「ランサーズから来たものだけ転送」にすると、余計なものが流れません

## A-4. 動いたかを確かめる

1. ランサーズ等から通知が来るのを待つ（またはテストで自分に送る）
2. **LINEに「【ランサーズ】…」と届けば成功**
3. 届かないときは、下の「困ったとき」へ

---

# B. 配線図（/line-root/）の鍵を本物にする（5分）

## ★先に知っておくこと

いまの `/line-root/` は:
- **本番では404**（CIを回したときだけ配信される作り）
- パスワード3041は**HTMLを読めば分かる**。中身を配ってからJSで隠しているだけ

## ★パスキーは、ここでは使えません

パスキーは「端末が署名 → **サーバーが検証**」の仕組みです。
`/line-root/` は静的HTMLなので検証する相手がおらず、
JSで「成功したことにする」だけになります。**今のパスワードと強さは変わりません。**

代わりに **Cloudflare Access** を使います。こちらは:
- ページに届く**手前**で止めるので、**HTMLが1バイトも配られない**
- Googleログイン、またはメールに届く確認コードで入る
- **コード変更ゼロ**（設定だけ）

## B-1. Accessを有効にする

1. Cloudflare ダッシュボード → 左上で **Zero Trust** に切り替え
   （初回はチーム名を決めます。無料枠で足ります）
2. 左メニュー **「Access」→「Applications」**
3. **「Add an application」→「Self-hosted」**

## B-2. 保護する場所を指定する

- **Application name**: `LINE導線の地図`
- **Session Duration**: 24時間くらい
- **Application domain**:
  - Subdomain: （空欄）
  - Domain: `kimitotalk.link`
  - **Path: `line-root`** ← ★ここが重要。これを入れないとサイト全体が鍵になります

## B-3. 誰が入れるかを決める

1. **「Add policy」**
2. Policy name: `自分だけ`
3. Action: **Allow**
4. Include: **Emails** を選び、自分のメールアドレスを入れる
   - 複数人で見るなら、ここに足していけます
5. **Save**

## B-4. 確かめる

1. シークレットウィンドウで `https://kimitotalk.link/line-root/` を開く
2. **Cloudflareのログイン画面が出れば成功**
3. メールアドレスを入れる → 届いた確認コードを入れる → 地図が見える

## B-5. 古いパスワードをどうするか

Accessが効いたら、ページ内のパスワード（3041）は**二重の鍵**になります。
残しておいても害はありませんが、外すなら:

`scripts/build-line-root.mjs` の `body class="locked"` を `body` にして再生成すれば、
パスワード入力が出なくなります（★Accessを先に確認してから。順番を逆にすると無防備になります）。

---

# 困ったとき

## メールが届かない

**まず記録を見ます。** 届かなくても記録は残る作りです。

```bash
cd apps/worker
npx wrangler d1 execute <本番のDB名> --remote \
  --command "SELECT received_at, from_address, from_source, rule_site, status, detail FROM email_events ORDER BY received_at DESC LIMIT 10" --json
```

| status | 意味 | どうする |
|---|---|---|
| `delivered` | 送れた | LINE側を確認 |
| `unmatched` | ルールに当たらない | `from_address` と `subject` を見てルールを足す |
| `push_failed` | LINEへ送れなかった | `detail` に理由。トークン切れが多い |
| `parse_failed` | メールを読めなかった | `detail` に理由 |

★**1件も記録が無い**なら、メールがWorkerに届いていません（A-2の設定を確認）。

## 差出人が変な値になっている

`from_source` を見てください。

- `header-from` … ふつう
- `body-forwarded-block` … 転送メールから復元した（Gmail転送のとき正常）
- ★`header-from` なのに転送者のアドレスになっている場合、
  転送ブロックの形が想定と違います。そのメール1通を確保して調整が要ります

## Accessでログインできない

- **Path を間違えていないか**（`line-root` であって `/line-root/` ではない）
- ポリシーの Emails に自分のアドレスが入っているか
- 迷惑メールフォルダに確認コードが入っていないか

---

# ★やってはいけないこと

- **通知先をメールの中身から決める**ようにしない。
  いまは固定リスト（あなたのLINE）にしてあります。ここを「メールに書かれた宛先へ送る」に
  変えると、偽メール1通で通知先を乗っ取られます。
- **Access の Path を空にしない。** サイト全体が鍵の内側に入り、
  お客様がLPを見られなくなります。
