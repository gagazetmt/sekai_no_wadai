// scripts/modules/fetchers/wikipedia.js
// Wikipedia REST API でテキスト・要約を取得（無料・安定）
//
// 使用API: https://en.wikipedia.org/api/rest_v1/page/summary/{title}

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
      description: d.description  || '',  // 短い説明（例: "Norwegian professional footballer"）
      extract:     d.extract      || '',  // 数段落のプレーンテキスト要約
      thumbnail:   d.thumbnail?.source || null,
      url:         d.content_urls?.desktop?.page || '',
      type:        d.type,
    };
  } catch (e) {
    if (e.response?.status === 404) return { ok: false, error: `Wikipedia に "${nameEn}" が見つかりません` };
    return { ok: false, error: e.message };
  }
}

// 複数の候補名でフォールバック検索（最初に成功したものを返す）
async function fetchWikipediaSafe(candidates) {
  const names = Array.isArray(candidates) ? candidates : [candidates];
  for (const name of names) {
    if (!name) continue;
    const r = await fetchWikipedia(name);
    if (r.ok && r.extract && r.extract.length > 50) return r;
  }
  return { ok: false, error: `取得できませんでした: ${names.join(', ')}` };
}

module.exports = { fetchWikipedia, fetchWikipediaSafe };
