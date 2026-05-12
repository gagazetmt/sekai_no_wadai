// scripts/modules/fetchers/_curl_cffi_caller.js
// Node から _curl_cffi_fetch.py を呼ぶ汎用ヘルパー（2026-05-12）
//
// 背景: Webshare 1GB 枯渇調査で判明 — Puppeteer は過剰で、curl-cffi + Chrome131 TLS で
//      sofascore/fotmob/transfermarkt 全部 200 取れる。Puppeteer から移行することで
//      帯域 60%+ 削減見込み。
//
// 使い方:
//   const { curlGet, curlGetImage } = require('./_curl_cffi_caller');
//   const json = await curlGet('https://api.sofascore.com/api/v1/team/2829', {
//     referer: 'https://www.sofascore.com/',
//   });
//   const dataUri = await curlGetImage('https://api.sofascore.com/api/v1/team/2829/image', {
//     referer: 'https://www.sofascore.com/',
//   });

const path = require('path');
const { spawn } = require('child_process');

const PY_SCRIPT = path.join(__dirname, '_curl_cffi_fetch.py');
const PROXY_LIST_SIZE = 4000;

function _pickProxy() {
  if (!process.env.WEBSHARE_PROXY_URL) return null;
  const n = Math.floor(Math.random() * PROXY_LIST_SIZE) + 1;
  return process.env.WEBSHARE_PROXY_URL.replace('{N}', String(n));
}

// 内部: Python サブプロセス起動 + stdin に JSON 渡し + stdout 解釈
function _runPython(input, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [PY_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`curl-cffi timeout ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); if (!killed) reject(e); });
    proc.on('close', () => {
      clearTimeout(timer);
      if (killed) return;
      try {
        const parsed = JSON.parse(out.trim());
        resolve(parsed);
      } catch (e) {
        reject(new Error(`json parse fail: ${e.message} | stdout: ${out.slice(0, 200)} | stderr: ${err.slice(0, 200)}`));
      }
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();
  });
}

// JSON / HTML 等のテキストを取得
//   opts.referer: Referer ヘッダ (デフォ 'https://www.google.com/')
//   opts.headers: 追加ヘッダ (Referer 含めて上書き可)
//   opts.useProxy: false で Webshare 経由しない VPS 直接続 (デバッグ用、通常 true)
//   opts.timeout: 秒 (デフォ 20)
//   opts.retries: リトライ回数 (デフォ 1)
//   opts.impersonate: chrome131 (デフォ)
//   返却: { ok, status, body, size, content_type } または例外
async function curlGet(url, opts = {}) {
  const proxy = opts.useProxy === false ? null : _pickProxy();
  const headers = {
    Referer: opts.referer || 'https://www.google.com/',
    ...(opts.headers || {}),
  };
  const input = {
    url,
    proxy,
    headers,
    timeout: opts.timeout || 20,
    impersonate: opts.impersonate || 'chrome131',
    retries: opts.retries == null ? 1 : opts.retries,
    binary: false,
  };
  return await _runPython(input, (opts.timeout || 20) * 1000 * 3);
}

// 画像取得（data:image/...;base64,... を返す）
//   失敗時は null
async function curlGetImage(url, opts = {}) {
  const proxy = opts.useProxy === false ? null : _pickProxy();
  const headers = {
    Referer: opts.referer || 'https://www.google.com/',
    ...(opts.headers || {}),
  };
  const input = {
    url,
    proxy,
    headers,
    timeout: opts.timeout || 20,
    impersonate: opts.impersonate || 'chrome131',
    retries: opts.retries == null ? 1 : opts.retries,
    binary: true,
  };
  try {
    const r = await _runPython(input, (opts.timeout || 20) * 1000 * 3);
    if (!r.ok || !r.body) return null;
    const mime = (r.content_type || 'image/png').split(';')[0];
    return `data:${mime};base64,${r.body}`;
  } catch (e) {
    return null;
  }
}

// JSON として取得（curlGet + JSON.parse）
//   失敗時は例外
async function curlGetJson(url, opts = {}) {
  const r = await curlGet(url, opts);
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}: ${(r.body || r.error || '').slice(0, 120)}`);
    err.status = r.status;
    throw err;
  }
  try {
    return JSON.parse(r.body);
  } catch (e) {
    const err = new Error(`not JSON: ${r.body.slice(0, 120)}`);
    err.status = r.status;
    throw err;
  }
}

module.exports = { curlGet, curlGetJson, curlGetImage };
