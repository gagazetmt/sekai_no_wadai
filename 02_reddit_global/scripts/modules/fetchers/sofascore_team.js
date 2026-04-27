// scripts/modules/fetchers/sofascore_team.js
// SofaScore からチーム情報を取得（最適化版: 5 API call）
//  ① /search/all/                → teamId
//  ② /team/{id}                  → 基本情報・監督・市場価値
//  ③ /team/{id}/events/last/0    → 直近5試合
//  ④ /team/{id}/events/next/0    → リーグ情報（tournament+season ID取得のため）
//  ⑤ /unique-tournament/{t}/season/{s}/standings/total → 順位・今期スタッツ

const { apiGet } = require('./_sofa_common');
const { fetchWikipediaWikitext, extractHonoursSection } = require('./wikipedia');

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

    // ②③④ 並列取得（detail / events last / events next）────────
    const [tdRaw, evRaw, nxRaw] = await Promise.all([
      apiGet(`/team/${teamId}`).catch(e => ({ __err: e })),
      apiGet(`/team/${teamId}/events/last/0`).catch(e => ({ __err: e })),
      apiGet(`/team/${teamId}/events/next/0`).catch(e => ({ __err: e })),
    ]);

    // ② チーム詳細
    const teamDetail = tdRaw?.__err ? {} : (tdRaw.team || {});

    const managerName = teamDetail.manager?.name || null;
    const managerId   = teamDetail.manager?.id   || null;
    const venue       = teamDetail.venue?.stadium?.name || null;
    const country     = teamDetail.country?.name || team.country?.name || null;
    const founded     = teamDetail.foundationDateTimestamp
      ? new Date(teamDetail.foundationDateTimestamp * 1000).getFullYear()
      : null;
    const marketValue    = teamDetail.value?.value || teamDetail.proposedMarketValue || null;
    const marketValueStr = marketValue
      ? (marketValue >= 1_000_000
          ? `€${(marketValue / 1_000_000).toFixed(0)}M`
          : `€${(marketValue / 1_000).toFixed(0)}K`)
      : null;

    // ③ 直近5試合
    let last5 = [];
    if (!evRaw?.__err) {
      const finished = (evRaw.events || []).filter(e => e.status?.type === 'finished').reverse();
      last5 = finished.slice(-5).reverse().map(e => formatTeamMatch(e, teamId));
    }

    // ④ 次試合（リーグ情報取得のため）
    let leagueName = null;
    let seasonYear = null;
    let tournamentId = null;
    let seasonId     = null;
    if (!nxRaw?.__err) {
      const nextEvent = (nxRaw.events || []).find(e => e.tournament?.uniqueTournament);
      if (nextEvent) {
        tournamentId = nextEvent.tournament?.uniqueTournament?.id;
        seasonId     = nextEvent.season?.id;
        leagueName   = nextEvent.tournament?.uniqueTournament?.name || nextEvent.tournament?.name;
        seasonYear   = nextEvent.season?.year;
      }
    }

    // ⑤⑥⑦ 並列取得（順位 + 試合平均スタッツ + Wikipedia honours）
    const [stRaw, statsRaw, wikiRaw] = await Promise.all([
      tournamentId && seasonId
        ? apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`).catch(e => ({ __err: e }))
        : Promise.resolve({ __err: 'no tournamentId' }),
      tournamentId && seasonId
        ? apiGet(`/team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`).catch(e => ({ __err: e }))
        : Promise.resolve({ __err: 'no tournamentId' }),
      teamName
        ? fetchWikipediaWikitext(teamName).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false }),
    ]);

    // ⑤ 順位
    let standing = null;
    if (!stRaw.__err) {
      const rows = stRaw.standings?.[0]?.rows || [];
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

    // ⑥ 試合平均スタッツ
    let teamStats = null;
    if (!statsRaw.__err) {
      const s = statsRaw.statistics || {};
      const apps = s.matches || s.appearances || standing?.played || 0;
      const safeAvg = (total) => apps ? parseFloat((total / apps).toFixed(2)) : null;
      teamStats = {
        matches:           apps,
        avgGoalsScored:    s.goalsScored != null ? safeAvg(s.goalsScored) : null,
        avgGoalsConceded:  s.goalsConceded != null ? safeAvg(s.goalsConceded) : null,
        avgShots:          s.shots != null ? safeAvg(s.shots) : null,
        avgShotsOnTarget:  s.shotsOnTarget != null ? safeAvg(s.shotsOnTarget) : null,
        avgPossession:     s.averageBallPossession != null ? parseFloat(Number(s.averageBallPossession).toFixed(1)) : null,
        passAccuracy:      s.accuratePassesPercentage != null ? parseFloat(Number(s.accuratePassesPercentage).toFixed(1)) : null,
        avgCorners:        s.corners != null ? safeAvg(s.corners) : null,
        avgFouls:          s.fouls != null ? safeAvg(s.fouls) : null,
        avgYellows:        s.yellowCards != null ? safeAvg(s.yellowCards) : null,
        cleanSheets:       s.cleanSheets ?? null,
        bigChancesCreated: s.bigChancesCreated ?? null,
        bigChancesMissed:  s.bigChancesMissed ?? null,
        expectedGoals:     s.expectedGoals != null ? parseFloat(Number(s.expectedGoals).toFixed(2)) : null,
        avgxG:             s.expectedGoals != null && apps ? parseFloat((s.expectedGoals / apps).toFixed(2)) : null,
      };
    }

    // ⑦ Wikipedia honours 集計
    const honours = wikiRaw?.ok ? extractHonoursSection(wikiRaw.wikitext) : [];
    const _allItems = honours.flatMap(h => h.items || []);
    const _matchAny = (re) => _allItems.filter(it => re.test(it)).length;
    const trophySummary = {
      total:        _allItems.length,
      leagueTitles: _matchAny(/league|liga|premier|serie a|bundesliga|ligue 1|eredivisie|primeira/i),
      cupTitles:    _matchAny(/\bcup\b|copa|coupe|pokal|coppa/i),
      clTitles:     _matchAny(/champions league|uefa champions/i),
      uefaSuper:    _matchAny(/uefa super cup/i),
      worldClub:    _matchAny(/(fifa club world|club world cup|intercontinental)/i),
    };

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
      teamStats,         // 試合平均（avgGoals/avgPossession/passAcc 等）
      honours,           // [{ category, items }] Wikipedia 由来
      trophySummary,     // { total, leagueTitles, cupTitles, clTitles, ... }
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
