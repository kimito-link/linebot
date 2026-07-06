# 27. アフィリエイト ASP（セルフサーブ計測）

LINE Harness に内蔵されたセルフサーブ型アフィリエイト計測機能のリファレンスです。リンク発行からクリック・友だち追加・コンバージョンまでを時系列で計測し、帰属計算からレポート出力まで一気通貫で処理します。

---

## 1. 機能概要

```
アフィリエイター
  ↓  LIFF (?page=affiliate) でセルフ登録
  ↓  媒体別リンクを最大 20 本発行
  ↓
ユーザー
  ↓  短縮リンクをクリック → ref_tracking に記録
  ↓  LINE 友だち追加
  ↓  コンバージョン発生
  ↓
システム
  ↓  last-touch / 90日窓でアフィリエイターに帰属
  ↓  CV 時点のレートでコミッション確定（後から不変）
  ↓
管理者
     /affiliates 画面でレポート確認・重複フラグ確認
```

主な特徴:

- **セルフサーブ**: アフィリエイターが管理者の手を借りずに LIFF から登録・リンク発行・実績確認
- **ref_code ベース追跡**: 6〜8 文字の base62 スラグ。リンク毎に独立した計測
- **スナップショット CV**: コンバージョン発生時にアフィリエイター・レートを確定。後からレートを変更しても過去レポートは変わらない
- **重複検知**: `identity_key`（電話番号・UID 等の複合キー）が同一の友だちが複数帰属した場合に⚠フラグ

---

## 2. アフィリエイター向け: LIFF でのセルフサーブ操作

### 2-1. 登録

LIFF アプリを `?page=affiliate` 付きで開くとアフィリエイト登録フローが起動します。

```
https://liff.line.me/<YOUR_LIFF_ID>?page=affiliate
```

初回アクセス時に LINE ログイン（LIFF SDK が自動実行）が走り、取得した `lineAccessToken` をサーバーに送信して登録が完了します。すでに登録済みの場合は既存のデータを返す（冪等）。

登録時に最初のリンクが自動発行されます。

### 2-2. リンク発行（媒体別ラベル付き）

1. LIFF 上の「リンクを追加」ボタンをクリック
2. 媒体を表すラベルを入力（例: `Instagram`, `YouTube`, `Twitter`）
3. `https://go.example.com/<ref_code>` 形式の短縮 URL が発行される

**上限: アフィリエイター 1 人あたり 20 本**。21 本目の発行は 400 エラー。

リンクの形式（`LINK_BASE_URL` 設定時）:

```
https://go.example.com/Ab3XyZ
```

`LINK_BASE_URL` 未設定時は Worker 組み込みのリダイレクトルートを使用:

```
https://<your-worker>/r/Ab3XyZ
```

### 2-3. 実績確認

LIFF の自分のダッシュボードで以下が確認できます:

| 項目 | 説明 |
|------|------|
| クリック数 | リンク毎の `click_count`（リダイレクトヒット数） |
| 友だち追加数 | 追加時点で last-touch 帰属されたユニーク人数 |
| コンバージョン数 | 帰属された CV イベント数 |
| コミッション（参考） | `revenue × commissionRate`（支払い確定は管理者側） |

---

## 3. 帰属ルール

### 3-1. last-touch / 90 日窓

友だちの `ref_tracking` テーブルを参照し、**友だち追加日時から遡って 90 日以内**の最新タッチ（`julianday` 比較）を持つアフィリエイトリンクの所有者が帰属先になります。

```
帰属先 = argmax_{t ∈ touches} julianday(t.created_at)
         where julianday(friend.created_at) - 90 <= julianday(t.created_at)
               AND julianday(t.created_at) <= julianday(friend.created_at)
               AND t.ref_code → affiliate_link が存在する
```

参照実装: `packages/db/src/affiliate-attribution.ts` `resolveAffiliateAttribution()`

### 3-2. 自己クリック除外

アフィリエイター自身の LINE 友だち UUID（`affiliates.friend_id`）と `ref_tracking.friend_id` が一致するタッチは帰属から除外されます。自分のリンクを自分で踏んでも成果にはなりません。

```sql
AND (a.friend_id IS NULL OR a.friend_id != rt.friend_id)
```

### 3-3. CV 時スナップショット

コンバージョン発生時、`conversion_events` テーブルに以下を書き込みます:

