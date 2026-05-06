// scripts/utilities/fetch_player_jp.js
// Wikipedia langlinks API で英語選手名 → 日本語カタカナ表記を取得
//
// 仕組み:
//   1. en.wikipedia.org の MediaWiki API で titles=<name> & lllang=ja
//   2. langlinks[0]['*'] が日本語版タイトル (= カタカナ表記想定)
//   3. data/player_names_jp_cache.json にキャッシュ書出
//   4. lookup → cache hit → static dict 順で短絡
//
// 使い方:
//   const { fetchPlayerJp, lookupCachedKatakana, prefetchPlayerNames } = require('./fetch_player_jp');
//
//   const ja = await fetchPlayerJp('Bukayo Saka');         // → 'ブカヨ・サカ'
//   const ja2 = lookupCachedKatakana('Mohamed Salah');     // → 'モハメド・サラー' (cache のみ)
//   await prefetchPlayerNames(['A','B','C']);              // 不足分をまとめて fetch

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const CACHE_PATH = path.join(__dirname, '..', '..', 'data', 'player_names_jp_cache.json');
const CACHE_NEG  = '__NOT_FOUND__';   // ja 版が存在しない → 再 fetch スキップマーカー

let _cache = null;
function _loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); }
  catch (_) { _cache = {}; }
  return _cache;
}
function _saveCache() {
  if (!_cache) return;
  try {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(_cache, null, 2));
  } catch (e) {
    console.warn('[fetch_player_jp] cache save failed:', e.message);
  }
}

function _fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'soccer-yt-pipeline/1.0 (research)' },
      timeout: 12000,
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

async function fetchPlayerJp(name) {
  if (!name) return null;
  const cache = _loadCache();
  if (Object.prototype.hasOwnProperty.call(cache, name)) {
    const v = cache[name];
    return v === CACHE_NEG ? null : v;
  }

  const titleEnc = encodeURIComponent(String(name).replace(/\s+/g, '_'));
  const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${titleEnc}&prop=langlinks&lllang=ja&format=json&redirects=1`;
  let result = null;
  try {
    const j = await _fetchJson(url);
    const pages = j?.query?.pages || {};
    for (const pid of Object.keys(pages)) {
      const links = pages[pid].langlinks;
      if (Array.isArray(links) && links.length) {
        result = links[0]['*'] || null;
        break;
      }
    }
  } catch (e) {
    // 一過性失敗は cache せず（次回再試行）
    return null;
  }

  cache[name] = result || CACHE_NEG;
  _saveCache();
  return result;
}

function lookupCachedKatakana(name) {
  if (!name) return null;
  const cache = _loadCache();
  const v = cache[name];
  if (v === undefined) return null;
  return v === CACHE_NEG ? null : v;
}

// 並列 4 で不足分のみ fetch（既キャッシュはスキップ）
async function prefetchPlayerNames(names) {
  if (!Array.isArray(names) || !names.length) return { hit: 0, fetched: 0, missed: 0 };
  const cache = _loadCache();
  const missing = [...new Set(names.filter(Boolean))]
    .filter(n => !Object.prototype.hasOwnProperty.call(cache, n));

  let hit = names.filter(n => Object.prototype.hasOwnProperty.call(cache, n)).length;
  let fetched = 0, missed = 0;
  const queue = missing.slice();
  const POOL  = 4;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (queue.length) {
      const n = queue.shift();
      const r = await fetchPlayerJp(n).catch(() => null);
      if (r) fetched++; else missed++;
    }
  }));
  return { hit, fetched, missed, total: names.length };
}

module.exports = {
  fetchPlayerJp,
  lookupCachedKatakana,
  prefetchPlayerNames,
  CACHE_PATH,
};

// CLI for testing / bulk warm-up
if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    console.log('Usage: node fetch_player_jp.js "Bukayo Saka"');
    console.log('       node fetch_player_jp.js --bulk Bukayo_Saka,Mohamed_Salah,...');
    process.exit(0);
  }
  if (arg === '--bulk') {
    const names = (process.argv[3] || '').split(',').map(s => s.replace(/_/g, ' ').trim()).filter(Boolean);
    prefetchPlayerNames(names).then(r => console.log(r));
  } else {
    fetchPlayerJp(arg.replace(/_/g, ' ')).then(r => console.log(arg, '→', r));
  }
}
