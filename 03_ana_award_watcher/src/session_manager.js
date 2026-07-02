const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { humanPause, typeHuman } = require('./human_delay');

const SESSIONS_DIR = path.join(__dirname, '..', 'data', 'sessions');

// ログインフォームのURL・セレクタは実際にANA公式サイトのHTMLから確認済み(2026-07時点)。
// ANA側のサイトリニューアルで変わる可能性があるので、ログインに失敗し続ける場合はまずここを疑う。
const LOGIN_URL = 'https://cam.ana.co.jp/psz/fwd/jsp/login_cooperation/psgwLoginJa.jsp?ssoProduct=ECSV';
const CUSNUM_SELECTOR = '#w2AMCNum';
const PASSWORD_SELECTOR = '#w2logpass';
const SUBMIT_SELECTOR = '#submitBtn';

const MEMBER_CHECK_URL = 'https://www.ana.co.jp/ja/jp/amc/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cookiePathFor(accountId) {
  return path.join(SESSIONS_DIR, `${accountId}.cookies.json`);
}

async function launchBrowser() {
  const debug = process.env.DEBUG_MODE === 'true';
  return puppeteer.launch({
    headless: !debug,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: { width: 1366, height: 900 },
  });
}

async function prepPage(page) {
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
}

async function loadCookies(page, accountId) {
  const p = cookiePathFor(accountId);
  if (!fs.existsSync(p)) return false;
  const cookies = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (cookies.length === 0) return false;
  await page.setCookie(...cookies);
  return true;
}

async function saveCookies(page, accountId) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const cookies = await page.cookies();
  fs.writeFileSync(cookiePathFor(accountId), JSON.stringify(cookies, null, 2));
}

async function isOnLoginForm(page) {
  return !!(await page.$(CUSNUM_SELECTOR));
}

// Cookieが残っていればそれを使い回し、再ログインを最小回数に抑える。
// 期限切れ・未ログインを検知した場合のみ実際のログインフォームを操作する。
async function ensureLoggedIn(page, account) {
  const hadCookies = await loadCookies(page, account.id);

  if (hadCookies) {
    await page.goto(MEMBER_CHECK_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await humanPause();
    if (!(await isOnLoginForm(page))) {
      return { loggedIn: true, freshLogin: false };
    }
  }

  await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector(CUSNUM_SELECTOR, { timeout: 15000 });
  await humanPause(300, 900);
  await typeHuman(page, CUSNUM_SELECTOR, account.cusnum);
  await humanPause(200, 600);
  await typeHuman(page, PASSWORD_SELECTOR, account.password);
  await humanPause(300, 800);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
    page.click(SUBMIT_SELECTOR),
  ]);
  await saveCookies(page, account.id);

  if (await isOnLoginForm(page)) {
    throw new Error(
      `ログインに失敗しました（account=${account.id}）。お客様番号/パスワード、またはページ構造の変化を確認してください。`
    );
  }
  return { loggedIn: true, freshLogin: true };
}

module.exports = { launchBrowser, prepPage, ensureLoggedIn, saveCookies };
