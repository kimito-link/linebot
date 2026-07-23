# 実装ハンドオフ — Kimito Link 動画ラインナップV2（REAL DEMO格上げ＋動画2本追加）

> このファイル1枚で着手できます。設計の全文は [`KIMITO-LINK-DEMO-VIDEOS-LINEUP-V2-DESIGN.md`](KIMITO-LINK-DEMO-VIDEOS-LINEUP-V2-DESIGN.md) 参照（E章「MVP」・C章「制作仕様」だけで十分）。
> 3段構えワークフロー（council-fable）の手順3の産物。

## スコープ（優先順位つき、3段階）

1. **今すぐ・コード変更のみ**: REAL DEMOセクションをヒーロー直下へ移動（LPコピー・構造変更、新規収録不要）
2. **次のセッション・MVP**: 動画②「気づいた、そのあと。」を収録・編集・公開・LP追加
3. **その次・2番手**: 動画③「ちゃんと、見分けてる。」（収録前に帰属反応の実機確認が必須条件）

## 着手手順

### ステップ1: REAL DEMOセクションの格上げ（コード変更のみ、今すぐ実行可）

1. `apps/lp/index.html`で、`<span class="eyebrow">REAL DEMO</span>`を含む`<section class="soft">`〜
   `</section>`の塊を特定する。
2. その塊を`</header>`（ヒーロー終了タグ）の直後、「USE IT YOUR WAY」セクションの前に移動する。
   **中身（h2文言・iframe埋め込み）は変更しない**、位置だけ動かす。
3. `origin`（`kimito-link/linebot`）のmainへ、前回同様worktree経由でLP差分のみpush。
4. `npx vercel --prod --yes`で本番反映、実機確認。

完了判定: `curl -s https://lp-eight-dusky.vercel.app/` で、`</header>`直後（「USE IT YOUR WAY」より前）に
`REAL DEMO`が出現することを確認する（`grep -o -A2 "</header>"`等で位置関係を見る）。

### ステップ2: 動画②の収録・編集・公開（次セッション、60-75分）

1. 収録前にGemini API疎通確認は不要（Tier 0/0.5の決定的判定のみ使用、Tier 1には依存しない設計）。
2. LINEデスクトップで「りんく」のトークを開き、設計書C章の収録シナリオ通りに3往復を実演・Bandicam録画。
3. ffmpeg編集: 9:16、mp4/h264、crf22+maxrate800k、`-movflags +faststart`必須、ハードカットのみ。
   タイトルカードは`#FAF7F2`下地+`apps/lp/assets/video/link-loop.mp4`合成（既存パターン踏襲）。
4. YouTube Shortsへアップロード（限定公開または公開、ユーザー確認の上で）。動画IDを控える。
5. `apps/lp/index.html`のREAL DEMOセクション内に`.demo-video-grid`ブロックを追加（設計書C章のHTML/CSS
   をそのまま使用）。この時点では動画②のみ、動画③の枠は作らない（1本ずつ追加、fail-closed）。
6. `origin`main反映→Vercel手動デプロイ→実機確認。

完了判定: LP上で動画②が再生でき、`.demo-video-grid`にfigcaption「気づいた、そのあとも。」が表示される。

### ステップ3: 動画③（その次のセッション、60-90分）

1. **収録開始前に必須**: 別テストアカウントで「こん太のトークにりんくの動画を送ると、正しく『それはりんく』
   と否定するか」を実機確認する。返らない場合は設計書C章の代替シナリオ（再現性デモ）に切り替える。
2. 確認OKなら設計書C章の収録シナリオで実演・録画・編集・公開。
3. `.demo-video-grid`に2つ目のfigureを追加。

## 地雷（詳細は設計書G章）

- コーデックmp4/h264限定、`-movflags +faststart`必須、ハードカットのみ、`origin`リポジトリ限定、
  Vercel手動デプロイ必須。
- **未完成の動画枠をLPに先置きしない**（「準備中」表示は作らない）。
- 動画③は帰属反応の実機確認が収録開始の前提条件。
- ビジネス系動画・失敗ケース動画は作らない（設計書F章で明示的に却下済み）。

## 転記元の実在パス一覧

- REAL DEMOセクション: `apps/lp/index.html`内 `<span class="eyebrow">REAL DEMO</span>`を含むsection
- 既存CSS: `apps/lp/index.html`内 `.demo-video-embed` / `.frame` クラス定義
- ループ動画資産: `apps/lp/assets/video/link-loop.mp4`（動画②のタイトルカードに使用）
- 既存の1本目Shorts: `https://www.youtube.com/embed/gBpNXxri9Zs`
- 前回のffmpeg制作実例: `_docs/demo-video/rinku-self-recognition-demo.mp4`、コミット`5af5914`/`6a784f2`
