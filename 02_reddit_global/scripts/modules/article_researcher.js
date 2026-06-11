// scripts/modules/article_researcher.js
// 記事ディープリサーチパイプライン
//
// フロー:
//   ① 検索クエリ拡張（既存3本 + 角度クエリ2本）で最大30候補を収集
//   ② Q1(15本)のHTTPフェッチ完了 → DeepSeekで事実抽出 ＋ 同時にQ2(15本)HTTPフェッチ
//   ③ Q2フェッチ完了 → DeepSeekで事実抽出
//   ④ 全事実 + enrichedMemo を校正AI(DeepSeek)に渡して照合
//   ⑤ 合格事実 + 制約リスト(選外・負傷選手) を返す
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { callAI }            = require('../ai_client');
const { fetchSerper }       = require('./fetchers/brave_search_module');
const { fetchArticleContent } = require('./fetchers/article_fetcher');

const QUEUE_SIZE   = 15;
const MAX_EN       = 22;  // 4クエリ×10件→フィルタ後22件
const MAX_JA       = 8;
// 各記事の抽出サマリ上限（出力800字相当）
const SUMMARY_CHARS = 800;
// AIに渡す1記事あたりの本文上限
const ARTICLE_INPUT_CHARS = 1800;

// ─── ソーススコア（step2から流用）──────────────────────────────
const HIGH_SCORE_HOSTS = new Set([
  'sportsnavi.yahoo.co.jp','news.yahoo.co.jp','nhk.or.jp',
  'goal.com','bbc.com','bbc.co.uk','espn.com','theguardian.com',
  'theathletic.com','skysports.com','talksport.com',
  'transfermarkt.com','transfermarkt.de',
]);
function _srcScore(host) {
  if (!host) return 40;
  if (HIGH_SCORE_HOSTS.has(host)) return 75;
  for (const h of HIGH_SCORE_HOSTS) { if (host.endsWith(h)) return 70; }
  return 40;
}

const BLOCKED_HOSTS = new Set([
  'youtube.com','youtu.be','instagram.com','tiktok.com',
  'twitter.com','x.com','facebook.com',
]);

// ─── 角度クエリ生成（既存クエリから追加クエリを派生）──────────
function _buildExtendedQueries(searches) {
  const all = (searches || []).filter(Boolean);
  const enQueries = all.filter(q => !/[ぁ-ん]|[ァ-ン]|[一-龥]/.test(q)).slice(0, 2);
  const jaQueries = all.filter(q =>  /[ぁ-ん]|[ァ-ン]|[一-龥]/.test(q)).slice(0, 1);

  // 角度クエリ: EN1のキーワードから生成
  const baseKeywords = (enQueries[0] || '').split(/\s+/).slice(0, 3).join(' ');
  const angleQueries = baseKeywords ? [
    `${baseKeywords} injury squad latest`,
    `${baseKeywords} analysis tactical`,
  ] : [];

  return {
    en: [...enQueries, ...angleQueries].slice(0, 4),
    ja: jaQueries,
  };
}

// ─── 検索 → 候補リスト（フルテキストなし）────────────────────
async function _searchCandidates(queries) {
  const { en: enQ, ja: jaQ } = queries;
  const seen  = new Set();
  const results = [];

  const [enResults, jaResults] = await Promise.all([
    Promise.all(enQ.map(q => fetchSerper(q, '', 'en', null, { num: 10 }).catch(() => ({ organic: [] })))),
    Promise.all(jaQ.map(q => fetchSerper(q, '', 'ja', null, { num: 10 }).catch(() => ({ organic: [] })))),
  ]);

  function add(organic, lang, limit) {
    const items = [];
    for (const r of organic) {
      const title = (r.title || '').trim();
      if (!title) continue;
      let host = 'search';
      try { host = new URL(r.link).hostname.replace(/^www\./, ''); } catch (_) {}
      if (BLOCKED_HOSTS.has(host)) continue;
      const key = title.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ title, snippet: (r.snippet || '').slice(0, 260), link: r.link || '', host, lang, sourceScore: _srcScore(host) });
      if (items.length >= limit) break;
    }
    results.push(...items);
  }

  const enOrganic = enResults.flatMap(r => r?.organic || []);
  const jaOrganic = jaResults.flatMap(r => r?.organic || []);
  add(enOrganic.sort((a, b) => _srcScore((b.link||'').split('/')[2]) - _srcScore((a.link||'').split('/')[2])), 'en', MAX_EN);
  add(jaOrganic.sort((a, b) => _srcScore((b.link||'').split('/')[2]) - _srcScore((a.link||'').split('/')[2])), 'ja', MAX_JA);

  return results.slice(0, QUEUE_SIZE * 2);
}

