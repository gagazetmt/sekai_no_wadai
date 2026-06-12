// v4_launcher/scripts/v4_neta.js
// ネタブック生成: 案件1件 → 記事3本読む → 概要+補足シナリオ2本+反応集を生成
//
// 出力（ネタブック）:
//   topic       : 案件タイトル
//   hook        : フック文（2ch煽り）
//   overview    : 概要説明（2〜3文）
//   scenario1   : 補足シナリオ①（視聴者が知らない事実・驚き）
//   scenario2   : 補足シナリオ②（別角度・共感・クスッ）
//   reactions   : Reddit/Yahoo反応集（5件）
//   mainEntity  : 主役の選手/チーム名（画像検索用）
'use strict';

const path = require('path');
const fs   = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { fetchSerper }        = require('../../scripts/modules/fetchers/brave_search_module');
const { fetchArticleContent } = require('../../scripts/modules/fetchers/article_fetcher');
const { callAI }             = require('../../scripts/ai_client');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const NETA_DIR   = path.join(DATA_DIR, 'neta_books');
if (!fs.existsSync(NETA_DIR)) fs.mkdirSync(NETA_DIR, { recursive: true });

const ARTICLE_CHARS = 2000;  // 記事1本あたりの最大文字数

// ── 記事3本を取得してフルテキスト読み込み ────────────────────
async function _fetchArticles(topic, existingUrl = '') {
  // EN + JA の2クエリ並列
  const enQ = topic.replace(/[ぁ-ん]|[ァ-ン]|[一-龥]/g, '').trim() || topic;
  const [enRes, jaRes] = await Promise.all([
    fetchSerper(enQ + ' latest',   '', 'en', null, { num: 8 }).catch(() => ({ organic: [] })),
    fetchSerper(topic + ' 最新情報', '', 'ja', null, { num: 8 }).catch(() => ({ organic: [] })),
  ]);

  const BLOCKED = new Set(['youtube.com','youtu.be','tiktok.com','instagram.com','twitter.com','x.com']);
  const seen = new Set([existingUrl]);
  const candidates = [];

  for (const r of [...(enRes.organic||[]), ...(jaRes.organic||[])]) {
    let host = '';
    try { host = new URL(r.link||'').hostname.replace(/^www\./, ''); } catch(_) {}
    if (BLOCKED.has(host) || seen.has(r.link)) continue;
    seen.add(r.link);
    candidates.push({ title: r.title||'', url: r.link||'', snippet: r.snippet||'', host });
    if (candidates.length >= 6) break;
  }

  // 上位3本のフルテキスト取得
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
    if (!articles.find(a => a.url === c.url)) {
      articles.push({ ...c, fullText: c.snippet });
    }
  }

  return articles.slice(0, 3);
}

// ── DeepSeek: 記事からネタブック生成（誹謗中傷チェック込み）──
async function _generateNetaBook(topic, hook, articles) {
  const articleBlock = articles.map((a, i) =>
    `【記事${i+1}】[${a.host}] ${a.title}\n${a.fullText}`
  ).join('\n\n---\n\n');

  const prompt = `あなたは2chサッカー動画のコンテンツライターです。
以下の記事を読んで、120秒の動画用ネタブックを作ってください。

【案件】${topic}
【フック】${hook}

【記事】
${articleBlock}

【ネタブックの形式】
- overview: 案件の概要（2〜3文・60〜100字）。「何が起きたか」を伝える
- scenario1: 補足シナリオ①（40〜80字）
  ・記事から発見した「視聴者が知らなかった事実」
  ・「えっそうなの！？」と思わせる数字・背景・文脈
  ・例:「ちなみに○○は今季リーグ最多のシュート数を記録しながら、得点は最下位クラスなんですよね」
- scenario2: 補足シナリオ②（40〜80字）
  ・別角度から。共感・クスッとくる笑い・皮肉
  ・例:「そのクラブ、去年も全く同じことして炎上してましたよね」
- mainEntity: 主役の選手名またはクラブ名（画像検索用・英語フルネーム推奨）
- tone_check: "ok" または "ng"（誹謗中傷・差別・悪意ある攻撃が含まれれば "ng"）
  ・NGの判定基準: 選手の人格否定、差別、プライベートへの攻撃
  ・OKの判定基準: ネタ化されてる欠点、公式記録の数字、記事に書いてある事実

JSONのみ:
{
  "overview": "...",
  "scenario1": "...",
  "scenario2": "...",
  "mainEntity": "Ibrahima Konate",
  "tone_check": "ok"
}`;

  const raw = await callAI({
    forceProvider: 'deepseek',
    model: 'deepseek-v4-flash',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });

  const m = raw && raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('ネタブック生成失敗: JSON未検出');
  const parsed = JSON.parse(m[0]);

  if (parsed.tone_check === 'ng') {
    throw new Error('tone_check: NG（誹謗中傷判定）');
  }

  return {
    overview:    String(parsed.overview    || '').slice(0, 150),
    scenario1:   String(parsed.scenario1   || '').slice(0, 120),
    scenario2:   String(parsed.scenario2   || '').slice(0, 120),
    mainEntity:  String(parsed.mainEntity  || '').slice(0, 60),
    tone_check:  'ok',
  };
}

