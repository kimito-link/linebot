# 設計書 — りんくBot「自分が写った動画」への一人称自己言及

> 設計=Fable(claude-fable-5) ／ 裏取り=司令塔Claude ／ 2026-07-20
> 3段構え（会議ハーネス→Fable設計→実装引き継ぎ）の手順2の産物。
> 会議素材: `council-question-self-recognition.txt`（design分類、5体召集・3体成功、統合役gpt-oss-120b）
> Fableブリーフ: `fable-brief-self-recognition.md`の要点は本ドキュメントに転記済み

**背景**: 動画埋め込み機能実装後、Bot送信テストで3キャラ（りんく・こん太・たぬ姉）の動画を送信したところ、
いずれも「かわいいキャラクターですね」という他人事描写になった。persona.mdに外見カード（設計書
CHARACTER-VIDEO-DESIGN.md C-1）を追加してデプロイしたが、効果がなかった（実機で確認済み）。

---

## 1. 会議診断の検証結果（コード裏取り）

### 1.1 診断は正しい — ただし1点、前提の修正がある

会議は「persona.mdに外見カードを足しても静的知識に過ぎない」と診断したが、実コードを確認したところ、
**外見カード＋自己認識指示はすでにpersona.md／groq-knowledge-content.tsの両方に実装済み**である
（`knowledge-packs/ai-shain/persona.md` 29〜41行、`apps/worker/src/services/groq-knowledge-content.ts`
35〜46行の「## 自分と仲間の見た目」セクション）。「描写が似ていたら一人称で反応せよ」「他人事の描写は
絶対にしない」まで書いてあるのに、それでも三人称が返っている。

つまりこれは**「プロンプトに指示を足せば直るか」の実験がすでに実施され、失敗した状態**である。会議の
結論（自然言語のあいまいな推論に判定を委ねるのは弱い、構造的解決が必要）は、実コードによって裏付け
られた。案C・案D単独の棄却根拠としてこれ以上ない証拠になる。

### 1.2 見落とされていた副次的要因（2つ発見）

**(a) incomingTextのフレーミング自体が三人称を誘導している**

`apps/worker/src/routes/webhook.ts` 746行:

```
incomingText: `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}を見て、あなたらしく反応してください。`
```

「（ユーザーが）動画を送ってきました」「この動画を**見て**反応して」という文面は、動画を**外部の鑑賞対象**
として位置づける。system prompt中段の条件付き指示（「もし似ていたら一人称で」）と、user turn直近の
明示指示（「この動画を見て反応して」）が綱引きになれば、小型モデルは後者に従う。**persona側の指示が
負けているのは、指示が無いからではなく、より近い位置により強い逆向きの指示があるから**でもある。これは
会議で誰も指摘していない。

**(b) 判定タスクの性質がsmall LLMの弱点に直撃している**

Gemini描写（「金髪でヘッドホンの…」）とpersona内の外見カード（「りんく: 金髪…ヘッドホン…」）の照合は、
プロンプト内の離れた2箇所のクロスリファレンス＋閾値判定であり、Groqで使う小型モデルが最も苦手とする
処理。しかも失敗時の出力（丁寧な三人称の褒め言葉）は文面としては自然なので、モデルに「失敗した」自覚
シグナルが働かない。安全なデフォルトに吸い込まれ続けるという会議の診断どおりの構図。

### 1.3 その他の確認事項（設計の前提となる事実）

- `runGroqSupportPipeline`の返信生成は`generateLlmReplyWithFallback`でGroq→Gemini→Workers AIの
  **3段フォールバック**（`groq-pipeline.ts` 115行）。したがって解決策は**Groq固有機能（JSON mode等）に
  依存してはならず、systemPrompt/incomingTextレベルで効かせる必要がある**。案Aの「Groq側で機械的
  ルール適用」はこの点で減点。
- メディア経路は`cachePolicy: 'skip'`済み（webhook.ts 748行）→ キャッシュ汚染の心配は不要。
- `externalContext`パラメータ（groq-pipeline.ts 45行）はURL用で、メディア経路では未使用。今回も
  incomingText注入で統一する（既存の2026-07-18修正と同じレバー）。
- 描写精度は既に十分（特徴語はGemini出力に正確に含まれる）→ **文字列マッチングの入力品質は保証
  されている**。

---

## 2. 案の評価（3軸: 実装コスト／安全性／タイムアウト予算）

