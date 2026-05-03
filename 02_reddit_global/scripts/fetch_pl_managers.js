// scripts/fetch_pl_managers.js
// PL 現行 20クラブの監督画像を SofaScore 経由で取得（Phase 3）
//
// 使い方:
//   node scripts/fetch_pl_managers.js          # 全20クラブ
//   node scripts/fetch_pl_managers.js arsenal  # 1クラブ
//
// 動作:
//   1. _pl_clubs.js の manager 名で SofaScore search → manager ID 取得
//   2. /manager/{id}/image を curl-cffi + Webshare 経由で取得（既存 apiGetImage 流用）
//   3. images_stock/managers/premier-league/{club-key}.{png|jpg}
//   4. data/managers_index.json にインデックス保存

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const { LEAGUE_SLUG, LEAGUE_NAME, PL_CLUBS } = require('./_pl_clubs');
const { apiGet, apiGetImage } = require('./modules/fetchers/_sofa_common');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'managers', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'managers_index.json');

function safeName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
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
      if (td.team?.manager?.name?.toLowerCase().includes(name.toLowerCase())) {
        return { id: td.team.manager.id, sourceName: td.team.manager.name };
      }
    } catch (_) {}
  }
  return null;
}

function dataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/\w+);base64,(.*)$/);
  if (!m) return null;
  const ext = m[1] === 'image/png'  ? '.png'
            : m[1] === 'image/jpeg' ? '.jpg'
            : m[1] === 'image/gif'  ? '.gif'
            : '.png';
  return { ext, buf: Buffer.from(m[2], 'base64'), mime: m[1] };
}

async function fetchClubManager(key, club) {
  if (!club.manager) {
    return { ok: false, reason: 'no manager name' };
  }
  // 1) ID 解決
  const found = await findManagerId(club.manager);
  if (!found?.id) {
    return { ok: false, reason: 'manager id not found' };
  }
  // 2) 画像取得
  const dataUri = await apiGetImage(`/manager/${found.id}/image`);
  if (!dataUri) {
    return { ok: false, reason: 'image fetch failed', sofaId: found.id };
  }
  const conv = dataUriToBuffer(dataUri);
  if (!conv) {
    return { ok: false, reason: 'invalid data uri', sofaId: found.id };
  }
  // 3) 保存
  const outPath = path.join(STOCK_DIR, `${key}${conv.ext}`);
  fs.writeFileSync(outPath, conv.buf);
  return {
    ok: true, sofaId: found.id, sourceName: found.sourceName,
    outPath, size: conv.buf.length, mime: conv.mime,
  };
}

async function main() {
  const arg = process.argv[2];
  let targets;
  if (arg) {
    if (!PL_CLUBS[arg]) {
      console.error(`Unknown club: ${arg}\nAvailable: ${Object.keys(PL_CLUBS).filter(k => PL_CLUBS[k].manager).join(', ')}`);
      process.exit(1);
    }
    targets = { [arg]: PL_CLUBS[arg] };
  } else {
    // manager 設定済みクラブのみ
    targets = Object.fromEntries(Object.entries(PL_CLUBS).filter(([_, c]) => c.manager));
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  console.log(`👔 監督画像取得開始: ${Object.keys(targets).length}クラブ\n`);
  const results = [];

  for (const [key, club] of Object.entries(targets)) {
    process.stdout.write(`  ${club.name.padEnd(28)} (${club.manager}) ... `);
    try {
      const r = await fetchClubManager(key, club);
      if (r.ok) {
        const kb = (r.size / 1024).toFixed(0);
        console.log(`✅ id=${r.sofaId} (${kb}KB ${r.mime})`);
      } else {
        console.log(`❌ ${r.reason}${r.sofaId ? ` (sofaId=${r.sofaId})` : ''}`);
      }
      results.push({ club: key, ...r, name: club.manager, clubName: club.name });
    } catch (e) {
      console.log(`❌ ${e.message.slice(0, 80)}`);
      results.push({ club: key, ok: false, reason: e.message, name: club.manager, clubName: club.name });
    }
  }

  // 既存 index に追記
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).managers || {}; } catch (_) {}
  }
  for (const r of results) {
    if (!r.ok) continue;
    prev[`${LEAGUE_SLUG}:${r.club}`] = {
      league:     LEAGUE_NAME,
      leagueSlug: LEAGUE_SLUG,
      clubKey:    r.club,
      clubName:   r.clubName,
      name:       r.name,
      sourceName: r.sourceName,
      sofaId:     r.sofaId,
      slug:       safeName(r.name),
      localPath:  path.relative(path.join(__dirname, '..'), r.outPath).replace(/\\/g, '/'),
      sizeBytes:  r.size,
    };
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    managers: prev,
  }, null, 2));

  const ok = results.filter(r => r.ok).length;
  console.log(`\n=== サマリー ===`);
  console.log(`  ${LEAGUE_NAME}: ok=${ok}/${results.length}`);
  console.log(`Index: ${INDEX_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
