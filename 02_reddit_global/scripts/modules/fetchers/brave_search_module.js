// scripts/modules/fetchers/brave_search_module.js
// Brave Search API — Serper互換インターフェース
// fetchSerper / fetchSerperBilingual と同じ戻り値形式で差し替え可能

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env'), quiet: true });

async function fetchBraveSearch(query, moduleId = '', lang = 'en', _tbs = null, extraParams = {}) {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return { ok: false, error: 'BRAVE_API_KEY が設定されていません' };
  if (!query)  return { ok: false, error: '検索クエリが未指定' };

  const count       = extraParams.num || 10;
  // Brave Search API: 日本語は search_lang='jp'（'ja'は422エラー）
  const searchLang  = lang === 'ja' ? 'jp' : lang;
  const country     = lang === 'ja' ? 'JP' : 'US';

  try {
    const params = new URLSearchParams({
      q:           query,
      count:       String(count),
      search_lang: searchLang,
      country,
      safesearch:  'moderate',
    });

    // site: 絞り込みは query に含まれるのでそのままでOK
    const res = await fetch('https://api.search.brave.com/res/v1/web/search?' + params.toString(), {
      headers: {
        'Accept':              'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) return { ok: false, error: `Brave Search HTTP ${res.status}` };
    const data = await res.json();

    const organic = (data.web?.results || []).map(r => ({
      title:   r.title   || '',
      snippet: r.description || '',
      link:    r.url     || '',
      date:    r.age     || null,
    }));

    return {
      ok: true,
      moduleId,
      query,
      organic,
      answerBox:      null,
      knowledgeGraph: null,
      topStories:     [],
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Serper互換: 英語・日本語並列検索
async function fetchBraveSearchBilingual(queryEn, queryJa, moduleId = '') {
  const [en, ja] = await Promise.all([
    fetchBraveSearch(queryEn, moduleId, 'en'),
    fetchBraveSearch(queryJa, moduleId, 'ja'),
  ]);
  return { ok: en.ok || ja.ok, en, ja, moduleId };
}

// Serper互換エイリアス（差し替えをimport1行で済ませるため）
const fetchSerper           = fetchBraveSearch;
const fetchSerperBilingual  = fetchBraveSearchBilingual;

module.exports = { fetchBraveSearch, fetchBraveSearchBilingual, fetchSerper, fetchSerperBilingual };
