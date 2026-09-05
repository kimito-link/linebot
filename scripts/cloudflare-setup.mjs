#!/usr/bin/env node
/**
 * Cloudflare の設定（メール受信 / 配線図の鍵）を API で行う。
 *
 * 【★手元では動かない】
 * このスクリプトは GitHub Actions の中で動かす前提。
 * トークンは GitHub Secrets にあり読み出せないが、workflow の中でだけ使える。
 * こうすると**トークンの値を誰の目にも触れさせずに**設定できる。
 *
 * 【★まず check】
 * いきなり設定を変えない。check は読み取りだけを行い、
 * 「そのトークンで何ができるか」を先に確かめる。
 *
 * 【★トークンの値を出力しない】
 * エラー本文にトークンが混ざる可能性があるので、出す前に必ず伏せる。
 */

const TOKEN = process.env.CF_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT;
const MODE = process.env.MODE || 'check';
const ZONE_NAME = process.env.ZONE_NAME || 'kimitotalk.link';
const EMAIL_LOCAL = (process.env.EMAIL_LOCAL || 'notify').trim();
const WORKER_NAME = (process.env.WORKER_NAME || '').trim();
const ACCESS_EMAILS = (process.env.ACCESS_EMAILS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error('✗ CLOUDFLARE_API_TOKEN が渡っていません');
  process.exit(1);
}

/** ★ログにトークンを出さない。 */
const redact = (s) => String(s).split(TOKEN).join('***REDACTED***');

async function cf(path, init = {}) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok && json.success !== false, status: res.status, json };
}

function report(label, r) {
  if (r.ok) return true;
  const errs = r.json?.errors || [];
  const msgs = errs.map((e) => `${e.code}: ${e.message ?? JSON.stringify(e)}`).join(' / ');
  console.log(`  ✗ ${label} — ${redact(msgs || r.status)}`);
  // ★message が undefined で返ることがある（Access API）。原因を追えるよう全文も出す。
  //   トークンは redact 済み。
  if (!msgs || msgs.includes('undefined')) {
    console.log(`    詳細: ${redact(JSON.stringify(r.json).slice(0, 600))}`);
  }
  return false;
}

// ── ゾーンを見つける ────────────────────────────────
async function findZone() {
  const r = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  if (!r.ok) { report('ゾーン検索', r); return null; }
  const zone = (r.json.result || [])[0];
  if (!zone) {
    console.log(`  ✗ ${ZONE_NAME} が見つからない（トークンにZone権限が無いか、別アカウント）`);
    return null;
  }
  return zone;
}

// ── check: 何ができるかを確かめる（変更しない） ────
async function check() {
  console.log('■ トークンでできることを確認します（変更はしません）\n');

  const v = await cf('/user/tokens/verify');
  console.log(`トークン: ${v.ok ? '有効' : '無効'}`);

  const zones = await cf('/zones?per_page=50');
  const list = zones.json?.result || [];
  console.log(`見えるゾーン: ${list.length}件`);
  if (list.length) console.log(`  ${list.map((z) => z.name).slice(0, 10).join(', ')}`);

  const zone = list.find((z) => z.name === ZONE_NAME);
  if (!zone) {
    console.log(`\n✗ ${ZONE_NAME} が見えません。Zone→Zone→Read が要ります。`);
    process.exit(1);
  }
  console.log(`\n対象ゾーン: ${zone.name}`);

  // Email Routing
  const er = await cf(`/zones/${zone.id}/email/routing`);
  if (er.ok) {
    console.log(`  Email Routing: ${er.json.result?.enabled ? '有効' : '無効（これから有効化できます）'}`);
  } else {
    report('Email Routing の状態', er);
  }

  const rules = await cf(`/zones/${zone.id}/email/routing/rules`);
  if (rules.ok) {
    const rs = rules.json.result || [];
    console.log(`  受信ルール: ${rs.length}件`);
    for (const r of rs.slice(0, 5)) {
      const to = (r.matchers || []).map((m) => m.value).join(',');
      const act = (r.actions || []).map((a) => `${a.type}:${(a.value || []).join(',')}`).join(' ');
      console.log(`    - ${to} → ${act}`);
    }
  } else {
    report('受信ルールの取得（Email Routing Rules→Read/Edit が要る）', rules);
  }

  // Workers（メールの宛先に指定するため）
  if (ACCOUNT) {
    const w = await cf(`/accounts/${ACCOUNT}/workers/scripts`);
    if (w.ok) {
      const names = (w.json.result || []).map((s) => s.id);
      console.log(`  Worker: ${names.length}件 ${names.slice(0, 8).join(', ')}`);
    } else {
      report('Workers一覧（Workers Scripts→Read が要る）', w);
    }
  }

  // Access
  // ★読めるだけでは足りない。作れるかどうかまで確かめる。
  //   実測(2026-09-05): 一覧はGETできるのに POST は 1010 auth.forbidden だった。
  //   「見えている＝編集できる、ではない」をここで検出する。
  if (ACCOUNT) {
    const a = await cf(`/accounts/${ACCOUNT}/access/apps`);
    if (a.ok) {
      const apps = a.json.result || [];
      console.log(`  Access アプリ(読み取り): ${apps.length}件`);
      for (const app of apps.slice(0, 5)) console.log(`    - ${app.name} (${app.domain})`);

      // 実際に作って消して、書き込めるかを確かめる
      const probeDomain = `${ZONE_NAME}/__perm_probe_${Date.now()}`;
      const made = await cf(`/accounts/${ACCOUNT}/access/apps`, {
        method: 'POST',
        body: JSON.stringify({
          name: '権限確認用（すぐ消します）',
          domain: probeDomain,
          type: 'self_hosted',
          session_duration: '1h',
        }),
      });
      if (made.ok) {
        console.log('  Access 書き込み: できる');
        const id = made.json.result?.id;
        if (id) {
          const del = await cf(`/accounts/${ACCOUNT}/access/apps/${id}`, { method: 'DELETE' });
          console.log(del.ok
            ? '  （確認用に作ったものは削除しました）'
            : `  ★確認用のものを削除できませんでした。手で消してください: ${probeDomain}`);
        }
      } else {
        report('Access 書き込み（Account→Access: Apps and Policies→Edit が要る）', made);
      }
    } else {
      report('Access 読み取り', a);
    }
  }

  console.log('\n■ 上に ✗ が無ければ、そのまま設定に進めます。');
}

