// v3_launcher/v3_research.js
// V3 topic research layer.
//
// Reuses V2 fetchers, but keeps V3 selection/scoring separate:
// 3 queries -> pick 3-5 useful URLs per query -> fetch article text -> build learning corpus.

const path = require('path');
const { fetchSerper } = require('../scripts/modules/fetchers/serper_module');
const { fetchArticleContent } = require('../scripts/modules/fetchers/article_fetcher');
const {
  fetchWikipediaSafe,
  fetchPlayerCareerEvents,
  fetchTeamHonoursEvents,
} = require('../scripts/modules/fetchers/wikipedia');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));

const DEFAULT_QUERY_LIMIT = 3;
const DEFAULT_PICK_MIN = 3;
const DEFAULT_PICK_MAX = 6;
const ARTICLE_CHAR_LIMIT = 3200;
const FULL_TEXT_TARGET = 5;
const EXTRA_FETCH_LIMIT = 8;

const TRUSTED_DOMAIN_HINTS = [
  'fifa.com',
  'uefa.com',
  'rfef.es',
  'realmadrid.com',
  'fcbarcelona.com',
  'theathletic.com',
  'bbc.com',
  'skysports.com',
  'reuters.com',
  'apnews.com',
  'espn.com',
  'marca.com',
  'as.com',
  'elpais.com',
  'beinsports.com',
];

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 80);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function compactSearchQuery(query) {
  const raw = String(query || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\[\]【】「」『』"“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';

  const firstClause = raw.split(/[。！？!?]|(?:\s+-\s+)|(?:\s+｜\s+)|(?:\s+\|\s+)/)[0].trim();
  const base = firstClause || raw;
  if (/[぀-ヿ一-鿿]/.test(base)) {
    return base.slice(0, 72);
  }
  return base
    .split(/\s+/)
    .filter((w) => !/^(reddit|thread|comments?|video|youtube)$/i.test(w))
    .slice(0, 10)
    .join(' ')
    .slice(0, 96);
}

function parseLooseJson(raw) {
  const s = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(s);
  } catch (_) {}
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      return JSON.parse(obj[0]);
    } catch (_) {}
  }
  const arr = s.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      return JSON.parse(arr[0]);
    } catch (_) {}
  }
  return null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function freshnessScore(dateText) {
  const s = String(dateText || '').toLowerCase();
  if (!s) return 0.35;
  if (/hour|minute|today|yesterday|時間|分|今日|昨日/.test(s)) return 1.0;
  if (/day|日前/.test(s)) return 0.9;
  if (/week|週間/.test(s)) return 0.75;
  if (/month|ヶ月|か月/.test(s)) return 0.55;
  if (/2026/.test(s)) return 0.8;
  if (/2025/.test(s)) return 0.45;
  return 0.35;
}

function trustedScore(url) {
  const host = hostOf(url);
  if (!host) return 0.2;
  if (TRUSTED_DOMAIN_HINTS.some((d) => host.endsWith(d))) return 1.0;
  if (/\.(edu|gov)$/.test(host)) return 0.85;
  if (/wikipedia\.org$/.test(host)) return 0.75;
  return 0.45;
}

function relevanceScore(item, topic, query) {
  const text = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
  const terms = uniq([...tokenize(topic), ...tokenize(query)]).slice(0, 20);
  if (!terms.length) return 0.5;
  const hits = terms.filter((term) => text.includes(term)).length;
  return Math.min(1, hits / Math.min(8, terms.length));
}

