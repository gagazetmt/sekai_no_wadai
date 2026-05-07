// scripts/v2_video/utils/wiki_ja_kana.js
// 英字選手名 → ja.wikipedia.org 検索で公式カタカナ表記を取得
//
// 使い方:
//   const { nameToKana, nameToKanaSync, prefetchKanaBatch } = require('./wiki_ja_kana');
//   const kana = await nameToKana('Khvicha Kvaratskhelia');  // → 'フヴィチャ・クヴァラツヘリア'
//   const cached = nameToKanaSync('Khvicha Kvaratskhelia');   // 同期取得（キャッシュ済のみ）
//
// 仕組み:
//   1. ja.wiki search API で最初の 5 件取得
//   2. カタカナ含み率 40% 以上 + "・" を含む（フルネーム形式）の最初のヒットを採用
//   3. キャッシュ data/player_kana_cache.json に保存（次回以降即返し）
//   4. ヒットしなければ null（呼び出し元で原文 fallback）

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const CACHE_FILE = path.join(__dirname, '..', '..', '..', 'data', 'player_kana_cache.json');
const UA = 'SoccerYTBot/2.0 (soccer-yt-project)';

let _cache = null;

function _loadCache() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!_cache || typeof _cache !== 'object') _cache = { entries: {}, updatedAt: null };
    if (!_cache.entries) _cache.entries = {};
  } catch (_) {
    _cache = { entries: {}, updatedAt: null };
  }
  return _cache;
}

function _saveCache() {
  if (!_cache) return;
  _cache.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2));
  } catch (_) {}
}

// 英字（ASCII）+ 空白 + ハイフン/ピリオド/アポストロフィのみで構成されてるか
function isAllAscii(s) {
  if (!s) return false;
  return /^[\x00-\x7F\s.\-']+$/.test(String(s));
}

// タイトルが「選手名らしいカタカナフルネーム」か判定
//   - カタカナ含み率 40% 以上
//   - ひらがな含まない
//   - 漢字を含まない（記事タイトルの常用漢字）
//   - "・" or "＝" を含む（フルネーム形式の区切り）
function isPlayerLikeKana(title) {
  if (!title || title.length < 3) return false;
  const kana  = (title.match(/[ァ-ヶー]/g) || []).length;
  if (kana / title.length < 0.4) return false;
  if (/[ぁ-ん]|[一-龯]/.test(title)) return false;
  return title.includes('・') || title.includes('＝');
}

// 1名分: ja.wiki 検索 → カタカナフルネームを返す
async function nameToKana(englishName) {
  if (!englishName || !isAllAscii(englishName)) return null;
  const cache = _loadCache();
  const key = String(englishName).trim();
  if (key in cache.entries) {
    // キャッシュ済（'' は「過去にヒット無しと確認」を意味し再fetchを抑制）
    return cache.entries[key] || null;
  }

  const url = 'https://ja.wikipedia.org/w/api.php?action=query&list=search&srsearch='
    + encodeURIComponent(key) + '&format=json&srlimit=5';
  try {
    const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
    const hits = (res.data?.query?.search || []).map(h => h.title);
    const found = hits.find(isPlayerLikeKana) || null;
    cache.entries[key] = found || '';
    _saveCache();
    return found;
  } catch (e) {
    // 一時失敗はキャッシュしない（次回再試行可能に）
    return null;
  }
}

// 同期版: キャッシュからのみ取得（無ければ null）
//   matchcard / profile 等でテンプレ build が同期実装の場合に使う
function nameToKanaSync(englishName) {
  if (!englishName || !isAllAscii(englishName)) return null;
  const cache = _loadCache();
  const v = cache.entries[String(englishName).trim()];
  return v || null;
}

// 複数まとめて prefetch（matchcard build 前に呼んでキャッシュを温める）
//   並列度 3 で過剰負荷防止
async function prefetchKanaBatch(names) {
  if (!Array.isArray(names) || !names.length) return;
  const unique = [...new Set(names.filter(isAllAscii))];
  const queue = unique.slice();
  async function _worker() {
    while (queue.length) {
      const n = queue.shift();
      await nameToKana(n);
      // ja.wiki への過剰アクセス防止に小休止
      await new Promise(r => setTimeout(r, 250));
    }
  }
  await Promise.all([_worker(), _worker(), _worker()]);
}

module.exports = { nameToKana, nameToKanaSync, prefetchKanaBatch, isAllAscii };
