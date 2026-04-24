// scripts/modules/fetchers/_sofa_common.js
// SofaScore API 共通ヘルパー
//  - コール間に最低300msの間隔を強制（レート制限対策）
//  - 403/429 受信時は5秒待って1回だけリトライ
//  - 全 sofascore_* fetcher がこれ経由で呼ぶこと

const axios = require('axios');

const BASE_URL = 'https://api.sofascore.com/api/v1';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

const MIN_DELAY_MS   = 300;
const RETRY_WAIT_MS  = 5000;
const REQ_TIMEOUT_MS = 12000;

let _lastCallTs = 0;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _rawGet(endpoint) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, {
    headers: HEADERS,
    timeout: REQ_TIMEOUT_MS,
  });
  return res.data;
}

// 全fetcher共通のレート制限付き GET
async function apiGet(endpoint) {
  // 前回コールから最低 MIN_DELAY_MS 経っていなければ待機
  const elapsed = Date.now() - _lastCallTs;
  if (elapsed < MIN_DELAY_MS) await _sleep(MIN_DELAY_MS - elapsed);

  try {
    const data = await _rawGet(endpoint);
    _lastCallTs = Date.now();
    return data;
  } catch (e) {
    const status = e.response?.status;
    _lastCallTs  = Date.now();

    // レート制限 or IPブロック → 5秒待って1回リトライ
    if (status === 403 || status === 429) {
      console.log(`[SofaScore] ${status} on ${endpoint} → ${RETRY_WAIT_MS}ms 後にリトライ`);
      await _sleep(RETRY_WAIT_MS);
      try {
        const data2 = await _rawGet(endpoint);
        _lastCallTs = Date.now();
        return data2;
      } catch (e2) {
        _lastCallTs = Date.now();
        throw e2;
      }
    }
    throw e;
  }
}

// 軽量GET: リトライしない。検証用（失敗即判定）
async function apiGetLight(endpoint) {
  const elapsed = Date.now() - _lastCallTs;
  if (elapsed < MIN_DELAY_MS) await _sleep(MIN_DELAY_MS - elapsed);
  try {
    const data = await _rawGet(endpoint);
    _lastCallTs = Date.now();
    return data;
  } catch (e) {
    _lastCallTs = Date.now();
    throw e;
  }
}

module.exports = { apiGet, apiGetLight, BASE_URL, HEADERS };
