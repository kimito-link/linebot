# 地図: chats画面を「台帳型」に寄せる（wayfinder 手順1）

作成: 2026-09-04 / 司令塔(Claude)が実コードを読んで作成。**推測はすべて「未確認」と明記した。**

## 何を解こうとしているか

作者の観測: リバースハックの「LINE対応」画面(`partnership_program_website`)のほうが、
line-bot の `chats` 画面より**実務で分かりやすい**。寄せられないか。

## 実測: 2つの画面の違い

| | line-bot `apps/web/src/app/chats/page.tsx` (1284行) | リバースハック `LineSupport.tsx` (943行) |
|---|---|---|
| レイアウト | 一覧 + 会話ペイン（チャットアプリ型） | **1人1カード**（台帳型）。会話は折りたたみ |
| 状態の出し方 | `status` 3値(未読/対応中/解決済)をバッジ表示 | `botPaused`→「対応中」/ 時刻比較→「未返信」/ 新着→「NEW」の**3種を重ねて表示** |
| 「未返信」の判定 | **無い**（`status`は人が手で変える）★下記の訂正1 | `lastUserMessageAt > lastAdminSendAt` で**自動判定**(L601-602) |
| 操作の置き場所 | 会話を開いてから、下部のバー | **カード上に全部**(L631-717)。開かずに押せる |
| 絞り込み | 状態 + 未対応のみ + アカウント | 状態 + **チャネル別** + **名前/紹介者の検索** |
| 定型送信 | 無い | **11個のボタン**(Stripe送信/振込先送信/完了報告/+3日確認/+25日保証終了/+30日フォロー/+3ヶ月確認/+6ヶ月確認/みまもり案内 ほか) |

## ★最重要の発見: 定型ボタンはそのまま移植できない

リバースハック側の11ボタンは、**1個ずつ専用エンドポイント**になっている:
`sendDay3Check` / `sendDay25WarrantyEnd` / `sendCompletionReport` / `sendFollowUpMessage` …
(`LineSupport.tsx` L403-425 で個別に `trpc.admin.*` を呼ぶ)

これは**リバースハックのITサポート業務に固有**の手順（Stripe決済・25日保証・みまもりプラン）。
line-bot は LP で「予約管理/専門知見/ファン対応/購入後サポート」と**複数業種**を掲げている。
同じ11個を持ち込むと、他業種では意味を成さないボタンが並ぶ。

**→ 一般化の受け皿は既にある**: `templates` テーブル(bootstrap.sql:790)と
`/api/templates`(`apps/worker/src/routes/templates.ts`)。★下記の訂正2
「業種ごとに定型文を登録 → カードに並ぶ」にすれば、業種を選ばない。
★**確認済み(2026-09-04)**: 専用APIは要らない。既存の `POST /api/chats/:id/send` が
`{ messageType, content }` を受け取り、text/flex の両方を push する(`chats.ts` の send ハンドラ)。
`message_templates` が持つのも `message_type` / `message_content` なので、
**画面がテンプレを読んで、その中身を send に渡すだけで成立する**。新規テーブル・新規APIともに不要。

## 移植できるもの / できないもの

**そのまま持ってこられる（新しいテーブル不要）**
- カード型レイアウト … 表示だけの話
- 「未返信」バッジ … `lastMessageDirection` を一覧APIが既に返している(`chats.ts` L373)。
  `direction==='incoming'` が最後なら未返信。**サーバー変更なしで出せる**
- 会話の折りたたみ … 既に `GET /api/chats/:id` で messages を取っている
- Bot停止/再開 … 2026-09-04 に実装済み(`PUT /api/chats/:id/ai-reply-mode`)
- 「LINEで開く」… 外部リンクを開くだけ

**持ってこられない / 判断が要る**
- 11個の業務ボタン … 上記のとおり業種固有。テンプレ方式に置き換える必要がある
- `channel` 別の絞り込み … line-bot の対応物は `line_account_id`（複数アカウント）。
  意味は近いが同じではない
- 「顧客化」… リバースハック固有の概念(clientIdへの変換)。line-bot に対応物は**無い**

## 触る必要のあるファイル（実在を確認済み）