function scoreSearchItem(item, topic, query) {
  const relevance = relevanceScore(item, topic, query);
  const freshness = freshnessScore(item.date);
  const trust = trustedScore(item.link);
  const score = relevance * 0.55 + freshness * 0.25 + trust * 0.20;
  return {
    ...item,
    host: hostOf(item.link),
    score: Number(score.toFixed(3)),
    scoreParts: {
      relevance: Number(relevance.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      trust: Number(trust.toFixed(3)),
    },
  };
}

function fallbackQueries(topic, memo = '') {
  const joined = `${topic}\n${memo}`;
  if (/(?=.*(マドリー|レアル|Real Madrid))(?=.*(スペイン代表|代表))(?=.*(0|ゼロ|いない|不在))/i.test(joined)) {
    return [
      'Spain squad no Real Madrid players',
      'Spain 2026 World Cup squad Real Madrid players zero',
      'Spain 2010 World Cup squad Barcelona Real Madrid players',
    ];
  }
  // Extract Latin/accented names from mixed Japanese+English title (e.g. "ジョアン・ペドロ João Pedro")
  const latinNames = (topic.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+)*/g) || [])
    .filter((w) => w.length >= 3 && !/^(the|and|for|with|news|latest|transfer|about|from|that|this)$/i.test(w));
  if (latinNames.length >= 1) {
    const nameStr = latinNames.slice(0, 2).join(' ');
    return [
      `${nameStr} 2026 news`,
      `${nameStr} transfer latest`,
      `${nameStr} stats season`,
    ];
  }
  const compactTopic = compactSearchQuery(topic);
  if (!compactTopic) {
    return ['football latest news', 'football transfer news', 'football stats'];
  }
  return [
    compactTopic,
    `${compactTopic} football latest news`,
    `${compactTopic} football background analysis`,
  ];
}

function pickQueries({ topic, memo = '', plan = null, queries = [] }) {
  const fromPlan = [];
  if (plan?.evidencePlan?.researchTasks) {
    for (const task of plan.evidencePlan.researchTasks) {
      for (const q of task.queries || []) fromPlan.push(q);
    }
  }
  return uniq(uniq([...queries, ...fromPlan, ...fallbackQueries(topic, memo)])
    .map(compactSearchQuery)
    .filter(Boolean))
    .slice(0, DEFAULT_QUERY_LIMIT);
}

function dedupeByUrl(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item.link || seen.has(item.link)) continue;
    seen.add(item.link);
    out.push(item);
  }
  return out;
}

async function enrichItemWithArticle(item) {
  const article = await fetchArticleContent(item.link);
  if (!article.ok || !article.content) {
    return {
      ...item,
      fetchStatus: article.url ? 'snippet_only' : 'blocked',
      articleText: '',
      learningText: `${item.title || ''}\n${item.snippet || ''}`.trim(),
    };
  }
  const articleText = article.content.slice(0, ARTICLE_CHAR_LIMIT);
  return {
    ...item,
    fetchStatus: article.method === 'jina_reader' ? 'full_text_reader' : 'full_text',
    articleText,
    learningText: `[${item.host}] ${item.title || ''}\n${item.snippet || ''}\n${articleText}`.trim(),
  };
}

function classifyUse(item) {
  const text = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
  const tags = [];
  if (/squad|convocatoria|call[- ]?up|roster|代表|招集/.test(text)) tags.push('fact_check');
  if (/2010|world cup|黄金期|history|historia/.test(text)) tags.push('contrast');
  if (/quote|said|de la fuente|監督|comment/.test(text)) tags.push('quote');
  if (/academy|cantera|la masia|youth|育成/.test(text)) tags.push('side_story');
  if (!tags.length) tags.push('background');
  return tags;
}

