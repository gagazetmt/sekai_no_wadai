// scripts/modules/curated_articles.js
// ═══════════════════════════════════════════════════════════════
// Curated RAG: 良質サッカーサイト群から関連記事を収集する
//
// パイプライン:
//   1. config/curated_sources.json の enabled サイトから RSS 取得
//   2. 各 RSS フィードを最小依存パーサで items に分解
//   3. クエリ語句マッチで関連 items を抽出 (タイトル + description)
//   4. 上位 N 件の URL を article_fetcher で本文取得
//   5. 出典タグ付きで返却
//
// コスト: ¥0 (HTTP fetch のみ・AI 呼び出しなし・Serper も使わない)
//
// 既存 article_fetcher.js を流用 (本文取得 + フォールバック)
// ═══════════════════════════════════════════════════════════════

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { fetchArticleContent } = require('./fetchers/article_fetcher');

const SOURCES_FILE = path.join(__dirname, '..', '..', 'config', 'curated_sources.json');

let _sourcesCache = null;
let _sourcesLoadedAt = 0;
function loadSources() {
  // 60秒キャッシュ (頻繁な再読み込み回避)
  if (_sourcesCache && Date.now() - _sourcesLoadedAt < 60000) return _sourcesCache;
  try {
    const raw = fs.readFileSync(SOURCES_FILE, 'utf8');
    const data = JSON.parse(raw);
    _sourcesCache = (data.sources || []).filter(s => s.enabled && s.feedUrl);
    _sourcesLoadedAt = Date.now();
    return _sourcesCache;
  } catch (e) {
    console.warn('[curated] sources load 失敗:', e.message);
    return [];
  }
}

// ─── RSS パース (regex ベース、依存ゼロ) ─────────────────────
function _stripCData(s) {
  if (!s) return '';
  return String(s).replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}
function _decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function _extractTag(itemXml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = itemXml.match(re);
  return m ? _decodeEntities(_stripCData(m[1])) : '';
}
function _extractLink(itemXml) {
  // RSS: <link>URL</link>  /  Atom: <link href="URL"/>
  const m1 = itemXml.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
  if (m1 && m1[1].trim()) return _decodeEntities(_stripCData(m1[1])).trim();
  const m2 = itemXml.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (m2) return _decodeEntities(m2[1]).trim();
  return '';
}
function parseRss(xml) {
  if (!xml) return [];
  const items = [];
  // RSS 2.0 <item> も Atom <entry> も両対応
  const itemRe = /<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi;
  const matches = xml.match(itemRe) || [];
  for (const block of matches) {
    const title = _extractTag(block, 'title');
    const link  = _extractLink(block);
    const pubDate = _extractTag(block, 'pubDate') || _extractTag(block, 'published') || _extractTag(block, 'updated');
    const description = _extractTag(block, 'description') || _extractTag(block, 'summary') || _extractTag(block, 'content');
    if (!title && !link) continue;
    items.push({ title, link, pubDate, description: stripHtmlTags(description).slice(0, 400) });
  }
  return items;
}
function stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// ─── 1 サイトの RSS 取得 + パース ─────────────────────────────
async function fetchSourceFeed(source) {
  try {
    const res = await axios.get(source.feedUrl, {
      timeout: 8000,
      maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':     'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
      },
      responseType: 'text',
    });
    const items = parseRss(String(res.data));
    return items.map(it => ({
      ...it,
      sourceId:   source.id,
      sourceName: source.name,
      layer:      source.layer,
      language:   source.language,
    }));
  } catch (e) {
    console.warn(`[curated] feed 失敗 ${source.id} (${source.feedUrl}): ${e.message}`);
    return [];
  }
}

// ─── 全 enabled サイトから並列取得 ────────────────────────────
async function fetchAllFeeds(opts = {}) {
  const sources = loadSources();
  const layers  = opts.layers;   // ['speed','tactics'] 等で絞り込み可。 未指定なら全レイヤー
  const filtered = Array.isArray(layers) && layers.length
    ? sources.filter(s => layers.includes(s.layer))
    : sources;
  console.log(`[curated] feed 並列取得開始: ${filtered.length} サイト (layers=${layers || 'all'})`);
  const all = await Promise.all(filtered.map(fetchSourceFeed));
  const flat = all.flat();
  console.log(`[curated] feed 取得完了: ${flat.length} items 合計`);
  return flat;
}

