# 実装仕様: chats 画面を「台帳型」に寄せる（wayfinder 手順2 / Fable設計）

作成: 2026-09-04。地図 `MAP-CHATS-LEDGER-REDESIGN.md` を出発点に Fable が設計し、
司令塔が訂正1〜3を実コードで裏取りした（訂正は地図の末尾に記載）。

**出発点の地図には3つの誤りがあった。地図末尾の「訂正」を必ず先に読むこと。**

---

## 1. 設計判断

### 1-1. `status` と `ai_reply_mode` は両方見せる（統合しない）

理由:
1. **答えている問いが違う**。`status`=「この案件は終わったか」、`ai_reply_mode`=「次の受信に誰が返すか」。
   解決済でも Bot に戻していない相手はいる（`diag.ts` が「human のまま放置」を検知しているのはそのため）。
2. **どちらも機械が動かす**。`status` は受信で resolved→unread、送信で in_progress。
   `ai_reply_mode` は LLM のエスカレーションで human になる。統合は webhook/followup-nudge/diag の意味を変える。
3. **お手本も1軸ではない**。リバースハックも botPaused + status + 未返信の3つを重ねている。

★**迷わせないための言葉の設計（ここが本質）**
- 現状 `status='in_progress'` のラベルが「対応中」で、お手本の botPaused 表示も「対応中」。
  同じ語にすると2軸が完全に混ざる。
- `ai_reply_mode='human'` のバッジは **「自分で返信」**（琥珀）にする。「対応中」は status 専用の語にする。
- Bot モードのときはバッジを出さない（正常状態は静かに）。
- `friend-info-sidebar.tsx` L37 の「未対応」を「未読」に統一する。

### 1-2. 「未返信」の自動判定は入れる（ソースは未対応インボックス）

- 判定式を持ち込まず、`api.inbox.unanswered.list({ pageSize: 2000 })` の friendId を Set にして所属で決める。
- サイドバーの赤バッジ・`/notifications`・既存の「未対応のみ」と**同じ正**なので数が食い違わない。
- 既存の「🔥 未対応のみ」は「未返信のみ」に改名。★URLパラメータ `unanswered=1` は
  `/notifications` からの深いリンクが使っているので**変えない**。
- 未返信は status と独立（in_progress でも新着があれば点く）。
  これは現状の穴を塞ぐ: `upsertChatOnMessage` は in_progress を unread に戻さない。

### 1-3. 1284行の分割

| ファイル | 中身 |
|---|---|
| `app/chats/page.tsx` | ヘッダ・フィルタ・一覧の状態・カードのmap。目標 ≤350行 |
| `components/chats/chat-card.tsx` | カード1枚（折りたたみヘッダ + 展開部の器） |
| `components/chats/chat-thread.tsx` | 吹き出し一覧（日付区切り・Flex/画像/スタンプ分岐） |
| `components/chats/chat-composer.tsx` | textarea・画像添付・ローディング表示・送信 |
| `components/chats/template-quick-send.tsx` | 定型文ボタン・メニュー・確認モーダル |
| `components/chats/chat-card-flags.ts` | 純関数と定数だけ（Reactなし・テスト対象） |
| `components/chats/chat-card-flags.test.ts` | 上記のvitest |
| 削除 | `DirectMessagePanel` / `FriendItem` / `MessageLog` / `allFriends` / `loadAllFriends` / `selectedFriendId` |

### 1-4. 件数とスクロール

根拠: 本番実測「friend 10k行 / messages_log 96k行」(`chats.ts` L211-218 のコメント、2026-07-06)。

1. カードは既定で折りたたみ（3行固定）。展開は**同時に1枚**。
2. ページサイズ 300 → **50**。
3. `contentVisibility: 'auto'` + `containIntrinsicSize: '0 96px'` で画面外の描画を省く。
4. **仮想スクロールは入れない**（計測してから判断）。

---

## 2. 画面の構造

