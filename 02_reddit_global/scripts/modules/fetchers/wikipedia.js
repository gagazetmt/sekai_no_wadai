// scripts/modules/fetchers/wikipedia.js
// Wikipedia REST API でテキスト・要約を取得（無料・安定）
//
// 使用API:
//   直接: https://en.wikipedia.org/api/rest_v1/page/summary/{title}
//   検索: https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}

const axios = require('axios');

const HEADERS = {
  'User-Agent': 'SoccerYTBot/2.0 (soccer-yt-project)',
  'Accept':     'application/json',
};

// 単一タイトルでWikipedia要約を取得
async function fetchWikipedia(nameEn) {
  if (!nameEn) return { ok: false, error: '名前が未指定' };

  const title = encodeURIComponent(nameEn.trim().replace(/ /g, '_'));
  try {
    const res = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,
      { headers: HEADERS, timeout: 10000 }
    );
    const d = res.data;

    // disambiguation（曖昧さ回避ページ）は除外
    if (d.type === 'disambiguation') {
      return { ok: false, error: `${nameEn} は曖昧さ回避ページです` };
    }

    return {
      ok:          true,
      title:       d.title        || nameEn,
      description: d.description  || '',
      extract:     d.extract      || '',
      thumbnail:   d.thumbnail?.source || null,
      url:         d.content_urls?.desktop?.page || '',
      type:        d.type,
    };
  } catch (e) {
    if (e.response?.status === 404) return { ok: false, error: `Wikipedia に "${nameEn}" が見つかりません` };
    return { ok: false, error: e.message };
  }
}

// MediaWiki Search API で検索 → 上位ヒットのタイトルリストを返す
async function searchWikipediaTitles(query, limit = 3) {
  try {
    const res = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action:   'query',
        list:     'search',
        srsearch: query,
        srlimit:  limit,
        format:   'json',
        origin:   '*',
      },
      headers: HEADERS,
      timeout: 10000,
    });
    return (res.data?.query?.search || []).map(r => r.title);
  } catch (e) {
    return [];
  }
}

// 複数の候補名でフォールバック検索（最初に成功したものを返す）
// ① 各candidateを直接検索
// ② 全て失敗した場合、最初のcandidateでSearch APIを叩いてヒットしたタイトルを試す
async function fetchWikipediaSafe(candidates) {
  const names = Array.isArray(candidates) ? candidates : [candidates];

  // ── ① 直接タイトル検索 ───────────────────────────────────────────────────
  for (const name of names) {
    if (!name) continue;
    const r = await fetchWikipedia(name);
    if (r.ok && r.extract && r.extract.length > 50) return r;
  }

  // ── ② Search API フォールバック ──────────────────────────────────────────
  // 最初の有効な候補でSearch APIを使い、ヒットしたタイトルをさらに試す
  const primaryQuery = names.find(n => n) || '';
  if (primaryQuery) {
    const searchTitles = await searchWikipediaTitles(primaryQuery);
    for (const title of searchTitles) {
      const r = await fetchWikipedia(title);
      if (r.ok && r.extract && r.extract.length > 50) {
        console.log(`[wikipedia] Search fallback hit: "${primaryQuery}" → "${title}"`);
        return r;
      }
    }
  }

  return { ok: false, error: `取得できませんでした: ${names.join(', ')}` };
}

module.exports = { fetchWikipedia, fetchWikipediaSafe, searchWikipediaTitles };
