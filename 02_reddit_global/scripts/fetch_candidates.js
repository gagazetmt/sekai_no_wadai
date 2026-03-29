// fetch_candidates.js
// Reddit からサッカー関連スレッドを取得し、Claude でタイトル翻訳
// Usage: node scripts/fetch_candidates.js [YYYY-MM-DD]
// Output: JSON to stdout

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const { callAI } = require("./ai_client");

async function redditFetch(url) {
  return fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
}


const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const dateArg   = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const targetTs  = new Date(dateArg + "T12:00:00Z").getTime() / 1000;

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const LEAGUE_KEYWORDS = [
  "Premier League", "La Liga", "Bundesliga", "Ligue 1", "Serie A",
  "Champions League", "Europa League", "Conference League",
  "World Cup", "FA Cup", "Copa del Rey",
];

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function mapRedditPost(c) {
  return {
    title:       c.data.title,
    score:       c.data.score,
    url:         "https://www.reddit.com" + c.data.permalink,
    permalink:   c.data.permalink,
    created_utc: c.data.created_utc,
    numComments: c.data.num_comments,
    subreddit:   c.data.subreddit,
  };
}

function isPostMatchThread(title) {
  const lower = title.toLowerCase();
  const isPost    = lower.includes("post match thread") || lower.includes("post-match thread");
  const hasLeague = LEAGUE_KEYWORDS.some(k => title.includes(k));
  const isExcluded = lower.includes("konferenz") || lower.includes("simulcast") || lower.includes("2. bundesliga");
  return isPost && hasLeague && !isExcluded;
}

function detectRedditType(title) {
  const lower = title.toLowerCase();
  if (isPostMatchThread(title)) return "post-match";
  if (/transfer|signs for|joins|loan deal|contract extension|release clause|fee agreed|here we go/.test(lower)) return "transfer";
  if (/injur|ruled out|out for|muscle|hamstring|knee|ligament/.test(lower)) return "injury";
  if (/sacked|fired|resign|appointed|new manager|new head coach/.test(lower)) return "manager";
  if (/\bffp\b|financial fair play|ban|suspended|investigation|charged|misconduct|breach/.test(lower)) return "finance";
  return "topic";
}

// ─── Reddit 取得 ──────────────────────────────────────────────────────────────
async function redditSearch(subreddit, query, sort, time, limit) {
  const url = `https://www.reddit.com/r/${subreddit}/search.json?` +
    `q=${encodeURIComponent(query)}&sort=${sort}&restrict_sr=true&limit=${limit}&t=${time}`;
  try {
    const res = await redditFetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data?.children || []).map(mapRedditPost);
  } catch { return []; }
}

async function redditListing(url) {
  try {
    const res = await redditFetch(url);
    if (!res.ok) return [];
    const json = await res.json();
    return (json.data?.children || []).map(mapRedditPost);
  } catch { return []; }
}

// ─── タイトル一括日本語訳 ─────────────────────────────────────────────────────
async function translateTitles(items) {
  if (!items.length) return items;
  const titles = items.map(p => p.title);
  const prompt = `以下のサッカー関連Redditスレッドタイトルを日本語に翻訳してください。
チーム名・選手名・大会名はカタカナ表記（例：アーセナル、マンシティ、プレミアリーグ）。
スコア表記（例：3-1）はそのまま残す。
JSON配列のみ返してください。順番はそのまま。

${titles.map((t, i) => `${i}: ${t}`).join("\n")}

出力形式: ["日本語タイトル0", "日本語タイトル1", ...]`;

  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 1500, messages: [{ role: "user", content: prompt }] });
    const json = raw.match(/\[[\s\S]*\]/);
    if (!json) return items;
    const translated = JSON.parse(json[0]);
    return items.map((p, i) => ({ ...p, titleJa: translated[i] || p.title }));
  } catch {
    return items.map(p => ({ ...p, titleJa: p.title }));
  }
}

// ─── RSS取得 ──────────────────────────────────────────────────────────────────
function extractXmlField(body, tag) {
  const m = body.match(new RegExp(`<${tag}[\\s>][^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, "i"))
         || body.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))<\\/${tag}>`, "i"));
  return m ? (m[1] ?? m[2] ?? "").trim() : null;
}

