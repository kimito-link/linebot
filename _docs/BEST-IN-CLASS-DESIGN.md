# 設計書 — りんくBot キャラクター動画機能 総合設計（A自己言及 / B動画品質 / C安定性）

> 設計=Fable(claude-fable-5) ／ 裏取り=司令塔Claude ／ 2026-07-20
> 3段構え（会議ハーネス→Fable設計→実装引き継ぎ）の手順2の産物。
> 会議素材: `council-question-best-in-class.txt`（design分類、5体召集・3体成功、統合役gpt-oss-120b）
> Fableブリーフ: `fable-brief-best-in-class.md`の要点は本ドキュメントに転記済み
> 前提コード裏取り済み: `self-recognition.ts`・`media-describe.ts`・`webhook.ts(699-790)`・
> `llm-providers.ts`・`wrangler.toml`・`_docs/SELF-RECOGNITION-DESIGN.md`・
> `_docs/CHARACTER-VIDEO-DESIGN.md`

**背景**: 動画埋め込み・自己言及機能（Phase 1）実装後、実機3件検証で「りんく成功／こん太は
特徴語未マッチでフォールバック／たぬ姉は無反応」という結果になった。ユーザーから「自己言及機能・
動画クオリティ・Bot全体の安定性の3軸すべてを最高にしたい」という要望を受け、3軸を統合した
総合設計を行った。

---

## 0. エグゼクティブサマリ（裁定の結論）

**「CかAか」という二者択一は偽の対立である。** 今日の実機3件の失敗を分解すると:

| 実機事象 | 真の原因軸 | 修正コスト |
|---|---|---|
| こん太: 「猫のような耳」でマッチ失敗→他人事描写 | **A**（特徴語テーブルの語彙カバレッジ不足）。Cを直しても再発する | 極小（純粋関数の定数変更+テスト） |
| たぬ姉: 完全無言 | **C**（Gemini 503 × fail-closed無言設計） | 小（定型フォールバック返信1分岐） |
| りんく: 成功 | — | — |

つまり **AとCの「最小の一手」は互いに独立で、どちらも数時間クラスの小変更**。順序で争う必要がなく、
同一スプリントで両方やるのが正しい。会議の対立は「Aのフル対策（ハッシュ方式等）」と「Cのフル対策
（リトライ基盤等）」を比較したから起きた誤り。**Bは今日ユーザーに見える欠陥が観測されておらず、
明確に3番手。**

**着手順序: Sprint 1 = C-1(無言化解消) + A-1(特徴語拡充) + C-2(503限定リトライ) +
C-3(Observability切り分け) → Sprint 2 = A-2(送信済み動画の完全一致ハッシュTier) + 画像経路展開
→ Sprint 3(証拠が出たときのみ) = B改善。**

---

## 1. 裁定の根拠 — 対立の解体

- **gpt-oss-120b/llama側「Cが根本」**: 半分正しい。たぬ姉の無言はCで説明できる。しかし
  **こん太の失敗はCでは1ミリも直らない**（Geminiは正常応答しており、描写文の表現ゆれが
  Worker側テーブルに無いだけ）。「C無しにAは届かない」は、Aの成功パス（りんく）が今日実機で
  届いている事実と矛盾する。
- **qwen側「Aの崩れは離脱直結」**: 体験リスクの指摘は正しいが、現行実装はマッチ失敗時に
  **現状動作（丁寧な三人称）へfail-openする**設計であり、「キャラが別人と話す」最悪形は既に
  構造的に防がれている。緊急性の見積もりが過大。
- **本当に離脱に直結するのは「Botの完全無言」**（既読無視と区別がつかない）。これはA/Bどちらの
  改善よりも先に塞ぐべき唯一の穴で、その意味では「C-liteが最優先」。ただしC-liteは1分岐の追加で
  済むため、Aと排他にならない。

---

## 2. A軸 — 自己言及の3層防御設計

### 2.1 判定アーキテクチャ: Tier構造に再編

