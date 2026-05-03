// scripts/fetch_bundesliga_managers.js
// Bundesliga 現行18クラブの監督画像を SofaScore 経由で取得（Phase 3）
//
// 使い方:
//   node scripts/fetch_bundesliga_managers.js          # 全クラブ
//   node scripts/fetch_bundesliga_managers.js dortmund # 1クラブ
//
// 動作:
//   1. _bundesliga_clubs.js の manager 名で SofaScore 検索 → managerId
//   2. /manager/{id}/image を curl-cffi + Webshare 経由で取得
//   3. images_stock/managers/bundesliga/{club-key}.{png|jpg}
//   4. data/managers_index.json にインデックス保存（追記）

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS } = require('./_bundesliga_clubs');
const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'managers', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'managers_index.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return null;
  const ext = m[1] === 'image/png'  ? '.png'
            : m[1] === 'image/jpeg' ? '.jpg'
            : '.png';
  return { ext, buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function findManagerId(name) {
  const data = await apiGet(`/search/all/?q=${encodeURIComponent(name)}`);
  const managers = (data.results || []).filter(r => r.type === 'manager');
  if (managers.length) return { id: managers[0].entity?.id, sourceName: managers[0].entity?.name };
  // チーム経由フォールバック
  const teams = (data.results || []).filter(r => r.type === 'team').slice(0, 3);
  for (const t of teams) {
    try {
      const td = await apiGet(`/team/${t.entity.id}`);
      if (td.team?.manager?.name?.toLowerCase().includes(name.split(' ').pop().toLowerCase())) {
        return { id: td.team.manager.id, sourceName: td.team.manager.name };
      }
    } catch (_) {}
  }
  return null;
}

async function fetchClubManager(key, club) {
  if (!club.manager) return { ok: false, reason: 'no manager name' };

  const found = await findManagerId(club.manager);
  if (!found?.id) return { ok: false, reason: 'manager id not found' };

  const dataUri = await apiGetImage(`/manager/${found.id}/image`);
  if (!dataUri) return { ok: false, reason: 'image fetch failed', sofaId: found.id };

  const conv = dataUriToBuffer(dataUri);
  if (!conv) return { ok: false, reason: 'invalid data uri', sofaId: found.id };

  const outPath = path.join(STOCK_DIR, `${key}${conv.ext}`);
  fs.writeFileSync(outPath, conv.buf);
  return {
    ok: true, sofaId: found.id, sourceName: found.sourceName,
    outPath, size: conv.buf.length, mime: conv.mime,
    ext: conv.ext,
    localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
  };
}

async function main() {
  const arg = process.argv[2];
  let targets;
  if (arg) {
    if (!BUNDESLIGA_CLUBS[arg]) {
      console.error(`Unknown club: ${arg}\nAvailable: ${Object.keys(BUNDESLIGA_CLUBS).filter(k => BUNDESLIGA_CLUBS[k].manager).join(', ')}`);
      process.exit(1);
    }
    targets = { [arg]: BUNDESLIGA_CLUBS[arg] };
  } else {
    targets = Object.fromEntries(Object.entries(BUNDESLIGA_CLUBS).filter(([_, c]) => c.manager));
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  // 既存 index 読み込み
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).managers || {}; } catch (_) {}
  }

  const results = [];
  console.log(`👔 監督画像取得開始: ${Object.keys(targets).length}クラブ\n`);

  for (const [key, club] of Object.entries(targets)) {
    await sleep(400);
    console.log(`${club.name} (${club.manager})`);
    try {
      const r = await fetchClubManager(key, club);
      if (r.ok) {
        const kb = (r.size / 1024).toFixed(0);
        console.log(`  ✅ SofaID=${r.sofaId} → ${key}${r.ext} (${kb}KB)`);
        prev[`${LEAGUE_SLUG}:${key}`] = {
          league:    LEAGUE_NAME,
          leagueSlug: LEAGUE_SLUG,
          clubKey:   key,
          clubName:  club.name,
          name:      club.manager,
          sofaId:    r.sofaId,
          sourceName: r.sourceName,
          localPath: r.localPath,
          sizeBytes: r.size,
        };
        results.push({ key, ok: true });
      } else {
        console.warn(`  ❌ ${r.reason}${r.sofaId ? ` (sofaId=${r.sofaId})` : ''}`);
        results.push({ key, ok: false, reason: r.reason });
      }
    } catch (e) {
      console.warn(`  ❌ 例外: ${e.message}`);
      results.push({ key, ok: false, reason: e.message });
    }
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    managers: prev,
  }, null, 2));

  const okN  = results.filter(r => r.ok).length;
  const failN = results.filter(r => !r.ok).length;
  console.log(`\n✅ ${okN} / ❌ ${failN}  Index: ${INDEX_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
