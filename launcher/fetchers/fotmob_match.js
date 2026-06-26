// scripts/modules/fetchers/fotmob_match.js
// FotMob から試合データを取得（curl-cffi + cheerio SSR）
//   SofaScore API が 403 で死んでる時の代替
//   検索 → match page SSR → スコア・スタッツ・フォーメーション・選手画像
//
// 返却形式: sofascore_match.js の fetchSofaScoreMatch と互換

const cheerio = require('cheerio');
const { curlGet, curlGetJson, curlGetImage } = require('./_curl_cffi_caller');

const FM_REFERER = 'https://www.fotmob.com/';
const FM_HEADERS = { Accept: 'text/html' };
const FM_JSON_HEADERS = { Accept: 'application/json' };

// FotMob の表記に合わせる正規化マップ
const TEAM_NAME_MAP = {
  'usa': 'United States',
  'us': 'United States',
  'america': 'United States',
  'united states of america': 'United States',
  'korea': 'South Korea',
  'republic of korea': 'South Korea',
  'dpr korea': 'North Korea',
  'turkiye': 'Turkey',
  'türkiye': 'Turkey',
  'ivory coast': 'Côte d\'Ivoire',
  "cote d'ivoire": 'Côte d\'Ivoire',
  'dr congo': 'Congo DR',
  'democratic republic of congo': 'Congo DR',
  'czech republic': 'Czechia',
  'iran': 'IR Iran',
  'cape verde': 'Cabo Verde',
  'trinidad': 'Trinidad and Tobago',
  'bosnia': 'Bosnia and Herzegovina',
  'bosnia herzegovina': 'Bosnia and Herzegovina',
  'bosnia & herzegovina': 'Bosnia and Herzegovina',
  'bih': 'Bosnia and Herzegovina',
  'north macedonia': 'North Macedonia',
  'fyr macedonia': 'North Macedonia',
  'scotland': 'Scotland',
  'wales': 'Wales',
  'republic of ireland': 'Republic of Ireland',
  'northern ireland': 'Northern Ireland',
};

function normalizeTeamName(name) {
  if (!name) return name;
  const key = name.toLowerCase().trim();
  return TEAM_NAME_MAP[key] || name;
}

// ── 試合検索: チーム名 → FotMob matchId ──
async function _searchMatch(homeTeam, awayTeam) {
  const q = `${homeTeam} ${awayTeam}`;
  try {
    const url = `https://www.fotmob.com/api/data/search/suggest?hits=20&lang=en&term=${encodeURIComponent(q)}`;
    const sections = await curlGetJson(url, { referer: FM_REFERER, headers: FM_JSON_HEADERS, timeout: 15 });
    const all = (Array.isArray(sections) ? sections : []);
    const matchSection = all.find(s => s.title?.key === 'matches_tab_title') || all.find(s => s.title?.key === 'all');
    if (!matchSection) return null;
    const matches = (matchSection.suggestions || []).filter(s => s.type === 'match');
    if (!matches.length) return null;
    // 最新の試合を返す（finished 優先）
    return { matchId: matches[0].id, leagueName: matches[0].leagueName };
  } catch (_) { return null; }
}

// ── SSR ページから __NEXT_DATA__ 取得 ──
async function _fetchMatchPage(matchId) {
  const url = `https://www.fotmob.com/match/${matchId}/matchfacts`;
  const res = await curlGet(url, { referer: FM_REFERER, headers: FM_HEADERS, timeout: 30 });
  if (!res.ok) return null;
  const $ = cheerio.load(res.body);
  const nd = $('#__NEXT_DATA__').html();
  if (!nd) return null;
  try { return JSON.parse(nd).props?.pageProps || null; }
  catch (_) { return null; }
}