```
LINE動画受信
  → ★Tier 0: SHA-256完全一致（Bot送信済み動画レジストリ照合）  … Gemini不要・<5ms
       ├─ 一致 → selfMatch = { character, confidence: 'high' } を合成し、
       │         describeVideoを丸ごとスキップ（合成descriptionで返信生成へ）
       └─ 不一致 ↓
  → describeVideo()（現行どおり。C-2のリトライはここに内蔵）
  → Tier 1: matchSelfCharacter(description)（現行+特徴語拡充）
  → マッチなし → 現状動作フレーミング（fail-open、無変更）
```

**Tier 0の副次効果が大きい**: 完全一致した動画は**Gemini 503の影響圏から完全に脱出する**
（describe自体を呼ばない）。A軸の対策がそのままC軸の耐障害性になる。デモ・LP導線で
「Botに公式動画を送り返す」体験は最頻パスなので、ここが決定的・即時・無料になる価値は高い。

### 2.2 qwen案（ハッシュ/messageId記憶）の技術検証

**判定: 「完全一致ハッシュ」は採用（Tier 0）。「知覚的ハッシュ」は棄却。**

| 方式 | 検証結果 |
|---|---|
| SHA-256完全一致 | `crypto.subtle.digest('SHA-256', mediaBytes)` はWorkerで数ms・追加依存ゼロ。対象は自作動画6本程度（3キャラ×LP版/Bot版）でレジストリは極小。**偽陽性が原理的にゼロ**なので、当たれば無条件でhigh confidence。再圧縮で外れるケースはTier 1に自然フォールバックするだけで、失って困るものが何もない。費用対効果が非対称に良い |
| 知覚的ハッシュ（pHash）/先頭フレーム類似度 | **棄却**。Cloudflare WorkersにはH.264デコード手段が無い（ffmpeg不可、WASMデコーダはCPU時間・バンドルサイズ・45秒締切のすべてに反する）。フレームを取り出せない環境で知覚ハッシュは成立しない |
| mp4メタデータ指紋（moovボックスからduration/解像度をJSパース） | **保留（Phase 3の温存カード）**。デコード不要でdurationは再圧縮を概ね生き残るが、単独では識別力不足（「6秒の動画」は世に無数にある）。Tier 1の確信度ブースターとしてのみ意味があり、今は複雑さに見合わない |

**再圧縮問題の扱い**: ブリーフの懸念どおり、カメラロール保存→再送信ではLINE再圧縮でバイト列が
変わる可能性が高い。ただし**LINEアプリ内転送**ではコンテンツが保存される可能性があり、これは
Tier 0のrecall（当たる率）を左右する。**推測で設計せず、Sprint 2冒頭に10分の実機実験で確定する**:

> **実験プロトコル（ハッシュrecall測定）**: webhookに受信動画のSHA-256をログ出力する1行を先に
> 入れる（構造化ログ§4.4と同時実装）。Bot送信済み動画を (1)LINEアプリ内転送 (2)カメラロール
> 保存→送信 (3)他アプリ共有→送信 の3経路で送り返し、Workers Logsで元ファイルのハッシュと突合。
> 1経路でも一致すればTier 0は有効。全滅ならTier 0はレジストリ実装を省略し、ログだけ残して撤退
> （撤退コストほぼゼロ）。

### 2.3 Tier 1: 特徴語テーブル拡充（こん太失敗の直接修正）

**核心の言語学的洞察**: Geminiが「猫のような耳」と書いたのは誤認ではなくパラフレーズ。そして
**「Xのような耳」という表現は、主体がXそのものでは*ない*（=獣耳キャラである）ことを含意する**。
本物の猫の動画なら「猫が…」と書かれ、「猫のような耳」とは書かれない。よって「〜のような耳」
「獣耳」系表現は、実在動物と衝突しない安全なweight-2特徴として使える。

`apps/worker/src/services/self-recognition.ts` の `FEATURE_TABLE` 変更見立て:

