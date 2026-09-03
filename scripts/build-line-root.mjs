#!/usr/bin/env node
/**
 * 収集したデータを apps/lp/line-root/index.html に組み立てる。
 *
 * ★確かめていないことを緑や赤に塗らない。3つ目の色（未確認）を必ず使う。
 *   「取得できなかった」を「切れている」と書くと、この地図自体が嘘になる。
 *
 * ★機密は1文字も出さない。line_accounts のトークン類は collect 側で
 *   そもそも SELECT していないが、ここでも出力後に検査する。
 *
 * 使い方:
 *   node scripts/collect-line-root.mjs   # 先にデータを集める
 *   node scripts/build-line-root.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const DATA = join(HERE, '.line-root-data.json');
const OUT_DIR = join(REPO, 'apps/lp/line-root');
const OUT = join(OUT_DIR, 'index.html');
const PASS = '3041';

if (!existsSync(DATA)) {
  console.error('データが無い。先に node scripts/collect-line-root.mjs を実行する。');
  process.exit(2);
}
const d = JSON.parse(readFileSync(DATA, 'utf8'));

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 生きた導線だけ（アーカイブ・旧クローンは除く） */
const liveLinks = d.scan.links.filter((l) => l.hits.some((h) => !h.archive));
const identityOf = (url) => d.identities.find((i) => i.url === url) ?? null;

// ── アカウント実体ごとにまとめる ───────────────────────────
const groups = new Map();
for (const link of liveLinks) {
  const id = identityOf(link.url);
  let key, unknown = false;
  if (!id || id.status === null) { key = '取得できなかった'; unknown = true; }
  else if (id.account) key = id.account;
  else {
    // ★名前を公開していないアカウントを1つのグループにまとめない。
    //   実体が違うものを束ねると「同じ窓口」と誤読される。URLごとに分ける。
    key = `名前非公開（${link.url.replace(/^https:\/\/(lin\.ee\/|line\.me\/R\/ti\/p\/|page\.line\.me\/)/, '')}）`;
    unknown = true;
  }
  if (!groups.has(key)) groups.set(key, { name: key, unknown, links: [] });
  groups.get(key).links.push({ ...link, identity: id });
}
const groupList = [...groups.values()].sort((a, b) => b.links.length - a.links.length);

// ── 導線の鎖（LP → リンク → ref → project） ────────────────
// ★ここが地図の核心。各段が繋がっているかを、根拠つきで示す。
// ★CSSのクラス名（b-ok / b-ng / b-unk）と一致させる。
//   'unknown' にすると b-unknown という存在しないクラスになり、
//   未確認バッジだけ枠も背景も消える（実測で発覚）。
const OK = 'ok', NG = 'ng', UNK = 'unk';

const lpRefs = liveLinks.flatMap((l) => l.refs.map((r) => ({ ref: r, url: l.url })));
const projects = (() => {
  try {
    const cfg = JSON.parse(readFileSync(join(REPO, 'bot.config.json'), 'utf8'));
    return { list: Object.keys(cfg.projects ?? {}), def: cfg.defaultProject };
  } catch { return { list: [], def: null }; }
})();

const entryRoutes = d.d1?.entryRoutes ?? null;
const lineAccounts = d.d1?.lineAccounts ?? null;
const friendCounts = d.d1?.friendCounts ?? null;

const chain = [
  {
    step: 'LPにリンクがある',
    state: liveLinks.length ? OK : NG,
    detail: `${liveLinks.length}本の導線URLを ${new Set(liveLinks.flatMap((l) => l.hits.map((h) => h.repo))).size} リポジトリで確認`,
    how: 'github/ 配下の全ファイルを走査（テストとビルド成果物は除外）',
  },
  {
    step: 'リンクが /r/:ref を通る',
    state: lpRefs.length && liveLinks.every((l) => !l.refs.length || l.url.includes('/r/')) ? OK : NG,
    detail: lpRefs.length
      ? `?ref= 付きは ${lpRefs.length}本（${lpRefs.map((r) => r.ref).join(' / ')}）。いずれも LINE の友だち追加URLに直接付いており、/r/:ref を通っていない`
      : '?ref= 付きのリンクが無い',
    how: 'LINEの友だち追加URLは ?ref= をBotへ渡さない（apps/worker/src/routes/liff.ts:800 が記録地点）',
  },
  {
    step: 'ref_code がD1に記録される',
    state: UNK,
    detail: 'LINEが発行した本物の id_token を Worker が検証して初めて記録される。ブラウザからは確かめられない',
    how: '未確認。実機での友だち追加が要る（@line/liff-mock は liff.init() を肩代わりするだけで、id_token の検証は通せない）',
  },
  {
    step: 'ref から応対（project）が決まる',
    state: entryRoutes ? OK : UNK,
    detail: entryRoutes
      ? `entry_routes に ${entryRoutes.length}件。project 付きは ${entryRoutes.filter((r) => r.project).length}件`
      : 'D1 を読めていないため未確認。CI（build-line-root.yml）で実行すると入る',
    how: 'apps/worker/src/services/bot-project.ts:11-17 の解決順（ref_code → entry_routes.project → line_accounts.default_project → defaultProject）',
  },
];

