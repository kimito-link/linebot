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
- **本番で正常に表示される**（★2026-09-05訂正。一時「404」と誤報告した。
  原因は `?cb=乱数` によるキャッシュ回避が効いておらず、CDNの古い404応答を
  掴んでいたこと。`Cache-Control: no-cache` を付けると 200 が返る。
  **クエリを足すだけでは新しい応答を保証できない。**）
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

---

# ★実施記録（2026-09-05）

## 完了したもの（AIが workflow から実施）

| やったこと | 結果 |
|---|---|
| GitHub Secrets のトークン更新 | 完了（`line-harness-deploy` の値） |
| 受信ルール作成 | `notify@kimitotalk.link` → Worker `kimitolink-line` |
| **MXレコード追加** | route1-3.mx.cloudflare.net（★これが無いと届かない） |
| 転送ルールを本番D1へ | **28件**・6354バイト |

**入っているルール（12サービス）**
ランサーズ10 / ココナラ8 / BASE / STORES / Stripe / Googleフォーム /
クラウドワークス / Shopify / PayPal / Amazon / メルカリ / note

★**コードはサービス名を知らない。** 判定に使うのは送信元アドレスと件名の固定部分だけ。
　だからルールを1行足すだけで、どんなサービスでも増やせる。
　実測: 7サービスの実際の件名で、すべて1つのルールにだけ当たることを確認（誤爆なし）。

★**MXが無いと、ルールを作っても1通も届かない。**
実測: ルール作成に成功した直後でも MX は0件だった。
「ルールができた＝届く」ではない。

## 残っているもの

**1. 通知先を `notify@kimitotalk.link` に変える**（作者の操作）
ランサーズ・ココナラ等の登録メールアドレスを変えるか、Gmailから転送する。
★まず1つで試してから広げるのが安全。

**2. Access（配線図の鍵）**
トークンに `Account → Access: Apps and Policies → Edit` が要る。
いま入っているのは `Access: Policies` で、これでは作成できない（実測: 1010 auth.forbidden）。
足したら: Actions → Cloudflare Setup → mode=access → access_emails に自分のアドレス

## 動いているか確かめる

```bash
# 届いたメールの記録（本番）
npx wrangler d1 execute <D1名> --remote --json   --command "SELECT received_at, from_address, from_source, rule_site, status FROM email_events ORDER BY received_at DESC LIMIT 10"
```

1件も無ければ、メールが Worker まで届いていない（MXとルールを確認）。