```typescript
// 共有の獣耳パターン（こん太・たぬ姉の両方にweight2で入れる。
// ハイフンや中黒を挟む表記ゆれはNFKC後も残らない前提で単純に）
const KEMOMIMI = /(狐|猫|犬|獣|動物|きつね|キツネ|ねこ|ネコ)のような耳|獣耳|けも(の)?耳|ケモ耳|アニマル(風の)?耳/;

こん太: [
  { weight: 2, pattern: /狐|きつね|キツネ/, label: 'fox' },
  { weight: 2, pattern: KEMOMIMI, label: 'kemomimi' },          // ★追加
  { weight: 1, pattern: /オレンジ(色)?の?髪/, label: 'orange_hair' },
  { weight: 1, pattern: /尻尾|しっぽ|シッポ/, label: 'tail' },   // ★追加
  { weight: 1, pattern: /耳/, label: 'ears' },
],
たぬ姉: [
  { weight: 2, pattern: /狸|たぬき|タヌキ/, label: 'tanuki' },
  { weight: 2, pattern: KEMOMIMI, label: 'kemomimi' },          // ★追加
  { weight: 1, pattern: /茶髪|茶色(い|の)髪/, label: 'brown_hair' },
  { weight: 1, pattern: /尻尾|しっぽ|シッポ/, label: 'tail' },   // ★追加
  { weight: 1, pattern: /耳/, label: 'ears' },
],
```

- 挙動: 「猫のような耳・オレンジの髪」→ こん太 kemomimi(2)+orange_hair(1)+ears(1)=4=**high**。
  「猫のような耳」のみ→ こん太・たぬ姉が同点2ずつ→閾値未満→null（fail-open維持、正しい）。
  髪色が判別器として機能する。
- **採点仕様の注意（現行実装の暗黙挙動）**: `scoreCharacter` は全グループを独立加算するため、
  KEMOMIMI(2)と汎用`耳`(1)は同一文で両方ヒットして3になる。これは意図どおり（獣耳表現単独で
  probable到達はしない設計にしたければ`耳`グループをKEMOMIMI非ヒット時のみ加点にする手もあるが、
  閾値3を単独超えしない限り実害なし。テストで固定すること）。
- テスト追加（`self-recognition.test.ts`）: (1) 今日の実機Gemini文言そのまま「…猫のような耳の
  キャラクターが…オレンジ色の髪…」→ こん太 (2) 「猫のような耳」だけ→null (3) 本物の猫動画描写
  「オレンジ色の猫が毛づくろい…耳をぴくぴく」→null（「のような耳」不成立を確認）
  (4) 茶髪+獣耳→たぬ姉。
- **やらないこと**: `DESCRIBE_VIDEO_PROMPT`（`media-describe.ts:33`）は今回も**一切触らない**。
  「登場キャラの髪色・耳・アクセサリーを必ず描写せよ」という中立的追記案はA-1が実機で再失敗した
  場合のPhase 3候補として温存（その場合もキャラ名・期待解は絶対に入れない。7-19事故の再発条件を
  作らないこと）。

### 2.4 Tier 0の実装見立て

- **レジストリ**: D1新テーブル `bot_media_assets (sha256 TEXT PRIMARY KEY, character TEXT, kind TEXT, byte_length INTEGER, registered_at TEXT)`。migration追加。登録は当面、生成スクリプト側でハッシュを計算してseed SQLを吐く方式で十分（管理画面は不要）。
- **webhook.ts 変更点**（699行の動画分岐内、describe呼び出しの直前）: `crypto.subtle.digest`で
  mediaBytesのSHA-256を計算→D1照合→ヒット時は `description` を合成文（例:
  `「${character}の公式アニメーション動画（まばたきや笑顔の表情が動く）」`）にし、
  `selfMatch = { character, confidence: 'high', matchedFeatures: ['exact_hash'] }` を直接組み立てて
  既存の分岐（744行〜）に合流させる。**744行のフレーミング文面は無変更で再利用できる**
  （合成descriptionが `${description}` に入るだけ）。