// ─── フルテキスト取得（並列）─────────────────────────────────
async function _loadFullTexts(articles) {
  await Promise.all(articles.map(async (a) => {
    if (!a.link) return;
    try {
      const res = await fetchArticleContent(a.link);
      if (res?.ok && res.content) {
        a.fullText = res.content.slice(0, ARTICLE_INPUT_CHARS);
      }
    } catch (_) {}
  }));
  return articles.filter(a => a.fullText || a.snippet);
}

// ─── DeepSeek: 記事バッチから事実抽出（800字サマリ）───────────
async function _extractFacts(articles, postTitle) {
  if (!articles.length) return [];

  const articleBlock = articles.map((a, i) => {
    const body = (a.fullText || a.snippet || '').trim();
    return `【記事${i+1}】[${a.host}] ${a.title}\n${body}`;
  }).join('\n\n---\n\n').slice(0, 28000);

  const prompt = `あなたはサッカーコンテンツの事実抽出エキスパートです。
以下の記事群（${articles.length}本）を熟読し、各記事から事実を構造化して抽出してください。

【動画案件】
${postTitle}

【記事群】
${articleBlock}

【抽出ルール】
1. 各記事につき1エントリ（空の記事はスキップ）
2. summary: 記事の要点と視点概要（${SUMMARY_CHARS}字以内）
3. key_fact: 動画に使える最重要事実1文（30字以内の日本語）
4. player_statuses: 記事に明示された選手ステータス（推測禁止。明示されていない場合は空配列）
   - name: 選手名（日本語）
   - status: "injured"（負傷中）/ "excluded"（選外）/ "suspended"（出場停止）/ "limited"（コンディション不良）/ "available"（問題なし）
   - evidence: 記事に書いてある根拠フレーズ（30字以内）
5. angle: "analysis"（分析）/ "criticism"（批判）/ "news"（速報）/ "reaction"（反応）/ "data"（データ）
6. catchiness: 0-100（動画フックとしての強さ）

JSONのみ（コードブロック不要）:
{
  "extractions": [
    {
      "article_index": 1,
      "host": "goal.com",
      "summary": "...",
      "key_fact": "...",
      "player_statuses": [
        {"name": "三笘薫", "status": "injured", "evidence": "左膝の負傷で全治3ヶ月と発表"}
      ],
      "angle": "news",
      "catchiness": 75
    }
  ]
}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    return Array.isArray(parsed.extractions) ? parsed.extractions : [];
  } catch (e) {
    console.warn('[article_researcher] extractFacts失敗:', e.message);
    return [];
  }
}

// ─── enrichedMemoからエンティティ情報を要約────────────────────
function _buildEnrichedSummary(siData) {
  const entities = (siData?.boxes?.entity?.items || []);
  return entities.map(it => {
    const name = it.label || '?';
    const role = it.role || '?';
    // TM怪我データ
    const tmInjury = it.tm?.injuries;
    const currentInjury = Array.isArray(tmInjury)
      ? tmInjury.find(inj => !inj.returnDate || new Date(inj.returnDate) > new Date())
      : null;
    const injuryNote = currentInjury
      ? `【注意: TM怪我データあり → ${currentInjury.injury || '詳細不明'} / 復帰予定: ${currentInjury.returnDate || '未定'}】`
      : '';
    // SofaScore基本データ
    const sofaOk = Boolean(it.sofa?.ok);
    return `- ${name} [${role}]${injuryNote}${sofaOk ? '' : ' (データ未取得)'}`;
  }).join('\n') || '(エンティティデータなし)';
}

// ─── 校正AI: 事実 vs enrichedMemo 照合────────────────────────
async function _validateFacts(allExtractions, siData, postTitle) {
  const enrichedSummary = _buildEnrichedSummary(siData);

  // 全player_statusesを集約
  const allStatuses = allExtractions.flatMap(e =>
    (e.player_statuses || []).map(ps => ({
      ...ps,
      source: e.host || '?',
      catchiness: e.catchiness || 50,
    }))
  );

  // 全key_factsを集約
  const allKeyFacts = allExtractions
    .filter(e => e.key_fact)
    .sort((a, b) => (b.catchiness || 0) - (a.catchiness || 0))
    .slice(0, 20)
    .map(e => `(${e.catchiness||50}) [${e.host}] ${e.key_fact}`);

  const prompt = `あなたはサッカーファクトチェッカーです。
記事から抽出した事実とenrichedMemo（公式データ）を照合し、企画ピース生成前の制約リストを作成してください。

【動画案件】${postTitle}

【enrichedMemo（公式取得データ）】
${enrichedSummary}

【記事から抽出した選手ステータス】
${allStatuses.length ? allStatuses.map(s =>
  `- ${s.name}: ${s.status} / 根拠:「${s.evidence}」/ 出典:${s.source}`
).join('\n') : '(ステータス言及なし)'}

【記事から抽出した重要事実（catchiness順）】
${allKeyFacts.join('\n') || '(なし)'}

【チェック方針】
- player_statusesの情報は「記事に明示的に書いてある」ものだけ。推測は含めない
- enrichedMemoのTM怪我データと記事情報が矛盾する場合は記事情報を優先（より新しい可能性が高い）
- unavailableに入れる条件: 負傷中/選外/出場停止のいずれかが記事またはenrichedMemoで確認できる
- limitedに入れる条件: コンディション不良・試合欠場続きなど

JSONのみ:
{
  "constraintList": {
    "unavailable": [
      {"name": "三笘薫", "reason": "負傷・選外", "evidence": "左膝負傷で代表落選（Goal.com）"}
    ],
    "limited": [
      {"name": "遠藤航", "reason": "コンディション不良", "evidence": "直近3試合ベンチ外（Sponichi）"}
    ],
    "keyFacts": [
      "日本代表はW杯最終予選で首位通過",
      "三笘の離脱で左サイドに空白"
    ]
  },
  "validationNotes": "校正で修正・除外した内容があれば記載（なければ空文字）"
}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) return _fallbackConstraints();
    const parsed = JSON.parse(m[0]);
    return {
      constraintList: _normalizeConstraintList(parsed.constraintList),
      validationNotes: String(parsed.validationNotes || ''),
    };
  } catch (e) {
    console.warn('[article_researcher] validateFacts失敗:', e.message);
    return _fallbackConstraints();
  }
}

