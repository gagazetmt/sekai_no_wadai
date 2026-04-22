// scripts/modules/fetchers/sofascore_match.js
// SofaScore から試合結果・得点・カード情報を取得

const axios = require('axios');

const BASE_URL = 'https://api.sofascore.com/api/v1';
const HEADERS  = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          'application/json',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

async function apiGet(endpoint) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, { headers: HEADERS, timeout: 12000 });
  return res.data;
}

// チーム名で試合を検索し、最も直近の試合を返す
async function searchMatch(homeTeam, awayTeam) {
  const q = `${homeTeam} ${awayTeam}`;
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(q)}`);
  const events = (data.results || []).filter(r => r.type === 'event');
  if (!events.length) return null;

  // 最も最近の試合（startTimestamp が最大）を選ぶ
  const sorted = events
    .map(r => r.entity)
    .filter(e => e.startTimestamp)
    .sort((a, b) => b.startTimestamp - a.startTimestamp);

  return sorted[0] || null;
}

// 試合の得点・カード・交代を取得してまとめる
async function fetchSofaScoreMatch(homeTeam, awayTeam) {
  if (!homeTeam || !awayTeam) return { ok: false, error: 'ホーム/アウェイチーム名が必要です' };

  try {
    // ① 試合を検索
    const match = await searchMatch(homeTeam, awayTeam);
    if (!match) return { ok: false, error: `SofaScore に "${homeTeam} vs ${awayTeam}" の試合が見つかりません` };

    const matchId = match.id;

    // ② 試合詳細（スコアを確実に取得）
    let homeScore = null, awayScore = null, matchDate = null, tournament = null;
    let homeTeamName = match.homeTeam?.name || homeTeam;
    let awayTeamName = match.awayTeam?.name || awayTeam;
    try {
      const detail = await apiGet(`/event/${matchId}`);
      const ev = detail.event || {};
      homeScore    = ev.homeScore?.display ?? ev.homeScore?.normaltime ?? null;
      awayScore    = ev.awayScore?.display ?? ev.awayScore?.normaltime ?? null;
      // PK決着の場合はペナルティスコアを付記
      const statusType = ev.status?.type || '';
      if (statusType === 'finished' && ev.homeScore?.penalties != null) {
        homeScore = `${homeScore} (PK ${ev.homeScore.penalties}-${ev.awayScore.penalties})`;
        awayScore = null; // scorelineはhomeScoreにまとめる
      }
      matchDate    = ev.startTimestamp ? new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10) : null;
      tournament   = ev.tournament?.name || null;
      homeTeamName = ev.homeTeam?.name || homeTeamName;
      awayTeamName = ev.awayTeam?.name || awayTeamName;
    } catch (_) {
      // 検索結果からフォールバック
      homeScore  = match.homeScore?.display ?? match.homeScore?.normaltime ?? null;
      awayScore  = match.awayScore?.display ?? match.awayScore?.normaltime ?? null;
      matchDate  = match.startTimestamp ? new Date(match.startTimestamp * 1000).toISOString().slice(0, 10) : null;
      tournament = match.tournament?.name || null;
    }

    // ③ incidents（得点・カード）を取得
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
            time:      inc.time,
            timeStr,
            player:    inc.player?.name || '不明',
            isHome:    inc.isHome,
            team:      inc.isHome ? homeTeamName : awayTeamName,
            type:      inc.incidentClass === 'own' ? 'OG' : inc.incidentClass === 'penalty' ? 'PK' : '通常',
          });
        } else if (inc.incidentType === 'card') {
          cards.push({
            time:      inc.time,
            timeStr,
            player:    inc.player?.name || '不明',
            isHome:    inc.isHome,
            team:      inc.isHome ? homeTeamName : awayTeamName,
            color:     inc.incidentClass === 'red' ? 'レッド' : inc.incidentClass === 'yellowRed' ? '2枚目イエロー→退場' : 'イエロー',
          });
        }
      }
      goals.sort((a, b) => a.time - b.time);
      cards.sort((a, b) => a.time - b.time);
    } catch (_) {}

    // ④ 試合スタッツ（ポゼッション・シュート等）を取得
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

    // ⑤ ラインアップ・評価点トップ選手・全選手個人スタッツを取得
    let topPlayers = [];
    let playerStats = {}; // { "Xavi Simons": { goals:1, assists:1, rating:8.3, ... } }
    let venue = null, attendance = null;
    try {
      const [lineupData, detailData] = await Promise.all([
        apiGet(`/event/${matchId}/lineups`).catch(() => null),
        apiGet(`/event/${matchId}`).catch(() => null),
      ]);
      if (lineupData) {
        const home = lineupData.home?.players || [];
        const away = lineupData.away?.players || [];
        const allPlayers = [...home, ...away];

        topPlayers = allPlayers
          .map(p => ({ name: p.player?.name, rating: p.statistics?.rating }))
          .filter(p => p.name && p.rating)
          .sort((a, b) => b.rating - a.rating)
          .slice(0, 5)
          .map(p => ({ name: p.name, rating: parseFloat(Number(p.rating).toFixed(1)) }));

        // 全選手の個人スタッツをマップに格納
        for (const p of allPlayers) {
          if (!p.player?.name || !p.statistics) continue;
          const st = p.statistics;
          playerStats[p.player.name] = {
            rating:         st.rating ? parseFloat(Number(st.rating).toFixed(1)) : null,
            minutesPlayed:  st.minutesPlayed ?? null,
            goals:          st.goals ?? null,
            assists:        st.goalAssist ?? null,
            shots:          st.totalShots ?? null,
            shotsOnTarget:  st.onTargetScoringAttempt ?? null,
            keyPasses:      st.keyPass ?? null,
            passes:         st.totalPass ?? null,
            passAccuracy:   st.totalPass ? Math.round((st.accuratePass ?? 0) / st.totalPass * 100) : null,
            dribbles:       st.totalContest ?? null,
            dribblesWon:    st.wonContest ?? null,
            touches:        st.touches ?? null,
            fouls:          st.fouls ?? null,
            wasFouled:      st.wasFouled ?? null,
            expectedGoals:  st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
            bigChanceCreated: st.bigChanceCreated ?? null,
          };
        }
      }
      if (detailData?.event) {
        venue      = detailData.event.venue?.stadium?.name || null;
        attendance = detailData.event.attendance || null;
      }
    } catch (_) {}

    // ⑥ 両チームの直近成績 ＆ H2H直近5試合を取得
    let homeTeamLast5 = null, awayTeamLast5 = null, h2hSummary = null;
    try {
      const { fetchSofaScoreTeam, searchTeam } = require('./sofascore_team');
      
      // チームIDを取得
      const [homeEnt, awayEnt] = await Promise.all([
        searchTeam(homeTeamName),
        searchTeam(awayTeamName)
      ]);

      if (homeEnt && awayEnt) {
        const id1 = homeEnt.id;
        const id2 = awayEnt.id;

        // 並列取得: ホーム直近, アウェイ直近, H2H履歴
        const [homeT, awayT, h2hRes] = await Promise.all([
          fetchSofaScoreTeam(homeTeamName),
          fetchSofaScoreTeam(awayTeamName),
          apiGet(`/team/${id1}/events/last/0`).catch(() => ({ events: [] })) // H2H用にページ0取得
        ]);

        if (homeT.ok && homeT.last5) {
          homeTeamLast5 = homeT.last5.map(r => r.result === 'W' ? '○' : r.result === 'D' ? '△' : '●').join('');
        }
        if (awayT.ok && awayT.last5) {
          awayTeamLast5 = awayT.last5.map(r => r.result === 'W' ? '○' : r.result === 'D' ? '△' : '●').join('');
        }

        // H2H抽出（直近5試合分）
        const h2hEvents = (h2hRes.events || []).filter(e => e.homeTeam?.id === id2 || e.awayTeam?.id === id2).slice(0, 5);
        if (h2hEvents.length) {
          let w = 0, d = 0, l = 0;
          h2hEvents.forEach(e => {
            if (e.winnerCode === 3) d++;
            else if ((e.homeTeam.id === id1 && e.winnerCode === 1) || (e.awayTeam.id === id1 && e.winnerCode === 2)) w++;
            else l++;
          });
          h2hSummary = `${w}勝${d}分${l}敗`;
        }
      }
    } catch (e) {
      console.error(`[SofaScore Match Extra] Error: ${e.message}`);
    }

    // ⑦ 人間可読なサマリーを生成
    const scoreline = awayScore != null
      ? `${homeTeamName} ${homeScore ?? '?'} - ${awayScore} ${awayTeamName}`
      : `${homeTeamName} ${homeScore ?? '?'} ${awayTeamName}`;
    const goalSummary = goals.map(g =>
      `${g.timeStr} ${g.player}（${g.team}）${g.type !== '通常' ? `[${g.type}]` : ''}`
    ).join(', ') || '（得点情報なし）';
    const cardSummary = cards.length
      ? cards.map(c => `${c.timeStr} ${c.player}（${c.team}）${c.color}`).join(', ')
      : 'なし';

    return {
      ok: true,
      matchId,
      homeTeam:   homeTeamName,
      awayTeam:   awayTeamName,
      homeScore:  homeScore ?? null,
      awayScore:  awayScore ?? null,
      matchDate,
      tournament,
      venue,
      attendance,
      homeTeamLast5,
      awayTeamLast5,
      h2hSummary,
      goals,
      cards,
      stats,
      topPlayers,
      playerStats,
      scoreline,
      summary: `【試合結果】${scoreline}（${matchDate || '日付不明'} / ${tournament || '大会不明'}）\n` +
               `【得点】${goalSummary}\n` +
               `【カード】${cardSummary}\n` +
               (h2hSummary ? `【H2H直近5試合】${h2hSummary}` : ''),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// チーム名 → チームIDを検索
async function searchTeamId(teamName) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(teamName)}`);
  const teams = (data.results || []).filter(r => r.type === 'team');
  return teams[0]?.entity?.id || null;
}

