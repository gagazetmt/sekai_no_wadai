// scripts/fetch_bundesliga_logos.js
// Bundesliga 全クラブのロゴ・エンブレム一括取得（Phase 2）
//
// 使い方:
//   node scripts/fetch_bundesliga_logos.js          # 全18クラブ
//
// 戦略:
//   各クラブの page (/en/bundesliga/clubs/{slug}) を開いて、
//   img src で assets.bundesliga.com/clublogos/{seasonId}/{clubId}.svg を抽出。
//   SVG なのでサイズ無関係でそのまま保存。
//
// 出力:
//   images_stock/club_logos/bundesliga/{club-key}.svg
//   data/club_logos_index.json (リーグ別キーで PL/LaLiga と共存)

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');

const { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS } = require('./_bundesliga_clubs');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'club_logos', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'club_logos_index.json');
const SLEEP_MS   = 1500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function newBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

async function findLogoUrl(page, club) {
  const url = `https://www.bundesliga.com/en/bundesliga/clubs/${club.slug}`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  try {
    await page.evaluate(() => {
      const sels = ['#onetrust-accept-btn-handler', 'button[id*="onetrust-accept"]', 'button[mode="primary"]'];
      for (const s of sels) { const b = document.querySelector(s); if (b) { b.click(); return; } }
    });
  } catch (_) {}
  await sleep(1500);

  return page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img'));
    for (const i of imgs) {
      const src = i.getAttribute('src') || '';
      if (/assets\.bundesliga\.com\/clublogos\//i.test(src)) return src;
    }
    return null;
  });
}

async function downloadImage(url, outPath) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'image/*' },
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
  });
  fs.writeFileSync(outPath, Buffer.from(res.data));
  return res.data.length;
}

async function fetchClubLogo(page, key, club) {
  const found = await findLogoUrl(page, club);
  if (!found) return { ok: false, reason: 'logo url not found' };

  // クエリ削除（fit=70,70 は不要、SVG はサイズ無関係）
  const cleaned = found.split('?')[0];
  const ext = (cleaned.match(/\.(png|jpg|jpeg|svg)/i) || ['.svg'])[0].toLowerCase();
  const outPath = path.join(STOCK_DIR, key + ext);

  const size = await downloadImage(cleaned, outPath);
  return { ok: true, url: cleaned, ext, size, outPath };
}

async function main() {
  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const browser = await newBrowser();
  const page = await setupPage(browser);

  const results = [];
  console.log(`📛 ${LEAGUE_NAME} ロゴ取得開始: ${Object.keys(BUNDESLIGA_CLUBS).length}クラブ\n`);

  try {
    for (const [key, club] of Object.entries(BUNDESLIGA_CLUBS)) {
      await sleep(SLEEP_MS);
      try {
        const r = await fetchClubLogo(page, key, club);
        if (r.ok) {
          const kb = (r.size / 1024).toFixed(1);
          console.log(`  ✅ ${club.name.padEnd(30)} → ${key}${r.ext} (${kb}KB)`);
          results.push({ club: key, ...r, clubName: club.name });
        } else {
          console.log(`  ❌ ${club.name.padEnd(30)} ${r.reason}`);
          results.push({ club: key, ok: false, reason: r.reason, clubName: club.name });
        }
      } catch (e) {
        console.log(`  ❌ ${club.name.padEnd(30)} ${e.message.slice(0, 60)}`);
        results.push({ club: key, ok: false, reason: e.message, clubName: club.name });
      }
    }
  } finally {
    await browser.close();
  }

  // 既存 index に追記
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).clubs || {}; } catch (_) {}
  }
  for (const r of results) {
    if (!r.ok) continue;
    prev[`${LEAGUE_SLUG}:${r.club}`] = {
      league:     LEAGUE_NAME,
      leagueSlug: LEAGUE_SLUG,
      clubKey:    r.club,
      clubName:   r.clubName,
      logoUrl:    r.url,
      format:     r.ext.replace('.', ''),
      localPath:  path.relative(path.join(__dirname, '..'), r.outPath).replace(/\\/g, '/'),
      sizeBytes:  r.size,
    };
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    clubs: prev,
  }, null, 2));

  const ok = results.filter(r => r.ok).length;
  console.log(`\n=== サマリー === ${LEAGUE_NAME} ok=${ok}/${results.length}`);
  console.log(`Index: ${INDEX_FILE} (累計 ${Object.keys(prev).length}クラブ)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
