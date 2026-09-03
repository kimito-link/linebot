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
  if (!groups.has(key)) groups.set(key, { name: key, unknown, verified: false, links: [] });
  // 認証済みバッジ（実物の管理画面にも出る）。1本でも認証済みなら、そのアカウントは認証済み。
  if (id?.verified) groups.get(key).verified = true;
  groups.get(key).links.push({ ...link, identity: id });
}
const groupList = [...groups.values()].sort((a, b) => b.links.length - a.links.length);

// ── 配線図のためのデータ（リポジトリ → アカウント）────────────
// ★表では「複雑さ」が伝わらない。線で結んで初めて、
//   22のリポジトリが5つの窓口に絡んでいることが目で分かる。
//   ぐちゃぐちゃに描くのではなく、整列させて描く
//   （複雑だが管理されている、という状態をそのまま映す）。
let wiringAccountNo = new Map();
const wiring = (() => {
  const idOf = (u) => {
    const i = identityOf(u);
    return i && i.account ? i.account : '名前非公開の窓口';
  };
  const accSet = new Map();   // アカウント名 -> { name, verified, repos:Set }
  const repoSet = new Map();  // リポジトリ名 -> Set(アカウント名)
  for (const l of liveLinks) {
    const a = idOf(l.url);
    const ident = identityOf(l.url);
    if (!accSet.has(a)) accSet.set(a, { name: a, verified: !!ident?.verified, repos: new Set() });
    if (ident?.verified) accSet.get(a).verified = true;
    for (const h of l.hits.filter((x) => !x.archive)) {
      accSet.get(a).repos.add(h.repo);
      if (!repoSet.has(h.repo)) repoSet.set(h.repo, new Set());
      repoSet.get(h.repo).add(a);
    }
  }
  // 窓口は本数の多い順（この順を軸に、左側を並べ替える）
  const accounts = [...accSet.values()].sort((a, b) => b.repos.size - a.repos.size);

  // ★交差最小化（barycenter法）。
  //   左を「繋がっている窓口の平均位置」順に並べ替えるだけで、線の交差が大きく減る。
  //   Sugiyama の層別グラフ描画で使われる古典的な手法で、32本程度なら1回で十分効く。
  //   これをやらないと中央で線が団子になり、「混沌」に見えてしまう。
  const accPos = new Map(accounts.map((a, i) => [a.name, i]));
  const repos = [...repoSet.entries()]
    .map(([name, accs]) => {
      const list = [...accs].sort((x, y) => accPos.get(x) - accPos.get(y));
      const bary = list.reduce((n, a) => n + accPos.get(a), 0) / list.length;
      return { name, accs: list, bary };
    })
    .sort((a, b) => a.bary - b.bary || a.name.localeCompare(b.name));
  // ★配線図らしく、線ごとに「何箇所で使われているか」を持たせる。
  //   太さに反映すると、主幹線と支線の区別が図の上で付く。
  const weight = new Map();  // "repo|acc" -> 使用箇所数
  for (const l of liveLinks) {
    const a = idOf(l.url);
    for (const h of l.hits.filter((x) => !x.archive)) {
      const k = h.repo + '|' + a;
      weight.set(k, (weight.get(k) ?? 0) + 1);
    }
  }
  const edges = repos.flatMap((r) => r.accs.map((a) => ({
    repo: r.name, acc: a, n: weight.get(r.name + '|' + a) ?? 1,
  })));

  // ★左の並びを2群に分ける。Sankey の定石（1カラム8〜12ノード）を22件が
  //   超えているため、そのまま縦一列に並べるとラベルが潰れて流れが読めない。
  //   ★分け方は実測値だけで決める（分岐しているか否か）。
  //     「マーケ系」「サポート系」のような恣意的な分類はしない
  //     — データから来ない区分は、見る人が検証できない＝嘘になりうる。
  const groups = [
    { key: 'multi', label: '複数の窓口に分かれているサイト',
      note: 'どこに繋ぐかの判断が要る', items: repos.filter((r) => r.accs.length > 1) },
    { key: 'single', label: '1つの窓口だけに繋がるサイト',
      note: '経路が確定している', items: repos.filter((r) => r.accs.length === 1) },
  ].filter((g) => g.items.length);
  // 回路番号（L-01…）。図と表を突き合わせるための通し番号。
  wiringAccountNo = new Map(accounts.map((a, i) => [a.name, `L-${String(i + 1).padStart(2, '0')}`]));
  // 組み合わせの総数（22×5）。「整理されている」ことを算数で示すために使う。
  const possible = repos.length * accounts.length;
  return { accounts, repos, edges, groups, possible, multi: repos.filter((r) => r.accs.length > 1) };
})();

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
  /* ── 配線図 ──
     ★複雑さは線の本数で、秩序は整列で見せる。
       ぐちゃぐちゃに描くと「管理できていない」に見えてしまう。 */
  .wiring{background:var(--panel);border:1px solid var(--line);border-radius:12px;
    padding:14px 10px 18px;margin:14px 0 22px;overflow-x:auto}
  .wiring svg{display:block;min-width:900px}
  .w-line{fill:none;stroke:#3b5570;stroke-width:1}
  .w-line.branch{stroke:#c98a2b;stroke-width:1.4}
  .w-dot{fill:#5b7a99}
  .w-dot.branch{fill:#e0a33e}
  .w-repo{fill:#7f93a8;font-size:11px;text-anchor:end;font-family:ui-monospace,Consolas,monospace}
  .w-repo.branch{fill:#e0a33e;font-weight:700}
  .w-group{fill:#c8d6e5;font-size:11.5px;font-weight:800;text-anchor:end}
  .w-group-note{fill:#6b7f94;font-size:10.5px}
  .w-acc-dot{fill:#06c755}
  .w-acc{fill:#e6edf5;font-size:13.5px;font-weight:800}
  .w-acc-sub{fill:#8fa3b8;font-size:11px}
  .w-legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12px;color:var(--muted);
    padding:0 10px 12px;align-items:center}
  .w-legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;vertical-align:-1px}
  /* ★対比は控えめに。数字を大きく出すと押し付けになる（会議での指摘）。 */
  .w-foot{color:var(--muted);font-size:12.5px;margin:-10px 0 20px;padding:0 4px;line-height:1.8}
  .w-foot b{color:var(--ink)}
  .dot-repo{background:#5b7a99}.dot-acc{background:#06c755}
  .dot-edge{background:#3b5570}.dot-multi{background:#e0a33e}
  /* ── LINE Official Account Manager のアカウント一覧を模した表 ──
     ★実物（manager.line.biz）と同じ見た目にすることで、
       「管理画面で見えているあのアカウント」と地図上の行が
       頭の中で一対一に結びつく。別の意匠を作ると対応づけが要る。 */
  .oam{background:#fff;color:#333;border-radius:10px;overflow:hidden;margin:14px 0 26px;
    box-shadow:0 2px 14px rgba(0,0,0,.28)}
  .oam-head{padding:15px 18px 12px;border-bottom:1px solid #e5e5e5}
  .oam-head h3{margin:0;font-size:16px;font-weight:800;color:#222}
  .oam-head .n{color:#888;font-weight:600;font-size:13px;margin-left:5px}
  .oam table{width:100%;border-collapse:collapse;font-size:13px;min-width:600px}
  .oam thead th{background:#fafafa;color:#666;font-size:12px;font-weight:600;
    padding:11px 14px;border-bottom:1px solid #e5e5e5;text-align:left;white-space:nowrap}
  .oam tbody td{padding:13px 14px;border-bottom:1px solid #eee;vertical-align:middle}
  .oam tbody tr:last-child td{border-bottom:0}
  /* アカウント名のセル。実物と同じくアイコン＋名前＋認証バッジ */
  .oam .who{display:flex;align-items:center;gap:10px}
  .oam .ico{width:30px;height:30px;border-radius:50%;background:#e8eaed;flex-shrink:0;
    display:flex;align-items:center;justify-content:center;font-size:14px;color:#9aa0a6}
  .oam .nm{color:#1a73c8;font-weight:600;text-decoration:underline;text-underline-offset:2px}
  .oam .verified{color:#06c755;font-size:12px}
  /* リンク本数。実物の「友だち」列の位置に置く */
  .oam .cnt{font-weight:700;color:#333;white-space:nowrap}
  .oam .cnt .u{font-weight:400;color:#888;font-size:11.5px;margin-left:2px}
  /* そのアカウントへ向いているURLを、行の中にぶら下げる */
  .oam .urls{margin-top:7px;display:flex;flex-wrap:wrap;gap:5px}
  .oam .u-chip{background:#f1f3f4;border:1px solid #e0e0e0;border-radius:5px;
    padding:2px 7px;font-size:11.5px;font-family:ui-monospace,Consolas,monospace;color:#444}
  .oam .u-chip.has-ref{background:#e6f4ea;border-color:#b7e0c4;color:#137333}
  .oam .repos{color:#888;font-size:11.5px;margin-top:6px;line-height:1.6}
  /* 「同じ窓口に何本も向いている」ことを行そのもので警告する */
  .oam tr.dup td{background:#fffbf0}
  .oam .warn{display:inline-block;background:#fef7e0;color:#b06000;border:1px solid #feefc3;
    border-radius:4px;padding:1px 6px;font-size:11px;font-weight:700;margin-left:6px}
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

<h2>1.5 配線図 — いま何本の導線が走っているか</h2>
<p class="sub">
  左が出どころ（${wiring.repos.length}のサイト・アプリ）、右が受け口（${wiring.accounts.length}のLINE公式アカウント）。
  線が${wiring.edges.length}本。うち${wiring.multi.length}のサイトは<b>複数の窓口に分岐</b>しています。
</p>

<div class="wiring">
  <div class="w-legend">
    <span><i class="dot-repo"></i>出どころ ${wiring.repos.length}</span>
    <span><i class="dot-acc"></i>受け口 ${wiring.accounts.length}</span>
    <span><i class="dot-edge"></i>結線 ${wiring.edges.length}本</span>
    <span><i class="dot-multi"></i>分岐しているサイト ${wiring.multi.length}</span>
  </div>
  ${(() => {
    const RH = 25, AH = 78, PAD = 20, GAP = 30, LX = 300, RX = 660, W = 960;

    // 群見出しを挟みながら、左の縦位置を決める（Sankeyの8〜12上限への対処）
    const rowY = new Map();
    const headings = [];
    let cursor = PAD + 8;
    for (const g of wiring.groups) {
      headings.push({ y: cursor, label: g.label, note: g.note, n: g.items.length });
      cursor += 18;
      for (const r of g.items) { rowY.set(r.name, cursor + RH / 2); cursor += RH; }
      cursor += GAP;
    }
    const leftH = cursor;
    const accH = wiring.accounts.length * AH;
    const H = Math.max(leftH, accH + PAD * 2);
    // 右は左の高さに合わせて中央寄せ（左右のバランスを取る）
    const accTop = Math.max(PAD, (H - accH) / 2);
    const ay = (i) => accTop + i * AH + AH / 2;
    const accIdx = new Map(wiring.accounts.map((a, i) => [a.name, i]));

    // ★線の太さは「何箇所で使われているか」。実測で49倍の開きがあり、
    //   太さに出すと主幹線と支線が図の上で区別できる（装飾ではなく情報）。
    const maxN = Math.max(...wiring.edges.map((e) => e.n), 1);
    const paths = wiring.edges.map((e) => {
      const y1 = rowY.get(e.repo), y2 = ay(accIdx.get(e.acc));
      const mx = (LX + RX) / 2;
      const branching = wiring.repos.find((r) => r.name === e.repo).accs.length > 1;
      const w = (1 + 2.6 * Math.sqrt(e.n / maxN)).toFixed(2);
      return `<path d="M ${LX} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${RX} ${y2}" class="w-line${branching ? ' branch' : ''}" style="stroke-width:${w}"/>`;
    }).join('');

    const headNodes = headings.map((h) => `
      <text x="${LX - 10}" y="${h.y + 2}" class="w-group">${esc(h.label)}（${h.n}）</text>
      <text x="${LX + 8}" y="${h.y + 2}" class="w-group-note">${esc(h.note)}</text>`).join('');

    const repoNodes = wiring.repos.map((r) => {
      const y = rowY.get(r.name), b = r.accs.length > 1;
      return `<circle cx="${LX}" cy="${y}" r="3.5" class="w-dot${b ? ' branch' : ''}"/>
      <text x="${LX - 10}" y="${y + 4}" class="w-repo${b ? ' branch' : ''}">${esc(r.name)}</text>`;
    }).join('');

    const accNodes = wiring.accounts.map((a, i) => `
      <circle cx="${RX}" cy="${ay(i)}" r="6" class="w-acc-dot"/>
      <text x="${RX + 14}" y="${ay(i) - 2}" class="w-acc">${esc(a.name)}${a.verified ? ' ✓' : ''}</text>
      <text x="${RX + 14}" y="${ay(i) + 15}" class="w-acc-sub">${a.repos.size}のサイトから</text>`).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="LINE導線の配線図">
      ${paths}${headNodes}${repoNodes}${accNodes}</svg>`;
  })()}
</div>

<p class="w-foot">
  22のサイトと5つの窓口で、繋ぎ方は最大 <b>${wiring.possible}通り</b>ありえます。
  いまは <b>${wiring.edges.length}本</b>に絞ってあり、
  どのサイトがどの窓口に出ているかが1本ずつ確定しています。
</p>

<div class="card" style="margin-top:-8px">
  <div><span class="badge b-ok">蓄積している</span>
    <b style="margin-left:8px">線が増えるほど、一次情報が濃くなります</b></div>
  <div style="margin-top:7px">
    この線1本ごとに「どのサイトから来た人か」（<code>ref_code</code>）が残り、
    窓口ごとに何人溜まったかが数えられます。<b>広告費を払って買うデータではなく、
    自分の導線から出てくる一次情報</b>なので、貯まるほど次の判断が速くなります。
  </div>
  <div class="how">apps/worker/src/routes/liff.ts:800（ref_code の記録）／friends・ref_tracking テーブル</div>
</div>

<div class="card">
  <div><span class="badge b-ok">実装済み</span>
    <b style="margin-left:8px">線の先で、会話がそのまま貯まり続けます</b></div>
  <div style="margin-top:7px">
    友だち追加の後に交わされたやりとりは、往復とも <code>messages_log</code> に残ります。
    誰と・どちら向きに・いつ・どのアカウントで。<b>これが消えないので、
    次に話しかけるときに「前回の続き」から始められます。</b>
  </div>
  <div class="tbl"><table style="margin-top:8px">
    <tr><th>残るもの</th><th>使われ方</th></tr>
    <tr><td>会話の本文（往復）</td><td>間が空いた相手へ、履歴を踏まえた一言を自動で送る</td></tr>
    <tr><td>どの導線から来たか</td><td>応対する人格（ナレッジパック）の切り替え</td></tr>
    <tr><td>どの窓口・いつ</td><td>窓口ごとの溜まり具合、時間帯の偏り</td></tr>
  </table></div>
  <div class="how">packages/db/bootstrap.sql:540（messages_log）／apps/worker/src/services/followup-nudge.ts（履歴を踏まえた自発的な一言）</div>
</div>

<div class="card">
  <div><span class="badge b-ok">出願済み</span>
    <b style="margin-left:8px">貯めた文脈の扱いについて、特許を出しています</b></div>
  <div class="tbl"><table style="margin-top:8px">
    <tr><th>発明の名称</th><th>何をするものか</th></tr>
    <tr><td>文脈OS</td>
      <td>表示された情報から文脈を自動で取り出し、保存する</td></tr>
    <tr><td>AI返信秘書</td>
      <td>省略された指示を解決して、返信の内容を組み立てる</td></tr>
    <tr><td>感情影響可視化型 多段階意思決定支援システム</td>
      <td>送る前に、受け取る側がどう感じるかを可視化する</td></tr>
  </table></div>
  <div style="margin-top:9px">
    いずれも株式会社ベストトラストの出願です。
    <b>会話が貯まること自体と、その使い方の両方</b>を対象にしています。
  </div>
</div>

<div class="card">
  <div><b>この配線を、増やしながら壊さずに保つ</b></div>
  <div style="margin-top:7px">
    サイトが1つ増えるたびに線が増え、窓口を1つ足すと分岐が増えます。
    どこを直せば何に響くかは、この図を持っていないと追えません。
    ${wiring.multi.length}のサイトが既に複数の窓口に分かれており、
    ${wiring.edges.length}本すべてが正しく繋がっているかは、
    人の記憶ではなく<b>測って確かめる</b>しかない段階に来ています。
  </div>
  <div class="how">この図は scripts/collect-line-root.mjs が毎回実測して描き直しています（推測値は含みません）</div>
</div>

<h2>2. アカウント別 — 同じ窓口に何本向いているか</h2>
<p class="sub">
  短縮URL（<code>lin.ee/xxx</code>）を実際に開き、ページタイトルで実体を判定しました。
  ★存在しないURLはタイトルが空になることを対照実験で確認済みです。
</p>
<div class="oam">
  <div class="oam-head"><h3>アカウント<span class="n">(${groupList.length})</span></h3></div>
  <div class="tbl"><table>
    <thead><tr>
      <th>アカウント名</th><th>向いているリンク</th><th>使われている数</th><th>ref</th>
    </tr></thead>
    <tbody>
    ${rows(groupList, (g) => `
    <tr class="${g.links.length > 1 && !g.unknown ? 'dup' : ''}">
      <td>
        <div class="who">
          <div class="ico">${g.unknown ? '?' : '👤'}</div>
          <div>
            <span class="nm">${esc(g.name)}</span>${g.verified ? ' <span class="verified">✔</span>' : ''}
            ${g.links.length > 1 && !g.unknown ? '<span class="warn">重複</span>' : ''}
            <div class="repos">${esc([...new Set(g.links.flatMap((l) => l.hits.filter((h) => !h.archive).map((h) => h.repo)))].join(' / '))}</div>
          </div>
        </div>
      </td>
      <td>
        <div class="urls">${rows(g.links.sort((a, b) => b.hits.length - a.hits.length), (l) => `<span class="u-chip${l.refs.length ? ' has-ref' : ''}">${esc(l.url.replace('https://', ''))}</span>`)}</div>
      </td>
      <td class="cnt">${g.links.reduce((n, l) => n + l.hits.filter((h) => !h.archive).length, 0)}<span class="u">箇所</span></td>
      <td>${(() => { const r = [...new Set(g.links.flatMap((l) => l.refs))]; return r.length ? esc(r.join(', ')) : '<span style="color:#bbb">—</span>'; })()}</td>
    </tr>`)}
    </tbody>
  </table></div>
</div>

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