// ── Reddit/Yahoo反応を取得 ────────────────────────────────────
async function _fetchReactions(topic) {
  const jaQ = topic + ' 反応 コメント';
  try {
    const res = await fetchSerper(jaQ, '', 'ja', null, { num: 6 });
    const snippets = (res?.organic || []).slice(0, 3)
      .map(r => r.snippet || '').filter(Boolean);

    if (!snippets.length) return _defaultReactions();

    // スニペットから反応っぽい文を抽出（DeepSeek）
    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `以下のスニペットから、サッカーファンの反応コメントっぽい文を5件抽出してください。
2ch/Yahoo風の短いコメントとして自然なもの。存在しなければ作らず、あるものだけ。

${snippets.join('\n')}

JSONのみ: {"reactions": ["コメント1","コメント2","コメント3","コメント4","コメント5"]}`
      }],
    });
    const mm = raw && raw.match(/\{[\s\S]*\}/);
    if (!mm) return _defaultReactions();
    const p = JSON.parse(mm[0]);
    const reactions = Array.isArray(p.reactions)
      ? p.reactions.filter(Boolean).slice(0, 5)
      : [];
    return reactions.length >= 2 ? reactions : _defaultReactions();
  } catch (_) {
    return _defaultReactions();
  }
}

function _defaultReactions() {
  return ['反応収集中...', 'もう少しお待ちください', '', '', ''];
}

// ── メイン: ネタブック生成 ─────────────────────────────────────
async function buildNetaBook(topicData) {
  const { topic, hook = '', url = '' } = topicData;
  console.log('[v4_neta] 開始:', topic);

  // 1. 記事取得
  const articles = await _fetchArticles(topic, url);
  console.log(`[v4_neta] 記事取得: ${articles.length}本`);

  // 2. ネタブック生成（tone_checkはここで判定）
  const neta = await _generateNetaBook(topic, hook, articles);
  console.log('[v4_neta] 生成完了 tone:', neta.tone_check);

  // 3. 反応取得（並列可能だが記事取得と順番にして負荷分散）
  const reactions = await _fetchReactions(topic);

  const book = {
    topic,
    hook,
    overview:   neta.overview,
    scenario1:  neta.scenario1,
    scenario2:  neta.scenario2,
    mainEntity: neta.mainEntity,
    reactions:  reactions.map((text, i) => ({ text, score: 100 - i * 10 })),
    articles:   articles.map(a => ({ title: a.title, url: a.url, host: a.host })),
    createdAt:  new Date().toISOString(),
  };

  // 保存
  const safeId = topic.replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, '_').slice(0, 40);
  const outPath = path.join(NETA_DIR, `neta_${safeId}_${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(book, null, 2));
  console.log('[v4_neta] 保存:', outPath);

  return book;
}

module.exports = { buildNetaBook };

// ── CLIテスト ─────────────────────────────────────────────────
if (require.main === module) {
  buildNetaBook({
    topic: 'コナテ、リバプールとの契約延長しなかった理由',
    hook:  'えっこれマジ？リバポ大ピンチwwww',
  }).then(book => {
    console.log('\n=== ネタブック ===');
    console.log('概要:', book.overview);
    console.log('シナリオ①:', book.scenario1);
    console.log('シナリオ②:', book.scenario2);
    console.log('主役:', book.mainEntity);
    console.log('反応:', book.reactions.map(r => r.text).join(' / '));
  }).catch(console.error);
}
