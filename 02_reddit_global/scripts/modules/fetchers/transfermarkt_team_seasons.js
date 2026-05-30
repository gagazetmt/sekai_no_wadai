// scripts/modules/fetchers/transfermarkt_team_seasons.js
// Transfermarkt の platzierungen ページからチームの歴代リーグ順位を取得
//   /platzierungen/verein/{id} → シーズン別 順位・リーグ・W/D/L・勝点
//
// 使い方:
//   const { fetchTeamSeasons } = require('./transfermarkt_team_seasons');
//   const r = await fetchTeamSeasons('Arsenal', { limit: 10 });
//   // r: { ok: true, seasons: [{season:'24/25', league:'Premier League', position:1, points:89,...}] }

'use strict';

const { curlGet } = require('./_curl_cffi_caller');
const TM_REFERER = 'https://www.transfermarkt.com/';

// チーム名 → TM ID/slug 解決
async function searchTransfermarktTeam(name) {
  if (!name) return null;
  try {
    const url = `https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(name)}&Verein_page=1`;
    const res = await curlGet(url, { referer: TM_REFERER, headers: { Accept: 'text/html' }, timeout: 20 });
    if (!res.ok || !res.body) return null;

    const html = res.body;
    const re = /<a[^>]+href="\/([\w\-]+)\/profil\/verein\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g;
    const hits = [];
    let m;
    while ((m = re.exec(html))) {
      const linkText = m[3].replace(/<[^>]*>/g, '').trim();
      if (linkText) hits.push({ slug: m[1], id: parseInt(m[2], 10), name: linkText });
    }
    if (!hits.length) return null;

    const lc = name.toLowerCase();
    const exact = hits.find(h => h.name.toLowerCase() === lc);
    const start = hits.find(h => h.name.toLowerCase().startsWith(lc));
    const incl  = hits.find(h => h.name.toLowerCase().includes(lc));
    const pick  = exact || start || incl || hits[0];
    console.log(`[TM Team] "${name}" → "${pick.name}" (id=${pick.id})`);
    return { id: pick.id, slug: pick.slug, name: pick.name };
  } catch (e) {
    console.warn('[transfermarkt_team_seasons] search 例外:', e.message);
    return null;
  }
}

