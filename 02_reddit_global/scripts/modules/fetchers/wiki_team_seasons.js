// scripts/modules/fetchers/wiki_team_seasons.js
// Wikipedia 英語版 "List of {team} F.C. seasons" ページから直近 N シーズンの順位・成績を抽出
//
// 使い方:
//   const { fetchWikiTeamSeasons } = require('./wiki_team_seasons');
//   const r = await fetchWikiTeamSeasons('Arsenal', { limit: 10 });
//   // r: {
//   //   ok: true, source: 'wikipedia',
//   //   pageUsed: 'List of Arsenal F.C. seasons',
//   //   pageUrl: '...',
//   //   count: 10,
//   //   seasons: [
//   //     { season: '2024-25', league: 'PL', position: 2,
//   //       played: 38, wins: 20, draws: 14, losses: 4,
//   //       goalsFor: 89, goalsAgainst: 47, points: 74,
//   //       rawCells: [...] },
//   //     ...
//   //   ]
//   // }
//
// パース方針:
//   - Wikipedia parse API で HTML 取得
//   - <table class="wikitable"> をすべて検索し、ヘッダから列インデックス推定
//     (Season / League / Pos / P / W / D / L / GF / GA / Pts)
//   - 各行で Season セルが YYYY-YY パターンを満たす行のみ採用
//   - 直近 N シーズン分を新しい順で返却

const axios = require('axios');

const UA  = 'SoccerYTBot/2.0 (soccer-yt-project)';
const API = 'https://en.wikipedia.org/w/api.php';

// チーム名 → Wikipedia ページ正式名 のエイリアス
//   主要欧州クラブを網羅。マッチしないものは入力をそのまま使う
const TEAM_PAGE_ALIASES = {
  // Premier League
  'arsenal':            'Arsenal F.C.',
  'manchester city':    'Manchester City F.C.',
  'man city':           'Manchester City F.C.',
  'manchester united':  'Manchester United F.C.',
  'man utd':            'Manchester United F.C.',
  'man united':         'Manchester United F.C.',
  'chelsea':            'Chelsea F.C.',
  'liverpool':          'Liverpool F.C.',
  'tottenham':          'Tottenham Hotspur F.C.',
  'tottenham hotspur':  'Tottenham Hotspur F.C.',
  'spurs':              'Tottenham Hotspur F.C.',
  'newcastle':          'Newcastle United F.C.',
  'newcastle united':   'Newcastle United F.C.',
  'aston villa':        'Aston Villa F.C.',
  'west ham':           'West Ham United F.C.',
  'brighton':           'Brighton & Hove Albion F.C.',
  // La Liga
  'real madrid':        'Real Madrid CF',
  'barcelona':          'FC Barcelona',
  'fc barcelona':       'FC Barcelona',
  'atlético madrid':    'Atlético Madrid',
  'atletico madrid':    'Atlético Madrid',
  'real sociedad':      'Real Sociedad',
  'sevilla':            'Sevilla FC',
  'valencia':           'Valencia CF',
  // Bundesliga
  'bayern munich':      'FC Bayern Munich',
  'bayern münchen':     'FC Bayern Munich',
  'borussia dortmund':  'Borussia Dortmund',
  'rb leipzig':         'RB Leipzig',
  'bayer leverkusen':   'Bayer 04 Leverkusen',
  // Serie A
  'juventus':           'Juventus FC',
  'ac milan':           'A.C. Milan',
  'milan':              'A.C. Milan',
  'inter milan':        'Inter Milan',
  'inter':              'Inter Milan',
  'internazionale':     'Inter Milan',
  'napoli':             'S.S.C. Napoli',
  'roma':               'A.S. Roma',
  'as roma':            'A.S. Roma',
  // Ligue 1
  'paris saint-germain': 'Paris Saint-Germain F.C.',
  'paris saint germain': 'Paris Saint-Germain F.C.',
  'psg':                'Paris Saint-Germain F.C.',
  'olympique marseille': 'Olympique de Marseille',
  'marseille':          'Olympique de Marseille',
  'lyon':               'Olympique Lyonnais',
  // Eredivisie
  'ajax':               'AFC Ajax',
  'psv':                'PSV Eindhoven',
  'feyenoord':          'Feyenoord',
};

function _resolvePageTitle(teamName) {
  const k = String(teamName || '').trim().toLowerCase();
  return TEAM_PAGE_ALIASES[k] || teamName;
}

async function _fetchHtml(pageTitle) {
  try {
    const res = await axios.get(API, {
      params: {
        action: 'parse',
        format: 'json',
        page: pageTitle,
        prop: 'text',
        formatversion: 2,
        redirects: 1,
      },
      headers: { 'User-Agent': UA },
      timeout: 30000,
      validateStatus: () => true,
    });
    if (res.status !== 200) return null;
    return res.data?.parse?.text || null;
  } catch (_) {
    return null;
  }
}

function _stripHtmlTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[#\w]+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _parsePos(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+)(?:st|nd|rd|th)?/);
  return m ? parseInt(m[1], 10) : null;
}

