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

async function fromReddit(topic, enQuery = '', options = {}) {
  const searchTerm = enQuery || _toEnglishQuery(topic) || topic;
  if (!searchTerm) return [];

  try {
    // 既知のReddit URLがあればそのpermalinkを直接使う
    let permalinks = (options.redditUrls || []).map(url => {
      try { return new URL(url).pathname.replace(/\/?$/, ''); } catch { return null; }
    }).filter(Boolean);

    if (!permalinks.length) {
      console.log(`  [comments/reddit] 検索: "${searchTerm}"`);
      const searchUrl = `https://www.reddit.com/r/soccer/search.json?q=${encodeURIComponent(searchTerm)}&sort=new&restrict_sr=1&limit=5&t=week`;
      const res = await fetch(searchUrl, {
        headers: { 'User-Agent': UA, ...(REDDIT_COOKIE ? { Cookie: REDDIT_COOKIE } : {}) },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) { console.warn(`  [comments/reddit] search ${res.status}`); return []; }
      const data = await res.json();
      const posts = data?.data?.children || [];
      permalinks = posts.slice(0, 3).map(p => p.data?.permalink).filter(Boolean);
    } else {
      console.log(`  [comments/reddit] URL直接使用: ${permalinks.length}件`);
    }

    const threadResults = await Promise.all(permalinks.map(async (permalink) => {
      try {
        const url = `https://www.reddit.com${permalink}.json?limit=30&sort=top`;
        // curlGet（curl-cffi + Webshare proxy）で Cloudflare をバイパス
        const r = await curlGet(url, { referer: 'https://www.reddit.com/', timeout: 15 });
        if (!r.ok) { console.warn(`  [comments/reddit] ${r.status} ${permalink}`); return []; }
        const threadData = JSON.parse(r.body);
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

async function fromYahoo(topic, options = {}) {
  try {
    const { braveSearch } = require('../scout');
    let urls = (options.yahooUrls || []).filter(url => /news\.yahoo\.co\.jp/.test(url)).slice(0, 3);

    if (!urls.length) {
      const suffix = PHASE_YAHOO_SUFFIX[options.phase] || PHASE_YAHOO_SUFFIX.post;
      const yahooQ = `site:news.yahoo.co.jp ${topic} ${suffix}`;
      console.log(`  [comments/yahoo] 検索[${options.phase || 'post'}]: "${yahooQ}"`);
      const results = await braveSearch(yahooQ, 6);
      urls = [...new Set(
        results.map(r => r.url).filter(url => /^https?:\/\/news\.yahoo\.co\.jp\//i.test(String(url || '')))
      )].slice(0, 3);
    } else {
      console.log(`  [comments/yahoo] URL直接使用: ${urls.length}件`);
    }

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

async function _xSearchRaw(query, label, queryType = 'Top') {
  const res = await fetch(
    'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
    new URLSearchParams({ query, queryType }),
    { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) { console.warn(`  [comments/x] ${label} ${res.status}`); return []; }
  const data = await res.json();
  return data?.data?.tweets || data?.tweets || [];
}

// ── ニュースアカウント定義 ────────────────────────────────

// 日本語サッカーニュースアカウント
const JP_NEWS_ACCOUNTS = [
  'goal_jp', 'soccerdigestweb', 'gekisaka', 'footballchannel',
  'livedoornews', 'nhk_sport', 'sportsnavi', 'sponicchi',
  'nikkan_sports', 'football_tribe', 'soccer_king_jp',
];

// 英語サッカーニュースアカウント
const EN_NEWS_ACCOUNTS = [
  'goal', 'optajoe', 'bbcsport', 'espnfc', 'guardianfootball',
  'FabrizioRomano', 'SkySportsNews', 'talksport', 'btsportfootball',
  'footballdotcom', 'transfermarkt',
];

// ── AI: 案件ツイートを1件厳格特定 ──────────────────────────

async function _findMatchingTweet(candidates, topic) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_KEY || !candidates.length) return null;

  const list = candidates.map((t, i) => `[${i}] @${t.author}: ${t.text.slice(0, 120)}`).join('\n');
  const prompt = `トピック「${topic}」を直接報じているツイートを1件だけ選んでください。
判定条件（全て満たすこと）：
1. トピックの主役（選手名・チーム名）が明示されている
2. トピックの出来事（記録・移籍・試合結果等）が明示されている
3. 別の選手・別の試合・一般的なW杯情報だけのツイートは不可

どれも条件を満たさない場合は null を返してください。
JSON形式のみ: {"index": 数字} または {"index": null}

${list}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 20,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '{"index":null}';
    const parsed = JSON.parse(text);
    if (parsed.index === null || parsed.index === undefined) return null;
    return candidates[parsed.index] || null;
  } catch {
    return null;
  }
}

// ── ニュースアカウントリプライ取得（JP / EN 共通） ──────────

async function _fromNewsAccountReplies(topic, { lang = 'ja', accounts, label } = {}) {
  if (!X_API_KEY || !accounts?.length) return [];

  try {
    // キーワード抽出（カタカナ3文字以上 or 英字固有名詞）
    const jpKws = [...new Set(topic.match(/[ァ-ヶー]{3,}/g) || [])].slice(0, 2);
    const enKws = [...new Set(topic.match(/[A-Z][a-z]{2,}/g) || [])].slice(0, 2);
    const kws = lang === 'ja' ? jpKws : (enKws.length ? enKws : jpKws);
    const kwPart = kws.length ? kws.join(' OR ') : topic.slice(0, 20);

    const fromPart = accounts.slice(0, 8).map(a => `from:${a}`).join(' OR ');
    const q = `(${fromPart}) (${kwPart}) -is:retweet`;
    console.log(`  [comments/${label}] 検索: "${q}"`);

    const [topTweets, latestTweets] = await Promise.all([
      _xSearchRaw(q, `${label}_top`, 'Top'),
      _xSearchRaw(q, `${label}_latest`, 'Latest'),
    ]);

    const seenIds = new Set();
    const raw = [...topTweets, ...latestTweets].filter(t => {
      const id = t.id || t.tweet_id || t.id_str;
      if (!id || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });

    if (!raw.length) {
      console.log(`  [comments/${label}] ツイートなし`);
      return [];
    }

    // リプライ数でソートして上位10件をAI判定に渡す
    const candidates = raw
      .map(t => ({
        id: t.id || t.tweet_id || t.id_str,
        text: t.text || t.full_text || '',
        author: t.author?.userName || t.author?.name || '',
        replyCount: t.replyCount || t.reply_count || 0,
      }))
      .filter(t => t.id && t.text)
      .sort((a, b) => b.replyCount - a.replyCount)
      .slice(0, 10);

    // AI が案件ツイートを1件厳格特定（ノーマッチならスキップ）
    const matched = await _findMatchingTweet(candidates, topic);
    if (!matched) {
      console.log(`  [comments/${label}] AI一致なし → スキップ`);
      return [];
    }
    console.log(`  [comments/${label}] 特定: @${matched.author} "${matched.text.slice(0, 60)}..." (replies:${matched.replyCount})`);

    // リプライ取得
    const repQ = `conversation_id:${matched.id} lang:${lang} -is:retweet`;
    const replies = await _xSearchRaw(repQ, `replies_${matched.id}`).catch(() => []);
    const texts = replies.map(r => {
      return (r.text || r.full_text || '')
        .replace(/@\w+\s*/g, '')
        .replace(/https?:\/\/\S+/g, '')
        .trim();
    }).filter(t => t.length >= 12);

    const unique = _unique(texts.filter(_isXReaction), 12);
    console.log(`  [comments/${label}] → ${unique.length} リプライ`);
    return unique.map(text => ({ text, source: 'x', lang }));
  } catch (e) {
    console.warn(`  [comments/${label}] 失敗: ${e.message}`);
    return [];
  }
}

async function fromXReplies(topic, { phase = 'post', enQuery = '' } = {}) {
  if (!X_API_KEY) { console.log('  [comments/xr] API key なし'); return []; }

  const [jpReplies, enReplies] = await Promise.all([
    _fromNewsAccountReplies(topic, { lang: 'ja', accounts: JP_NEWS_ACCOUNTS, label: 'xr_jp' }),
    _fromNewsAccountReplies(topic, { lang: 'en', accounts: EN_NEWS_ACCOUNTS, label: 'xr_en' }),
  ]);

  const all = [...jpReplies, ...enReplies];
  console.log(`  [comments/xr] JP:${jpReplies.length} EN:${enReplies.length} → ${all.length}件`);
  return all;
}

async function fromX(topic, enQuery = '') {
  return []; // 廃止: fromXReplies（ニュースアカウント限定）に統合
}

// ── 試合フェーズ判定 ────────────────────────────────────

/**
 * matchData から試合フェーズを判定する
 * @param {object|null} matchData - FotMob などから取得した試合データ
 * @returns {'pre'|'live'|'post'}
 */
function detectMatchPhase(matchData) {
  if (!matchData) return 'post';
  const status = matchData?.match?.status || matchData?.status || {};

  if (status.finished || status.result) return 'post';
  if (status.started || status.ongoing) return 'live';

  // utcTime から計算
  const kickoffStr = status.utcTime || matchData?.match?.kickoffTime || matchData?.kickoffTime;
  if (!kickoffStr) return 'post';

  const kickoff = new Date(kickoffStr);
  if (isNaN(kickoff)) return 'post';

  const diffMin = (Date.now() - kickoff.getTime()) / 60000;
  if (diffMin < -30) return 'pre';   // 30分以上前
  if (diffMin < 130) return 'live';  // キックオフから130分以内
  return 'post';
}

// フェーズ別クエリヒント
const PHASE_YAHOO_SUFFIX = {
  pre:  '展望 予想',
  live: '速報 ライブ',
  post: '結果 感想',
};

const PHASE_X_HINT = {
  pre:  '展望 OR 予想 OR 注目',
  live: '速報 OR ゴール OR 実況',
  post: '感想 OR 試合終了 OR お疲れ',
};

// ── メインAPI: 3ソース並列取得 ──────────────────────────

async function collectComments(topic, options = {}) {
  console.log(`\n  === Comments: Collecting reactions ===`);

  const { enQuery = '', yahooUrls = [], redditUrls = [], xTweets = null, matchData = null } = options;

  const phase = detectMatchPhase(matchData);
  console.log(`  Topic: ${topic}  Phase: ${phase}\n`);

  const [reddit, yahoo, xReplies] = await Promise.all([
    fromReddit(topic, enQuery, { redditUrls }),
    fromYahoo(topic, { yahooUrls, phase }),
    fromXReplies(topic, { phase, enQuery }),
  ]);

  const all = [...reddit, ...yahoo, ...xReplies];
  console.log(`\n  Comments total: reddit=${reddit.length} yahoo=${yahoo.length} x_reply=${xReplies.length} → ${all.length}`);

  return { reddit, yahoo, x: xReplies, xReplies, xBroad: [], all, phase };
}

module.exports = { collectComments, fromReddit, fromYahoo, fromX, fromXReplies, detectMatchPhase };