```
Header「お問い合わせ対応」                          [未返信 N]
──────────────────────────────────────────────────────────
[全て][未読][対応中][解決済]  ☐未返信のみ  [名前で絞り込み（読み込み済みの中から）]
──────────────────────────────────────────────────────────
┌ ▌(左アクセント) ────────────────────────────────────────┐
│ (avatar) [未返信][自分で返信][対応中] 山田 太郎 ・アカウントA ・3分前│ 行1
│          「予約の変更をお願いしたいのですが…」                    │ 行2
│ [💬 返信する ▾] [定型: 営業時間][定型: 予約案内] [📋 定型文…]     │ 行3
│ [⏸ Botを止める] [status ▾] [📝 メモ]                            │
├───────────── 展開時のみ ────────────────────────────────┤
│  吹き出し一覧（max-h 420px・内部スクロール）                     │
│  自動応答の状態と切り替え / メモ / 送信設定 / 画像 / textarea    │
│  ▸ 友だち情報（折りたたみ）                                      │
└──────────────────────────────────────────────────────────┘
```

★**カードを開かずに操作できる**のが台帳型の要点。1画面に出す状態フラグは最大3つ。

- 左アクセント: 未返信→赤 / human→琥珀 / それ以外→なし（未返信が優先）
- 名前絞り込みは**クライアント側**（一覧APIに検索が無い）。
  プレースホルダに「読み込み済みの中から」と明記して、無いものを探させない。
- 深いリンク `?friend=<id>`: そのカードを展開。一覧に無ければ既存の合成行注入を残す。
- モバイル: カードが縦に積まれるだけ。現状の2ペイン切替は不要になる。

---

## 3. 状態バッジ

| 表示 | 条件 | 見た目 | 出典 |
|---|---|---|---|
| **未返信** | `unansweredSet.has(chat.id)` | 赤ベタ | `/api/inbox/unanswered` |
| **自分で返信** | `aiReplyMode === 'human'` | 琥珀ベタ | 詳細API（§5で一覧にも） |
| 未読/対応中/解決済 | `chat.status` | 既存の薄色 | 一覧API |

並びは左からこの順（今すぐ返す → 誰が返す → 案件の段階）。

```ts
export type CardFlags = {
  unanswered: boolean
  humanMode: boolean | null      // null = 未取得
  status: 'unread' | 'in_progress' | 'resolved'
  accent: 'red' | 'amber' | 'none'
}
```

**未返信セットの更新**
- `loadChats()` と並行取得（`Promise.all`）。失敗しても一覧は出す（バッジだけ消える）。
- 送信成功直後: `unansweredSet.delete()` （楽観）＋ 既存の `UNANSWERED_REFRESH_EVENT` 発火。
- 解決済にした直後: 同上（インボックスは resolved を除外する）。
- ★`total > rows.length` のときはヘッダに「2000+」と出し、バッジは出せた分だけ（正直に）。

---

## 4. 定型送信（テンプレ方式）

**データ源**: `GET /api/templates`（★`templates` テーブル。地図の訂正2）。
ページ表示時に1回だけ取得し、カードごとに取らない。

**業種を選ばない仕組み**
- フィルタ行に「カードに出す定型文: [カテゴリ ▾]」。選択肢は取得したテンプレの category の重複除去。
  選択は `localStorage['lh_chat_quick_category']` に保存（既存の `lh_chat_*` と同じ流儀）。
- 先頭6個をボタン、残りは「📋 定型文…」メニュー。
- 表示は `messageType ∈ {text, flex, image}` のみ（carousel は出さない＝訂正3の二重防御）。
- 例: 予約業なら category『予約』、購入後サポートなら『サポート』。
  ★**コードに業種の語は一切出ない**。

**押してから送るまで**（1クリック即送信にはしない）
```
[定型ボタン] → expandTemplateForChat() → 確認モーダル（送信先・文面プレビュー）
  → api.chats.send(id, {messageType, content})   ← 既存API・新規API不要
  → 成功: 既存の楽観更新 + unansweredSet.delete + イベント発火
```

