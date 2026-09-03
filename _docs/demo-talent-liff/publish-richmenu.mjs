#!/usr/bin/env node
/**
 * リッチメニューを LINE に登録して、全友だちの既定にする。
 *
 * ★talent LP の「下のボタンはいつも出ている」を実物にする。
 *   出演情報 → デモ公演のイベント画面（LIFF）
 *   チケット → 案内メッセージ（購入は各プレイガイドなので、ここでは売らない）
 *   お問い合わせ → 受付メッセージ
 *
 * 使い方:
 *   LINE_TOKEN=xxx node publish-richmenu.mjs --dry-run   # 何をするか出すだけ
 *   LINE_TOKEN=xxx node publish-richmenu.mjs             # 実際に登録する
 *
 * ★トークンはファイルに書かない。環境変数で渡す。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');
const TOKEN = (process.env.LINE_TOKEN || '').trim();

const LIFF_ID = '2010492622-XPBsRwnD';
const EVENT_ID = 'evt-talent-demo-1123';
const W = 2500, H = 843, COL = Math.floor(W / 3);

const menu = {
  size: { width: W, height: H },
  selected: true,
  name: 'talent-demo-3btn',
  chatBarText: 'メニュー',
  areas: [
    {
      bounds: { x: 0, y: 0, width: COL, height: H },
      // ★出演情報 → 参加表明の画面へ。ここが「人数が見える」入口。
      action: { type: 'uri', label: '出演情報', uri: `https://liff.line.me/${LIFF_ID}/events/${EVENT_ID}` },
    },
    {
      bounds: { x: COL, y: 0, width: COL, height: H },
      // ★チケットは売らない（LPの方針）。案内だけ返す。
      action: { type: 'message', label: 'チケット', text: 'チケットについて教えてください' },
    },
    {
      bounds: { x: COL * 2, y: 0, width: W - COL * 2, height: H },
      action: { type: 'message', label: 'お問い合わせ', text: 'お問い合わせしたいです' },
    },
  ],
};

console.log('登録するリッチメニュー:');
console.log(`  名前: ${menu.name} / ${W}x${H} / 3分割`);
for (const a of menu.areas) {
  const act = a.action;
  console.log(`    ${String(act.label).padEnd(8)} ${act.type === 'uri' ? act.uri : `「${act.text}」`}`);
}

if (DRY) { console.log('\n--dry-run なので、ここまで。'); process.exit(0); }
if (!TOKEN) { console.error('\n★LINE_TOKEN が無い。環境変数で渡すこと。'); process.exit(2); }

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.line.me${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} が ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

// 1) メニュー本体を作る
const { richMenuId } = await api('/v2/bot/richmenu', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(menu),
});
console.log(`\n  作成: ${richMenuId}`);

// 2) 画像を上げる（★api-data.line.me。ホストが違う）
const png = readFileSync(join(HERE, 'richmenu.png'));
const up = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
  body: png,
});
if (!up.ok) throw new Error(`画像アップロードが ${up.status}: ${(await up.text()).slice(0, 200)}`);
console.log('  画像をアップロード');

// 3) 全友だちの既定にする
await api(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' });
console.log('  全友だちの既定に設定');
console.log('\n完了。LINE のトーク画面を開き直すと下部にメニューが出る。');
