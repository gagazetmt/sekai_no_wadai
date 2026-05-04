// scripts/fetch_bundesliga_player_photos.js
// Bundesliga 公式から選手プロフィール写真を取得（Phase 1）
//
// 使い方:
//   node scripts/fetch_bundesliga_player_photos.js                  # bayern-munich デフォルト
//   node scripts/fetch_bundesliga_player_photos.js borussia-dortmund
//   node scripts/fetch_bundesliga_player_photos.js all              # 全18クラブ
//
// 動作:
//   1. squad page (/en/bundesliga/clubs/{slug}) → 選手の player slug 抽出
//   2. 各 player page を開いて img tag から CDN URL を発見
//      URL pattern: assets.bundesliga.com/player/dfl-obj-XXX-dfl-clu-YYY-dfl-sea-ZZZ-body.png?crop=...&fit=256,256
//   3. fit パラメータを 1024,1024 に書き換えて高解像度版を取得
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
const PREFER_FIT = '1024,1024';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  const url = `https://www.bundesliga.com/en/bundesliga/clubs/${club.slug}`;
  console.log(`  → squad: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  // cookie consent クリック
  try {
    await page.evaluate(() => {
      const sels = [
        '#onetrust-accept-btn-handler',
        'button[id*="onetrust-accept"]',
        'button[class*="cookie"][class*="accept"]',
        'button[mode="primary"]',
      ];
      for (const s of sels) {
        const btn = document.querySelector(s);
        if (btn) { btn.click(); return; }
      }
    });
  } catch (_) {}
  // SPA 描画 + lazy load 完了を待つ
  try {
    await page.waitForSelector('a[href*="/player/"]', { timeout: 15000 });
  } catch (_) {}
  await sleep(2000);

  return page.evaluate(() => {
    const players = [];
    const seen = new Set();
    const links = Array.from(document.querySelectorAll('a[href*="/player/"]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/player\/([^/?#]+)/);
      if (!m) continue;
      const slug = m[1];
      if (seen.has(slug)) continue;
      seen.add(slug);
      players.push({ slug });
    }
    return players;
  });
}

function cleanPlayerName(raw) {
  if (!raw) return '';
  // h1 が "JoshuaKimmich6" 等で背番号連結 → 末尾の数字を剥がす
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\d+$/, '').trim();
  // CamelCase 連結ぎみ（例: "JoshuaKimmich"）→ 大文字前に空白挿入
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2');
  return s.trim();
}

// 選手ページから CDN URL を抽出 → fit を 1024x1024 に書き換えて高解像度を取得
async function getPlayerPhoto(browser, playerSlug) {
  const page = await setupPage(browser);
  try {
    const url = `https://www.bundesliga.com/en/bundesliga/player/${playerSlug}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    return await page.evaluate((preferFit) => {
      const imgs = Array.from(document.querySelectorAll('img'));
      let foundUrl = null;
      for (const i of imgs) {
        const src = i.getAttribute('src') || '';
        if (/assets\.bundesliga\.com\/player\//.test(src) && /-body\.png/.test(src)) {
          foundUrl = src;
          break;
        }
      }
      if (!foundUrl) return { url: null, h1: (document.querySelector('h1') || {}).textContent || '' };
      let upgraded = foundUrl.replace(/fit=\d+,\d+/, `fit=${preferFit}`);
      if (!/fit=/.test(upgraded)) {
        upgraded += (upgraded.includes('?') ? '&' : '?') + `fit=${preferFit}`;
      }
      const m = foundUrl.match(/dfl-obj-([a-z0-9]+)-dfl-clu-([a-z0-9]+)-dfl-sea-([a-z0-9]+)/i);
      return {
        url: upgraded,
        origUrl: foundUrl,
        playerId: m?.[1],
        clubId:   m?.[2],
        seasonId: m?.[3],
        h1: ((document.querySelector('h1') || {}).textContent || '').trim(),
      };
    }, PREFER_FIT);
  } finally {
    try { await page.close(); } catch (_) {}
  }
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

