// v4_launcher/scripts/v4_scout.js
// V4ニューススカウト（4部門: X / Yahoo / Reddit / 5ch）
//   X       : advanced_search × 2 + Japan trends
//   Yahoo   : Brave Search site:news.yahoo.co.jp
//   Reddit  : r/soccer + r/JapanSoccer top posts
//
//   → 全件 DeepSeek に渡して上位 7 件選定 + フック生成
//   → 48h 重複排除 (used_topics.json)
'use strict';

const path  = require('path');
const fs    = require('fs');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { fetchSerper } = require('../../scripts/modules/fetchers/brave_search_module');
const { fetch5chCandidates } = require('../../scripts/modules/fetchers/5ch_fetcher');
const { callAI }      = require('../../scripts/ai_client');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const SCOUT_FILE = path.join(DATA_DIR, 'scout_results.json');
const USED_FILE  = path.join(DATA_DIR, 'used_topics.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const X_API_KEY = process.env.TWITTER_API_IO_KEY;
const REDDIT_COOKIE = process.env.REDDIT_SESSION_COOKIE || '';

// ─────────────────────────────────────────────────────────────
// ① X (twitterAPI.io)
// ─────────────────────────────────────────────────────────────
async function _fetchX() {
  if (!X_API_KEY) return [];
  const items = [];

  const queries = [
    { q: 'サッカー OR 日本代表 OR W杯 -is:retweet lang:ja', label: 'X/JP' },
    { q: 'soccer transfer injury news -is:retweet lang:en',  label: 'X/EN' },
  ];

  for (const { q, label } of queries) {
    try {
      const res = await fetch('https://api.twitterapi.io/twitter/tweet/advanced_search?' + new URLSearchParams({
        query: q, queryType: 'Top',
      }), { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) });
      const data = await res.json();
      const tweets = data?.data?.tweets || data?.tweets || [];
      for (const t of tweets.slice(0, 20)) {
        const text = String(t.text || '').replace(/https?:\/\/\S+/g, '').replace(/\n+/g, ' ').trim();
        if (text.length < 20) continue;
        items.push({ title: text.slice(0, 120), source: label, url: `https://x.com/i/web/status/${t.id || ''}`, date: t.created_at || null });
      }
    } catch (e) { console.warn(`[scout] X ${label} 失敗:`, e.message); }
  }

  // Japan Trends
  try {
    const res = await fetch('https://api.twitterapi.io/twitter/trends?' + new URLSearchParams({ woeid: '23424856' }), {
      headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    const trends = data?.trends || [];
    const soccerTrends = trends.filter(t => {
      const n = (t.trend?.name || '').toLowerCase();
      return /サッカー|football|soccer|代表|w杯|worldcup|jfa|移籍|cl |pl |premier|champions/i.test(n);
    });
    for (const t of soccerTrends.slice(0, 5)) {
      items.push({ title: t.trend.name, source: 'X/Trend', url: '', date: null });
    }
  } catch (e) { console.warn('[scout] X Trends 失敗:', e.message); }

  return items;
}

// ─────────────────────────────────────────────────────────────
// ② Yahoo Japan（Brave Search 経由）
// ─────────────────────────────────────────────────────────────
async function _fetchYahoo() {
  try {
    const res = await fetchSerper('site:news.yahoo.co.jp サッカー 最新', '', 'ja', null, { num: 25 });
    if (!res?.ok) {
      console.warn('[scout] Yahoo 失敗:', res?.error || 'unknown');
      return [];
    }
    return (res?.organic || []).map(r => ({
      title:  (r.title || '').trim(),
      source: 'Yahoo',
      url:    r.link || '',
      date:   r.date || null,
    })).filter(it => it.title.length > 10);
  } catch (e) {
    console.warn('[scout] Yahoo 失敗:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// ③ Reddit（JSON API）
// ─────────────────────────────────────────────────────────────
async function _fetchReddit() {
  const subreddits = ['soccer', 'JapanSoccer'];
  const items = [];

  for (const sub of subreddits) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=25`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; V4Scout/1.0)',
          // REDDIT_SESSION_COOKIE は .env に "reddit_session=xxxx" 形式で入ってる
          ...(REDDIT_COOKIE ? { Cookie: REDDIT_COOKIE } : {}),
        },
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      const posts = data?.data?.children || [];
      for (const p of posts) {
        const d = p.data || {};
        if (d.stickied || d.is_video) continue;
        items.push({
          title:  String(d.title || '').trim(),
          source: `Reddit/r/${sub}`,
          url:    `https://reddit.com${d.permalink || ''}`,
          date:   d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
          score:  d.score || 0,
        });
      }
    } catch (e) { console.warn(`[scout] Reddit r/${sub} 失敗:`, e.message); }
  }

  return items;
}

