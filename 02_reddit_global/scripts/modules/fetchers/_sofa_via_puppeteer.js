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
//   sofascore.com の page から fetch で api.sofascore.com を叩く
//   --disable-web-security で CORS バイパス済 → cross-origin fetch が成立
async function apiGet(urlPath) {
  await init();
  return _serialize(async () => {
    const url = BASE + urlPath;
    const result = await _page.evaluate(async (u) => {
      try {
        const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
        const text = await r.text();
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) {}
        return { status: r.status, isJson: !!parsed, body: parsed || text.slice(0, 500) };
      } catch (e) { return { status: 0, error: e.message || String(e), errName: e.name }; }
    }, url);
    if (!result.isJson) {
      const detail = result.error
        ? `${result.errName || 'Error'}: ${result.error}`
        : (typeof result.body === 'string' ? result.body.slice(0, 120) : '');
      const err = new Error(`HTTP ${result.status}: ${detail}`);
      err.status = result.status;
      throw err;
    }
    return result.body;
  });
}

// 画像 GET（data:image base64 として返す / 旧 _sofa_common と同形式）
async function apiGetImage(urlPath) {
  await init();
  return _serialize(async () => {
    const url = BASE + urlPath;
    const result = await _page.evaluate(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return { status: r.status, error: 'HTTP ' + r.status };
        const blob = await r.blob();
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64 = btoa(bin);
        const type = blob.type || 'image/png';
        return { status: r.status, dataUri: `data:${type};base64,${b64}` };
      } catch (e) { return { status: 0, error: e.message }; }
    }, url);
    if (result.error || !result.dataUri) return null;
    return result.dataUri;
  });
}

module.exports = { init, close, apiGet, apiGetImage };
