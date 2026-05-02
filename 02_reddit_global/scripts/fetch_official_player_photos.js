// scripts/fetch_official_player_photos.js
// 主要クラブの公式 HP から選手プロフィール写真を一括取得（Phase 1 バックフィル）
//
// 使い方:
//   node scripts/fetch_official_player_photos.js          # 全クラブ
//   node scripts/fetch_official_player_photos.js man-city # 1クラブだけ
//
// 動作:
//   1. 各クラブの squad page を puppeteer で開く
//   2. 選手リンク + 名前を抽出
//   3. 各選手ページから og:image を取得
//   4. images_stock/players_official/{club}/{player-slug}.jpg に保存
//   5. 取得結果を data/players_official_index.json に書く（後の検索用）

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');

const STOCK_DIR = path.join(__dirname, '..', 'images_stock', 'players_official');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const SLEEP_MS  = 1500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// クラブ別の selector 設定。最初は推測ベース、結果見て調整する想定
const CLUB_CONFIGS = {
  'man-city': {
    name: 'Manchester City',
    squadUrl: 'https://www.mancity.com/teams/men/squad',
    base: 'https://www.mancity.com',
    // squad page から選手リンクを拾う selector 候補（複数指定で OR）
    playerLinkSelectors: [
      'a[href*="/players/men/"]',
      '.player-card a',
      'a[href*="/squad/"]',
    ],
  },
  'real-madrid': {
    name: 'Real Madrid',
    squadUrl: 'https://www.realmadrid.com/en-US/football/first-team/squad',
    base: 'https://www.realmadrid.com',
    playerLinkSelectors: [
      'a[href*="/players/"]',
      'a[href*="/football/first-team/squad/"]',
    ],
  },
  'bayern': {
    name: 'Bayern Munich',
    squadUrl: 'https://fcbayern.com/en/teams/professionals',
    base: 'https://fcbayern.com',
    playerLinkSelectors: [
      'a[href*="/players/"]',
      '.player-link',
    ],
  },
  'man-utd': {
    name: 'Manchester United',
    squadUrl: 'https://www.manutd.com/en/players-and-staff/first-team',
    base: 'https://www.manutd.com',
    playerLinkSelectors: [
      'a[href*="/Players/"]',
      'a[href*="/players-and-staff/"]',
    ],
  },
  'arsenal': {
    name: 'Arsenal',
    squadUrl: 'https://www.arsenal.com/the-squad',
    base: 'https://www.arsenal.com',
    playerLinkSelectors: [
      'a[href*="/the-squad/"]',
      '.player-card a',
    ],
  },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) {
  return String(s || '').toLowerCase()
    .replace(/[^a-z0-9À-ÿĀ-ſ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function newBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',  // bot 検出回避
      '--disable-dev-shm-usage',
    ],
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
  });
  return page;
}

// squad page を開いて 選手リスト [{name, url}] を取る
async function getSquadList(page, cfg) {
  console.log(`  → squad page: ${cfg.squadUrl}`);
  await page.goto(cfg.squadUrl, { waitUntil: 'networkidle2', timeout: 45000 });

  // selector 候補を順番に試して一番取れたやつを採用
  const results = await page.evaluate((selectors, base) => {
    function abs(href) {
      if (!href) return null;
      if (href.startsWith('http')) return href;
      if (href.startsWith('/')) return base + href;
      return null;
    }
    const out = [];
    for (const sel of selectors) {
      try {
        const links = Array.from(document.querySelectorAll(sel));
        const list = [];
        const seen = new Set();
        for (const a of links) {
          const url = abs(a.getAttribute('href'));
          if (!url || seen.has(url)) continue;
          seen.add(url);
          // 名前候補: aタグ内テキスト / img alt / title 属性
          const name = (a.textContent || '').replace(/\s+/g, ' ').trim()
            || a.getAttribute('title')
            || (a.querySelector('img') && a.querySelector('img').getAttribute('alt'))
            || '';
          list.push({ name, url });
        }
        out.push({ selector: sel, list });
      } catch (e) {
        out.push({ selector: sel, error: e.message });
      }
    }
    return out;
  }, cfg.playerLinkSelectors, cfg.base);

  // 一番件数多い selector を採用（スパム除外のため 4以上を要求）
  let best = null;
  for (const r of results) {
    if (r.list && r.list.length >= 4 && (!best || r.list.length > best.list.length)) {
      best = r;
    }
  }
  if (!best) {
    console.warn(`  ⚠️ squad リスト取得失敗。試した selector の結果:`);
    results.forEach(r => console.warn(`     ${r.selector}: ${r.list ? r.list.length + '件' : 'error: ' + r.error}`));
    return [];
  }
  console.log(`  selector="${best.selector}" → ${best.list.length}件`);
  return best.list;
}

