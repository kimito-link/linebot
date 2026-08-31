# 音声応答デモ（kimitotalk.link 掲載用）

「LINEに音声メッセージを送ると、キャラクターが声で返す」という仕組みを見せるためのデモ一式。

- **触って試すデモ**: `index.html` + `server.mjs`（ブラウザで実際に話しかけられる）
- **LP掲載用の動画を作る**: `record.html` + `make_audio.mjs` + `record.mjs`

掲載先は `apps/lp/kimitotalk/index.html` の「こんなこともできます」セクション。

## 前提

VOICEVOXアプリが起動していること（エンジンは `http://127.0.0.1:50021`）。

```bash
curl -s http://127.0.0.1:50021/version
```

これが応答しない場合は VOICEVOX を起動する:
`C:\Users\info\AppData\Local\Programs\VOICEVOX\VOICEVOX.exe`

## 触って試すデモ

```bash
node server.mjs
```

`http://localhost:8787/` を開く。マイクボタンで話しかけるか、テキスト入力でも試せる。
音声認識はブラウザの Web Speech API を使うので Chrome 推奨（APIキー不要）。

`server.mjs` は静的配信に加えて `/vv/*` を VOICEVOX へプロキシする。
ブラウザから `127.0.0.1:50021` を直接叩くと CORS で弾かれるため、必ずこのプロキシを経由する。

## LP用の動画を作り直す

```bash
# 1. 音声トラック（VOICEVOXで合成 → 冒頭に無音を足して尺を合わせる）
node make_audio.mjs          # -> demo_audio.wav

# 2. 映像（Playwrightで録画。※Playwrightの録画に音声は入らない）
#    line-bot配下で npm install playwright すると親のワークスペース設定を拾って失敗するので、
#    スクラッチパッド等に独立したディレクトリを作り、そこで作業する:
#      mkdir rec-work && cd rec-work
#      echo '{"name":"rec-work","private":true,"type":"module"}' > package.json
#      npm install playwright
#      cp ../record.html ../record.mjs ../demo_audio.wav .
node record.mjs              # -> rec/*.webm

# 3. 合成してmp4化（既存 setup-demo.mp4 と同じ映像仕様に揃える）
ffmpeg -y -i rec/page@*.webm -i demo_audio.wav \
  -map 0:v -map 1:a \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -r 25 -s 1280x900 -crf 23 \
  -c:a aac -b:a 128k \
  -movflags +faststart -shortest \
  voice-demo.mp4

# 4. posterとあわせてLPへ配置
ffmpeg -y -ss 12 -i voice-demo.mp4 -frames:v 1 -q:v 3 voice-demo-poster.jpg
cp voice-demo.mp4 voice-demo-poster.jpg ../../apps/lp/kimitotalk/assets/videos/
```

### 守ること

- **`make_audio.mjs` の `PLAY_AT_SEC` と `record.html` の `'play'` イベント時刻を一致させる。**
  ずれると「再生ボタンが光る瞬間」と「声が鳴り始める瞬間」がずれる。
- **`-movflags +faststart` は必須**（付け忘れるとVercel配信で再生開始が遅延する）。
- **コーデックは mp4/h264 固定**。WebM・GIF は過去に検証のうえ却下済み。
- **波形バーに乱数を使わない**。`record.html` は固定パターンにしてある（録り直しで絵が変わらないように）。

### LP側の埋め込みについて

他のLP動画は `autoplay muted loop` だが、**この動画だけは `controls` 付き・autoplayなし**にしている。
音が主役なので muted 自動再生では訴求が成立しないため。「▶ を押すと音が出ます」の一文も必ず添える。

## 声の割り当てとクレジット表記

`ouenmovie/whc-it/script_vertical.py` の `VOICE` 辞書が正本。勝手に別IDを当てると既存動画と声がブレる。
コード側の正本は `apps/worker/src/services/voice-reply.ts`（`CHARACTER_SPEAKER_ID` / `CHARACTER_CREDIT`）。

| キャラ | 話者ID | VOICEVOX話者 | クレジット表記 |
|---|---|---|---|
| たぬ姉 | 14 | 冥鳴ひまり | VOICEVOX：冥鳴ひまり |
| りんく | 8 | 春日部つむぎ | VOICEVOX：春日部つむぎ |
| こん太 | 32 | 白上虎太郎（わーい） | VOICEVOX：白上虎太郎 |

**クレジット表記は義務**。VOICEVOXは商用・非商用問わず利用できるが、「VOICEVOXを利用したことが
わかるクレジット表記」が利用規約で求められている（キャラごとの個別規約もある）。
声を出す場所には必ず添えること。参照: https://voicevox.hiroshiba.jp/term/

## LINE実機で音声を返す（2026-08-25 実装済み）

Worker側の実装は入っている（`apps/worker/src/services/voice-reply.ts`）。
**音声メッセージを受け取ったときだけ**、返答をキャラクターの声で返す。
動画・エスカレーション・エラー通知は確実に読まれるべきなのでテキストのまま。

