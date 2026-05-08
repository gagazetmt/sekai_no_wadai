// scripts/modules/fetchers/_sofa_common.js
// SofaScore API 共通ヘルパー（2026-05-08 再設計・2回目チャレンジ）
//
// 旧: Python (curl-cffi + Chrome TLS 指紋) を spawn、Webshare 住宅プロキシ rotation
//     → 出口 IP プールが Cloudflare で繰り返し blocked され、連続呼出で 10 連 403 多発
// 新: Puppeteer + Stealth + Webshare proxy（_sofa_via_puppeteer）に統一
//     → page.goto 方式で CORS / cross-origin 完全回避、ブラウザ singleton + mutex で並列対応
//
// 前回 (commit 76c492e) は page.evaluate(fetch) で TypeError: Failed to fetch 多発でロールバック。
// 今回は apiGet/apiGetImage 共に page.goto + response.buffer() に変更し、Mbappe テスト全通過確認済。
//
// API 互換性:
//   旧 apiGet / apiGetLight / apiGetImage / BASE_URL の signature は維持
//   既存 fetcher (sofascore_player / team / match / manager / tournament 等) は無修正で動く

const sofa = require('./_sofa_via_puppeteer');

const BASE_URL = 'https://api.sofascore.com/api/v1';

// 通常の API GET（JSON 返却・リトライは _sofa_via_puppeteer 内で吸収）
async function apiGet(endpoint) {
  return sofa.apiGet(endpoint);
}

// 軽量版（旧版はリトライ抑制、新版でも apiGet と同一）
async function apiGetLight(endpoint) {
  return sofa.apiGet(endpoint);
}

// 画像取得（旧版は失敗時 null 返却）→ 互換維持
async function apiGetImage(endpoint) {
  try {
    return await sofa.apiGetImage(endpoint);
  } catch (e) {
    return null;
  }
}

module.exports = { apiGet, apiGetLight, apiGetImage, BASE_URL };
