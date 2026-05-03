// scripts/fetch_pl_stadiums.js
// PL 全クラブのスタジアム写真を Wikimedia Commons から取得（Phase 5）
//
// 使い方:
//   node scripts/fetch_pl_stadiums.js          # 全49クラブ
//   node scripts/fetch_pl_stadiums.js arsenal  # 1クラブ
//
// 出力:
//   images_stock/stadiums/premier-league/{club-key}/{stadium-slug}_{n}.{ext}
//   data/stadiums_index.json

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { LEAGUE_SLUG, LEAGUE_NAME, PL_CLUBS } = require('./_pl_clubs');
const { fetchWikimediaImages } = require('./fetch_wikimedia_images');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'stadiums', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'stadiums_index.json');
const PER_CLUB   = 5;     // クラブあたり何枚取るか
const SLEEP_MS   = 1000;  // Wikimedia API レート制限対策

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function fetchClubStadium(key, club) {
  if (!club.stadium) {
    console.warn(`  ⚠️ ${club.name}: stadium 名未設定`);
    return { ok: 0, fail: 1, paths: [] };
  }
  const outDir = path.join(STOCK_DIR, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Wikimedia 検索: スタジアム名 + クラブ名で精度UP
  const searchTerm = `${club.stadium} ${club.name}`;
  const prefix = safeName(club.stadium);
  const paths = await fetchWikimediaImages(searchTerm, prefix, PER_CLUB, { outDir });
  return { ok: paths.length, fail: paths.length === 0 ? 1 : 0, paths };
}

async function main() {
  const arg = process.argv[2];
  let targets;
  if (arg) {
    if (!PL_CLUBS[arg]) {
      console.error(`Unknown club: ${arg}\nAvailable: ${Object.keys(PL_CLUBS).join(', ')}`);
      process.exit(1);
    }
    targets = { [arg]: PL_CLUBS[arg] };
  } else {
    targets = PL_CLUBS;
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  console.log(`🏟️ スタジアム取得開始: ${Object.keys(targets).length}クラブ\n`);
  const results = [];

  for (const [key, club] of Object.entries(targets)) {
    console.log(`=== ${club.name} (${club.stadium}) ===`);
    try {
      const r = await fetchClubStadium(key, club);
      console.log(`  ✓ ${r.ok}枚 取得`);
      results.push({ club: key, name: club.name, stadium: club.stadium, ok: r.ok, fail: r.fail, paths: r.paths });
    } catch (e) {
      console.warn(`  ❌ ${club.name}: ${e.message}`);
      results.push({ club: key, name: club.name, stadium: club.stadium, ok: 0, fail: 1, error: e.message });
    }
    await sleep(SLEEP_MS);
  }

  // 既存 index に追記
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).clubs || {}; } catch (_) {}
  }
  for (const r of results) {
    prev[`${LEAGUE_SLUG}:${r.club}`] = {
      league:     LEAGUE_NAME,
      leagueSlug: LEAGUE_SLUG,
      clubKey:    r.club,
      clubName:   r.name,
      stadium:    r.stadium,
      photoCount: r.ok,
      photos:     (r.paths || []).map(p => path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/')),
    };
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    clubs: prev,
  }, null, 2));

  const totalOk = results.reduce((s, r) => s + r.ok, 0);
  const totalFail = results.reduce((s, r) => s + (r.ok === 0 ? 1 : 0), 0);
  console.log(`\n=== サマリー ===`);
  console.log(`  ${LEAGUE_NAME}: 取得成功 ${results.length - totalFail}/${results.length}クラブ / 計 ${totalOk}枚`);
  console.log(`Index: ${INDEX_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
