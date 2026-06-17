// v4_launcher/scripts/v4_scout.js
// V4ニューススカウト（YouTube RSS ベース）
//   → サッカー速報系チャンネルのRSSから最新動画タイトルを収集
//   → 重複排除・被りスコアリング → DeepSeek で案件名生成
//   → 48h 重複排除 (used_topics.json)
'use strict';

const path  = require('path');
const fs    = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { callAI } = require('../../scripts/ai_client');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const SCOUT_FILE   = path.join(DATA_DIR, 'scout_results.json');
const HISTORY_FILE = path.join(DATA_DIR, 'scout_history.json');
const USED_FILE    = path.join(DATA_DIR, 'used_topics.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FRESHNESS_HOURS = 48;

const YT_CHANNELS = [
  { id: 'UCMu08XN0y5PDstIZuIvGI4Q', name: 'uwasathefootball2' },
  { id: 'UChh0v1SKmhWT46AvTCtDhOA', name: 'soccer-labo' },
  { id: 'UCQ2yepON1XgzXdU622bdJag', name: 'soccerhannousyu' },
  { id: 'UCiqOY9-kU6ZdkqgTeEvQk9w', name: 'soccer_chiebukuro' },
  { id: 'UCUbpukVQZHXV_3Uh1O7JACQ', name: 'sokuhosoccer', trusted: true },
];

// ─────────────────────────────────────────────────────────────
// YouTube RSS 取得
// ─────────────────────────────────────────────────────────────
function _parseXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : '';
}

function _parseEntries(xml) {
  const entries = [];
  const parts = xml.split('<entry>').slice(1);
  for (const part of parts) {
    const block = part.split('</entry>')[0] || '';
    const title = _parseXmlTag(block, 'title');
    const published = _parseXmlTag(block, 'published');
    const videoId = _parseXmlTag(block, 'yt:videoId');
    const descBlock = block.match(/<media:description>([\s\S]*?)<\/media:description>/);
    const description = descBlock ? descBlock[1].trim() : '';
    if (title && videoId) {
      entries.push({ title, published, videoId, description });
    }
  }
  return entries;
}