// ─── マッチング ──────────────────────────────────────────────
//   キーワード配列を渡し、 タイトル + description に含まれる items を抽出。
//   スコア = ヒット語数 × 3 (タイトル) + ヒット語数 (description) + 直近性ボーナス
function scoreItem(item, keywords) {
  const t = String(item.title || '').toLowerCase();
  const d = String(item.description || '').toLowerCase();
  let score = 0;
  for (const kw of keywords) {
    const k = String(kw || '').toLowerCase().trim();
    if (!k) continue;
    if (t.includes(k)) score += 3;
    if (d.includes(k)) score += 1;
  }
  // 直近性ボーナス: 過去 7 日以内なら +2、 24h 以内なら +5
  try {
    const pub = new Date(item.pubDate);
    if (!isNaN(pub.getTime())) {
      const ageHrs = (Date.now() - pub.getTime()) / 3600000;
      if (ageHrs < 24)  score += 5;
      else if (ageHrs < 168) score += 2;
    }
  } catch (_) {}
  return score;
}
function pickRelevantItems(items, keywords, maxItems = 10) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const scored = items
    .map(it => ({ ...it, _score: scoreItem(it, keywords) }))
    .filter(it => it._score > 0);
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, maxItems);
}

// ─── 本文取得 (article_fetcher 流用、 並列) ───────────────────
async function enrichWithContent(items, opts = {}) {
  const maxFetch = opts.maxFetch || 5;
  const target = items.slice(0, maxFetch);
  console.log(`[curated] 本文取得開始: ${target.length} 記事`);
  const results = await Promise.all(target.map(async it => {
    if (!it.link) return { ...it, content: null };
    const art = await fetchArticleContent(it.link);
    return { ...it, content: art.ok ? art.content : null };
  }));
  const ok = results.filter(r => r.content).length;
  console.log(`[curated] 本文取得完了: ${ok}/${target.length} 成功`);
  return results;
}

// ─── メイン: キーワード → 関連記事本文 ─────────────────────────
//   返り値: [{ title, link, pubDate, sourceId, sourceName, layer, language, content, _score }, ...]
async function searchCuratedArticles(opts = {}) {
  const keywords = Array.isArray(opts.keywords) && opts.keywords.length
    ? opts.keywords
    : (opts.query ? [opts.query] : []);
  if (keywords.length === 0) {
    console.warn('[curated] keywords 未指定');
    return [];
  }
  const layers   = opts.layers;      // ['speed','story',...] or undefined
  const maxItems = opts.maxItems || 10;
  const maxFetch = opts.maxFetch || 5;

  const allItems = await fetchAllFeeds({ layers });
  const relevant = pickRelevantItems(allItems, keywords, maxItems);
  if (relevant.length === 0) {
    console.log(`[curated] 関連記事 0 件 (keywords=${keywords.join(',')})`);
    return [];
  }
  console.log(`[curated] 関連記事 ${relevant.length} 件 (上位スコア: ${relevant.slice(0, 3).map(r => r._score).join(',')})`);
  return await enrichWithContent(relevant, { maxFetch });
}

// ─── プロンプト用ブロック整形 ─────────────────────────────────
function formatForPrompt(articles, maxChars = 8000) {
  if (!articles || articles.length === 0) return '';
  const parts = [];
  let totalLen = 0;
  for (const a of articles) {
    const body = a.content
      ? a.content.slice(0, 1200)
      : (a.description || '').slice(0, 300);
    if (!body) continue;
    const date = a.pubDate ? `(${String(a.pubDate).slice(0, 16)})` : '';
    const block = `【${a.sourceName} ${date}】 ${a.title}\nURL: ${a.link}\n${body}`;
    if (totalLen + block.length > maxChars) break;
    parts.push(block);
    totalLen += block.length;
  }
  if (parts.length === 0) return '';
  // 2026-05-25: 明示活用ルール追加。 これまで「読んだ気にだけなる」現象を回避し、
  //   narration / dataSlots に積極的に記事の数字・引用・固有名詞を取り込ませる。
  const usageRule = [
    '【この記事群の活用ルール（厳守）】',
    '- 記事中の **具体的な数字 / 引用 / 固有名詞 / 発言** は narration に積極的に取り込む（特に「○○ 発言」「現地報道」のような熱量ある表現）',
    '- 案件タイトル・本文と矛盾する記事内容は無視（最新の方を優先）',
    '- 記事の出典名（サイト名）は表示しない。 narration では「現地メディアによると」「報道では」程度に抽象化',
    '- 推測ベース（「○○の可能性」「移籍が噂される」）と確定情報（「○月○日に発表」「契約締結」）は narration でも区別して書く',
    '- どの記事も使えない場合は無視して OK（無理に引用しない）',
  ].join('\n');
  return `━━━ 📚 Curated Web リサーチ結果 (良質サイト本文) ━━━\n${usageRule}\n\n${parts.join('\n\n---\n\n')}\n━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

module.exports = {
  loadSources,
  parseRss,
  fetchSourceFeed,
  fetchAllFeeds,
  pickRelevantItems,
  enrichWithContent,
  searchCuratedArticles,
  formatForPrompt,
};