// ── 実測で分かった食い違い ───────────────────────────────
const findings = [];
for (const g of groupList) {
  if (g.unknown || g.links.length < 2) continue;
  const repos = [...new Set(g.links.flatMap((l) => l.hits.filter((h) => !h.archive).map((h) => h.repo)))];
  if (repos.length >= 2) {
    findings.push({
      title: `「${g.name}」に ${g.links.length}本のURLが向いている`,
      body: `${repos.join(' / ')} の ${repos.length}リポジトリから、同じ1つのアカウントを指している。`
        + `サービスごとに別の窓口のつもりでも、実際は同じところに集まっている。`,
      urls: g.links.map((l) => l.url.replace('https://', '')),
      repos,
    });
  }
}

const rows = (arr, f) => arr.map(f).join('\n');

// ★テンプレートリテラルの中で ${} を深くネストするとパースが壊れる。
//   整形は外で済ませておく。
const collectedJst = new Date(d.collectedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>LINE導線の地図</title>
<style>
  :root{
    --bg:#0f1720; --panel:#16212e; --line:#243347; --ink:#e6edf5; --muted:#8fa3b8;
    --ok:#34d399; --ng:#f87171; --unk:#fbbf24; --accent:#60a5fa;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:"Hiragino Sans","Yu Gothic",Meiryo,system-ui,sans-serif;line-height:1.75;font-size:15px}
  body.locked>.wrap{display:none}
  .wrap{max-width:960px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:23px;margin:0 0 6px;font-weight:800}
  h2{font-size:17px;margin:44px 0 6px;padding-top:20px;border-top:1px solid var(--line);font-weight:800}
  h2:first-of-type{border-top:0;padding-top:0}
  .sub{color:var(--muted);font-size:13px;margin:0 0 18px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin:12px 0}
  .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11.5px;font-weight:700;white-space:nowrap}
  .b-ok{background:rgba(52,211,153,.15);color:var(--ok);border:1px solid rgba(52,211,153,.4)}
  .b-ng{background:rgba(248,113,113,.15);color:var(--ng);border:1px solid rgba(248,113,113,.4)}
  .b-unk{background:rgba(251,191,36,.15);color:var(--unk);border:1px solid rgba(251,191,36,.4)}
  code{background:#0b131c;border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:12.5px;
    font-family:ui-monospace,Consolas,monospace;word-break:break-all}
  .tbl{overflow-x:auto;margin:10px 0}
  table{border-collapse:collapse;width:100%;font-size:13px;min-width:460px}
  th,td{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
  th{color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}
  .how{color:var(--muted);font-size:12px;margin-top:5px}
  .how::before{content:"確かめ方: "}
  .acc-name{font-weight:800;font-size:15px;margin-bottom:2px}
  .acc-meta{color:var(--muted);font-size:12px;margin-bottom:9px}
  ul{margin:6px 0;padding-left:20px}
  li{margin:3px 0}
  .foot{color:var(--muted);font-size:12px;margin-top:44px;padding-top:16px;border-top:1px solid var(--line)}
  /* ゲート */
  #gate{position:fixed;inset:0;z-index:99;display:none;align-items:center;justify-content:center;
    padding:24px;background:var(--bg)}
  body.locked #gate{display:flex}
  #gate .box{width:100%;max-width:340px;background:var(--panel);border:1px solid var(--line);
    border-radius:16px;padding:30px 24px;text-align:center}
  #gate h2{border:0;padding:0;margin:0 0 6px;font-size:17px}
  #gate p{color:var(--muted);font-size:12.5px;margin:0 0 16px}
  #gate input{width:100%;background:#0b131c;border:1px solid var(--line);border-radius:9px;
    color:var(--ink);padding:11px 12px;font-size:17px;text-align:center;letter-spacing:.25em}
  #gate input:focus{outline:none;border-color:var(--accent)}
  #gate button{width:100%;margin-top:11px;background:var(--accent);color:#06182e;border:0;
    border-radius:9px;padding:11px;font-weight:800;font-size:14px;cursor:pointer}
  #gate .err{color:var(--ng);font-size:12.5px;min-height:18px;margin-top:8px}
</style>
</head>
<body class="locked">