- こん太/たぬ姉ヒット時も既存の「仲間フレーミング」(748-749行)がそのまま機能する。
- fail-open原則維持: D1照合失敗・例外はcatchしてTier 1へ落とす。

---

## 3. C軸 — 安定性設計

### 3.1 「リトライは429を拡大する」説の検証

**判定: この主張は本Botのトラフィック規模では成立しない。ただし無条件リトライは別の理由（時間予算）
で不可能であり、結論として「条件付き最大1回」を採用する。**

- 503（overloaded）は**容量側**の問題、429は**クォータ側**の問題で、発生機構が別物。多重リトライが
  429を誘発するのは高QPS・バースト時の話で、個人運用のLINE Bot（毎分数リクエスト未満）で1回の
  追い打ちがRPMクォータを圧迫することはない。会議の「過去の内部モニタリング」という出典は
  本システムのものではなく、規模の違う環境の経験則が混入した可能性が高い。
- ただし**429を受けたときのリトライは絶対にしない**（クォータ超過に追い打ちしても429が返り続ける
  だけで純損）。リトライ対象は503のみに限定する。
- **真の制約は時間予算**: 22秒タイムアウトを2回舐めると44秒>45秒締切で確実に死ぬ。ここに次の
  好条件がある — **503は即座に返る（数秒以内）が、タイムアウトは22秒を丸ごと消費する**。
  よって「リトライ前に残り予算を再チェックする」だけで、タイムアウト後の危険な再試行は*自動的に*
  排除される（22秒消費後は残り<37秒となり再チェックに落ちる）。バックオフ計算より予算ゲートの
  ほうが決定的で安全。

**設計（`media-describe.ts` / `llm-providers.ts`）:**

1. `callGeminiVideo` の戻り値を `string | null` から判別可能な型へ変更:
   ```typescript
   export type MediaDescribeCallResult =
     | { ok: true; text: string }
     | { ok: false; reason: 'http' | 'fetch' | 'timeout' | 'empty' | 'parse'; status?: number };
   ```
   呼び出し箇所は `describeVideo` の1箇所のみなので影響は閉じている（`callGeminiAudio`は今回
   触らない。音声で503頻発の証拠が出たら同型に揃える）。
2. `describeVideo` にリトライループ（最大2試行）:
   ```
   1回目呼び出し
     → ok → text返却
     → ok:false かつ status===503 かつ remainingMs(receivedAt) ≥ timeoutMs + POST_DESCRIBE_MARGIN_MS + RETRY_BACKOFF_MS
        → await sleep(RETRY_BACKOFF_MS=2000 + jitter(0..500))
        → 2回目呼び出し → 結果を最終とする（3回目なし）
     → それ以外（429/timeout/fetch/empty）→ 即null
   ```
3. `llm.video.timeoutMs=22秒`・`POST_DESCRIBE_MARGIN_MS=15秒`・`REPLY_DEADLINE_MS=45秒` は
   **1msも動かさない**（音声実障害で反証済みの地雷）。
4. 「事前生成した代替動画へのフェイルオーバー」という会議の対案は**問題設定の取り違えとして棄却**:
   障害点は「受信動画の解釈」であり「動画の送信」ではない。解釈できないときに別動画を送っても
   会話が成立しない。

### 3.2 無言化の解消（C軸で最重要・最小の一手）

`webhook.ts` 783行のコメント「description === null → 静かに戻る」の分岐に、定型フォールバック
返信を追加する。既にサイズ超過時の`tooLargeNotice`（708-713行）で「fail-closedを一言に置き換える」
前例があり、同じ流儀を踏襲するだけ。LLMを介さないのでpersona事故のリスクはゼロ。

