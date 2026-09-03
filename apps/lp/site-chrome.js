// site-chrome.js — サイト共通のヘッダー・フッターを実行時に差し込む（Distribution Canonical）。
//
// ★このファイルはconsumer側で変更禁止。全サイトでバイト単位一致を維持する
//   （SHA-256でCURRENT/DRIFTED判定される対象）。サイト固有値は一切ここに書かない —
//   読み込み順で先にロードされる site-chrome.config.js が定義する
//   window.SITE_CHROME_CONFIG を参照するだけ。
//
// ★出典・なぜこの方式か（2026-08-22, web-ios-androidキット自身のsite/で実証）:
//   ビルドツールなしの静的HTMLサイトで、複数ページすべてにヘッダー/フッターの
//   生HTMLがコピペされていた。相対パス（../ の深さ）がページの階層ごとに違うため、
//   同じ内容のはずが1文字も揃わずコピペのズレに気づけない状態だった。
//   ここでリンクを「サイトルート相対の絶対パス」に統一し、1箇所の変更が
//   全ページに反映されるようにする。
//
// ★2026-09-03: Core/Config/Local extension境界を確定（GPT相談での設計）。
//   従来の site-chrome.template.js（Core+SITE_CONFIG+NAV_ITEMS混在）から、
//   consumer固有値を site-chrome.config.js（config/schema.jsonから生成）へ分離した。
//   これによりCoreファイル自体はhash完全一致でdrift判定できるようになる。
//
// 使い方:
//   1. このファイルを対象サイトへ site-chrome.js としてコピーする（無改変）
//   2. site-chrome.config.json（config/schema.json準拠）を書き、generatorで
//      site-chrome.config.js / site-chrome.theme.css / site-chrome.layout.css を生成する
//   3. 各ページの <body> 直後に <div id="site-header"></div>、
//      </body> 直前に <div id="site-footer"></div> を置く
//   4. 読み込み順: config.js → site-chrome.js(このファイル) → layout.css/theme.css →
//      任意で site-chrome.local.js（"site-chrome:mounted"イベントを購読する）
//   5. 現在ページに対応する nav リンクには自動で class="active" が付く
//
// 対応していないこと:
//   - Reactやビルドツールを使うプロジェクト（Next.js等）はこの方式を使わない。
//     フレームワーク標準のレイアウト/共通コンポーネント機構を使うこと。
//   - この金型はビルドレスな静的HTML複数ページサイト専用。

(function () {
  var CONFIG = window.SITE_CHROME_CONFIG || {};
  var NAV_ITEMS = CONFIG.navItems || [];

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
      '  <a class="logo-link" href="/"><img class="logo" src="' + CONFIG.logoSrc + '" alt="' + CONFIG.brandName + '"></a>\n' +
      '  <button class="nav-toggle" aria-expanded="false" aria-controls="site-nav" aria-label="メニューを開く"><span></span></button>\n' +
      '  <nav id="site-nav">\n' +
      '    <a href="/"' + (isActive('/') ? ' class="active"' : '') + '>' + CONFIG.homeLabel + '</a>\n' +
      '    ' + nav + '\n' +
      '  </nav>\n' +
      '</header>'
    );
  }

  function buildFooter() {
    var links = ['<a href="/">' + CONFIG.homeLabel + '</a>']
      .concat(NAV_ITEMS.map(function (item) {
        return '<a href="' + item.href + '">' + item.label + '</a>';
      }))
      .join('\n    ');

    return (
      '<footer class="site-footer">\n' +
      '  <div class="site-footer-links">\n' +
      '    ' + links + '\n' +
      '  </div>\n' +
      '  <div class="site-footer-copy">' + CONFIG.brandCopyright + '</div>\n' +
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
    // ★Local extension（web-ios-androidのAI共有ボタン等）はこのイベントを購読して
    //   ヘッダー/フッターのDOM構築完了後に動く。Coreはこのイベント発火だけを責務とし、
    //   Local側の中身は一切知らない（plugin frameworkではなく1個のフックのみ）。
    document.dispatchEvent(new CustomEvent('site-chrome:mounted'));
  });
})();
