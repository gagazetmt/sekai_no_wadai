// scripts/modules/fetchers/sofascore_manager.js
// SofaScore から監督情報を取得（3 API call）+ Wikipedia honours
//  ① /search/all/               → managerId
//  ② /manager/{id}              → 基本情報・経歴・通算成績
//  ③ /manager/{id}/events/last/0 → 直近5試合
//  ④ Wikipedia (並列) → 主要トロフィー履歴

const { apiGet } = require('./_sofa_common');
const { fetchWikipediaWikitext, extractHonoursSection } = require('./wikipedia');

async function findManagerId(managerName) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(managerName)}`);
  const managers = (data.results || []).filter(r => r.type === 'manager');
  if (managers.length) return managers[0].entity?.id;

  // フォールバック: チームから逆引き（上位3件）
  const teams = (data.results || []).filter(r => r.type === 'team');
  for (const t of teams.slice(0, 3)) {
    try {
      const td = await apiGet(`/team/${t.entity.id}`);
      if (td.team?.manager?.name?.toLowerCase().includes(managerName.toLowerCase())) {
        return td.team.manager.id;
      }
    } catch (_) {}
  }
  return null;
}

// 1試合を扱いやすい形に整形（監督視点 = 現チームが勝敗どっちだったか判定は難しいので中立表示）
function formatManagerMatch(e) {
  const homeScore = e.homeScore?.display ?? e.homeScore?.normaltime ?? null;
  const awayScore = e.awayScore?.display ?? e.awayScore?.normaltime ?? null;
  return {
    date:       e.startTimestamp ? new Date(e.startTimestamp * 1000).toISOString().slice(0, 10) : null,
    tournament: e.tournament?.name || null,
    homeTeam:   e.homeTeam?.name,
    awayTeam:   e.awayTeam?.name,
    score:      `${homeScore ?? '?'}-${awayScore ?? '?'}`,
    winnerCode: e.winnerCode, // 1=home勝ち 2=away勝ち 3=引き分け
  };
}

async function fetchSofaScoreManager(managerName, managerId = null) {
  if (!managerName && !managerId) return { ok: false, error: '監督名またはIDが必要です' };

  try {
    // ① ID解決
    const id = managerId || await findManagerId(managerName);
    if (!id) return { ok: false, error: `"${managerName}" の監督IDが見つかりません` };

    // ②③ 並列取得（manager info + events last）────────
    const [data, evRaw, wikiRaw] = await Promise.all([
      apiGet(`/manager/${id}`),
      apiGet(`/manager/${id}/events/last/0`).catch(e => ({ __err: e })),
      managerName
        ? fetchWikipediaWikitext(managerName).catch(() => ({ ok: false }))
        : Promise.resolve({ ok: false }),
    ]);
    const m = data.manager || {};

    // 経歴整形（新しい順）+ tenure 別 W/D/L (SofaScore で取れる場合)
    const career = (m.teams || []).map(t => {
      const st = t.statistics || {};
      const tenureWins   = st.wins   ?? null;
      const tenureDraws  = st.draws  ?? null;
      const tenureLosses = st.losses ?? null;
      const tenureTotal  = (tenureWins != null || tenureDraws != null || tenureLosses != null)
        ? (tenureWins || 0) + (tenureDraws || 0) + (tenureLosses || 0)
        : null;
      return {
        club:     t.name,
        teamId:   t.id,
        from:     t.inTeamFrom  ? new Date(t.inTeamFrom  * 1000).toISOString().slice(0, 7) : null,
        to:       t.inTeamUntil ? new Date(t.inTeamUntil * 1000).toISOString().slice(0, 7) : null,
        current:  !t.inTeamUntil,
        wins:     tenureWins,
        draws:    tenureDraws,
        losses:   tenureLosses,
        total:    tenureTotal,
        winRate:  tenureTotal ? parseFloat(((tenureWins / tenureTotal) * 100).toFixed(1)) : null,
      };
    });
    const currentTeam = career.find(c => c.current) || career[0] || null;

    // 通算成績 + 1試合平均
    const perf = m.performance || {};
    const winRate = perf.total
      ? parseFloat(((perf.wins / perf.total) * 100).toFixed(1))
      : null;
    const goalsPerGame    = perf.total ? parseFloat((perf.goalsScored   / perf.total).toFixed(2)) : null;
    const concededPerGame = perf.total ? parseFloat((perf.goalsConceded / perf.total).toFixed(2)) : null;
    const pointsPerGame   = perf.total
      ? parseFloat((((perf.wins * 3) + perf.draws) / perf.total).toFixed(2))
      : null;

    // Wikipedia honours 抽出 + 集計
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

    // 年齢計算
    const age = m.dateOfBirthTimestamp
      ? Math.floor((Date.now() - m.dateOfBirthTimestamp * 1000) / (365.25 * 24 * 3600 * 1000))
      : null;

    // ③ 直近試合（並列取得済みを処理）
    let last5Matches = [];
    let currentTeamStats = null;
    if (!evRaw?.__err) {
      const events = (evRaw.events || []).filter(e => e.status?.type === 'finished');
      last5Matches = events.slice(0, 5).map(formatManagerMatch);

      // 現チームの直近成績を集計（最大10件）
      if (currentTeam?.teamId) {
        const currentEvents = events.filter(e =>
          e.homeTeam?.id === currentTeam.teamId || e.awayTeam?.id === currentTeam.teamId
        ).slice(0, 10);
        let w = 0, d = 0, l = 0;
        currentEvents.forEach(e => {
          const isHome = e.homeTeam?.id === currentTeam.teamId;
          if (e.winnerCode === 3) d++;
          else if ((isHome && e.winnerCode === 1) || (!isHome && e.winnerCode === 2)) w++;
          else l++;
        });
        if (currentEvents.length) {
          currentTeamStats = {
            club:    currentTeam.club,
            sample:  currentEvents.length,
            wins:    w,
            draws:   d,
            losses:  l,
            winRate: parseFloat(((w / currentEvents.length) * 100).toFixed(1)),
          };
        }
      }
    }

    return {
      ok:                 true,
      managerId:          id,
      name:               m.name,
      nationality:        m.nationality,
      age,
      preferredFormation: m.preferredFormation || null,
      currentTeam:        currentTeam ? currentTeam.club : null,
      currentTeamSince:   currentTeam?.from || null,
      career,
      overallPerformance: perf.total ? {
        total:           perf.total,
        wins:            perf.wins,
        draws:           perf.draws,
        losses:          perf.losses,
        winRate,
        goalsScored:     perf.goalsScored,
        goalsConceded:   perf.goalsConceded,
        goalsPerGame,
        concededPerGame,
        pointsPerGame,
      } : null,
      currentTeamStats,
      last5Matches,
      honours,           // [{ category, items: [...] }]  Wikipedia 由来
      trophySummary,     // { total, leagueTitles, cupTitles, clTitles, uefaSuper, worldClub }
    };
  } catch (e) {
    if (e.response?.status === 403) {
      return { ok: false, error: 'SofaScore: IPブロック(403)。プロキシ設定が必要です' };
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreManager, findManagerId };
