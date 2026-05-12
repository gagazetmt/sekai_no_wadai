// scripts/modules/fetchers/fotmob_distance.js
// FotMob から試合の走行距離データを取得する（オンデマンド利用）
//
// 使い方:
//   const { fetchMatchDistance, searchTeamMatches } = require('./fotmob_distance');
//   const dist = await fetchMatchDistance(4837435);
//   const matches = await searchTeamMatches(8633); // Real Madrid
//
// CLI:
//   node fotmob_distance.js match 4837435
//   node fotmob_distance.js team 8633        # 直近5試合の距離取得
//
// 仕組み:
//   1. puppeteer-extra + stealth で fotmob.com/match/{id} 開く
//   2. page.on('response') で XHR レスポンス傍受
//   3. matchDetails / teamStats / lineups 系の JSON を捕まえる
//   4. distance / sprintsCount / topSpeed フィールド抽出
//   5. ホーム/アウェイ別 + 選手別データを返す

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const { BANDWIDTH_SAVE_ARGS, attachBlocker } = require('./_puppeteer_bandwidth');
puppeteerExtra.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_TIMEOUT  = 60000;
const WAIT_AFTER_LOAD = 8000;
const PROXY_LIST_SIZE = 4000;

function pickProxy() {
  if (!process.env.WEBSHARE_PROXY_URL) return null;
  const n = Math.floor(Math.random() * PROXY_LIST_SIZE) + 1;
  return process.env.WEBSHARE_PROXY_URL.replace('{N}', String(n));
}

async function newBrowser({ useProxy = true } = {}) {
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
    // 帯域節約: mtalk.google.com 等の Chrome 垂れ流し通信を停止
    ...BANDWIDTH_SAVE_ARGS,
  ];
  let proxyUrl = null;
  if (useProxy) {
    proxyUrl = pickProxy();
    if (proxyUrl) {
      const u = new URL(proxyUrl);
      args.push(`--proxy-server=${u.host}`);
    }
  }
  const browser = await puppeteerExtra.launch({ headless: 'new', args });
  return { browser, proxyUrl };
}

