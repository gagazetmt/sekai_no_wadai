// scripts/modules/fetchers/_sofa_via_puppeteer.js
// SofaScore API を Puppeteer 経由で呼び出す（Cloudflare 突破用）
//   curl-cffi (apiGet) は Webshare 出口 IP プールが SofaScore で繰り返し blocked される
//   → Puppeteer の page.evaluate(fetch) は Cookie + UA + JS 環境込みなので Cloudflare 通過率高い
//
// 使い方:
//   const sp = require('./_sofa_via_puppeteer');
//   await sp.init();   // ブラウザ起動（最初に1回）
//   const json = await sp.apiGet('/unique-tournament/17/seasons');
//   const dataUri = await sp.apiGetImage('/team/42/image');
//   await sp.close();  // 終了時

require('dotenv').config();
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE = 'https://api.sofascore.com/api/v1';

let _browser = null;
let _page    = null;

function _pickProxy() {
  if (!process.env.WEBSHARE_PROXY_URL) return null;
  const n = Math.floor(Math.random() * 4000) + 1;
  return process.env.WEBSHARE_PROXY_URL.replace('{N}', String(n));
}

async function init() {
  if (_browser) return;
  const proxyUrl = _pickProxy();
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'];
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
  // sofascore.com にアクセスして cookie + cf challenge を済ませる
  await _page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 2500));
}

async function close() {
  try { if (_page)    await _page.close(); }    catch (_) {}
  try { if (_browser) await _browser.close(); } catch (_) {}
  _page = null; _browser = null;
}

// 通常の API GET（JSON 返却）
async function apiGet(urlPath) {
  if (!_page) throw new Error('init() を先に呼んでください');
  const url = BASE + urlPath;
  const result = await _page.evaluate(async (u) => {
    try {
      const r = await fetch(u, { headers: { 'Accept': 'application/json' } });
      const text = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch (_) {}
      return { status: r.status, isJson: !!parsed, body: parsed || text.slice(0, 500) };
    } catch (e) { return { status: 0, error: e.message }; }
  }, url);
  if (!result.isJson) {
    const err = new Error(`HTTP ${result.status}: ${typeof result.body === 'string' ? result.body.slice(0, 100) : ''}`);
    err.status = result.status;
    throw err;
  }
  return result.body;
}

// 画像 GET（data:image base64 として返す）
async function apiGetImage(urlPath) {
  if (!_page) throw new Error('init() を先に呼んでください');
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
  if (result.error || !result.dataUri) {
    throw new Error(`Image fetch fail: ${result.error || 'no data'}`);
  }
  return result.dataUri;
}

module.exports = { init, close, apiGet, apiGetImage };
