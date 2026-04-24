// scripts/modules/fetchers/sofascore_player.js
// SofaScore 非公式API で選手スタッツを取得（最適化版: 4 API call）
//  ① /search/all/         → playerId
//  ② /player/{id}         → 基本情報・市場価値・契約
//  ③ /player/{id}/events/last/0 → 直近5試合 + 今試合スタッツ
//  ④ /player/{id}/statistics    → 今期スタッツ

const { apiGet } = require('./_sofa_common');
const { callAI } = require('../../ai_client');

// 日本語文字が含まれるか
function hasJapanese(str) {
  return /[　-鿿＀-￯]/.test(str);
}

// 日本語名 → 英語名を Claude haiku で翻訳
async function translateToEnglish(jaName) {
  try {
    const raw = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 50,
      messages:   [{ role: 'user', content: `Soccer player name in Japanese: "${jaName}". Return only the official English name (e.g. "Kaoru Mitoma"). No explanation.` }],
    });
    return raw.trim().replace(/^["']|["']$/g, '');
  } catch { return null; }
}

async function buildSearchCandidates(name) {
  const candidates = [name];
  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) candidates.push(parts[parts.length - 1]);
  if (hasJapanese(name)) {
    const en = await translateToEnglish(name);
    if (en && !candidates.includes(en)) candidates.unshift(en);
  }
  return [...new Set(candidates)];
}

// 検索のみ: playerエンティティ（ID・name等）を返す
async function searchPlayer(name) {
  const candidates = await buildSearchCandidates(name);
  for (const q of candidates) {
    try {
      const data = await apiGet(`/search/all/?q=${encodeURIComponent(q)}`);
      const players = (data.results || []).filter(r =>
        r.type === 'player' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
      );
      if (players.length) {
        console.log(`[SofaScore Player] "${q}" → ${players[0].entity.name}`);
        return players[0].entity;
      }
    } catch (_) {}
  }
  return null;
}

// ポジション別スタッツ抽出
function buildPositionStats(position, st) {
  if (!st) return null;
  const pos = (position || '').toUpperCase();
  if (pos === 'G') return {
    saves:          st.saves ?? null,
    cleanSheets:    st.cleanSheet ?? null,
    goalsConceded:  st.goalsConceded ?? null,
    savedFromBox:   st.savedShotsFromInsideTheBox ?? null,
    goalsPrevented: st.goalsPrevented ?? null,
  };
  if (pos === 'D') return {
    tackles:        st.tackles ?? null,
    interceptions:  st.interceptions ?? null,
    clearances:     st.clearances ?? null,
    duelsWon:       st.duelsWon ?? null,
    aerialDuelsWon: st.aerialDuelsWon ?? null,
    blockedShots:   st.blockedShots ?? null,
  };
  if (pos === 'M') return {
    keyPasses:          st.keyPasses ?? null,
    successfulDribbles: st.successfulDribbles ?? null,
    bigChancesCreated:  st.bigChancesCreated ?? null,
    tackles:            st.tackles ?? null,
    interceptions:      st.interceptions ?? null,
    accuratePassesPct:  st.accuratePassesPercentage ?? null,
  };
  return {
    shotsOnTarget:      st.shotsOnTarget ?? null,
    bigChancesMissed:   st.bigChancesMissed ?? null,
    bigChancesCreated:  st.bigChancesCreated ?? null,
    successfulDribbles: st.successfulDribbles ?? null,
    expectedGoals:      st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
  };
}

// 1試合の選手スタッツを扱いやすい形に整形
function formatMatchStats(e, playerId) {
  const isHome   = e.homeTeam?.id && e.awayTeam?.id
    ? (e.playerStatistics?.team === 'home' || (e.homeTeam?.players || []).some(p => p.player?.id === playerId))
    : null;
  const homeScore = e.homeScore?.display ?? e.homeScore?.normaltime ?? null;
  const awayScore = e.awayScore?.display ?? e.awayScore?.normaltime ?? null;
  const myScore   = isHome === true ? homeScore : (isHome === false ? awayScore : null);
  const oppScore  = isHome === true ? awayScore : (isHome === false ? homeScore : null);
  const opp       = isHome === true ? e.awayTeam?.name : (isHome === false ? e.homeTeam?.name : (e.awayTeam?.name || e.homeTeam?.name));
  const st = e.playerStatistics || {};

  return {
    date:          e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null,
    tournament:    e.tournament?.name || null,
    opponent:      opp || null,
    score:         (myScore != null && oppScore != null) ? `${myScore}-${oppScore}` : `${homeScore ?? '?'}-${awayScore ?? '?'}`,
    rating:        st.rating != null ? parseFloat(Number(st.rating).toFixed(2)) : null,
    goals:         st.goals ?? null,
    assists:       st.goalAssist ?? null,
    minutesPlayed: st.minutesPlayed ?? null,
    shots:         st.totalShots ?? null,
    shotsOnTarget: st.onTargetScoringAttempt ?? null,
    keyPasses:     st.keyPass ?? null,
    passes:        st.totalPass ?? null,
    accuratePassesPct: st.totalPass ? Math.round((st.accuratePass ?? 0) / st.totalPass * 100) : null,
    dribbles:      st.totalContest ?? null,
    dribblesWon:   st.wonContest ?? null,
    touches:       st.touches ?? null,
    expectedGoals: st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
  };
}

