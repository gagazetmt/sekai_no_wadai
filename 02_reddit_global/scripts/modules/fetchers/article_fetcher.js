// scripts/modules/fetchers/article_fetcher.js
// SerperのURL上位N件から記事本文を取得してSerper結果に付加する
// 失敗してもSerperスニペットにフォールバックするのでエラーにならない

const axios = require('axios');
const cheerio = require('cheerio');
const { curlGet } = require('./_curl_cffi_caller');

const FETCH_TIMEOUT = 9000;  // 1記事あたり9秒でタイムアウト
const MAX_CHARS     = 30000; // 1記事あたりの最大文字数（呼び出し側で総量制限）

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

function normalizeArticleText(text) {
  return String(text || '')
    .replace(/^Title:\s*.+?\n+/i, '')
    .replace(/^URL Source:\s*.+?\n+/im, '')
    .replace(/^Markdown Content:\s*/im, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/(Share|Subscribe|Advertisement|Related Articles)\s+/gi, '')
    .trim();
}

function isYahooNewsUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)news\.yahoo\.co\.jp$/i.test(u.hostname) && /\/articles\//.test(u.pathname);
  } catch (_) {
    return false;
  }
}

function cleanYahooText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/この記事はいかがでしたか。?.*$/g, '')
    .replace(/最終更新:.+$/g, '')
    .trim();
}

function uniqueTexts(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const text = cleanYahooText(raw);
    const key = text.replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function extractYahooArticleBody(html) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, header, footer, aside').remove();

  const selectors = [
    'article p',
    'main article p',
    '[data-testid*="article"] p',
    '[class*="ArticleBody"] p',
    '[class*="articleBody"] p',
    '[class*="article_body"] p',
    'main p',
  ];

  for (const selector of selectors) {
    const paragraphs = uniqueTexts($(selector).map((_, el) => $(el).text()).get())
      .filter((t) => t.length >= 20 && !/^(関連記事|おすすめ|もっと見る|コメント|シェア|写真|画像)/.test(t));
    const text = paragraphs.join('\n');
    if (text.length >= 120) return text;
  }

  const meta = $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '';
  return cleanYahooText(meta);
}

function _isYahooComment(text) {
  // 除外: UI系テキスト
  if (/^(コメント|返信|共感した|なるほど|うーん|ログイン|表示順|投稿|違反報告|もっと見る)/.test(text)) return false;
  if (/Yahoo!ニュース|利用規約|プライバシー|ヘルプ|ニュース一覧/.test(text)) return false;
  // 除外: 関連記事タイトル — 文末に「。！？」がなく短い or 「…」が途中に入って文末記号なし
  const hasSentenceEnd = /[。！？]/.test(text);
  const hasMidEllipsis = /…/.test(text) && !hasSentenceEnd;
  if (hasMidEllipsis) return false;
  // 除外: 60字未満かつ文末記号なし → ニュース見出しの典型
  if (text.length < 60 && !hasSentenceEnd) return false;
  return true;
}

function extractYahooComments(html, limit = 12) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, header, footer, aside').remove();

  const candidates = [];
  const selectors = [
    '[class*="Comment"] p',
    '[class*="comment"] p',
    '[data-testid*="comment"]',
    'li p',
    'article p',
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const text = cleanYahooText($(el).text());
      if (text.length < 24 || text.length > 700) return;
      if (!/[ぁ-んァ-ン一-龥]/.test(text)) return;
      if (!_isYahooComment(text)) return;
      candidates.push(text);
    });
    if (candidates.length >= limit) break;
  }

  return uniqueTexts(candidates).slice(0, limit);
}

// Yahoo News は VPS IP が 403 されるため curl-cffi + Webshare JP proxy 経由で取得
async function fetchYahooNewsArticle(url) {
  try {
    const r = await curlGet(url, {
      referer: 'https://news.yahoo.co.jp/',
      headers: { 'Accept-Language': 'ja,en;q=0.9' },
      timeout: 15,
    });
    if (!r.ok) return { ok: false, url, method: 'yahoo_news' };

    const body = extractYahooArticleBody(String(r.body));
    if (body.length < 60) return { ok: false, url, method: 'yahoo_news' };

    let comments = [];
    const commentsUrl = url.replace(/\/comments(?:\?.*)?$/, '').replace(/([?#].*)$/, '') + '/comments';
    try {
      const cr = await curlGet(commentsUrl, {
        referer: url,
        headers: { 'Accept-Language': 'ja,en;q=0.9' },
        timeout: 12,
      });
      if (cr.ok) comments = extractYahooComments(String(cr.body), 12);
    } catch (_) {}

    const commentBlock = comments.length
      ? `\n\n【Yahooコメント欄】\n${comments.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : '';
    const content = normalizeArticleText(`${body}${commentBlock}`);
    return {
      ok: true,
      url,
      content: content.slice(0, MAX_CHARS),
      method: 'yahoo_news',
      comments,
      commentsUrl,
    };
  } catch (_) {
    return { ok: false, url, method: 'yahoo_news' };
  }
}

async function fetchViaJinaReader(url) {
  try {
    const res = await axios.get(`https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`, {
      headers: HEADERS,
      timeout: FETCH_TIMEOUT,
      maxRedirects: 3,
      responseType: 'text',
    });
    const text = normalizeArticleText(String(res.data));
    if (/^Warning:\s*Target URL returned error/i.test(text)) {
      return { ok: false, url, method: 'jina_reader' };
    }
    if (text.length < 160) return { ok: false, url, method: 'jina_reader' };
    return { ok: true, url, content: text.slice(0, MAX_CHARS), method: 'jina_reader' };
  } catch (_) {
    return { ok: false, url, method: 'jina_reader' };
  }
}

// 単一URLから記事本文を取得
async function fetchArticleContent(url) {
  if (!url) return { ok: false };
  if (isYahooNewsUrl(url)) {
    const yahoo = await fetchYahooNewsArticle(url);
    if (yahoo.ok) return yahoo;
  }
  try {
    const res = await axios.get(url, {
      headers:      HEADERS,
      timeout:      FETCH_TIMEOUT,
      maxRedirects: 3,
      responseType: 'text',
    });
    const text = normalizeArticleText(extractText(String(res.data)));
    if (text.length >= 160) return { ok: true, url, content: text.slice(0, MAX_CHARS), method: 'direct' };
  } catch (_) {
    // fall through to reader fallback
  }
  return await fetchViaJinaReader(url);
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
