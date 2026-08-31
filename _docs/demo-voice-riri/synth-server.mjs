// =============================================================================
// 音声合成サーバー — Workerから呼ばれてm4a(AAC)を返す
// =============================================================================
//
// Worker（apps/worker/src/services/voice-reply.ts）との契約はこれ1本だけ:
//
//   POST /
//   Authorization: Bearer <VOICE_SYNTH_TOKEN>
//   { "text": "...", "speakerId": 14 }
//   → 200 audio/mp4 （m4aのバイト列）  ヘッダ X-Duration-Ms に再生時間(ミリ秒)
//
// この契約さえ満たせば中身は何でもよい。ここではVOICEVOX+ffmpegで実装しているが、
// クラウドTTSに載せ替えても、別のエンジンにしても、Worker側は一切変更不要。
//
// 【なぜWorkerの外なのか】
// LINEの音声メッセージは m4a(AAC) しか受理せず、Cloudflare Workers上では
// AACエンコードができない（ffmpeg.wasmは約31MBでバンドル上限10MB超、
// 実行時のWASM取得も禁止、メモリ128MB/CPU時間の制約）。
//
// 【動かし方】
//   VOICE_SYNTH_TOKEN=<好きな秘密の文字列> node synth-server.mjs
//   （VOICEVOXアプリとffmpegが必要）
//
// そのうえでWorker側に設定する:
//   npx wrangler secret put VOICE_SYNTH_TOKEN     # 上と同じ値
//   npx wrangler secret put VOICE_SYNTH_ENDPOINT  # このサーバーの公開URL
//
// ローカルPCで動かす場合は Cloudflare Tunnel 等で公開する必要がある。
// 常時稼働させたいなら、このファイルをコンテナに載せてどこかにデプロイする
// （契約が小さいので置き場所は選ばない）。

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT ?? 8788);
const VOICEVOX = process.env.VOICEVOX_URL ?? 'http://127.0.0.1:50021';
const TOKEN = process.env.VOICE_SYNTH_TOKEN;

// LINEの音声メッセージは最長1分。長文が来ても途中で切るのではなく、
// そもそも長くなりすぎないよう入力側で制限する。
const MAX_TEXT_LENGTH = 200;

if (!TOKEN) {
  console.error('VOICE_SYNTH_TOKEN が未設定です。');
  console.error('例: VOICE_SYNTH_TOKEN=your-secret node synth-server.mjs');
  process.exit(1);
}

