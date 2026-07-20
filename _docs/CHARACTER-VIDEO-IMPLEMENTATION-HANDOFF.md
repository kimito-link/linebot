# 実装ハンドオフ — りんくBot キャラクター動画

> この1枚だけで着手できる。設計の背景・判断根拠は [`CHARACTER-VIDEO-DESIGN.md`](./CHARACTER-VIDEO-DESIGN.md) を参照（読む必要が生じたときだけ）。
> 実装は別モデル/次チャットで行う。このドキュメント作成時点では未着手。

## スコープ（MVPだけ）

1. **LP用ヒーロー動画3本**（りんく・こん太・たぬ姉、各8秒480×480）をffmpegで新規生成し、`apps/lp/assets/video/{link,konta,tanunee}-loop.mp4` を上書き
2. **LINE Bot送信テスト用動画3本**（同キャラ、各6秒・軽量エンコード）を別途生成
3. Bot送信テスト用動画を実際にLINE公式アカウント（りんくBot）へ送信し、3キャラそれぞれの人格プロンプトが「自己外見カード」（設計書C-1）の反応をするか実機確認

**やらないこと（今回のMVPスコープ外）**:
- パーツ分解版でのリグ的アニメーション（設計書E-2で却下・温存カード）
- 人格プロンプトの恒久的な書き換え（まずBot版動画で試験送信し、反応が微妙なら次回調整）

## 着手手順

1. ブランチを切る（例: `feat/character-loop-videos`）
2. 素材を scratchpad にコピー（地雷12: OneDrive同期ロック回避）:
   ```bash
   mkdir -p /path/to/scratchpad/video-src
   cp "C:/Users/info/OneDrive/デスクトップ/Resilio/github/kimito-link/src/images/yukkuri-charactore-english/link/"*.png /path/to/scratchpad/video-src/link/
   # konta, tanunee も同様
   ```
3. 各キャラの`fc-{link,konta,tanunee}.txt`（filter_complex_script）を設計書A-3のストーリーボード通りに作成。**こん太は地雷10の命名マッピングに注意**（`kitsune-yukkuri-normal.png`=口開き、`kitsune-yukkuri-mouth-closed.png`=口閉じ）
4. LP版（8秒/24fps/crf22+maxrate800k/`-an`）を3キャラ分生成。設計書A-4のコマンド構造を使用、入力パスはフルパスに置き換え
5. Bot版（6秒/12fps/350k+無音AAC）を3キャラ分生成。設計書B-3のコマンド構造を使用
6. `ffprobe`で全6本のサイズ・尺・fpsを検収（LP版≦0.85MB、Bot版≦0.4MBであること）
7. LP版のみ`apps/lp/assets/video/`へコピーし、既存の3本を上書き
8. ローカルサーバーで`<video>`タグの再生を確認（前回同様、`file://`直開きは避けローカルサーバー経由）
9. コミット→pushしてVercel `--prod`デプロイ（前回同様、明示許可があるまで本番反映しない）
10. Bot版動画を実際にLINE公式アカウントへ送信し、Botの反応を確認（設計書C-2の反応例と比較）
11. 反応が「かわいいキャラクターの動画ですね」のような他人事描写になっていたら、人格プロンプトに設計書C-1の「自己外見カード」スニペットを追加する必要あり（このハンドオフのスコープ外、別タスク化）

## 機械的な完了判定

- [ ] `apps/lp/assets/video/{link,konta,tanunee}-loop.mp4`が新しいストーリーボード版に更新されている（`ffprobe`で尺8秒・480x480を確認）
- [ ] 各LP版動画のファイルサイズが0.85MB以下
- [ ] 各Bot版動画のファイルサイズが0.4MB以下、尺6秒以下
- [ ] 透過→黒背景の問題が発生していない（フレーム抽出して背景色`#FAF7F2`であることを目視確認）
- [ ] ループ点で絵・呼吸位相が跳ばない（先頭フレームと最終フレームを目視比較）
- [ ] LPをローカルサーバーで開き、6箇所（ヒーロー3体+MORE THAN TEXTセクション3体）の動画が正しく再生される
- [ ] Bot版動画をLINE公式アカウントに送信し、既読後にBotから何らかの返信が来る（無反応=タイムアウト連鎖の兆候）

## 地雷（設計書からの転記・実装時に踏みやすい順）

1. Windows引用符地獄: `filter_complex`は`-filter_complex_script`でファイル外出しし、Git Bashで実行（PowerShellに複雑なfilter文字列を渡さない）
2. `fade=in:...`に`alpha=1`忘れ→黒フェード事故
3. `-loop 1`入力に`-t 尺`忘れ→無限エンコードで固まる
4. こん太の命名罠（上記手順3参照）
5. `llm.video.timeoutMs`（現在22秒）は絶対に延長しない。音声で実障害を起こした前例あり（設計書B-3参照）
6. `-movflags +faststart`を全出力に付与し忘れない（Vercel配信での再生開始遅延を防ぐ）

## 転記元の実在パス一覧

- キャラ表情差分素材: `kimito-link/src/images/yukkuri-charactore-english/{link,konta,tanunee}/*.png`（1500×1500 RGBA、実在確認済み）
- 現行LP動画（上書き対象）: `apps/lp/assets/video/{link,konta,tanunee}-loop.mp4`
- LP埋め込み箇所: `apps/lp/index.html`内の`<video class="trio-avatar">`×6箇所
- 締め切り定数: `apps/worker/src/services/llm-chain.ts:30`（`REPLY_DEADLINE_MS`）
- 動画タイムアウトガード: `apps/worker/src/services/media-describe.ts:21,55`（`POST_DESCRIBE_MARGIN_MS`）
- Bot設定: `bot.config.json`の`llm.video`（`timeoutMs: 22000`は変更不可）
- 人格プロンプト（自己外見カード追加候補地、未特定）: `apps/worker/src/services/groq-pipeline.ts`または関連プロンプト構築箇所を要調査
- 本番デプロイ元: `kimito-link/line-harness-oss`（`fork`リモート）。LP側は`kimito-link/linebot`（`origin`リモート）
