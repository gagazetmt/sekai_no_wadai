// scripts/fetch_bundesliga_logos.js
// Bundesliga 全クラブのロゴ・エンブレムを SofaScore 経由で取得（Phase 2）
//
// 使い方:
//   node scripts/fetch_bundesliga_logos.js          # 全18クラブ
//   node scripts/fetch_bundesliga_logos.js dortmund # 1クラブ
//
// 動作:
//   1. クラブ名で SofaScore 検索 → teamId 解決
//   2. /team/{id}/image を curl-cffi + Webshare 経由で取得
//   3. images_stock/club_logos/bundesliga/{club-key}.png
//   4. data/club_logos_index.json にインデックス保存（追記）

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS } = require('./_bundesliga_clubs');
const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'club_logos', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'club_logos_index.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return null;
  const ext = m[1] === 'image/jpeg' ? '.jpg' : m[1] === 'image/svg+xml' ? '.svg' : '.png';
  return { ext, buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function findTeamId(name) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(name)}`);
  const teams = (data.results || []).filter(r =>
    r.type === 'team' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
  );
  return teams.length ? { id: teams[0].entity.id, sourceName: teams[0].entity.name } : null;
}

async function fetchClubLogo(key, club) {
  const teamInfo = await findTeamId(club.name);
  if (!teamInfo) throw new Error('team not found in SofaScore');

  const dataUri = await apiGetImage(`/team/${teamInfo.id}/image`);
  if (!dataUri) throw new Error('image fetch failed');

  const conv = dataUriToBuffer(dataUri);
  if (!conv) throw new Error('invalid data uri');

  const outPath = path.join(STOCK_DIR, `${key}${conv.ext}`);
  fs.writeFileSync(outPath, conv.buf);
  return {
    sofaId:     teamInfo.id,
    sourceName: teamInfo.sourceName,
    outPath,
    ext:        conv.ext,
    size:       conv.buf.length,
    mime:       conv.mime,
    localPath:  path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
  };
}

async function main() {
  const arg = process.argv[2];
  let targets;
  if (arg && BUNDESLIGA_CLUBS[arg]) {
    targets = { [arg]: BUNDESLIGA_CLUBS[arg] };
  } else if (!arg) {
    targets = BUNDESLIGA_CLUBS;
  } else {
    console.error(`Unknown club: ${arg}\nAvailable: ${Object.keys(BUNDESLIGA_CLUBS).join(', ')}`);
    process.exit(1);
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  // 既存 index 読み込み
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).clubs || {}; } catch (_) {}
  }

  let ok = 0, fail = 0;
  const entries = Object.entries(targets);
  console.log(`📛 ロゴ取得開始: ${entries.length}クラブ\n`);

  for (const [key, club] of entries) {
    await sleep(400);
    try {
      const r = await fetchClubLogo(key, club);
      const kb = (r.size / 1024).toFixed(1);
      console.log(`  ✅ ${club.name.padEnd(35)} → ${key}${r.ext} (${kb}KB) [SofaScore]`);
      prev[`${LEAGUE_SLUG}:${key}`] = {
        league:    LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
        clubKey:   key,
        clubName:  club.name,
        sofaId:    r.sofaId,
        format:    r.ext.replace('.', '').toUpperCase(),
        localPath: r.localPath,
        sizeBytes: r.size,
      };
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${club.name.slice(0, 40)}: ${e.message}`);
      fail++;
    }
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    clubs: prev,
  }, null, 2));

  console.log(`\n✅ ${ok} / ❌ ${fail}  Index: ${INDEX_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
