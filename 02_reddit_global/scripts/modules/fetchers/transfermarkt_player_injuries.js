// scripts/modules/fetchers/transfermarkt_player_injuries.js
// Transfermarkt の /verletzungen/spieler/{id} ページから怪我履歴を取得する
//
// 使い方:
//   const { fetchPlayerInjuries } = require('./transfermarkt_player_injuries');
//   const r = await fetchPlayerInjuries(playerId, slug);
//
// 仕組み:
//   1. /{slug}/verletzungen/spieler/{id} を Puppeteer で開く
//   2. table.items の tbody から各行を抽出
//      列: Season / Injury / from / until / Days / Games missed
//   3. 日付を dd/MM/yyyy → YYYY-MM-DD に変換、isOngoing フラグ付与
//
// データ特性:
//   - 過去の怪我履歴は完全に DB 保管されている
//   - 進行中の怪我も登録され、untilDate に「予測復帰日」が入る (Slot 等の監督発言反映)
//   - 反映ラグは数日〜1週間程度。直近すぎる怪我はまだ未登録の可能性あり

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
const { BANDWIDTH_SAVE_ARGS, attachBlocker } = require('./_puppeteer_bandwidth');
puppeteerExtra.use(StealthPlugin());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_TIMEOUT = 60000;
const PROXY_LIST_SIZE = 4000;

function pickProxy() {
  if (!process.env.WEBSHARE_PROXY_URL) return null;
  const n = Math.floor(Math.random() * PROXY_LIST_SIZE) + 1;
  return process.env.WEBSHARE_PROXY_URL.replace('{N}', String(n));
}

async function _newBrowser() {
  const proxyUrl = pickProxy();
  const args = [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    // 帯域節約: mtalk.google.com 等の Chrome 垂れ流し通信を停止
    ...BANDWIDTH_SAVE_ARGS,
  ];
  if (proxyUrl) args.push(`--proxy-server=${new URL(proxyUrl).host}`);
  const browser = await puppeteerExtra.launch({ headless: 'new', args });
  return { browser, proxyUrl };
}

async function _newPage(browser, proxyUrl) {
  const page = await browser.newPage();
  if (proxyUrl) {
    const u = new URL(proxyUrl);
    if (u.username) {
      await page.authenticate({
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      });
    }
  }
  // 帯域節約: 画像/フォント/CSS + 広告/トラッカー遮断
  await attachBlocker(page, { allowHosts: ['transfermarkt.com'] });
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

// "11/02/2026" → "2026-02-11" (Europe → ISO)
function _toIsoDate(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

// "110 days" → 110
function _parseDays(s) {
  const m = String(s || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// 怪我履歴を取得
//   返却: { ok, playerId, injuries: [{ season, injury, fromDate, untilDate, days, missedGames, isOngoing, isFuture }, ...] }
//     - isOngoing: untilDate が今日以降 (進行中 or 予測復帰日が未来)
//     - isFuture:  fromDate が今日より未来 (理論上ほぼ無いが念のため)
async function fetchPlayerInjuries(playerId, slug = 'spieler') {
  if (!playerId) return { ok: false, error: 'playerId required' };
  const { browser, proxyUrl } = await _newBrowser();
  try {
    const page = await _newPage(browser, proxyUrl);
    const url = `https://www.transfermarkt.com/${slug}/verletzungen/spieler/${playerId}`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    if (!res || res.status() >= 400) return { ok: false, error: 'http ' + (res?.status() || '?') };
    await new Promise(r => setTimeout(r, 1500));

    const rows = await page.evaluate(() => {
      const tables = document.querySelectorAll('table.items');
      if (!tables.length) return [];
      const t = tables[0];
      return Array.from(t.querySelectorAll('tbody tr')).map(r =>
        Array.from(r.querySelectorAll('td')).map(td => (td.textContent || '').trim())
      );
    });

    const today = new Date().toISOString().slice(0, 10);
    const injuries = rows.map(cells => {
      if (!Array.isArray(cells) || cells.length < 5) return null;
      const fromDate  = _toIsoDate(cells[2]);
      const untilDate = _toIsoDate(cells[3]);
      return {
        season:      cells[0] || null,
        injury:      cells[1] || null,
        fromDate,
        untilDate,
        days:        _parseDays(cells[4]),
        missedGames: parseInt(cells[5], 10) || null,
        isOngoing:   !!(untilDate && untilDate >= today),
        isFuture:    !!(fromDate && fromDate > today),
      };
    }).filter(Boolean);

    return { ok: true, playerId: String(playerId), injuries };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { fetchPlayerInjuries };
