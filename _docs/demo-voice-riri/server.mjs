// 音声デモ用ローカルサーバー
// - 静的ファイル配信（index.html等）
// - VOICEVOXエンジン（127.0.0.1:50021）へのプロキシ（ブラウザCORS回避）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const VOICEVOX = 'http://127.0.0.1:50021';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wav': 'audio/wav',
  '.json': 'application/json',
};

async function proxyVoicevox(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const target = VOICEVOX + url.pathname + url.search;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('VOICEVOXエンジンに接続できませんでした: ' + e.message);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/vv/')) {
    req.url = req.url.replace(/^\/vv/, '');
    return proxyVoicevox(req, res);
  }

  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, decodeURIComponent(filePath.split('?')[0]));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + filePath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Demo server: http://localhost:${PORT}`);
  console.log(`VOICEVOX proxy: http://localhost:${PORT}/vv/*  -> ${VOICEVOX}`);
});