### なぜ合成役がWorkerの外にあるのか

LINEの音声メッセージは **m4a(AAC)しか受理しない**（mp3/wav不可、HTTPS必須、duration=ミリ秒）。
一方 Cloudflare Workers では AAC エンコードができない:

- ffmpeg.wasm は約31MB。Workersのバンドル上限（10MB gzip）を超える
- 実行時に取得したバイト列からのWASMコンパイルは禁止されている（ffmpeg.wasmはこれで起動する）
- メモリ128MB・CPU時間の制約

主要なクラウドTTS（Gemini/Azure/Google）もm4aを直接返さない（PCM/mp3/opusのみ）ので、
**どのルートを通ってもm4aへの変換役がWorkerの外に要る**。

そこで合成役を `VoiceSynthesizer` インターフェースの裏に隠してある。契約は POST 1本だけ:

```
POST {VOICE_SYNTH_ENDPOINT}
Authorization: Bearer {VOICE_SYNTH_TOKEN}
{ "text": "...", "speakerId": 14 }
→ 200 audio/mp4 (m4aのバイト列) + ヘッダ X-Duration-Ms
```

この契約さえ満たせば中身は何でもよい。VOICEVOXでも、別のTTSでも、10年後の別の何かでも、
**Worker側のコードは1行も変えずに差し替えられる**。

### 動かし方（コンテナ・常設向け）

VOICEVOX公式イメージ＋合成サーバーの2コンテナ。特定のクラウド製品に依存しない
普通のコンテナなので、VPSでもクラウドのコンテナサービスでも自宅サーバーでも置ける
（置き場所を後から変えられる、というのがこの構成の狙い）。

```bash
VOICE_SYNTH_TOKEN=<好きな秘密の文字列> docker compose up -d
```

そのうえで https で到達できるようにし、Workerに設定する:

```bash
npx wrangler secret put VOICE_SYNTH_ENDPOINT   # そのURL
npx wrangler secret put VOICE_SYNTH_TOKEN      # 上と同じ値
# 任意: VOICE_CHARACTER = tanunee | link | konta （既定はtanunee）
```

> **検証状況**（この環境にDockerが無いため、`docker compose up` 自体は未実行）
>
> 確認できていること:
> - `node synth-server.mjs` の直接起動は実機で動作確認済み（m4a・AAC・
>   X-Duration-Msの実測値が返る）。コンテナ内で走るのはこれと同じコード。
> - **DockerfileのHEALTHCHECKコマンドを実際に実行して確認**。
>   健全なとき exit 0、到達不能なとき exit 1、`PORT` を変えても追随することを
>   実サーバー（PORT=8791）で確認済み。
> - **compose で起きる流れをエンドツーエンドで再現して確認**。
>   起動が20秒遅れるVOICEVOXの代役を立て、(1)待機ログを出しながら待ち
>   (2)応答を検出して受付開始 (3)合成が正常動作（AAC・duration実測一致）、
>   までを通した。`depends_on` だけで healthcheck を持たせない設計が
>   実際に機能する（起動の遅れで取りこぼさない）ことの裏付け。
> - VOICEVOXが到達不能なとき、接続先URLと経過秒数を15秒ごとに出すことを確認。
>   黙って待つと `docker compose logs` で生死が判断できないため。
> - **SIGTERMで正常終了する**ことを確認（`docker stop` で10秒待たされない）。
> - ポート衝突時に原因と対処が読めるメッセージを出して exit 1 することを確認。
> - `apk add ffmpeg` で `ffprobe` も入ること（Alpine公式のパッケージ内容で確認。
>   duration実測に必要なので、ここが外れると再生時間がズレる）。
> - イメージタグ `voicevox/voicevox_engine:cpu-ubuntu22.04-0.25.2` の実在。
>   arm64/amd64両対応なのでApple Siliconでも動く。
> - 合成サーバーは外部依存ゼロ（node標準モジュールのみ）＝`npm install`不要。
> - compose.yamlの構造（depends_on参照先の実在・build文脈・ports書式）。
>
> **2026-08-31、残っていた「イメージのビルドとコンテナ間通信」も実機で確認済み**
> （WSL2 Ubuntu 24.04 / Docker 29.7.2）。もう未検証の箇所は無い。
>
> - `docker build` が通る（node:22-alpine + ffmpeg）
> - 本物の VOICEVOX 0.25.2 コンテナが起動し、合成サーバーが
>   サービス名 `voicevox:50021` で到達できる（compose のネットワーク越し）
> - HEALTHCHECK が `healthy` になる（nodeで叩く形にした修正が実際に効いている）
> - **3キャラとも本物の声で合成できた**。いずれも LINE の受理条件を満たす:
>
>   | キャラ | speakerId | HTTP | Content-Type | X-Duration-Ms | ffprobeの実尺 |
>   |---|---|---|---|---|---|
>   | たぬ姉（冥鳴ひまり） | 14 | 200 | audio/mp4 | 2784 | 2.784s |
>   | りんく（春日部つむぎ） | 8 | 200 | audio/mp4 | 2933 | 2.933s |
>   | こん太（白上虎太郎） | 32 | 200 | audio/mp4 | 2912 | 2.912s |
>
>   codec は3件とも `aac`。**X-Duration-Ms が実尺と一致**している
>   （ここがズレると LINE の再生バーが狂う）。
> - `docker compose stop` が**1秒で完了**（SIGTERMを握り潰していない証拠。
>   握り潰していれば10〜30秒のタイムアウトまで待たされる）
> - 認証も実測: 誤トークン→401、壊れたJSON→400
>
> ★ このとき入力検証のバグを2つ見つけて直した（`fix/synth-server-error-codes`）。
> 詳細は下の「入力検証」節を参照。
>
> なお、初版では alpine の wget に GNU wget 用のオプションを渡していて
> **確実に壊れる HEALTHCHECK になっていた**（BusyBox版wgetは
> `--server-response` を持たない）。curl/wgetに頼らずnodeで叩く形に直してある。
> 他人のイメージに何が入っているかを当てにしない、というのが教訓。

