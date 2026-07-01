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

async function _xSearchRaw(query, label) {
  const res = await fetch(
    'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
    new URLSearchParams({ query, queryType: 'Top' }),
    { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) { console.warn(`  [comments/x] ${label} ${res.status}`); return []; }
  const data = await res.json();
  return data?.data?.tweets || data?.tweets || [];
}

async function _xSearch(query, label) {
  const tweets = await _xSearchRaw(query, label);
  return tweets.map(t => t.text || t.full_text || '');
}

// サッカーニュースアカウントのリプライ欄から反応コメントを収集
const SOCCER_NEWS_ACCOUNTS = ['goal_jp', 'soccerdigestweb', 'gekisaka', 'jfa_samuraiblue', 'footballchannel'];

// GPT-4o-mini でツイートがトピックに関連するか一括判定
async function _filterByAI(candidates, topic) {
  const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
  if (!OPENAI_KEY || !candidates.length) return candidates;

  const list = candidates.map((t, i) => `[${i}] ${t.text.slice(0, 120)}`).join('\n');
  const prompt = `次のトピック「${topic}」について、このトピックを直接扱っているツイートの番号のみをJSON配列で返してください。\n関係が薄いもの（別の試合・別の選手・一般的なW杯報告など）は除外してください。\nJSON配列のみ返答。例: [0,2]\n\n${list}`;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 50,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return candidates;
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '[]';
    const indices = JSON.parse(text);
    if (!Array.isArray(indices) || !indices.length) return [];
    return indices.map(i => candidates[i]).filter(Boolean);
  } catch {
    return candidates;
  }
}

async function fromXReplies(topic, { phase = 'post', enQuery = '' } = {}) {
  if (!X_API_KEY) { console.log('  [comments/xr] API key なし'); return []; }

  try {
    // Step1: JP + EN キーワードで広く検索（アカウント縛りなし）
    const jpKws = [...new Set(topic.match(/[ァ-ヶー]{3,}/g) || [])].slice(0, 2);
    const GENERIC_EN = new Set(['goal','goals','record','records','cup','world','soccer','football','match','game','win','score']);
    const enKws = enQuery
      ? enQuery.split(/\s+/).filter(w => /^[A-Z]/.test(w) && !GENERIC_EN.has(w.toLowerCase())).slice(0, 2)
      : [];
    const allKws = [...jpKws, ...enKws];
    const kwQuery = allKws.length ? allKws.join(' OR ') : topic.slice(0, 20);
    const q = `(${kwQuery}) -is:retweet lang:ja`;
    console.log(`  [comments/xr] 検索: "${q}"`);

    const rawTweets = await _xSearchRaw(q, 'topic_search');
    if (!rawTweets.length) {
      console.log('  [comments/xr] ツイートなし');
      return [];
    }

    // ブルーバッジ＋フォロワー10万以上のメディアに絞り、リプライ数でソート
    const FOLLOWER_MIN = 100_000;
    const trusted = rawTweets
      .filter(t => t.author?.isBlueVerified && (t.author?.followers || 0) >= FOLLOWER_MIN)
      .map(t => ({
        id: t.id || t.tweet_id || t.id_str,
        text: t.text || t.full_text || '',
        author: t.author?.name || t.author?.userName || '',
        followers: t.author?.followers || 0,
        replyCount: t.replyCount || t.reply_count || 0,
      }))
      .filter(t => t.id)
      .sort((a, b) => b.replyCount - a.replyCount);

    console.log(`  [comments/xr] 全件:${rawTweets.length} / 信頼済み:${trusted.length}件`);

    // AI判定（上位10件に絞ってコスト抑制）
    const candidates = trusted.slice(0, 10);
    const aiMatched = await _filterByAI(candidates, topic);
    const pool = aiMatched.length ? aiMatched : trusted;
    const top2 = pool.slice(0, 2);
    console.log(`  [comments/xr] AI一致:${aiMatched.length}件 → top2:\n${top2.map(t => `    - [@${t.author} ${t.followers.toLocaleString()}F] ${t.text.slice(0, 50)}... (replies:${t.replyCount})`).join('\n')}`);

    // Step2: 各ツイートのリプライを並列取得
    const replyArrays = await Promise.all(top2.map(async t => {
      const repQ = `conversation_id:${t.id} lang:ja -is:retweet`;
      console.log(`  [comments/xr] リプライ取得: conversation_id:${t.id}`);
      const raw = await _xSearchRaw(repQ, `replies_${t.id}`).catch(() => []);
      return raw.map(r => {
        const text = (r.text || r.full_text || '')
          .replace(/@\w+\s*/g, '')
          .replace(/https?:\/\/\S+/g, '')
          .trim();
        return text;
      }).filter(text => text.length >= 12);
    }));

    const allReplies = replyArrays.flat();
    const filtered = allReplies.filter(_isXReaction);
    const unique = _unique(filtered, 15);
    console.log(`  [comments/xr] → ${unique.length} リプライコメント`);
    return unique.map(text => ({ text, source: 'x_reply' }));
  } catch (e) {
    console.warn(`  [comments/xr] 失敗: ${e.message}`);
    return [];
  }
}

async function fromX(topic, enQuery = '') {
  if (!X_API_KEY) { console.log('  [comments/x] API key なし'); return []; }

  try {
    const jaQ = topic.slice(0, 60) + ' lang:ja -is:retweet';
    // 英語クエリ: enQuery があればそれ、なければ日本語トピックを英語化
    const enTerm = (enQuery || _toEnglishQuery(topic)).slice(0, 80);
    const enQ = enTerm ? enTerm + ' lang:en -is:retweet' : '';

    console.log(`  [comments/x] 日本語: "${jaQ}"`);
    if (enQ) console.log(`  [comments/x] 英語:   "${enQ}"`);

    const [jaRaw, enRaw] = await Promise.all([
      _xSearch(jaQ, 'ja').catch(() => []),
      enQ ? _xSearch(enQ, 'en').catch(() => []) : Promise.resolve([]),
    ]);

    const jaReactions = _unique(jaRaw.filter(_isXReaction), 12);
    const enReactions = _unique(enRaw.filter(_isXReaction), 8);

    console.log(`  [comments/x] → ja:${jaReactions.length} en:${enReactions.length}`);
    return [
      ...jaReactions.map(text => ({ text, source: 'x' })),
      ...enReactions.map(text => ({ text, source: 'x', lang: 'en' })),
    ];
  } catch (e) {
    console.warn(`  [comments/x] 失敗: ${e.message}`);
    return [];
  }
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
