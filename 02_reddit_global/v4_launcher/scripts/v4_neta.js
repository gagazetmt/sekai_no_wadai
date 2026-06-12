// v4_launcher/scripts/v4_neta.js
// ネタブック生成: 案件1件 → 記事3本+反応素材 → 6フィールド構造で生成
//
// 出力（ネタブック）:
//   title       : 2ch風タイトル（必須）
//   overview    : 概要紹介（必須）
//   supplement1 : 補足紹介① (null = AI判断で省略)
//   supplement2 : 補足紹介② (null = AI判断で省略)
//   comments1   : コメント集① (null = AI判断で省略)
//   comments2   : コメント集② (null = AI判断で省略)
//   mainEntity  : 主役の選手/チーム名（画像検索用）
//
// AI が素材を見て「埋める価値があるセクションだけ」埋める。
// 全体で 1200 字以内を目安とする。
'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { fetchSerper }         = require('../../scripts/modules/fetchers/brave_search_module');
const { fetchArticleContent } = require('../../scripts/modules/fetchers/article_fetcher');
const { callAI }              = require('../../scripts/ai_client');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const NETA_DIR   = path.join(DATA_DIR, 'neta_books');
const INDEX_FILE = path.join(NETA_DIR, '_index.json');
if (!fs.existsSync(NETA_DIR)) fs.mkdirSync(NETA_DIR, { recursive: true });

const ARTICLE_CHARS  = 2000;
const REACTION_CHARS = 300;

// V4_NETA_MODEL=sonnet → Anthropic Sonnet / それ以外 → DeepSeek Chat（デフォルト）
const NETA_MODEL = (process.env.V4_NETA_MODEL || 'deepseek').toLowerCase();

// ── キャッシュ管理 ──────────────────────────────────────────────
function _topicKey(topic) {
  return String(topic || '').toLowerCase()
    .replace(/[\s　。、！？!?.,:;]+/g, '')
    .slice(0, 50);
}

function _loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function _saveIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

/** キャッシュされたネタブックを返す。なければ null */
function getCachedBook(topic) {
  const key  = _topicKey(topic);
  const idx  = _loadIndex();
  const file = idx[key];
  if (!file) return null;
  const full = path.join(NETA_DIR, file);
  if (!fs.existsSync(full)) { delete idx[key]; _saveIndex(idx); return null; }
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (_) { return null; }
}

function _cacheBook(topic, book, filename) {
  const idx = _loadIndex();
  idx[_topicKey(topic)] = filename;
  _saveIndex(idx);
}

// ── 記事3本を取得 ─────────────────────────────────────────────
async function _fetchArticles(topic, existingUrl = '') {
  const enQ = topic.replace(/[ぁ-ん]|[ァ-ン]|[一-龥]/g, '').trim() || topic;
  const [enRes, jaRes] = await Promise.all([
    fetchSerper(enQ + ' latest',    '', 'en', null, { num: 8 }).catch(() => ({ organic: [] })),
    fetchSerper(topic + ' 最新情報', '', 'ja', null, { num: 8 }).catch(() => ({ organic: [] })),
  ]);

  const BLOCKED = new Set(['youtube.com','youtu.be','tiktok.com','instagram.com','twitter.com','x.com']);
  const seen = new Set([existingUrl].filter(Boolean));
  const candidates = [];

  for (const r of [...(enRes.organic||[]), ...(jaRes.organic||[])]) {
    let host = '';
    try { host = new URL(r.link||'').hostname.replace(/^www\./, ''); } catch(_) {}
    if (BLOCKED.has(host) || seen.has(r.link)) continue;
    seen.add(r.link);
    candidates.push({ title: r.title||'', url: r.link||'', snippet: r.snippet||'', host });
    if (candidates.length >= 6) break;
  }

  const articles = [];
  for (const c of candidates.slice(0, 5)) {
    try {
      const res = await fetchArticleContent(c.url);
      if (res?.ok && res.content) {
        articles.push({ ...c, fullText: res.content.slice(0, ARTICLE_CHARS) });
        if (articles.length >= 3) break;
      }
    } catch (_) {}
  }
  // 取れなかった分はスニペットで補完
  for (const c of candidates) {
    if (articles.length >= 3) break;
    if (!articles.find(a => a.url === c.url))
      articles.push({ ...c, fullText: c.snippet });
  }
  return articles.slice(0, 3);
}

