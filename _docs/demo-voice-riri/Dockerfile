# =============================================================================
# 音声合成サーバー — Workerから呼ばれてm4a(AAC)を返す
# =============================================================================
#
# VOICEVOXエンジンは公式イメージを別コンテナで動かし、こちらはそれを叩いて
# ffmpegでm4a化する役に徹する（compose.yamlが両者をつなぐ）。
# 分けてあるのは、VOICEVOXを新しい版に上げるときにこちらを作り直さずに済むから。
#
# ビルド:  docker build -t voice-synth .
# 単体起動: docker run -p 8788:8788 -e VOICE_SYNTH_TOKEN=xxx \
#             -e VOICEVOX_URL=http://host.docker.internal:50021 voice-synth
# 通常は compose.yaml から起動する。

FROM node:22-alpine

# m4a(AAC)への変換と再生時間の実測に使う。
RUN apk add --no-cache ffmpeg

WORKDIR /app

# 依存パッケージは無し（Node標準モジュールだけで動く）。
# package.jsonはtype:moduleを宣言するためだけに置く。
COPY package.json ./
COPY synth-server.mjs ./

# rootで動かす必要がないので専用ユーザーに落とす。
USER node

ENV PORT=8788
EXPOSE 8788

# コンテナの生死をオーケストレータが判断できるようにする。
#
# curl/wgetに頼らずnodeで叩く。alpineのwgetはBusyBox版で --server-response 等の
# GNU wget向けオプションを持たず、curlも既定では入っていない。
# nodeは必ずこのイメージにあるので、依存を増やさずに済む。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "synth-server.mjs"]