```typescript
// describe失敗（503/タイムアウト/締切スキップ等）時。無言＝既読無視に見える実害への対処。
const mediaLabel = msg.type === 'video' ? '動画' : '音声';
const failNotice = `ごめんね、いまこの${mediaLabel}をうまく見られなかったみたい…。少し時間をおいてもう一回送ってみてくれる？`;
await sendSafeText(lineClient, event.replyToken, friend.line_user_id, failNotice, receivedAt, false);
await logOutgoingGroqMessage(db, friend.id, failNotice, 'groq_reply');
imageLlmHandled = true;  // 返信済みなのでunread化スキップ（tooLargeNoticeと同じ扱い）
```

注意点: `runGroqSupportPipeline`の`fail_closed`分岐（778行）は既に`escalationText`を返しているので、
追加が必要なのは**describe段のnull**だけ。これでたぬ姉型の「完全無言」は消滅し、しかもユーザーの
再送を促すため503が一過性なら自己回復する。

### 3.3 Cloudflare Observability「有効化しても無効に見える」現象の原因推測

`wrangler.toml` を確認した結果、**最有力の原因が設定ファイル内に見つかった**:

1. **`[observability]`ブロックが`[env.production]`にしかない**（71-72行）。デフォルト環境
   （トップレベル、worker名`line-harness`）には無い。ダッシュボードで**どのWorkerを見ているか**で
   有効/無効の表示が変わる。「断続的に無効に見えた」のは、テスト環境Worker
   （observability未設定）と本番Worker（設定済み）を行き来していた可能性が高い。
2. **wrangler deployはダッシュボード設定を上書きする**: ダッシュボードのトグルでONにしても、
   observabilityブロックを持たない設定でデプロイが走るたびにOFFへ戻る。今日はデプロイを
   繰り返した日なので、「有効化→デプロイ→無効表示」のフリップが起きた説明になる。
3. wranglerのバージョンが古いとobservabilityキーが無視される（v3.78+で対応）。
   `npx wrangler --version`の確認を実装タスクに含める。
4. 「直近ログが反映されない」ほうは、Workers Logsの取り込み遅延（通常数十秒〜数分）の可能性が
   高く、設定問題とは切り分けるべき。

**対策**: トップレベルにも `[observability]\nenabled = true` を追加し（テスト環境でもログが取れて
損はない）、デプロイ後にダッシュボードのSettings→Observabilityで**両方のWorker名**について
有効表示を確認する。

### 3.4 構造化ログ（診断能力への最小投資）

動画・音声経路の終端で必ず1行のJSONログを出す:

```typescript
console.log('[media-pipeline]', JSON.stringify({
  type: msg.type, bytes: mediaBytes.byteLength, sha256: hashHex,
  outcome: 'replied' | 'fail_notice' | 'too_large' | 'budget' | 'disabled',
  describe: 'ok' | 'http_503' | 'http_429' | 'timeout' | 'deadline_skip' | 'exact_hash_skip',
  retried: boolean, selfMatch: selfMatch?.character ?? null, elapsedMs: Date.now() - receivedAt,
}));
```

今日「たぬ姉は503か未確定」で終わったのは、まさにこのログが無いから。§2.2のハッシュ実験もこの
ログに乗る。

---

## 4. B軸 — 動画クオリティの検証と改善

### 4.1 WebM/VP9再提案の判定: **却下を維持・却下範囲を拡大**

- 過去のE-3却下は「**透過**WebM(VP9 alpha)のSafari非対応」だったが、今回の再提案（配信フォーマット
  としてのWebM/VP9）も独立に死んでいる:
  - **LP側**: LINE経由の流入はiOSではLINE内蔵ブラウザ（WebKit強制）。iOS/WebKitのVP9・WebM再生
    対応は不完全で、主要ターゲット環境でまさに再生できない恐れがある。背景色焼き込み済みH.264 mp4
    が既に全環境で動いており、乗り換える利得がない。
  - **Bot送信側**: LINE Messaging APIの動画メッセージは実質mp4前提。WebMは入口で終了。
- よって矛盾どころか、**過去の却下理由が今回の提案にもそのまま適用され、追加の却下理由（LINE側
  mp4要件）まで加わる**。再々提案を防ぐため、`_docs/CHARACTER-VIDEO-DESIGN.md` §Eに
  「E-3b: 非透過WebM/VP9も却下（iOS WebKit再生互換とLINE mp4要件）」を追記すること。