// 2チーム間のH2H（過去対戦成績）を取得
async function fetchSofaScoreH2H(team1, team2) {
  if (!team1 || !team2) return { ok: false, error: 'チーム名が2つ必要です' };

  try {
    // ① 両チームのIDを取得
    const [id1, id2] = await Promise.all([
      searchTeamId(team1),
      searchTeamId(team2),
    ]);
    if (!id1 || !id2) return { ok: false, error: `チームIDが取得できません: ${team1}(${id1}) / ${team2}(${id2})` };

    // ② チーム1のイベント履歴を最大5ページ漁って対戦相手(id2)との試合を抽出
    const MAX_PAGES = 5, TARGET_COUNT = 8;
    const h2hEvents = [];
    for (let page = 0; page < MAX_PAGES && h2hEvents.length < TARGET_COUNT; page++) {
      const d = await apiGet(`/team/${id1}/events/last/${page}`).catch(() => null);
      const evts = d?.events || [];
      if (!evts.length) break;
      const hits = evts.filter(e => e.homeTeam?.id === id2 || e.awayTeam?.id === id2);
      h2hEvents.push(...hits);
    }

    // ③ /event/{matchId}/h2h から通算成績サマリーを取得（直近の試合IDで取る）
    let duel = null;
    if (h2hEvents.length) {
      const latestId = h2hEvents[0].id;
      const h2hData  = await apiGet(`/event/${latestId}/h2h`).catch(() => null);
      duel = h2hData?.teamDuel || null;
    }

    // 直近の試合からチーム名を確定
    const latestEv    = h2hEvents[0];
    const team1Name   = latestEv ? (latestEv.homeTeam?.id === id1 ? latestEv.homeTeam?.name : latestEv.awayTeam?.name) : team1;
    const team2Name   = latestEv ? (latestEv.homeTeam?.id === id2 ? latestEv.homeTeam?.name : latestEv.awayTeam?.name) : team2;

    const duelText = duel
      ? `${team1Name} ${duel.homeWins}勝 ${duel.draws}分 ${duel.awayWins}敗 vs ${team2Name}`
      : null;

    // 過去の試合リスト
    const previousEvents = h2hEvents.slice(0, TARGET_COUNT).map(ev => {
      const date = ev.startTimestamp
        ? new Date(ev.startTimestamp * 1000).toISOString().slice(0, 10) : '?';
      const hs = ev.homeScore?.display ?? ev.homeScore?.normaltime ?? '?';
      const as = ev.awayScore?.display ?? ev.awayScore?.normaltime ?? '?';
      return {
        date,
        homeTeam:   ev.homeTeam?.name || '?',
        awayTeam:   ev.awayTeam?.name || '?',
        homeScore:  hs,
        awayScore:  as,
        scoreline:  `${ev.homeTeam?.name || '?'} ${hs} - ${as} ${ev.awayTeam?.name || '?'}`,
        tournament: ev.tournament?.name || '',
      };
    });

    const prevText = previousEvents.length
      ? previousEvents.map(e => `  ${e.date} ${e.scoreline}（${e.tournament}）`).join('\n')
      : '（過去の対戦データなし）';

    return {
      ok: true,
      team1: team1Name,
      team2: team2Name,
      duel,
      duelText,
      previousEvents,
      summaryText:
        `【H2H: ${team1Name} vs ${team2Name}】\n` +
        (duelText ? `通算: ${duelText}\n` : '') +
        `過去の対戦:\n${prevText}`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreMatch, fetchSofaScoreH2H };
