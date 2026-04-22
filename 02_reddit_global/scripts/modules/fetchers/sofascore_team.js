// scripts/modules/fetchers/sofascore_team.js
// SofaScore からチーム情報・順位・直近試合・監督を取得

const axios = require('axios');

const BASE_URL = 'https://api.sofascore.com/api/v1';
const HEADERS  = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':     'application/json',
  'Referer':    'https://www.sofascore.com/',
  'Origin':     'https://www.sofascore.com',
};

async function apiGet(endpoint) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, { headers: HEADERS, timeout: 12000 });
  return res.data;
}

async function searchTeam(teamName) {
  try {
    const data = await apiGet(`/search/all/?q=${encodeURIComponent(teamName)}`);
    const teams = (data.results || []).filter(r =>
      r.type === 'team' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
    );
    return teams.length ? teams[0].entity : null;
  } catch (_) {
    return null;
  }
}

async function fetchSofaScoreTeam(teamName) {
  if (!teamName) return { ok: false, error: 'チーム名が必要です' };

  try {
    // ① チーム検索
    const searchData = await apiGet(`/search/all/?q=${encodeURIComponent(teamName)}`);
    // sport.id=1 がサッカー。野球・バスケ等を除外
    const teams = (searchData.results || []).filter(r =>
      r.type === 'team' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
    );
    if (!teams.length) return { ok: false, error: `SofaScore に "${teamName}" が見つかりません` };
    const team   = teams[0].entity;
    const teamId = team.id;

    // ② チーム詳細・監督・フォーメーション（並列取得）
    const [detailData, lastPages, nextEventsData] = await Promise.all([
      apiGet(`/team/${teamId}`).catch(() => ({})),
      Promise.all([0,1,2,3].map(p => apiGet(`/team/${teamId}/events/last/${p}`).catch(() => ({ events: [] })))),
      apiGet(`/team/${teamId}/events/next/0`).catch(() => ({ events: [] })),
    ]);

    const teamDetail   = detailData.team || {};
    const managerName  = teamDetail.manager?.name  || null;
    const managerId    = teamDetail.manager?.id    || null;

    // ③ 直近5試合（結果）
    const allLastEvents = lastPages.flatMap(p => p.events || []);
    const last5 = allLastEvents.slice(0, 5).map(e => {
      const isHome   = e.homeTeam?.id === teamId;
      const myScore  = isHome ? (e.homeScore?.display ?? e.homeScore?.normaltime) : (e.awayScore?.display ?? e.awayScore?.normaltime);
      const oppScore = isHome ? (e.awayScore?.display ?? e.awayScore?.normaltime) : (e.homeScore?.display ?? e.homeScore?.normaltime);
      const oppName  = isHome ? e.awayTeam?.name : e.homeTeam?.name;
      const winner   = e.winnerCode;
      const result   = winner === 3 ? 'D' : (isHome ? winner === 1 : winner === 2) ? 'W' : 'L';
      const date     = e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null;
      return { result, opponent: oppName, score: `${myScore}-${oppScore}`, date, tournament: e.tournament?.name };
    });

    // ④ リーグ順位（次の試合のtournament/seasonから取得）
    let standing    = null;
    let leagueName  = null;
    let seasonYear  = null;

    const nextEvent = (nextEventsData.events || []).find(e => e.tournament?.uniqueTournament);
    if (nextEvent) {
      const tid = nextEvent.tournament?.uniqueTournament?.id;
      const sid = nextEvent.season?.id;
      leagueName = nextEvent.tournament?.uniqueTournament?.name || nextEvent.tournament?.name;
      seasonYear = nextEvent.season?.year;

      if (tid && sid) {
        const standData = await apiGet(`/unique-tournament/${tid}/season/${sid}/standings/total`).catch(() => null);
        if (standData) {
          const rows = standData.standings?.[0]?.rows || [];
          const row  = rows.find(r => r.team?.id === teamId);
          if (row) {
            standing = {
              position:     row.position,
              played:       row.matches,
              wins:         row.wins,
              draws:        row.draws,
              losses:       row.losses,
              goalsFor:     row.scoresFor,
              goalsAgainst: row.scoresAgainst,
              points:       row.points,
            };
          }
        }
      }
    }

    // ⑤ サマリー生成
    const last5str = last5.map(m => `${m.result} vs ${m.opponent} ${m.score}`).join(', ');
    const standStr = standing
      ? `${standing.position}位 ${standing.wins}勝${standing.draws}分${standing.losses}敗 ${standing.points}pts ` +
        `(GF:${standing.goalsFor} GA:${standing.goalsAgainst})`
      : null;

    return {
      ok: true,
      teamId,
      teamName:   teamDetail.name || team.name,
      leagueName,
      seasonYear,
      managerName,
      managerId,
      standing,
      last5,
      summary:
        `【チーム情報】${teamDetail.name || team.name}（${leagueName || '不明'} ${seasonYear || ''}）\n` +
        (managerName ? `監督: ${managerName}\n` : '') +
        (standStr    ? `順位: ${standStr}\n` : '') +
        `直近5試合: ${last5str || '（取得失敗）'}`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreTeam, searchTeam };
