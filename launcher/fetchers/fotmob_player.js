// scripts/modules/fetchers/fotmob_player.js
// FotMob から選手データを取得（curl-cffi + SSR __NEXT_DATA__）
//   旧 /api/playerData?id= は 2026-06 に廃止。SSR が唯一のデータソース
//
// 返却形式: sofascore_player.js の fetchSofaScorePlayer と互換

const cheerio = require('cheerio');
const { curlGet } = require('./_curl_cffi_caller');
const { searchFotMob } = require('./fotmob_career');

const FM_REFERER = 'https://www.fotmob.com/';

// ── SSR ページから __NEXT_DATA__ を抽出 ──
async function _fetchPlayerData(fotmobId, nameSlug) {
  const url = `https://www.fotmob.com/players/${fotmobId}/${nameSlug || 'overview'}`;
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
// SSR __NEXT_DATA__ は firstSeasonStats（表示中シーズン）を返す
// statSeasons はシーズン選択肢のみ（スタッツ値なし）
function _extractSeasonStats(d) {
  // 方法1: firstSeasonStats.statsSection（SSR 2026年〜の構造）
  const fss = d.firstSeasonStats;
  if (fss?.statsSection) {
    const stats = {};
    const section = fss.statsSection;
    const groups = section.items || section.stats || (Array.isArray(section) ? section : []);
    for (const group of groups) {
      const items = group.items || [];
      for (const s of items) {
        const key = _statKeyMap(s.title || s.localizedTitleId || '');
        if (key) stats[key] = _toNum(s.statValue ?? s.value);
      }
    }
    if (Array.isArray(fss.topStatCard)) {
      for (const s of fss.topStatCard) {
        const key = _statKeyMap(s.title || s.statKey || '');
        if (key) stats[key] = _toNum(s.statValue ?? s.value);
      }
    }
    const league = _resolveLeagueName(d);
    const season = _resolveSeasonYear(d);
    if (Object.keys(stats).length) return { leagueName: league, seasonYear: season, stats };
  }

  // 方法2: overviewSeasonStats（旧API互換）
  const overview = d.overviewSeasonStats || d.seasonStats || null;
  if (Array.isArray(overview)) {
    const domesticEntry = overview.find(s =>
      !/(champions|europa|conference|cup|super)/i.test(s.tournamentName || '')
    ) || overview[0];
    if (domesticEntry) {
      return _parseStatEntry(domesticEntry, d);
    }
  }

  // 方法3: mainLeague.stats
  const ml = d.mainLeague;
  if (ml?.stats) {
    return {
      leagueName: ml.leagueName || null,
      seasonYear: ml.season || null,
      stats: _flattenStats(ml.stats),
    };
  }

  return null;
}

function _resolveLeagueName(d) {
  if (d.mainLeague?.leagueName) return d.mainLeague.leagueName;
  const ss = d.statSeasons;
  if (Array.isArray(ss) && ss.length) {
    const t = ss[0].tournaments;
    if (Array.isArray(t) && t.length) return t[0].name || null;
  }
  return null;
}

function _resolveSeasonYear(d) {
  if (d.mainLeague?.season) return d.mainLeague.season;
  const ss = d.statSeasons;
  if (Array.isArray(ss) && ss.length) return ss[0].seasonName || null;
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
  dribbles_succeeded: 'successfulDribbles',
  tackles: 'tackles',
  interceptions: 'interceptions',
  'clean sheets': 'cleanSheets', clean_sheet_team_title: 'cleanSheets',
  saves: 'saves',
  'accurate passes': 'accuratePasses', successful_passes: 'accuratePasses',
  'pass accuracy': 'accuratePassesPct', successful_passes_accuracy: 'accuratePassesPct',
  'chances created': 'bigChancesCreated',
  shotsontarget: 'shotsOnTarget',
  touches: 'touches',
  recoveries: 'recoveries',
  fouls: 'foulsCommitted',
  fouls_won: 'foulsWon',
  dispossessed: 'dispossessed',
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

    // ② SSR ページから __NEXT_DATA__ 取得
    const slug = String(playerName).toLowerCase().replace(/\s+/g, '-');
    const d = await _fetchPlayerData(hit.id, slug);
    const source = 'fotmob-ssr';
    if (!d) return { ok: false, error: `FotMob SSR: ${playerName} (id=${hit.id}) データ取得失敗` };

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

    // 市場価値（playerInformation から取得、なければ marketValues）
    let marketValue = null;
    let marketValueHistory = [];
    const mvInfo = d.playerInformation?.find(i =>
      /market.?value|transfer.?value/i.test(i.title || i.translationKey || '')
    );
    if (mvInfo?.value?.fallback) {
      marketValue = String(mvInfo.value.fallback);
    }
    const mv = d.marketValues;
    if (mv) {
      const curr = mv.current?.currency || mv.currency || 'EUR';
      if (!marketValue) {
        const val = mv.current?.value || mv.value || (Array.isArray(mv.values) ? mv.values[mv.values.length - 1]?.value : null);
        if (val) {
          marketValue = val >= 1_000_000
            ? `€${(val / 1_000_000).toFixed(0)}M`
            : `€${(val / 1_000).toFixed(0)}K`;
        }
      }
      if (Array.isArray(mv.values)) {
        marketValueHistory = mv.values.map(v => ({
          date: v.date ? v.date.slice(0, 10) : null,
          value: v.value,
          currency: v.currency || curr,
          team: v.teamName || null,
        }));
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
    const ntEntries = ch['national team']?.teamEntries || ch.nationalTeam?.teamEntries || ch.national?.teamEntries || [];
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
      marketValueHistory,
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
