#!/usr/bin/env node
/**
 * タレント事務所さま向けデモの土台を作る。
 *
 * ★なぜ要るか: マネージャーさまに見せる画面が、データが無いと何も映らない。
 *   talent LP（kimitotalk.link/talent）が「実際の画面です」として見せている
 *   「11月23日、〇〇ホール」の告知と、3人の参加表明を実物として用意する。
 *
 * 使い方:
 *   node scripts/seed-talent-demo.mjs --dry-run   # 出すだけ（DBは触らない）
 *   node scripts/seed-talent-demo.mjs --sql       # 実行するSQLを出す
 *
 * ★このスクリプト自体はDBに書かない。SQLを出すだけにしてある。
 *   本番DBへの書き込みは wrangler 経由で人が確認してから流す（事故防止）。
 */
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

/** Kimito-Link Project（本番D1で確認済み） */
const ACCOUNT_ID = 'f0e13880-f6a7-4462-9fc4-979a2e9c5062';

/** ★LP の絵と揃える。「11月23日、〇〇ホールで舞台に出ます」 */
const EVENT = {
  id: 'evt-talent-demo-1123',
  name: '【デモ】11月23日 〇〇ホール 舞台公演',
  venue_name: '〇〇ホール（デモ）',
  description:
    'こちらは、動きをご覧いただくためのデモです。\n' +
    '実際の公演ではありません。\n\n' +
    '「行けそうかどうか」を選ぶと、その場で人数に反映されます。',
  // ★定員は決めない。多くの公演がそうであり、
  //   「定員なし」ではなく「◯人が参加」と出ることを見せたいため。
  reminder_day_before_enabled: 1,
  is_published: 1,
};

/** 1公演=1スロット。開演18:30〜20:30 想定 */
const SLOT = {
  id: 'slot-talent-demo-1123',
  starts_at: '2026-11-23T18:30:00.000',
  ends_at: '2026-11-23T20:30:00.000',
};

/**
 * 3人の参加表明。
 * ★りんく=気づく側 / こん太=説明する側 / たぬ姉=まとめる側（世界観の正本）。
 *   LP の3択（行きます / 行けたら行きます / 今回は難しそう）を
 *   全部見せたいので、答えを散らす。
 */
const CAST = [
  { key: 'rinku',   name: 'りんく',  status: 'confirmed', note: '行きます！楽しみにしてます' },
  { key: 'konta',   name: 'こん太',  status: 'requested', note: '行けたら行きます（仕事の都合次第）' },
  { key: 'tanunee', name: 'たぬ姉',  status: 'confirmed', note: '行きます。前日にまた確認しますね' },
];

/**
 * デモ用の友だち3件。
 *
 * ★実在の方のレコードは使わない。
 *   doin-challenge.com で「最新のユーザーを自動で選ぶ」実装にしたところ、
 *   **実在の他人のアカウントとしてログインし、その人の表示名で録画してしまった**
 *   事故がある（2026-09-02）。同じことを繰り返さない。
 *   line_user_id に demo- の接頭辞を付け、実データと必ず区別できるようにする。
 */
const DEMO_FRIENDS = CAST.map((c) => ({
  id: `friend-talent-demo-${c.key}`,
  line_user_id: `demo-talent-${c.key}`,
  display_name: c.name,
}));

const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString().replace('Z', '');

const sql = [
  `-- ★Kimito-Link Project のデモデータ（削除は id で消せる）`,
  `DELETE FROM event_bookings WHERE event_id = ${q(EVENT.id)};`,
  `DELETE FROM event_slots    WHERE event_id = ${q(EVENT.id)};`,
  `DELETE FROM events         WHERE id       = ${q(EVENT.id)};`,
  ``,
  `INSERT INTO events (id, line_account_id, name, venue_name, description,` +
    ` reminder_day_before_enabled, is_published, created_at, updated_at)`,
  `VALUES (${q(EVENT.id)}, ${q(ACCOUNT_ID)}, ${q(EVENT.name)}, ${q(EVENT.venue_name)},` +
    ` ${q(EVENT.description)}, ${EVENT.reminder_day_before_enabled}, ${EVENT.is_published},` +
    ` ${q(now)}, ${q(now)});`,
  ``,
  `INSERT INTO event_slots (id, event_id, starts_at, ends_at, is_active, created_at, updated_at)`,
  `VALUES (${q(SLOT.id)}, ${q(EVENT.id)}, ${q(SLOT.starts_at)}, ${q(SLOT.ends_at)}, 1, ${q(now)}, ${q(now)});`,
  ``,
  `-- デモ用の友だち（line_user_id が demo- で始まるので実データと区別できる）`,
  ...DEMO_FRIENDS.map(
    (f) =>
      `INSERT OR REPLACE INTO friends (id, line_user_id, display_name, is_following, line_account_id, created_at, updated_at)` +
      ` VALUES (${q(f.id)}, ${q(f.line_user_id)}, ${q(f.display_name)}, 1, ${q(ACCOUNT_ID)}, ${q(now)}, ${q(now)});`,
  ),
  ``,
  `-- 参加表明`,
  ...CAST.map((c, i) => {
    const f = DEMO_FRIENDS[i];
    return (
      `INSERT INTO event_bookings (id, line_account_id, event_id, slot_id, friend_id, status, customer_note, requested_at, created_at, updated_at)` +
      ` VALUES (${q('bk-talent-demo-' + c.key)}, ${q(ACCOUNT_ID)}, ${q(EVENT.id)}, ${q(SLOT.id)},` +
      ` ${q(f.id)}, ${q(c.status)}, ${q(c.note)}, ${q(now)}, ${q(now)}, ${q(now)});`
    );
  }),
  ``,
];

console.log('作るもの:');
console.log(`  イベント: ${EVENT.name}`);
console.log(`    会場 ${EVENT.venue_name} / 開演 ${SLOT.starts_at.slice(0, 16).replace('T', ' ')}`);
console.log(`    ★定員は決めない（「定員なし」ではなく「◯人が参加」と出るのを見せる）`);
console.log('  参加表明:');
for (const c of CAST) {
  const label = c.status === 'confirmed' ? '行きます' : '行けたら行きます';
  console.log(`    ${c.name.padEnd(4)} ${label.padEnd(9)} 「${c.note}」`);
}
const going = CAST.filter((c) => c.status === 'confirmed' || c.status === 'requested').length;
console.log(`  → 画面には「${going}人が参加予定です」と出る`);

if (DRY) {
  console.log('\n--dry-run なので、SQL は出しません。');
  process.exit(0);
}

console.log('\n--- ここから SQL（friends は実データを使うので別途） ---\n');
console.log(sql.join('\n'));
console.log(`-- ★デモを消すとき:`);
console.log(`--   DELETE FROM event_bookings WHERE event_id = ${q(EVENT.id)};`);
console.log(`--   DELETE FROM event_slots WHERE event_id = ${q(EVENT.id)};`);
console.log(`--   DELETE FROM events WHERE id = ${q(EVENT.id)};`);
console.log(`--   DELETE FROM friends WHERE line_user_id LIKE 'demo-talent-%';`);
