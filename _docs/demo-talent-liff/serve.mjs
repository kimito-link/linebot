#!/usr/bin/env node
/**
 * タレントデモ用: LIFF の画面だけを見るための、APIモック付き静的サーバー。
 *
 * ★なぜ要るか:
 *   LIFF の画面（「3人が参加予定です」）をマネージャーさまに見せたいが、
 *   実機で動かすには LINE Developers 側で LIFF ID の発行が要る（未設定）。
 *   さらにローカルの Worker は Durable Object のマイグレーション不整合で起動しない。
 *   → **APIだけを差し替えれば、画面そのものは本物**が見られる。
 *
 *   ここで返すデータは、本番D1に実際に入っているものと同じ内容にしてある
 *   （evt-talent-demo-1123 / りんく・こん太・たぬ姉）。
 *
 * 使い方:
 *   node _docs/demo-talent-liff/serve.mjs
 *   → http://localhost:5180/events/evt-talent-demo-1123
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★dist ではなく dist-mock を配信する。
//   素の dist は liff.init() が LINE のサーバーへ問い合わせるため、
//   PC のブラウザでは LINE ログインへ飛んで画面まで到達できない
//   （2026-09-02 に実測済み。d97ca11 の記録と同じ）。
//   dist-mock は次で作る:
//     cd apps/liff && VITE_LIFF_MOCK=1 npx vite build --outDir dist-mock
const DIST = join(HERE, '../../apps/liff/dist-mock');
const PORT = 5180;

/** ★本番D1に入っているものと同じ内容 */
const EVENT = {
  id: 'evt-talent-demo-1123',
  name: '【デモ】11月23日 〇〇ホール 舞台公演',
  venue_name: '〇〇ホール',
  venue_url: null,
  image_url: null,
  description:
    '11月23日、〇〇ホールで舞台に出ます。\n' +
    'チケットは今週末から受付です。\n\n' +
    'よかったら、来られそうか教えてください。',
  description_centered: 0,
  max_bookings_per_friend: null,
  requires_approval: 0,
  cancel_deadline_hours_before: null,
};

const SLOTS = [
  {
    id: 'slot-talent-demo-1123',
    event_id: EVENT.id,
    starts_at: '2026-11-23T18:30:00.000',
    ends_at: '2026-11-23T20:30:00.000',
    capacity: null,          // ★定員は決めない（多くの公演がそう）
    remaining: null,
    active_count: 3,         // ★りんく・こん太・たぬ姉
    is_active: 1,
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const json = (res, body, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  // ── API モック ──
  if (p === `/api/liff/events/${EVENT.id}`) return json(res, EVENT);
  // ★本番は配列そのものではなく {items:[...]} を返す（実測で確認）。
  //   ここを合わせないと画面側で読めない。
  if (p === `/api/liff/events/${EVENT.id}/slots`) return json(res, { items: SLOTS });
  // 自分の予約は空（★「まだ答えていない人」の視点を見せたいので）
  if (p === '/api/liff/events/me') return json(res, { items: [] });

  // ── 静的ファイル ──
  let file = p === '/' ? '/index.html' : p;
  try {
    const buf = await readFile(join(DIST, file));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
    return res.end(buf);
  } catch {
    // SPA なので、見つからないパスは index.html を返す
    try {
      const buf = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      return res.end(buf);
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
  }
}).listen(PORT, () => {
  console.log(`  http://localhost:${PORT}/events/${EVENT.id}`);
  console.log('  ★APIはモック。画面そのものは本物の LIFF ビルド。');
});
