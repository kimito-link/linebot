# 引き継ぎプロンプト — 2026-07-21 セッション（Part 3）終了時点

次のチャットの冒頭にこのファイルの内容をそのまま貼るか、「`_docs/HANDOFF-RESUME-2026-07-21-PART3.md`を読んで続きから」と伝えてください。
前回の引き継ぎ（`_docs/HANDOFF-RESUME-2026-07-21-PART2.md`）の続きのセッションです。

---

## リポジトリ構成（毎回混同しやすいので再掲）

| リモート名 | 実体 | 用途 |
|---|---|---|
| `fork` | `kimito-link/line-harness-oss` | **Bot本体の本番デプロイ元**。`apps/worker/**`等の変更はここにpush後、`gh workflow run deploy-cloudflare-worker.yml --repo kimito-link/line-harness-oss --ref feat/character-loop-videos`でデプロイ |
| `origin` | `kimito-link/linebot` | **LP（`apps/lp/`）専用**。Vercel（`lp-eight-dusky.vercel.app`）がここをデプロイ対象にしている。**自動デプロイは信用できない、必ず`npx vercel --prod --yes`を`apps/lp`ディレクトリで手動実行して確認する** |
| `shudesu` | `Shudesu/line-harness-oss` | 第三者リポジトリ。**一切pushしない** |

現在の作業ブランチ: `feat/character-loop-videos`（`fork`とは同期済み、作業ツリーはクリーン）

Cloudflareアカウント: `ca40e10bfbfdda12a70fbff91f4e1089`。本番Worker名は`kimitolink-line`。
本番URL: `https://kimitolink-line.info-a40.workers.dev`
LP本番URL: `https://lp-eight-dusky.vercel.app/`

**origin へのLP差分反映の定型手順**（このセッションで複数回使った、次回も同じ手順でよい）:
```bash
git fetch origin main
git worktree add <scratchpad>/lp-worktreeN origin/main
cd <scratchpad>/lp-worktreeN
git checkout -b feat/<わかりやすい名前>
git diff origin/main..HEAD -- apps/lp/index.html > /tmp/xxx.patch  # 現在のfeat/character-loop-videosブランチ側で先に生成
git apply /tmp/xxx.patch
git add apps/lp/index.html && git commit -m "..."
git push origin feat/<名前>:main
cd - && git worktree remove <path> --force
cd apps/lp && npx vercel --prod --yes
```

---

## このセッション（Part 3）でやったこと（時系列）

### 1. Part 2からの引き継ぎ完了
- Gemini APIキーをCloudflareの`GEMINI_API_KEY`にローテート・デプロイ（新プロジェクト`line-bot-video`のキー）
- モデル名を`gemini-2.5-flash-lite`→`gemini-2.5-flash`→**`gemini-3.1-flash-lite`**に段階的に修正（新規プロジェクトでは旧世代モデルが404になるため）。実機で動画認識が正常動作することを確認済み（コミット`94bad46`〜`a4aa7d0`）

### 2. 予算アラート設定
Google Cloud「請求先アカウント1」に月¥3,000の予算アラートを設定済み（50%/90%/100%でメール通知）

### 3. 自発的フォローアップ機能（OpenClaw方式）実装
`apps/worker/src/services/followup-nudge.ts`を新規実装。過去に会話履歴があり最終発言から24時間返信がない相手に、AI生成の一言を1回だけpush送信。6時間cronで稼働（コミット`7565935`）。テスト5件全通過、本番デプロイ済み。

### 4. dHash自己認識のYouTube実演デモ制作・LP埋め込み
LINEデスクトップでの実演をBandicam録画→ffmpeg編集（9:16, mp4/h264, crf22+maxrate800k, `-movflags +faststart`必須, ハードカットのみ）→YouTube Shorts公開（`https://www.youtube.com/shorts/gBpNXxri9Zs`）→LP埋め込み（コミット`5af5914`）

### 5. 3段構えワークフロー（council-fable）でプロダクト価値提案を再定義 ★重要な方針転換
ユーザーの発言「ビジネスでも、亡くなった個人でも。自分を認識してもらえる。推し活やカスタマーサポート、汎用性は無限大」をきっかけに、Exploreエージェント調査で**「言葉で人格を自由に作れる」機能は実装されておらず、りんくの人格はハードコードされた固定文言だった**ことが判明。

マルチLLM会議ハーネス＋Fable(claude-fable-5)設計により、以下の方針転換を実施・実装・本番反映済み：
- **主軸を「自分を認識してもらえる」体験（dHash技術）に一本化**。人格カスタマイズ訴求はLPから全面削除
- **偲び・グリーフケア用途は提供しない**と明確に決定（現技術は「登録済みアセットとの近似一致」のみで、初見の顔・姿を認識する顔認識ではなく、遺族に対して倫理的リスクが高いため）
- LP全体（ヒーロー・6カード・3ステップ・FAQ・CTA等）を新方針で書き換え・本番反映済み（コミット`f2725f5`）
- REAL DEMOセクション（dHashデモ動画）をヒーロー直下に格上げ（コミット`c1d843c`）