### 4.2 「フレーム数増→サイズ超過」懸念の定量的却下

gpt-oss-120bの懸念は**レート制御の理解が誤っている**。現行コマンドは
`-maxrate 800k -bufsize 1600k`（LP版）/`-maxrate 450k`（Bot版）でVBV上限が張られており、
**フレーム数や差分PNG枚数を増やしてもファイルサイズ上限は変わらない**（上限=maxrate×尺÷8。
変わるのは同一サイズ内での画質配分だけ）。LP版理論上限800KB、Bot版約362KBで、LINEの制限にも
自主規約1MBにも遠い。**サイズは非問題として閉じる。**

### 4.3 qwen指摘「再生開始ラグ」への対処（B軸で唯一やる価値がある改善）

`-movflags +faststart` は既に全出力に付いている。残る改善は配信・マークアップ側:

| 改善 | 実装見立て |
|---|---|
| poster画像 | 各キャラのループ先頭フレーム（=normal口閉じPNGを480に縮小したWebP、~20KB）を`<video poster=...>`に指定。動画到着前の空白/黒枠を消す。**体感ラグへの効果が最大** |
| `preload="metadata"` + IntersectionObserverでビューポート進入時に`.play()` | ファーストビュー外の動画が帯域を食い合わない |
| キャッシュヘッダ | 配信元（Vercel/CF）で`Cache-Control: public, max-age=31536000, immutable`。ファイル名にハッシュを含めるか確認 |
| Bot送信時の`previewImageUrl` | LINE動画メッセージのサムネイル。未設定/雑だと受信直後がグレーの矩形になり「品質が低い」印象の主因になる。posterと同じ静止画を流用 |

エンコード自体（8秒/480/24fps/ストーリーボード方式）は今日ユーザー承認済みの品質なので**触らない**。
パーツ分解リグ等の表現力向上は引き続き温存カード。

---

## 5. 実行計画（1本化）

### Sprint 1 — 今すぐ（すべて小変更・相互独立・同日デプロイ可）

| # | 一手 | ファイル | 完了条件 |
|---|---|---|---|
| 1 | **C-1 無言化解消**: describe null時の定型フォールバック返信 | `apps/worker/src/routes/webhook.ts`（783行の分岐） | 大容量でない動画でGemini疎通を切った状態（またはAPIキー無効化テスト）で定型文が返る |
| 2 | **A-1 特徴語拡充**: KEMOMIMI共有weight2+尻尾+テスト | `apps/worker/src/services/self-recognition.ts` / `self-recognition.test.ts` | 実機でこん太動画→「仲間のこん太」反応。本物の猫動画→現状動作 |
| 3 | **C-2 503限定リトライ**: 予算ゲート付き最大1回 | `apps/worker/src/services/llm-providers.ts`（`callGeminiVideo`戻り値型変更）/ `media-describe.ts` | 単体テスト: 503→リトライ1回、429/timeout→リトライなし、予算不足→リトライなし |
| 4 | **C-3 Observability**: トップレベル`[observability]`追加+wranglerバージョン確認+ダッシュボードWorker名照合 | `apps/worker/wrangler.toml` | 両環境のダッシュボードで有効表示、`[media-pipeline]`ログが検索できる |
| 5 | **C-4 構造化ログ**: §3.4のJSON1行（受信sha256含む＝Sprint 2の実験準備を兼ねる） | `webhook.ts` | たぬ姉再送でoutcome/describe理由がログに残る |

Sprint 1完了後、**たぬ姉を実機再テスト**（今日の無反応が503起因かを構造化ログで確定させる）。

### Sprint 2 — Sprint 1の実機確認後

1. **ハッシュrecall実験**（§2.2プロトコル、10分）→ 1経路でも一致すれば **A-2 Tier 0実装**
   （D1テーブル+webhook照合+describeスキップ合流）。全滅ならA-2撤退（ログのみ残す）。
