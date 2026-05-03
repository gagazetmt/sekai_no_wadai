// scripts/fetch_pl_player_photos.js
// Premier League 公式サイトから選手プロフィール写真を取得（パイロット）
//
// 使い方:
//   node scripts/fetch_pl_player_photos.js                 # man-utd だけ
//   node scripts/fetch_pl_player_photos.js liverpool       # 1クラブ指定
//   node scripts/fetch_pl_player_photos.js all             # 6クラブ全部
//
// 動作:
//   1. クラブ squad page → 選手リンク抽出
//   2. 各選手ページから og:image 取得
//   3. URL のサイズ指定 (250x250) を高解像度 (1184x1184 or photos) に書き換えて取得試行
//   4. images_stock/players_official/{club}/{slug}.{ext} に保存
//   5. data/players_official_index.json にインデックス書き込み

require('dotenv').config();
const fs        = require('fs');
const path      = require('path');
const axios     = require('axios');
const puppeteer = require('puppeteer');

const STOCK_DIR  = path.join(__dirname, '..', 'images_stock', 'players_official');
const INDEX_FILE = path.join(__dirname, '..', 'data', 'players_official_index.json');
const SLEEP_MS   = 1500;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LEAGUE_SLUG = 'premier-league';

// Premier League 全クラブ（現行 20 + 過去 PL 経験 29 = 49）
//   ID/slug は premierleague.com/clubs から取得した正規値
//   現行クラブは 2025-26 シーズン基準
const PL_CLUBS = {
  // ── 現行 PL 20クラブ (2025-26) ──
  'arsenal':                  { id: 3,   slug: 'Arsenal',                  name: 'Arsenal' },
  'aston-villa':              { id: 7,   slug: 'Aston-Villa',              name: 'Aston Villa' },
  'bournemouth':              { id: 91,  slug: 'Bournemouth',              name: 'Bournemouth' },
  'brentford':                { id: 94,  slug: 'Brentford',                name: 'Brentford' },
  'brighton':                 { id: 36,  slug: 'Brighton-and-Hove-Albion', name: 'Brighton & Hove Albion' },
  'burnley':                  { id: 90,  slug: 'Burnley',                  name: 'Burnley' },
  'chelsea':                  { id: 8,   slug: 'Chelsea',                  name: 'Chelsea' },
  'crystal-palace':           { id: 31,  slug: 'Crystal-Palace',           name: 'Crystal Palace' },
  'everton':                  { id: 11,  slug: 'Everton',                  name: 'Everton' },
  'fulham':                   { id: 54,  slug: 'Fulham',                   name: 'Fulham' },
  'leeds':                    { id: 2,   slug: 'Leeds-United',             name: 'Leeds United' },
  'liverpool':                { id: 14,  slug: 'Liverpool',                name: 'Liverpool' },
  'man-city':                 { id: 43,  slug: 'Manchester-City',          name: 'Manchester City' },
  'man-utd':                  { id: 1,   slug: 'Manchester-United',        name: 'Manchester United' },
  'newcastle':                { id: 4,   slug: 'Newcastle-United',         name: 'Newcastle United' },
  'nottingham-forest':        { id: 17,  slug: 'Nottingham-Forest',        name: 'Nottingham Forest' },
  'sunderland':               { id: 56,  slug: 'Sunderland',               name: 'Sunderland' },
  'tottenham':                { id: 6,   slug: 'Tottenham-Hotspur',        name: 'Tottenham Hotspur' },
  'west-ham':                 { id: 21,  slug: 'West-Ham-United',          name: 'West Ham United' },
  'wolves':                   { id: 39,  slug: 'Wolverhampton-Wanderers',  name: 'Wolverhampton Wanderers' },

  // ── 過去 PL 経験あり 29クラブ（現在下部リーグでも squad 取れる場合あり） ──
  'barnsley':                 { id: 37,  slug: 'Barnsley',                 name: 'Barnsley' },
  'birmingham':               { id: 41,  slug: 'Birmingham-City',          name: 'Birmingham City' },
  'blackburn':                { id: 5,   slug: 'Blackburn-Rovers',         name: 'Blackburn Rovers' },
  'blackpool':                { id: 92,  slug: 'Blackpool',                name: 'Blackpool' },
  'bolton':                   { id: 30,  slug: 'Bolton-Wanderers',         name: 'Bolton Wanderers' },
  'bradford':                 { id: 55,  slug: 'Bradford-City',            name: 'Bradford City' },
  'cardiff':                  { id: 97,  slug: 'Cardiff-City',             name: 'Cardiff City' },
  'charlton':                 { id: 33,  slug: 'Charlton-Athletic',        name: 'Charlton Athletic' },
  'coventry':                 { id: 9,   slug: 'Coventry-City',            name: 'Coventry City' },
  'derby':                    { id: 24,  slug: 'Derby-County',             name: 'Derby County' },
  'huddersfield':             { id: 38,  slug: 'Huddersfield-Town',        name: 'Huddersfield Town' },
  'hull':                     { id: 88,  slug: 'Hull-City',                name: 'Hull City' },
  'ipswich':                  { id: 40,  slug: 'Ipswich-Town',             name: 'Ipswich Town' },
  'leicester':                { id: 13,  slug: 'Leicester-City',           name: 'Leicester City' },
  'luton':                    { id: 102, slug: 'Luton-Town',               name: 'Luton Town' },
  'middlesbrough':            { id: 25,  slug: 'Middlesbrough',            name: 'Middlesbrough' },
  'norwich':                  { id: 45,  slug: 'Norwich-City',             name: 'Norwich City' },
  'oldham':                   { id: 105, slug: 'Oldham-Athletic',          name: 'Oldham Athletic' },
  'portsmouth':               { id: 47,  slug: 'Portsmouth',               name: 'Portsmouth' },
  'qpr':                      { id: 52,  slug: 'Queens-Park-Rangers',      name: 'Queens Park Rangers' },
  'reading':                  { id: 108, slug: 'Reading',                  name: 'Reading' },
  'sheffield-united':         { id: 49,  slug: 'Sheffield-United',         name: 'Sheffield United' },
  'sheffield-wednesday':      { id: 19,  slug: 'Sheffield-Wednesday',      name: 'Sheffield Wednesday' },
  'southampton':              { id: 20,  slug: 'Southampton',              name: 'Southampton' },
  'stoke':                    { id: 110, slug: 'Stoke-City',               name: 'Stoke City' },
  'swansea':                  { id: 80,  slug: 'Swansea-City',             name: 'Swansea City' },
  'swindon':                  { id: 46,  slug: 'Swindon-Town',             name: 'Swindon Town' },
  'watford':                  { id: 57,  slug: 'Watford',                  name: 'Watford' },
  'west-brom':                { id: 35,  slug: 'West-Bromwich-Albion',     name: 'West Bromwich Albion' },
  'wigan':                    { id: 111, slug: 'Wigan-Athletic',           name: 'Wigan Athletic' },
  'wimbledon':                { id: 1736,slug: 'Wimbledon',                name: 'Wimbledon' },
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function safeName(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
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
  const url = `https://www.premierleague.com/clubs/${club.id}/${club.slug}/squad`;
  console.log(`  → squad: ${url}`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('button.js-accept-all-close, button[id*="onetrust-accept"]');
      if (btn) btn.click();
    });
    await sleep(800);
  } catch (_) {}

  // squad page の各選手リンクから {id, slug, name} を抽出
  //   href パターン: /en/players/{id}/{slug}/overview
  //   img パターン:  resources.premierleague.com/premierleague25/photos/players/40x40/{id}.png
  return page.evaluate(() => {
    const players = [];
    const seen = new Set();
    const links = Array.from(document.querySelectorAll('a[href*="/players/"]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/players\/(\d+)\/([^\/]+)\/overview/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      seen.add(id);
      const slug = m[2];
      // 名前候補：img alt > textContent > title
      const img = a.querySelector('img');
      const altName = img && img.getAttribute('alt') || '';
      const txtName = (a.textContent || '').replace(/\s+/g, ' ').trim()
        // squad page では "Bruno Fernandes 8 Portugal" のように国籍まで連結される
        // → 数字以降を切り落とす
        .replace(/\s*\d+.*$/, '');
      const name = altName || txtName || slug.replace(/-/g, ' ');
      players.push({ id, slug, name });
    }
    return players;
  });
}