**保存した正本ドキュメント**（すべて`_docs/`配下）:
- `KIMITO-LINK-VALUE-PROPOSITION-DESIGN.md` — 価値提案の再定義（設計書）
- `KIMITO-LINK-VALUE-PROPOSITION-IMPLEMENTATION-HANDOFF.md` — 実装ハンドオフ（完了済み）
- `KIMITO-LINK-DEMO-VIDEOS-DESIGN.md` — 旧動画設計書（**一部無効、冒頭に打ち消し追記あり**）
- `KIMITO-LINK-DEMO-VIDEOS-LINEUP-V2-DESIGN.md` — 新動画ラインナップ設計書（正本）
- `KIMITO-LINK-DEMO-VIDEOS-LINEUP-V2-IMPLEMENTATION-HANDOFF.md` — 実装ハンドオフ

### 6. 動画②「気づいた、そのあと。」の収録を試みるも失敗 ★次回引き継ぎの本題
V2設計書のMVP（動画②、りんく1キャラで3往復の収録シナリオ）に着手。

**つまずいた点1（解決済み）**: LINEデスクトップでトーク検索から複数回別のトーク（「Kimito-Link Project」「友だち」タブの個人トーク）に迷い込んだ。最終的に正しい「ゆっくりサポートAI社員りんく」トーク（公式アカウントタブ内）を発見・選択できた。

**つまずいた点2（解決済み、知見として残す）**: メッセージ入力欄でEnterキーを押しても**改行になるだけで送信されない**。Ctrl+Enterも効かなかった。原因不明のまま、テキスト単独送信は諦めて動画添付のみで代替した（`link-hero.mp4`を2回連続送信し、「気づいた、そのあとも一貫している」という設計書の趣旨は実演できた）。**次回はこの問題を先に解決するか、テキストは諦めて動画添付主体で台本を作り直すこと**。

**つまずいた点3（未解決、致命的）**: Bandicamで約16分間録画したが、**録画された内容が終始「ファイルエクスプローラー（ダウンロードフォルダ）」の画面のままで、LINEでの実演が一切映っていなかった**。原因: Bandicamのウィンドウ自体を操作しやすいモニターに移動しても、**Bandicamの「録画対象モニター」の設定（キャプチャ対象）は別モニターに固定されたままだった**。ウィンドウの表示位置とキャプチャ対象は別設定であることを見落としていた。この録画ファイル（`bandicam 2026-07-21 22-13-47-998.mp4`）は使い物にならないため破棄してよい。

**セッション終了時点の状態**: ユーザーに「LINEをディスプレイ4に移動してほしい」とお願いしたところ、「ディスプレイ4にして、押しやすい位置に移動しました」と返答があったが、Claude側で`switch_display`・`open_application`を繰り返してもLINEウィンドウを画面に表示できず（タスクバーのLINEアイコンクリックがcomputer-useツールの制限で直接操作できない）、行き詰まった状態でコンテキスト逼迫により引き継ぎとなった。

---

## 次にやること（優先順位）

1. **最優先**: Bandicamの録画対象モニター設定を確認・修正してから、動画②の収録をやり直す
   - Bandicamウィンドウの「ホーム」タブ→録画範囲（デスクトップ全体 or 特定モニター選択）の設定を明示的に確認すること
   - 前回（Part 2）のdHashデモ収録では同じモニターに両方あった状態で成功しているので、**その時と同じセットアップ手順を再現するのが最も確実**
   - LINEの現在の位置が分からなくなったら、まずユーザーに「今LINEはどのモニターに表示されていますか、番号で教えてください」と直接尋ねるのが手戻りが少ない
2. LINE入力欄でEnterキーが送信されない問題の原因を特定する（IME設定、LINEの設定内「Enterキーで送信」オプションの有無を確認するとよいかもしれない）。解決しなければ、テキストメッセージなしで動画・画像添付のみの台本に作り直す
3. 動画②収録完了後: ffmpeg編集→YouTube Shorts公開→LP追加（`KIMITO-LINK-DEMO-VIDEOS-LINEUP-V2-IMPLEMENTATION-HANDOFF.md`のステップ2を参照）
4. 動画③「ちゃんと、見分けてる。」（収録前に「他キャラの動画に正しく否定反応するか」の実機確認が必須条件、設計書C章参照）

## ユーザーの意向（重要な文脈）

- 「最高のものを作りたい」という強い要望があり、時間をかけて実機検証・修正を繰り返すことを歓迎している
- 3段構え（会議ハーネス→Fable→実装）のワークフローを気に入っており、今回の価値提案再定義でも自発的に指示してきた。今後も複雑な設計判断が必要な場面ではこの手順を使うとよい
- Google Cloud関連の操作（ログイン、支払い情報、プロジェクト作成）は必ずユーザー自身に行ってもらう方針を徹底している
- モニターが5枚（DELL P1914S、DELL P1914S (2)、DELL S2425HS、ROG PG279Q、LG TV）あり、Claude側からは今どのモニターに何が表示されているか把握しづらい。**LINEやBandicamの位置を見失ったら、遠慮なくユーザーに直接尋ねるのが結果的に早い**
