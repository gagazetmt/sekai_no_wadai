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

    // ③ 直近試合（last5 + 全 events も保持して集計に使う）
    let last5 = [];
    let recentForm = null;  // "WWLDD" 形式（新しい順）
    let allRecentMatches = [];  // 30試合分（代表チーム集計用）
    if (!evRaw?.__err) {
      const finished = (evRaw.events || []).filter(e => e.status?.type === 'finished').reverse();
      last5 = finished.slice(-5).reverse().map(e => formatTeamMatch(e, teamId));
      recentForm = last5.map(m => m.result).join('');
      // 全試合を保持（最大30程度、新しい順）→ 集計関数で使う
      allRecentMatches = finished.slice(-30).reverse().map(e => formatTeamMatch(e, teamId));
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

    // ⑤⑥⑦⑧⑨ 並列取得（順位 + 試合平均 + wiki + トップ選手 + 監督経歴）
    const [stRaw, statsRaw, wikiRaw, topRaw, mgrCareerRaw] = await Promise.all([
      tournamentId && seasonId
        ? apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`).catch(e => ({ __err: e }))
        : Promise.resolve({ __err: 'no tournamentId' }),
      tournamentId && seasonId
        ? apiGet(`/team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/statistics/overall`).catch(e => ({ __err: e }))
        : Promise.resolve({ __err: 'no tournamentId' }),
      teamName
        ? fetchWikipediaWikitext(teamName).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false }),
      tournamentId && seasonId
        ? apiGet(`/team/${teamId}/unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`).catch(e => ({ __err: e }))
        : Promise.resolve({ __err: 'no tournamentId' }),
      // 現監督の career-history → このチームでの通算成績抽出に使う
      managerId
        ? apiGet(`/manager/${managerId}/career-history`).catch(e => ({ __err: e }))
        : Promise.resolve({ __err: 'no managerId' }),
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

    // 各 item から「優勝回数」を抽出する。
    //   形式例:
    //     "UEFA Champions League: 6 (1973–74, ...)"   → 6
    //     "European Cup / UEFA Champions League: 6"   → 6
    //     "FA Cup: 14"                                → 14
    //     "Premier League (1)"                        → 1
    //   括弧内の年カウントもフォールバックで使う
    const _countTitles = (item) => {
      const colonM = item.match(/:\s*(\d{1,2})\b/);
      if (colonM) return parseInt(colonM[1], 10);
      const parenM = item.match(/\((\d{1,2})\)/);
      if (parenM) return parseInt(parenM[1], 10);
      // 括弧内の年(YYYY)の数で代用
      const years = (item.match(/\b(19|20)\d{2}\b/g) || []).length;
      return years || 1;
    };
    const _sumTitles = (re) =>
      _allItems.filter(it => re.test(it)).reduce((s, it) => s + _countTitles(it), 0);

    const trophySummary = {
      total:        _allItems.reduce((s, it) => s + _countTitles(it), 0),
      leagueTitles: _sumTitles(/league|liga|premier|serie a|bundesliga|ligue 1|eredivisie|primeira/i),
      cupTitles:    _sumTitles(/\bcup\b|copa|coupe|pokal|coppa/i) - _sumTitles(/(european cup|cup winners|champions league|uefa cup|super cup|world cup|intercontinental)/i),
      // European Cup（1955-1992 旧称）と UEFA Champions League を両方カウント。"Cup Winners' Cup" は除外
      clTitles:     _sumTitles(/(?:european cup(?!\s*winners)|uefa champions|champions league)/i),
      uefaSuper:    _sumTitles(/uefa super cup/i),
      uefaCup:      _sumTitles(/uefa cup\b|europa league/i),
      cupWinners:   _sumTitles(/cup winners(?:'|s)?\s*cup/i),
      worldClub:    _sumTitles(/(fifa club world|club world cup|intercontinental)/i),
    };

    // ⑧ チーム内トップ選手（得点・アシスト・評価点 各TOP3）
    let topPlayers = null;
    if (!topRaw.__err) {
      const tp = topRaw.topPlayers || {};
      const _pick = (arr, statKey) => (arr || []).slice(0, 3).map(x => ({
        name:       x.player?.name,
        playerId:   x.player?.id,
        position:   x.player?.position,
        appearances: x.statistics?.appearances ?? null,
        value:      x.statistics?.[statKey] ?? null,
      }));
      topPlayers = {
        goals:      _pick(tp.goals,           'goals'),
        assists:    _pick(tp.assists,         'assists'),
        rating:     _pick(tp.rating,          'rating'),
      };
    }

    // ⑨ 現監督の在任成績（manager career-history からこのチームのエントリを抽出）
    let currentManagerStats = null;
    if (!mgrCareerRaw.__err) {
      const hist = mgrCareerRaw.careerHistory || [];
      const myStint = hist.find(h => h.team?.id === teamId);
      if (myStint) {
        const p = myStint.performance || {};
        const since = myStint.startTimestamp
          ? new Date(myStint.startTimestamp * 1000).toISOString().slice(0, 10)
          : null;
        const total = (p.wins || 0) + (p.draws || 0) + (p.losses || 0);
        currentManagerStats = {
          name:    managerName,
          since,
          total:   p.total ?? total,
          wins:    p.wins   ?? 0,
          draws:   p.draws  ?? 0,
          losses:  p.losses ?? 0,
          points:  p.totalPoints ?? null,
          winRate: total ? Math.round(((p.wins || 0) / total) * 100) : null,
        };
      }
    }

    // ⑩ 試合集計（代表チーム向け：年別 / 大会別 / 直近W杯）
    //   allRecentMatches を使って動画題材になりそうなサマリを計算
    const _aggregate = (matches) => {
      const total = matches.length;
      const wins = matches.filter(m => m.result === 'W').length;
      const draws = matches.filter(m => m.result === 'D').length;
      const losses = matches.filter(m => m.result === 'L').length;
      // ゴール集計（score "2-1" → 自チーム2 / 相手1）
      let goalsFor = 0, goalsAgainst = 0;
      matches.forEach(m => {
        const [a, b] = (m.score || '').split('-').map(s => parseInt(s.trim(), 10));
        if (Number.isFinite(a)) goalsFor += a;
        if (Number.isFinite(b)) goalsAgainst += b;
      });
      return { total, wins, draws, losses, goalsFor, goalsAgainst };
    };

    const currentYear = new Date().getFullYear();
    const thisYearMatches  = allRecentMatches.filter(m =>
      (m.date || '').startsWith(String(currentYear)));
    const lastYearMatches  = allRecentMatches.filter(m =>
      (m.date || '').startsWith(String(currentYear - 1)));
    const wcMatches        = allRecentMatches.filter(m =>
      /FIFA World Cup(?!.*Qual)/i.test(m.tournament || ''));
    const wcQualMatches    = allRecentMatches.filter(m =>
      /World Cup.*Qual/i.test(m.tournament || ''));

    const seasonAggregate = {
      thisYear:  _aggregate(thisYearMatches),
      lastYear:  _aggregate(lastYearMatches),
      worldCup:  _aggregate(wcMatches),
      wcQual:    _aggregate(wcQualMatches),
      // 大会別ブレイクダウン（最大8大会まで保持）
      byTournament: (() => {
        const groups = {};
        allRecentMatches.forEach(m => {
          const t = m.tournament || '?';
          (groups[t] = groups[t] || []).push(m);
        });
        return Object.entries(groups)
          .map(([name, ms]) => ({ name, ..._aggregate(ms) }))
          .sort((a, b) => b.total - a.total)
          .slice(0, 8);
      })(),
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
      topPlayers,        // { goals: [...3], assists: [...3], rating: [...3] }
      last5,
      recentForm,        // "WWLDD" 直近5試合フォーム（新しい順）
      currentManagerStats,  // { name, since, total, wins, draws, losses, points, winRate }
      seasonAggregate,      // { thisYear, lastYear, worldCup, wcQual, byTournament }
    };
  } catch (e) {
    if (e.response?.status === 403) {
      return { ok: false, error: 'SofaScore: IPブロック(403)。プロキシ設定が必要です' };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreTeam, searchTeam };