2. **画像経路への自己言及展開**（既存設計書SELF-RECOGNITION-DESIGN.md Phase 2、
   webhook.ts 663行の`incomingText`に`matchSelfCharacter`適用）。
3. 連続会話テスト: 自己言及返信の次ターンで履歴の`[画像: 三人称描写]`が会話を引き戻さないか
   （既存設計書§4の残課題）。

### Sprint 3 — 証拠駆動（先回りしない）

- B改善: poster/previewImageUrl/preload/キャッシュヘッダ（§4.3）。
- A-1がなお表現ゆれで外れる実例が出た場合のみ: describeプロンプトへの中立的外見描写追記
  （キャラ名・期待解を含めない厳格条件つき）。
- 音声経路の`callGeminiAudio`のResult型統一（503が音声でも観測された場合のみ)。

---

## 6. 地雷順守チェックリスト（実装者は着手前に読むこと）

| 地雷 | 本設計での扱い |
|---|---|
| `llm.video.timeoutMs=22s`/`POST_DESCRIBE_MARGIN_MS=15s`/`REPLY_DEADLINE_MS=45s` | **不変更**。リトライは予算ゲートで自動抑制される設計 |
| `DESCRIBE_VIDEO_PROMPT`への人格情報混入（7-19事故） | **不変更**。Sprint 3の中立追記案もキャラ名・期待解の混入を禁止 |
| 429へのリトライ | **禁止**（503のみ、最大1回） |
| fail-closed→無言 | 定型文置換はLLM非経由なのでpersona事故経路を作らない。`tooLargeNotice`の既存前例に準拠 |
| 3段フォールバックチェーン（Groq固有機能への依存禁止） | incomingText注入方式を維持。Tier 0もincomingText合流なので全段で効く |
| WebM/VP9 | 却下維持+却下範囲拡大をCHARACTER-VIDEO-DESIGN.md §Eに追記 |
| wrangler deployがダッシュボード設定を上書き | Observabilityは必ずwrangler.toml側で宣言（トグルでの有効化は次デプロイで消える） |
| LINEアプリ再圧縮（地雷13） | Tier 0は「外れてもTier 1に落ちるだけ」の設計で吸収。recallは実験で確定、推測しない |

---

## 7. 会議で出た主張への最終判定一覧

| 主張 | 判定 |
|---|---|
| 「Cが根本、C無しにA/Bは届かない」 | **部分棄却**（こん太失敗はCで直らない。りんく成功はCの現状でも届いている） |
| 「Aの崩れは離脱即発」 | **部分採用**（体験リスクは実在するがfail-openで最悪形は既に防止済み。真の即発リスクは無言化=C） |
| 「リトライは429を拡大」 | **棄却**（このトラフィック規模では不成立。ただし時間予算の理由で無条件リトライも不可→条件付き1回） |
| 「指数バックオフ+最大1回」 | **修正採用**（バックオフより予算ゲートを主防御に） |
| 「事前生成代替動画へフェイルオーバー」 | **棄却**（障害点の取り違え） |
| qwen「ハッシュ/messageId記憶」 | **採用**（完全一致のみ、Tier 0として。Gemini非依存の決定パスというC軸への波及効果が決め手） |
| 知覚的ハッシュ/フレーム類似度 | **棄却**(Workersにフレームデコード手段が無い） |
| 「WebM/VP9切り替え」 | **棄却**（E-3却下と矛盾+LINE mp4要件で二重に死） |
| 「フレーム増でサイズがLINE制限に接近」 | **棄却**（maxrate VBVで上限固定、フレーム数非依存） |
| 「サイズより再生開始ラグ」 | **採用**（poster/previewImageUrl等、Sprint 3で） |

---

実装担当への申し送り: Sprint 1の5項目は相互依存が無いので、テスト含め1コミットずつ独立に進めて
よい。実機検証はreality-checkerの流儀（証拠なき緑を認めない）で、§3.4の構造化ログを判定材料に
すること。
