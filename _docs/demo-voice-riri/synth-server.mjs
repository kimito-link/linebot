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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      // 認証前に大きなボディを読み込まされないように上限を設ける。
      if (size > 64 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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

  try {
    const raw = await readBody(req);
    const { text, speakerId } = JSON.parse(raw);

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
  const deadline = Date.now() + timeoutMs;
  let notified = false;
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
      console.log('[synth] VOICEVOX の起動を待っています…');
      notified = true;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.warn('[synth] VOICEVOX が時間内に応答しませんでした。受付は開始します');
  return false;
}

await waitForVoicevox();

server.listen(PORT, () => {
  console.log(`音声合成サーバー: http://localhost:${PORT}`);
  console.log(`VOICEVOX: ${VOICEVOX}`);
});