// PL の選手 ID から、サイズを指定して画像 URL を直接構成
//   - 推し: 500x500 (~280KB, 高解像度)
//   - フォールバック: 110x140 (顔クローズアップ), 40x40 (サムネ最終手段)
function plPhotoUrls(id) {
  const base = 'https://resources.premierleague.com/premierleague25/photos/players';
  return [
    `${base}/500x500/${id}.png`,    // 高解像度 ★
    `${base}/110x140/${id}.png`,    // 中
    `${base}/40x40/${id}.png`,      // サムネ
  ];
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

async function tryDownloadHighRes(urls, outPath) {
  for (const u of urls) {
    try {
      const size = await downloadImage(u, outPath);
      return { url: u, size };
    } catch (_) {
      // try next
    }
  }
  throw new Error('all variants failed');
}

async function fetchClub(browser, key, club) {
  console.log(`\n=== ${club.name} ===`);
  // 階層化: images_stock/players_official/{league-slug}/{club-key}/
  const outDir = path.join(STOCK_DIR, LEAGUE_SLUG, key);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // 旧スクレイプ結果を残しつつ追記する想定（同 slug は上書き）

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
    await sleep(300);  // PL の CDN だけ叩くから軽くてOK
    try {
      const playerName = p.name || p.slug.replace(/-/g, ' ');
      const slug = safeName(playerName);
      if (!slug || slug.length < 2) {
        console.warn(`  ⚠️ slug 空: ${playerName}`);
        fail++;
        continue;
      }
      const outPath = path.join(outDir, `${slug}.png`);
      const dl = await tryDownloadHighRes(plPhotoUrls(p.id), outPath);
      const kb = (dl.size / 1024).toFixed(0);
      const sizeTag = dl.url.match(/\/(\d+x\d+)\//)?.[1] || '?';
      console.log(`  ✅ ${playerName.padEnd(28)} → ${slug}.png (${kb}KB) [${sizeTag}]`);
      entries.push({
        club: key,
        league: 'Premier League',
        plPlayerId: p.id,
        name: playerName,
        slug,
        playerPageUrl: `https://www.premierleague.com/en/players/${p.id}/${p.slug}/overview`,
        photoUrl: dl.url,
        localPath: path.relative(path.join(__dirname, '..'), outPath).replace(/\\/g, '/'),
        sizeBytes: dl.size,
      });
      ok++;
    } catch (e) {
      console.warn(`  ❌ ${(p.name || p.slug).slice(0, 40)} → ${e.message.slice(0, 80)}`);
      fail++;
    }
  }

  await page.close();
  return { club: key, ok, fail, squadCount: squad.length, entries };
}

async function main() {
  const arg = process.argv[2] || 'man-utd';
  let targets;
  if (arg === 'all') {
    targets = PL_CLUBS;
  } else if (PL_CLUBS[arg]) {
    targets = { [arg]: PL_CLUBS[arg] };
  } else {
    console.error(`Unknown club: ${arg}\nAvailable: ${Object.keys(PL_CLUBS).join(', ')} | all`);
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

  let index = {};
  if (fs.existsSync(INDEX_FILE)) {
    try {
      const cur = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      index = cur.players || {};
    } catch (_) {}
  }
  for (const e of allEntries) index[e.slug] = e;

  fs.writeFileSync(INDEX_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    total: Object.keys(index).length,
    byClub: all.map(r => ({ club: r.club, ok: r.ok, fail: r.fail, squadCount: r.squadCount, error: r.error || null })),
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