function fallbackQueryLabels(topic, memo = '') {
  const raw = `${topic}\n${memo}`;
  const labels = [];
  const push = (value) => {
    const clean = String(value || '').trim();
    if (clean && !labels.includes(clean)) labels.push(clean);
  };
  (raw.match(/[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'.-]+){0,3}/g) || [])
    .filter((w) => !/^(reddit|thread|comments?|news|latest|football|soccer|official|report|reports)$/i.test(w))
    .slice(0, 4)
    .forEach(push);
  (raw.match(/[\p{Script=Katakana}ー]{3,}|[\p{Script=Han}]{2,}/gu) || [])
    .filter((w) => !/^(ニュース|サッカー|代表|選出|負傷|移籍|報道|速報)$/.test(w))
    .slice(0, 5)
    .forEach(push);
  return labels.slice(0, 8);
}

function buildQueriesFromLabels(labels, topic) {
  const base = (labels || []).filter(Boolean).slice(0, 5);
  if (base.length >= 2) {
    const joined = base.slice(0, 4).join(' ');
    return uniq([
      joined,
      `${joined} football news`,
      `${joined} official report`,
    ]).slice(0, 3);
  }
  return fallbackQueries(topic).map(compactSearchQuery).filter(Boolean).slice(0, 3);
}

async function generateSearchPlan(topic, memo = '') {
  const prompt = `You are preparing search for a Japanese soccer-news case.

Case title:
${topic}

Context:
${memo || ''}

Make sure the search hits articles that report the exact case, not generic background.

Return JSON only:
{
  "queryLabels": ["main person/team", "related person/team", "national team/club"],
  "queries": ["targeted search query 1", "targeted search query 2", "targeted search query 3"]
}

Rules:
- queryLabels are short labels, 3 to 8 items.
- queries must combine multiple labels from the case.
- Include original Japanese names when the case is Japanese, and add English names only when useful.
- Do not output broad queries like "football latest news".
- Example: "ジョアン・ペドロ、負傷したネイマールに変わりブラジル代表選出か" -> labels ["ジョアン・ペドロ","ネイマール","ブラジル代表"], queries ["ジョアン・ペドロ ネイマール ブラジル代表 選出","Joao Pedro Neymar Brazil squad call up","Joao Pedro replaces Neymar Brazil injury"]`;
  try {
    const raw = await callAI({
      system: 'Output valid JSON only. No markdown.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      forceProvider: 'gemini',
      label: 'step2_query_plan',
    });
    const parsed = parseLooseJson(raw);
    const queryLabels = Array.isArray(parsed?.queryLabels)
      ? parsed.queryLabels.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
      : [];
    const queries = Array.isArray(parsed?.queries)
      ? parsed.queries.map((x) => compactSearchQuery(String(x))).filter(Boolean).slice(0, 3)
      : [];
    if (queryLabels.length && queries.length) return { queryLabels, queries };
  } catch (e) {
    console.warn('[v3_research] generateSearchPlan failed:', e.message);
  }
  const queryLabels = fallbackQueryLabels(topic, memo);
  return { queryLabels, queries: buildQueriesFromLabels(queryLabels, topic) };
}

// Use DeepSeek to convert a Japanese soccer topic into 3 targeted English search queries.
// Returns array of strings, or null if topic is already English or AI call fails.
async function generateEnglishQueries(topic, memo = '') {
  if (!/[぀-ヿ一-鿿]/.test(topic)) return null; // already Latin, skip
  const prompt = `Convert this Japanese soccer topic into 3 targeted English search queries for Google/Serper.

Topic: ${topic}
${memo ? `Context: ${memo}` : ''}

Rules:
- Translate Japanese names to proper English (ジョアン・ペドロ→João Pedro, マドリー→Real Madrid, ハーランド→Haaland, バルサ→Barcelona, etc.)
- Query 1: Specific news/event (5-8 words)
- Query 2: Squad/transfer/injury context (5-8 words)
- Query 3: Player or club stats/career (5-8 words)
- Output ONLY a valid JSON array: ["query1","query2","query3"]`;
  try {
    const raw = await callAI({
      system: 'Output a JSON array of 3 English search queries only. No explanation, no markdown.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
      forceProvider: 'gemini',
      label: '①query_gen',
    });
    const parsed = parseLooseJson(raw);
    if (Array.isArray(parsed) && parsed.filter(Boolean).length >= 2) {
      const qs = parsed.map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
      console.log('[v3_research] AI English queries:', qs);
      return qs;
    }
  } catch (e) {
    console.warn('[v3_research] generateEnglishQueries failed:', e.message);
  }
  return null;
}

async function runTopicResearch(input = {}) {
  const topic = String(input.topic || input.title || '').trim();
  const memo = String(input.memo || '').trim();
  const searchPlan = await generateSearchPlan(topic, memo);
  // AI-translate Japanese topic to English before building query list
  const aiQueries = await generateEnglishQueries(topic, memo);
  const queries = pickQueries({
    topic, memo, plan: input.plan,
    queries: [...(searchPlan.queries || []), ...(aiQueries || []), ...(input.queries || [])],
  });
  const pickMin = Number(input.pickMin || DEFAULT_PICK_MIN);
  const pickMax = Number(input.pickMax || DEFAULT_PICK_MAX);

  const queryResults = [];
  for (const query of queries) {
    const serper = await fetchSerper(query, 'v3_topic_research', input.lang || 'en', input.tbs || null);
    const scored = (serper.organic || [])
      .map((item) => scoreSearchItem(item, topic, query))
      .sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, Math.max(pickMin, Math.min(pickMax, scored.length)));
    queryResults.push({
      query,
      ok: serper.ok,
      error: serper.error || null,
      picked,
      candidates: scored,
    });
  }

  const allPicked = dedupeByUrl(queryResults.flatMap((r) => r.picked));
  let enriched = await Promise.all(allPicked.map(enrichItemWithArticle));
  const fullTextCount = enriched.filter((x) => /^full_text/.test(x.fetchStatus)).length;
  if (fullTextCount < FULL_TEXT_TARGET) {
    const pickedUrls = new Set(allPicked.map((x) => x.link));
    const extras = dedupeByUrl(queryResults.flatMap((r) => r.candidates || []))
      .filter((item) => item.link && !pickedUrls.has(item.link))
      .slice(0, EXTRA_FETCH_LIMIT);
    const extraEnriched = await Promise.all(extras.map(enrichItemWithArticle));
    const usefulExtras = extraEnriched
      .filter((x) => /^full_text/.test(x.fetchStatus))
      .slice(0, FULL_TEXT_TARGET - fullTextCount);
    enriched = dedupeByUrl([...enriched, ...usefulExtras]);
  }
  const learningItems = enriched.map((item) => ({
    ...item,
    usableFor: classifyUse(item),
  }));

  return {
    ok: true,
    topic,
    queryLabels: searchPlan.queryLabels || [],
    queries,
    serperCreditsEstimated: queries.length,
    queryResults,
    learningItems,
    learningCorpus: learningItems.map((item, i) => ({
      index: i + 1,
      title: item.title,
      url: item.link,
      host: item.host,
      fetchStatus: item.fetchStatus,
      score: item.score,
      usableFor: item.usableFor,
      text: item.learningText,
    })),
    summary: {
      queryCount: queries.length,
      selectedUrlCount: learningItems.length,
      fullTextCount: learningItems.filter((x) => /^full_text/.test(x.fetchStatus)).length,
      snippetOnlyCount: learningItems.filter((x) => !/^full_text/.test(x.fetchStatus)).length,
    },
  };
}

function pickWikiEntities({ topic = '', memo = '', entities = [], learningCorpus = [] } = {}) {
  const manual = Array.isArray(entities) ? entities : [];
  const joined = `${topic}\n${memo}`;

  // Step1: corpus から固有名詞を抽出（ウェブリサーチ後）
  const corpusText = (learningCorpus || []).slice(0, 8).map(x => x.title || '').join(' ');
  const STOP = new Set(['World','Cup','League','Premier','Serie','Bundesliga','Ligue','English','Spanish','Italian','French','German','European','Champion','Europa','Super','Final','Season','Soccer','Football','Reddit','Transfer','News',
    'MVP','VAR','SNS','TV','BBC','ESPN','Sky','God','His','Her','The','This','That','Also','After','Before','More','Most','All']);
  const TEAM_RE = /\b(fc|cf|sc|united|city|athletic|real|chelsea|arsenal|liverpool|barcelona|madrid|juventus|national|inter|ajax|dortmund|psv|ac milan|as roma)\b/i;
  const corpusNames = [];
  (corpusText.match(/[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-Þà-öø-ÿ'.-]{1,}(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-Þà-öø-ÿ'.-]{1,}){0,2}/g) || []).forEach(name => {
    if (name.length < 3 || STOP.has(name.split(' ')[0])) return;
    // skip all-caps abbreviations (MVP, VAR, SNS etc.)
    if (/^[A-Z]{2,5}$/.test(name.split(' ')[0])) return;
    corpusNames.push(name);
  });

  // Step2: topic/memo のキーワードマッチ（フォールバック）
  const known = [
    ['Real Madrid', /(マドリー|レアル|Real Madrid)/i],
    ['Spain national football team', /(スペイン代表|Spain national)/i],
    ['FC Barcelona', /(バルサ|Barcelona|バルセロナ)/i],
    ['Lamine Yamal', /(ヤマル|Yamal)/i],
    ['Pedri', /(ペドリ|Pedri)/i],
    ['Kylian Mbappe', /(ムバッペ|Mbappe)/i],
    ['Erling Haaland', /(ハーランド|Haaland)/i],
    ['Jude Bellingham', /(ベリンガム|Bellingham)/i],
  ];
  const inferred = known.filter(([, re]) => re.test(joined)).map(([name]) => name);

  return uniq([...manual, ...corpusNames.slice(0, 3), ...inferred]).slice(0, 4);
}

async function fetchWikiSideStories(input = {}) {
  const entities = pickWikiEntities(input);
  const results = [];
  for (const entity of entities) {
    const summary = await fetchWikipediaSafe([entity, `${entity} football`]).catch((e) => ({
      ok: false,
      error: e.message,
      extract: '',
    }));
    let events = null;
    if (/Real Madrid|Barcelona|Spain national/i.test(entity)) {
      events = await fetchTeamHonoursEvents(entity).catch((e) => ({ ok: false, error: e.message }));
    } else {
      events = await fetchPlayerCareerEvents(entity).catch((e) => ({ ok: false, error: e.message }));
    }
    results.push({
      entity,
      summary,
      events,
      sideStoryCandidates: buildSideStoryCandidates(entity, summary, events),
    });
  }
  return {
    ok: true,
    entityCount: entities.length,
    note: 'Wiki side stories are capped to 4 entities to avoid making the first research pass heavy.',
    results,
  };
}

function buildSideStoryCandidates(entity, summary, events) {
  const out = [];
  if (summary?.ok && summary.extract) {
    out.push({
      type: 'summary',
      text: `${entity}: ${summary.extract.slice(0, 260)}`,
      usableFor: ['context', 'side_story'],
    });
  }
  if (events?.ok && Array.isArray(events.events)) {
    events.events.slice(-5).forEach((ev) => {
      out.push({
        type: 'career_event',
        text: `${ev.year}: ${ev.title}${ev.description ? ` - ${ev.description}` : ''}`,
        usableFor: ['contrast', 'side_story'],
      });
    });
  }
  return out.slice(0, 6);
}

// AI reads topic/memo/articles → decides follow-up search queries + which entities need stats data.
// Returns { followUpQueries: string[], entities: {type, nameEn}[] }
// Note: works even with empty learningCorpus — extracts from topic/memo alone.
async function aiExpandResearch(topic, memo, learningCorpus) {
  const articles = (learningCorpus || []).slice(0, 5);
  const summaries = articles.length
    ? '\nArticles found:\n' + articles
        .map((a, i) => `[${i + 1}] ${a.title} (${a.host})\n${String(a.text || '').slice(0, 200)}`)
        .join('\n\n')
    : '';

  const prompt = `You are a soccer research assistant. Analyze the topic, context, and articles below.

Topic: ${topic}
${memo ? `Context: ${memo}` : ''}${summaries}

Tasks:
1. Up to 2 follow-up English search queries for specific factual gaps (regulations, official rules, key dates).
   Example: "FIFA World Cup 2026 squad replacement deadline"
2. Up to 4 soccer player or club names that need live stats data. IMPORTANT: translate Japanese names to English.
   Examples: ジョアン・ペドロ→João Pedro, ネイマール→Neymar, アンチェロッティ→Carlo Ancelotti,
   ブラジル代表→Brazil, スペイン代表→Spain, 日本代表→Japan, ヴィニシウス→Vinicius Junior, ムバッペ→Kylian Mbappe

Output JSON only (no markdown, no explanation):
{"followUpQueries":["query1"],"entities":[{"type":"player","nameEn":"Name"},{"type":"team","nameEn":"Club"}]}`;

  try {
    const raw = await callAI({
      system: 'Soccer research assistant. Output valid JSON only. No markdown.',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 450,
      forceProvider: 'gemini',
      label: '③entity_expand',
    });
    const parsed = parseLooseJson(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('AI expansion JSON parse failed');
    const followUpQueries = Array.isArray(parsed.followUpQueries)
      ? parsed.followUpQueries.map((q) => String(q).trim()).filter(Boolean).slice(0, 2)
      : [];
    const entities = Array.isArray(parsed.entities)
      ? parsed.entities.filter((e) => e && e.nameEn).slice(0, 3)
      : [];
    console.log('[v3_research] aiExpandResearch → queries:', followUpQueries, 'entities:', entities.map(e => e.nameEn));
    return { followUpQueries, entities };
  } catch (e) {
    console.warn('[v3_research] aiExpandResearch failed:', e.message);
    return { followUpQueries: [], entities: [] };
  }
}

module.exports = {
  runTopicResearch,
  fetchWikiSideStories,
  aiExpandResearch,
  generateSearchPlan,
  pickQueries,
  scoreSearchItem,
};
