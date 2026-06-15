// scripts/modules/fetchers/sofascore_match.js
// SofaScore から試合情報を取得（最適化版: 5-6 API call）
//  ① /search/all/              → matchId（team1 + team2 で検索）
//  ② /event/{id}               → 基本情報・スコア・会場
//  ③ /event/{id}/incidents     → 得点・カード
//  ④ /event/{id}/statistics    → 試合スタッツ
//  ⑤ /event/{id}/lineups       → 選手個人スタッツ・ラインアップ
//  ⑥ /team/{homeId}/events/last/0 → H2H直近5試合（オプション、homeId/awayIdが取れたら）

const { apiGet, apiGetImage } = require('./_sofa_common');

// チーム名 → teamId を1件取得
async function _findTeamId(teamName) {
  try {
    const data = await apiGet(`/search/all/?q=${encodeURIComponent(teamName)}`);
    const team = (data.results || []).find(r =>
      r.type === 'team' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
    );
    return team?.entity || null;
  } catch (_) { return null; }
}

/**
 * 「Home vs Away」から直近の試合イベントを特定する。
 *  戦略1（速い）: /search/all/?q=A B → recent events（ただし古い試合が先頭に来がち）
 *  戦略2（正確）: 両チームの team ID を取得 → /team/{home}/events/last/0 で絞り込み
 *                 → 両チーム ID が一致する試合だけ残して時系列ソート → 最新を返す
 */
