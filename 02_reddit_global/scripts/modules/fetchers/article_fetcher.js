// scripts/modules/fetchers/article_fetcher.js
// SerperのURL上位N件から記事本文を取得してSerper結果に付加する
// 失敗してもSerperスニペットにフォールバックするのでエラーにならない

const axios = require('axios');

const FETCH_TIMEOUT = 5000;  // 1記事あたり5秒でタイムアウト
const MAX_CHARS     = 1500;  // 1記事あたりの最大文字数

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,ja;q=0.8',
};

// HTMLから本文テキストを抽出
function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 単一URLから記事本文を取得
async function fetchArticleContent(url) {
  if (!url) return { ok: false };
  try {
    const res = await axios.get(url, {
      headers:      HEADERS,
      timeout:      FETCH_TIMEOUT,
      maxRedirects: 3,
      responseType: 'text',
    });
    const text = extractText(String(res.data));
    if (text.length < 100) return { ok: false, url };  // 中身がほぼないページはスキップ
    return { ok: true, url, content: text.slice(0, MAX_CHARS) };
  } catch (_) {
    return { ok: false, url };
  }
}

// Serper結果のURL上位topN件から記事本文を並列取得してserperResultに付加
// → serperResult.articleContent にまとめたテキストが入る
async function enrichSerperWithArticles(serperResult, topN = 2) {
  if (!serperResult?.organic?.length) return serperResult;

  const urls = (serperResult.organic)
    .slice(0, topN)
    .map(r => r.link)
    .filter(Boolean);

  const articles = await Promise.all(urls.map(fetchArticleContent));

  const articleContent = articles
    .filter(a => a.ok && a.content)
    .map(a => `[出典: ${a.url}]\n${a.content}`)
    .join('\n\n---\n\n');

  return {
    ...serperResult,
    articleContent: articleContent || null,
  };
}

module.exports = { fetchArticleContent, enrichSerperWithArticles };
