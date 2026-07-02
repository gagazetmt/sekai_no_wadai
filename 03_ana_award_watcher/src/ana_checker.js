const fs = require('fs');
const path = require('path');
const { humanPause } = require('./human_delay');

const SELECTORS_PATH = path.join(__dirname, '..', 'config', 'selectors.json');
const LOGS_DIR = path.join(__dirname, '..', 'logs');

function loadSelectors() {
  if (!fs.existsSync(SELECTORS_PATH)) return null;
  return JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf-8'));
}

// ANAの空席照会画面はJSで描画される重いSPA/AEMコンポーネントで、認証なしには
// 実機で構造を確認できなかった。selectors.json が未整備の間は、ログイン後の
// 画面のスクリーンショット・HTML・XHR/fetchレスポンスを logs/capture_* に保存するだけの
// 「キャリブレーションモード」で動く。これを見ながら config/selectors.json を埋めていく。
async function runCaptureMode(page, target) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(LOGS_DIR, `capture_${stamp}`);
  fs.mkdirSync(dir, { recursive: true });

  const captured = [];
  const onResponse = async (res) => {
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try {
      const url = res.url();
      const body = await res.text();
      if (body.length > 200000) return;
      captured.push({ url, status: res.status(), body });
    } catch (_) {
      // レスポンス取得に失敗しても継続
    }
  };
  page.on('response', onResponse);

  const selectors = loadSelectors();
  const searchUrl = (selectors && selectors.searchPageUrl) || 'https://www.ana.co.jp/ja/jp/guide/reservation/domestic/';
  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanPause(1500, 3000);

  await page.screenshot({ path: path.join(dir, 'search_page.png'), fullPage: true });
  fs.writeFileSync(path.join(dir, 'search_page.html'), await page.content());
  fs.writeFileSync(path.join(dir, 'network_capture.json'), JSON.stringify(captured, null, 2));

  page.off('response', onResponse);

  return {
    targetId: target.id,
    mode: 'capture',
    captureDir: dir,
    note: 'selectors.json が未整備のためキャリブレーション用データのみ保存しました',
  };
}

async function fillIfPresent(page, selector, value) {
  if (!selector) return false;
  const el = await page.$(selector);
  if (!el) return false;
  await el.click({ clickCount: 3 }).catch(() => {});
  await page.type(selector, value, { delay: 80 }).catch(() => {});
  return true;
}

async function checkTarget(page, target, selectors) {
  await page.goto(selectors.searchPageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await humanPause(1200, 2500);

  if (selectors.awardToggleSelector) {
    await page.click(selectors.awardToggleSelector).catch(() => {});
    await humanPause(400, 900);
  }

  await fillIfPresent(page, selectors.departureSelectSelector, target.departureAirport);
  await humanPause(300, 700);
  await fillIfPresent(page, selectors.arrivalSelectSelector, target.arrivalAirport);
  await humanPause(300, 700);
  await fillIfPresent(page, selectors.dateInputSelector, target.date);
  await humanPause(400, 900);

  if (selectors.submitSelector) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
      page.click(selectors.submitSelector),
    ]);
  }
  await humanPause(1000, 2000);

  if (selectors.resultContainerSelector) {
    await page.waitForSelector(selectors.resultContainerSelector, { timeout: 20000 }).catch(() => {});
  }

  const available = selectors.availableCellSelector
    ? !!(await page.$(selectors.availableCellSelector))
    : null;

  return { targetId: target.id, mode: 'live', available, checkedAt: new Date().toISOString() };
}

async function runCheck(page, target) {
  const selectors = loadSelectors();
  const isCalibrated =
    selectors &&
    selectors.dateInputSelector &&
    selectors.submitSelector &&
    selectors.availableCellSelector;

  if (!isCalibrated) {
    return runCaptureMode(page, target);
  }
  return checkTarget(page, target, selectors);
}

module.exports = { runCheck };