| ファイル | 行数 | 何をするか |
|---|---|---|
| `apps/web/src/app/chats/page.tsx` | 1284 | 一覧をカード型に。★大きいので分割も検討 |
| `apps/worker/src/routes/chats.ts` | 665 | 一覧APIは**変更不要の見込み**(必要な値は既に返っている) |
| `apps/worker/src/routes/templates.ts` | (実在) | テンプレ一覧の取得元 |
| `apps/web/src/lib/api.ts` | — | `api.chats.*` / `api.templates.*` |

## 既に確認できている事実（裏取り済み）

- `lastMessageDirection` は一覧APIが返している → `chats.ts:373`
- `ai_reply_mode` の切替APIは実装済み → `chats.ts` の `PUT /api/chats/:id/ai-reply-mode`
- `message_templates` は `name` / `message_type` / `message_content` を持つ → `bootstrap.sql:531`
- リバースハックの「未返信」判定式 → `LineSupport.tsx:601-602`

## 未確認（Fableに判断させる前に、実装時に必ず確かめること）

- 一覧の件数規模。カード型は1件あたりの縦が伸びるので、何百件だとスクロールが辛い可能性
- `status`(未読/対応中/解決済) と `ai_reply_mode`(bot/human) の**役割の重なり**。
  リバースハックは `botPaused` を「対応中」と表示している＝1つの軸で兼ねている。
  line-bot は2軸ある。統合すべきか、両方見せるかは設計判断


---

# ★訂正（2026-09-04・Fableの仕様設計で判明し、司令塔が実コードで裏取りした）

この地図には3つの誤りがあった。**実装者は下の訂正を正とすること。**

## 訂正1: `lastMessageDirection === 'incoming'` は「最後が受信」を意味しない

一覧SQL(`chats.ts` L326)はこうなっている:
```sql
CASE WHEN i.friend_id IS NOT NULL THEN 'incoming' ELSE a.direction END AS direction
```
`i`(`in_agg`)は「その友だちの**受信の最新**」。受信が1件でもあれば `i.friend_id` は非NULL なので、
**この式は常に `'incoming'` を返す**。プレビューを「相手が何と言ったか」優先で見せるための設計であって、
最後の1通がどちらかは表していない。同じ理由で `lastMessageAt` も「最新の受信時刻」であり、
最新メッセージの時刻ではない。

→ 未返信の判定には使えない。**`/api/inbox/unanswered` を正とする**。
   これはサイドバーの赤バッジ・`/notifications`・`?unansweredOnly=1` が既に使っている単一の正で、
   「最後の手動返信より新しい受信があるか」＋auto_replyマッチ除外＋解決済除外を持つ。
   画面間で数が食い違わない利点もある。

## 訂正2: テンプレのテーブルは2つあり、使うべきは `templates`

| | `templates`(790行) | `message_templates`(531行) |
|---|---|---|
| 列 | `name, category, message_type(text/image/flex/carousel), message_content` | `name, message_type(text/flex), message_content` |
| API | `GET /api/templates` | `GET /api/message-templates` |
| 管理画面 | `/templates`（実在） | 無し |

この地図は「`message_templates` テーブル + `/api/templates`」と書いたが、**この組み合わせは存在しない**。
`/api/templates` が読むのは `templates` のほう。
**`templates` を使う**。`category` 列があり業種ごとに束ねられ、管理画面も既にあるため。

## 訂正3: `POST /api/chats/:id/send` は未知の messageType を黙って飲んでいた（修正済み）

send は text/flex/image だけを分岐し、それ以外は**どの push も呼ばないまま**
messages_log に outgoing を INSERT し `success:true` を返していた。
＝**送ったように見えて相手に届かない**。`templates.message_type` は `carousel` も許すので実際に踏み得た。

→ 2026-09-04、`else` で 400 を返すよう修正済み(`chats.ts` の send)。
   画面側でも carousel テンプレはボタンに出さない（二重の防御）。

## 副産物（Fableが発見・実装時に扱う）

- **死んだコード**: `DirectMessagePanel` は到達不能(`setSelectedFriendId` に非nullを渡す箇所が無い)。
  それに伴い `loadAllFriends` が毎回 `limit=800` を無駄に取りに行っている。作り替え時に削除する。
- **未確認**: カーソルページングの取りこぼし疑い。並び順は `d.last_message_at` だが、
  クライアントが次カーソルに使う `lastMessageAt` は訂正1のとおり受信時刻。
  コード上は行が飛び得るが、**実データでの再現は未確認**。