// ── 反応スニペット収集（国内 + Reddit） ──────────────────────
async function _fetchReactionSnippets(topic) {
  const [jaRes, enRes] = await Promise.all([
    fetchSerper(topic + ' 反応 コメント', '', 'ja', null, { num: 5 }).catch(() => ({ organic: [] })),
    fetchSerper(topic + ' reaction reddit', '', 'en', null, { num: 4 }).catch(() => ({ organic: [] })),
  ]);
  const ja = (jaRes?.organic || []).map(r => r.snippet).filter(Boolean).slice(0, 3).join('\n');
  const en = (enRes?.organic || []).map(r => r.snippet).filter(Boolean).slice(0, 3).join('\n');
  return {
    jaReactions: ja.slice(0, REACTION_CHARS),
    enReactions: en.slice(0, REACTION_CHARS),
  };
}

// ── DeepSeek: ネタブック 1 発生成 ─────────────────────────────
async function _generateNetaBook(topic, hook, articles, reactions) {
  const articleBlock = articles.map((a, i) =>
    `【記事${i+1}】[${a.host}] ${a.title}\n${a.fullText}`
  ).join('\n\n---\n\n');

  const reactionBlock = [
    reactions.jaReactions ? `【国内反応スニペット】\n${reactions.jaReactions}` : '',
    reactions.enReactions ? `【海外反応スニペット】\n${reactions.enReactions}` : '',
  ].filter(Boolean).join('\n\n');

  const prompt = `あなたは2ch風サッカー動画チャンネルのコンテンツライターです。
以下の記事・反応素材を読んで、ショート動画用のネタブックを作ってください。

【案件】${topic}
${hook ? `【フックヒント】${hook}` : ''}

${articleBlock}

${reactionBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━
## 出力ルール

全体合計 **1200字以内**。
各セクションは「素材として使える内容がある場合のみ」埋める。ない場合は null にする。

| フィールド | 内容 | 文字数目安 | 必須? |
|---|---|---|---|
| title | 2ch風タイトル。煽り・驚き・笑いのどれか | 〜40字 | ✅必須 |
| overview | 「何が起きたか」を伝える概要 | 150〜250字 | ✅必須 |
| supplement1 | 記事にある「視聴者が知らない驚きの事実・数字・背景」 | 100〜200字 | 素材あれば |
| supplement2 | 別角度（共感・皮肉・クスッ）の補足 | 100〜200字 | 素材あれば |
| comments1 | コメント集①（国内or海外の反応 3〜4件、1件25字以内） | — | 反応あれば |
| comments2 | コメント集②（①と明らかに異なるトーンや立場 3〜4件） | — | 対比できるなら |
| mainEntity | 主役の選手名/チーム名（画像検索用・英語フルネーム推奨） | — | ✅必須 |
| tone_check | "ok" / "ng"（人格否定・差別・プライベート攻撃は ng） | — | ✅必須 |

## 判断基準

- supplement1/2 が似たような内容になるなら、どちらか 1 つだけ埋める
- comments1/2 は reactions セクションから自然に抽出できる文のみ使う。でっち上げ禁止
- comments2 は comments1 と明確にトーンや視点が違う場合だけ入れる
- 1200字を超えそうなら supplement を削ってでも title・overview を充実させる

JSONのみ:
{
  "title": "...",
  "overview": "...",
  "supplement1": "...",
  "supplement2": null,
  "comments1": ["...", "...", "..."],
  "comments2": null,
  "mainEntity": "Wataru Endo",
  "tone_check": "ok"
}`;

  const aiOpts = NETA_MODEL === 'sonnet'
    ? { forceProvider: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 3000 }
    : { forceProvider: 'deepseek',  model: 'deepseek-chat',     max_tokens: 3000 };
  console.log(`[v4_neta] モデル: ${NETA_MODEL === 'sonnet' ? 'claude-sonnet-4-6' : 'deepseek-chat'}`);

  const raw = await callAI({
    ...aiOpts,
    label: 'v4-neta',
    messages: [{ role: 'user', content: prompt }],
  });

  const m = raw && raw.match(/\{[\s\S]*?\n\}/);
  const m2 = m || (raw && raw.match(/\{[\s\S]*\}/));
  if (!m2) throw new Error('ネタブック生成失敗: JSON未検出');

  let parsed;
  try {
    parsed = JSON.parse(m2[0]);
  } catch (e) {
    // JSON が壊れていたら最小構造でフォールバック
    throw new Error('ネタブックJSON parse失敗: ' + e.message);
  }

  if (parsed.tone_check === 'ng') {
    throw new Error('tone_check: NG（誹謗中傷判定）');
  }

  // null/undefined/空文字 の正規化
  function clean(v, maxLen) {
    const s = String(v || '').trim();
    return s ? s.slice(0, maxLen) : null;
  }
  function cleanArr(v, maxItem, maxLen) {
    if (!Array.isArray(v) || !v.length) return null;
    const arr = v.map(x => String(x||'').trim()).filter(Boolean).map(x => x.slice(0, maxLen));
    return arr.length >= 2 ? arr.slice(0, maxItem) : null;
  }

  return {
    title:       clean(parsed.title, 60)        || topic,
    overview:    clean(parsed.overview, 300)     || '（概要未生成）',
    supplement1: clean(parsed.supplement1, 250),
    supplement2: clean(parsed.supplement2, 250),
    comments1:   cleanArr(parsed.comments1, 5, 40),
    comments2:   cleanArr(parsed.comments2, 5, 40),
    mainEntity:  clean(parsed.mainEntity, 80)    || '',
    tone_check:  'ok',
  };
}

