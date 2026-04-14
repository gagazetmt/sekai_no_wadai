// scripts/modules/fetchers/serper_module.js
// Serper (Google検索API) でモジュール用データを取得
// 既存の Serper 実装と同じキーを使用

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env'), quiet: true });

async function fetchSerper(query, moduleId = '', lang = 'en') {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return { ok: false, error: 'SERPER_API_KEY が設定されていません' };
  if (!query)  return { ok: false, error: '検索クエリが未指定' };

  try {
    const res = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: {
        'X-API-Key':    apiKey,
        'Content-Type': 'application/json',
      },
      body:   JSON.stringify({ q: query, num: 6, hl: lang, gl: lang === 'ja' ? 'jp' : 'us' }),
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) return { ok: false, error: `Serper HTTP ${res.status}` };
    const data = await res.json();

    return {
      ok:             true,
      moduleId,
      query,
      organic:        (data.organic || []).map(r => ({
        title:   r.title,
        snippet: r.snippet,
        link:    r.link,
        date:    r.date || null,
      })),
      answerBox:      data.answerBox      || null,
      knowledgeGraph: data.knowledgeGraph || null,
      topStories:     (data.topStories    || []).slice(0, 3),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 英語と日本語で並列検索し、両方の結果を返す
async function fetchSerperBilingual(queryEn, queryJa, moduleId = '') {
  const [en, ja] = await Promise.all([
    fetchSerper(queryEn, moduleId, 'en'),
    fetchSerper(queryJa, moduleId, 'ja'),
  ]);
  return { ok: en.ok || ja.ok, en, ja, moduleId };
}

module.exports = { fetchSerper, fetchSerperBilingual };
