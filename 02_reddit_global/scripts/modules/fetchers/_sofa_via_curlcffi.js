// scripts/modules/fetchers/_sofa_via_curlcffi.js
// SofaScore API を curl-cffi (Chrome131 TLS fingerprint) + Webshare 経由で呼び出す
// 2026-05-12: Puppeteer 版から curl-cffi 版へ移行
//
// 経緯:
//   ・Puppeteer 版は CF 通過のため www.sofascore.com を pre-load (1.5-3MB) してた
//   ・実は api.sofascore.com には CF challenge 無し、Webshare 住宅IP からは直接 200
//   ・curl-cffi + Chrome131 TLS で十分通過、Puppeteer の Chrome 起動コスト不要
//   ・帯域 60-90% 削減見込み
//
// API 互換性: _sofa_via_puppeteer.js と同じ関数 signature 維持
//   const sp = require('./_sofa_via_curlcffi');
//   const json = await sp.apiGet('/unique-tournament/17/seasons');
//   const dataUri = await sp.apiGetImage('/team/42/image');
//   await sp.close();  // no-op（互換性のため残す）

const { curlGetJson, curlGetImage } = require('./_curl_cffi_caller');

const BASE = 'https://api.sofascore.com/api/v1';
const REFERER = 'https://www.sofascore.com/';
const HEADERS = { Accept: '*/*' };

// 初期化不要（互換性のため空関数残す）
async function init() { /* no-op */ }
async function close() { /* no-op */ }

// API JSON 取得
async function apiGet(urlPath) {
  const url = BASE + urlPath;
  return await curlGetJson(url, { referer: REFERER, headers: HEADERS, timeout: 25, retries: 2 });
}

// 互換性のため別関数として残す（旧版でリトライ抑制版だった）
async function apiGetLight(urlPath) {
  const url = BASE + urlPath;
  return await curlGetJson(url, { referer: REFERER, headers: HEADERS, timeout: 15, retries: 0 });
}

// 画像取得（data:image/...;base64,... を返す、失敗時 null）
async function apiGetImage(urlPath) {
  const url = BASE + urlPath;
  return await curlGetImage(url, { referer: REFERER, headers: HEADERS, timeout: 20, retries: 1 });
}

module.exports = { init, close, apiGet, apiGetLight, apiGetImage };
