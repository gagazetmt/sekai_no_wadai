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

// ── DeepSeek: 記事からラベル抽出（ラベル方式） ──────────

async function deepseekExtractInfo(topic, articles) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;

  const snippets = articles.map((a, i) =>
    `[${i + 1}] ${a.title}\n${(a.text || a.snippet || '').slice(0, 600)}`
  ).join('\n\n');

  const sys = `あなたはサッカーニュース分析AIです。
記事を読んで、動画制作に必要な情報をJSONで返してください。

【出力フォーマット】
{
  "topicType": "match" | "player" | "transfer" | "controversy" | "other",
  "homeTeam": "英語チーム名 or null",
  "awayTeam": "英語チーム名 or null",
  "matchDate": "YYYY-MM-DD or null",
  "playerName": "英語フルネーム or null",
  "competition": "大会名 or null",
  "labels": [
    { "type": "match", "homeTeam": "Japan", "awayTeam": "Sweden", "matchDate": "2026-06-XX", "competition": "FIFA World Cup 2026" },
    { "type": "team",   "name": "Japan" },
    { "type": "team",   "name": "Sweden" },
    { "type": "player", "name": "Kaoru Mitoma", "team": "Brighton", "nationalTeam": "Japan" }
  ]
}

【labelsルール】
- 3〜5個。記事の核心にある「チーム」「選手」「試合」を抽出する
- topicTypeが"match"なら必ず type:"match" のラベルを含める
- type:"team" のname は英語チーム名（FotMob/X検索に使う）
- type:"player" は選手名(英語)・所属クラブ(team,英語)・代表チーム(nationalTeam,英語 or null)
- type:"match" は homeTeam/awayTeam 両方必須（片方不明でも null で含める）

【重要】
- チーム名は必ず英語変換（「日本」→"Japan"、「スウェーデン」→"Sweden"）
- matchDate は記事に明記された日付のみ。推測しない
- JSONのみ返す。説明文不要`;

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.1, max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: `トピック: ${topic}\n\n記事:\n${snippets}` },
        ],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.warn(`  [extract] DeepSeek ${res.status}`); return null; }
    const d = await res.json();
    return JSON.parse(d.choices[0].message.content);
  } catch (e) {
    console.warn(`  [extract] failed: ${e.message}`);
    return null;
  }
}

// ── メインAPI ─────────────────────────────────────────

async function research(topic, options = {}) {
  console.log('\n=== Research: Gathering facts ===\n');
  console.log(`  Topic: ${topic}\n`);

  const facts = { topic, articles: [], matchData: null, playerData: null, comments: null, extracted: null, xImages: [] };

  // Step1: 記事収集
  try {
    const articles = await braveDeepSearch(topic, 3);
    facts.articles = articles;
    console.log(`  [articles] ${articles.length} articles scraped`);
  } catch (err) {
    console.warn(`  [articles] failed: ${err.message}`);
  }

  // Step2: DeepSeek で記事を解析 → チーム名/日付/選手名を抽出
  if (facts.articles.length > 0) {
    console.log('  [extract] Analyzing articles with DeepSeek...');
    const extracted = await deepseekExtractInfo(topic, facts.articles);
    if (extracted) {
      facts.extracted = extracted;
      console.log(`  [extract] type:${extracted.topicType} home:${extracted.homeTeam} away:${extracted.awayTeam} date:${extracted.matchDate} player:${extracted.playerName}`);
    } else {
      console.warn('  [extract] DeepSeek skipped or failed');
    }
  }

  // Step3: 試合データ（options優先 → 抽出値フォールバック）
  const homeTeam = options.homeTeam || facts.extracted?.homeTeam || null;
  const awayTeam = options.awayTeam || facts.extracted?.awayTeam || null;
  if (homeTeam && awayTeam) {
    const matchResult = await fetchMatch(homeTeam, awayTeam);
    if (matchResult.ok) {
      facts.matchData = matchResult;
    }
  }

  // Step4: 選手データ（options優先 → match系でなければ抽出値）
  const playerName = options.playerName ||
    (facts.extracted?.topicType === 'player' ? facts.extracted?.playerName : null) || null;
  if (playerName) {
    const playerResult = await fetchPlayer(playerName);
    if (playerResult.ok) {
      facts.playerData = playerResult;
    }
  }

  // Step5: X公式画像取得（ラベルベース）
  const labels = facts.extracted?.labels || [];
  if (labels.length > 0) {
    console.log(`  [x_images] Fetching from ${labels.length} labels...`);
    try {
      const { fetchImagesForLabels } = require('./fetchers/x_images');
      const xImages = await fetchImagesForLabels(labels);
      facts.xImages = xImages;
    } catch (err) {
      console.warn(`  [x_images] failed: ${err.message}`);
    }
  } else {
    console.log('  [x_images] no labels, skipping');
  }

  // Step6: コメント収集
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
