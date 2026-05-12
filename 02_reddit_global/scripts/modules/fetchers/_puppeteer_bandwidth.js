// scripts/modules/fetchers/_puppeteer_bandwidth.js
// Webshare 帯域節約用 Puppeteer 共通ヘルパー（2026-05-12）
//
// 背景: Webshare 1GB 枯渇調査で判明したこと:
//   - Chrome の `mtalk.google.com` 常駐通信が月 1GB+ を食う
//   - sofascore/fotmob 等の HTML ページに広告/トラッカー数百KB含まれる
//   - 画像/フォント/CSS は CF 通過に不要なのに全部ロードしてた
//
// 使い方:
//   const { BANDWIDTH_SAVE_ARGS, attachBlocker } = require('./_puppeteer_bandwidth');
//   const browser = await puppeteer.launch({ args: [...BANDWIDTH_SAVE_ARGS, ...] });
//   const page = await browser.newPage();
//   await attachBlocker(page, { allowHosts: ['api.sofascore.com'] });

// Chrome バックグラウンド通信を完全停止するフラグ群
//   --disable-background-networking が核心。これだけで mtalk が消える
const BANDWIDTH_SAVE_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-features=BackgroundDownloads,PushMessaging',
  '--no-default-browser-check',
  '--no-first-run',
  '--disable-translate',
  '--disable-domain-reliability',
  '--metrics-recording-only',
  '--mute-audio',
];

// 広告/トラッカーのホスト名（部分一致でマッチ）
const BLOCKED_HOSTS = [
  'mtalk.google.com',
  'gum.criteo.com', 'criteo.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googletagmanager.com',
  'google-analytics.com', 'analytics.google.com',
  'accounts.google.com', 'www.google.com', 'www.google.co.jp',
  'fundingchoicesmessages.google.com',
  'firebase.googleapis.com',
  'adtrafficquality.google',
  'confiant-integrations.net',
  'hbwrapper.com', 'hbwrapper.nyc3.cdn.digitaloceanspaces.com',
];

// CF 通過に不要なリソース種別（画像/フォント/CSS/メディア）
const BLOCKED_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

// page にリクエスト遮断を仕込む
//   opts.extraBlockedHosts: 追加で遮断したいホスト名
//   opts.allowHosts: 通常ブロック対象でも通したいホスト（画像で API 画像取得する fetcher 用）
async function attachBlocker(page, opts = {}) {
  const allowHosts = opts.allowHosts || [];
  const extraBlockedHosts = opts.extraBlockedHosts || [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    const type = req.resourceType();
    // 1. メインドキュメント (page.goto の対象自体) は絶対通す
    //    apiGetImage の page.goto('...api/v1/team/42/image') もこれで通る
    if (type === 'document') { req.continue().catch(() => {}); return; }
    // 2. allow リスト（XHR/fetch/script の特例。画像/フォントは別途リソース種別でブロック）
    let allowed = false;
    for (const h of allowHosts) {
      if (url.includes(h)) { allowed = true; break; }
    }
    // 3. リソース種別で遮断（画像/フォント/CSS/メディア。allow されてても遮断）
    if (BLOCKED_TYPES.has(type)) { req.abort().catch(() => {}); return; }
    // 4. allow なら通す
    if (allowed) { req.continue().catch(() => {}); return; }
    // 5. ホスト名で遮断（広告/トラッカー）
    for (const h of [...BLOCKED_HOSTS, ...extraBlockedHosts]) {
      if (url.includes(h)) { req.abort().catch(() => {}); return; }
    }
    // 6. それ以外は通す（XHR / Fetch / script 等）
    req.continue().catch(() => {});
  });
}

module.exports = {
  BANDWIDTH_SAVE_ARGS,
  BLOCKED_HOSTS,
  BLOCKED_TYPES,
  attachBlocker,
};