async function _fetch5ch() {
  try {
    const iso = new Date().toISOString().slice(0, 10);
    const candidates = await fetch5chCandidates(iso);
    return candidates.map(item => ({
      title: String(item.titleJa || item.title || '').trim(),
      source: '5ch',
      url: item.url || '',
      date: item.created_utc ? new Date(item.created_utc * 1000).toISOString() : null,
      score: item.score || 0,
    })).filter(item => item.title.length > 8);
  } catch (e) {
    console.warn('[scout] 5ch 失敗:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 重複排除（URL・正規化タイトル・文字bigram類似）
// ─────────────────────────────────────────────────────────────
function _normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/【[^】]*】|\[[^\]]*\]/g, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/さん|選手|監督|速報|悲報|朗報|話題|発表/g, '');
}

function _bigrams(value) {
  const chars = Array.from(_normalizeTitle(value));
  const set = new Set();
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1]);
  return set;
}

function _similarTitle(a, b) {
  const na = _normalizeTitle(a);
  const nb = _normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb || (Math.min(na.length, nb.length) >= 8 && (na.includes(nb) || nb.includes(na)))) return true;
  const aa = _bigrams(na);
  const bb = _bigrams(nb);
  if (!aa.size || !bb.size) return false;
  let hits = 0;
  aa.forEach(value => { if (bb.has(value)) hits++; });
  return hits / Math.min(aa.size, bb.size) >= 0.72;
}

function _dedup(items, existing = []) {
  const kept = [...existing];
  const seenUrls = new Set(existing.map(item => item.url).filter(Boolean));
  return items.filter(it => {
    if (!it.title) return false;
    if (it.url && seenUrls.has(it.url)) return false;
    if (kept.some(prev => _similarTitle(prev.title, it.title))) return false;
    if (it.url) seenUrls.add(it.url);
    kept.push(it);
    return true;
  });
}

function _sourceGroup(source) {
  const value = String(source || '');
  if (value.startsWith('X')) return 'X';
  if (value.startsWith('Yahoo')) return 'Yahoo';
  if (value.startsWith('Reddit')) return 'Reddit';
  if (value.startsWith('5ch')) return '5ch';
  return '';
}

// ─────────────────────────────────────────────────────────────
// 48h 使用済みURL管理
// ─────────────────────────────────────────────────────────────
function _loadUsed() {
  try {
    const raw = JSON.parse(fs.readFileSync(USED_FILE, 'utf8'));
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    return (raw || []).filter(it => new Date(it.addedAt).getTime() > cutoff);
  } catch (_) { return []; }
}

function _saveUsed(used, newTopics) {
  const now = new Date().toISOString();
  const added = newTopics.map(t => ({ url: t.url, title: t.title, addedAt: now }));
  const next = [...used, ...added].slice(-200);  // 最大200件保持
  fs.writeFileSync(USED_FILE, JSON.stringify(next, null, 2));
}