async function setupPage(browser, proxyUrl) {
  const page = await browser.newPage();
  if (proxyUrl) {
    const u = new URL(proxyUrl);
    if (u.username && u.password) {
      await page.authenticate({ username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) });
    }
  }
  // 帯域節約: 画像/フォント/CSS + 広告/トラッカー遮断（fotmob.com XHR は通す）
  await attachBlocker(page, { allowHosts: ['www.fotmob.com'] });
  await page.setUserAgent(UA);
  await page.setViewport({ width: 1366, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

// XHR レスポンスを傍受して JSON を集める
function attachInterceptor(page) {
  const captured = { matchDetails: null, lineups: null, teamStats: null, others: [] };
  page.on('response', async (resp) => {
    const url = resp.url();
    const status = resp.status();
    if (status !== 200) return;
    try {
      const ct = resp.headers()['content-type'] || '';
      if (!/json/i.test(ct)) return;
      // FotMob は様々な API パスがある
      if (/matchDetails|matches\/details/i.test(url)) {
        captured.matchDetails = await resp.json();
      } else if (/lineups?|matchLineup/i.test(url)) {
        captured.lineups = await resp.json();
      } else if (/teamStats|match.*stats/i.test(url)) {
        captured.teamStats = await resp.json();
      } else if (/api\/data\/(match|stats|player)/.test(url)) {
        const j = await resp.json();
        if (j && Object.keys(j).length > 0) {
          captured.others.push({ url, body: j });
        }
      }
    } catch (_) {}
  });
  return captured;
}

// JSON から distance / sprint / topSpeed を再帰的に探す
function extractPhysical(obj, path = '', acc = []) {
  if (!obj || typeof obj !== 'object') return acc;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => extractPhysical(item, path + `[${i}]`, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(obj)) {
    const newPath = path ? path + '.' + k : k;
    const lk = k.toLowerCase();
    if (typeof v === 'number' && (lk.includes('distance') || lk.includes('sprint') || lk.includes('speed') || lk === 'km')) {
      acc.push({ path: newPath, key: k, value: v });
    }
    if (typeof v === 'object') extractPhysical(v, newPath, acc);
  }
  return acc;
}

// 主要関数: 試合 ID から距離データ取得
async function fetchMatchDistance(matchId, opts = {}) {
  const { useProxy = true, debug = false } = opts;
  const { browser, proxyUrl } = await newBrowser({ useProxy });
  try {
    const page = await setupPage(browser, proxyUrl);
    const captured = attachInterceptor(page);

    const url = `https://www.fotmob.com/match/${matchId}`;
    if (debug) console.log(`  goto: ${url} (proxy=${proxyUrl ? 'yes' : 'no'})`);
    // 帯域節約パッチで image/css/font を abort してるので networkidle2 が解決しない
    // → domcontentloaded で goto し、後段の WAIT_AFTER_LOAD (8s) で XHR 完了待つ
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // 物理タブのリンクを探してクリック（あれば）
    try {
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a, button'));
        for (const l of links) {
          const t = (l.textContent || '').toLowerCase();
          if (t === 'physical' || t === 'lineup' || t === 'lineups') {
            l.click();
            return true;
          }
        }
        return false;
      });
    } catch (_) {}

    // 追加の XHR を待つ
    await new Promise(r => setTimeout(r, WAIT_AFTER_LOAD));

    if (debug) {
      console.log(`  matchDetails: ${captured.matchDetails ? 'yes' : 'no'}`);
      console.log(`  lineups: ${captured.lineups ? 'yes' : 'no'}`);
      console.log(`  others count: ${captured.others.length}`);
    }

    // 全 captured をまとめて再帰的に物理項目抽出
    const allHits = [];
    if (captured.matchDetails) allHits.push(...extractPhysical(captured.matchDetails, 'matchDetails'));
    if (captured.lineups)      allHits.push(...extractPhysical(captured.lineups, 'lineups'));
    if (captured.teamStats)    allHits.push(...extractPhysical(captured.teamStats, 'teamStats'));
    for (const o of captured.others) {
      allHits.push(...extractPhysical(o.body, o.url.split('/').pop()));
    }

    // 重複除外（path ベース）
    const seenPaths = new Set();
    const uniqueHits = [];
    for (const h of allHits) {
      if (seenPaths.has(h.path)) continue;
      seenPaths.add(h.path);
      uniqueHits.push(h);
    }

    return {
      matchId,
      url,
      ok: uniqueHits.length > 0,
      raw: { matchDetails: captured.matchDetails, lineups: captured.lineups, teamStats: captured.teamStats, others: captured.others },
      hits: uniqueHits,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
  const cmd = process.argv[2];
  const arg = process.argv[3];

  if (cmd === 'match' && arg) {
    const r = await fetchMatchDistance(Number(arg), { debug: true });
    console.log(`\n=== matchId=${arg} ok=${r.ok} hits=${r.hits.length} ===`);
    for (const h of r.hits.slice(0, 30)) {
      console.log(`  ${h.path}: ${h.value}`);
    }
    if (!r.ok) {
      console.log('\n--- Captured XHR URLs ---');
      console.log('matchDetails:', !!r.raw.matchDetails);
      console.log('lineups:',      !!r.raw.lineups);
      console.log('others:',       r.raw.others.length);
      for (const o of r.raw.others.slice(0, 5)) console.log('  -', o.url);
    }
  } else {
    console.error('Usage: node fotmob_distance.js match <matchId>');
    process.exit(1);
  }
}

if (require.main === module) main().catch(e => { console.error('FATAL', e); process.exit(1); });

module.exports = { fetchMatchDistance, extractPhysical };