- `affiliate_id`: 帰属先アフィリエイター
- `attributed_ref_code`: 帰属元 ref_code
- コンバージョンポイントの `value`（CV 時点の値）

レポート計算は `conversion_events.affiliate_id` を参照するため、**後からアフィリエイターの `commission_rate` を変更しても過去のレポート数値は不変**です。

参照実装: `packages/db/src/affiliate-report.ts` `getAffiliateReportV2()`

---

## 4. 管理者向け: /affiliates 画面

### 4-1. 一覧画面の列

| 列 | 内容 |
|----|------|
| 名前 / コード | アフィリエイター名と識別コード |
| リンク数 | 発行済み ref_code の本数 |
| クリック（RT） | `ref_tracking` カウント（実タッチ数） |
| リンククリック | `click_count` 合計（リダイレクトヒット） |
| 友だち追加 | 追加時点 last-touch で帰属されたユニーク友だち数 |
| CV 数 | `conversion_events` 帰属件数 |
| 売上 | CV ポイント `value` の合計 |
| 推定コミッション | 売上 × `commission_rate` |
| ステータス | active / paused |

### 4-2. 詳細画面

- **CV 内訳**: CV ポイント別の件数・売上を表示
- **ジャーニー**: 帰属友だちの一覧（追加日時 / ref_code / タッチ数 / フォーム数 / CV 数 / 最終イベント）。カーソルページネーション（最大 200 件/ページ）
- **リンク一覧**: 各 ref_code の URL・ラベル・クリック数

### 4-3. ⚠ 重複フラグ（`duplicateFlags`）

レポートに `duplicateFlags` フィールドがあります。これは**帰属友だちのうち `identity_key` が同一の友だちが 2 人以上存在する**場合に表示されます。

`identity_key` は LINE UID・電話番号・メールアドレス等を組み合わせた複合キーで、実質的に同一人物を示します。同じ人が複数のアカウントで友だち追加して CV を水増ししているサインです。

```json
"duplicateFlags": [
  { "friendId": "<uuid-A>", "identityKey": "<hashed-key>" },
  { "friendId": "<uuid-B>", "identityKey": "<hashed-key>" }
]
```

参照実装: `packages/db/src/affiliate-report.ts` `getAffiliateReportV2()` の `duplicateFlags` ブロック

### 4-4. ジャーニー API（管理者向け）

友だち単体のタイムライン（タッチ → 友だち追加 → フォーム → CV）を取得できます:

```bash
GET /api/friends/:id/journey
```

イベント種別は `touch` / `friend_add` / `form` / `conversion` の 4 種類。同一友だちの複数 ref_code タッチの順序やどの時点でどの ref_code が last-touch になったかを確認するのに使います。

---

## 5. 短縮 URL 設定

### 5-1. アカウント設定（管理画面）

管理画面の「アカウント設定」→「リンクベース URL」に独自ドメインを入力します。

```
https://go.example.com
```

- `https://` で始まること（バリデーション必須）
- 末尾スラッシュは自動除去
- 空文字で保存するとリセット（Worker 組み込みの `/r` に戻る）

内部的には `account_settings` テーブルの `link_base_url` キー（`accountId = '__global__'`）に保存されます。

### 5-2. ドメイン側 Redirect Rule の設定

独自ドメイン（例: `go.example.com`）でリンクを受け取り、Worker のリダイレクトルートに転送します。Cloudflare の「Redirect Rules」を使う場合の設定例:

| 項目 | 値 |
|------|-----|
| If (URL path) | matches `/*` |
| Then (Redirect to) | `https://<your-worker>/r/${path}` |
| Status code | 301 |

`${path}` はマッチしたパス部分（スラッシュ含む）に展開されます。

**例**:  
`https://go.example.com/Ab3XyZ` → 301 → `https://<your-worker>/r/Ab3XyZ`

Worker の `/r/:ref` ルートが ref_code を解決し、LINE 公式アカウントへのリンクを含むランディングページにリダイレクトします。

---

## 6. API リファレンス

### 認証方式

| 種別 | 方式 |
|------|------|
| 管理者 API (`/api/affiliates/*`) | `Authorization: Bearer <API_KEY>` ヘッダー |
| セルフ API (`/api/liff/affiliate/*`) | リクエストボディまたはクエリの `lineAccessToken`（LIFF SDK 発行トークンをサーバー側で LINE OAuth API に検証） |
| クリック記録（公開） | 認証不要 |

