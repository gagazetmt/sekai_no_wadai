// launcher/fetchers/fotmob_team.js
// FotMob からチーム情報（監督・直近フォーム）を取得
//   チームページはCSRなのでSSRデータなし
//   ① search/suggest でチームID解決
//   ② 試合検索で直近フォームを収集
//   ③ 試合ページのlineupから監督名を取得（フォールバック: Brave Search）

const cheerio = require('cheerio');
const { curlGet, curlGetJson } = require('./_curl_cffi_caller');
const FM_REFERER = 'https://www.fotmob.com/';

function stripDiacritics(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// チーム検索 → { id, name }
async function searchFotMobTeam(teamName) {
  if (!teamName) return null;
  const q = stripDiacritics(teamName);
  try {
    const url = `https://www.fotmob.com/api/data/search/suggest?hits=50&lang=en&term=${encodeURIComponent(q)}`;
    const sections = await curlGetJson(url, { referer: FM_REFERER, headers: { Accept: 'application/json' } });
    const all = (Array.isArray(sections) ? sections : []);
    const teamSec = all.find(s => s.title?.key === 'teams') || all.find(s => s.title?.key === 'all');
    const suggestions = (teamSec?.suggestions || []).filter(s => s.type === 'team');
    if (!suggestions.length) return null;
    const lc = q.toLowerCase();
    const norm = s => stripDiacritics(String(s.name || '')).toLowerCase();
    const hit = suggestions.find(s => norm(s) === lc)
      || suggestions.find(s => norm(s).startsWith(lc))
      || suggestions.find(s => norm(s).includes(lc))
      || suggestions[0];
    return { id: hit.id, name: hit.name };
  } catch (_) { return null; }
}

// チーム名で試合検索 → 直近matchIdリスト（最大10件）
async function _searchRecentMatches(teamName) {
  try {
    const q = stripDiacritics(teamName);
    const url = `https://www.fotmob.com/api/data/search/suggest?hits=50&lang=en&term=${encodeURIComponent(q)}`;
    const sections = await curlGetJson(url, { referer: FM_REFERER, headers: { Accept: 'application/json' } });
    const all = Array.isArray(sections) ? sections : [];
    const ms = all.find(s => s.title?.key === 'matches_tab_title');
    return (ms?.suggestions || []).filter(s => s.type === 'match').slice(0, 10).map(m => m.id);
  } catch (_) { return []; }
}

// 試合ページのlineupから監督名を取得
async function _fetchCoachFromMatch(matchId, teamId) {
  try {
    const res = await curlGet(`https://www.fotmob.com/match/${matchId}/lineup`, {
      referer: FM_REFERER, headers: { Accept: 'text/html' }, timeout: 20,
    });
    if (!res.ok) return null;
    const $ = cheerio.load(res.body);
    const nd = $('#__NEXT_DATA__').html();
    if (!nd) return null;
    const pp = JSON.parse(nd).props?.pageProps;
    const lineup = pp?.content?.lineup;
    if (!lineup) return null;
    const tid = Number(teamId);
    const team = lineup.homeTeam?.id === tid ? lineup.homeTeam : lineup.awayTeam;
    return team?.coach?.name || team?.coachName || null;
  } catch (_) { return null; }
}

// 試合ページから結果を取得
async function _fetchMatchResult(matchId, teamId) {
  try {
    const res = await curlGet(`https://www.fotmob.com/match/${matchId}/matchfacts`, {
      referer: FM_REFERER, headers: { Accept: 'text/html' }, timeout: 20,
    });
    if (!res.ok) return null;
    const $ = cheerio.load(res.body);
    const nd = $('#__NEXT_DATA__').html();
    if (!nd) return null;
    const pp = JSON.parse(nd).props?.pageProps;
    const header = pp?.header;
    if (!header) return null;
    const status = header.status;
    if (!status?.finished) return null;
    const teams = header.teams || [];
    const tid = Number(teamId);
    const myTeam = teams.find(t => Number(t.id) === tid);
    const oppTeam = teams.find(t => Number(t.id) !== tid);
    if (!myTeam || !oppTeam) return null;
    const myScore = myTeam.score ?? null;
    const oppScore = oppTeam.score ?? null;
    const result = myScore == null || oppScore == null ? null
      : myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'D';
    return {
      result,
      opponent: oppTeam.name || null,
      score: `${myScore ?? '?'}-${oppScore ?? '?'}`,
      tournament: pp?.general?.leagueName || null,
      date: status?.utcTime?.slice(0, 10) || null,
      matchId,
    };
  } catch (_) { return null; }
}

// Brave Search で監督名フォールバック
async function _fetchManagerViaBrave(teamName) {
  try {
    const { braveSearch } = require('../scout');
    const results = await braveSearch(`${teamName} national football team head coach manager 2026`, 3);
    if (!results.length) return null;
    const snippet = results[0].snippet || results[0].title || '';
    // 監督名を抽出するシンプルなパターン: "coached by", "manager", "head coach"
    const m = snippet.match(/(?:head coach|manager|coach(?:ed by)?)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

async function fetchFotMobTeam(teamName) {
  if (!teamName) return { ok: false, error: 'チーム名が未指定' };
  try {
    // ① チームID解決
    const hit = await searchFotMobTeam(teamName);
    if (!hit?.id) return { ok: false, error: `FotMob: "${teamName}" が見つかりません` };
    console.log(`  [team] FotMob ID: ${hit.id} (${hit.name})`);

    // ② 直近試合IDs（チーム名検索）
    const matchIds = await _searchRecentMatches(teamName);
    console.log(`  [team] recent matchIds: ${matchIds.length}件`);

    // ③ 試合結果を並列取得（最大5件）
    const last5Raw = (await Promise.all(
      matchIds.slice(0, 5).map(id => _fetchMatchResult(id, hit.id))
    )).filter(Boolean);

    // ④ 監督：最初の試合ページのlineupから取得
    let manager = null;
    for (const mid of matchIds.slice(0, 3)) {
      manager = await _fetchCoachFromMatch(mid, hit.id);
      if (manager) break;
    }

    // ⑤ 監督が取れなければ Brave Search
    if (!manager) {
      console.log(`  [team] lineup に監督なし → Brave Search`);
      manager = await _fetchManagerViaBrave(teamName);
    }

    const last5 = last5Raw.slice(0, 5);
    const recentForm = last5.length ? last5.map(m => m.result || '?').join(' ') : null;

    console.log(`  [team] ${hit.name} | 監督: ${manager || '—'} | 直近: ${recentForm || '—'}`);

    return {
      ok: true,
      teamId: hit.id,
      name: hit.name,
      manager: manager || null,
      leagueName: null,
      standing: null,
      recentForm: recentForm || null,
      last5,
    };
  } catch (e) {
    return { ok: false, error: `FotMob Team: ${e.message}` };
  }
}

module.exports = { fetchFotMobTeam, searchFotMobTeam };
