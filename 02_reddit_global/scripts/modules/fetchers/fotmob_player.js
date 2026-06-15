// scripts/modules/fetchers/fotmob_player.js
// FotMob から選手データを取得（curl-cffi + SSR）
//   SofaScore API 403 完全ブロックの代替
//   ① searchFotMob → fotmobId
//   ② /api/playerData?id= → JSON（高速・フルデータ）
//   ③ 失敗時: player page SSR → __NEXT_DATA__（フォールバック）
//
// 返却形式: sofascore_player.js の fetchSofaScorePlayer と互換

const cheerio = require('cheerio');
const { curlGet, curlGetJson } = require('./_curl_cffi_caller');
const { searchFotMob } = require('./fotmob_career');

const FM_REFERER = 'https://www.fotmob.com/';
const FM_JSON_HEADERS = { Accept: 'application/json' };

// ── API 直接取得（速い） ──
async function _fetchPlayerAPI(fotmobId) {
  try {
    const url = `https://www.fotmob.com/api/playerData?id=${fotmobId}`;
    const data = await curlGetJson(url, { referer: FM_REFERER, headers: FM_JSON_HEADERS, timeout: 20 });
    if (data && (data.name || data.id)) return data;
    return null;
  } catch (_) { return null; }
}

// ── SSR フォールバック ──
async function _fetchPlayerSSR(fotmobId, nameSlug) {
  const url = `https://www.fotmob.com/players/${fotmobId}/${nameSlug || 'x'}`;
  const res = await curlGet(url, {
    referer: FM_REFERER,
    headers: { Accept: 'text/html' },
    timeout: 30,
  });
  if (!res.ok) return null;
  const $ = cheerio.load(res.body);
  const nd = $('#__NEXT_DATA__').html();
  if (!nd) return null;
  try { return JSON.parse(nd).props?.pageProps?.data || null; }
  catch (_) { return null; }
}

// ── 今季スタッツ抽出 ──
// FotMob playerData API は statSeasons + overviewSeasonStats を返す
// statSeasons はシーズン選択肢、overviewSeasonStats は現表示中の集計
function _extractSeasonStats(d) {
  // 方法1: overviewSeasonStats（API 取得時に含まれる）
  const overview = d.overviewSeasonStats || d.seasonStats || null;
  if (Array.isArray(overview)) {
    // [{statisticsType, fetchAllStatisticsUrl, topStatCard, stats}]
    const domesticEntry = overview.find(s =>
      !/(champions|europa|conference|cup|super)/i.test(s.tournamentName || '')
    ) || overview[0];
    if (domesticEntry) {
      return _parseStatEntry(domesticEntry, d);
    }
  }

  // 方法2: mainLeague.stats（SSR に含まれることがある）
  const ml = d.mainLeague;
  if (ml?.stats) {
    return {
      leagueName: ml.leagueName || null,
      seasonYear: ml.season || null,
      stats: _flattenStats(ml.stats),
    };
  }

  // 方法3: statSeasons から最新を探す
  const ss = d.statSeasons;
  if (Array.isArray(ss) && ss.length) {
    const latest = ss[0];
    if (latest.stats || latest.statistics) {
      return {
        leagueName: latest.tournamentName || latest.name || null,
        seasonYear: latest.seasonName || null,
        stats: _flattenStats(latest.stats || latest.statistics),
      };
    }
  }

  return null;
}

function _parseStatEntry(entry, d) {
  const stats = {};
  // topStatCard: [{title, value, ...}]
  if (Array.isArray(entry.topStatCard)) {
    for (const s of entry.topStatCard) {
      const key = _statKeyMap(s.title || s.statKey || '');
      if (key) stats[key] = _toNum(s.value ?? s.statValue);
    }
  }
  // stats: [{title, stats: [{title, value}]}] or flat
  if (Array.isArray(entry.stats)) {
    for (const group of entry.stats) {
      if (Array.isArray(group.stats)) {
        for (const s of group.stats) {
          const key = _statKeyMap(s.title || s.key || '');
          if (key) stats[key] = _toNum(s.value ?? s.stat?.value);
        }
      } else {
        const key = _statKeyMap(group.title || group.key || '');
        if (key) stats[key] = _toNum(group.value ?? group.stat?.value);
      }
    }
  }
  return {
    leagueName: entry.tournamentName || d.mainLeague?.leagueName || null,
    seasonYear: entry.seasonName || d.mainLeague?.season || null,
    stats,
  };
}