### セルフ API（アフィリエイター向け）

| メソッド | パス | 説明 |
|---------|------|------|
| `POST` | `/api/liff/affiliate/register` | 登録（冪等）。未登録なら作成 + 1 本目リンクを自動発行 |
| `GET` | `/api/liff/affiliate/me` | 自分のプロフィール + リンク一覧 |
| `POST` | `/api/liff/affiliate/links` | リンクを 1 本追加（20 本上限）|

**POST /api/liff/affiliate/register**

```json
// リクエストボディ
{ "lineAccessToken": "<LIFF_ACCESS_TOKEN>" }

// レスポンス 200
{
  "affiliate": {
    "id": "<uuid>",
    "name": "<display_name>",
    "code": "<base62_code>",
    "commissionRate": 0.1,
    "isActive": true,
    "friendId": "<friend_uuid>"
  },
  "links": [
    {
      "refCode": "Ab3XyZ",
      "label": null,
      "url": "https://go.example.com/Ab3XyZ",
      "clickCount": 0,
      "friendAdds": 0,
      "conversions": 0
    }
  ]
}
```

**GET /api/liff/affiliate/me**

```
GET /api/liff/affiliate/me?lineAccessToken=<token>
```

レスポンス形式は `register` と同一。未登録の場合は 404。

**POST /api/liff/affiliate/links**

```json
// リクエストボディ
{ "lineAccessToken": "<LIFF_ACCESS_TOKEN>", "label": "Instagram" }

// レスポンス 200
{ "link": { "refCode": "Cd4WqR", "label": "Instagram", "url": "...", "clickCount": 0, "friendAdds": 0, "conversions": 0 } }
```

上限超過時は 400: `{ "error": "Link limit reached (max 20)" }`

### ジャーニー API

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/affiliates/:id/journeys` | アフィリエイターに帰属した友だちの一覧（カーソルページ） |
| `GET` | `/api/friends/:id/journey` | 友だち 1 人のタイムライン（全イベント時系列） |

**GET /api/affiliates/:id/journeys**

クエリパラメータ:

| パラメータ | 型 | 既定 | 説明 |
|-----------|-----|------|------|
| `limit` | integer | 50 | 最大 200 |
| `beforeAt` | ISO 8601 | — | カーソル（前ページの末尾 `addedAt`） |
| `beforeId` | string | — | カーソル（前ページの末尾 `friendId`） |

```json
// レスポンス
{
  "success": true,
  "data": [
    {
      "friendId": "<uuid>",
      "displayName": "山田太郎",
      "addedAt": "2026-07-01T10:00:00.000+09:00",
      "refCode": "Ab3XyZ",
      "touchCount": 3,
      "formCount": 1,
      "conversionCount": 1,
      "lastEventAt": "2026-07-05T14:30:00.000+09:00"
    }
  ],
  "nextCursor": { "beforeAt": "...", "beforeId": "..." }
}
```

`nextCursor` が `null` の場合は最終ページです。

### レポート API

| メソッド | パス | 説明 |
|---------|------|------|
| `GET` | `/api/affiliates/:id/report` | アフィリエイター 1 人の詳細レポート（v2） |
| `GET` | `/api/affiliates-report` | 全アフィリエイター一覧レポート |

**GET /api/affiliates/:id/report**

クエリパラメータ: `startDate` / `endDate`（ISO 8601 日付、省略可）

```json
// レスポンス
{
  "success": true,
  "data": {
    "affiliateId": "<uuid>",
    "affiliateName": "田中さん",
    "code": "<code>",
    "commissionRate": 0.1,
    "clicks": 80,
    "linkClicks": 95,
    "friendAdds": 12,
    "conversions": 4,
    "conversionsByPoint": [
      { "conversionPointId": "<uuid>", "name": "商品A購入", "count": 3, "value": 29400 },
      { "conversionPointId": "<uuid>", "name": "メルマガ登録", "count": 1, "value": 0 }
    ],
    "revenue": 29400,
    "estimatedCommission": 2940,
    "duplicateFlags": []
  }
}
```

`clicks` は `ref_tracking` の実タッチ数、`linkClicks` はリダイレクトヒット（`affiliate_links.click_count` 合計）です。両者はボットフィルタリング方法の違いにより一致しないことがあります。