// ── メイン: 試合データ取得 ──
async function fetchFotMobMatch(homeTeam, awayTeam) {
  if (!homeTeam || !awayTeam) return { ok: false, error: 'ホーム/アウェイチーム名が必要です' };

  const normHome = normalizeTeamName(homeTeam);
  const normAway = normalizeTeamName(awayTeam);
  if (normHome !== homeTeam || normAway !== awayTeam) {
    console.log(`  [fotmob] normalized: "${homeTeam}"→"${normHome}" / "${awayTeam}"→"${normAway}"`);
  }

  try {
    // ① 試合検索
    const found = await _searchMatch(normHome, normAway);
    if (!found) return { ok: false, error: `FotMob に "${homeTeam} vs ${awayTeam}" の試合が見つかりません` };

    // ② SSR ページ取得
    const pp = await _fetchMatchPage(found.matchId);
    if (!pp) return { ok: false, error: 'FotMob match page の取得に失敗' };

    // ③ ヘッダー（スコア・チーム・ロゴ）
    const teams = pp.header?.teams || [];
    const homeT = teams[0] || {};
    const awayT = teams[1] || {};
    const homeTeamName = homeT.name || homeTeam;
    const awayTeamName = awayT.name || awayTeam;
    const homeScore = homeT.score ?? null;
    const awayScore = awayT.score ?? null;
    const homeLogo = homeT.imageUrl || null;
    const awayLogo = awayT.imageUrl || null;
    const homeTeamId = homeT.id || null;
    const awayTeamId = awayT.id || null;

    // 試合日・大会
    const matchDate = pp.general?.matchTimeUTCDate
      ? pp.general.matchTimeUTCDate.slice(0, 10)
      : null;
    const tournament = pp.general?.leagueName || found.leagueName || null;
    const venue = pp.general?.venue?.name || null;

    // ④ ゴール・カード（header.events）
    const events = pp.header?.events || {};
    const goals = [];
    for (const side of ['homeTeamGoals', 'awayTeamGoals']) {
      const isHome = side === 'homeTeamGoals';
      const obj = events[side] || {};
      for (const scorerGoals of Object.values(obj)) {
        for (const g of (Array.isArray(scorerGoals) ? scorerGoals : [])) {
          goals.push({
            time: g.time,
            timeStr: g.overloadTime ? `${g.time}+${g.overloadTime}'` : `${g.time}'`,
            player: g.player?.name || '不明',
            isHome,
            team: isHome ? homeTeamName : awayTeamName,
            type: g.ownGoal ? 'OG' : g.isPenalty ? 'PK' : '通常',
          });
        }
      }
    }
    goals.sort((a, b) => a.time - b.time);

    const cards = [];
    // FotMob doesn't have card details in header.events, but they may be in match facts

    // ⑤ スタッツ（content.stats.Periods.All）
    const stats = {};
    const allStats = pp.content?.stats?.Periods?.All?.stats;
    if (Array.isArray(allStats)) {
      for (const group of allStats) {
        const items = group.stats || [];
        for (const item of items) {
          if (item.stats && item.stats.length >= 2 && item.title && item.type !== 'title') {
            stats[item.title] = { home: item.stats[0], away: item.stats[1] };
          }
        }
      }
    }

    // ⑥ ラインアップ・フォーメーション（content.lineup）
    const lu = pp.content?.lineup || {};
    const formations = {
      home: lu.homeTeam?.formation || null,
      away: lu.awayTeam?.formation || null,
    };

    const POS_MAP = { 0: 'goalkeeper', 1: 'goalkeeper', 2: 'defender', 3: 'midfielder', 4: 'forward' };
    function _buildLineup(teamData) {
      if (!teamData?.starters) return [];
      return teamData.starters.map(p => ({
        id: p.id || null,
        name: p.name || '',
        jersey: p.shirtNumber || null,
        pos: POS_MAP[Math.floor((p.positionId || 0) / 10)] || 'midfielder',
        photo: p.id ? `https://images.fotmob.com/image_resources/playerimages/${p.id}.png` : null,
        rating: p.performance?.rating ?? null,
      }));
    }

    const lineup = {
      home: _buildLineup(lu.homeTeam),
      away: _buildLineup(lu.awayTeam),
    };

    // ⑦ 選手別試合スタッツ（content.playerStats）
    const playerStats = {};
    const rawPS = pp.content?.playerStats || {};
    for (const [pid, p] of Object.entries(rawPS)) {
      if (!Array.isArray(p.stats) || !p.stats.length) continue;
      const flat = {};
      for (const group of p.stats) {
        if (!group.stats || typeof group.stats !== 'object') continue;
        for (const [title, item] of Object.entries(group.stats)) {
          const val = item?.stat?.value;
          if (val != null) flat[title] = val;
        }
      }
      if (Object.keys(flat).length) {
        playerStats[pid] = {
          name: p.name,
          teamId: p.teamId,
          teamName: p.teamName,
          isGoalkeeper: p.isGoalkeeper || false,
          stats: flat,
        };
      }
    }

    // トッププレイヤー（レーティング順）
    const allPlayers = [
      ...lineup.home.map(p => ({ ...p, teamSide: 'home' })),
      ...lineup.away.map(p => ({ ...p, teamSide: 'away' })),
    ];
    const topPlayers = allPlayers
      .filter(p => p.rating != null)
      .sort((a, b) => b.rating - a.rating)
      .slice(0, 5)
      .map(p => ({
        name: p.name,
        team: p.teamSide === 'home' ? homeTeamName : awayTeamName,
        rating: parseFloat(Number(p.rating).toFixed(1)),
      }));

    const scoreline = `${homeTeamName} ${homeScore ?? '?'} - ${awayScore ?? '?'} ${awayTeamName}`;
    console.log(`[FotMob Match] ${scoreline} | goals:${goals.length} stats:${Object.keys(stats).length} players:${Object.keys(playerStats).length} formation:${formations.home}/${formations.away}`);

    return {
      ok: true,
      matchId: found.matchId,
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
      homeTeamId,
      awayTeamId,
      homeLogo,
      awayLogo,
      homeScore,
      awayScore,
      matchDate,
      tournament,
      venue,
      attendance: null,
      scoreline,
      goals,
      cards,
      subs: [],
      stats,
      formations,
      lineup,
      topPlayers,
      playerStats,
      h2hMatches: [],
      h2hSummary: null,
      _source: 'fotmob',
    };
  } catch (e) {
    return { ok: false, error: `FotMob: ${e.message}` };
  }
}

module.exports = { fetchFotMobMatch };