function _flattenStats(statsObj) {
  if (!statsObj) return {};
  if (Array.isArray(statsObj)) {
    const out = {};
    for (const item of statsObj) {
      const key = _statKeyMap(item.title || item.key || item.name || '');
      if (key) out[key] = _toNum(item.value ?? item.stat?.value);
    }
    return out;
  }
  if (typeof statsObj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(statsObj)) {
      const key = _statKeyMap(k);
      if (key && v != null) out[key] = _toNum(v);
    }
    return out;
  }
  return {};
}

const _STAT_KEY_REMAP = {
  goals: 'goals', goal: 'goals',
  assists: 'assists', assist: 'assists',
  appearances: 'appearances', 'matches played': 'appearances', 'games played': 'appearances',
  rating: 'rating', 'fotmob rating': 'rating', 'avg rating': 'rating',
  'minutes played': 'minutesPlayed', minutes: 'minutesPlayed',
  'yellow cards': 'yellowCards',
  'red cards': 'redCards',
  'expected goals': 'expectedGoals', xg: 'expectedGoals',
  'expected assists': 'expectedAssists', xa: 'expectedAssists',
  'shots on target': 'shotsOnTarget',
  'total shots': 'totalShots', shots: 'totalShots',
  'key passes': 'keyPasses',
  'big chances created': 'bigChancesCreated',
  'successful dribbles': 'successfulDribbles', dribbles: 'successfulDribbles',
  tackles: 'tackles',
  interceptions: 'interceptions',
  'clean sheets': 'cleanSheets',
  saves: 'saves',
  'accurate passes': 'accuratePasses',
  'pass accuracy': 'accuratePassesPct',
  'chances created': 'bigChancesCreated',
};
function _statKeyMap(rawKey) {
  const k = String(rawKey || '').toLowerCase().trim();
  return _STAT_KEY_REMAP[k] || null;
}

function _toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,%]/g, '').trim();
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// ── 直近試合抽出 ──
function _extractRecentMatches(d) {
  // recentMatches / lastXMatches / matchesOverview
  const raw = d.recentMatches || d.lastXMatches || d.matchesOverview?.matches || [];
  if (!Array.isArray(raw) || !raw.length) return [];
  return raw.slice(0, 5).map(m => ({
    date: m.matchDate?.utcTime?.slice(0, 10) || m.date || null,
    tournament: m.leagueName || m.tournament?.name || null,
    opponent: m.opponentTeamName || m.opponent?.name || null,
    score: m.score || (m.homeScore != null ? `${m.homeScore}-${m.awayScore}` : null),
    rating: _toNum(m.rating?.num ?? m.playerRating),
    goals: _toNum(m.goals),
    assists: _toNum(m.assists),
    minutesPlayed: _toNum(m.minutesPlayed),
  })).filter(m => m.date || m.opponent);
}

