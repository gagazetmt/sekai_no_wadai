// scripts/modules/fetchers/sofascore_player.js
// SofaScore 非公式API で選手スタッツを取得
// VPS IPブロック時はSerperにフォールバック

const axios = require('axios');
const { fetchSerper } = require('./serper_module');

const BASE_URL = 'https://api.sofascore.com/api/v1';
const HEADERS  = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://www.sofascore.com/',
  'Origin':          'https://www.sofascore.com',
};

async function apiGet(endpoint) {
  const res = await axios.get(`${BASE_URL}${endpoint}`, { headers: HEADERS, timeout: 12000 });
  return res.data;
}

// 選手名でSofaScore検索 → プレーヤーエンティティを返す
async function searchPlayer(playerNameEn) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(playerNameEn)}`);
  const players = (data.results || []).filter(r => r.type === 'player');
  if (!players.length) return null;

  // スコアが最高のものを選ぶ（通常1番目）
  return players[0].entity;
}

// 選手の今シーズン統計を取得
async function fetchSofaScorePlayer(playerNameEn) {
  if (!playerNameEn) return { ok: false, error: '選手名が未指定' };

  try {
    // ── ① 選手検索 ────────────────────────────────────────────────────────
    const player = await searchPlayer(playerNameEn);
    if (!player) return { ok: false, error: `SofaScore に "${playerNameEn}" が見つかりません` };

    const playerId = player.id;

    // ── ② 選手詳細情報 ───────────────────────────────────────────────────
    let playerDetail = {};
    try {
      const pd = await apiGet(`/player/${playerId}`);
      playerDetail = pd.player || {};
    } catch (_) {}

    // ── ③ 直近試合の平均レーティング ─────────────────────────────────────
    let recentAvgRating = null;
    let recentMatchCount = 0;
    try {
      const eventsData = await apiGet(`/player/${playerId}/events/last/0`);
      const events = (eventsData.events || []).slice(0, 10);
      const ratings = events
        .map(e => e.playerStatistics?.rating)
        .filter(r => r != null && r > 0);
      recentMatchCount = events.length;
      recentAvgRating  = ratings.length
        ? parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
        : null;
    } catch (_) {}

    // ── ④ シーズン統計 ───────────────────────────────────────────────────
    let seasonStats = null;
    let leagueName  = null;
    try {
      const seasonsData = await apiGet(`/player/${playerId}/statistics/seasons`);
      const allSeasons  = seasonsData.uniqueTournamentSeasons || [];
      // 主要リーグのシーズンを優先（UCL/PL/LaLiga等のid判定）
      const MAJOR_TOURNAMENT_IDS = [17, 8, 23, 35, 34, 7]; // PL, LaLiga, SerieA, Bundesliga, Ligue1, UCL
      const preferred = allSeasons.find(s =>
        MAJOR_TOURNAMENT_IDS.includes(s.uniqueTournament?.id)
      ) || allSeasons[0];

      if (preferred) {
        leagueName = preferred.uniqueTournament?.name;
        const tid  = preferred.uniqueTournament.id;
        const sid  = preferred.seasons?.[0]?.id;
        if (tid && sid) {
          const statsData = await apiGet(`/player/${playerId}/unique-statistics/season/${sid}/unique-tournament/${tid}`);
          seasonStats = statsData.statistics || null;
        }
      }
    } catch (_) {}

    return {
      ok:            true,
      playerId,
      name:          player.name,
      position:      playerDetail.position || player.position,
      team:          player.team?.name || playerDetail.team?.name,
      nationality:   player.country?.name,
      dateOfBirth:   playerDetail.dateOfBirth,
      height:        playerDetail.height,
      preferredFoot: playerDetail.preferredFoot,
      leagueName,
      recentMatchCount,
      recentAvgRating,
      seasonStats: seasonStats ? {
        appearances: seasonStats.appearances,
        goals:       seasonStats.goals,
        assists:     seasonStats.assists,
        rating:      seasonStats.rating ? parseFloat(seasonStats.rating.toFixed(2)) : null,
        minutesPlayed: seasonStats.minutesPlayed,
        yellowCards:   seasonStats.yellowCards,
        redCards:      seasonStats.redCards,
      } : null,
    };
  } catch (e) {
    // 403 = VPS IPブロック → Serperにフォールバック
    if (e.response?.status === 403 || e.message?.includes('403')) {
      return await fetchPlayerStatsViaSerper(playerNameEn);
    }
    return { ok: false, error: e.message };
  }
}

// SofaScore 403時のSerperフォールバック
async function fetchPlayerStatsViaSerper(playerNameEn) {
  try {
    const [statsRes, profileRes] = await Promise.all([
      fetchSerper(`${playerNameEn} 2025-26 season stats goals assists appearances`, 'sofascore_fallback'),
      fetchSerper(`${playerNameEn} footballer profile age nationality position club`, 'sofascore_fallback'),
    ]);

    const snippets = [
      ...(statsRes.organic   || []).slice(0, 3).map(r => `[Stats] ${r.title}: ${r.snippet}`),
      ...(profileRes.organic || []).slice(0, 2).map(r => `[Profile] ${r.title}: ${r.snippet}`),
      statsRes.answerBox?.snippet   ? `[Answer] ${statsRes.answerBox.snippet}`   : null,
      profileRes.answerBox?.snippet ? `[Answer] ${profileRes.answerBox.snippet}` : null,
    ].filter(Boolean);

    return {
      ok:           snippets.length > 0,
      source:       'serper_fallback',
      playerNameEn,
      summary:      snippets.join('\n'),
      // SofaScore形式のフィールドは null（シナリオ生成側でsummaryを使う）
      seasonStats:  null,
      recentAvgRating: null,
    };
  } catch (e) {
    return { ok: false, error: `SofaScore 403 + Serper fallback失敗: ${e.message}` };
  }
}

module.exports = { fetchSofaScorePlayer, searchPlayer, fetchPlayerStatsViaSerper };
