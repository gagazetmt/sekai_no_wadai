// scripts/fetch_laliga_logos.js
// LaLiga 全クラブのロゴ・エンブレム一括取得（Phase 2）
//
// 使い方:
//   node scripts/fetch_laliga_logos.js          # 全20クラブ
//
// 戦略:
//   各クラブの squad page を開いて、img.shield / img[alt*="shield"] / src*="assets.laliga.com"
//   からロゴ URL を抽出。日付パスがクラブ毎に違うので動的取得が必要。
//   サイズを xlarge に書き換えて高解像度版を取得。
//
// 出力:
//   images_stock/club_logos/la-liga/{club-key}.png
//   data/club_logos_index.json (リーグ別キーで PL と共存)

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');

const { LEAGUE_SLUG, LEAGUE_NAME, LALIGA_CLUBS } = require('./_laliga_clubs');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'club_logos', LEAGUE_SLUG);
const INDEX_FILE = path.join(__dirname, '..', 'data', 'club_logos_index.json');
const SLEEP_MS   = 1500;
const PREFER_SIZE = 'xlarge';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function newBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
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
  const url = `https://www.laliga.com/en-GB/clubs/${club.slug}/squad`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  try {
    await page.evaluate(() => {
      const sels = ['#onetrust-accept-btn-handler', 'button[id*="onetrust-accept"]'];
      for (const s of sels) { const b = document.querySelector(s); if (b) { b.click(); return; } }
    });
  } catch (_) {}
  await sleep(1500);

  return page.evaluate((slug) => {
    const imgs = Array.from(document.querySelectorAll('img'));
    // alt に "shield" を含む or src が assets.laliga + slug を含む URL を探す
    for (const i of imgs) {
      const src = i.getAttribute('src') || '';
      const alt = i.getAttribute('alt') || '';
      if (/assets\.laliga\.com\/assets\/\d{4}\/\d{2}\/\d{2}\//.test(src) && src.includes(slug)) return src;
      if (/shield/i.test(alt) && /assets\.laliga\.com/.test(src)) return src;
    }
    // フォールバック: assets.laliga.com の最初のもの（小さくないもの）
    for (const i of imgs) {
      const src = i.getAttribute('src') || '';
      if (/assets\.laliga\.com\/assets\/\d{4}\/\d{2}\/\d{2}\/.+\.(png|jpg|jpeg|svg)/i.test(src)) return src;
    }
    return null;
  }, club.slug);
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

  // サイズを xlarge に書き換え
  const upgraded = found.replace(/\/(small|medium|large|xlarge)\//, `/${PREFER_SIZE}/`);
  const ext = (found.match(/\.(png|jpg|jpeg|svg)/i) || ['.png'])[0];
  const outPath = path.join(STOCK_DIR, key + ext);

  try {
    const size = await downloadImage(upgraded, outPath);
    return { ok: true, url: upgraded, ext, size, outPath };
  } catch (_) {
    // 元サイズで再試行
    const size = await downloadImage(found, outPath);
    return { ok: true, url: found, ext, size, outPath };
  }
}

async function main() {
  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const browser = await newBrowser();
  const page = await setupPage(browser);

  const results = [];
  console.log(`📛 ロゴ取得開始: ${Object.keys(LALIGA_CLUBS).length}クラブ\n`);

  try {
    for (const [key, club] of Object.entries(LALIGA_CLUBS)) {
      await sleep(SLEEP_MS);
      try {
        const r = await fetchClubLogo(page, key, club);
        if (r.ok) {
          const kb = (r.size / 1024).toFixed(1);
          console.log(`  ✅ ${club.name.padEnd(28)} → ${key}${r.ext} (${kb}KB)`);
          results.push({ club: key, ...r, clubName: club.name });
        } else {
          console.log(`  ❌ ${club.name.padEnd(28)} ${r.reason}`);
          results.push({ club: key, ok: false, reason: r.reason, clubName: club.name });
        }
      } catch (e) {
        console.log(`  ❌ ${club.name.padEnd(28)} ${e.message.slice(0, 60)}`);
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