function _parseInt(s) {
  if (s == null) return null;
  const m = String(s).match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function _parseSeasonsFromHtml(html) {
  const seasons = [];
  // wikitable をすべて検索
  const tableRegex = /<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  let tm;
  while ((tm = tableRegex.exec(html)) !== null) {
    const table = tm[1];
    // 最初の <tr> をヘッダとして列推定
    const headerMatch = table.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
    if (!headerMatch) continue;
    const headerCells = (headerMatch[1].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [])
      .map(c => _stripHtmlTags(c));
    if (headerCells.length < 4) continue;

    const lowerHeaders = headerCells.map(h => h.toLowerCase());
    const idxSeason = lowerHeaders.findIndex(h => /season/.test(h));
    const idxLeague = lowerHeaders.findIndex(h => /\bleague\b|\bdiv(\.|ision)\b|\btier\b/.test(h));
    const idxPos    = lowerHeaders.findIndex(h => /^pos\.?$/.test(h) || /position/.test(h));
    const idxPts    = lowerHeaders.findIndex(h => /^pts\.?$/.test(h) || /^points$/.test(h));
    const idxP      = lowerHeaders.findIndex(h => /^p\.?$|^pld\.?$|^matches$|^played$/.test(h));
    const idxW      = lowerHeaders.findIndex(h => /^w\.?$|^won$/.test(h));
    const idxD      = lowerHeaders.findIndex(h => /^d\.?$|^drawn$|^draws?$/.test(h));
    const idxL      = lowerHeaders.findIndex(h => /^l\.?$|^lost$|^losses?$/.test(h));
    const idxGF     = lowerHeaders.findIndex(h => /^gf\.?$|^f$|goals.*for/.test(h));
    const idxGA     = lowerHeaders.findIndex(h => /^ga\.?$|^a$|goals.*against/.test(h));

    // Season 列が無いテーブルはスキップ
    if (idxSeason < 0 && !lowerHeaders.some(h => /20\d{2}/.test(h))) {
      // 一部のページでは Season ヘッダが無く 0列目に直接シーズンが入るパターンも
    }

    // 各行をパース
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm;
    let isFirst = true;
    while ((rm = rowRegex.exec(table)) !== null) {
      if (isFirst) { isFirst = false; continue; }   // ヘッダ行スキップ
      const cells = (rm[1].match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [])
        .map(c => _stripHtmlTags(c));
      if (cells.length < 5) continue;

      const seasonCell = cells[idxSeason >= 0 ? idxSeason : 0] || '';
      // 2024–25 / 2024-25 / 2024-2025 を捕捉（en dash と hyphen 両対応）
      const seasonMatch = seasonCell.match(/(\d{4})[–—\-](\d{2,4})/);
      if (!seasonMatch) continue;
      const yearFrom = seasonMatch[1];
      const yearToRaw = seasonMatch[2];
      const yearTo = yearToRaw.length === 2
        ? yearFrom.slice(0, 2) + yearToRaw
        : yearToRaw;

      seasons.push({
        season: `${yearFrom}-${yearTo.slice(-2)}`,
        league:        idxLeague >= 0 ? cells[idxLeague] : null,
        position:      idxPos    >= 0 ? _parsePos(cells[idxPos])    : null,
        played:        idxP      >= 0 ? _parseInt(cells[idxP])      : null,
        wins:          idxW      >= 0 ? _parseInt(cells[idxW])      : null,
        draws:         idxD      >= 0 ? _parseInt(cells[idxD])      : null,
        losses:        idxL      >= 0 ? _parseInt(cells[idxL])      : null,
        goalsFor:      idxGF     >= 0 ? _parseInt(cells[idxGF])     : null,
        goalsAgainst:  idxGA     >= 0 ? _parseInt(cells[idxGA])     : null,
        points:        idxPts    >= 0 ? _parseInt(cells[idxPts])    : null,
        rawCells:      cells.slice(0, 15),
      });
    }
    // 5シーズン以上採れたらこのテーブルで確定
    if (seasons.length >= 5) break;
  }
  return seasons;
}

/**
 * @param {string} teamName - "Arsenal" / "Manchester City" / "Real Madrid" 等
 * @param {{limit?: number}} opts - limit: 直近何シーズン取るか（既定10）
 * @returns {Promise<{ok, source, pageUsed, pageUrl, count, seasons} | {ok:false, error}>}
 */
async function fetchWikiTeamSeasons(teamName, opts = {}) {
  const limit = opts.limit || 10;
  if (!teamName) return { ok: false, error: 'teamName required' };

  const resolved = _resolvePageTitle(teamName);
  const candidates = Array.from(new Set([
    `List of ${resolved} seasons`,
    `List of ${teamName} seasons`,
  ]));

  let html = null;
  let pageUsed = null;
  for (const page of candidates) {
    const h = await _fetchHtml(page);
    if (h && h.length > 1000) { html = h; pageUsed = page; break; }
  }
  if (!html) return { ok: false, error: 'wiki season page not found', triedPages: candidates };

  let seasons = _parseSeasonsFromHtml(html);
  if (!seasons.length) return { ok: false, error: 'no seasons table parsed', pageUsed };

  // 新しい順
  seasons.sort((a, b) => b.season.localeCompare(a.season));
  seasons = seasons.slice(0, limit);

  return {
    ok:       true,
    source:   'wikipedia',
    pageUsed,
    pageUrl:  `https://en.wikipedia.org/wiki/${encodeURIComponent(pageUsed.replace(/\s/g, '_'))}`,
    count:    seasons.length,
    seasons,
  };
}

module.exports = { fetchWikiTeamSeasons };
