// launcher/research.js
// 選んだトピックの詳細情報を収集
// FotMob（メイン） + SofaScore（フォールバック） + Brave Search

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchFotMobMatch }   = require('./fetchers/fotmob_match');
const { fetchFotMobPlayer }  = require('./fetchers/fotmob_player');
const { collectComments, fromX } = require('./fetchers/comments');
const { enrichLabels, isDbLoaded, getSquadForTeam } = require('./player_db');

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

// ── Publisher 重複排除ヘルパー ────────────────────────────
// NBC系列局など同一親メディアの記事が複数来るのを防ぐ

function _getPublisher(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (/^nbc/.test(host))  return 'nbc';
    if (/^abc/.test(host))  return 'abc';
    if (/^cbs/.test(host))  return 'cbs';
    if (/^fox/.test(host))  return 'fox';
    if (/^sky/.test(host))  return 'sky';
    return host.split('.').slice(-2).join('.');
  } catch (_) { return url; }
}

// ── Brave Search でスニペット収集（Yahoo/Reddit枠保証） ──
// 3並列: 汎用web(publisher重複排除7枠) + Yahoo日本語(2枠) + Reddit(1枠)

async function braveDeepSearch(query, topicJa = '') {
  const { braveSearch } = require('./scout');

  const [webRaw, yahooRaw, redditRaw] = await Promise.all([
    braveSearch(query, 20),
    topicJa ? braveSearch(`site:news.yahoo.co.jp ${topicJa}`, 3) : Promise.resolve([]),
    braveSearch(`site:reddit.com/r/soccer "Match Thread" OR "Post Match" ${query}`, 3),
  ]);

  // Web: yahoo/reddit/x を除外してpublisher単位で重複排除
  const seenPub = new Set();
  const webSlots = [];
  for (const r of webRaw) {
    if (/yahoo\.co\.jp|reddit\.com|twitter\.com|x\.com/.test(r.url)) continue;
    const pub = _getPublisher(r.url);
    if (seenPub.has(pub)) continue;
    seenPub.add(pub);
    webSlots.push({ url: r.url, title: r.title, text: r.snippet || '', thumbnail: r.thumbnail || null, sourceType: 'web' });
    if (webSlots.length >= 7) break;
  }

  const yahooSlots  = yahooRaw.slice(0, 2).map(r => ({ url: r.url, title: r.title, text: r.snippet || '', thumbnail: r.thumbnail || null, sourceType: 'yahoo' }));
  const redditSlots = redditRaw.slice(0, 1).map(r => ({ url: r.url, title: r.title, text: r.snippet || '', thumbnail: r.thumbnail || null, sourceType: 'reddit' }));

  console.log(`  [articles] web:${webSlots.length} yahoo:${yahooSlots.length} reddit:${redditSlots.length}`);
  return [...yahooSlots, ...redditSlots, ...webSlots].slice(0, 10);
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

// ── チームデータ取得（SofaScore） ─────────────────────────

async function fetchTeam(teamName) {
  console.log(`  [team] FotMob: ${teamName}`);
  try {
    const { fetchFotMobTeam } = require('./fetchers/fotmob_team');
    const td = await fetchFotMobTeam(teamName);
    if (!td.ok) {
      console.warn(`  [team] FotMob failed: ${td.error}`);
      return { ok: false, name: teamName, error: td.error };
    }
    console.log(`  [team] OK: ${td.name} / 監督: ${td.manager || '—'}`);
    return {
      ok: true,
      name: td.name,
      manager: td.manager || null,
      leagueName: td.leagueName || null,
      standing: td.standing || null,
      recentForm: td.recentForm || null,
      last5: td.last5 || [],
    };
  } catch (err) {
    console.warn(`  [team] error: ${err.message}`);
    return { ok: false, name: teamName, error: err.message };
  }
}

// ── DeepSeek: 記事からラベル抽出（ラベル方式） ──────────

async function deepseekExtractInfo(topic, articles) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;

  const snippets = articles.length > 0
    ? articles.map((a, i) => `[${i + 1}] ${a.title}\n${(a.text || a.snippet || '').slice(0, 600)}`).join('\n\n')
    : '（記事なし）';

  // player_db からスクワッド文脈を生成（チーム名をトピック・記事タイトルから推定）
  let squadContext = '';
  if (isDbLoaded()) {
    const allText = topic + ' ' + articles.map(a => a.title || '').join(' ');
    // 代表チーム名リスト（よく登場するもの優先）
    const NT_LIST = [
      'Japan','Brazil','Argentina','France','England','Spain','Germany','Portugal',
      'Netherlands','Italy','Belgium','Croatia','USA','Mexico','Canada','Morocco',
      'Senegal','Nigeria','South Korea','Australia','Uruguay','Colombia','Ecuador',
      'Chile','Saudi Arabia','Iran','Qatar','Switzerland','Denmark','Serbia',
      'Poland','Turkey','Austria','Sweden','Norway','Wales','Scotland',
      'Ghana','Cameroon','Ivory Coast','Egypt','Algeria','Tunisia','DR Congo',
      'Peru','Paraguay','Bolivia','Venezuela','Honduras','Costa Rica','Panama',
      'Iraq','Uzbekistan','Jordan','Georgia','Slovakia',
    ];
    const found = NT_LIST.filter(n => new RegExp(n, 'i').test(allText)).slice(0, 3);
    if (found.length) {
      const lines = found.map(team => {
        const { players, manager } = getSquadForTeam(team, 15);
        const parts = [];
        if (manager) parts.push(`監督:${manager}`);
        if (players.length) parts.push(players.join(', '));
        return `${team}: ${parts.join(' / ')}`;
      });
      squadContext = '\n\n【player_db スクワッド参照（ラベル選定の参考に）】\n' + lines.join('\n') + '\n※ 所属クラブはDBで後処理補正するため team フィールドは知識から記入してよい';
    }
  }

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
    { "type": "match",   "homeTeam": "Japan", "awayTeam": "Brazil", "matchDate": "2026-06-30", "competition": "FIFA World Cup 2026" },
    { "type": "team",    "name": "Japan" },
    { "type": "team",    "name": "Brazil" },
    { "type": "player",  "name": "Kaoru Mitoma",    "team": "Brighton",    "nationalTeam": "Japan" },
    { "type": "player",  "name": "Vinicius Junior",  "team": "Real Madrid", "nationalTeam": "Brazil" },
    { "type": "manager", "name": "Hajime Moriyasu",  "nationalTeam": "Japan" },
    { "type": "manager", "name": "Carlo Ancelotti",  "nationalTeam": "Brazil" }
  ]
}