// ── メール受信を設定する ────────────────────────────
async function setupEmailRouting() {
  const zone = await findZone();
  if (!zone) process.exit(1);

  if (!WORKER_NAME) {
    console.error('✗ Worker名が分かりません（worker_name を入れるか vars.WORKER_NAME を設定）');
    process.exit(1);
  }

  console.log(`■ ${EMAIL_LOCAL}@${ZONE_NAME} → Worker「${WORKER_NAME}」\n`);

  // 1) Email Routing を有効化（MX等のDNSも Cloudflare 側が用意する）
  const st = await cf(`/zones/${zone.id}/email/routing`);
  if (st.ok && st.json.result?.enabled) {
    console.log('  Email Routing: すでに有効');
  } else {
    const en = await cf(`/zones/${zone.id}/email/routing/enable`, { method: 'POST', body: '{}' });
    if (!report('Email Routing の有効化', en)) process.exit(1);
    console.log('  Email Routing: 有効にしました');
  }

  // 2) 受信ルールを作る（同じアドレスが既にあれば作らない）
  const existing = await cf(`/zones/${zone.id}/email/routing/rules`);
  const address = `${EMAIL_LOCAL}@${ZONE_NAME}`;
  const already = (existing.json?.result || []).find((r) =>
    (r.matchers || []).some((m) => m.value === address));

  if (already) {
    console.log(`  受信ルール: ${address} は既にあります（作り直しません）`);
  } else {
    const created = await cf(`/zones/${zone.id}/email/routing/rules`, {
      method: 'POST',
      body: JSON.stringify({
        name: `${address} → ${WORKER_NAME}`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: address }],
        actions: [{ type: 'worker', value: [WORKER_NAME] }],
      }),
    });
    if (!report('受信ルールの作成', created)) process.exit(1);
    console.log(`  受信ルール: ${address} → ${WORKER_NAME} を作りました`);
  }

  console.log('\n✓ 完了。このアドレス宛のメールが Worker に届きます。');
  console.log(`  次: 各サービスの通知先を ${address} に変えてください。`);
}

// ── 配線図に鍵をかける ──────────────────────────────
async function setupAccess() {
  if (!ACCOUNT) { console.error('✗ CLOUDFLARE_ACCOUNT_ID が要ります'); process.exit(1); }
  if (ACCESS_EMAILS.length === 0) {
    console.error('✗ access_emails が空です。入れる人のメールアドレスを指定してください。');
    process.exit(1);
  }

  const domain = `${ZONE_NAME}/line-root`;
  console.log(`■ ${domain} に鍵をかけます\n`);
  console.log(`  入れる人: ${ACCESS_EMAILS.join(', ')}`);

  // ★同じものが既にあれば作らない（二重にすると挙動が読めなくなる）
  const list = await cf(`/accounts/${ACCOUNT}/access/apps`);
  if (!report('Access アプリ一覧', list)) process.exit(1);
  const dup = (list.json.result || []).find((a) => a.domain === domain);
  if (dup) {
    console.log(`\n  すでに設定済みです（${dup.name}）。作り直しません。`);
    return;
  }

  const app = await cf(`/accounts/${ACCOUNT}/access/apps`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'LINE導線の地図',
      // ★path を必ず付ける。空にするとサイト全体が鍵の内側に入り、
      //   お客様がLPを見られなくなる。
      domain,
      type: 'self_hosted',
      session_duration: '24h',
    }),
  });
  if (!report('Access アプリの作成', app)) process.exit(1);
  const appId = app.json.result.id;
  console.log('  アプリを作りました');

  const policy = await cf(`/accounts/${ACCOUNT}/access/apps/${appId}/policies`, {
    method: 'POST',
    body: JSON.stringify({
      name: '許可した人だけ',
      decision: 'allow',
      include: ACCESS_EMAILS.map((email) => ({ email: { email } })),
    }),
  });
  if (!report('ポリシーの作成', policy)) process.exit(1);

  console.log('\n✓ 完了。シークレットウィンドウで開くとログイン画面が出ます。');
  console.log(`  https://${ZONE_NAME}/line-root/`);
}

const run = { check, 'email-routing': setupEmailRouting, access: setupAccess }[MODE];
if (!run) { console.error(`✗ 知らない mode: ${MODE}`); process.exit(1); }
run().catch((err) => {
  console.error('✗', redact(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
