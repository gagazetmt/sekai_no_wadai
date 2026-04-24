// scripts/modules/fetchers/sofascore_match.js
// SofaScore から試合情報を取得（最適化版: 5-6 API call）
//  ① /search/all/              → matchId（team1 + team2 で検索）
//  ② /event/{id}               → 基本情報・スコア・会場
//  ③ /event/{id}/incidents     → 得点・カード
//  ④ /event/{id}/statistics    → 試合スタッツ
//  ⑤ /event/{id}/lineups       → 選手個人スタッツ・ラインアップ
//  ⑥ /team/{homeId}/events/last/0 → H2H直近5試合（オプション、homeId/awayIdが取れたら）

const { apiGet } = require('./_sofa_common');

async function searchMatch(homeTeam, awayTeam) {
  const q = `${homeTeam} ${awayTeam}`;
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(q)}`);
  const events = (data.results || []).filter(r => r.type === 'event');
  if (!events.length) return null;
  const sorted = events
    .map(r => r.entity)
    .filter(e => e.startTimestamp)
    .sort((a, b) => b.startTimestamp - a.startTimestamp);
  return sorted[0] || null;
}

async function fetchSofaScoreMatch(homeTeam, awayTeam) {
  if (!homeTeam || !awayTeam) return { ok: false, error: 'ホーム/アウェイチーム名が必要です' };

  try {
    // ① 試合検索
    const match = await searchMatch(homeTeam, awayTeam);
    if (!match) return { ok: false, error: `SofaScore に "${homeTeam} vs ${awayTeam}" の試合が見つかりません` };
    const matchId = match.id;

    // ② 試合詳細（スコアと基本情報）
    let homeScore = null, awayScore = null, matchDate = null, tournament = null;
    let homeTeamName = match.homeTeam?.name || homeTeam;
    let awayTeamName = match.awayTeam?.name || awayTeam;
    let homeTeamId   = match.homeTeam?.id   || null;
    let awayTeamId   = match.awayTeam?.id   || null;
    let venue        = null;
    let attendance   = null;
    try {
      const detail = await apiGet(`/event/${matchId}`);
      const ev     = detail.event || {};
      homeScore = ev.homeScore?.display ?? ev.homeScore?.normaltime ?? null;
      awayScore = ev.awayScore?.display ?? ev.awayScore?.normaltime ?? null;
      const statusType = ev.status?.type || '';
      if (statusType === 'finished' && ev.homeScore?.penalties != null) {
        homeScore = `${homeScore} (PK ${ev.homeScore.penalties}-${ev.awayScore.penalties})`;
        awayScore = null;
      }
      matchDate    = ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10) : null;
      tournament   = ev.tournament?.name || null;
      homeTeamName = ev.homeTeam?.name || homeTeamName;
      awayTeamName = ev.awayTeam?.name || awayTeamName;
      homeTeamId   = ev.homeTeam?.id   || homeTeamId;
      awayTeamId   = ev.awayTeam?.id   || awayTeamId;
      venue        = ev.venue?.stadium?.name || null;
      attendance   = ev.attendance || null;
    } catch (_) {
      homeScore = match.homeScore?.display ?? match.homeScore?.normaltime ?? null;
      awayScore = match.awayScore?.display ?? match.awayScore?.normaltime ?? null;
      matchDate = match.startTimestamp ? new Date(match.startTimestamp * 1000).toISOString().slice(0, 10) : null;
      tournament = match.tournament?.name || null;
    }

    // ③ incidents（得点・カード）
    let goals = [], cards = [];
    try {
      const incData   = await apiGet(`/event/${matchId}/incidents`);
      const incidents = incData.incidents || [];
      for (const inc of incidents) {
        if (inc.time < 0) continue;
        const timeStr = inc.addedTime && inc.addedTime > 0
          ? `${inc.time}+${inc.addedTime}'`
          : `${inc.time}'`;
        if (inc.incidentType === 'goal') {
          goals.push({
            time: inc.time, timeStr,
            player: inc.player?.name || '不明',
            isHome: inc.isHome,
            team:   inc.isHome ? homeTeamName : awayTeamName,
            type:   inc.incidentClass === 'own' ? 'OG'
                  : inc.incidentClass === 'penalty' ? 'PK' : '通常',
          });
        } else if (inc.incidentType === 'card') {
          cards.push({
            time: inc.time, timeStr,
            player: inc.player?.name || '不明',
            isHome: inc.isHome,
            team:   inc.isHome ? homeTeamName : awayTeamName,
            color:  inc.incidentClass === 'red' ? 'レッド'
                  : inc.incidentClass === 'yellowRed' ? '2枚目イエロー→退場' : 'イエロー',
          });
        }
      }
      goals.sort((a, b) => a.time - b.time);
      cards.sort((a, b) => a.time - b.time);
    } catch (_) {}

    // ④ 試合スタッツ（ポゼッション・シュート等）
    let stats = {};
    try {
      const statsRaw = await apiGet(`/event/${matchId}/statistics`);
      for (const group of (statsRaw.statistics?.[0]?.groups || [])) {
        for (const item of (group.statisticsItems || [])) {
          if (!stats[item.name]) {
            stats[item.name] = { home: item.home, away: item.away };
          }
        }
      }
    } catch (_) {}

    // ⑤ ラインアップ + 選手個人スタッツ
    let topPlayers  = [];
    let playerStats = {};
    let formations  = { home: null, away: null };
    try {
      const lineupData = await apiGet(`/event/${matchId}/lineups`);
      formations.home = lineupData.home?.formation || null;
      formations.away = lineupData.away?.formation || null;

      const home = lineupData.home?.players || [];
      const away = lineupData.away?.players || [];
      const allPlayers = [
        ...home.map(p => ({ ...p, team: 'home' })),
        ...away.map(p => ({ ...p, team: 'away' })),
      ];

      topPlayers = allPlayers
        .map(p => ({ name: p.player?.name, team: p.team, rating: p.statistics?.rating }))
        .filter(p => p.name && p.rating)
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 5)
        .map(p => ({
          name:   p.name,
          team:   p.team === 'home' ? homeTeamName : awayTeamName,
          rating: parseFloat(Number(p.rating).toFixed(1)),
        }));

      for (const p of allPlayers) {
        if (!p.player?.name || !p.statistics) continue;
        const st = p.statistics;
        playerStats[p.player.name] = {
          team:             p.team === 'home' ? homeTeamName : awayTeamName,
          rating:           st.rating ? parseFloat(Number(st.rating).toFixed(1)) : null,
          minutesPlayed:    st.minutesPlayed ?? null,
          goals:            st.goals ?? null,
          assists:          st.goalAssist ?? null,
          shots:            st.totalShots ?? null,
          shotsOnTarget:    st.onTargetScoringAttempt ?? null,
          keyPasses:        st.keyPass ?? null,
          passes:           st.totalPass ?? null,
          passAccuracy:     st.totalPass ? Math.round((st.accuratePass ?? 0) / st.totalPass * 100) : null,
          dribbles:         st.totalContest ?? null,
          dribblesWon:      st.wonContest ?? null,
          touches:          st.touches ?? null,
          fouls:            st.fouls ?? null,
          wasFouled:        st.wasFouled ?? null,
          expectedGoals:    st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
          bigChanceCreated: st.bigChanceCreated ?? null,
        };
      }
    } catch (_) {}

    // ⑥ H2H直近5試合（homeTeamId/awayTeamId両方が取れた場合のみ）
    let h2hMatches = [];
    let h2hSummary = null;
    if (homeTeamId && awayTeamId) {
      try {
        const h2hRes  = await apiGet(`/team/${homeTeamId}/events/last/0`);
        const allEvs  = h2hRes.events || [];
        const h2hEvts = allEvs
          .filter(e =>
            e.status?.type === 'finished' &&
            (e.homeTeam?.id === awayTeamId || e.awayTeam?.id === awayTeamId) &&
            e.id !== matchId
          )
          .slice(0, 5);

        let w = 0, d = 0, l = 0;
        h2hMatches = h2hEvts.map(e => {
          const hs = e.homeScore?.display ?? e.homeScore?.normaltime ?? '?';
          const as = e.awayScore?.display ?? e.awayScore?.normaltime ?? '?';
          const date = e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null;
          // homeTeamIdから見た勝敗
          const isHome = e.homeTeam?.id === homeTeamId;
          if (e.winnerCode === 3) d++;
          else if ((isHome && e.winnerCode === 1) || (!isHome && e.winnerCode === 2)) w++;
          else l++;
          return {
            date,
            scoreline:  `${e.homeTeam?.name} ${hs}-${as} ${e.awayTeam?.name}`,
            tournament: e.tournament?.name,
          };
        });
        if (h2hMatches.length) {
          h2hSummary = `${homeTeamName}から見て ${w}勝${d}分${l}敗（直近${h2hMatches.length}試合）`;
        }
      } catch (_) {}
    }

    const scoreline = awayScore != null
      ? `${homeTeamName} ${homeScore ?? '?'} - ${awayScore} ${awayTeamName}`
      : `${homeTeamName} ${homeScore ?? '?'} ${awayTeamName}`;

    return {
      ok: true,
      matchId,
      homeTeam:  homeTeamName,
      awayTeam:  awayTeamName,
      homeTeamId,
      awayTeamId,
      homeScore: homeScore ?? null,
      awayScore: awayScore ?? null,
      matchDate,
      tournament,
      venue,
      attendance,
      scoreline,
      goals,
      cards,
      stats,
      formations,
      topPlayers,
      playerStats,
      h2hMatches,
      h2hSummary,
    };
  } catch (e) {
    if (e.response?.status === 403) {
      return { ok: false, error: 'SofaScore: IPブロック(403)。プロキシ設定が必要です' };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreMatch, searchMatch };