| 案 | 実装コスト | 安全性（7-19事故再発リスク） | タイムアウト影響 | 判定 |
|---|---|---|---|---|
| **A. 構造化中間表現（Gemini出力をJSON化）** | 高 | **中〜高**: describeプロンプト大改造。JSONパース失敗→fail-closedで無言化する新故障モードを追加。自然文描写が失われ反応の具体性も劣化 | なし | 棄却 |
| **B. Worker側静的マッチング** | **低**（純粋関数1ファイル＋webhook 5行） | **最低**: describeプロンプト無変更。マッチ失敗時は現状動作に自然フォールバック。決定的・単体テスト可能 | **ゼロ**（文字列走査は<1ms） | **採用（骨格）** |
| C. Geminiプロンプト微調整 | 低 | **高**: 7-19事故（描写プロンプトへの人格情報混入→生描写がユーザーに漏れる）の再演。しかもLLM推論依存で非決定的 | なし | 棄却 |
| D. メタ文脈注入（フレーミング変更） | 最低 | 低 | ゼロ | **単独では棄却、Bの注入内容として採用** |
| E. アーキテクチャ変更 | 最高 | 高（未知領域） | Groq visionは動画非対応、分類モデル追加は22秒予算に新たな消費者を増やす | 棄却 |

**選定: B+D合成案。** Dの弱点は「いつ一人称フレーミングを適用するか」を決められないこと（全動画に
「鏡に映る自分」と言えば、猫の動画にも自分だと反応する）。Bの弱点は「マッチした後どう伝えるか」が
未定義なこと。**Bが決定器、Dが作動器**として組み合わせると、判定は決定的コード・表現は既存の実績ある
レバー（incomingTextフレーミング）に収まり、LLMのあいまい推論への依存が完全に消える。1.2(a)で発見した
フレーミング問題も同時に解消される。

---

## 3. 詳細設計

### 3.1 データフロー（変更後）

```
LINE動画受信
  → describeVideo()  【無変更。DESCRIBE_VIDEO_PROMPTも無変更】
  → description（自然文・三人称のまま。これで正しい）
  → ★NEW: matchSelfCharacter(description)   … Worker内の純粋関数、<1ms
       ├─ りんくにマッチ(高確信) → incomingText = 一人称強制フレーミング
       ├─ りんくにマッチ(中確信) → incomingText = 「わたしかも？」確認フレーミング
       ├─ こん太/たぬ姉にマッチ → incomingText = 仲間フレーミング
       └─ マッチなし/両義的     → incomingText = 現行文面（完全に現状動作）
  → runGroqSupportPipeline()  【無変更】
```

### 3.2 新規ファイル: `apps/worker/src/services/self-recognition.ts`

役割: Gemini客観描写テキストからキャラ主体を決定的に判定する純粋関数。LLM・DB・fetch一切なし。
fail-open（判定不能→null→現状動作）。

**インターフェース見立て:**

```typescript
export type SelfMatchCharacter = 'りんく' | 'こん太' | 'たぬ姉';

export interface SelfMatchResult {
  character: SelfMatchCharacter;
  confidence: 'high' | 'probable';
  matchedFeatures: string[];  // ログ・テスト用
}

/** マッチなし・複数キャラ同点はnull（現状動作へフォールバック） */
export function matchSelfCharacter(description: string): SelfMatchResult | null;
```

**特徴語テーブルと採点（実装の中核）:**

正規化: 判定前に `description.normalize('NFKC')` ＋小文字化。

| キャラ | 強特徴（weight 2） | 弱特徴（weight 1、各グループ1回のみ加点） |
|---|---|---|
| りんく | `ヘッドホン\|ヘッドフォン` | `金髪\|ブロンド\|金色の髪\|黄色い髪` ／ `オレンジ(色)?の?リボン\|リボン` |
| こん太 | `狐\|きつね\|キツネ`（耳含む） | `オレンジ(色)?の?髪` ／ `耳` |
| たぬ姉 | `狸\|たぬき\|タヌキ` | `茶髪\|茶色い髪` ／ `耳` |

- スコア = Σ(マッチしたグループのweight)。同一グループ内の複数語ヒットは1回だけ数える。
- **閾値: スコア≥3で`probable`、≥4で`high`**（例: ヘッドホン(2)+金髪(1)=3=probable、+リボン(1)=4=high）。
- 弱特徴のみでは最大2点なので発火しない → 「オレンジのリボンをした別キャラ」等の誤爆を構造的に防ぐ。
- 複数キャラが閾値超え → 最高スコア採用、**同点はnull**（両義的なら黙って現状動作。fail-openの原則）。
- 特徴語はこのファイル内に定数として持つ。**persona.md/groq-knowledge-content.tsの外見カードとは
  意図的に独立**させる（あちらは人格の自己知識＝表現用、こちらは判定用。二重管理の対象を増やさない
  ため、persona側の変更は今回不要）。

### 3.3 webhook.ts の変更（動画・音声ブロック、736〜750行付近）

`incomingText:` の1行を、マッチ結果による分岐に差し替える。**変更はこの経路のこの箇所だけ**
（`runGroqSupportPipeline`のシグネチャ・`excludeLogId`・`cachePolicy`はそのまま）。

**文面案（そのまま使える形で提示）:**

