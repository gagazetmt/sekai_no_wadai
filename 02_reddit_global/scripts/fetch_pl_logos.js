// scripts/fetch_pl_logos.js
// Premier League 全クラブのロゴ・エンブレム一括取得（Phase 2）
//
// 使い方:
//   node scripts/fetch_pl_logos.js          # 全49クラブ
//
// ソース:
//   https://resources.premierleague.com/premierleague/badges/t{id}.svg  (推し: SVG)
//   https://resources.premierleague.com/premierleague/badges/100/t{id}.png  (フォールバック)
//
// 出力:
//   images_stock/club_logos/premier-league/{club-key}.svg|png
//   data/club_logos_index.json

require('dotenv').config();
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const { LEAGUE_SLUG, LEAGUE_NAME, PL_CLUBS } = require('./_pl_clubs');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'club_logos', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'club_logos_index.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ロゴ URL 候補を順番に試す。SVG > 100x100 PNG > 50x50 PNG の優先順
function logoUrlVariants(id) {
  const base = 'https://resources.premierleague.com/premierleague/badges';
  return [
    { url: `${base}/t${id}.svg`,    ext: '.svg' },
    { url: `${base}/100/t${id}.png`, ext: '.png' },
    { url: `${base}/50/t${id}.png`,  ext: '.png' },
    { url: `${base}/25/t${id}.png`,  ext: '.png' },
  ];
}

async function downloadOne(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'image/*' },
    responseType: 'arraybuffer',
    timeout: 15000,
    maxRedirects: 5,
  });
  return Buffer.from(res.data);
}

async function fetchClubLogo(key, club) {
  for (const v of logoUrlVariants(club.id)) {
    try {
      const buf = await downloadOne(v.url);
      // ファイル拡張子を URL に合わせる
      const outPath = path.join(STOCK_DIR, key + v.ext);
      fs.writeFileSync(outPath, buf);
      return { url: v.url, ext: v.ext, size: buf.length, localPath: outPath };
    } catch (_) {
      // try next
    }
  }
  throw new Error('all logo variants failed');
}

async function main() {
  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const index = {};
  let ok = 0, fail = 0;
  const entries = Object.entries(PL_CLUBS);
  console.log(`📛 ロゴ取得開始: ${entries.length}クラブ\n`);

  for (const [key, club] of entries) {
    await sleep(200);
    try {
      const r = await fetchClubLogo(key, club);
      const kb = (r.size / 1024).toFixed(1);
      const sizeTag = r.url.match(/\/(\d+|t\d+\.svg)\//)?.[1] || (r.ext === '.svg' ? 'SVG' : '?');
      console.log(`  ✅ ${club.name.padEnd(30)} → ${key}${r.ext} (${kb}KB) [${r.ext === '.svg' ? 'SVG' : sizeTag}]`);
      index[key] = {
        league:    LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
        clubKey:   key,
        clubName:  club.name,
        plClubId:  club.id,
        logoUrl:   r.url,
        format:    r.ext.replace('.', ''),
        localPath: path.relative(path.join(__dirname, '..'), r.localPath).replace(/\\/g, '/'),
        sizeBytes: r.size,
      };
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${club.name.padEnd(30)} → ${e.message}`);
      fail++;
    }
  }

  // 既存 index に追記（他リーグ追加時に上書きしないため）
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).clubs || {}; } catch (_) {}
  }
  for (const k of Object.keys(index)) prev[`${LEAGUE_SLUG}:${k}`] = index[k];

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    clubs: prev,
  }, null, 2));

  console.log(`\n=== サマリー ===`);
  console.log(`  ${LEAGUE_NAME}: ok=${ok}/${entries.length} fail=${fail}`);
  console.log(`Index: ${INDEX_FILE} (累計 ${Object.keys(prev).length}クラブ)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
