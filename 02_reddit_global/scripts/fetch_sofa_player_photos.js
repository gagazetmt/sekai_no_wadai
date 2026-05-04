// scripts/fetch_sofa_player_photos.js
// SofaScore ベースの汎用選手画像取得スクリプト（複数リーグ対応）
//
// 使い方:
//   node fetch_sofa_player_photos.js <league> <club|all>
//
//   league: serie-a | ligue-1 | liga-portugal | eredivisie | scottish-premiership
//   club:   クラブキー or 'all'
//
// 例:
//   node fetch_sofa_player_photos.js ligue-1 all
//   node fetch_sofa_player_photos.js liga-portugal porto

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

// 各リーグの clubs マスタ
const LEAGUES = {
  'serie-a': {
    name: 'Serie A',
    country: 'Italy',
    clubs: require('./_seriea_clubs').SERIEA_CLUBS,
  },
  'ligue-1': {
    name: 'Ligue 1',
    country: 'France',
    clubs: require('./_ligue1_clubs').LIGUE1_CLUBS,
  },
  'liga-portugal': {
    name: 'Liga Portugal',
    country: 'Portugal',
    clubs: require('./_liga_portugal_clubs').LIGA_PORTUGAL_CLUBS,
  },
  'eredivisie': {
    name: 'Eredivisie',
    country: 'Netherlands',
    clubs: require('./_eredivisie_clubs').EREDIVISIE_CLUBS,
  },
  'scottish-premiership': {
    name: 'Scottish Premiership',
    country: 'Scotland',
    clubs: require('./_scottish_clubs').SCOTTISH_CLUBS,
  },
};

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'players_official');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const SLEEP_MS   = 600;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function dataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return null;
  const ext = m[1] === 'image/png' ? '.png' : m[1] === 'image/jpeg' ? '.jpg' : '.png';
  return { ext, buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function findTeamId(searchName, country) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(searchName)}`);
  const teams = (data.results || []).filter(r => r.type === 'team');
  const matched = teams.find(t => t.entity?.country?.name === country);
  if (matched) return { id: matched.entity.id, name: matched.entity.name };
  return teams.length ? { id: teams[0].entity.id, name: teams[0].entity.name } : null;
}

async function fetchClub(leagueSlug, leagueName, country, key, club) {
  console.log(`\n=== ${club.name} ===`);
  const outDir = path.join(STOCK_DIR, leagueSlug, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const team = await findTeamId(club.searchName, country);
  if (!team) {
    console.warn(`  ❌ team not found: ${club.searchName}`);
    return { club: key, ok: 0, fail: 1, squadCount: 0, error: 'team not found', entries: [] };
  }
  console.log(`  teamId=${team.id} (${team.name})`);

  const squadResp = await apiGet(`/team/${team.id}/players`);
  const squad = squadResp.players || [];
  console.log(`  スカッド: ${squad.length} 件`);
  if (!squad.length) {
    return { club: key, ok: 0, fail: 0, squadCount: 0, error: 'empty squad', entries: [] };
  }

  let ok = 0, fail = 0;
  const entries = [];

  for (const item of squad) {
    const p = item.player || item;
    const playerName = p.name || '';
    const playerId   = p.id;
    if (!playerId || !playerName) { fail++; continue; }
    await sleep(SLEEP_MS);
    try {
      const dataUri = await apiGetImage(`/player/${playerId}/image`);
      if (!dataUri) { console.warn(`  ⚠️ no img: ${playerName}`); fail++; continue; }
      const conv = dataUriToBuffer(dataUri);
      if (!conv) { console.warn(`  ⚠️ invalid uri: ${playerName}`); fail++; continue; }
      const slug = safeName(playerName);
      if (!slug || slug.length < 2) { fail++; continue; }
      const outPath = path.join(outDir, `${slug}${conv.ext}`);
      fs.writeFileSync(outPath, conv.buf);
      const kb = (conv.buf.length / 1024).toFixed(0);
      console.log(`  ✅ ${playerName.padEnd(28)} → ${slug}${conv.ext} (${kb}KB)`);
      entries.push({
        club: key,
        league: leagueName,
        leagueSlug,
        sofaTeamId: team.id,
        sofaPlayerId: playerId,
        playerSlug: p.slug || slug,
        name: playerName,
        slug,
        sourceName: p.name,
        photoUrl: `https://api.sofascore.com/api/v1/player/${playerId}/image`,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: conv.buf.length,
      });
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${playerName.slice(0, 30)} → ${e.message.slice(0, 80)}`);
      fail++;
    }
  }

  return { club: key, ok, fail, squadCount: squad.length, entries };
}

async function main() {
  const leagueArg = process.argv[2];
  const clubArg   = process.argv[3] || 'all';

  if (!leagueArg || !LEAGUES[leagueArg]) {
    console.error(`Usage: node fetch_sofa_player_photos.js <league> [club|all]\nLeagues: ${Object.keys(LEAGUES).join(', ')}`);
    process.exit(1);
  }
  const lg = LEAGUES[leagueArg];
  const clubs = lg.clubs;

  let targets;
  if (clubArg === 'all') targets = clubs;
  else if (clubs[clubArg]) targets = { [clubArg]: clubs[clubArg] };
  else {
    console.error(`Unknown club: ${clubArg}\nAvailable: ${Object.keys(clubs).join(', ')} | all`);
    process.exit(1);
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const all = [];
  const allEntries = [];
  for (const [key, club] of Object.entries(targets)) {
    const r = await fetchClub(leagueArg, lg.name, lg.country, key, club);
    all.push(r);
    allEntries.push(...(r.entries || []));
  }

  let index = {};
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const cur = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      index = cur.players || {};
    } catch (_) {}
  }
  for (const e of allEntries) {
    index[`${leagueArg}:${e.club}:${e.slug}`] = e;
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(index).length,
    byClub: all.map(r => ({ club: r.club, league: lg.name, ok: r.ok, fail: r.fail, squadCount: r.squadCount, error: r.error || null })),
    players: index,
  }, null, 2));

  console.log('\n=== サマリー ===');
  all.forEach(r => {
    const status = r.error ? `❌ ${r.error.slice(0, 60)}` : `ok=${r.ok}/${r.squadCount} fail=${r.fail}`;
    console.log(`  ${r.club.padEnd(20)} ${status}`);
  });
  console.log(`\nIndex: ${INDEX_FILE} (累計 ${Object.keys(index).length}選手)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