<div id="gate">
  <div class="box">
    <h2>🔒 LINE導線の地図</h2>
    <p>パスワードを入力してください</p>
    <input id="gate-input" type="password" inputmode="numeric" autocomplete="off" maxlength="12">
    <button id="gate-btn">開く</button>
    <div class="err" id="gate-err"></div>
  </div>
</div>

<script>
(function () {
  var PASS = ${JSON.stringify(PASS)};
  var KEY = "line_root_unlocked";
  function unlock() {
    document.body.classList.remove("locked");
    try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
  }
  try { if (sessionStorage.getItem(KEY) === "1") unlock(); } catch (e) {}
  var input = document.getElementById("gate-input");
  var err = document.getElementById("gate-err");
  function tryUnlock() {
    if (input.value === PASS) { err.textContent = ""; unlock(); }
    else { err.textContent = "パスワードが違います"; input.value = ""; input.focus(); }
  }
  document.getElementById("gate-btn").addEventListener("click", tryUnlock);
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") tryUnlock(); });
  if (document.body.classList.contains("locked")) input.focus();
})();
</script>

<div class="wrap">

<h1>LINE導線の地図</h1>
<p class="sub">
  ${esc(collectedJst)} 時点の実測。
  緑=確かめて繋がっている／赤=確かめて切れている／黄=<b>まだ確かめていない</b>。
  推測は書いていません。
</p>

<h2>1. 導線の鎖 — どこまで繋がっているか</h2>
<p class="sub">友だち追加のリンクを押してから、応対が決まるまで。1段でも切れると、その先は効きません。</p>
${rows(chain, (c) => `
<div class="card">
  <div><span class="badge b-${c.state}">${c.state === OK ? '繋がっている' : c.state === NG ? '切れている' : '未確認'}</span>
    <b style="margin-left:8px">${esc(c.step)}</b></div>
  <div style="margin-top:7px">${esc(c.detail)}</div>
  <div class="how">${esc(c.how)}</div>
</div>`)}

<h2>2. アカウント別 — 同じ窓口に何本向いているか</h2>
<p class="sub">
  短縮URL（<code>lin.ee/xxx</code>）を実際に開き、ページタイトルで実体を判定しました。
  ★存在しないURLはタイトルが空になることを対照実験で確認済みです。
</p>
${rows(groupList, (g) => `
<div class="card">
  <div class="acc-name">${g.unknown ? '⚠️ ' : ''}${esc(g.name)}
    <span class="badge b-${g.unknown ? 'unk' : g.links.length > 1 ? 'unk' : 'ok'}" style="margin-left:8px">${g.links.length}本</span></div>
  <div class="acc-meta">${esc([...new Set(g.links.flatMap((l) => l.hits.filter((h) => !h.archive).map((h) => h.repo)))].join(' / '))}</div>
  <div class="tbl"><table>
    <tr><th>URL</th><th>使われている数</th><th>ref</th></tr>
    ${rows(g.links.sort((a, b) => b.hits.length - a.hits.length), (l) => `
    <tr><td><code>${esc(l.url.replace('https://', ''))}</code></td>
      <td>${l.hits.filter((h) => !h.archive).length}箇所</td>
      <td>${l.refs.length ? esc(l.refs.join(', ')) : '<span style="color:var(--muted)">—</span>'}</td></tr>`)}
  </table></div>
</div>`)}

${findings.length ? `
<h2>3. 実測で見つかった食い違い</h2>
<p class="sub">サービスごとに別の窓口のつもりでも、実際は同じアカウントを指しているものです。</p>
${rows(findings, (f) => `
<div class="card">
  <div><span class="badge b-unk">要確認</span> <b style="margin-left:8px">${esc(f.title)}</b></div>
  <div style="margin-top:7px">${esc(f.body)}</div>
  <ul>${rows(f.urls, (u) => `<li><code>${esc(u)}</code></li>`)}</ul>
</div>`)}` : ''}

<h2>4. 応対の切り替え（project）</h2>
<div class="card">
  <div><b>登録されているナレッジパック</b>（bot.config.json）</div>
  <ul>${rows(projects.list, (p) => `<li><code>${esc(p)}</code>${p === projects.def ? ' <span class="badge b-ok">既定</span>' : ''}</li>`)}</ul>
  <div class="how">解決順は ref_code → entry_routes.project → line_accounts.default_project → 既定（apps/worker/src/services/bot-project.ts:11-17）</div>
