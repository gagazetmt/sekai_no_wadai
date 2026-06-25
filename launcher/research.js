// launcher/research.js
// 選んだトピックの詳細情報を収集
// FotMob（メイン） + SofaScore（フォールバック） + Brave Search

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchFotMobMatch }   = require('./fetchers/fotmob_match');
const { fetchFotMobPlayer }  = require('./fetchers/fotmob_player');
const { collectComments }    = require('./fetchers/comments');

// ── Webスクレイプ（curl-cffi経由） ────────────────────

async function scrapeUrl(url) {
  try {
    const { curlGet } = require('./fetchers/_curl_cffi_caller');
    const res = await curlGet(url, { timeout: 15 });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = res.body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
    return text;
  } catch (err) {
    // curl-cffi失敗時はdirect fetch
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!res.ok) throw new Error(`Scrape ${res.status}: ${url}`);
    const html = await res.text();
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  }
}

// ── Brave Search で記事収集 ───────────────────────────

async function braveDeepSearch(query, count = 5) {
  const { braveSearch } = require('./scout');
  const results = await braveSearch(query, count);
  const texts = [];
  const seenDomains = new Set();

  for (const r of results) {
    if (texts.length >= 3) break;
    // 同一ドメインの記事を除外
    try {
      const domain = new URL(r.url).hostname.replace(/^www\./, '');
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);
    } catch (_) {}

    try {
      const text = await scrapeUrl(r.url);
      texts.push({ url: r.url, title: r.title, text });
    } catch (err) {
      texts.push({ url: r.url, title: r.title, text: r.snippet || '' });
    }
  }

  return texts;
}

// ── 試合データ取得（FotMob → SofaScore） ─────────────

async function fetchMatch(homeTeam, awayTeam) {
  // FotMob（メイン）
  console.log(`  [match] FotMob: ${homeTeam} vs ${awayTeam}`);
  const fm = await fetchFotMobMatch(homeTeam, awayTeam);
  if (fm.ok) {
    console.log(`  [match] FotMob OK: ${fm.scoreline}`);
    return fm;
  }
  console.warn(`  [match] FotMob failed: ${fm.error}`);

  // SofaScore（フォールバック）
  try {
    const { fetchSofaScoreMatch } = require('./fetchers/sofascore_match');
    console.log(`  [match] SofaScore fallback...`);
    const sf = await fetchSofaScoreMatch(homeTeam, awayTeam);
    if (sf.ok) {
      console.log(`  [match] SofaScore OK: ${sf.scoreline}`);
      return sf;
    }
    console.warn(`  [match] SofaScore failed: ${sf.error}`);
  } catch (err) {
    console.warn(`  [match] SofaScore unavailable: ${err.message}`);
  }

  return { ok: false, error: 'All match data sources failed' };
}

// ── 選手データ取得（FotMob → SofaScore） ─────────────

async function fetchPlayer(playerName) {
  // FotMob（メイン）
  console.log(`  [player] FotMob: ${playerName}`);
  const fm = await fetchFotMobPlayer(playerName);
  if (fm.ok) {
    console.log(`  [player] FotMob OK: ${fm.name} (${fm.team})`);
    return fm;
  }
  console.warn(`  [player] FotMob failed: ${fm.error}`);

  // SofaScore（フォールバック）
  try {
    const { fetchSofaScorePlayer } = require('./fetchers/sofascore_player');
    console.log(`  [player] SofaScore fallback...`);
    const sf = await fetchSofaScorePlayer(playerName);
    if (sf.ok) {
      console.log(`  [player] SofaScore OK: ${sf.name}`);
      return sf;
    }
    console.warn(`  [player] SofaScore failed: ${sf.error}`);
  } catch (err) {
    console.warn(`  [player] SofaScore unavailable: ${err.message}`);
  }

  return { ok: false, error: `Player "${playerName}" not found` };
}

// ── メインAPI ─────────────────────────────────────────

async function research(topic, options = {}) {
  console.log('\n=== Research: Gathering facts ===\n');
  console.log(`  Topic: ${topic}\n`);

  const facts = { topic, articles: [], matchData: null, playerData: null, comments: null };

  // Brave Searchで関連記事を収集
  try {
    const articles = await braveDeepSearch(topic, 3);
    facts.articles = articles;
    console.log(`  [articles] ${articles.length} articles scraped`);
  } catch (err) {
    console.warn(`  [articles] failed: ${err.message}`);
  }

  // 試合データ（チーム名が指定された場合）
  if (options.homeTeam && options.awayTeam) {
    const matchResult = await fetchMatch(options.homeTeam, options.awayTeam);
    if (matchResult.ok) {
      facts.matchData = matchResult;
    }
  }

  // 選手データ（選手名が指定された場合）
  if (options.playerName) {
    const playerResult = await fetchPlayer(options.playerName);
    if (playerResult.ok) {
      facts.playerData = playerResult;
    }
  }

  // コメント収集（3ソース並列）
  try {
    const commentResult = await collectComments(topic, { enQuery: options.searchQuery || '' });
    facts.comments = commentResult;
    console.log(`  [comments] ${commentResult.all.length} total`);
  } catch (err) {
    console.warn(`  [comments] failed: ${err.message}`);
  }

  console.log(`\n  Facts collected: ${JSON.stringify(facts).length} bytes\n`);
  return facts;
}

module.exports = { research, fetchMatch, fetchPlayer, scrapeUrl, braveDeepSearch };
