// scripts/fetch_seriea_player_photos.js
// Serie A 全クラブの選手画像を SofaScore 経由で取得（Phase 1）
//
// 使い方:
//   node scripts/fetch_seriea_player_photos.js                  # inter-milan デフォルト
//   node scripts/fetch_seriea_player_photos.js juventus
//   node scripts/fetch_seriea_player_photos.js all              # 全20クラブ
//
// 仕組み:
//   1. SofaScore search で teamId 取得
//   2. /team/{teamId}/players で squad 取得
//   3. 各選手 /player/{playerId}/image で画像取得
//   4. images_stock/players_official/serie-a/{club}/{slug}.png に保存

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { LEAGUE_SLUG, LEAGUE_NAME, SERIEA_CLUBS } = require('./_seriea_clubs');
const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

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

async function findTeamId(searchName, country = 'Italy') {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(searchName)}`);
  const teams = (data.results || []).filter(r => r.type === 'team');
  // 国名一致を優先
  const italian = teams.find(t => t.entity?.country?.name === country);
  if (italian) return { id: italian.entity.id, name: italian.entity.name };
  return teams.length ? { id: teams[0].entity.id, name: teams[0].entity.name } : null;
}

async function fetchClub(key, club) {
  console.log(`\n=== ${club.name} ===`);
  const outDir = path.join(STOCK_DIR, LEAGUE_SLUG, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const team = await findTeamId(club.searchName);
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
        league: LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
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
  const arg = process.argv[2] || 'inter-milan';
  let targets;
  if (arg === 'all') {
    targets = SERIEA_CLUBS;
  } else if (SERIEA_CLUBS[arg]) {
    targets = { [arg]: SERIEA_CLUBS[arg] };
  } else {
    console.error(`Unknown: ${arg}\nAvailable: ${Object.keys(SERIEA_CLUBS).join(', ')} | all`);
    process.exit(1);
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const all = [];
  const allEntries = [];
  for (const [key, club] of Object.entries(targets)) {
    const r = await fetchClub(key, club);
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
    index[`${LEAGUE_SLUG}:${e.club}:${e.slug}`] = e;
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(index).length,
    byClub: all.map(r => ({ club: r.club, league: LEAGUE_NAME, ok: r.ok, fail: r.fail, squadCount: r.squadCount, error: r.error || null })),
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
