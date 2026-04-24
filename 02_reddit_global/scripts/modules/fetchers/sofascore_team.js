// scripts/modules/fetchers/sofascore_team.js
// SofaScore からチーム情報を取得（最適化版: 5 API call）
//  ① /search/all/                → teamId
//  ② /team/{id}                  → 基本情報・監督・市場価値
//  ③ /team/{id}/events/last/0    → 直近5試合
//  ④ /team/{id}/events/next/0    → リーグ情報（tournament+season ID取得のため）
//  ⑤ /unique-tournament/{t}/season/{s}/standings/total → 順位・今期スタッツ

const { apiGet } = require('./_sofa_common');

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

function formatTeamMatch(e, teamId) {
  const isHome   = e.homeTeam?.id === teamId;
  const homeScore = e.homeScore?.display ?? e.homeScore?.normaltime ?? null;
  const awayScore = e.awayScore?.display ?? e.awayScore?.normaltime ?? null;
  const myScore   = isHome ? homeScore : awayScore;
  const oppScore  = isHome ? awayScore : homeScore;
  const oppName   = isHome ? e.awayTeam?.name : e.homeTeam?.name;
  const winner    = e.winnerCode;
  const result    = winner === 3 ? 'D' : ((isHome && winner === 1) || (!isHome && winner === 2)) ? 'W' : 'L';
  return {
    result,
    opponent:   oppName,
    isHome,
    score:      `${myScore ?? '?'}-${oppScore ?? '?'}`,
    date:       e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null,
    tournament: e.tournament?.name,
  };
}

async function fetchSofaScoreTeam(teamName) {
  if (!teamName) return { ok: false, error: 'チーム名が必要です' };

  try {
    // ① チーム検索
    const team = await searchTeam(teamName);
    if (!team) return { ok: false, error: `SofaScore に "${teamName}" が見つかりません` };
    const teamId = team.id;

    // ② チーム詳細
    let teamDetail = {};
    try {
      const td   = await apiGet(`/team/${teamId}`);
      teamDetail = td.team || {};
    } catch (_) {}

    const managerName = teamDetail.manager?.name || null;
    const managerId   = teamDetail.manager?.id   || null;
    const venue       = teamDetail.venue?.stadium?.name || null;
    const country     = teamDetail.country?.name || team.country?.name || null;
    const founded     = teamDetail.foundationDateTimestamp
      ? new Date(teamDetail.foundationDateTimestamp * 1000).getFullYear()
      : null;
    // クラブ総市場価値（取れたら）
    const marketValue    = teamDetail.value?.value || teamDetail.proposedMarketValue || null;
    const marketValueStr = marketValue
      ? (marketValue >= 1_000_000
          ? `€${(marketValue / 1_000_000).toFixed(0)}M`
          : `€${(marketValue / 1_000).toFixed(0)}K`)
      : null;

    // ③ 直近5試合（ページ0のみ。通常10-12件取れる）
    let last5 = [];
    try {
      const ev = await apiGet(`/team/${teamId}/events/last/0`);
      const finished = (ev.events || []).filter(e => e.status?.type === 'finished').reverse();
      // reverseで古い順→新しい順にし直してslice(0,5)で最新5試合
      last5 = finished.slice(-5).reverse().map(e => formatTeamMatch(e, teamId));
    } catch (_) {}

    // ④ 次試合（リーグ情報取得のため）
    let leagueName = null;
    let seasonYear = null;
    let tournamentId = null;
    let seasonId     = null;
    try {
      const nx = await apiGet(`/team/${teamId}/events/next/0`);
      const nextEvent = (nx.events || []).find(e => e.tournament?.uniqueTournament);
      if (nextEvent) {
        tournamentId = nextEvent.tournament?.uniqueTournament?.id;
        seasonId     = nextEvent.season?.id;
        leagueName   = nextEvent.tournament?.uniqueTournament?.name || nextEvent.tournament?.name;
        seasonYear   = nextEvent.season?.year;
      }
    } catch (_) {}

    // ⑤ 順位（今期スタッツ）
    let standing = null;
    if (tournamentId && seasonId) {
      try {
        const st = await apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`);
        const rows = st.standings?.[0]?.rows || [];
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
      } catch (_) {}
    }

    return {
      ok:          true,
      teamId,
      teamName:    teamDetail.name || team.name,
      country,
      venue,
      founded,
      marketValue: marketValueStr,
      managerName,
      managerId,
      leagueName,
      seasonYear,
      standing,
      last5,
    };
  } catch (e) {
    if (e.response?.status === 403) {
      return { ok: false, error: 'SofaScore: IPブロック(403)。プロキシ設定が必要です' };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreTeam, searchTeam };
