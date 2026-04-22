// scripts/modules/fetchers/sofascore_player.js
// SofaScore 非公式API で選手スタッツを取得
// VPS IPブロック時はSerperにフォールバック

const axios = require('axios');
const { fetchSerper } = require('./serper_module');
const { callAI }      = require('../../ai_client');

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

// 日本語文字（ひらがな・カタカナ・漢字）が含まれるか
function hasJapanese(str) {
  return /[\u3000-\u9fff\uff00-\uffef]/.test(str);
}

// 日本語名 → 英語名 を Claude haiku で翻訳
async function translateToEnglish(jaName) {
  try {
    const raw = await callAI({
      model:      'claude-haiku',
      max_tokens: 50,
      messages:   [{ role: 'user', content: `Soccer player name in Japanese: "${jaName}". Return only the official English name (e.g. "Kaoru Mitoma"). No explanation.` }],
    });
    return raw.trim().replace(/^["']|["']$/g, '');
  } catch { return null; }
}

// 検索クエリ候補を生成（元の名前 → 姓のみ → 翻訳名）
async function buildSearchCandidates(playerNameEn) {
  const candidates = [playerNameEn];
  // 姓のみ（スペース区切りの最後の単語）
  const parts = playerNameEn.trim().split(/\s+/);
  if (parts.length > 1) candidates.push(parts[parts.length - 1]);
  // 日本語が含まれていたら英語翻訳を追加
  if (hasJapanese(playerNameEn)) {
    const translated = await translateToEnglish(playerNameEn);
    if (translated && !candidates.includes(translated)) candidates.unshift(translated);
  }
  return [...new Set(candidates)];
}

// 選手名でSofaScore検索 → フットボール選手エンティティを返す
async function searchPlayer(playerNameEn) {
  const candidates = await buildSearchCandidates(playerNameEn);

  for (const q of candidates) {
    try {
      const data = await apiGet(`/search/all/?q=${encodeURIComponent(q)}`);
      // sport.id=1 がサッカー。sport フィールドがない場合も許容
      const players = (data.results || []).filter(r =>
        r.type === 'player' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
      );
      if (players.length) {
        console.log(`[SofaScore] "${q}" でヒット: ${players[0].entity.name}`);
        return players[0].entity;
      }
    } catch (_) {}
  }
  return null;
}

// ポジション別の特化スタッツを抽出
function buildPositionStats(position, st) {
  if (!st) return null;
  const pos = (position || '').toUpperCase();

  if (pos === 'G') {
    // GK
    return {
      saves:                   st.saves          ?? null,
      cleanSheets:             st.cleanSheet      ?? null,
      goalsConceded:           st.goalsConceded   ?? null,
      savedFromBox:            st.savedShotsFromInsideTheBox ?? null,
      goalsPrevented:          st.goalsPrevented  ?? null,
    };
  }
  if (pos === 'D') {
    // DF
    return {
      tackles:                 st.tackles         ?? null,
      interceptions:           st.interceptions   ?? null,
      clearances:              st.clearances      ?? null,
      duelsWon:                st.duelsWon        ?? null,
      aerialDuelsWon:          st.aerialDuelsWon  ?? null,
      blockedShots:            st.blockedShots    ?? null,
    };
  }
  if (pos === 'M') {
    // MF
    return {
      keyPasses:               st.keyPasses              ?? null,
      successfulDribbles:      st.successfulDribbles     ?? null,
      bigChancesCreated:       st.bigChancesCreated      ?? null,
      tackles:                 st.tackles                ?? null,
      interceptions:           st.interceptions          ?? null,
      accuratePassesPct:       st.accuratePassesPercentage ?? null,
    };
  }
  // FW / その他
  return {
    shotsOnTarget:           st.shotsOnTarget           ?? null,
    bigChancesMissed:        st.bigChancesMissed        ?? null,
    bigChancesCreated:       st.bigChancesCreated       ?? null,
    successfulDribbles:      st.successfulDribbles      ?? null,
    expectedGoals:           st.expectedGoals ? parseFloat(Number(st.expectedGoals).toFixed(2)) : null,
  };
}

// 選手の今シーズン統計を取得
async function fetchSofaScorePlayer(playerNameEn) {
  if (!playerNameEn) return { ok: false, error: '選手名が未指定' };

  try {
    // ── ① 選手検索 ────────────────────────────────────────────────────────
    const player = await searchPlayer(playerNameEn);
    if (!player) return { ok: false, error: `SofaScore に "${playerNameEn}" が見つかりません` };

    const playerId = player.id;

    // ── ② 選手詳細情報（市場価格・契約等） ─────────────────────────────────
    let playerDetail = {};
    let marketValue  = null;
    let contractUntil = null;
    try {
      const pd = await apiGet(`/player/${playerId}`);
      playerDetail  = pd.player || {};
      marketValue   = playerDetail.proposedMarketValue || null; // 例: 218000000
      contractUntil = playerDetail.contractUntilTimestamp
        ? new Date(playerDetail.contractUntilTimestamp * 1000).toISOString().slice(0, 7)
        : null;
    } catch (_) {}

    // ── ③ 直近試合の平均レーティング ─────────────────────────────────────
    let recentAvgRating = null;
    let recentMatchCount = 0;
    try {
      // 0〜3 ページを並列取得（最大40件）
      const pages = await Promise.all([0,1,2,3].map(p => apiGet(`/player/${playerId}/events/last/${p}`).catch(() => ({ events: [] }))));
      const allEvents = pages.flatMap(p => p.events || []);
      
      // 有効なレーティングを持つ最新10件を抽出
      const ratings = allEvents
        .map(e => e.playerStatistics?.rating)
        .filter(r => r != null && r > 0)
        .slice(0, 10);
      
      recentMatchCount = allEvents.length;
      recentAvgRating  = ratings.length
        ? parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2))
        : null;
    } catch (_) {}

    // ── ④ シーズン統計 (/player/{id}/statistics で全シーズン取得) ──────────
    let seasonStats = null;
    let leagueName  = null;
    let seasonYear  = null;
    let uclStats    = null;
    try {
      const statsData = await apiGet(`/player/${playerId}/statistics`);
      const allSeasons = statsData.seasons || [];
      // ① 最新年（例: "25/26"）を特定し、そのシーズンのみに絞る
      const latestYear = allSeasons[0]?.year;
      const currentSeasons = latestYear
        ? allSeasons.filter(s => s.year === latestYear)
        : allSeasons;
      // ② 国内リーグ優先でメインを決定
      const DOMESTIC_IDS  = [17, 8, 23, 35, 34, 37, 44]; // PL, LaLiga, SerieA, Bundesliga, Ligue1, Eredivisie, Süper Lig
      const UCL_IDS       = [7]; // UCL
      let preferred = null;
      for (const tid of [...DOMESTIC_IDS, ...UCL_IDS]) {
        preferred = currentSeasons.find(s => s.uniqueTournament?.id === tid);
        if (preferred) break;
      }
      preferred = preferred || currentSeasons[0] || allSeasons[0];
      // ③ UCLの成績も別途取得（国内リーグと異なる場合）
      const uclEntry = currentSeasons.find(s => UCL_IDS.includes(s.uniqueTournament?.id));
      uclStats = (uclEntry && uclEntry.uniqueTournament?.id !== preferred?.uniqueTournament?.id)
        ? {
            leagueName:  uclEntry.uniqueTournament?.name,
            appearances: uclEntry.statistics?.appearances,
            goals:       uclEntry.statistics?.goals,
            assists:     uclEntry.statistics?.assists,
            rating:      uclEntry.statistics?.rating ? parseFloat(Number(uclEntry.statistics.rating).toFixed(2)) : null,
          }
        : null;

      if (preferred) {
        leagueName  = preferred.uniqueTournament?.name;
        seasonYear  = preferred.year;
        seasonStats = preferred.statistics || null;
      }
    } catch (_) {}

    // ── ポジション別スタッツを抽出 ───────────────────────────────────────
    const position = playerDetail.position || player.position || '';
    const positionStats = buildPositionStats(position, seasonStats);

    // 市場価格を読みやすい形式に（例: 218000000 → "€218M"）
    const marketValueStr = marketValue
      ? (marketValue >= 1_000_000
          ? `€${(marketValue / 1_000_000).toFixed(0)}M`
          : `€${(marketValue / 1_000).toFixed(0)}K`)
      : null;

    return {
      ok:            true,
      playerId,
      name:          player.name,
      position,
      team:          player.team?.name || playerDetail.team?.name,
      nationality:   player.country?.name,
      dateOfBirth:   playerDetail.dateOfBirth,
      age:           playerDetail.dateOfBirthTimestamp
        ? Math.floor((Date.now() - playerDetail.dateOfBirthTimestamp * 1000) / (365.25 * 24 * 3600 * 1000))
        : null,
      height:        playerDetail.height,
      weight:        playerDetail.weight || null,
      shirtNumber:   playerDetail.jerseyNumber ?? playerDetail.shirtNumber ?? null,
      preferredFoot: playerDetail.preferredFoot,
      marketValue:   marketValueStr,
      contractUntil,
      leagueName,
      seasonYear,
      recentMatchCount,
      recentAvgRating,
      seasonStats: seasonStats ? {
        appearances:   seasonStats.appearances,
        goals:         seasonStats.goals,
        assists:       seasonStats.assists,
        rating:        seasonStats.rating ? parseFloat(Number(seasonStats.rating).toFixed(2)) : null,
        minutesPlayed: seasonStats.minutesPlayed,
        yellowCards:   seasonStats.yellowCards,
        redCards:      seasonStats.redCards,
        expectedGoals: seasonStats.expectedGoals ? parseFloat(Number(seasonStats.expectedGoals).toFixed(2)) : null,
        keyPasses:     seasonStats.keyPasses,
      } : null,
      positionStats,  // ポジション特化スタッツ
      uclStats,       // UCL成績（国内リーグと別に保持）
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
