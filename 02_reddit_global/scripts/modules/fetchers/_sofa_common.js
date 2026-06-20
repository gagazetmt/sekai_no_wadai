// scripts/modules/fetchers/_sofa_common.js
// SofaScore API 共通ヘルパー
//
// 歴史:
//   2026-05-08: Puppeteer + Stealth + Webshare に統一（_sofa_via_puppeteer）
//   2026-05-12: curl-cffi + Webshare に戻す（_sofa_via_curlcffi）
//
//   理由: Webshare 1GB 枯渇調査で判明:
//     ・api.sofascore.com には CF challenge 無し（IP 評価のみ）
//     ・Webshare 住宅IP + Chrome131 TLS で curl-cffi 直叩き可能
//     ・Puppeteer の Chrome 起動コスト (1.5-3MB/init) は完全に不要だった
//     ・帯域 60-90% 削減見込み
//
// API 互換性:
//   apiGet / apiGetLight / apiGetImage / BASE_URL の signature は維持
//   既存 fetcher (sofascore_player / team / match / manager / tournament 等) は無修正で動く

const sofa = require('./_sofa_via_curlcffi');

const BASE_URL = 'https://api.sofascore.com/api/v1';

// 通常の API GET（JSON 返却・リトライは _sofa_via_puppeteer 内で吸収）
async function apiGet(endpoint) {
  return sofa.apiGet(endpoint);
}

// 軽量版（リトライ抑制版・タイムアウト短め）
async function apiGetLight(endpoint) {
  return sofa.apiGetLight(endpoint);
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
