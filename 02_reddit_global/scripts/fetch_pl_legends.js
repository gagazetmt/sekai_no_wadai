// scripts/fetch_pl_legends.js
// Premier League Hall of Fame レジェンド画像を一括取得（Phase 4）
//
// 戦略:
//   inductees 一覧ページに各レジェンドの hero 画像が src + alt 属性で含まれている。
//   個別ページを開かず、alt の名前と inductee link の slug をマッチングする。
//
// 出力:
//   images_stock/legends/premier-league/{slug}.{jpg|png}
//   data/legends_index.json

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'legends', 'premier-league');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'legends_index.json');
const URL_INDUCTEES = 'https://www.premierleague.com/en/events/hall-of-fame/inductees';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function safeName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
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

async function main() {
  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });

  console.log(`📥 Inductees page: ${URL_INDUCTEES}`);
  await page.goto(URL_INDUCTEES, { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise(r => setTimeout(r, 3000));

  const scraped = await page.evaluate(() => {
    const inductees = [];
    const seen = new Set();
    const aTags = Array.from(document.querySelectorAll('a[href*="/inductees/"]'));
    for (const a of aTags) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/inductees\/([^/?#]+)/);
      if (!m) continue;
      const slug = m[1];
      if (slug === 'overview' || slug === 'inductees' || seen.has(slug)) continue;
      seen.add(slug);
      inductees.push({ slug });
    }
    const imgs = Array.from(document.querySelectorAll('img[src][alt]'))
      .filter(i => /pulselive\.com\/photo-resources/.test(i.getAttribute('src') || ''))
      .map(i => ({ src: i.getAttribute('src'), alt: i.getAttribute('alt') || '' }));
    return { inductees, imgs };
  });

  await browser.close();

  console.log(`  Inductees: ${scraped.inductees.length}`);
  console.log(`  Hero images: ${scraped.imgs.length}\n`);

  const index = {};
  let ok = 0, fail = 0;

  for (const ind of scraped.inductees) {
    // slug "gary-neville" → ["gary", "neville"] の全単語が alt 内に含まれる img を探す
    const words = ind.slug.split('-').filter(w => w.length >= 2);
    const matched = scraped.imgs.find(im => {
      const altLower = im.alt.toLowerCase();
      return words.every(w => altLower.includes(w));
    });
    if (!matched) {
      console.warn(`  ⚠️ no img match: ${ind.slug}`);
      fail++;
      continue;
    }
    try {
      const ext = (matched.src.match(/\.(jpe?g|png|webp)/i) || ['.jpg'])[0];
      const outPath = path.join(STOCK_DIR, `${ind.slug}${ext}`);
      const size = await downloadImage(matched.src, outPath);
      const kb = (size / 1024).toFixed(0);
      const displayName = words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
      console.log(`  ✅ ${displayName.padEnd(28)} → ${ind.slug}${ext} (${kb}KB)`);
      index[ind.slug] = {
        league:    'Premier League',
        leagueSlug:'premier-league',
        slug:      ind.slug,
        name:      displayName,
        photoUrl:  matched.src,
        alt:       matched.alt,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: size,
      };
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${ind.slug} → ${e.message.slice(0, 80)}`);
      fail++;
    }
  }

  // 既存 index に追記
  let prev = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')).inductees || {}; } catch (_) {}
  }
  for (const k of Object.keys(index)) prev[`premier-league:${k}`] = index[k];

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(prev).length,
    inductees: prev,
  }, null, 2));

  console.log(`\n=== サマリー === ok=${ok} fail=${fail}`);
  console.log(`Index: ${INDEX_FILE} (累計 ${Object.keys(prev).length}人)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