### 動かし方（手元でとりあえず試す）

```bash
# VOICEVOXアプリとffmpegが入っている前提
VOICE_SYNTH_TOKEN=<好きな秘密の文字列> node synth-server.mjs
```

ローカルPCで動かす場合、外から到達させるには Cloudflare Tunnel 等が要る。
ただし**PCが落ちれば止まる**ので、常用するならコンテナで常設する方がよい。

未設定なら音声機能は静かにオフになり、従来どおりテキストで返る（壊れない）。

### クレジット表記を忘れないこと

声を出す場所には必ずクレジットを添える（表記は上の「声の割り当てとクレジット表記」を参照）。
LPには記載済み。新しい掲載先を作るときも忘れないこと。

### 疎通確認

```bash
curl -D - -X POST http://localhost:8788/ \
  -H "authorization: Bearer <トークン>" \
  -H "content-type: application/json" \
  -d '{"text":"こんにちは","speakerId":14}' \
  -o out.m4a
ffprobe -v error -show_entries stream=codec_name -of default=noprint_wrappers=1 out.m4a
```

`X-Duration-Ms` ヘッダが返り、`codec_name=aac` であれば正しい。

### 入力検証 — 呼び出し側の誤りとサーバー障害を分ける

合成サーバーは受け取ったものを次のように分類する。**400と500を分けているのが肝**で、
障害が起きたときに「送った内容が悪い」のか「VOICEVOXが落ちた」のかを切り分けられる。

| 送ったもの | 返る | 意味 |
|---|---|---|
| Authorizationヘッダなし / 誤ったトークン | **401** | 認証の失敗 |
| 壊れたJSON / 配列 / null / 空の本文 | **400** | 呼び出し側の誤り |
| `text` が空・空白のみ・上限超え | **400** | 同上 |
| `speakerId` が文字列・小数・欠落 | **400** | 同上 |
| 本文が64KBを超える | **400** | 同上（接続は切らずに400を返す） |
| GETなど POST以外 | **405** | 同上 |
| VOICEVOXが応答しない / ffmpegが失敗 | **500** | **こちら側の障害** |

500が出たときだけサーバーを見に行けばよい、という切り分けができる。

**過去に踏んだ穴**（2026-08-31に実測して発見・修正済み）:

- 壊れたJSONが**500**を返していた。`JSON.parse` を合成処理と同じ `try` に
  入れていたため、呼び出し側の誤りとサーバー障害が同じ `catch` に落ちていた
- 本文が上限を超えると**レスポンスが返らなかった**（`curl` で HTTP 000）。
  `req.destroy()` で接続ごと切っていたため、呼び出し側には何も届かず
  「大きすぎた」のか「サーバーが落ちた」のかを区別できなかった。
  いまは `pause()` で受信を止め、残りを読み捨ててから400を返す

どちらも**エラーの分類を間違えると、障害調査で真っ先に迷う**種類の穴だった。

### 無言にしないこと

音声化は"おまけ"で、届くことの方が大事。以下のどれで転んでも**必ずテキストで返る**:

- 合成役が未設定 / 合成サーバーが落ちている / タイムアウト（既定15秒）
- 空レスポンス・非OKレスポンス
- R2未設定・R2への保存失敗
- replyToken失効（pushMessageに切り替わる）

この保証は `replyWithVoice()` の内部で完結させてあるので、呼び出し側が
フォールバックを書き忘れても無言にはならない。`voice-reply.test.ts` の
「無言にしないこと」がこれを固定している（20テスト）。

音声だけでなく**テキストも一緒に送る**（後から読み返せるように、
またアクセシビリティの観点からも音声のみにはしない）。