★**変数展開はフェイルクローズ**。send は `expandVariables` を通さないので、
`{{name}}` 入りテンプレをそのまま送ると `{{name}}` が相手に届く。
画面側で `{{name}}` だけ置換し、**他の変数が残っていたら送信ボタンを無効にして理由を出す**。

---

## 5. 触るファイル

### web（必須）
page.tsx の分割、chat-card / chat-thread / chat-composer / template-quick-send / chat-card-flags の新規、
friend-info-sidebar の「未対応」→「未読」、inbox-row の `formatElapsed` を共用に。

### worker（★新規APIなし。既存レスポンスへの追記のみ）
| 何を | 必須? |
|---|---|
| 一覧SQLに `f.ai_reply_mode` / `d.last_message_at AS activity_at` を追加し、レスポンスに `aiReplyMode` / `lineAccountId` / `lastActivityAt` を足す（既存フィールドは変えない） | 推奨（無くても動く。無いとBotボタンが展開後にしか出ない） |
| カーソルを `lastActivityAt` で切る（副産物Bの対処） | 推奨 |
| send の未知 messageType で400 | ★2026-09-04 実施済み |

---

## 6. 実装の順番（各段は単独でデプロイ可能）

1. **純関数とtest** — `chat-card-flags.ts` + test。UIは未変更
2. **挙動を変えない分割** — thread/composer 切り出し、死んだコード削除。2ペインのまま。
   §8の既存機能チェックを全部通す。★**ここで一度コミット**（戻れる分岐点）
3. **カード化** — 折りたたみ、status セレクト、ページサイズ50、contentVisibility
4. **未返信** — インボックス取得、赤バッジ、「未返信のみ」改名
5. **定型送信** — テンプレ取得、カテゴリ、確認モーダル
6. **worker追記** — aiReplyMode / lineAccountId / lastActivityAt
7. **計測** — 50件でのスクロールと初回描画

---

## 7. やらないこと（スコープ外）

- リバースハックの11ボタンの移植（業種固有。category付きテンプレで各業種が登録する）
- 「顧客化」（line-bot に対応概念が無い）
- 「LINEで開く」★`line_accounts` に chat.line.biz のURLを組める識別子が無い。**未確認のまま実装しない**
- **NEWバッジ** ★一覧の `createdAt` は友だち追加日時ではない（COALESCE で last_message_at に落ちる）。
  信頼できる出典が無いので出さない
- サーバー側の名前検索 / `{{name}}` 以外の変数展開 / 会話履歴1000件超のページング
- status と ai_reply_mode の統合、webhook の状態遷移変更
- 仮想スクロールの導入（計測してから）
- 一覧のクライアント側並び替え（カーソルページングと衝突する）

---

## 8. 検証

**自動**: `pnpm --filter web test`（flags の純関数）/ `build`（削除漏れを拾う）/ worker の typecheck・test

**手動（既存機能が残っていること。段2の直後と最終の2回）**
一覧表示・さらに読み込み（重複なし）・展開して会話・テキスト送信（実機着信）・
Enter設定の保存・画像送信・ローディング表示・メモ保存・Bot停止再開（D1で ai_reply_mode を確認）・
status変更でサイドバーのバッジが減る・「未返信のみ」が /notifications と一致・深いリンク

**新機能**
未返信バッジ数＝ヘッダ＝サイドバーの3点一致 / 送信でバッジが消える /
category付きテンプレを作って送信し messages_log が `manual` になる /
`{{uid}}` 入りは送信ボタンが無効 / carousel はボタンに出ない / 375px で横スクロールなし

**性能**: DevTools で50件の初回描画とスクロール。`/api/friends?limit=800` が飛んでいないこと。

---

## 9. 未確認（実装時に必ず確かめる）

- 副産物B（カーソルの取りこぼし）は**コード読みからの推定**。実データでの再現は取っていない
- 未返信が2000件を超える運用があるか
- `templates` に既に何件・どんな category が入っているか（本番D1未確認）。
  だからカテゴリ初期値は「すべて」にしてある
- `content-visibility: auto` が現行構成でそのまま効くか（効かなくても機能は変わらない）