// ── メイン ──
async function fetchFotMobPlayer(playerName) {
  if (!playerName) return { ok: false, error: '選手名が未指定' };

  try {
    // ① 検索
    const hit = await searchFotMob(playerName);
    if (!hit?.id) return { ok: false, error: `FotMob: "${playerName}" が見つかりません` };

    // ② API 直接 → SSR フォールバック
    let d = await _fetchPlayerAPI(hit.id);
    let source = 'fotmob-api';
    if (!d) {
      const slug = String(playerName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      d = await _fetchPlayerSSR(hit.id, slug);
      source = 'fotmob-ssr';
    }
    if (!d) return { ok: false, error: `FotMob: ${playerName} データ取得失敗` };

    // デバッグ: トップレベルキーをログ
    console.log(`[FotMob Player] ${playerName} source=${source} keys=[${Object.keys(d).join(',')}]`);

    // 基本情報
    const name = d.name || playerName;
    const teamName = d.primaryTeam?.teamName || d.teamName || null;
    const teamId = d.primaryTeam?.teamId || null;
    const leagueName = d.mainLeague?.leagueName || null;

    // 年齢
    let age = null;
    if (d.birthDate?.utcTime) {
      age = Math.floor((Date.now() - new Date(d.birthDate.utcTime)) / (365.25 * 24 * 3600 * 1000));
    }

    // ポジション
    const posDesc = d.positionDescription;
    const position = posDesc?.primaryPosition?.label
      || posDesc?.positions?.[0]?.strPos?.label
      || posDesc?.positions?.[0]?.strPosSh?.label
      || null;

    // 国籍
    const nationality = d.playerInformation?.find(i =>
      /country|nationality/i.test(i.title || i.key || '')
    )?.value?.fallback || d.country?.name || null;

    // 市場価値
    let marketValue = null;
    const mv = d.marketValue || d.marketValues;
    if (mv) {
      const val = mv.current?.value || mv.value || (Array.isArray(mv) ? mv[mv.length - 1]?.value : null);
      const curr = mv.current?.currency || mv.currency || '€';
      if (val) {
        marketValue = val >= 1_000_000
          ? `${curr}${(val / 1_000_000).toFixed(0)}M`
          : `${curr}${(val / 1_000).toFixed(0)}K`;
      }
    }

    // 今季スタッツ
    const seasonData = _extractSeasonStats(d);
    const seasonStats = seasonData?.stats || null;

    // 直近試合
    const last5Matches = _extractRecentMatches(d);
    const recentAvgRating = (() => {
      const ratings = last5Matches.map(m => m.rating).filter(r => r != null && r > 0);
      if (!ratings.length) return null;
      return parseFloat((ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(2));
    })();

    // キャリア情報（fotmob_career.js と同じ構造）
    const ch = d.careerHistory?.careerItems || {};
    const playerCareer = (ch.senior?.teamEntries || []).map(e => ({
      team: e.team, teamId: e.teamId,
      startDate: (e.startDate || '').slice(0, 10),
      endDate: e.endDate ? e.endDate.slice(0, 10) : null,
      current: !e.endDate,
      appearances: _toNum(e.appearances),
      goals: _toNum(e.goals),
      assists: _toNum(e.assists),
    }));
    const currentClub = playerCareer.find(e => e.current) || playerCareer[0];

    // 代表チーム（FotMob のキャリアに national team entries がある場合）
    const ntEntries = ch.nationalTeam?.teamEntries || ch.national?.teamEntries || [];
    let nationalTeam = null;
    if (ntEntries.length) {
      const total = ntEntries.reduce((a, e) => ({
        appearances: (a.appearances || 0) + (_toNum(e.appearances) || 0),
        goals: (a.goals || 0) + (_toNum(e.goals) || 0),
        assists: (a.assists || 0) + (_toNum(e.assists) || 0),
      }), {});
      nationalTeam = { teamName: ntEntries[0]?.team || null, total };
    }

    // 顔写真URL
    const photo = `https://images.fotmob.com/image_resources/playerimages/${hit.id}.png`;

    const result = {
      ok: true,
      playerId: hit.id,
      name,
      position,
      team: teamName,
      teamId,
      nationality,
      age,
      marketValue,
      leagueName: seasonData?.leagueName || leagueName,
      seasonYear: seasonData?.seasonYear || null,
      seasonStats: seasonStats ? {
        appearances: seasonStats.appearances ?? null,
        goals: seasonStats.goals ?? null,
        assists: seasonStats.assists ?? null,
        rating: seasonStats.rating ? parseFloat(Number(seasonStats.rating).toFixed(2)) : null,
        minutesPlayed: seasonStats.minutesPlayed ?? null,
        yellowCards: seasonStats.yellowCards ?? null,
        redCards: seasonStats.redCards ?? null,
        expectedGoals: seasonStats.expectedGoals ? parseFloat(Number(seasonStats.expectedGoals).toFixed(2)) : null,
        keyPasses: seasonStats.keyPasses ?? null,
        bigChancesCreated: seasonStats.bigChancesCreated ?? null,
        successfulDribbles: seasonStats.successfulDribbles ?? null,
        totalShots: seasonStats.totalShots ?? null,
        shotsOnTarget: seasonStats.shotsOnTarget ?? null,
        accuratePassesPct: seasonStats.accuratePassesPct ?? null,
        tackles: seasonStats.tackles ?? null,
        interceptions: seasonStats.interceptions ?? null,
        cleanSheets: seasonStats.cleanSheets ?? null,
        saves: seasonStats.saves ?? null,
      } : null,
      recentAvgRating,
      last5Matches,
      nationalTeam,
      currentClub: currentClub ? {
        team: currentClub.team,
        appearances: currentClub.appearances,
        goals: currentClub.goals,
        assists: currentClub.assists,
      } : null,
      playerCareer,
      photo,
      _source: source,
    };

    const ss = result.seasonStats;
    console.log(`[FotMob Player] ${name} (${teamName}) | ${seasonData?.leagueName || '?'} G:${ss?.goals ?? '?'} A:${ss?.assists ?? '?'} R:${ss?.rating ?? '?'} | career@${currentClub?.team}: ${currentClub?.appearances ?? '?'}apps`);

    return result;
  } catch (e) {
    return { ok: false, error: `FotMob: ${e.message}` };
  }
}

module.exports = { fetchFotMobPlayer };