// ── メイン ────────────────────────────────────────────────────
// force: true → キャッシュを無視して再生成
async function buildNetaBook(topicData, { force = false } = {}) {
  const { topic, hook = '', url = '' } = topicData;

  // キャッシュチェック（force=false のときのみ）
  if (!force) {
    const cached = getCachedBook(topic);
    if (cached) {
      console.log('[v4_neta] キャッシュ使用:', topic);
      return cached;
    }
  }

  console.log('[v4_neta] 開始:', topic);

  // 記事 + 反応素材 を並列取得
  const [articles, reactions] = await Promise.all([
    _fetchArticles(topic, url),
    _fetchReactionSnippets(topic),
  ]);
  console.log(`[v4_neta] 記事: ${articles.length}本 / 国内反応: ${reactions.jaReactions.length}字 / 海外: ${reactions.enReactions.length}字`);

  // AI ネタブック生成（1 API call）
  const neta = await _generateNetaBook(topic, hook, articles, reactions);
  console.log(`[v4_neta] 生成完了 s1:${!!neta.supplement1} s2:${!!neta.supplement2} c1:${!!neta.comments1} c2:${!!neta.comments2}`);

  const book = {
    topic,
    hook,
    title:       neta.title,
    overview:    neta.overview,
    supplement1: neta.supplement1,
    supplement2: neta.supplement2,
    comments1:   neta.comments1,
    comments2:   neta.comments2,
    mainEntity:  neta.mainEntity,
    articles:    articles.map(a => ({ title: a.title, url: a.url, host: a.host })),
    createdAt:   new Date().toISOString(),
  };

  const safeId  = topic.replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, '_').slice(0, 40);
  const fname   = `neta_${safeId}_${Date.now()}.json`;
  const outPath = path.join(NETA_DIR, fname);
  fs.writeFileSync(outPath, JSON.stringify(book, null, 2));
  _cacheBook(topic, book, fname);
  console.log('[v4_neta] 保存:', outPath);

  return book;
}

module.exports = { buildNetaBook, getCachedBook };

// ── CLI テスト ────────────────────────────────────────────────
if (require.main === module) {
  const topic = process.argv[2] || '遠藤航、W杯直前に離脱＆代表引退';
  buildNetaBook({ topic, hook: '' }).then(book => {
    console.log('\n=== ネタブック ===');
    console.log('①タイトル:', book.title);
    console.log('②概要:', book.overview);
    console.log('③補足1:', book.supplement1 || '（省略）');
    console.log('④補足2:', book.supplement2 || '（省略）');
    console.log('⑤コメント1:', book.comments1 ? book.comments1.join(' / ') : '（省略）');
    console.log('⑥コメント2:', book.comments2 ? book.comments2.join(' / ') : '（省略）');
    console.log('主役:', book.mainEntity);
  }).catch(console.error);
}
