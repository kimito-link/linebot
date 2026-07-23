# 実装ハンドオフ — Kimito Link デモ動画1「言葉が、人格になる。」

> このファイル1枚で着手できます。設計の全文は [`KIMITO-LINK-DEMO-VIDEOS-DESIGN.md`](KIMITO-LINK-DEMO-VIDEOS-DESIGN.md) 参照（読む必要があるのはE章「MVP」とC章「制作仕様」とG章「地雷」だけで十分）。
> 3段構えワークフロー（council-fable）の手順3の産物。実装は別セッション/別モデルで行う想定。

## スコープ（今回作るのはこれだけ）

動画1本「言葉が、人格になる。」（60〜90秒）を収録・編集・YouTube公開・LP掲載し、既存のdHashデモを
「安心の話」セクション直後に移設する。動画2（3キャラ切替）・動画3（マルチモーダル深掘り）は**今回やらない**。

## 前提確認（着手前に1回だけ）

- [ ] Gemini APIが生きているか確認（`gemini-3.1-flash-lite`、`GEMINI_API_KEY`は`line-bot-video`プロジェクトのもの）。
      死んでいたら台本B（設計書C章、写真反応パートを削除した版）に切り替える。
- [ ] LINEデスクトップアプリの現在の配置モニターを確認しておく（前回セッションでモニター特定に手間取った）。
- [ ] Bandicamの録画範囲がLINEウィンドウと同じモニターになっているか確認。

## 着手手順

1. **台本確定（15-20分、コーディング前）**
   - 設計書C章の台本A（4幕構成）を元に、実際に送信する文言を一字一句決める。
   - 人格作成プロンプト例と、その後の相談メッセージ例を用意する。
   - 写真反応パートで使う画像を1枚用意する（プライバシーに配慮した無難な画像）。

2. **収録（30分目安）**
   - Bandicamで録画開始 → LINEで台本通りに送信 → 反応を確認 → 録画停止。
   - 返信が「らしくない」場合は送信文言を変えて撮り直す（編集でごまかさない、設計書C章より）。

3. **編集（30分目安、ffmpegで既存パイプライン踏襲）**
   - dHashデモ制作時のffmpegコマンド（クロップ・セグメント抽出・concat）をベースに流用する。
   - タイトルカード・エンドカードに`link-loop.mp4`等の既存ループ動画を`#FAF7F2`下地+overlayで合成。
   - 出力は9:16 (1080×1920)、mp4/h264、crf22+maxrate800k、**`-movflags +faststart`必須**。
   - 遷移はハードカットのみ（xfade禁止）。

4. **YouTube公開**
   - YouTube Studioでアップロード（前回セッションではブラウザ拡張経由の自動操作が不安定だったため、
     ユーザー自身がタイトル・説明・公開範囲を入力する手動フローを推奨）。
   - タイトル案: 「言葉だけで、"その人"をつくる。｜Kimito Link」
   - 動画IDを控える。

5. **LP反映（origin/main、Vercel）**
   - `apps/lp/index.html`のヒーローセクション（`</header>`）直後に、設計書C章のLP配置コードを挿入。
     既存の`.demo-video-embed`/`.frame`/`.eyebrow`CSSをそのまま使う（追加CSS不要）。
   - 既存dHashデモセクション（REAL DEMO、eyebrow="REAL DEMO"）を「安心の話」セクション直後へ移動し、
     見出し・リード文を設計書D章の通り書き換える（eyebrow→`BEHIND THE SCENES`、h2→「なぜ、ここまで
     "わかって"くれるのか。」）。
   - **originリポジトリへの反映方法**（前回セッションで確立した手順）:
     ```bash
     # line-botリポジトリ内、fork向け作業ブランチとは別にworktreeを作る
     git fetch origin main
     git worktree add <scratchpad>/lp-worktree origin/main
     cd <scratchpad>/lp-worktree
     git checkout -b feat/main-demo-video
     # index.htmlの差分だけを適用（他ファイルは触らない）
     git add apps/lp/index.html
     git commit -m "feat(lp): メインデモ動画をヒーロー直下に追加、dHashデモを信頼補強セクションへ移設"
     git push origin feat/main-demo-video:main
     git worktree remove <path> --force
     ```
   - デプロイ確認: `apps/lp`ディレクトリで`npx vercel --prod --yes`（GitHub連携の自動デプロイは信用しない）。
   - 本番URL（`https://lp-eight-dusky.vercel.app/`）で実際に動画が再生できるか確認。

## 完了判定（機械的に確認できる基準）

- [ ] `curl -s https://lp-eight-dusky.vercel.app/ | grep "MAIN DEMO"` がヒットする
- [ ] `curl -s https://lp-eight-dusky.vercel.app/ | grep "BEHIND THE SCENES"` がヒットする（dHash移設確認）
- [ ] YouTube動画がLP上のiframeから実際に再生できる（reality-checkerまたは目視で確認）
- [ ] `apps/lp/index.html`に`-movflags`関連のエンコード事故（再生開始遅延）が発生していない

## 地雷（詳細は設計書G章）

- コーデックはmp4/h264限定。WebM/GIF/APNGは過去に却下済みなので再検討しない。
- `-movflags +faststart`忘れ厳禁。
- xfade禁止、ハードカットのみ。
- リポジトリ混同注意（LP=`origin`、Bot本体=`fork`）。
- Vercel自動デプロイは信用せず、必ず手動`vercel --prod`で確認する。

## 転記元の実在パス一覧

- 既存ループ動画: `apps/lp/assets/video/link-loop.mp4` / `konta-loop.mp4` / `tanunee-loop.mp4`（`apps/lp/index.html:250,254,258,338,347,351`で使用中）
- 既存dHashデモセクション: `apps/lp/index.html`内 `<span class="eyebrow">REAL DEMO</span>` を含むsection
- 既存CSS: `apps/lp/index.html`内 `.demo-video-embed` / `.frame` / `.eyebrow` クラス定義
- 過去のffmpeg編集手順の実例: 本セッションで作成した`_docs/demo-video/rinku-self-recognition-demo.mp4`の制作過程（このチャットのログ、またはコミット`5af5914`/`6a784f2`のPR差分）
