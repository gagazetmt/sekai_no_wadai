// scripts/fetch_bundesliga_player_photos.js
// Bundesliga 公式サイトから選手プロフィール写真を取得（Phase 1）
//
// 使い方:
//   node scripts/fetch_bundesliga_player_photos.js                    # fc-bayern デフォルト
//   node scripts/fetch_bundesliga_player_photos.js borussia-dortmund  # 1クラブ指定
//   node scripts/fetch_bundesliga_player_photos.js all                # 全18クラブ
//
// 動作:
//   1. squad page (/en/bundesliga/clubs/{slug}/squad) → 選手の player slug 抽出
//   2. 各 player page を開いて img tag から img.bundesliga.com CDN URL を発見
//   3. クエリパラメータを外してフル解像度を取得試行、失敗時は元 URL にフォールバック
//   4. 階層化保存: images_stock/players_official/bundesliga/{club-key}/{player-slug}.png

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');

const { LEAGUE_SLUG, LEAGUE_NAME, BUNDESLIGA_CLUBS } = require('./_bundesliga_clubs');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'players_official');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const SLEEP_MS   = 1500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// img.bundesliga.com の CDN URL パターン（tachyon WordPress 画像サービス）
//   https://img.bundesliga.com/tachyon/sites/2/players/YYYY/MM/player-name.png?fit=WxH&crop=faces
//   → クエリなしで full size が取得できることが多い
const BUNDESLIGA_IMG_CDN = /img\.bundesliga\.com\/tachyon\/sites\/\d+\/players\//;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

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

async function getSquadList(page, club) {
  const url = `https://www.bundesliga.com/en/bundesliga/clubs/${club.slug}/squad`;
  console.log(`  → squad: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });

  // cookie consent クリック（OneTrust 対応）
  try {
    await page.evaluate(() => {
      const sels = [
        '#onetrust-accept-btn-handler',
        'button[id*="onetrust-accept"]',
        'button[class*="cookie"][class*="accept"]',
        'button.js-accept-all-close',
      ];
      for (const s of sels) {
        const btn = document.querySelector(s);
        if (btn) { btn.click(); return; }
      }
    });
  } catch (_) {}

  // SPA 描画 + lazy load 完了を待つ
  try {
    await page.waitForSelector('a[href*="/players/"]', { timeout: 15000 });
  } catch (_) {}
  await sleep(2000);

  return page.evaluate(() => {
    const players = [];
    const seen = new Set();
    // bundesliga.com: /en/bundesliga/players/{player-slug}/overview or /profile
    const links = Array.from(document.querySelectorAll('a[href*="/players/"]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/players\/([^/?#]+)/);
      if (!m) continue;
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      const img  = a.querySelector('img');
      const name = (img && img.getAttribute('alt') || '').trim()
        || (a.textContent || '').replace(/\s+/g, ' ').trim().replace(/\s*\d+.*$/, '');
      players.push({ slug, name });
    }
    return players;
  });
}

// 選手ページから img.bundesliga.com の CDN URL を抽出
async function getPlayerPhoto(page, playerSlug) {
  const url = `https://www.bundesliga.com/en/bundesliga/players/${playerSlug}/profile`;
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  return page.evaluate((cdnPattern) => {
    const re = new RegExp(cdnPattern);
    const imgs = Array.from(document.querySelectorAll('img'));
    let foundUrl = null;
    for (const i of imgs) {
      const src = i.getAttribute('src') || '';
      if (re.test(src)) { foundUrl = src; break; }
    }
    if (!foundUrl) {
      // og:image フォールバック
      const og = document.querySelector('meta[property="og:image"]');
      if (og) foundUrl = og.getAttribute('content') || null;
    }
    if (!foundUrl) return { url: null, h1: (document.querySelector('h1') || {}).textContent || '' };

    // クエリパラメータを外してフル解像度を試みる
    const fullRes = foundUrl.replace(/\?.*$/, '');
    return {
      url: fullRes,
      origUrl: foundUrl,
      h1: ((document.querySelector('h1') || {}).textContent || '').trim(),
    };
  }, BUNDESLIGA_IMG_CDN.source);
}

async function downloadImage(url, outPath) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'image/*' },
    responseType: 'arraybuffer',
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400,
  });
  fs.writeFileSync(outPath, Buffer.from(res.data));
  return res.data.length;
}

async function fetchClub(browser, key, club) {
  console.log(`\n=== ${club.name} ===`);
  const outDir = path.join(STOCK_DIR, LEAGUE_SLUG, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const page = await setupPage(browser);
  const entries = [];
  let ok = 0, fail = 0;

  let squad = [];
  try {
    squad = await getSquadList(page, club);
    console.log(`  スカッド: ${squad.length} 件`);
  } catch (e) {
    console.warn(`  ❌ squad 失敗: ${e.message}`);
    await page.close();
    return { club: key, ok, fail: 1, squadCount: 0, error: e.message, entries };
  }
  if (!squad.length) {
    await page.close();
    return { club: key, ok, fail: 0, squadCount: 0, error: 'no players found', entries };
  }

  for (const p of squad) {
    await sleep(SLEEP_MS);
    try {
      const info = await getPlayerPhoto(page, p.slug);
      const playerName = info.h1 || p.name || p.slug.replace(/-/g, ' ');
      if (!info.url) {
        console.warn(`  ⚠️ no img: ${playerName}`);
        fail++;
        continue;
      }
      const slug = safeName(playerName);
      if (!slug || slug.length < 2) {
        console.warn(`  ⚠️ slug 空: ${playerName}`);
        fail++;
        continue;
      }
      const ext = (info.url.match(/\.(png|jpg|jpeg|webp)$/i) || ['', 'png'])[1].toLowerCase();
      const outPath = path.join(outDir, `${slug}.${ext}`);

      let dl;
      try {
        const size = await downloadImage(info.url, outPath);
        dl = { url: info.url, size };
      } catch (_) {
        // フル解像度失敗 → 元 URL でリトライ
        if (info.origUrl && info.origUrl !== info.url) {
          const size = await downloadImage(info.origUrl, outPath);
          dl = { url: info.origUrl, size };
        } else {
          throw _;
        }
      }

      const kb = (dl.size / 1024).toFixed(0);
      console.log(`  ✅ ${playerName.padEnd(28)} → ${slug}.${ext} (${kb}KB)`);
      entries.push({
        club: key,
        league: LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
        playerPageUrl: `https://www.bundesliga.com/en/bundesliga/players/${p.slug}/profile`,
        playerSlug: p.slug,
        name: playerName,
        slug,
        photoUrl: dl.url,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: dl.size,
      });
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${(p.name || p.slug || '').slice(0, 40)} → ${e.message.slice(0, 80)}`);
      fail++;
    }
  }

  await page.close();
  return { club: key, ok, fail, squadCount: squad.length, entries };
}

async function main() {
  const arg = process.argv[2] || 'fc-bayern';
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

  const browser = await newBrowser();
  const all = [];
  const allEntries = [];
  try {
    for (const [key, club] of Object.entries(targets)) {
      const r = await fetchClub(browser, key, club);
      all.push(r);
      allEntries.push(...(r.entries || []));
    }
  } finally {
    await browser.close();
  }

  // 既存 index に追記（リーグ違いの slug 重複を避けるため league-prefixed key を使用）
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
    console.log(`  ${r.club.padEnd(25)} ${status}`);
  });
  console.log(`\nIndex: ${INDEX_FILE} (累計 ${Object.keys(index).length}選手)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