function _fallbackConstraints() {
  return {
    constraintList: { unavailable: [], limited: [], keyFacts: [] },
    validationNotes: '校正AI失敗のためデフォルト値',
  };
}

function _normalizeConstraintList(raw) {
  if (!raw || typeof raw !== 'object') return { unavailable: [], limited: [], keyFacts: [] };
  return {
    unavailable: Array.isArray(raw.unavailable)
      ? raw.unavailable.map(it => ({
          name:     String(it.name     || '').trim().slice(0, 30),
          reason:   String(it.reason   || '').trim().slice(0, 40),
          evidence: String(it.evidence || '').trim().slice(0, 80),
        })).filter(it => it.name)
      : [],
    limited: Array.isArray(raw.limited)
      ? raw.limited.map(it => ({
          name:     String(it.name     || '').trim().slice(0, 30),
          reason:   String(it.reason   || '').trim().slice(0, 40),
          evidence: String(it.evidence || '').trim().slice(0, 80),
        })).filter(it => it.name)
      : [],
    keyFacts: Array.isArray(raw.keyFacts)
      ? raw.keyFacts.map(s => String(s || '').trim()).filter(Boolean).slice(0, 10)
      : [],
  };
}

// ─── DeepSeek: 記事事実からエンティティラベル提案（最大6件）────
// suggest-labelsの代替。記事に実際に登場した人物・チームから重要度順に絞り込む
async function _suggestEntitiesFromResearch(allExtractions, constraintList, postTitle) {
  if (!allExtractions.length) return [];

  // 言及頻度カウント（player_statusesに名前が出た回数）
  const mentionCount = {};
  allExtractions.forEach(e => {
    (e.player_statuses || []).forEach(ps => {
      const name = (ps.name || '').trim();
      if (name) mentionCount[name] = (mentionCount[name] || 0) + 1;
    });
  });

  // catchiness上位の記事サマリを渡す
  const topSummaries = [...allExtractions]
    .sort((a, b) => (b.catchiness || 0) - (a.catchiness || 0))
    .slice(0, 12)
    .map((e, i) => `${i+1}. [${e.host}] ${e.key_fact || ''}\n${String(e.summary || '').slice(0, 300)}`)
    .join('\n\n');

  const mentionBlock = Object.entries(mentionCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => `- ${name}: ${count}件`)
    .join('\n') || '(なし)';

  const unavailableNames = (constraintList.unavailable || []).map(it => it.name).join('、') || 'なし';

  const prompt = `あなたはサッカーデータ取得の優先度判断エキスパートです。
以下の記事リサーチ結果から、SofaScore/Transfermarkt/Wikipediaでデータを取得すべきエンティティを最大6件提案してください。

【動画案件】${postTitle}

【記事内での言及頻度（多いほど重要）】
${mentionBlock}

【記事サマリ（catchiness順）】
${topSummaries}

【出場不可（参考: 歴史データ目的での取得は可）】
${unavailableNames}

【選定ルール】
- 最大6件。記事が実際に取り上げた人物・チーム・大会のみ（推測禁止）
- 言及頻度が高い＋catchinessが高い記事に登場するエンティティを優先
- 出場不可でも「過去の実績比較」「不在の影響」に使えるなら入れてよい（unavailable:trueを付ける）
- role は player / manager / team / tournament のどれか
- name は必ず**公式英語表記フルネーム**（例: "Takumi Minamino" "FC Barcelona"）
- 解説者・アナリスト・記者は除外

JSONのみ:
{
  "entities": [
    {"name": "Takumi Minamino", "role": "player", "reason": "複数記事で代表最多得点として言及", "unavailable": false},
    {"name": "Kaoru Mitoma",    "role": "player", "reason": "負傷選外だが不在の影響を複数記事が分析", "unavailable": true}
  ]
}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed.entities)) return [];
    return parsed.entities
      .filter(it => it?.name && it?.role)
      .map(it => ({
        name:        String(it.name).trim().slice(0, 60),
        role:        ['player','manager','team','tournament'].includes(it.role) ? it.role : 'player',
        reason:      String(it.reason || '').trim().slice(0, 80),
        unavailable: Boolean(it.unavailable),
      }))
      .slice(0, 6);
  } catch (e) {
    console.warn('[article_researcher] suggestEntities失敗:', e.message);
    return [];
  }
}

// ─── メイン: ディープリサーチ実行 ────────────────────────────
// @param {string[]} searches - suggest-labelsで生成した検索クエリ
// @param {object}   siData   - enrichedMemo（entity/match取得済みデータ）
// @param {object}   opts     - { postTitle, onProgress }
// @returns {{ articleCount, q1Count, q2Count, extractions, constraintList, validationNotes, validatedAt }}
async function runDeepResearch(searches, siData, opts = {}) {
  const { postTitle = '', onProgress = () => {} } = opts;

  // 1. クエリ拡張
  const queries = _buildExtendedQueries(searches);
  console.log(`[DeepResearch] クエリ: EN×${queries.en.length} JA×${queries.ja.length}`);

  // 2. 候補URL収集（全クエリ並列）
  onProgress({ step: 'search', message: `${queries.en.length + queries.ja.length}クエリで記事候補収集中` });
  const candidates = await _searchCandidates(queries);
  console.log(`[DeepResearch] 候補: ${candidates.length}件`);

  const q1Candidates = candidates.slice(0, QUEUE_SIZE);
  const q2Candidates = candidates.slice(QUEUE_SIZE, QUEUE_SIZE * 2);

  // 3. Q1フルテキスト取得
  onProgress({ step: 'fetch_q1', message: `Q1: ${q1Candidates.length}本フェッチ中` });
  const q1Articles = await _loadFullTexts(q1Candidates);
  console.log(`[DeepResearch] Q1フェッチ完了: ${q1Articles.length}/${q1Candidates.length}本`);

  // 4. Q1事実抽出 + Q2フルテキスト取得（並列）
  onProgress({ step: 'extract_q1_fetch_q2', message: `Q1事実抽出 ＋ Q2フェッチ（並列）` });
  const [q1Extractions, q2Articles] = await Promise.all([
    _extractFacts(q1Articles, postTitle),
    _loadFullTexts(q2Candidates),
  ]);
  console.log(`[DeepResearch] Q1抽出: ${q1Extractions.length}件 / Q2フェッチ: ${q2Articles.length}本`);

  // 5. Q2事実抽出
  onProgress({ step: 'extract_q2', message: `Q2: ${q2Articles.length}本から事実抽出中` });
  const q2Extractions = q2Articles.length ? await _extractFacts(q2Articles, postTitle) : [];
  console.log(`[DeepResearch] Q2抽出: ${q2Extractions.length}件`);

  // 6. 校正AI
  const allExtractions = [...q1Extractions, ...q2Extractions];
  onProgress({ step: 'validate', message: `校正AI: ${allExtractions.length}件の事実をenrichedMemoと照合中` });
  const { constraintList, validationNotes } = await _validateFacts(allExtractions, siData, postTitle);
  console.log(`[DeepResearch] 校正完了: unavailable=${constraintList.unavailable.length} limited=${constraintList.limited.length}`);

  // 7. エンティティラベル提案（SofaScore/TM/Wiki取得用）
  onProgress({ step: 'suggest_entities', message: '記事ベースのエンティティラベル提案中' });
  const suggestedEntities = await _suggestEntitiesFromResearch(allExtractions, constraintList, postTitle);
  console.log(`[DeepResearch] エンティティ提案: ${suggestedEntities.map(e => e.name).join(', ')}`);

  return {
    articleCount:     q1Articles.length + q2Articles.length,
    q1Count:          q1Articles.length,
    q2Count:          q2Articles.length,
    extractions:      allExtractions,
    constraintList,
    validationNotes,
    suggestedEntities,
    validatedAt:      new Date().toISOString(),
  };
}

// ─── エンティティデータをテキスト化（アナライズブック用）────────
function _buildEntityText(siData) {
  const items = siData?.boxes?.entity?.items || [];
  if (!items.length) return '(エンティティデータなし)';
  return items.map(it => {
    const name = it.label || '?';
    const role = it.role || '?';
    const lines = [`【${name} / ${role}】`];
    // Wikipedia抜粋
    if (it.wiki?.ok && it.wiki.extract) {
      lines.push(`Wikipedia: ${String(it.wiki.extract).slice(0, 200)}`);
    }
    // SofaScoreスタッツ（文字列化）
    if (it.sofa?.ok) {
      const stats = it.sofa.stats || it.sofa.playerStats || it.sofa.teamStats;
      if (stats && typeof stats === 'object') {
        const entries = Object.entries(stats).slice(0, 8)
          .map(([k, v]) => `${k}: ${v}`).join(' / ');
        if (entries) lines.push(`Stats: ${entries}`);
      }
    }
    // TM怪我
    const inj = it.tm?.injuries;
    if (Array.isArray(inj) && inj.length) {
      const active = inj.find(i => !i.returnDate || new Date(i.returnDate) > new Date());
      if (active) lines.push(`怪我: ${active.injury || '詳細不明'} / 復帰: ${active.returnDate || '未定'}`);
    }
    // TM試合成績サマリ（player）
    if (it.tm?.seasonSummaries?.length) {
      const latest = it.tm.seasonSummaries[0];
      if (latest) lines.push(`今季TM: ${JSON.stringify(latest).slice(0, 120)}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

// ─── アナライズブック生成 ─────────────────────────────────────
// 全記事extractions + entity data → 論点別レポートに統合
// runDeepResearch と _runFetchAll の両方が完了した後に呼ぶこと
// @param {object[]} extractions  - runDeepResearchのallExtractions
// @param {object}   siData       - fetch-all完了後の最新siData
// @param {string}   postTitle    - 案件タイトル
// @returns {object} analyzeBook
async function buildAnalyzeBook(extractions, siData, postTitle) {
  if (!extractions?.length) return _fallbackBook();

  // 記事サマリブロック（catchiness順上位20件）
  const topExtractions = [...extractions]
    .sort((a, b) => (b.catchiness || 0) - (a.catchiness || 0))
    .slice(0, 20);

  const articleBlock = topExtractions.map((e, i) =>
    `[${i+1}] [${e.host}] angle:${e.angle||'?'} (${e.catchiness||50})\n` +
    `事実: ${e.key_fact || ''}\n` +
    `概要: ${String(e.summary || '').slice(0, 500)}`
  ).join('\n\n---\n\n').slice(0, 24000);

  const entityBlock = _buildEntityText(siData).slice(0, 6000);

  const prompt = `あなたはサッカーコンテンツのリサーチアナリストです。
以下の【記事リサーチ結果】と【取得済みデータ】を全て読んだ上で、
YouTube動画の企画・脚本に直接使えるアナライズブックを作成してください。

【動画案件】
${postTitle}

【記事リサーチ結果（${topExtractions.length}本・catchiness順）】
${articleBlock}

【取得済みデータ（SofaScore/TM/Wikipedia）】
${entityBlock}

【作成ルール】
- topics: 記事を横断して浮かび上がる論点を3〜5件。各論点に対して複数ソースを統合したレポートを書く
  - title: 論点タイトル（15〜25字）
  - report: 横断的まとめ（400〜600字）。単なる箇条書きでなく、「なぜ今重要か」「何が対立しているか」「どんなデータが裏付けるか」を繋げて書く
  - keyData: この論点を支える具体的な数字・事実（3件以内）
- entitySummary: 主要選手・チームのスタッツと状況を300字でまとめる（TM/SofaScoreデータ優先）
- wikiContext: Wikipedia由来の重要な歴史的文脈・背景（200字）
- situationOverview: 今この案件が注目される理由を一文で（80字以内）

JSONのみ（コードブロック不要）:
{
  "situationOverview": "...",
  "topics": [
    {
      "title": "三笘不在と左サイドの穴",
      "report": "...(400〜600字)...",
      "keyData": ["左サイド突破成功率チーム最高", "代替候補3名のスタッツ比較", "直近2試合での左からの失点"]
    }
  ],
  "entitySummary": "...",
  "wikiContext": "..."
}`;

  try {
    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-v4-flash',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (!m) return _fallbackBook();
    const parsed = JSON.parse(m[0]);
    return _normalizeBook(parsed);
  } catch (e) {
    console.warn('[article_researcher] buildAnalyzeBook失敗:', e.message);
    return _fallbackBook();
  }
}

function _fallbackBook() {
  return { situationOverview: '', topics: [], entitySummary: '', wikiContext: '', generatedAt: new Date().toISOString() };
}

function _normalizeBook(raw) {
  return {
    situationOverview: String(raw.situationOverview || '').slice(0, 120),
    topics: Array.isArray(raw.topics)
      ? raw.topics.slice(0, 5).map(t => ({
          title:   String(t.title   || '').slice(0, 40),
          report:  String(t.report  || '').slice(0, 800),
          keyData: Array.isArray(t.keyData) ? t.keyData.slice(0, 3).map(s => String(s).slice(0, 80)) : [],
        }))
      : [],
    entitySummary: String(raw.entitySummary || '').slice(0, 500),
    wikiContext:   String(raw.wikiContext   || '').slice(0, 400),
    generatedAt:   new Date().toISOString(),
  };
}

module.exports = { runDeepResearch, buildAnalyzeBook };
