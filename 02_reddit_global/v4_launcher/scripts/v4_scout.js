// v4_launcher/scripts/v4_scout.js
// ニューススカウト: Brave Searchで最新サッカーニュースを取得しスコアリング
// 優先: 日本代表 > 日本人欧州組 > 欧州主要リーグ
//
// 使い方:
//   require('./v4_scout').runScout()  → トピック一覧を返す
//   node v4_scout.js                 → CLIテスト
'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { fetchSerper } = require('../../scripts/modules/fetchers/brave_search_module');
const { callAI }      = require('../../scripts/ai_client');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const SCOUT_FILE  = path.join(DATA_DIR, 'scout_results.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── 検索クエリ定義 ────────────────────────────────────────────
const QUERIES = [
  // 日本関連（最優先）
  { q: '日本代表 サッカー 最新',    lang: 'ja', weight: 100, tag: '日本代表' },
  { q: '三笘 久保 南野 遠藤 最新',  lang: 'ja', weight: 90,  tag: '日本人' },
  { q: '日本人選手 欧州 移籍 速報', lang: 'ja', weight: 85,  tag: '日本人' },
  // 欧州主要ニュース
  { q: 'Premier League breaking news today', lang: 'en', weight: 70, tag: 'PL' },
  { q: 'Champions League latest news',       lang: 'en', weight: 65, tag: 'CL' },
  { q: 'football transfer news today',       lang: 'en', weight: 60, tag: '移籍' },
  { q: 'サッカー 速報 今日',                 lang: 'ja', weight: 75, tag: '速報' },
];

const BLOCKED_HOSTS = new Set([
  'youtube.com','youtu.be','tiktok.com','instagram.com',
  'twitter.com','x.com','facebook.com',
]);

function _norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w぀-鿿]+/g, ' ').trim();
}

// タイトル重複チェック（先頭15文字で判定）
function _dedupByTitle(items) {
  const seen = new Set();
  return items.filter(it => {
    const key = _norm(it.title).slice(0, 15);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// AIがトピックをスコアリング・要約してJSON返す
async function _scoreTopics(rawItems, maxTopics = 7) {
  const block = rawItems.slice(0, 30).map((it, i) =>
    `${i+1}. [${it.tag}] ${it.title} (${it.date || '?'})\n   ${it.snippet}`
  ).join('\n\n');

  const prompt = `あなたはサッカーYouTubeコンテンツのプロデューサーです。
以下のニュース一覧から、**日本人視聴者（45〜54歳サッカーファン）が「見たい！」と思う案件**を最大${maxTopics}件選んでスコアリングしてください。

優先順:
1. 日本代表・日本人選手に直接関係するニュース（最優先）
2. 有名選手の移籍・スキャンダル・記録達成
3. CL/PL/欧州主要大会の話題
4. J-League専用ネタは低優先（メジャーな選手移籍は除く）

【ニュース一覧】
${block}

各案件について:
- topic: 案件の一言要約（20字以内）
- hook: 視聴者が食いつくフック（2chっぽい煽り文、30字以内）
- score: 0〜100（日本人視聴者のニーズ度）
- tag: 上の[タグ]をそのまま使う
- originalIndex: 上記リストの番号（1始まり）

JSONのみ:
{
  "topics": [
    {"topic":"コナテ、マドリー移籍決定か","hook":"えっこれマジ？リバポ大ピンチwwww","score":88,"tag":"PL","originalIndex":3},
    ...
  ]
}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      max_tokens: 2000,
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
        const orig = rawItems[(t.originalIndex || 1) - 1] || {};
        return {
          topic:     String(t.topic || '').slice(0, 30),
          hook:      String(t.hook  || '').slice(0, 50),
          score:     Math.max(0, Math.min(100, Number(t.score) || 50)),
          tag:       String(t.tag   || ''),
          title:     orig.title || '',
          url:       orig.url   || '',
          snippet:   orig.snippet || '',
          date:      orig.date  || null,
        };
      });
  } catch (e) {
    console.warn('[v4_scout] スコアリング失敗:', e.message);
    return rawItems.slice(0, maxTopics).map(it => ({
      topic: it.title.slice(0, 30),
      hook:  '',
      score: it.weight || 50,
      tag:   it.tag || '',
      title: it.title,
      url:   it.url,
      snippet: it.snippet,
      date:  it.date || null,
    }));
  }
}

// ── メイン: スカウト実行 ──────────────────────────────────────
async function runScout(opts = {}) {
  const maxTopics = opts.maxTopics || 7;
  console.log('[v4_scout] 開始:', new Date().toLocaleString('ja-JP'));

  // 全クエリ並列実行
  const results = await Promise.all(
    QUERIES.map(q =>
      fetchSerper(q.q, '', q.lang, null, { num: 10 })
        .then(r => ({ ...q, organic: r?.organic || [] }))
        .catch(() => ({ ...q, organic: [] }))
    )
  );

  // 結果を統合・正規化
  const allItems = [];
  for (const res of results) {
    for (const r of res.organic) {
      let host = 'unknown';
      try { host = new URL(r.link || '').hostname.replace(/^www\./, ''); } catch (_) {}
      if (BLOCKED_HOSTS.has(host)) continue;
      allItems.push({
        title:   (r.title   || '').trim(),
        snippet: (r.snippet || '').slice(0, 200),
        url:     r.link || '',
        date:    r.date || null,
        host,
        weight:  res.weight,
        tag:     res.tag,
      });
    }
  }

  // タイトル重複排除
  const deduped = _dedupByTitle(allItems);
  console.log(`[v4_scout] 収集: ${allItems.length}件 → 重複排除後 ${deduped.length}件`);

  // AIスコアリング
  const topics = await _scoreTopics(deduped, maxTopics);
  console.log(`[v4_scout] 案件${topics.length}件 スコア: ${topics.map(t => t.score).join(', ')}`);

  // 保存
  const result = {
    scoutedAt: new Date().toISOString(),
    topicCount: topics.length,
    topics,
  };
  fs.writeFileSync(SCOUT_FILE, JSON.stringify(result, null, 2));
  console.log('[v4_scout] 保存:', SCOUT_FILE);

  return topics;
}

module.exports = { runScout, SCOUT_FILE };

// ── CLIテスト ─────────────────────────────────────────────────
if (require.main === module) {
  runScout({ maxTopics: 7 }).then(topics => {
    console.log('\n=== スカウト結果 ===');
    topics.forEach((t, i) => {
      console.log(`\n${i+1}位 [${t.score}点] [${t.tag}] ${t.topic}`);
      console.log(`   フック: ${t.hook}`);
      console.log(`   ${t.title}`);
    });
  }).catch(console.error);
}