```typescript
const selfMatch = msg.type === 'video' ? matchSelfCharacter(description) : null; // まず動画のみ
let mediaIncomingText: string;
if (selfMatch?.character === 'りんく' && selfMatch.confidence === 'high') {
  mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}に写っているのは、あなた自身（りんく）です。ファンが作ってくれたあなたの${mediaLabel}を見せてもらった場面として、一人称で、照れ・喜び・ツッコミなど自分の姿を見たときの感情を素直に伝えてください。${mediaLabel}の中の動き（まばたき・笑顔など）に1つだけ具体的に触れてください。`;
} else if (selfMatch?.character === 'りんく') { // probable
  mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}に写っているのは、おそらくあなた自身（りんく）です。「わたし…だよね？」と軽く確かめつつ、一人称で嬉しさを伝えてください。`;
} else if (selfMatch) { // こん太・たぬ姉
  mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}に写っているのは、あなたの仲間の${selfMatch.character}です。仲間が${mediaLabel}に登場して嬉しい、というあなたらしい反応をしてください。`;
} else {
  mediaIncomingText = `（${mediaLabel}を送ってきました。内容は次の通りです: ${description}）この${mediaLabel}を見て、あなたらしく反応してください。`; // 現行文面そのまま
}
```

文面設計の意図:
- 「〜は、あなた自身（りんく）です」と**判定済みの事実として断言**する。モデルに判定を残さない（会議の核心対応）。
- 否定形指示（「キャラクターという言葉を使うな」等）は入れない。否定形はかえって語彙をプライミングする。
  禁止事項はpersona.md既存の「他人事の描写は絶対にしない」が引き続き担う。
- 「ファンが作ってくれた〜を見せてもらった場面として」という状況フレーミングは、7-18修正（カギ括弧
  メタ記法回避）と同じ会話的スタイルを維持。
- 観測用ログを1行追加: `console.log('[self-recognition] matched', JSON.stringify({ character, confidence, matchedFeatures }))`。
  マッチなし時もdebugログを出すと実機検証が楽。

### 3.4 テスト: `apps/worker/src/services/self-recognition.test.ts`（新規）

リポは`*.test.ts`同居方式（`media-describe.test.ts`等が既にある）。純粋関数なのでモック不要。
最低限のケース:

1. 実機で確認済みのGemini描写文（「金髪でヘッドホンをつけ、オレンジのリボンの〜キャラクターが…」）→ りんく/high
2. ヘッドホン+金髪のみ → りんく/probable
3. 「オレンジのリボンをつけた猫」→ null（弱特徴のみ）
4. 狐耳+オレンジ髪 → こん太
5. りんくとこん太が同点になる合成文 → null
6. 全く無関係な描写（風景・料理）→ null
7. NFKC正規化（半角カナ・全角英数混在）で崩れないこと

### 3.5 変更しないもの（地雷順守チェックリスト）

| 地雷 | 本設計での扱い |
|---|---|
| `DESCRIBE_VIDEO_PROMPT`（media-describe.ts 33行） | **一切触らない**。7-19事故の再発経路を物理的に遮断 |
| fail-closed設計（describe失敗→null→無言） | 無変更。self-recognitionは**fail-open**（判定不能→現状動作）で、無言化の新経路を作らない |
| timeoutMs=22秒／REPLY_DEADLINE 45秒 | 文字列走査のみで消費ゼロ。LLM呼び出し回数も増えない |
| persona.md／groq-knowledge-content.ts二重管理 | **今回どちらも変更不要**（既存の外見カード・反応指示はそのまま表現層として活きる） |
| 3段フォールバックチェーン | incomingText注入なのでGroq/Gemini/Workers AIどの段でも同様に効く |

---

## 4. まず試すべき最小の一手（段階導入計画）

**Phase 1（最小の一手）**: `self-recognition.ts`新規作成＋webhook.tsの**動画経路のみ**差し替え＋単体
テスト。実機で「りんく動画→一人称反応」「無関係動画→現状どおり」の2本を確認。fork
（kimito-link/line-harness-oss）へpush→Actionsデプロイ。

**Phase 2（Phase 1成功後）**: 画像経路（webhook.ts 662行の`incomingText`）に同じヘルパーを適用。
ファンアート静止画でも自己言及が働く。音声はマッチ対象外のまま（外見特徴が乗らないため
`msg.type === 'video'`ガードで除外済み）。

**Phase 3（誤判定が実際に観測された場合のみ）**: 特徴語テーブル・閾値の調整で対処。それでも足りない
場合に初めて案A（構造化中間表現）を検討する。**先回りでAに行かない**こと。

**実装時の確認ポイント（設計外だが要検証）**: `groq-reply.ts`の`imageRowToHistoryText`は履歴上の
メディア行を`[画像: <客観描写>]`形式で出す（44〜51行）。自己言及返信の**次のターン以降**、履歴に
三人称描写が残って会話が三人称に引き戻される可能性がある。Phase 1の実機検証で連続会話を1回試し、
問題が出たときだけ履歴表現の調整を別課題として起票する（今回のスコープには含めない）。
