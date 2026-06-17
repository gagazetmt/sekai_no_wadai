// v4_launcher/scripts/v4_scout.js
// V4ニューススカウト（X/JP + X/EN のみ）
//   → 全件 DeepSeek に渡して総合上位40件選定 + フック生成
//   → 48h 重複排除 (used_topics.json)
'use strict';

const path  = require('path');
const fs    = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { callAI } = require('../../scripts/ai_client');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const SCOUT_FILE = path.join(DATA_DIR, 'scout_results.json');
const USED_FILE  = path.join(DATA_DIR, 'used_topics.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const X_API_KEY = process.env.TWITTER_API_IO_KEY;

const FRESHNESS_HOURS = 12;

function _isWithinHours(dateStr, hours) {
  if (!dateStr) return true;
  const s = String(dateStr).trim();
  const d = new Date(s);
  if (!isNaN(d.getTime())) return (Date.now() - d.getTime()) < hours * 3600 * 1000;
  const m = s.match(/(\d+)\s*(minute|hour|day|week|month|year)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = { minute: 60e3, hour: 3600e3, day: 86400e3, week: 604800e3, month: 2592e6, year: 31536e6 };
    return n * (ms[unit] || 86400e3) < hours * 3600e3;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────
// X (twitterAPI.io) — JP + EN
// ─────────────────────────────────────────────────────────────
async function _fetchX() {
  if (!X_API_KEY) return [];
  const items = [];

  const queries = [
    { q: 'サッカー OR 日本代表 OR W杯 -is:retweet lang:ja', label: 'X/JP' },
    { q: 'World Cup OR football OR soccer -is:retweet lang:en', label: 'X/EN' },
  ];

  const TARGET_PER_QUERY = 100;
  const MAX_PAGES = 5;

  for (const { q, label } of queries) {
    try {
      let cursor = null;
      let collected = 0;
      for (let page = 0; page < MAX_PAGES && collected < TARGET_PER_QUERY; page++) {
        const params = { query: q, queryType: 'Top' };
        if (cursor) params.cursor = cursor;
        const res = await fetch('https://api.twitterapi.io/twitter/tweet/advanced_search?' + new URLSearchParams(params),
          { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) });
        const data = await res.json();
        const tweets = data?.data?.tweets || data?.tweets || [];
        if (!tweets.length) break;
        for (const t of tweets) {
          if (collected >= TARGET_PER_QUERY) break;
          const text = String(t.text || '').replace(/https?:\/\/\S+/g, '').replace(/\n+/g, ' ').trim();
          if (text.length < 20) continue;
          items.push({ title: text.slice(0, 120), source: label, url: `https://x.com/i/web/status/${t.id || ''}`, date: t.created_at || null });
          collected++;
        }
        cursor = data?.next_cursor || data?.data?.next_cursor || null;
        if (!cursor) break;
      }
    } catch (e) { console.warn(`[scout] X ${label} 失敗:`, e.message); }
  }

  return items;
}

// ─────────────────────────────────────────────────────────────
// 重複排除
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

const EVENT_GROUPS = [
  ['離脱', '欠場', '負傷', '怪我', '故障'],
  ['引退', '現役終了'],
  ['移籍', '加入', '獲得', '退団', '放出'],
  ['解任', '辞任', '退任'],
  ['就任', '新監督'],
  ['優勝', '制覇'],
  ['敗退', '敗戦', '黒星'],
  ['勝利', '快勝', '白星'],
  ['契約', '更新', '延長'],
  ['ランキング', 'ランク', '順位'],
];

function _entityTokens(value) {
  const text = String(value || '').normalize('NFKC');
  const stop = new Set([
    '日本代表', 'サッカー', 'ワールドカップ', 'プレミア', 'ニュース',
    '最新', '緊急', '悲報', '朗報', '速報', '発表', '話題',
  ]);
  const tokens = [
    ...(text.match(/[一-龯々]{2,6}/g) || []),
    ...(text.match(/[ァ-ヴー]{3,12}/g) || []),
    ...(text.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{4,}/g) || []).map(token => token.toLowerCase()),
  ];
  return new Set(tokens.filter(token => !stop.has(token)));
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
  if (hits / Math.min(aa.size, bb.size) >= 0.72) return true;

  const entitiesA = _entityTokens(a);
  const entitiesB = _entityTokens(b);
  const commonEntity = [...entitiesA].some(left =>
    [...entitiesB].some(right =>
      left === right ||
      (Math.min(left.length, right.length) >= 2 && (left.includes(right) || right.includes(left)))
    )
  );
  const sharedAnchor = /W杯|ワールドカップ|日本代表|FIFA/i.test(String(a || '')) &&
    /W杯|ワールドカップ|日本代表|FIFA/i.test(String(b || ''));
  if (!commonEntity && !sharedAnchor) return false;
  const lowerA = String(a || '').toLowerCase();
  const lowerB = String(b || '').toLowerCase();
  return EVENT_GROUPS.some(group =>
    group.some(word => lowerA.includes(word.toLowerCase())) &&
    group.some(word => lowerB.includes(word.toLowerCase()))
  );
}

function _itemText(item) {
  return [item?.topic, item?.hook, item?.title].filter(Boolean).join(' ');
}

function _dedup(items, existing = []) {
  const kept = [...existing];
  const seenUrls = new Set(existing.map(item => item.url).filter(Boolean));
  return items.filter(it => {
    if (!it.title) return false;
    if (it.url && seenUrls.has(it.url)) return false;
    if (kept.some(prev => _similarTitle(_itemText(prev), _itemText(it)))) return false;
    if (it.url) seenUrls.add(it.url);
    kept.push(it);
    return true;
  });
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
  const next = [...used, ...added].slice(-200);
  fs.writeFileSync(USED_FILE, JSON.stringify(next, null, 2));
}

// ─────────────────────────────────────────────────────────────
// DeepSeek: 全件見せて総合上位40件選定
// ─────────────────────────────────────────────────────────────
async function _pickTopics(items, maxTopics = 40) {
  const block = items.map((it, i) =>
    `${i+1}. [${it.source}] ${it.title}`
  ).join('\n');

  const examples = [
    '【悲報】エンバペ君、ファンダイクに勝負を挑んだ結果wwwww',
    '【朗報】辛口キャラガーさん、三笘の天才ゴールを大絶賛してしまう',
    '【速報】クロップさん、レアル監督就任で交渉合意と現地報道',
    '日本代表のPKが下手な理由がこちらですwww',
    '【完全覚醒】遠藤航、31歳にしてとんでもない境地に辿り着く',
    'レヴァンドフスキさん（36）、まだ衰える気配がない模様',
    '【悲報】マンUさん、また逆転負けを喫してしまう…',
  ].join('\n');

  const prompt = `あなたは2ch/5chサッカー板の住人であり、サッカー動画チャンネルのプロデューサーです。
以下は今日のXで話題になっているサッカーニュース一覧です。

**選定基準（優先順）**
1. W杯・CL・PL・リーガなど主要大会の試合結果・トピック → 最優先
2. 有名選手の移籍・スキャンダル・記録・名場面 → 高優先
3. 日本代表・日本人選手（三笘/久保/南野/遠藤/冨安/上田/堂安/鎌田/中村敬斗 等）→ 高優先
4. ネタ化・笑い・驚きになる要素があるか → 重要
5. 似たようなニュースが被ってないか → 被りは1件だけにする

**5chスレタイの例（このノリ・テンションで topic を作る）:**
${examples}

**スレタイのルール:**
- 【悲報】【朗報】【速報】【悲報】【完全覚醒】等のタグを適宜つける
- 「○○さん、△△してしまうwww」「○○した結果wwwww」「○○な模様」「○○がこちら」等の5ch定番構文を使う
- 選手・チームを「さん」「君」「ニキ」等で親しみを込めて呼ぶのもOK
- 長すぎない（40字以内）。パッと見てネタが分かること
- 選手やクラブへのリスペクトは忘れない。愛あるイジりはOKだが誹謗中傷はNG

【ニュース一覧（${items.length}件）】
${block}

総合スコア順に上位${maxTopics}件を選んでください。
同じ出来事を扱うニュースはソースが違っても1件だけにしてください。

それぞれ:
- topic: 5chスレタイ風の案件名（40字以内）※上記の例を参考に
- score: 0〜100
- source: [ソース]タグそのまま
- originalIndex: 上記番号（1始まり）

JSONのみ:
{"topics":[{"topic":"【悲報】エンバペ君、ファンダイクに勝負を挑んだ結果wwwww","score":88,"source":"X/JP","originalIndex":3}]}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek', model: 'deepseek-chat',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed.topics)) return [];
    return parsed.topics
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, maxTopics)
      .map(t => {
        const orig = items[(t.originalIndex || 1) - 1] || {};
        return {
          topic:  String(t.topic || '').slice(0, 50),
          hook:   String(t.topic || '').slice(0, 50),
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
    return items.slice(0, maxTopics).map(it => ({
      topic: it.title.slice(0, 50), hook: it.title.slice(0, 50), score: 50,
      source: it.source, title: it.title, url: it.url, date: it.date,
    }));
  }
}

// ─────────────────────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────────────────────
async function runScout(opts = {}) {
  const maxTopics = opts.maxTopics || 40;
  const onProgress = opts.onProgress || (() => {});
  console.log('[v4_scout] 開始:', new Date().toLocaleString('ja-JP'));

  onProgress({ stage: 'fetch', message: 'X/JP + X/EN を取得中...' });

  const xItems = await _fetchX();
  console.log(`[v4_scout] 取得: X=${xItems.length}`);
  onProgress({ stage: 'filter', message: `${xItems.length}件取得 → フィルタ・重複排除中...` });

  // 12時間以内フィルタ
  const fresh = xItems.filter(it => _isWithinHours(it.date, FRESHNESS_HOURS));
  console.log(`[v4_scout] 12h フィルタ: ${fresh.length}件`);

  // 重複排除
  const deduped = _dedup(fresh);

  // 48h 使用済みURL除外
  const used = _loadUsed();
  const usedUrls = new Set(used.map(u => u.url).filter(Boolean));
  const usedTitles = used.map(u => u.title).filter(Boolean);
  const novel = deduped.filter(it => {
    if (it.url && usedUrls.has(it.url)) return false;
    if (usedTitles.some(title => _similarTitle(title, _itemText(it)))) return false;
    return true;
  });

  console.log(`[v4_scout] 重複排除: ${deduped.length}件 → 新規${novel.length}件`);
  onProgress({ stage: 'ai', message: `新規${novel.length}件 → AI選定中...` });

  const topics = await _pickTopics(novel, maxTopics);
  console.log(`[v4_scout] 選定: ${topics.length}件`);

  // 結果保存（全候補も含める）
  const selectedUrls = new Set(topics.map(t => t.url).filter(Boolean));
  const rejected = novel
    .filter(it => !selectedUrls.has(it.url))
    .map(it => ({ title: it.title, source: it.source, url: it.url, date: it.date }));
  const result = { scoutedAt: new Date().toISOString(), topicCount: topics.length, topics, rejected };
  fs.writeFileSync(SCOUT_FILE, JSON.stringify(result, null, 2));

  // 使用済みに追加
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