async function fetchRss(feedUrl, maxAgeDays = 4) {
  try {
    const res = await fetch(feedUrl, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
    if (!res.ok) return [];
    const xml = await res.text();
    const now = Date.now() / 1000;
    const cutoff = maxAgeDays * 86400;
    const items = [];
    for (const [, body] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const title   = extractXmlField(body, "title");
      const rawLink = extractXmlField(body, "link");
      const link    = rawLink || (body.match(/<link[^>]+href="([^"]+)"/) || [])[1];
      const pubDate = extractXmlField(body, "pubDate") || extractXmlField(body, "dc:date");
      const desc    = (extractXmlField(body, "description") || "").replace(/<[^>]+>/g, "").trim().slice(0, 200);
      if (!title || !link) continue;
      const created_utc = pubDate ? Math.floor(new Date(pubDate).getTime() / 1000) : now;
      if (now - created_utc > cutoff) continue;
      items.push({ title, titleJa: title, url: link, permalink: null, created_utc, score: 0, type: "topic", source: "rss", description: desc });
    }
    return items;
  } catch { return []; }
}

async function fetchAllRss() {
  const items = await fetchRss("https://www.calciomatome.net/index20.rdf");
  return items.sort((a, b) => b.created_utc - a.created_utc).slice(0, 15);
}

// ─── 共通ネタ検出 ─────────────────────────────────────────────────────────────
function extractKeywords(titleJa) {
  const kws = new Set();
  // スコア（例: 3-1, 2-0）
  (titleJa.match(/\d+[-－]\d+/g) || []).forEach(s => kws.add(s));
  // カタカナ3文字以上（チーム名・選手名）
  (titleJa.match(/[ァ-ヶー]{3,}/g) || []).forEach(k => kws.add(k));
  return kws;
}

function findCommonTopics(redditItems, rssItems) {
  const usedReddit = new Set();
  const usedRss    = new Set();
  const common     = [];

  for (let ri = 0; ri < redditItems.length; ri++) {
    const r    = redditItems[ri];
    const rKws = extractKeywords(r.titleJa || r.title);
    for (let si = 0; si < rssItems.length; si++) {
      if (usedRss.has(si)) continue;
      const s    = rssItems[si];
      const sKws = extractKeywords(s.titleJa || s.title);
      const overlap = [...rKws].filter(k => sKws.has(k));
      if (overlap.length >= 2) {
        common.push({ ...r, source: "common", rssMatch: { title: s.titleJa || s.title, url: s.url } });
        usedReddit.add(ri);
        usedRss.add(si);
        break;
      }
    }
  }

  return {
    commonTopics:  common,
    redditFiltered: redditItems.filter((_, i) => !usedReddit.has(i)),
    rssFiltered:    rssItems.filter((_, i) => !usedRss.has(i)),
  };
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const [
    soccerHot, soccerNew,
    matchNew, transferNew, romanoNew,
    rssTopics,
  ] = await Promise.all([
    redditListing("https://www.reddit.com/r/soccer/hot.json?limit=60"),
    redditListing("https://www.reddit.com/r/soccer/new.json?limit=50"),
    redditSearch("soccer", "post match thread OR match thread",                 "new", "week", 50),
    redditSearch("soccer", "transfer OR injury OR sacked OR appointed OR signs", "hot", "week", 30),
    redditSearch("soccer", "Romano",                                             "new", "week", 20),
    fetchAllRss(),
  ]);

  // ── Reddit統合: 全ソースをまとめてスコア順20件 ──
  const seen = new Set();
  const allReddit = [...soccerHot, ...soccerNew, ...matchNew, ...transferNew, ...romanoNew]
    .filter(p => {
      if (Math.abs(p.created_utc - targetTs) > 3 * 86400) return false;
      if (seen.has(p.title)) return false;
      seen.add(p.title);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(p => ({
      ...p,
      type:   isPostMatchThread(p.title) ? "post-match" : detectRedditType(p.title),
      source: "reddit",
    }));

  // サーバー互換: post-match と topic に分割して出力
  const postMatchThreads = allReddit.filter(p => p.type === "post-match");
  const redditTopics     = allReddit.filter(p => p.type !== "post-match");

  // ── 翻訳 ──
  const [pmTranslated, rtTranslated] = await Promise.all([
    translateTitles(postMatchThreads),
    translateTitles(redditTopics),
  ]);

  // ── 共通ネタ検出（翻訳後に実施） ──
  const allRedditTranslated = [...pmTranslated, ...rtTranslated];
  const { commonTopics, redditFiltered, rssFiltered } = findCommonTopics(allRedditTranslated, rssTopics);

  // 共通から除外した残りをpost-match/topicに再分割
  const pmFinal  = redditFiltered.filter(p => p.type === "post-match");
  const rdtFinal = redditFiltered.filter(p => p.type !== "post-match");

  process.stdout.write(JSON.stringify({
    date:             dateArg,
    commonTopics,
    postMatchThreads: pmFinal,
    redditTopics:     rdtFinal,
    rssTopics:        rssFiltered,
  }));
}

main().catch(e => { process.stderr.write(e.message + "\n"); process.exit(1); });
