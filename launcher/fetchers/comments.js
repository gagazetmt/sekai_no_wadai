// launcher/fetchers/comments.js
// 3ソースからリアルコメントを収集: Reddit / Yahoo News / X
// V4 v4_neta.js + article_fetcher.js から必要ロジックのみ移植

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const cheerio = require('cheerio');
const { curlGet } = require('./_curl_cffi_caller');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const REDDIT_COOKIE = process.env.REDDIT_SESSION_COOKIE || '';
const X_API_KEY     = process.env.TWITTER_API_IO_KEY    || '';

// ── 共通ユーティリティ ──────────────────────────────────

function _clean(value, maxLen = 280) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function _unique(values, limit) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = _clean(value);
    const key = text.toLowerCase().replace(/[\s。、！？!?.,・「」『』（）()]+/g, '');
    if (text.length < 8 || key.length < 6 || /[�]/.test(text) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

// ── 日本語トピック → Reddit検索用英語クエリ ────────────

const JA_EN_MAP = [
  [/日本代表|日本/, 'Japan'],
  [/W杯|ワールドカップ|世界杯/, 'World Cup'],
  [/2026/, '2026'],
  [/グループステージ|GS/, 'group stage'],
  [/決勝トーナメント/, 'knockout'],
  [/決勝/, 'final'],
  [/準決勝/, 'semi-final'],
  [/準々決勝/, 'quarter-final'],
  [/ベスト16/, 'round of 16'],
  [/移籍/, 'transfer'],
  [/怪我|負傷/, 'injury'],
  [/引退/, 'retirement'],
  [/監督/, 'manager coach'],
  [/ゴール|得点/, 'goal'],
  [/ハットトリック/, 'hat-trick'],
  [/ドリブル/, 'dribble'],
  [/アシスト/, 'assist'],
  [/レッドカード|退場/, 'red card'],
  [/VAR/, 'VAR'],
  [/PK|ペナルティ/, 'penalty'],
  [/プレミアリーグ/, 'Premier League'],
  [/ラ・?リーガ|リーガ/, 'La Liga'],
  [/セリエA/, 'Serie A'],
  [/ブンデスリーガ/, 'Bundesliga'],
  [/チャンピオンズリーグ|CL/, 'Champions League'],
  [/ヨーロッパリーグ|EL/, 'Europa League'],
];

function _toEnglishQuery(topic) {
  const words = [];
  for (const [re, en] of JA_EN_MAP) {
    if (re.test(topic)) words.push(en);
  }
  const ascii = topic.replace(/[ぁ-んァ-ヶ一-龥々ー　]/g, ' ').replace(/\s+/g, ' ').trim();
  if (ascii) words.push(ascii);
  return words.join(' ').trim();
}

// ── Reddit ──────────────────────────────────────────────

function _isReaction(text) {
  const signal = /思う|思っ|残念|嬉し|悲し|すご|凄|ヤバ|やば|最高|期待|心配|驚|好き|嫌い|頑張|lol|lmao|damn|crazy|insane|goat|beast|legend|class|wow|love|hate|hope/i;
  return signal.test(text);
}

async function fromReddit(topic, enQuery = '') {
  const searchTerm = enQuery || _toEnglishQuery(topic) || topic;
  if (!searchTerm) return [];

  try {
    console.log(`  [comments/reddit] 検索: "${searchTerm}"`);
    const searchUrl = `https://www.reddit.com/r/soccer/search.json?q=${encodeURIComponent(searchTerm)}&sort=new&restrict_sr=1&limit=5&t=week`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': UA, ...(REDDIT_COOKIE ? { Cookie: REDDIT_COOKIE } : {}) },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { console.warn(`  [comments/reddit] search ${res.status}`); return []; }

    const data = await res.json();
    const posts = data?.data?.children || [];
    const permalinks = posts.slice(0, 3).map(p => p.data?.permalink).filter(Boolean);

    const threadResults = await Promise.all(permalinks.map(async (permalink) => {
      try {
        const threadRes = await fetch(`https://www.reddit.com${permalink}.json?limit=30&sort=top`, {
          headers: { 'User-Agent': UA, ...(REDDIT_COOKIE ? { Cookie: REDDIT_COOKIE } : {}) },
          signal: AbortSignal.timeout(10000),
        });
        if (!threadRes.ok) return [];
        const threadData = await threadRes.json();
        return (threadData?.[1]?.data?.children || [])
          .filter(c => c.kind === 't1' && c.data?.body && c.data.body !== '[deleted]')
          .map(c => String(c.data.body).replace(/\n+/g, ' ').trim())
          .filter(t => t.length >= 15 && t.length <= 280);
      } catch (_) { return []; }
    }));

    const comments = _unique(threadResults.flat(), 25);
    console.log(`  [comments/reddit] → ${comments.length} comments`);
    return comments.map(text => ({ text, source: 'reddit' }));
  } catch (e) {
    console.warn(`  [comments/reddit] 失敗: ${e.message}`);
    return [];
  }
}

// ── Yahoo News ──────────────────────────────────────────

function _cleanYahoo(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/この記事はいかがでしたか。?.*$/g, '')
    .replace(/最終更新:.+$/g, '')
    .trim();
}

