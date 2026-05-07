// scripts/modules/fetchers/transfermarkt_manager.js
// Transfermarkt から監督のクラブ別通算成績・今季大会別 W/D/L・獲得タイトルを取得する
//
// 使い方:
//   const { searchTransfermarktManager, fetchTransfermarktManager } = require('./transfermarkt_manager');
//   const hit = await searchTransfermarktManager('Mikel Arteta');
//   if (hit) {
//     const data = await fetchTransfermarktManager(hit.id, hit.slug);
//   }
//
// 仕組み:
//   1. /schnellsuche/ergebnis/schnellsuche?query=&Trainer_page=1 で名前 → trainer ID/slug 解決
//   2. /{slug}/profil/trainer/{id}    : クラブ別通算 + 今季大会別 W/D/L + プロフィール
//   3. /{slug}/erfolge/trainer/{id}   : 獲得タイトル（年度+クラブ別）
//
// FotMob と同じく Puppeteer + Webshare 住宅プロキシ経由（Transfermarkt は素のaxiosでも200だが
// レートリミット回避のため住宅IP使用、また既存の puppeteer-extra-plugin-stealth 環境を流用）

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

// "26/03/1982" → "1982-03-26"
function _parseDateDMY(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (!m) return null;
  const [_, d, mo, y] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// "-" や空文字を null に / 数値文字列を Number に
function _toIntOrNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === '-' || t === '–') return null;
  const n = parseInt(t.replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function _toFloatOrNull(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || t === '-' || t === '–') return null;
  const n = parseFloat(t.replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 名前 → trainer ID/slug 解決
//   返却: { id, slug, name } | null
async function searchTransfermarktManager(name) {
  if (!name) return null;
  const { browser, proxyUrl } = await _newBrowser();
  try {
    const page = await _newPage(browser, proxyUrl);
    const url = `https://www.transfermarkt.com/schnellsuche/ergebnis/schnellsuche?query=${encodeURIComponent(name)}&Trainer_page=1`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
    if (!res || res.status() >= 400) return null;
    await new Promise(r => setTimeout(r, 1500));

    // /{slug}/profil/trainer/{id} を最初にヒットさせる
    const hits = await page.evaluate(() => {
      const out = [];
      const links = document.querySelectorAll('a[href*="/profil/trainer/"]');
      for (const a of links) {
        const m = a.getAttribute('href')?.match(/\/([\w\-]+)\/profil\/trainer\/(\d+)/);
        if (m) out.push({ slug: m[1], id: parseInt(m[2], 10), name: (a.textContent || '').trim() });
      }
      return out;
    });
    if (!hits.length) return null;

    // 完全一致 → 部分一致 の順で選ぶ
    const lc = String(name).toLowerCase();
    const exact = hits.find(h => h.name.toLowerCase() === lc);
    const start = hits.find(h => h.name.toLowerCase().startsWith(lc));
    const incl  = hits.find(h => h.name.toLowerCase().includes(lc));
    const pick  = exact || start || incl || hits[0];
    return { id: pick.id, slug: pick.slug, name: pick.name };
  } catch (e) {
    console.warn('[transfermarkt_manager] search 例外:', e.message);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}

// profil ページから 3 種類のテーブル + auflistung を抽出
async function _fetchProfil(page, slug, id) {
  const url = `https://www.transfermarkt.com/${slug}/profil/trainer/${id}`;
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  if (!res || res.status() >= 400) throw new Error(`profil status ${res?.status()}`);
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    const out = { profile: {}, currentSeasonByCompetition: [], coachClubs: [] };

    // ── テーブル[0]: 監督プロフィール（class="auflistung"）
    const auf = document.querySelector('table.auflistung');
    if (auf) {
      for (const row of auf.rows) {
        const k = (row.cells[0]?.innerText || '').trim().replace(/:$/, '');
        const v = (row.cells[1]?.innerText || '').trim();
        if (k && v) out.profile[k] = v;
      }
    }

    // ── テーブル群: class="items" のうち見出しに W/D/L があるのが今季大会別、Matches+PPM がクラブ別
    const itemsTables = document.querySelectorAll('table.items');
    for (const tbl of itemsTables) {
      const headerRow = tbl.rows[0];
      if (!headerRow) continue;
      const headers = Array.from(headerRow.cells).map(c => (c.innerText || '').trim().toLowerCase());

      // 今季大会別: Competition | Matches | W | D | L | Points | PPM
      if (headers.includes('w') && headers.includes('d') && headers.includes('l')) {
        for (let i = 1; i < tbl.rows.length; i++) {
          const r = tbl.rows[i];
          const cells = Array.from(r.cells).map(c => (c.innerText || '').trim());
          if (cells.length < headers.length) continue;
          const obj = {};
          headers.forEach((h, k) => { obj[h] = cells[k]; });
          out.currentSeasonByCompetition.push(obj);
        }
        continue;
      }

      // クラブ別通算: 紋章 | Club & role | Appointed | In charge until | Matches | PPM
      if (headers.some(h => h.includes('club & role') || h.includes('appointed') || h.includes('in charge'))) {
        for (let i = 1; i < tbl.rows.length; i++) {
          const r = tbl.rows[i];
          // assistant manager の "Assistant Manager of: Pep Guardiola (..." は単一セル行で来る場合あり
          const cells = Array.from(r.cells).map(c => (c.innerText || '').trim());
          if (cells.length < 4) {
            // 補足行 — 直前の coachClubs エントリに mentor として連結
            const last = out.coachClubs[out.coachClubs.length - 1];
            const txt = cells.join(' ').trim();
            if (last && /assistant manager of:/i.test(txt)) {
              const m = txt.match(/Assistant Manager of:\s*([^()]+)/i);
              if (m) last.mentor = m[1].trim();
            }
            continue;
          }
          const obj = {};
          headers.forEach((h, k) => { obj[h] = cells[k]; });
          out.coachClubs.push(obj);
        }
      }
    }

    return out;
  });
}

// erfolge ページから獲得タイトル一覧を抽出
async function _fetchErfolge(page, slug, id) {
  const url = `https://www.transfermarkt.com/${slug}/erfolge/trainer/${id}`;
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
  if (!res || res.status() >= 400) return [];
  await new Promise(r => setTimeout(r, 2000));

  return await page.evaluate(() => {
    // erfolge ページは <div class="box"> ごとにタイトル種類が並ぶ
    //   <h2 class="content-box-headline">2x English Champion</h2>
    //   <table class="auflistung"> 各シーズン+クラブ </table>
    const out = [];
    const headers = document.querySelectorAll('h2.content-box-headline, .content-box-headline');
    for (const h of headers) {
      const titleRaw = (h.textContent || '').trim();
      if (!titleRaw) continue;
      // 直後の table.auflistung を取る
      let el = h.nextElementSibling;
      let table = null;
      for (let i = 0; el && i < 5; i++, el = el.nextElementSibling) {
        if (el.tagName === 'TABLE') { table = el; break; }
        const inner = el.querySelector?.('table.auflistung');
        if (inner) { table = inner; break; }
      }
      if (!table) continue;

      const seasons = [];
      for (const row of table.rows) {
        const cells = Array.from(row.cells).map(c => (c.innerText || '').trim());
        // 形式: [ "23/24", "", "Arsenal FC" ] のような3セル
        if (cells.length >= 1) {
          const season = cells[0];
          const club   = cells[cells.length - 1];
          if (/^\d{2}\/\d{2}$/.test(season)) seasons.push({ season, club });
        }
      }
      // タイトル名から数字接頭辞 ("2x ") を除去 + 回数取得
      const countMatch = titleRaw.match(/^(\d+)\s*x\s+(.+)$/i);
      const count = countMatch ? parseInt(countMatch[1], 10) : seasons.length || 1;
      const title = countMatch ? countMatch[2].trim() : titleRaw;
      out.push({ title, count, seasons });
    }
    return out;
  });
}

// season は必ず YY/YY 形式（例 "19/20"）。日付の MM/DD と区別するため
//   2 数字がほぼ連続（差が 1 で 30 以下）で来るパターンを season とみなす
function _isSeasonStr(s) {
  if (!s) return false;
  const m = String(s).match(/^(\d{2})\/(\d{2})$/);
  if (!m) return false;
  const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
  // 期またぎ "23/24" or 同年 "08/09" → b - a は 1 (mod 100) または同年(0)
  return ((b - a + 100) % 100) <= 1;
}

// "19/20 (22/12/2019)" → { season: '19/20', date: '2019-12-22' }
function _parseAppointed(s) {
  if (!s) return { season: null, date: null };
  const t = String(s).trim();
  const seasonM = t.match(/^(\d{2}\/\d{2})\b/);
  const dateM   = t.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  return {
    season: (seasonM && _isSeasonStr(seasonM[1])) ? seasonM[1] : null,
    date:   dateM ? _parseDateDMY(dateM[1]) : null,
  };
}

// "expected 30/06/2027" / "19/20 (20/12/2019)" → { until, expected }
//   expected の場合 season 表記が無いことが多いので "30/06" を season と誤認しないよう注意
function _parseInChargeUntil(s) {
  if (!s) return { season: null, date: null, expected: false };
  const t = String(s).trim();
  const expected = /expected/i.test(t);
  const seasonM  = t.match(/^(\d{2}\/\d{2})\b/);
  const dateM    = t.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  return {
    season: (seasonM && _isSeasonStr(seasonM[1])) ? seasonM[1] : null,
    date:   dateM ? _parseDateDMY(dateM[1]) : null,
    expected,
  };
}

// クラブ&役職を分離: "Arsenal\nManager" / "Arsenal Manager" → { club, role }
//   innerText の改行と空白の両方に対応。長い役職名から先にマッチさせる
const _ROLE_TOKENS = [
  'Assistant Manager', 'Caretaker Manager', 'Interim Manager',
  'Global Sports Director', 'Sporting Director', 'Sports Director',
  'Director of Football', 'Technical Director',
  'Head Coach', 'Manager', 'Coach',
];
function _parseClubRole(s) {
  if (!s) return { club: null, role: null };
  // 改行と連続空白を 1 スペースに正規化
  const t = String(s).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const role of _ROLE_TOKENS) {
    // 末尾一致（前に空白）か完全一致
    if (t === role) return { club: null, role };
    if (t.endsWith(' ' + role)) {
      return { club: t.slice(0, t.length - role.length).trim(), role };
    }
  }
  return { club: t, role: null };
}