async function fetchClub(browserRef, key, club) {
  console.log(`\n=== ${club.name} ===`);
  const outDir = path.join(STOCK_DIR, LEAGUE_SLUG, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const entries = [];
  let ok = 0, fail = 0;

  // squad リスト取得（独立 page）
  let squad = [];
  try {
    const squadPage = await setupPage(browserRef.browser);
    try {
      squad = await getSquadList(squadPage, club);
    } finally {
      try { await squadPage.close(); } catch (_) {}
    }
    console.log(`  スカッド: ${squad.length} 件`);
  } catch (e) {
    console.warn(`  ❌ squad 失敗: ${e.message}`);
    return { club: key, ok, fail: 1, squadCount: 0, error: e.message, entries };
  }
  if (!squad.length) {
    return { club: key, ok, fail: 0, squadCount: 0, error: 'no players found', entries };
  }

  let consecutiveErrors = 0;

  for (let idx = 0; idx < squad.length; idx++) {
    const p = squad[idx];
    await sleep(SLEEP_MS);

    // 連続エラー or 一定数毎にブラウザ再起動
    if (consecutiveErrors >= 3 || (idx > 0 && idx % 15 === 0)) {
      console.log(`  ↻ browser restart (idx=${idx}, consecutiveErrors=${consecutiveErrors})`);
      try { await browserRef.browser.close(); } catch (_) {}
      browserRef.browser = await newBrowser();
      consecutiveErrors = 0;
      await sleep(2000);
    }

    try {
      const info = await getPlayerPhoto(browserRef.browser, p.slug);
      const playerName = cleanPlayerName(info.h1) || p.slug.replace(/-/g, ' ');
      if (!info.url) {
        console.warn(`  ⚠️ no img: ${playerName} (${p.slug})`);
        fail++;
        continue;
      }
      const slug = safeName(playerName);
      if (!slug || slug.length < 2) {
        console.warn(`  ⚠️ slug 空: ${playerName}`);
        fail++;
        continue;
      }
      const outPath = path.join(outDir, `${slug}.png`);
      let dl;
      try {
        const size = await downloadImage(info.url, outPath);
        dl = { url: info.url, size };
      } catch (_) {
        const size = await downloadImage(info.origUrl, outPath);
        dl = { url: info.origUrl, size };
      }
      const kb = (dl.size / 1024).toFixed(0);
      const fitTag = (dl.url.match(/fit=(\d+,\d+)/) || [])[1] || '?';
      console.log(`  ✅ ${playerName.padEnd(28)} → ${slug}.png (${kb}KB) [${fitTag}]`);
      entries.push({
        club: key,
        league: LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
        playerPageUrl: `https://www.bundesliga.com/en/bundesliga/player/${p.slug}`,
        playerSlug: p.slug,
        playerId: info.playerId,
        clubId:   info.clubId,
        seasonId: info.seasonId,
        name: playerName,
        slug,
        photoUrl: dl.url,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: dl.size,
      });
      ok++;
      consecutiveErrors = 0;
    } catch (e) {
      console.warn(`  ❌ ${(p.slug || '').slice(0, 40)} → ${e.message.slice(0, 80)}`);
      fail++;
      consecutiveErrors++;
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

  const browserRef = { browser: await newBrowser() };
  const all = [];
  const allEntries = [];
  try {
    for (const [key, club] of Object.entries(targets)) {
      // クラブ毎にブラウザ再起動（メモリリセット）
      try { await browserRef.browser.close(); } catch (_) {}
      browserRef.browser = await newBrowser();
      const r = await fetchClub(browserRef, key, club);
      all.push(r);
      allEntries.push(...(r.entries || []));
    }
  } finally {
    try { await browserRef.browser.close(); } catch (_) {}
  }

  // 既存 index に追記
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
    console.log(`  ${r.club.padEnd(30)} ${status}`);
  });
  console.log(`\nIndex: ${INDEX_FILE} (累計 ${Object.keys(index).length}選手)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
