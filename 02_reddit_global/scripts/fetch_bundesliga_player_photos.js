// scripts/fetch_bundesliga_player_photos.js
// Bundesliga 全クラブの選手プロフィール写真を SofaScore 経由で取得（Phase 1）
//
// 使い方:
//   node scripts/fetch_bundesliga_player_photos.js                  # bayern-munich デフォルト
//   node scripts/fetch_bundesliga_player_photos.js dortmund
//   node scripts/fetch_bundesliga_player_photos.js all              # 全18クラブ
//
// 動作:
//   1. クラブ名で SofaScore 検索 → teamId 解決
//   2. /team/{teamId}/players → スカッドリスト取得
//   3. 各選手の /player/{id}/image を curl-cffi + Webshare 経由で取得
//   4. images_stock/players_official/bundesliga/{club-key}/{slug}.png
//   5. data/players_official_index.json にインデックス保存（累積追記）

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS } = require('./_bundesliga_clubs');
const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'players_official', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const SLEEP_MS   = 400;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function dataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return null;
  const ext = m[1] === 'image/jpeg' ? '.jpg' : '.png';
  return { ext, buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function findTeamId(name) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(name)}`);
  const teams = (data.results || []).filter(r =>
    r.type === 'team' && (r.entity?.sport?.id === 1 || !r.entity?.sport)
  );
  return teams.length ? { id: teams[0].entity.id, sourceName: teams[0].entity.name } : null;
}

async function getSquad(teamId) {
  const data = await apiGet(`/team/${teamId}/players`);
  // レスポンス: { players: [ { player: { id, name, position, ... } }, ... ] }
  return (data.players || []).map(e => e.player).filter(p => p && p.id && p.name);
}

async function fetchClub(key, club) {
  console.log(`\n=== ${club.name} ===`);
  const outDir = path.join(STOCK_DIR, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 1) チーム ID 解決
  let teamInfo;
  try {
    teamInfo = await findTeamId(club.name);
    if (!teamInfo) throw new Error('team not found');
    console.log(`  チームID: ${teamInfo.id} (${teamInfo.sourceName})`);
  } catch (e) {
    console.warn(`  ❌ チーム検索失敗: ${e.message}`);
    return { club: key, ok: 0, fail: 1, squadCount: 0, error: e.message, entries: [] };
  }

  // 2) スカッド取得
  let squad = [];
  try {
    squad = await getSquad(teamInfo.id);
    console.log(`  スカッド: ${squad.length} 件`);
  } catch (e) {
    console.warn(`  ❌ スカッド取得失敗: ${e.message}`);
    return { club: key, ok: 0, fail: 1, squadCount: 0, error: e.message, entries: [] };
  }

  if (!squad.length) {
    return { club: key, ok: 0, fail: 0, squadCount: 0, error: 'no players found', entries: [] };
  }

  // 3) 各選手の写真取得
  const entries = [];
  let ok = 0, fail = 0;

  for (const p of squad) {
    await sleep(SLEEP_MS);
    try {
      const slug = safeName(p.name);
      if (!slug || slug.length < 2) {
        console.warn(`  ⚠️ slug 空: ${p.name}`);
        fail++;
        continue;
      }
      const dataUri = await apiGetImage(`/player/${p.id}/image`);
      if (!dataUri) {
        console.warn(`  ⚠️ 画像なし: ${p.name}`);
        fail++;
        continue;
      }
      const conv = dataUriToBuffer(dataUri);
      if (!conv) {
        fail++;
        continue;
      }
      const outPath = path.join(outDir, `${slug}${conv.ext}`);
      fs.writeFileSync(outPath, conv.buf);
      const kb = (conv.buf.length / 1024).toFixed(0);
      console.log(`  ✅ ${p.name.padEnd(28)} → ${slug}${conv.ext} (${kb}KB)`);
      entries.push({
        club:      key,
        league:    LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
        sofaId:    p.id,
        name:      p.name,
        position:  p.position || null,
        slug,
        photoUrl:  `https://api.sofascore.com/api/v1/player/${p.id}/image`,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: conv.buf.length,
      });
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${(p.name || '').slice(0, 40)} → ${e.message.slice(0, 80)}`);
      fail++;
    }
  }

  return { club: key, ok, fail, squadCount: squad.length, entries };
}

async function main() {
  const arg = process.argv[2] || 'bayern-munich';
  let targets;
  if (arg === 'all') {
    targets = BUNDESLIGA_CLUBS;
  } else if (BUNDESLIGA_CLUBS[arg]) {
    targets = { [arg]: BUNDESLIGA_CLUBS[arg] };
  } else {
    console.error(`Unknown club: ${arg}\nAvailable: ${Object.keys(BUNDESLIGA_CLUBS).join(', ')} | all`);
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

  // 既存 index に累積追記（リーグ違い slug 衝突を key で回避）
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
    byClub: all.map(r => ({
      club: r.club, league: LEAGUE_NAME,
      ok: r.ok, fail: r.fail, squadCount: r.squadCount, error: r.error || null,
    })),
    players: index,
  }, null, 2));

  console.log('\n=== サマリー ===');
  all.forEach(r => {
    const status = r.error
      ? `❌ ${r.error.slice(0, 60)}`
      : `ok=${r.ok}/${r.squadCount} fail=${r.fail}`;
    console.log(`  ${r.club.padEnd(18)} ${status}`);
  });
  console.log(`\nIndex: ${INDEX_FILE} (累計 ${Object.keys(index).length}選手)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