function _isYahooComment(text) {
  if (/^(コメント|返信|共感した|なるほど|うーん|ログイン|表示順|投稿|違反報告|もっと見る)/.test(text)) return false;
  if (/Yahoo!ニュース|利用規約|プライバシー|ヘルプ|ニュース一覧/.test(text)) return false;
  if (/^【/.test(text)) return false;
  const hasSentenceEnd = /[。！？]/.test(text);
  if (/…/.test(text) && !hasSentenceEnd) return false;
  if (/[へかもを]$|現実$|決断$|発覚$|浮上$|判明$|見通し$/.test(text) && !hasSentenceEnd) return false;
  if (text.length < 60 && !hasSentenceEnd) return false;
  return true;
}

function _extractYahooComments(html, limit = 12) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, nav, header, footer, aside').remove();

  const candidates = [];
  const selectors = [
    '[class*="Comment"] p',
    '[class*="comment"] p',
    '[data-testid*="comment"]',
    'li p',
  ];

  for (const selector of selectors) {
    $(selector).each((_, el) => {
      const text = _cleanYahoo($(el).text());
      if (text.length < 24 || text.length > 700) return;
      if (!/[ぁ-んァ-ン一-龥]/.test(text)) return;
      if (!_isYahooComment(text)) return;
      candidates.push(text);
    });
    if (candidates.length >= limit) break;
  }

  const seen = new Set();
  return candidates.filter(t => {
    const k = t.replace(/\s+/g, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, limit);
}

async function fromYahoo(topic) {
  try {
    const { braveSearch } = require('../scout');
    console.log(`  [comments/yahoo] 検索: "site:news.yahoo.co.jp ${topic}"`);
    const results = await braveSearch(`site:news.yahoo.co.jp ${topic}`, 6);
    const urls = [...new Set(
      results.map(r => r.url).filter(url => /^https?:\/\/news\.yahoo\.co\.jp\//i.test(String(url || '')))
    )].slice(0, 3);

    if (!urls.length) { console.log('  [comments/yahoo] → 0 URLs'); return []; }

    const allComments = [];
    for (const url of urls) {
      const commentsUrl = url.replace(/\/comments(?:\?.*)?$/, '').replace(/([?#].*)$/, '') + '/comments';
      try {
        const cr = await curlGet(commentsUrl, {
          referer: 'https://news.yahoo.co.jp/',
          headers: { 'Accept-Language': 'ja,en;q=0.9' },
          timeout: 12,
        });
        if (cr.ok) {
          const comments = _extractYahooComments(String(cr.body), 12);
          allComments.push(...comments);
        }
      } catch (_) {}
    }

    const unique = _unique(allComments, 20);
    console.log(`  [comments/yahoo] → ${unique.length} comments`);
    return unique.map(text => ({ text, source: 'yahoo' }));
  } catch (e) {
    console.warn(`  [comments/yahoo] 失敗: ${e.message}`);
    return [];
  }
}

// ── X (TwitterAPI.io) ───────────────────────────────────

function _isXReaction(value) {
  const text = _clean(value);
  if (!text) return false;
  const newsSummary = /(?:発表|表明|公表|報道|判明|明らかに|離脱|就任|退任|移籍)(?:しました|した|となりました|となった)/;
  const reactionSignal = /思う|思っ|残念|嬉し|悲し|すご|凄|ヤバ|やば|最高|期待|心配|驚|好き|嫌い|頑張/;
  return !newsSummary.test(text) || reactionSignal.test(text);
}

async function fromX(topic) {
  if (!X_API_KEY) { console.log('  [comments/x] API key なし'); return []; }

  try {
    const jaQ = topic.slice(0, 60) + ' lang:ja -is:retweet';
    console.log(`  [comments/x] 検索: "${jaQ}"`);
    const res = await fetch(
      'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
      new URLSearchParams({ query: jaQ, queryType: 'Top' }),
      { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) { console.warn(`  [comments/x] ${res.status}`); return []; }

    const data = await res.json();
    const tweets = data?.data?.tweets || data?.tweets || [];
    const reactions = tweets
      .map(t => t.text || t.full_text || '')
      .filter(_isXReaction);

    const unique = _unique(reactions, 15);
    console.log(`  [comments/x] → ${unique.length} comments`);
    return unique.map(text => ({ text, source: 'x' }));
  } catch (e) {
    console.warn(`  [comments/x] 失敗: ${e.message}`);
    return [];
  }
}

// ── メインAPI: 3ソース並列取得 ──────────────────────────

async function collectComments(topic, options = {}) {
  console.log(`\n  === Comments: Collecting reactions ===`);
  console.log(`  Topic: ${topic}\n`);

  const enQuery = options.enQuery || '';

  const [reddit, yahoo, x] = await Promise.all([
    fromReddit(topic, enQuery),
    fromYahoo(topic),
    fromX(topic),
  ]);

  const all = [...reddit, ...yahoo, ...x];
  console.log(`\n  Comments total: reddit=${reddit.length} yahoo=${yahoo.length} x=${x.length} → ${all.length}`);

  return { reddit, yahoo, x, all };
}

module.exports = { collectComments, fromReddit, fromYahoo, fromX };