// ─────────────────────────────────────────────────────────────
// DeepSeek: 全件見せて上位選定 + フック生成
// ─────────────────────────────────────────────────────────────
async function _pickTopics(items, perSource = 5) {
  const block = items.map((it, i) =>
    `${i+1}. [${it.source}] ${it.title}`
  ).join('\n');

  const examples = [
    '【悲報】エンバペ君、ファンダイクに勝負を挑んだ結果wwwww',
    '【朗報】辛口でおなじみキャラガーさん、三笘の天才ゴールを大絶賛',
    '【速報】ユルゲン・クロップ、レアルマドリード監督の交渉合意と現地報道',
    '日本代表のPKが下手な理由がこちらです',
    '【完全覚醒】遠藤航、31歳にしてとんでもない境地に辿り着くwwwwww',
  ].join('\n');

  const prompt = `あなたは2chサッカー動画チャンネルのプロデューサーです。
以下は今日のX・Yahoo・Reddit・5chで話題になっているサッカーニュース一覧です。

**選定基準**
1. 日本代表・日本人選手（三笘/久保/南野/遠藤/冨安/上田/堂安/鎌田/中村敬斗 等）→ 最優先（+20点ボーナス）
2. W杯・CL・PLの話題 → 高優先
3. 有名選手の移籍・スキャンダル・記録 → 高優先
4. ネタ化・笑い・驚きになる要素があるか → 重要
5. 似たようなニュースが被ってないか → 避ける

**良いフック文の例（この雰囲気で作る）:**
${examples}

【ニュース一覧（${items.length}件）】
${block}

X・Yahoo・Reddit・5chから、それぞれ最大${perSource}件ずつ選んでください。
同じ出来事を扱うニュースはソースが違っても1件だけにしてください。
全体順位ではなく、各ソースの枠を必ず守ってください。

それぞれ:
- topic: 20字以内の一言要約
- hook: 2ch風フック文（30字以内）※良い例の雰囲気を参考に
- score: 0〜100
- source: [ソース]タグそのまま
- originalIndex: 上記番号（1始まり）

JSONのみ:
{"topics":[{"topic":"...","hook":"...","score":88,"source":"X/JP","originalIndex":3}]}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek', model: 'deepseek-chat',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed.topics)) return [];
    return parsed.topics
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map(t => {
        const orig = items[(t.originalIndex || 1) - 1] || {};
        return {
          topic:  String(t.topic || '').slice(0, 30),
          hook:   String(t.hook  || '').slice(0, 60),
          score:  Math.max(0, Math.min(100, Number(t.score) || 50)),
          source: String(orig.source || t.source || ''),
          title:  orig.title || '',
          url:    orig.url   || '',
          date:   orig.date  || null,
        };
      })
      .filter(topic => topic.topic && topic.title);
  } catch (e) {
    console.warn('[scout] 選定失敗:', e.message);
    return items.map(it => ({
      topic: it.title.slice(0, 30), hook: '', score: 50,
      source: it.source, title: it.title, url: it.url, date: it.date,
    }));
  }
}

// ─────────────────────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────────────────────
async function runScout(opts = {}) {
  const perSource = opts.perSource || 5;
  console.log('[v4_scout] 開始:', new Date().toLocaleString('ja-JP'));

  // 4部門並列取得
  const [xItems, yahooItems, redditItems, fivechItems] = await Promise.all([
    _fetchX(), _fetchYahoo(), _fetchReddit(), _fetch5ch(),
  ]);

  console.log(
    `[v4_scout] 取得: X=${xItems.length} Yahoo=${yahooItems.length} Reddit=${redditItems.length} 5ch=${fivechItems.length}`,
  );

  // ソース内重複を先に落とし、各ソースの候補数を均等に保つ
  const sourcePools = {
    X: _dedup(xItems),
    Yahoo: _dedup(yahooItems),
    Reddit: _dedup(redditItems),
    '5ch': _dedup(fivechItems),
  };
  const all = Object.values(sourcePools).flat();

  // 48h 使用済みURL除外
  const used = _loadUsed();
  const usedUrls = new Set(used.map(u => u.url).filter(Boolean));
  const usedTitles = used.map(u => u.title).filter(Boolean);
  const fresh = all.filter(it => {
    if (it.url && usedUrls.has(it.url)) return false;
    if (usedTitles.some(title => _similarTitle(title, it.title))) return false;
    return true;
  });

  console.log(`[v4_scout] 重複排除: ${all.length}件 → 新規${fresh.length}件`);

  // 各ソース最大15件をAIへ渡し、各5件を選定
  const balancedInput = ['X', 'Yahoo', 'Reddit', '5ch']
    .flatMap(group => fresh.filter(item => _sourceGroup(item.source) === group).slice(0, 15));
  const picked = await _pickTopics(balancedInput, perSource);

  // AI出力をソース別に固定し、足りない枠は元候補から補完
  const topics = [];
  for (const group of ['X', 'Yahoo', 'Reddit', '5ch']) {
    const selected = _dedup(
      picked.filter(item => _sourceGroup(item.source) === group),
      topics,
    ).slice(0, perSource);
    const pool = fresh.filter(item => _sourceGroup(item.source) === group);
    const fillers = _dedup(pool, [...topics, ...selected])
      .slice(0, Math.max(0, perSource - selected.length))
      .map(item => ({
        topic: item.title.slice(0, 30),
        hook: item.title.slice(0, 60),
        score: Math.max(50, Math.min(100, Number(item.score) || 70)),
        source: item.source,
        title: item.title,
        url: item.url,
        date: item.date,
      }));
    topics.push(...selected, ...fillers);
  }
  topics.sort((a, b) => (b.score || 0) - (a.score || 0));
  console.log(`[v4_scout] 選定: ${topics.length}件`);

  // 結果保存
  const result = { scoutedAt: new Date().toISOString(), topicCount: topics.length, topics };
  fs.writeFileSync(SCOUT_FILE, JSON.stringify(result, null, 2));

  // 使用済みに追加（今回選ばれた7件）
  _saveUsed(used, topics);

  return topics;
}

module.exports = { runScout, SCOUT_FILE, dedupItems: _dedup, similarTitle: _similarTitle };

if (require.main === module) {
  runScout().then(t => {
    console.log('\n=== スカウト結果 ===');
    t.forEach((it, i) => console.log(`${i+1}. [${it.score}] [${it.source}] ${it.topic}\n   ${it.hook}`));
  }).catch(console.error);
}