【labelsルール】
- 5〜10個を目安に抽出する
- topicTypeが"match"なら必ず type:"match" ラベルを含める
- type:"team" は英語チーム名（"Japan", "Brazil" 等）
- type:"player" は記事に登場する選手。名前(英語)・所属クラブ(team,英語)・代表(nationalTeam,英語 or null)
  - 記事に名前が出ていなくても、試合・移籍のトピックなら主力選手を知識から補完してよい
- type:"manager" は監督。名前(英語)・代表チームまたはクラブ(nationalTeam,英語)
  - 記事に監督名が出ていなくても、チームが特定できれば現監督を知識から補完してよい
- type:"match" は homeTeam/awayTeam 両方必須

【重要】
- 名前は必ず英語（「中村敬斗」→"Keito Nakamura"、「上田綺世」→"Ayase Ueda"、「森保一」→"Hajime Moriyasu"）
- チーム名も英語（「日本」→"Japan"）
- matchDate は記事に明記された日付のみ。推測しない
- JSONのみ返す。説明文不要` + squadContext;

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

  // Step1: 記事収集 + X tweets を並列取得
  const searchQuery = options.searchQuery || topic
    .replace(/（[^）]*）/g, '')
    .replace(/\s*[-－]\s*Yahoo.*$/i, '')
    .replace(/[！!。、【】「」『』★☆♪]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  console.log(`  [articles] query: "${searchQuery}"`);

  let xTweets = [];
  try {
    // BraveDeepSearch と X tweets を並列実行
    const [braveArticles, xResults] = await Promise.all([
      braveDeepSearch(searchQuery, topic),
      fromX(topic, searchQuery).catch(() => []),
    ]);
    xTweets = xResults;

    // X top tweet をスニペット枠に追加（最大1件）
    const xSnippet = xTweets.slice(0, 1).map(t => ({
      url: `https://x.com/search?q=${encodeURIComponent(topic)}`,
      title: 'X: ' + t.text.slice(0, 60),
      text: t.text,
      thumbnail: null,
      sourceType: 'x',
    }));

    facts.articles = [...braveArticles, ...xSnippet].slice(0, 10);
    console.log(`  [articles] ${facts.articles.length} snippets (web/yahoo/reddit + x:${xSnippet.length})`);
  } catch (err) {
    console.warn(`  [articles] failed: ${err.message}`);
  }

  // Step2: DeepSeek でラベル抽出（記事ゼロでもトピック名だけで実行）
  console.log('  [extract] Analyzing with DeepSeek...');
  const extracted = await deepseekExtractInfo(topic, facts.articles);
  if (extracted) {
    // player_db.json でクラブ・代表情報を補正（DeepSeekのカットオフ誤情報対策）
    if (isDbLoaded() && Array.isArray(extracted.labels)) {
      extracted.labels = enrichLabels(extracted.labels);
      console.log('  [extract] player_db 補正済み');
    }
    facts.extracted = extracted;
    console.log(`  [extract] type:${extracted.topicType} home:${extracted.homeTeam} away:${extracted.awayTeam} date:${extracted.matchDate} player:${extracted.playerName}`);
  } else {
    console.warn('  [extract] DeepSeek failed');
  }

  // Step3: 試合データ先行フェッチ（フェーズ判定に使う）
  const ext = facts.extracted;
  if (ext?.topicType === 'match' && ext.homeTeam && ext.awayTeam && !facts.matchData) {
    try {
      const md = await fetchMatch(ext.homeTeam, ext.awayTeam);
      if (md?.ok) {
        facts.matchData = md;
        console.log('  [research] matchData 先行フェッチ完了');
      }
    } catch (_) {}
  }

  // Step4: コメント収集（Yahoo/Reddit URLを渡して再検索を省略、X tweetsも再利用）
  try {
    const yahooUrls   = facts.articles.filter(a => a.sourceType === 'yahoo').map(a => a.url);
    const redditUrls  = facts.articles.filter(a => a.sourceType === 'reddit').map(a => a.url);
    const commentResult = await collectComments(topic, {
      enQuery: searchQuery,
      yahooUrls,
      redditUrls,
      xTweets,
      matchData: facts.matchData,
    });
    facts.comments = commentResult;
    console.log(`  [comments] ${commentResult.all.length} total (phase: ${commentResult.phase})`);
  } catch (err) {
    console.warn(`  [comments] failed: ${err.message}`);
  }

  console.log(`\n  Facts collected: ${JSON.stringify(facts).length} bytes\n`);
  return facts;
}

module.exports = { research, fetchMatch, fetchPlayer, fetchTeam, scrapeUrl, braveDeepSearch };