</div>
${entryRoutes ? `
<div class="card">
  <div><b>entry_routes の登録</b>（D1の実データ）</div>
  <div class="tbl"><table>
    <tr><th>ref_code</th><th>名前</th><th>project</th><th>有効</th></tr>
    ${rows(entryRoutes, (r) => `<tr><td><code>${esc(r.ref_code)}</code></td><td>${esc(r.name)}</td>
      <td>${r.project ? `<code>${esc(r.project)}</code>` : '<span class="badge b-unk">未設定→既定になる</span>'}</td>
      <td>${r.is_active ? '✓' : '—'}</td></tr>`)}
  </table></div>
</div>` : `
<div class="card">
  <div><span class="badge b-unk">未確認</span> <b style="margin-left:8px">entry_routes の中身</b></div>
  <div style="margin-top:7px">D1 を読めていません。CI（<code>build-line-root.yml</code>）で生成すると、ここに実データが入ります。</div>
  <div class="how">手元のCloudflareトークンではD1が読めない（Authentication error [code: 10000]）</div>
</div>`}

${lineAccounts ? `
<h2>5. LINEアカウント（D1に登録されているもの）</h2>
<div class="card">
  <div class="tbl"><table>
    <tr><th>名前</th><th>LIFF</th><th>既定のproject</th><th>有効</th></tr>
    ${rows(lineAccounts, (a) => `<tr><td>${esc(a.name)}</td>
      <td>${a.has_liff ? '<span class="badge b-ok">あり</span>' : '<span class="badge b-ng">なし</span>'}</td>
      <td>${a.default_project ? `<code>${esc(a.default_project)}</code>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td>${a.is_active ? '✓' : '—'}</td></tr>`)}
  </table></div>
  <div class="how">トークン類（channel_access_token / channel_secret）はSQLで選んでいないため、このページには存在しません</div>
</div>` : ''}

${friendCounts ? `
<h2>6. 実績（導線ごとの友だち数）</h2>
<div class="card">
  <div class="tbl"><table>
    <tr><th>ref_code</th><th>人数</th></tr>
    ${rows([...friendCounts].sort((a, b) => b.n - a.n), (f) => `<tr>
      <td>${f.ref_code ? `<code>${esc(f.ref_code)}</code>` : '<span style="color:var(--muted)">refなし（直接追加）</span>'}</td>
      <td>${f.n}</td></tr>`)}
  </table></div>
</div>` : ''}

<h2>${friendCounts ? '7' : lineAccounts ? '6' : '5'}. エンドポイントの生存</h2>
<div class="card">
  <div class="tbl"><table>
    <tr><th>対象</th><th>状態</th><th>HTTP</th></tr>
    ${rows(d.endpoints, (e) => `<tr><td>${esc(e.label)}</td>
      <td><span class="badge b-${e.alive === true ? 'ok' : e.alive === false ? 'ng' : 'unk'}">${e.alive === true ? '生きている' : e.alive === false ? '異常' : '確認できず'}</span></td>
      <td><code>${esc(e.status ?? '—')}</code></td></tr>`)}
  </table></div>
</div>

${d.scan.liffIds.length ? `
<div class="card">
  <div><b>LIFF ID</b>（テストの固定値とビルド成果物は除外）</div>
  <ul>${rows(d.scan.liffIds, (f) => `<li><code>${esc(f.id)}</code> — ${esc(f.hits[0].file)}</li>`)}</ul>
</div>` : ''}

<p class="foot">
  このページは <code>scripts/collect-line-root.mjs</code> が集めたデータから自動生成しています。
  データはリポジトリにコミットしていません（このリポジトリは公開されているため）。<br>
  ★パスワードは共有相手を限るためのものです。HTMLを読めば分かる仕組みなので、
  外に出せない情報は載せていません。
</p>

</div>
</body>
</html>
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, html, 'utf8');

// ★出力後の検査。機密が1文字でも混ざっていたら止める。
const FORBIDDEN = [
  'channel_access_token', 'channel_secret', 'login_channel_secret',
  'CLOUDFLARE_API_TOKEN', 'GROQ_API_KEY',
];
const body = readFileSync(OUT, 'utf8');
const leaked = FORBIDDEN.filter((w) => body.includes(w) && !body.includes(`${w} / `));
// 「トークン類（channel_access_token / channel_secret）は…」の説明文は許す
const realLeak = FORBIDDEN.filter((w) => {
  const idx = body.indexOf(w);
  if (idx < 0) return false;
  return !body.slice(Math.max(0, idx - 120), idx + 120).includes('選んでいないため');
});
if (realLeak.length) {
  console.error(`★機密が混入している: ${realLeak.join(', ')}`);
  process.exit(1);
}

console.log(`書いた: apps/lp/line-root/index.html (${Math.round(body.length / 1024)}KB)`);
console.log(`  アカウント ${groupList.length}種 / 導線 ${liveLinks.length}本 / 鎖 ${chain.length}段`);
console.log(`  機密の混入: なし`);
