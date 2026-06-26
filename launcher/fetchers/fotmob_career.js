// scripts/modules/fetchers/fotmob_career.js
// FotMob から選手・監督のキャリア & トロフィーを取得する
//
// 使い方:
//   const { searchFotMob, fetchFotMobCareer } = require('./fotmob_career');
//   const id = await searchFotMob('Diego Simeone', 'manager');
//   const data = await fetchFotMobCareer(id);
//
// 仕組み:
//   1. /api/data/search/suggest?term= で名前 → FotMob ID 解決
//   2. /players/{id}/{slug} ページを Puppeteer で開く
//   3. NEXT_DATA から pageProps.data を抽出
//      - careerHistory.careerItems.{senior|coach}.teamEntries[] : クラブ歴
//      - trophies.{playerTrophies|coachTrophies}                 : 大会別タイトル
//      - primaryTeam, isCoach, statSeasons, marketValues 等
//
// FotMob は curl 直叩きを Cloudflare で弾くため Puppeteer-extra-stealth + Webshare 必須

// 2026-05-12: Puppeteer → curl-cffi + cheerio に移行
const cheerio = require('cheerio');
const { curlGet, curlGetJson } = require('./_curl_cffi_caller');
const FM_REFERER = 'https://www.fotmob.com/';

// 名前 → FotMob ID 解決
//   FotMob は player/manager を区別せず player type で返す（コーチも player ID を持つ）
//   返却: { id, name, teamId, type } | null
// ダイアクリティカル（アクセント記号）を除去: Džeko→Dzeko, Mitomá→Mitoma 等
function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function searchFotMob(name, opts = {}) {
  if (!name) return null;

  // ダイアクリティカル除去版も用意（バルカン・中欧選手対応）
  const strippedName = stripDiacritics(name);
  const searchName = strippedName !== name ? strippedName : name;

  // ① FotMob内部API（旧エンドポイント）を試す
  try {
    const url = `https://www.fotmob.com/api/data/search/suggest?hits=50&lang=en&term=${encodeURIComponent(searchName)}`;
    const sections = await curlGetJson(url, {
      referer: FM_REFERER,
      headers: { Accept: 'application/json' },
    });
    const all = (Array.isArray(sections) ? sections : []).find(s => s.title?.key === 'all') || (Array.isArray(sections) ? sections[0] : null);
    const suggestions = all?.suggestions || [];
    if (suggestions.length) {
      const lcName = stripDiacritics(String(name)).toLowerCase();
      const normalize = s => stripDiacritics(String(s.name || '')).toLowerCase();
      const exact = suggestions.find(s => normalize(s) === lcName);
      const startMatch = suggestions.find(s => normalize(s).startsWith(lcName));
      const include = suggestions.find(s => normalize(s).includes(lcName));
      const pick = exact || startMatch || include || suggestions[0];
      return { id: pick.id, name: pick.name, teamId: pick.teamId, type: pick.type };
    }
  } catch (_) {}

  // ② Brave Search で site:fotmob.com からID抽出（APIが404のときのフォールバック）
  try {
    const { fetchBraveSearch } = require('./brave_search_module');
    const res = await fetchBraveSearch(`site:fotmob.com/players ${name}`, '', 'en', null, { num: 5 });
    if (res.ok && res.organic) {
      for (const r of res.organic) {
        const m = String(r.link || '').match(/fotmob\.com\/players\/(\d+)\//);
        if (m) {
          const pName = String(r.link).split('/').pop()?.replace(/-/g, ' ') || name;
          return { id: m[1], name: pName, teamId: null, type: 'player' };
        }
      }
    }
  } catch (_) {}

  return null;
}

// FotMob ID から career データを取得
//   返却: {
//     id, name, isCoach, primaryTeam, mainLeague,
//     coachCareer: [{ teamId, team, startDate, endDate, current }],
//     playerCareer: [{ teamId, team, startDate, endDate, appearances, goals, assists }],
//     coachTrophies: [{ teamId, teamName, tournaments: [{ leagueName, seasonsWon, seasonsRunnerUp }] }],
//     playerTrophies: [...],
//     statSeasons: [...],   // シーズン別スタッツ
//     marketValue: { value, currency } | null,
//   }
async function fetchFotMobCareer(fotmobId, opts = {}) {
  if (!fotmobId) throw new Error('fotmobId required');
  const slug = opts.slug || 'x';
  const url = `https://www.fotmob.com/players/${fotmobId}/${slug}`;
  const res = await curlGet(url, {
    referer: FM_REFERER,
    headers: { Accept: 'text/html' },
    timeout: 30,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const $ = cheerio.load(res.body);
  const nextDataRaw = $('#__NEXT_DATA__').html();
  if (!nextDataRaw) throw new Error('no NEXT_DATA');
  const next = JSON.parse(nextDataRaw);
  const d = next.props?.pageProps?.data;
  if (!d) throw new Error('no pageProps.data');

  const ch = d.careerHistory?.careerItems || {};
  const coach  = (ch.coach?.teamEntries  || []).map(_simplifyEntry);
  const player = (ch.senior?.teamEntries || []).map(_simplifyEntry);

  return {
    id: d.id,
    name: d.name,
    isCoach: !!d.isCoach,
    primaryTeam: d.primaryTeam || null,
    mainLeague: d.mainLeague || null,
    coachCareer: coach,
    playerCareer: player,
    coachTrophies:  d.trophies?.coachTrophies  || [],
    playerTrophies: d.trophies?.playerTrophies || [],
    statSeasons:    d.statSeasons    || null,
    marketValue:    _extractMarketValue(d.marketValues),
    birthDate:      d.birthDate || null,
    positionDescription: d.positionDescription || null,
  };
}

function _simplifyEntry(e) {
  return {
    teamId: e.teamId,
    team:   e.team,
    teamGender: e.teamGender,
    startDate: (e.startDate || '').slice(0, 10),
    endDate:   e.endDate ? e.endDate.slice(0, 10) : null,
    current: !e.endDate,
    transferType: e.transferType,
    appearances: _toNum(e.appearances),
    goals:       _toNum(e.goals),
    assists:     _toNum(e.assists),
  };
}

function _toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function _extractMarketValue(mv) {
  if (!mv) return null;
  // marketValues は { current: { value, currency }, history: [...] } 形式
  if (mv.current) return mv.current;
  if (Array.isArray(mv) && mv.length) return mv[mv.length - 1];
  return null;
}

// 名前 → 一括取得（search → fetch）
async function fetchByName(name, opts = {}) {
  const found = await searchFotMob(name, opts);
  if (!found) return null;
  const slug = String(name).toLowerCase().replace(/\s+/g, '-');
  const data = await fetchFotMobCareer(found.id, { slug });
  return { found, data };
}

module.exports = {
  searchFotMob,
  fetchFotMobCareer,
  fetchByName,
};

// CLI for testing
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
  const name = process.argv[2] || 'Pep Guardiola';
  (async () => {
    console.log('Searching:', name);
    const res = await fetchByName(name);
    if (!res) { console.error('not found'); process.exit(1); }
    console.log('Match:', res.found);
    console.log('Coach career:');
    res.data.coachCareer.forEach(c => console.log(' -', c.team, c.startDate, '→', c.endDate || 'present'));
    console.log('Player career:');
    res.data.playerCareer.slice(0, 5).forEach(c => console.log(' -', c.team, c.startDate, '→', c.endDate || 'present', '| apps=' + c.appearances, 'goals=' + c.goals));
    console.log('Coach trophies (top 2 teams):');
    (res.data.coachTrophies || []).slice(0, 2).forEach(t => {
      console.log(' ', t.teamName);
      (t.tournaments || []).slice(0, 5).forEach(tn => console.log('   -', tn.leagueName, ': won', (tn.seasonsWon || []).length, '| RU', (tn.seasonsRunnerUp || []).length));
    });
  })().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