function _stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function _parseInt(s) {
  if (s == null) return null;
  const m = String(s).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// platzierungen HTML → シーズン配列
function _parseSeasonsHtml(html) {
  const seasons = [];

  // TM の platzierungen テーブルを探す
  const tableRe = /<table[^>]*class="[^"]*(?:items|sortable)[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRe.exec(html)) !== null) {
    const tableInner = tm[1];
    const rows = tableInner.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    if (rows.length < 5) continue;

    // ヘッダ行から列インデックスを推定
    const headRow = rows.find(r => /<th/i.test(r));
    if (!headRow) continue;

    const thRe = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
    const headers = [];
    let hm;
    while ((hm = thRe.exec(headRow)) !== null) {
      headers.push(_stripHtml(hm[1]).toLowerCase());
    }

    // 列インデックスを特定
    const iSeason = headers.findIndex(h => /season|saison/.test(h));
    const iLeague = headers.findIndex(h => /league|liga|wettbewerb|division|comp/.test(h));
    const iPos    = headers.findIndex(h => /^pos\.?$|place|rang|platz/.test(h));
    const iPld    = headers.findIndex(h => /^(?:games?|played|pld|g|sp\.?)$/.test(h));
    const iW      = headers.findIndex(h => /^w\.?$|^won$|^s\.?$/.test(h));
    const iD      = headers.findIndex(h => /^d\.?$|^drawn?$|^u\.?$/.test(h));
    const iL      = headers.findIndex(h => /^l\.?$|^lost?$|^n\.?$/.test(h));
    const iGF     = headers.findIndex(h => /^gf\.?$|^f$|goals.*for|^tor/.test(h));
    const iGA     = headers.findIndex(h => /^ga\.?$|^a$|goals.*against/.test(h));
    const iPts    = headers.findIndex(h => /^pts\.?$|^points?$|^pkt\.?$/.test(h));

    // シーズン列が見つからないテーブルはスキップ
    if (iSeason < 0) continue;

    for (const row of rows) {
      if (/<th/i.test(row)) continue;

      const tdRe2 = /<td[^>]*>([\s\S]*?)<\/td>/gi;
      const tds = [];
      let tm2;
      while ((tm2 = tdRe2.exec(row)) !== null) {
        tds.push(_stripHtml(tm2[1]));
      }
      if (tds.length < 4) continue;

      const seasonCell = tds[iSeason >= 0 ? iSeason : 0] || '';
      // "2023/24" or "23/24" or "2023-24"
      const sMatch = seasonCell.match(/(\d{2,4})[\/\-](\d{2,4})/);
      if (!sMatch) continue;

      const rawA = sMatch[1], rawB = sMatch[2];
      const yearA = rawA.length === 2 ? '20' + rawA : rawA;
      const yearB = rawB.length === 2 ? yearA.slice(0, 2) + rawB : rawB;
      const season = `${yearA}-${yearB.slice(-2)}`;

      const league   = iLeague >= 0 ? (tds[iLeague] || null) : null;
      const position = iPos    >= 0 ? _parseInt(tds[iPos])   : null;
      const played   = iPld    >= 0 ? _parseInt(tds[iPld])   : null;
      const wins     = iW      >= 0 ? _parseInt(tds[iW])     : null;
      const draws    = iD      >= 0 ? _parseInt(tds[iD])     : null;
      const losses   = iL      >= 0 ? _parseInt(tds[iL])     : null;
      const points   = iPts    >= 0 ? _parseInt(tds[iPts])   : null;

      let goalsFor = null, goalsAgainst = null;
      if (iGF >= 0) goalsFor = _parseInt(tds[iGF]);
      if (iGA >= 0) goalsAgainst = _parseInt(tds[iGA]);

      // "85:36" 形式の得失点も吸収
      const goalCombined = tds.find(t => /^\d+\s*:\s*\d+$/.test(t));
      if (goalCombined && goalsFor == null) {
        const gParts = goalCombined.split(/\s*:\s*/);
        goalsFor = parseInt(gParts[0], 10);
        goalsAgainst = parseInt(gParts[1], 10);
      }

      if (!season) continue;
      seasons.push({ season, league: league || null, position, played, wins, draws, losses, goalsFor, goalsAgainst, points });
    }

    if (seasons.length >= 5) break;
  }

  return seasons;
}

async function fetchTransfermarktTeamSeasons(teamId, slug, opts = {}) {
  const limit = opts.limit || 10;
  const slugStr = slug || 'team';
  const url = `https://www.transfermarkt.com/${slugStr}/platzierungen/verein/${teamId}`;

  try {
    const res = await curlGet(url, {
      referer: TM_REFERER,
      headers: { Accept: 'text/html' },
      timeout: 30,
    });
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status || 'err'}` };

    let seasons = _parseSeasonsHtml(res.body);
    if (!seasons.length) return { ok: false, error: 'season table not found', bodySize: res.body.length };

    seasons.sort((a, b) => b.season.localeCompare(a.season));
    seasons = seasons.slice(0, limit);

    return { ok: true, source: 'transfermarkt', seasons, count: seasons.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function fetchTeamSeasons(teamName, opts = {}) {
  const hit = await searchTransfermarktTeam(teamName).catch(() => null);
  if (!hit) return { ok: false, error: `TM team not found: ${teamName}` };
  return await fetchTransfermarktTeamSeasons(hit.id, hit.slug, opts);
}

module.exports = { searchTransfermarktTeam, fetchTransfermarktTeamSeasons, fetchTeamSeasons };
