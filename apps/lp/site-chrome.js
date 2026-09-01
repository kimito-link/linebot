// site-chrome.js — サイト共通のヘッダー・フッターを実行時に差し込む（金型）。
//
// ★出典・なぜこの方式か（2026-08-22, web-ios-androidキット自身のsite/で実証）:
//   ビルドツールなしの静的HTMLサイトで、複数ページすべてにヘッダー/フッターの
//   生HTMLがコピペされていた。相対パス（../ の深さ）がページの階層ごとに違うため、
//   同じ内容のはずが1文字も揃わずコピペのズレに気づけない状態だった。
//   ここでリンクを「サイトルート相対の絶対パス」に統一し、1箇所の変更が
//   全ページに反映されるようにする。
//
// ★2026-09-01追記: この仕組み自体は当初 site/scripts/site-chrome.js としてキット
//   自身のサイトにしか存在せず、他プロジェクトが新規に複数ページのサイト/LPを作る
//   ときに再利用できる形になっていなかった（line-bot/apps/lp配下でheader/footerが
//   ページごとに個別実装される事故が実際に起きた）。このファイルはそれを受けて
//   templates/へ一般化・格上げしたもの。
//
// 使い方:
//   1. このファイルを対象サイトへ site-chrome.js としてコピーする
//   2. 下の SITE_CONFIG を対象サイトの値に書き換える（ブランド名・ロゴ・ナビ項目）
//   3. 各ページの <body> 直後に <div id="site-header"></div>、
//      </body> 直前に <div id="site-footer"></div> を置く
//   4. site-chrome.template.css も同様にコピーして読み込む（クラス名はそのまま）
//   5. 現在ページに対応する nav リンクには自動で class="active" が付く
//
// 対応していないこと:
//   - Reactやビルドツールを使うプロジェクト（Next.js等）はこの方式を使わない。
//     フレームワーク標準のレイアウト/共通コンポーネント機構を使うこと。
//   - この金型はビルドレスな静的HTML複数ページサイト専用。

(function () {
  // ★ここを対象サイトの値に書き換える。他は変更不要。
  var SITE_CONFIG = {
    brandName: 'Kimito Talk',
    brandCopyright: '株式会社ベストトラスト',
    logoSrc: '/assets/kimito-link-logo-rect.png?v=2',  // ★?v= はキャッシュ対策。ロゴを差し替えたら数字を上げる
    homeLabel: 'トップ',
  };

  // ★ここを増やすだけで全ページのヘッダー・フッターに反映される。
  //   以前は5つのLPがそれぞれ別々のフッターを持ち、ページ間を行き来する導線が
  //   ひとつも無かった（2026-09-01 実測）。
  //   /dhash-report は技術記事なので nav には出さない（フッターにも出ない）。
  var NAV_ITEMS = [
    { href: '/kimitotalk/', label: 'できること' },
    { href: '/talent/', label: 'タレント事務所さまへ' },
    { href: '/gpt-hikkoshi/', label: 'GPTお引越し' },
    { href: '/privacy/', label: 'プライバシーポリシー' },
  ];

  function isActive(href) {
    var path = window.location.pathname;
    if (href === '/') return path === '/' || path === '/index.html';
    return path.indexOf(href) === 0;
  }

  function buildHeader() {
    var nav = NAV_ITEMS.map(function (item) {
      var cls = isActive(item.href) ? ' class="active"' : '';
      return '<a href="' + item.href + '"' + cls + '>' + item.label + '</a>';
    }).join('\n    ');

    return (
      '<header>\n' +
      '  <a class="logo-link" href="/"><img class="logo" src="' + SITE_CONFIG.logoSrc + '" alt="' + SITE_CONFIG.brandName + '"></a>\n' +
      '  <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="メニューを開く"><span></span></button>\n' +
      '  <nav id="site-nav">\n' +
      '    <a href="/"' + (isActive('/') ? ' class="active"' : '') + '>' + SITE_CONFIG.homeLabel + '</a>\n' +
      '    ' + nav + '\n' +
      '  </nav>\n' +
      '</header>'
    );
  }

  function buildFooter() {
    var links = ['<a href="/">' + SITE_CONFIG.homeLabel + '</a>']
      .concat(NAV_ITEMS.map(function (item) {
        return '<a href="' + item.href + '">' + item.label + '</a>';
      }))
      .join('\n    ');

    return (
      '<footer class="site-footer">\n' +
      '  <div class="site-footer-links">\n' +
      '    ' + links + '\n' +
      '  </div>\n' +
      '  <div class="site-footer-copy">' + SITE_CONFIG.brandCopyright + '</div>\n' +
      '</footer>'
    );
  }

  function mountToggle() {
    var toggle = document.querySelector('.nav-toggle');
    var nav = document.getElementById('site-nav');
    if (!toggle || !nav) return;

    toggle.addEventListener('click', function () {
      var isOpen = nav.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') {
        nav.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    var headerSlot = document.getElementById('site-header');
    var footerSlot = document.getElementById('site-footer');
    if (headerSlot) headerSlot.outerHTML = buildHeader();
    if (footerSlot) footerSlot.outerHTML = buildFooter();
    mountToggle();
  });
})();