// 選手ページから og:image を取る
async function getPlayerPhoto(page, playerUrl) {
  await page.goto(playerUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page.evaluate(() => {
    function get(sel, attr) {
      const el = document.querySelector(sel);
      return el ? el.getAttribute(attr) : null;
    }
    const og   = get('meta[property="og:image"]', 'content');
    const tw   = get('meta[name="twitter:image"]', 'content');
    const tw2  = get('meta[property="twitter:image"]', 'content');
    const h1   = (document.querySelector('h1') || {}).textContent || '';
    return {
      photoUrl: og || tw || tw2 || null,
      pageTitle: (document.title || '').trim(),
      h1: h1.replace(/\s+/g, ' ').trim(),
    };
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

async function fetchClub(browser, key, cfg) {
  console.log(`\n=== ${cfg.name} ===`);
  const outDir = path.join(STOCK_DIR, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const page = await setupPage(browser);
  const indexEntries = [];
  let ok = 0, fail = 0;

  let squad = [];
  try {
    squad = await getSquadList(page, cfg);
  } catch (e) {
    console.warn(`  ❌ squad page 取得失敗: ${e.message}`);
    await page.close();
    return { club: key, ok, fail: 1, squadCount: 0, error: e.message, entries: [] };
  }
  if (!squad.length) {
    await page.close();
    return { club: key, ok, fail: 0, squadCount: 0, error: 'no players found', entries: [] };
  }

  for (const p of squad) {
    await sleep(SLEEP_MS);
    try {
      const info = await getPlayerPhoto(page, p.url);
      const playerName = p.name || info.h1 || info.pageTitle.split(/[|·\-]/)[0].trim() || 'unknown';
      if (!info.photoUrl) {
        console.warn(`  ⚠️ no og:image: ${playerName}`);
        fail++;
        continue;
      }
      const slug = safeName(playerName);
      if (!slug || slug === 'unknown' || slug.length < 2) {
        console.warn(`  ⚠️ slug 空: ${playerName}`);
        fail++;
        continue;
      }
      // URL から拡張子推定
      let ext = '.jpg';
      try {
        const u = new URL(info.photoUrl);
        const m = u.pathname.match(/\.(jpg|jpeg|png|webp)(?:$|\?)/i);
        if (m) ext = '.' + m[1].toLowerCase();
      } catch (_) {}

      const outPath = path.join(outDir, `${slug}${ext}`);
      const size = await downloadImage(info.photoUrl, outPath);
      console.log(`  ✅ ${playerName.padEnd(30)} → ${slug}${ext} (${(size/1024).toFixed(0)}KB)`);
      indexEntries.push({
        club: key,
        name: playerName,
        slug,
        playerPageUrl: p.url,
        photoUrl: info.photoUrl,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: size,
      });
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${p.name || p.url} → ${e.message.slice(0, 80)}`);
      fail++;
    }
  }

  await page.close();
  return { club: key, ok, fail, squadCount: squad.length, entries: indexEntries };
}

async function main() {
  const targetKey = process.argv[2];
  const targets = targetKey ? { [targetKey]: CLUB_CONFIGS[targetKey] } : CLUB_CONFIGS;
  if (targetKey && !CLUB_CONFIGS[targetKey]) {
    console.error(`Unknown club: ${targetKey}\nAvailable: ${Object.keys(CLUB_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });

  const browser = await newBrowser();
  const all = [];
  const allEntries = [];
  try {
    for (const [key, cfg] of Object.entries(targets)) {
      const r = await fetchClub(browser, key, cfg);
      all.push(r);
      allEntries.push(...(r.entries || []));
    }
  } finally {
    await browser.close();
  }

  // インデックス保存（後の選手名→画像探索用）
  let index = {};
  if (fs.existsSync(INDEX_FILE)) {
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (_) {}
  }
  for (const e of allEntries) {
    index[e.slug] = e;  // slug キーで上書き
  }
  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(index).length,
    byClub: all.map(r => ({ club: r.club, ok: r.ok, fail: r.fail, squadCount: r.squadCount })),
    players: index,
  }, null, 2));

  console.log('\n=== サマリー ===');
  all.forEach(r => {
    const status = r.error ? `❌ ${r.error.slice(0, 60)}` : `ok=${r.ok}/${r.squadCount} fail=${r.fail}`;
    console.log(`  ${r.club.padEnd(15)} ${status}`);
  });
  console.log(`\nIndex: ${INDEX_FILE} (累計 ${Object.keys(index).length}選手)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
