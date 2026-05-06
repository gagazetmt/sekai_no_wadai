// scripts/modules/fetchers/fotmob_career.js
// FotMob から選手・監督のキャリア & トロフィーを取得する
//
// 使い方:
//   const { searchFotMob, fetchFotMobCareer } = require('./fotmob_career');
//   const id = await searchFotMob('Diego Simeone', 'manager');
//   const data = await fetchFotMobCareer(id);
//
// 仕組み:
//   1. /api/data/search/suggest?term= で名前 → FotMob ID 解決
//   2. /players/{id}/{slug} ページを Puppeteer で開く
//   3. NEXT_DATA から pageProps.data を抽出
//      - careerHistory.careerItems.{senior|coach}.teamEntries[] : クラブ歴
//      - trophies.{playerTrophies|coachTrophies}                 : 大会別タイトル
//      - primaryTeam, isCoach, statSeasons, marketValues 等
//
// FotMob は curl 直叩きを Cloudflare で弾くため Puppeteer-extra-stealth + Webshare 必須

const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
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
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  return page;
}

// 名前 → FotMob ID 解決
//   FotMob は player/manager を区別せず player type で返す（コーチも player ID を持つ）
//   ヒント role を渡すと teamId と照合して適切な候補を選びやすい
//   返却: { id, name, teamId, type } | null
async function searchFotMob(name, opts = {}) {
  if (!name) return null;
  const { browser, proxyUrl } = await _newBrowser();
  try {
    const page = await _newPage(browser, proxyUrl);
    await page.goto('https://www.fotmob.com/', { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    await new Promise(r => setTimeout(r, 2500));

    const result = await page.evaluate(async (term) => {
      const r = await fetch(`https://www.fotmob.com/api/data/search/suggest?hits=50&lang=en&term=${encodeURIComponent(term)}`, {
        credentials: 'include',
      });
      if (!r.ok) return { error: 'status ' + r.status };
      return { body: await r.json() };
    }, name);

    if (result.error) return null;
    const sections = result.body || [];
    // "All" セクションを優先
    const all = sections.find(s => s.title?.key === 'all') || sections[0];
    const suggestions = all?.suggestions || [];
    if (!suggestions.length) return null;

    // 完全一致を最優先、次に部分一致
    const lcName = String(name).toLowerCase();
    const exact = suggestions.find(s => String(s.name || '').toLowerCase() === lcName);
    const startMatch = suggestions.find(s => String(s.name || '').toLowerCase().startsWith(lcName));
    const include = suggestions.find(s => String(s.name || '').toLowerCase().includes(lcName));
    const pick = exact || startMatch || include || suggestions[0];
    return {
      id: pick.id,
      name: pick.name,
      teamId: pick.teamId,
      type: pick.type,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// FotMob ID から career データを取得
//   返却: {
//     id, name, isCoach, primaryTeam, mainLeague,
//     coachCareer: [{ teamId, team, startDate, endDate, current }],
//     playerCareer: [{ teamId, team, startDate, endDate, appearances, goals, assists }],
//     coachTrophies: [{ teamId, teamName, tournaments: [{ leagueName, seasonsWon, seasonsRunnerUp }] }],
//     playerTrophies: [...],
//     statSeasons: [...],   // シーズン別スタッツ
//     marketValue: { value, currency } | null,
//   }
async function fetchFotMobCareer(fotmobId, opts = {}) {
  if (!fotmobId) throw new Error('fotmobId required');
  const slug = opts.slug || 'x';
  const { browser, proxyUrl } = await _newBrowser();
  try {
    const page = await _newPage(browser, proxyUrl);
    const url = `https://www.fotmob.com/players/${fotmobId}/${slug}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PAGE_TIMEOUT });
    await new Promise(r => setTimeout(r, 3000));

    const nextDataRaw = await page.evaluate(() => {
      const el = document.querySelector('#__NEXT_DATA__');
      return el ? el.textContent : null;
    });
    if (!nextDataRaw) throw new Error('no NEXT_DATA');
    const next = JSON.parse(nextDataRaw);
    const d = next.props?.pageProps?.data;
    if (!d) throw new Error('no pageProps.data');

    const ch = d.careerHistory?.careerItems || {};
    const coach  = (ch.coach?.teamEntries  || []).map(_simplifyEntry);
    const player = (ch.senior?.teamEntries || []).map(_simplifyEntry);

    return {
      id: d.id,
      name: d.name,
      isCoach: !!d.isCoach,
      primaryTeam: d.primaryTeam || null,
      mainLeague: d.mainLeague || null,
      coachCareer: coach,
      playerCareer: player,
      coachTrophies:  d.trophies?.coachTrophies  || [],
      playerTrophies: d.trophies?.playerTrophies || [],
      statSeasons:    d.statSeasons    || null,
      marketValue:    _extractMarketValue(d.marketValues),
      birthDate:      d.birthDate || null,
      positionDescription: d.positionDescription || null,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

function _simplifyEntry(e) {
  return {
    teamId: e.teamId,
    team:   e.team,
    teamGender: e.teamGender,
    startDate: (e.startDate || '').slice(0, 10),
    endDate:   e.endDate ? e.endDate.slice(0, 10) : null,
    current: !e.endDate,
    transferType: e.transferType,
    appearances: _toNum(e.appearances),
    goals:       _toNum(e.goals),
    assists:     _toNum(e.assists),
  };
}

function _toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function _extractMarketValue(mv) {
  if (!mv) return null;
  // marketValues は { current: { value, currency }, history: [...] } 形式
  if (mv.current) return mv.current;
  if (Array.isArray(mv) && mv.length) return mv[mv.length - 1];
  return null;
}

// 名前 → 一括取得（search → fetch）
async function fetchByName(name, opts = {}) {
  const found = await searchFotMob(name, opts);
  if (!found) return null;
  const slug = String(name).toLowerCase().replace(/\s+/g, '-');
  const data = await fetchFotMobCareer(found.id, { slug });
  return { found, data };
}

module.exports = {
  searchFotMob,
  fetchFotMobCareer,
  fetchByName,
};

// CLI for testing
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env') });
  const name = process.argv[2] || 'Pep Guardiola';
  (async () => {
    console.log('Searching:', name);
    const res = await fetchByName(name);
    if (!res) { console.error('not found'); process.exit(1); }
    console.log('Match:', res.found);
    console.log('Coach career:');
    res.data.coachCareer.forEach(c => console.log(' -', c.team, c.startDate, '→', c.endDate || 'present'));
    console.log('Player career:');
    res.data.playerCareer.slice(0, 5).forEach(c => console.log(' -', c.team, c.startDate, '→', c.endDate || 'present', '| apps=' + c.appearances, 'goals=' + c.goals));
    console.log('Coach trophies (top 2 teams):');
    (res.data.coachTrophies || []).slice(0, 2).forEach(t => {
      console.log(' ', t.teamName);
      (t.tournaments || []).slice(0, 5).forEach(tn => console.log('   -', tn.leagueName, ': won', (tn.seasonsWon || []).length, '| RU', (tn.seasonsRunnerUp || []).length));
    });
  })().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