// 役職が「実際に試合の指揮を取る監督」か判定
//   Manager / Head Coach / Caretaker / Interim は ✓
//   Assistant Manager / Sports Director 系は ✗（参考扱い）
const _HEAD_COACH_ROLES = new Set(['Manager', 'Head Coach', 'Caretaker Manager', 'Interim Manager', 'Coach']);
function _isHeadCoachRole(role) {
  return role ? _HEAD_COACH_ROLES.has(role) : false;
}

// 監督本体取得（profil + erfolge）
//   返却: {
//     ok, id, slug, name, fullName, birthDate, age, birthPlace, nationality,
//     coachClubs: [{ club, role, fromSeason, fromDate, toSeason, toDate, toExpected, matches, ppm, mentor? }],
//     currentSeasonByCompetition: [{ competition, matches, w, d, l, points, ppm }],
//     trophies: [{ title, count, seasons: [{ season, club }] }],
//   }
async function fetchTransfermarktManager(id, slug) {
  if (!id || !slug) throw new Error('id and slug required');
  const { browser, proxyUrl } = await _newBrowser();
  try {
    const page = await _newPage(browser, proxyUrl);

    const profil = await _fetchProfil(page, slug, id);
    const trophies = await _fetchErfolge(page, slug, id);

    // ── プロフィールを構造化 ──
    const profKeys = profil.profile || {};
    const findKey = (...needles) => {
      const keys = Object.keys(profKeys);
      for (const need of needles) {
        const k = keys.find(kk => kk.toLowerCase().includes(need.toLowerCase()));
        if (k) return profKeys[k];
      }
      return null;
    };
    const fullName  = findKey('Full Name', 'Name in Home Country');
    const dobAge    = findKey('Date of birth', 'Age');
    const birthPlace = findKey('Place of Birth', 'Place of birth');
    const nationality = findKey('Citizenship', 'Nationality');
    let birthDate = null, age = null;
    if (dobAge) {
      birthDate = _parseDateDMY(dobAge);
      const aMatch = dobAge.match(/\((\d+)\)/);
      if (aMatch) age = parseInt(aMatch[1], 10);
    }

    // ── coachClubs: テーブル行を構造化 ──
    //   ヘッドコーチ役（Manager/Head Coach/Caretaker/Interim）と非ヘッドコーチ役を分離して保持
    const coachClubsAll = (profil.coachClubs || []).map(row => {
      const clubRole = row['club & role'] || row['club']  || '';
      const appoint  = row['appointed'] || '';
      const until    = row['in charge until'] || '';
      const matches  = row['matches'] || row['m'] || '';
      const ppm      = row['ppm'] || '';
      const { club, role } = _parseClubRole(clubRole);
      const a = _parseAppointed(appoint);
      const u = _parseInChargeUntil(until);
      return {
        club, role,
        fromSeason: a.season, fromDate: a.date,
        toSeason: u.season,  toDate: u.date, toExpected: u.expected,
        matches: _toIntOrNull(matches),
        ppm:     _toFloatOrNull(ppm),
        mentor:  row.mentor || null,
        isHeadCoach: _isHeadCoachRole(role),
      };
    }).filter(c => c.club);
    const coachClubs       = coachClubsAll.filter(c => c.isHeadCoach);
    const otherRoleClubs   = coachClubsAll.filter(c => !c.isHeadCoach);

    // ── currentSeasonByCompetition: テーブル行を構造化 ──
    //   "Total:" 行は別フィールドへ分離（合計だけ別管理）
    let currentSeasonTotal = null;
    const currentSeasonByCompetition = [];
    for (const row of (profil.currentSeasonByCompetition || [])) {
      const compRaw = row['competition'] || row['comp'] || '';
      if (!compRaw) continue;
      const obj = {
        competition: compRaw.replace(/:$/, '').trim(),
        matches: _toIntOrNull(row['matches']),
        w: _toIntOrNull(row['w']),
        d: _toIntOrNull(row['d']),
        l: _toIntOrNull(row['l']),
        points: _toIntOrNull(row['points'] || row['pts']),
        ppm: _toFloatOrNull(row['ppm']),
      };
      if (/^total/i.test(compRaw)) {
        currentSeasonTotal = obj;
      } else {
        currentSeasonByCompetition.push(obj);
      }
    }

    return {
      ok: true,
      id, slug,
      name: profKeys['Name in Home Country'] || fullName || null,
      fullName: fullName || null,
      birthDate, age,
      birthPlace: birthPlace || null,
      nationality: nationality || null,
      coachClubs,                       // ヘッドコーチ役のみ（実監督経歴）
      otherRoleClubs,                   // Assistant / Sports Director 等の参考経歴
      currentSeasonByCompetition,       // 大会別 W/D/L（Total 除く）
      currentSeasonTotal,               // 合計の W/D/L
      trophies: trophies || [],
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = {
  searchTransfermarktManager,
  fetchTransfermarktManager,
};
