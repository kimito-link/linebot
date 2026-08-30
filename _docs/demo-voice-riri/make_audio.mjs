// 録画動画に載せる音声トラックを作る
// シナリオ上 8.6秒時点でこん太の返答音声が再生される想定に合わせ、
// 冒頭に無音を挟んだ1本のwavを書き出す。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const VV = 'http://127.0.0.1:50021';
const SPEAKER_KONTA = 32; // 白上虎太郎（わーい）= こん太
const TEXT = '伸びない、イコール、ダメな投稿とは限らないよ！投稿時間とか、最初の一文でも変わることあるし、落ち込まず次いこ！';
const PLAY_AT_SEC = 8.6; // record.html の SCENARIO 'play' タイミングと一致させること
const TOTAL_SEC = 20;    // 動画全体の尺

const q = await fetch(`${VV}/audio_query?speaker=${SPEAKER_KONTA}&text=${encodeURIComponent(TEXT)}`, { method: 'POST' });
if (!q.ok) throw new Error('audio_query failed ' + q.status);
const query = await q.json();

const s = await fetch(`${VV}/synthesis?speaker=${SPEAKER_KONTA}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(query),
});
if (!s.ok) throw new Error('synthesis failed ' + s.status);
fs.writeFileSync('voice_konta.wav', Buffer.from(await s.arrayBuffer()));
console.log('synthesized voice_konta.wav');

// 冒頭に無音を足して、全体尺に合わせる
execFileSync('ffmpeg', [
  '-y',
  '-f', 'lavfi', '-t', String(PLAY_AT_SEC), '-i', 'anullsrc=r=24000:cl=mono',
  '-i', 'voice_konta.wav',
  '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[a];[a]apad[out]',
  '-map', '[out]', '-t', String(TOTAL_SEC),
  '-ar', '44100', '-ac', '2',
  'demo_audio.wav',
], { stdio: 'inherit' });

console.log('wrote demo_audio.wav');
