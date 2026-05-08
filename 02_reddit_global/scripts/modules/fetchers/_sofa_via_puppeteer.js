// scripts/modules/fetchers/_sofa_via_puppeteer.js
// SofaScore API を Puppeteer 経由で呼び出す（Cloudflare 突破用）
//   curl-cffi (旧 _sofa_common 直叩き) は Webshare 出口 IP プールが SofaScore で繰り返し blocked される
//   → Puppeteer の page.evaluate(fetch) は Cookie + UA + JS 環境込みなので Cloudflare 通過率高い
//
// 使い方:
//   const sp = require('./_sofa_via_puppeteer');
//   const json = await sp.apiGet('/unique-tournament/17/seasons');     // lazy init で初回自動起動
//   const dataUri = await sp.apiGetImage('/team/42/image');
//   await sp.close();  // 任意（プロセス終了時に自動 close）
//
// 並列耐性:
//   - ブラウザ + page を singleton で保持（起動コスト 1 回のみ）
//   - 全ての apiGet / apiGetImage は内部で mutex により serialize（page 競合回避）
//   - 同時並列で叩いても安全に処理される（順次処理）

require('dotenv').config();
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://api.sofascore.com/api/v1';
const PAGE_TIMEOUT = 60000;

let _browser     = null;
let _page        = null;
let _initPromise = null;

// ── Webshare proxy (回転 session) ──
function _pickProxy() {
  if (!process.env.WEBSHARE_PROXY_URL) return null;
  const n = Math.floor(Math.random() * 4000) + 1;
  return process.env.WEBSHARE_PROXY_URL.replace('{N}', String(n));
}

// ── lazy init: 初回呼出時にブラウザ起動 + sofascore.com で cookie/CF challenge 済ませる ──
async function init() {
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const proxyUrl = _pickProxy();
    const args = [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      // CORS バイパス: page から api.sofascore.com への fetch を直接許可
      //   sofascore.com → api.sofascore.com の cross-origin fetch でブラウザが TypeError 投げるのを防ぐ
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ];
    if (proxyUrl) args.push(`--proxy-server=${new URL(proxyUrl).host}`);
    _browser = await puppeteerExtra.launch({ headless: 'new', args });
    _page = await _browser.newPage();
    if (proxyUrl) {
      const u = new URL(proxyUrl);
      if (u.username) {
        await _page.authenticate({
          username: decodeURIComponent(u.username),
          password: decodeURIComponent(u.password),
        });
      }
    }
    await _page.setUserAgent(UA);
    await _page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    // sofascore.com で cf cookie/challenge を確実に済ませる（networkidle2 で完全ロード待ち）
    await _page.goto('https://www.sofascore.com/', { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
    await new Promise(r => setTimeout(r, 1500));
    // プロセス終了時に自動 close
    process.once('exit',   () => { try { _browser?.close(); } catch (_) {} });
    process.once('SIGINT', () => { try { _browser?.close(); } catch (_) {} process.exit(); });
  })();
  return _initPromise;
}

async function close() {
  try { if (_page)    await _page.close(); }    catch (_) {}
  try { if (_browser) await _browser.close(); } catch (_) {}
  _page = null; _browser = null; _initPromise = null;
}

// ── mutex: 全 API 呼出をシリアル化（page 競合回避）──
//   前 task の reject が後続に影響しないよう、queue は catch して swallow
//   呼出側には現在 task の reject/resolve をそのまま伝搬
let _queue = Promise.resolve();
function _serialize(taskFn) {
  const p = _queue.then(() => taskFn());
  _queue = p.catch(() => {});
  return p;
}

// 通常の API GET（JSON 返却）
//   page.goto(api_url) でページ遷移として取得 → CORS / cross-origin 問題を完全回避
//   Chrome はレスポンスを直接受信するので、Cloudflare 通過後に JSON が body として表示される
//   page.evaluate(fetch) は --disable-web-security でも一部環境で TypeError: Failed to fetch
//   が出るため、より堅牢な page.goto 方式に変更（2026-05-08）
async function apiGet(urlPath) {
  await init();
  return _serialize(async () => {
    const url = BASE + urlPath;
    let response;
    try {
      response = await _page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    } catch (e) {
      const err = new Error(`HTTP 0: goto fail: ${e.message}`);
      err.status = 0;
      throw err;
    }
    const status = response ? response.status() : 0;
    // body 取得（JSON.parse できなければエラー扱い）
    const text = await _page.evaluate(() => document.body && document.body.innerText || '');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) {}
    if (!parsed) {
      const err = new Error(`HTTP ${status}: not JSON: ${text.slice(0, 120)}`);
      err.status = status;
      throw err;
    }
    return parsed;
  });
}

// 画像 GET（data:image base64 として返す / 旧 _sofa_common と同形式）
//   page.goto + response.buffer() でバイナリ直接取得 → CORS 完全回避（2026-05-08）
async function apiGetImage(urlPath) {
  await init();
  return _serialize(async () => {
    const url = BASE + urlPath;
    let response;
    try {
      response = await _page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    } catch (e) {
      return null;
    }
    if (!response || response.status() !== 200) return null;
    let buf;
    try {
      buf = await response.buffer();
    } catch (e) { return null; }
    if (!buf || !buf.length) return null;
    // magic で MIME 判定（旧 _sofa_common と同形式）
    const sniff = buf.slice(0, 8).toString('hex');
    const mime  = sniff.startsWith('89504e47') ? 'image/png'
                : sniff.startsWith('ffd8ff')   ? 'image/jpeg'
                : sniff.startsWith('47494638') ? 'image/gif'
                : (response.headers()['content-type'] || 'image/png').split(';')[0];
    return `data:${mime};base64,${buf.toString('base64')}`;
  });
}

module.exports = { init, close, apiGet, apiGetImage };