async function searchMatch(homeTeam, awayTeam) {
  // 戦略2：team events から直接 H2H を引く（正確・最新優先）
  const [homeEnt, awayEnt] = await Promise.all([
    _findTeamId(homeTeam),
    _findTeamId(awayTeam),
  ]);

  if (homeEnt && awayEnt) {
    try {
      // home の直近イベント → awayId と対戦したものだけ抽出 → 新しい順
      const evRes = await apiGet(`/team/${homeEnt.id}/events/last/0`);
      const h2hEvents = (evRes.events || [])
        .filter(e =>
          (e.homeTeam?.id === homeEnt.id && e.awayTeam?.id === awayEnt.id) ||
          (e.homeTeam?.id === awayEnt.id && e.awayTeam?.id === homeEnt.id)
        )
        .sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0));

      if (h2hEvents.length) {
        console.log(`[SofaScore Match] H2H戦略2で発見: ${homeTeam} vs ${awayTeam} → ${new Date(h2hEvents[0].startTimestamp*1000).toISOString().slice(0,10)}`);
        return h2hEvents[0];
      }
    } catch (_) {}
  }

  // 戦略1：fallback の汎用検索（チーム ID が取れない時のため）
  const q = `${homeTeam} ${awayTeam}`;
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(q)}`);
  const events = (data.results || []).filter(r => r.type === 'event');
  if (!events.length) return null;

  const sorted = events
    .map(r => r.entity)
    .filter(e => e.startTimestamp)
    .sort((a, b) => b.startTimestamp - a.startTimestamp);

  // finished を優先（upcoming だとまだスコア無いため）
  const finished = sorted.filter(e => e.status?.type === 'finished');
  console.log(`[SofaScore Match] 戦略1 fallback: ${sorted.length}件中 finished ${finished.length}件`);
  return finished[0] || sorted[0] || null;
}

// H2H 履歴を取得（直近 N 件）
async function fetchRecentH2H(homeTeam, awayTeam, limit = 3) {
  const [homeEnt, awayEnt] = await Promise.all([
    _findTeamId(homeTeam),
    _findTeamId(awayTeam),
  ]);
  if (!homeEnt || !awayEnt) return [];

  try {
    const evRes = await apiGet(`/team/${homeEnt.id}/events/last/0`);
    return (evRes.events || [])
      .filter(e =>
        (e.homeTeam?.id === homeEnt.id && e.awayTeam?.id === awayEnt.id) ||
        (e.homeTeam?.id === awayEnt.id && e.awayTeam?.id === homeEnt.id)
      )
      .sort((a, b) => (b.startTimestamp || 0) - (a.startTimestamp || 0))
      .slice(0, limit)
      .map(e => ({
        id:         e.id,
        date:       e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null,
        homeTeam:   e.homeTeam?.name,
        awayTeam:   e.awayTeam?.name,
        homeScore:  e.homeScore?.display ?? e.homeScore?.normaltime ?? null,
        awayScore:  e.awayScore?.display ?? e.awayScore?.normaltime ?? null,
        tournament: e.tournament?.name,
        status:     e.status?.type,
      }));
  } catch (_) { return []; }
}

async function fetchSofaScoreMatch(homeTeam, awayTeam) {
  if (!homeTeam || !awayTeam) return { ok: false, error: 'ホーム/アウェイチーム名が必要です' };

  try {
    // ① 試合検索
    const match = await searchMatch(homeTeam, awayTeam);
    if (!match) {
      return { ok: false, error: `SofaScore に "${homeTeam} vs ${awayTeam}" の試合が見つかりません` };
    }
    const matchId = match.id;

    // ②③④⑤ 並列取得（detail / incidents / statistics / lineups）────────
    const [detailRaw, incRaw, statsRaw, lineupRaw] = await Promise.all([
      apiGet(`/event/${matchId}`).catch(e => ({ __err: e })),
      apiGet(`/event/${matchId}/incidents`).catch(e => ({ __err: e })),
      apiGet(`/event/${matchId}/statistics`).catch(e => ({ __err: e })),
      apiGet(`/event/${matchId}/lineups`).catch(e => ({ __err: e })),
    ]);

    // ② 試合詳細（スコアと基本情報）
    let homeScore = null, awayScore = null, matchDate = null, tournament = null;
    let homeTeamName = match.homeTeam?.name || homeTeam;
    let awayTeamName = match.awayTeam?.name || awayTeam;
    let homeTeamId   = match.homeTeam?.id   || null;
    let awayTeamId   = match.awayTeam?.id   || null;
    let venue        = null;
    let attendance   = null;
    if (!detailRaw?.__err && detailRaw.event) {
      const ev = detailRaw.event;
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
    } else {
      homeScore = match.homeScore?.display ?? match.homeScore?.normaltime ?? null;
      awayScore = match.awayScore?.display ?? match.awayScore?.normaltime ?? null;
      matchDate = match.startTimestamp ? new Date(match.startTimestamp * 1000).toISOString().slice(0, 10) : null;
      tournament = match.tournament?.name || null;
    }

    // ③ incidents（得点・カード・交代）
    let goals = [], cards = [], subs = [];
    if (!incRaw?.__err) {
      const incidents = incRaw.incidents || [];
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
        } else if (inc.incidentType === 'substitution') {
          subs.push({
            time: inc.time, timeStr,
            playerIn:  inc.playerIn?.name  || '不明',
            playerOut: inc.playerOut?.name || '不明',
            isHome:    inc.isHome,
            team:      inc.isHome ? homeTeamName : awayTeamName,
          });
        }
      }
      goals.sort((a, b) => a.time - b.time);
      cards.sort((a, b) => a.time - b.time);
      subs.sort((a, b) => a.time - b.time);
    }

    // ④ 試合スタッツ（ポゼッション・シュート等）
    let stats = {};
    if (!statsRaw?.__err) {
      for (const group of (statsRaw.statistics?.[0]?.groups || [])) {
        for (const item of (group.statisticsItems || [])) {
          if (!stats[item.name]) {
            stats[item.name] = { home: item.home, away: item.away };
          }
        }
      }
    }

    // ⑤ ラインアップ + 選手個人スタッツ（並列取得済みを処理）
    let topPlayers  = [];
    let playerStats = {};
    let formations  = { home: null, away: null };
    let lineup      = { home: [], away: [] };  // 先発11人 (pos: GK/DF/MF/FW)
    if (!lineupRaw?.__err) {
      const lineupData = lineupRaw;
      formations.home = lineupData.home?.formation || null;
      formations.away = lineupData.away?.formation || null;

      const home = lineupData.home?.players || [];
      const away = lineupData.away?.players || [];

      // SofaScore position コード → 内部 pos 名
      const POS_MAP = { G: 'goalkeeper', D: 'defender', M: 'midfielder', F: 'forward' };
      async function _toLineup(arr) {
        const players = arr
          .filter(p => !p.substitute)  // 先発のみ
          .map(p => ({
            id:      p.player?.id || null,
            name:    p.player?.name || '',
            jersey:  p.jerseyNumber || p.shirtNumber || null,
            pos:     POS_MAP[p.position] || 'midfielder',
          }))
          .filter(x => x.name);
        // 選手顔写真を並列取得（id がある選手のみ、失敗時 null）
        await Promise.all(players.map(async p => {
          if (!p.id) return;
          p.photo = await apiGetImage(`/player/${p.id}/image`).catch(() => null);
        }));
        return players;
      }
      lineup.home = await _toLineup(home);
      lineup.away = await _toLineup(away);

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
    }

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

    // ⑦ チームロゴ取得（matchcard で表示）── 並列、失敗時 null
    const [homeLogo, awayLogo] = await Promise.all([
      homeTeamId ? apiGetImage(`/team/${homeTeamId}/image`) : Promise.resolve(null),
      awayTeamId ? apiGetImage(`/team/${awayTeamId}/image`) : Promise.resolve(null),
    ]);

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
      homeLogo,
      awayLogo,
      homeScore: homeScore ?? null,
      awayScore: awayScore ?? null,
      matchDate,
      tournament,
      venue,
      attendance,
      scoreline,
      goals,
      cards,
      subs,
      stats,
      formations,
      lineup,
      topPlayers,
      playerStats,
      h2hMatches,
      h2hSummary,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreMatch, searchMatch, fetchRecentH2H };
