// scripts/modules/fetchers/_sofa_common.js
// SofaScore API 共通ヘルパー（2026-05-08 全面再設計）
//
// 旧: Python (curl-cffi + Chrome TLS 指紋) を spawn、Webshare 住宅プロキシ rotation
//     → 出口 IP プールが Cloudflare で繰り返し blocked され、連続呼出で 10 連 403 多発
// 新: Puppeteer + Stealth + Webshare proxy（_sofa_via_puppeteer）に統一
//     → Cookie/UA/JS 環境込みで Cloudflare 通過率高い、ブラウザ singleton で並列対応
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
    // 互換性のため失敗時は null（旧 curl-cffi 版と同挙動）
    return null;
  }
}

module.exports = { apiGet, apiGetLight, apiGetImage, BASE_URL };
