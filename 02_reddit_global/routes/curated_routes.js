// routes/curated_routes.js
// ─── Curated RAG API ─────────────────────────────────────────
// 良質サッカーサイト群から関連記事本文を取得する API。
// Step3 / Step4 から呼ばれて scriptDir / narration の材料に使う。
//
// エンドポイント:
//   POST /api/v3/curated-research { keywords[], layers?, maxItems?, maxFetch? }
//   GET  /api/v3/curated-sources     有効ソース一覧
//
// コスト: ¥0 (HTTP fetch のみ)

const express = require('express');
const router  = express.Router();

const {
  loadSources,
  searchCuratedArticles,
  formatForPrompt,
} = require('../scripts/modules/curated_articles');

// POST /api/v3/curated-research
//   body: { keywords: [string], layers?: [string], maxItems?: number, maxFetch?: number }
router.post('/v3/curated-research', async (req, res) => {
  const t0 = Date.now();
  try {
    const { keywords, query, layers, maxItems, maxFetch } = req.body || {};
    const kws = Array.isArray(keywords) ? keywords : (query ? [query] : []);
    if (kws.length === 0) {
      return res.status(400).json({ error: 'keywords (or query) required' });
    }
    const articles = await searchCuratedArticles({
      keywords: kws,
      layers,
      maxItems: maxItems || 10,
      maxFetch: maxFetch || 5,
    });
    const promptBlock = formatForPrompt(articles);
    res.json({
      ok: true,
      keywords: kws,
      count: articles.length,
      elapsedMs: Date.now() - t0,
      articles,
      promptBlock,
    });
  } catch (e) {
    console.error('[curated/research]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v3/curated-sources
router.get('/v3/curated-sources', (req, res) => {
  res.json({ sources: loadSources() });
});

module.exports = { router };