async function _fetchYouTubeRSS() {
  const items = [];
  const cutoff = Date.now() - FRESHNESS_HOURS * 3600 * 1000;

  const fetches = YT_CHANNELS.map(async (ch) => {
    try {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const xml = await res.text();
      const entries = _parseEntries(xml);
      const channelItems = [];
      for (const e of entries) {
        const pubDate = new Date(e.published);
        if (!isNaN(pubDate.getTime()) && pubDate.getTime() < cutoff) continue;
        const hashtags = (e.description.match(/#[^\s#]+/g) || []).slice(0, 20).join(' ');
        channelItems.push({
          title: e.title,
          source: `YT/${ch.name}`,
          url: `https://www.youtube.com/watch?v=${e.videoId}`,
          date: e.published,
          hashtags,
        });
      }
      return channelItems;
    } catch (e) {
      console.warn(`[scout] YT/${ch.name} RSS失敗:`, e.message);
      return [];
    }
  });

  const results = await Promise.all(fetches);
  for (const channelItems of results) items.push(...channelItems);
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
// 被りスコアリング: 複数チャンネルが扱ってるネタほど高スコア
// ─────────────────────────────────────────────────────────────
function _scoreByOverlap(items) {
  for (let i = 0; i < items.length; i++) {
    const refs = [{ title: items[i].title, hashtags: items[i].hashtags || '', source: items[i].source }];
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (_similarTitle(items[i].title, items[j].title)) {
        refs.push({ title: items[j].title, hashtags: items[j].hashtags || '', source: items[j].source });
      }
    }
    items[i].overlap = new Set(refs.map(r => r.source)).size;
    items[i].refVideos = refs;
  }
  return items;
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
// DeepSeek: YouTube動画タイトルから案件名を生成
// ─────────────────────────────────────────────────────────────
async function _pickTopics(items, maxTopics = 30) {
  const block = items.map((it, i) =>
    `${i+1}. [被り${it.overlap}ch] ${it.title}${it.hashtags ? ' / tags: ' + it.hashtags : ''}`
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
以下はサッカー速報系YouTubeチャンネルの最新動画タイトル一覧です。
「被りNch」は同じネタを扱ったチャンネル数（多い＝注目度が高い）。

**選定基準（優先順）**
1. 被りが多いネタ（複数chが扱っている）→ 最優先
2. W杯・CL・PL・リーガなど主要大会の試合結果・トピック → 高優先
3. 有名選手の移籍・スキャンダル・記録・名場面 → 高優先
4. 日本代表・日本人選手 → 高優先
5. ネタ化・笑い・驚きになる要素があるか → 重要
6. 同じ出来事を扱う動画は1件にまとめる

**5chスレタイの例（このノリ・テンションで topic を作る）:**
${examples}

**スレタイのルール:**
- 【悲報】【朗報】【速報】【完全覚醒】等のタグを適宜つける
- 「○○さん、△△してしまうwww」「○○した結果wwwww」「○○な模様」「○○がこちら」等の5ch定番構文を使う
- 選手・チームを「さん」「君」「ニキ」等で親しみを込めて呼ぶのもOK
- 長すぎない（40字以内）。パッと見てネタが分かること
- 選手やクラブへのリスペクトは忘れない。愛あるイジりはOKだが誹謗中傷はNG

【動画タイトル一覧（${items.length}件）】
${block}

上位${maxTopics}件を選んでください。
同じ出来事を扱う動画は1件にまとめてください。

それぞれ:
- topic: 5chスレタイ風の案件名（40字以内）※上記の例を参考に
- score: 0〜100（被りchが多いほど高スコアにする）
- originalIndex: 上記番号（1始まり）。まとめた場合は代表の1件

JSONのみ:
{"topics":[{"topic":"【悲報】エンバペ君、ファンダイクに勝負を挑んだ結果wwwww","score":88,"originalIndex":3}]}`;

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
          source: String(orig.source || ''),
          title:  orig.title || '',
          url:    orig.url   || '',
          date:   orig.date  || null,
          refVideos: orig.refVideos || [],
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
  const maxTopics = opts.maxTopics || 30;
  const onProgress = opts.onProgress || (() => {});
  console.log('[v4_scout] 開始:', new Date().toLocaleString('ja-JP'));

  onProgress({ stage: 'fetch', message: 'YouTube RSS を取得中...' });

  const ytItems = await _fetchYouTubeRSS();
  console.log(`[v4_scout] 取得: YT=${ytItems.length}件 (${YT_CHANNELS.length}ch)`);
  onProgress({ stage: 'filter', message: `${ytItems.length}件取得 → 重複排除・スコアリング中...` });

  // 被りスコアリング（dedup前に実施）
  _scoreByOverlap(ytItems);

  // 重複排除
  const deduped = _dedup(ytItems);

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

  // 過去案件格納庫に追記（7日分保持）
  _appendHistory(topics);

  return topics;
}

function _appendHistory(topics) {
  try {
    const history = fs.existsSync(HISTORY_FILE)
      ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'))
      : [];
    const entry = {
      scoutedAt: new Date().toISOString(),
      topics: topics.map(t => ({ topic: t.topic, score: t.score, source: t.source, url: t.url })),
    };
    history.push(entry);
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const trimmed = history.filter(h => new Date(h.scoutedAt).getTime() > cutoff);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed, null, 2));
  } catch (e) {
    console.warn('[scout] 履歴保存失敗:', e.message);
  }
}

module.exports = { runScout, SCOUT_FILE, HISTORY_FILE, dedupItems: _dedup, similarTitle: _similarTitle };

if (require.main === module) {
  runScout().then(t => {
    console.log('\n=== スカウト結果 ===');
    t.forEach((it, i) => console.log(`${i+1}. [${it.score}] [${it.source}] ${it.topic}\n   ${it.hook}`));
  }).catch(console.error);
}