/** VOICEVOXでwavを作る。 */
async function synthesizeWav(text, speakerId) {
  const queryRes = await fetch(
    `${VOICEVOX}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(text)}`,
    { method: 'POST' },
  );
  if (!queryRes.ok) throw new Error(`audio_query failed: ${queryRes.status}`);
  const query = await queryRes.json();

  const synthRes = await fetch(`${VOICEVOX}/synthesis?speaker=${speakerId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!synthRes.ok) throw new Error(`synthesis failed: ${synthRes.status}`);
  return Buffer.from(await synthRes.arrayBuffer());
}

/** wavをm4a(AAC)に変換し、バイト列と再生時間(ミリ秒)を返す。 */
async function wavToM4a(wav) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-'));
  const wavPath = path.join(dir, 'in.wav');
  const m4aPath = path.join(dir, 'out.m4a');
  try {
    await fs.writeFile(wavPath, wav);
    // LINEが受理するのは m4a(AAC)。faststartを付けて先頭から再生できるようにする。
    await execFileAsync('ffmpeg', [
      '-y', '-v', 'error',
      '-i', wavPath,
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '1',
      '-movflags', '+faststart',
      m4aPath,
    ]);

    const m4a = await fs.readFile(m4aPath);

    // 再生時間は推定せず実測する（LINEのシークバー表示がズレないように）。
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      m4aPath,
    ]);
    const durationMs = Math.round(Number(stdout.trim()) * 1000);

    return { m4a, durationMs };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * リクエスト本文を読む。上限を超えたら読むのをやめて例外にする。
 *
 * 接続は切らずに、pause() で受け取りを止めるだけにしてある。
 * 以前は req.destroy() で切っていたが、そうすると呼び出し側には
 * レスポンスが一切届かず（curlで HTTP 000）、「大きすぎた」のか
 * 「サーバーが落ちた」のかを区別できなかった。
 * 呼び出し側で調査するときに、この違いが効く。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      // 認証前に大きなボディを読み込まされないように上限を設ける。
      if (size > MAX_BODY_BYTES) {
        done = true;
        req.pause();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!done) reject(err); });
  });
}

const server = http.createServer(async (req, res) => {
  // ヘルスチェック用。コンテナのオーケストレータが生死を判断するためだけのもので、
  // 認証は不要にしてある（合成はしないので、ここから声を作られる心配はない）。
  // 秘密は一切返さない：状態を示す固定文字列だけ。
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  // 公開エンドポイントなので必ず認証する。
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end('Unauthorized');
    return;
  }

  // JSONの解釈は合成のtryの外で行う。
  // 中に入れると「壊れたJSONを送られた」(呼び出し側の誤り=400)と
  // 「VOICEVOXが落ちた」(こちらの障害=500)が同じcatchに落ち、
  // 障害調査のときにどちらが原因か切り分けられなくなる。
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    // 本文が大きすぎる／途中で切れた。どちらも送信側の問題。
    console.warn('[synth] bad request body:', err.message);
    // 400を書いてすぐ閉じると、送信側がまだ送っている途中の場合に
    // レスポンスが読まれないまま接続が切れることがある。
    // 残りを読み捨ててから閉じると、400が確実に相手に届く。
    req.resume();
    res.writeHead(400, { Connection: 'close' }).end('invalid request body');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[synth] malformed JSON');
    res.writeHead(400).end('malformed JSON');
    return;
  }

  if (parsed === null || typeof parsed !== 'object') {
    res.writeHead(400).end('body must be a JSON object');
    return;
  }

  try {
    const { text, speakerId } = parsed;

    if (typeof text !== 'string' || !text.trim()) {
      res.writeHead(400).end('text is required');
      return;
    }
    if (!Number.isInteger(speakerId)) {
      res.writeHead(400).end('speakerId must be an integer');
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res.writeHead(400).end(`text too long (max ${MAX_TEXT_LENGTH})`);
      return;
    }

    const wav = await synthesizeWav(text, speakerId);
    const { m4a, durationMs } = await wavToM4a(wav);

    res.writeHead(200, {
      'Content-Type': 'audio/mp4',
      'Content-Length': m4a.length,
      'X-Duration-Ms': String(durationMs),
    });
    res.end(m4a);
    console.log(`[synth] ok speaker=${speakerId} ${durationMs}ms ${m4a.length}B "${text.slice(0, 24)}..."`);
  } catch (err) {
    console.error('[synth] failed', err);
    // Worker側はnullに落としてテキストで返すので、ここで詳細を返す必要はない。
    res.writeHead(500).end('synthesis failed');
  }
});

/**
 * VOICEVOXが応答できるようになるまで待つ。
 *
 * VOICEVOXはモデル読み込みのため起動に時間がかかる（1分近くかかることもある）。
 * composeで同時に立ち上げると、こちらが先に受付を始めて最初の数リクエストを
 * 取りこぼす。それを防ぐために自前で待つ。
 *
 * compose側のhealthcheckに頼らないのは、他人のイメージにcurl/wgetが入っている
 * 保証がないため（「入っているはず」に賭けると起動しない構成になる）。
 *
 * 待てなくてもサーバー自体は起動する。合成の呼び出しはWorker側がnullに落として
 * テキストで返すので、起動を止めるより受け付けた方がまだよい。
 */
async function waitForVoicevox(timeoutMs = 180_000) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let notified = false;
  let lastReport = startedAt;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${VOICEVOX}/version`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log(`[synth] VOICEVOX 準備完了 (${(await res.text()).trim()})`);
        return true;
      }
    } catch {
      // まだ起動していないだけ。待つ。
    }
    if (!notified) {
      console.log(`[synth] VOICEVOX (${VOICEVOX}) の起動を待っています…`);
      notified = true;
      lastReport = Date.now();
    } else if (Date.now() - lastReport > 15_000) {
      // 15秒ごとに経過を出す。黙って待つと、docker compose logs を見た人が
      // 「生きているのか固まっているのか」を判断できない。
      const waited = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[synth] まだ待っています（${waited}秒経過 / 最大${Math.round(timeoutMs / 1000)}秒）`);
      lastReport = Date.now();
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.warn('[synth] VOICEVOX が時間内に応答しませんでした。受付は開始します');
  return false;
}

// 起動時の失敗は原因が一目で分かるようにする。
// 素のままだと EADDRINUSE がスタックトレースで出るだけで、
// 「何が悪いのか」「どうすればいいのか」が読み取れない。
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[synth] ポート ${PORT} は既に使われています。`);
    console.error('  既に起動していないか確認するか、PORT=別の番号 を指定してください。');
  } else if (err.code === 'EACCES') {
    console.error(`[synth] ポート ${PORT} を使う権限がありません（1024未満は要特権）。`);
  } else {
    console.error('[synth] 起動に失敗しました:', err.message);
  }
  process.exit(1);
});

// コンテナを止めるとき（docker stop / compose down）はSIGTERMが飛ぶ。
// 受け取らないと強制終了まで10秒待たされるので、受けて素直に閉じる。
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[synth] ${sig} を受け取りました。終了します`);
    server.close(() => process.exit(0));
    // 接続が残っていても待ち続けない。
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

await waitForVoicevox();

server.listen(PORT, () => {
  console.log(`音声合成サーバー: http://localhost:${PORT}`);
  console.log(`VOICEVOX: ${VOICEVOX}`);
});
