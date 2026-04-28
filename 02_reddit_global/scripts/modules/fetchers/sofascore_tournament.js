// scripts/modules/fetchers/sofascore_tournament.js
// SofaScore からリーグ大会データを取得（4 API call）
//   ① /search/all/                                                            → uniqueTournamentId
//   ② /unique-tournament/{t}/seasons                                          → 現行 seasonId
//   ③ /unique-tournament/{t}/season/{s}/standings/total                       → 全順位表
//   ④ /unique-tournament/{t}/season/{s}/top-players/overall                   → 得点王・アシスト王 等

const { apiGet } = require('./_sofa_common');

// ─── ① 大会検索（"LaLiga", "Premier League", "Serie A" 等）─────────
async function searchTournament(name) {
  try {
    const data = await apiGet(`/search/all/?q=${encodeURIComponent(name)}`);
    const items = (data.results || []).filter(r =>
      r.type === 'uniqueTournament' && (r.entity?.category?.sport?.id === 1 || !r.entity?.category)
    );
    if (!items.length) return null;
    // 完全一致を優先、なければ最初
    const lowerName = String(name).toLowerCase().trim();
    const exact = items.find(r => (r.entity?.name || '').toLowerCase() === lowerName);
    return (exact || items[0]).entity;
  } catch (_) { return null; }
}

// ─── ② 現行シーズン取得 ────────────────────────────────────────
async function getCurrentSeason(tournamentId) {
  try {
    const data = await apiGet(`/unique-tournament/${tournamentId}/seasons`);
    const seasons = data.seasons || [];
    if (!seasons.length) return null;
    return seasons[0];  // SofaScore は最新シーズンが先頭
  } catch (_) { return null; }
}

// ─── ヘルパ ────────────────────────────────────────────────
function _diff(row) {
  const gf = row.scoresFor ?? 0;
  const ga = row.scoresAgainst ?? 0;
  return gf - ga;
}

function _formatStandingRow(row) {
  return {
    position:  row.position,
    teamId:    row.team?.id,
    teamName:  row.team?.name || row.team?.shortName,
    played:    row.matches,
    wins:      row.wins,
    draws:     row.draws,
    losses:    row.losses,
    goalsFor:  row.scoresFor,
    goalsAgainst: row.scoresAgainst,
    goalDiff:  _diff(row),
    points:    row.points,
  };
}

function _formatTopPlayer(p) {
  // SofaScore top-players response の statistics は selector別に nest される
  // 共通: team.name / player.name / statistics.value（または goals/assists 等）
  return {
    name:       p.player?.name,
    teamName:   p.team?.name || p.team?.shortName,
    rating:     p.statistics?.rating,
    appearances: p.statistics?.appearances,
    minutesPlayed: p.statistics?.minutesPlayed,
    goals:      p.statistics?.goals,
    assists:    p.statistics?.assists,
    expectedGoals: p.statistics?.expectedGoals,
  };
}

// ─── メイン ────────────────────────────────────────────────
async function fetchSofaScoreTournament(tournamentName) {
  if (!tournamentName) return { ok: false, error: '大会名が必要です' };

  try {
    // ① 大会検索
    const t = await searchTournament(tournamentName);
    if (!t) return { ok: false, error: `SofaScore に大会 "${tournamentName}" が見つかりません` };
    const tournamentId = t.id;

    // ② シーズン解決
    const season = await getCurrentSeason(tournamentId);
    if (!season) return { ok: false, error: `${tournamentName} のシーズン情報が無い` };
    const seasonId = season.id;
    const seasonYear = season.year || season.name;

    // ③④ 並列取得（順位表 + 得点王ランキング）
    const [stRaw, tpRaw] = await Promise.all([
      apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/standings/total`).catch(e => ({ __err: e })),
      apiGet(`/unique-tournament/${tournamentId}/season/${seasonId}/top-players/overall`).catch(e => ({ __err: e })),
    ]);

    // ③ 全順位表（1〜N位）
    let standings = [];
    if (!stRaw?.__err) {
      const rows = stRaw.standings?.[0]?.rows || [];
      standings = rows.map(_formatStandingRow);
    }
    if (!standings.length) {
      return { ok: false, error: `順位表が取れませんでした (t=${tournamentId} s=${seasonId})` };
    }

    // ④ 得点王・アシスト王・評定上位（上位5人ずつ）
    let topScorers = [];
    let topAssists = [];
    let topRated   = [];
    if (!tpRaw?.__err) {
      const tp = tpRaw.topPlayers || {};
      topScorers = (tp.goals       || []).slice(0, 5).map(_formatTopPlayer);
      topAssists = (tp.assists     || []).slice(0, 5).map(_formatTopPlayer);
      topRated   = (tp.rating      || []).slice(0, 5).map(_formatTopPlayer);
    }

    // 派生指標：優勝争い・CL圏争い・残留争いの自動グループ化
    const titleRace      = standings.slice(0, 3);   // 1〜3位
    const clRace         = standings.slice(3, 7);   // 4〜7位（CL圏ボーダー）
    const relegationRace = standings.slice(-4);     // 下位4チーム

    return {
      ok:           true,
      name:         t.name,
      tournamentId,
      seasonId,
      seasonYear,
      country:      t.category?.country?.name || null,
      standings,           // 全順位
      titleRace,           // 1〜3位
      clRace,              // 4〜7位
      relegationRace,      // 下位4
      topScorers,
      topAssists,
      topRated,
      fetchedAt:    new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { fetchSofaScoreTournament, searchTournament };