async function fetchSofaScorePlayer(playerNameEn) {
  if (!playerNameEn) return { ok: false, error: '選手名が未指定' };

  try {
    // ① 検索
    const player = await searchPlayer(playerNameEn);
    if (!player) return { ok: false, error: `SofaScore に "${playerNameEn}" が見つかりません` };
    const playerId = player.id;

    // ②③④ 並列取得（detail / events / statistics）────────────
    const [pdRaw, evRaw, statsRaw] = await Promise.all([
      apiGet(`/player/${playerId}`).catch(e => ({ __err: e })),
      apiGet(`/player/${playerId}/events/last/0`).catch(e => ({ __err: e })),
      apiGet(`/player/${playerId}/statistics`).catch(e => ({ __err: e })),
    ]);

    // ② 詳細情報（市場価値・契約）
    const playerDetail = pdRaw?.__err ? {} : (pdRaw.player || {});
    const marketValue = playerDetail.proposedMarketValue || null;
    const contractUntil = playerDetail.contractUntilTimestamp
      ? new Date(playerDetail.contractUntilTimestamp * 1000).toISOString().slice(0, 7)
      : null;
    const marketValueStr = marketValue
      ? (marketValue >= 1_000_000
          ? `€${(marketValue / 1_000_000).toFixed(0)}M`
          : `€${(marketValue / 1_000).toFixed(0)}K`)
      : null;

    // ③ 直近試合
    let last5Matches = [];
    let lastMatchStats = null;
    let recentAvgRating = null;
    if (!evRaw?.__err) {
      const events = (evRaw.events || []).filter(e => e.playerStatistics != null).reverse();
      const recent = events.slice(-20).reverse();
      last5Matches = recent.slice(0, 5).map(e => formatMatchStats(e, playerId));
      lastMatchStats = last5Matches[0] || null;
      const ratings = recent.slice(0, 10)
        .map(e => e.playerStatistics?.rating)
        .filter(r => r != null && r > 0);
      recentAvgRating = ratings.length
        ? parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
        : null;
    }

    // ④ シーズン統計（全シーズン → 最新年の国内リーグ優先）
    let seasonStats = null;
    let leagueName  = null;
    let seasonYear  = null;
    let uclStats    = null;
    if (!statsRaw?.__err) {
      const statsData   = statsRaw;
      const allSeasons  = statsData.seasons || [];
      const latestYear  = allSeasons[0]?.year;
      const currentList = latestYear
        ? allSeasons.filter(s => s.year === latestYear)
        : allSeasons;
      const DOMESTIC = [17, 8, 23, 35, 34, 37, 44]; // PL, LaLiga, SerieA, Bundesliga, Ligue1, Eredivisie, Süper Lig
      const UCL      = [7];
      let preferred = null;
      for (const tid of [...DOMESTIC, ...UCL]) {
        preferred = currentList.find(s => s.uniqueTournament?.id === tid);
        if (preferred) break;
      }
      preferred = preferred || currentList[0] || allSeasons[0];
      const uclEntry = currentList.find(s => UCL.includes(s.uniqueTournament?.id));
      uclStats = (uclEntry && uclEntry.uniqueTournament?.id !== preferred?.uniqueTournament?.id)
        ? {
            leagueName:  uclEntry.uniqueTournament?.name,
            appearances: uclEntry.statistics?.appearances,
            goals:       uclEntry.statistics?.goals,
            assists:     uclEntry.statistics?.assists,
            rating:      uclEntry.statistics?.rating ? parseFloat(Number(uclEntry.statistics.rating).toFixed(2)) : null,
          }
        : null;
      if (preferred) {
        leagueName  = preferred.uniqueTournament?.name;
        seasonYear  = preferred.year;
        seasonStats = preferred.statistics || null;
      }
    }

    const position      = playerDetail.position || player.position || '';
    const positionStats = buildPositionStats(position, seasonStats);

    return {
      ok:            true,
      playerId,
      name:          player.name,
      position,
      team:          player.team?.name || playerDetail.team?.name,
      nationality:   player.country?.name,
      dateOfBirth:   playerDetail.dateOfBirth,
      age:           playerDetail.dateOfBirthTimestamp
        ? Math.floor((Date.now() - playerDetail.dateOfBirthTimestamp * 1000) / (365.25 * 24 * 3600 * 1000))
        : null,
      height:        playerDetail.height,
      weight:        playerDetail.weight || null,
      shirtNumber:   playerDetail.jerseyNumber ?? playerDetail.shirtNumber ?? null,
      preferredFoot: playerDetail.preferredFoot,
      marketValue:   marketValueStr,
      contractUntil,
      leagueName,
      seasonYear,
      seasonStats: seasonStats ? {
        appearances:   seasonStats.appearances,
        goals:         seasonStats.goals,
        assists:       seasonStats.assists,
        rating:        seasonStats.rating ? parseFloat(Number(seasonStats.rating).toFixed(2)) : null,
        minutesPlayed: seasonStats.minutesPlayed,
        yellowCards:   seasonStats.yellowCards,
        redCards:      seasonStats.redCards,
        expectedGoals: seasonStats.expectedGoals ? parseFloat(Number(seasonStats.expectedGoals).toFixed(2)) : null,
        keyPasses:     seasonStats.keyPasses,
      } : null,
      positionStats,
      uclStats,
      recentAvgRating,
      last5Matches,
      lastMatchStats,
    };
  } catch (e) {
    if (e.response?.status === 403) {
      return { ok: false, error: 'SofaScore: IPブロック(403)。プロキシ設定が必要です' };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScorePlayer, searchPlayer };
