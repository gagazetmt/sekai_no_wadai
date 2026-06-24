// scripts/modules/fetchers/fotmob_manager.js
// FotMob から監督データを取得（curl-cffi + SSR）
//   SofaScore API 403 完全ブロックの代替
//   ① searchFotMob → fotmobId
//   ② /api/playerData?id= → JSON（コーチも player として扱われる）
//   ③ 失敗時: player page SSR → __NEXT_DATA__
//
// 返却形式: sofascore_manager.js の fetchSofaScoreManager と互換

const cheerio = require('cheerio');
const { curlGet, curlGetJson } = require('./_curl_cffi_caller');
const { searchFotMob } = require('./fotmob_career');
const { fetchWikipediaWikitext, extractHonoursSection } = require('./wikipedia');

const FM_REFERER = 'https://www.fotmob.com/';
const FM_JSON_HEADERS = { Accept: 'application/json' };

async function _fetchManagerAPI(fotmobId) {
  try {
    const url = `https://www.fotmob.com/api/playerData?id=${fotmobId}`;
    const data = await curlGetJson(url, { referer: FM_REFERER, headers: FM_JSON_HEADERS, timeout: 20 });
    if (data && (data.name || data.id)) return data;
    return null;
  } catch (_) { return null; }
}

async function _fetchManagerSSR(fotmobId, nameSlug) {
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

function _toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchFotMobManager(managerName) {
  if (!managerName) return { ok: false, error: '監督名が未指定' };

  try {
    // ① 検索（FotMob はコーチも player type で返す）
    const hit = await searchFotMob(managerName, {});
    if (!hit?.id) return { ok: false, error: `FotMob: "${managerName}" が見つかりません` };

    // ② API 直接 → SSR フォールバック
    let d = await _fetchManagerAPI(hit.id);
    if (!d) {
      const slug = String(managerName).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      d = await _fetchManagerSSR(hit.id, slug);
    }
    if (!d) return { ok: false, error: `FotMob: ${managerName} データ取得失敗` };

    console.log(`[FotMob Manager] ${managerName} keys=[${Object.keys(d).join(',')}]`);

    // 基本情報
    const name = d.name || managerName;
    let age = null;
    if (d.birthDate?.utcTime) {
      age = Math.floor((Date.now() - new Date(d.birthDate.utcTime)) / (365.25 * 24 * 3600 * 1000));
    }

    const nationality = d.playerInformation?.find(i =>
      /country|nationality/i.test(i.title || i.key || '')
    )?.value?.fallback || d.country?.name || null;

    // コーチキャリア
    const ch = d.careerHistory?.careerItems || {};
    const coachEntries = (ch.coach?.teamEntries || []).map(e => ({
      club: e.team,
      teamId: e.teamId,
      from: (e.startDate || '').slice(0, 7),
      to: e.endDate ? e.endDate.slice(0, 7) : null,
      current: !e.endDate,
      appearances: _toNum(e.appearances),
      goals: _toNum(e.goals),
      assists: _toNum(e.assists),
    }));
    const currentTeam = coachEntries.find(c => c.current) || coachEntries[0] || null;

    // コーチ通算成績（FotMob に performance がある場合）
    const perf = d.coachingPerformance || d.performance || {};
    const overallPerformance = perf.total ? {
      total: perf.total,
      wins: perf.wins || 0,
      draws: perf.draws || 0,
      losses: perf.losses || 0,
      winRate: perf.total ? parseFloat(((perf.wins / perf.total) * 100).toFixed(1)) : null,
    } : null;

    // トロフィー
    const trophies = d.trophies?.coachTrophies || d.trophies?.playerTrophies || [];
    let trophyCount = 0;
    for (const t of trophies) {
      if (Array.isArray(t.tournaments)) {
        for (const tour of t.tournaments) {
          trophyCount += (tour.seasonsWon || []).length;
        }
      }
    }

    // Wikipedia honours（並列取得）
    let honours = [];
    let trophySummary = { total: 0 };
    try {
      const wikiRaw = await fetchWikipediaWikitext(managerName).catch(() => ({ ok: false }));
      if (wikiRaw?.ok) {
        honours = extractHonoursSection(wikiRaw.wikitext);
        const _allItems = honours.flatMap(h => h.items || []);
        const _matchAny = (re) => _allItems.filter(it => re.test(it)).length;
        trophySummary = {
          total: _allItems.length,
          leagueTitles: _matchAny(/league|liga|premier|serie a|bundesliga|ligue 1|eredivisie|primeira/i),
          cupTitles: _matchAny(/\bcup\b|copa|coupe|pokal|coppa/i),
          clTitles: _matchAny(/champions league|uefa champions/i),
        };
      }
    } catch (_) {}

    // 顔写真
    const photo = `https://images.fotmob.com/image_resources/playerimages/${hit.id}.png`;

    const result = {
      ok: true,
      managerId: hit.id,
      name,
      nationality,
      age,
      currentTeam: currentTeam?.club || null,
      currentTeamSince: currentTeam?.from || null,
      career: coachEntries,
      overallPerformance,
      last5Matches: [],
      honours,
      trophySummary,
      trophyCount,
      photo,
      _source: 'fotmob',
    };

    console.log(`[FotMob Manager] ${name} | team:${currentTeam?.club || '?'} | career:${coachEntries.length}clubs | trophies:${trophyCount}(fm)+${trophySummary.total}(wiki)`);

    return result;
  } catch (e) {
    return { ok: false, error: `FotMob: ${e.message}` };
  }
}

module.exports = { fetchFotMobManager };
