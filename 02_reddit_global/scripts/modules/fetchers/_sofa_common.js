// scripts/modules/fetchers/_sofa_common.js
// SofaScore API 共通ヘルパー
//   - 内部で Python (curl-cffi + Chrome TLS 指紋) を spawn してリクエスト
//   - 住宅プロキシ（Webshare rotating）を自動ローテーション（-JP-1..-JP-4000 をランダム選択）
//   - コール間に最低300msの間隔を強制
//   - 403/429 受信時は5秒待って1回だけリトライ
//
// 環境変数 WEBSHARE_PROXY_URL が設定されている場合のみプロキシを使う。
//   フォーマット: http://USERNAME-JP-{N}:PASSWORD@p.webshare.io:80
//   {N} プレースホルダが 1〜4000 のランダム数値に置換される。
//
// 環境変数が無い場合（ローカル開発時）は住宅プロキシなしで直叩き。

const { spawn } = require('child_process');
const path      = require('path');

const BASE_URL = 'https://api.sofascore.com/api/v1';

const MIN_DELAY_MS   = 300;
const RETRY_WAIT_MS  = 5000;
const REQ_TIMEOUT_S  = 20;
const SESSION_MAX    = 4000;

const PY_SCRIPT  = path.join(__dirname, '_sofa_fetch.py');
const PROXY_TPL  = process.env.WEBSHARE_PROXY_URL || null; // 例: http://gudxublo-JP-{N}:xxx@p.webshare.io:80

let _lastCallTs = 0;

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _pickProxy() {
  if (!PROXY_TPL) return null;
  const n = Math.floor(Math.random() * SESSION_MAX) + 1;
  // テンプレに {N} があれば置換、無ければそのまま返す
  return PROXY_TPL.includes('{N}') ? PROXY_TPL.replace('{N}', n) : PROXY_TPL;
}

/**
 * Python subprocess で HTTP リクエストして JSON 応答を返す
 */
function _callPython(urlPath) {
  return new Promise((resolve, reject) => {
    const payload = {
      url:         `${BASE_URL}${urlPath}`,
      proxy:       _pickProxy(),
      timeout:     REQ_TIMEOUT_S,
      impersonate: 'chrome131',
    };
    const proc = spawn('python3', [PY_SCRIPT]);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => reject(e));
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`python3 exit ${code}: ${stderr.slice(0, 200)}`));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error(`python output parse: ${stdout.slice(0, 200)}`)); }
    });
    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

async function _waitRateLimit() {
  const elapsed = Date.now() - _lastCallTs;
  if (elapsed < MIN_DELAY_MS) await _sleep(MIN_DELAY_MS - elapsed);
}

function _httpErr(status, body) {
  const e = new Error(`HTTP ${status}`);
  e.response = { status, data: body };
  return e;
}

function _isProxyError(msg) {
  return /CONNECT|tunnel|proxy/i.test(String(msg || ''));
}

// 通常版：プロキシ失敗 / 403 / 429 時にセッション変えて最大5回まで試行
// バックオフ: 0.8s, 1.5s, 2.5s, 4s
async function apiGet(endpoint) {
  const MAX_ATTEMPTS = 5;
  const PROXY_BACKOFFS = [0, 800, 1500, 2500, 4000]; // 試行前の追加待機

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await _waitRateLimit();
    if (attempt > 1) await _sleep(PROXY_BACKOFFS[attempt - 1] || 0);

    let res;
    try {
      // _callPython は呼ぶたびに _pickProxy() で別セッション選ぶ
      res = await _callPython(endpoint);
    } catch (e) {
      _lastCallTs = Date.now();
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[SofaScore] spawn fail (${attempt}/${MAX_ATTEMPTS}): ${e.message.slice(0, 80)}`);
        continue;
      }
      throw e;
    }
    _lastCallTs = Date.now();

    // Python 側で例外（CONNECT失敗など）→ プロキシ系エラーなら別セッションで即再試行
    if (!res.ok) {
      if (_isProxyError(res.error) && attempt < MAX_ATTEMPTS) {
        console.log(`[SofaScore] proxy error (${attempt}/${MAX_ATTEMPTS}): ${(res.error||'').slice(0, 60)}`);
        continue;
      }
      throw new Error(res.error || 'python call failed');
    }

    // 200 → 成功
    if (res.status === 200) {
      try { return JSON.parse(res.body); }
      catch (e) { throw new Error(`body parse: ${res.body.slice(0, 120)}`); }
    }

    // 403/429 → 再試行（セッション変わる）
    if ((res.status === 403 || res.status === 429) && attempt < MAX_ATTEMPTS) {
      console.log(`[SofaScore] ${res.status} on ${endpoint} (${attempt}/${MAX_ATTEMPTS})`);
      await _sleep(RETRY_WAIT_MS);
      continue;
    }

    // それ以外のエラー
    throw _httpErr(res.status, res.body);
  }

  throw new Error('apiGet: max attempts exceeded');
}

// 軽量版：リトライしない（検証用・ラベル検証でサーバー側が速く応答する必要があるケース）
async function apiGetLight(endpoint) {
  await _waitRateLimit();

  let res;
  try {
    res = await _callPython(endpoint);
  } catch (e) {
    _lastCallTs = Date.now();
    throw e;
  }
  _lastCallTs = Date.now();

  if (!res.ok) throw new Error(res.error || 'python call failed');
  if (res.status === 200) {
    try { return JSON.parse(res.body); }
    catch (e) { throw new Error(`body parse: ${res.body.slice(0, 120)}`); }
  }
  throw _httpErr(res.status, res.body);
}

module.exports = { apiGet, apiGetLight, BASE_URL };
