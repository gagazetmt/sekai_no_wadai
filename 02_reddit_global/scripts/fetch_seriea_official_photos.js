// scripts/fetch_seriea_official_photos.js
// Serie A 公式 (en.legaseriea.it) から透過 WebP の選手写真を一括取得
//
// 既存 fetch_seriea_player_photos.js は SofaScore ベース（顔だけアバター系）
// このスクリプトは公式サイトの胸上透過画像（674×675 WebP）を取得
//
// 仕組み:
//   1. https://en.legaseriea.it/team/{slug}/squad を puppeteer で開く
//   2. ページ内 <img src="..media-sdp.legaseriea.it/playerImages/.../*_left.webp"> を全抽出
//   3. 同時に <a href="/players/{player-slug}"> を順番で抽出 → 名前と画像を位置で対応付け
//   4. 各画像をダウンロード → images_stock/players_official/serie-a/{club}/{player-slug}.webp に保存
//   5. data/players_official_index.json を更新（既存 PL/LaLiga と共存）
//
// 使い方:
//   node fetch_seriea_official_photos.js               # 全 20 クラブ
//   node fetch_seriea_official_photos.js inter-milan   # 1 クラブだけ

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const { SERIEA_CLUBS } = require('./_seriea_clubs');
const LEAGUE_SLUG = 'serie-a';
const LEAGUE_NAME = 'Serie A';

const ROOT       = path.join(__dirname, '..');
const STOCK_BASE = path.join(ROOT, 'images_stock', 'players_official', LEAGUE_SLUG);
const INDEX_FILE = path.join(ROOT, 'data', 'players_official_index.json');

// クラブキー → 公式サイトのスラグ（en.legaseriea.it/team/{slug}/squad）
//   微妙に違うクラブだけマッピング、それ以外は clubKey をそのまま使う
const OFFICIAL_SLUG = {
  'inter-milan': 'inter',
  'ac-milan':    'milan',
  // 他は同じスラグで OK と推測（404 出たら追加）
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SLEEP_MS = 800;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeName(s) {
  return String(s || '').toLowerCase()
    .replace(/[À-ſ]/g, c => 'aaaaaaaaceeeeiiiidnoooooo  uuuuyy aaaaaaaceeeeiiiidnoooooo  uuuuyyy'[c.charCodeAt(0) - 0xC0] || c)
    .replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '');
}

// playerLink (/players/{slug}) からプレイヤースラグだけ抜く
function _extractPlayerSlug(href) {
  const m = String(href || '').match(/\/players\/([\w\-]+)/);
  return m ? m[1] : null;
}

async function _newBrowser() {
  return await puppeteerExtra.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
}

async function _fetchClubSquad(browser, clubKey, clubMeta) {
  const slug = OFFICIAL_SLUG[clubKey] || clubKey;
  const url = `https://en.legaseriea.it/team/${slug}/squad`;
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  try {
    const res = await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    if (!res || res.status() >= 400) return { ok: false, reason: `status ${res?.status()}` };
    await sleep(2500);

    // ページから 画像URL と 選手リンクを位置順で抽出
    const data = await page.evaluate(() => {
      // 画像URL: img.src or data-src or srcset で playerImages を含むもの
      const imgs = [];
      document.querySelectorAll('img').forEach(el => {
        const candidates = [];
        ['src', 'data-src'].forEach(a => { const v = el.getAttribute(a); if (v) candidates.push(v); });
        const ss = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (ss) ss.split(/[\s,]+/).forEach(s => s && candidates.push(s));
        for (const c of candidates) {
          if (c.includes('playerImages') && c.endsWith('.webp')) {
            imgs.push({ src: c, top: el.getBoundingClientRect().top + window.scrollY });
            break;
          }
        }
      });
      // 選手リンク: a[href*="/players/"]
      const links = [];
      document.querySelectorAll('a[href*="/players/"]').forEach(a => {
        const href = a.getAttribute('href') || a.href;
        // 名前テキストはカード内 .player-name や h3 などにある場合あり、無ければリンク自身
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        links.push({ href, text, top: a.getBoundingClientRect().top + window.scrollY });
      });
      return { imgs, links };
    });

    // 重複除去（href 単位、画像も src 単位）
    const seenHref = new Set();
    const dedupedLinks = data.links.filter(l => {
      if (seenHref.has(l.href)) return false;
      seenHref.add(l.href);
      return true;
    }).sort((a, b) => a.top - b.top);

    const seenSrc = new Set();
    const dedupedImgs = data.imgs.filter(i => {
      if (seenSrc.has(i.src)) return false;
      seenSrc.add(i.src);
      return true;
    }).sort((a, b) => a.top - b.top);

    // 位置順でペア（カード単位で同じ top のはず）
    //   カード数より画像が少ない場合、画像の順序＝表示順なので前から対応付け
    const n = Math.min(dedupedLinks.length, dedupedImgs.length);
    const pairs = [];
    for (let i = 0; i < n; i++) {
      const playerSlug = _extractPlayerSlug(dedupedLinks[i].href);
      if (!playerSlug) continue;
      pairs.push({ playerSlug, imgUrl: dedupedImgs[i].src, name: dedupedLinks[i].text });
    }
    return { ok: true, pairs, totalLinks: dedupedLinks.length, totalImgs: dedupedImgs.length };
  } finally {
    await page.close().catch(() => {});
  }
}

async function _downloadImage(browser, url, outPath) {
  // puppeteer の page.evaluate(fetch) でバイナリダウンロード（cookie/UA 引き継ぎ）
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.goto('https://en.legaseriea.it/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(500);
  try {
    const result = await page.evaluate(async (u) => {
      const r = await fetch(u);
      if (!r.ok) return { ok: false, status: r.status };
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return { ok: true, b64: btoa(bin), size: bytes.length };
    }, url);
    if (!result.ok) return { ok: false, reason: 'fetch ' + result.status };
    fs.writeFileSync(outPath, Buffer.from(result.b64, 'base64'));
    return { ok: true, sizeBytes: result.size };
  } finally {
    await page.close().catch(() => {});
  }
}

async function _processClub(browser, clubKey, clubMeta, indexEntries) {
  console.log(`\n━━━ ${clubMeta.name || clubKey}`);
  const result = await _fetchClubSquad(browser, clubKey, clubMeta);
  if (!result.ok) {
    console.warn(`  ❌ squad ページ取得失敗: ${result.reason}`);
    return { ok: 0, fail: 0 };
  }
  console.log(`  ${result.pairs.length} pairs (${result.totalLinks} links / ${result.totalImgs} imgs)`);

  const clubDir = path.join(STOCK_BASE, clubKey);
  fs.mkdirSync(clubDir, { recursive: true });

  let ok = 0, fail = 0;
  for (const pair of result.pairs) {
    const outPath = path.join(clubDir, `${pair.playerSlug}.webp`);
    if (fs.existsSync(outPath)) {
      // 既存ファイルがあればスキップ（再実行で重複ダウンロード回避）
      ok++;
      continue;
    }
    const dl = await _downloadImage(browser, pair.imgUrl, outPath);
    await sleep(SLEEP_MS);
    if (!dl.ok) {
      console.warn(`  ❌ ${pair.playerSlug}: ${dl.reason}`);
      fail++; continue;
    }
    const kb = (dl.sizeBytes / 1024).toFixed(0);
    console.log(`  ✅ ${pair.playerSlug.padEnd(36)} (${kb}KB)`);
    indexEntries.push({
      league: LEAGUE_NAME,
      leagueSlug: LEAGUE_SLUG,
      club: clubKey,
      playerSlug: pair.playerSlug,
      name: pair.name || pair.playerSlug,
      photoUrl: pair.imgUrl,
      localPath: path.relative(ROOT, outPath).replace(/\\/g, '/'),
      sizeBytes: dl.sizeBytes,
      source: 'legaseriea-official',
    });
    ok++;
  }
  return { ok, fail };
}

async function main() {
  const arg = process.argv[2];
  let targets;
  if (arg) {
    if (!SERIEA_CLUBS[arg]) { console.error('未知のクラブ:', arg); process.exit(1); }
    targets = [arg];
  } else {
    targets = Object.keys(SERIEA_CLUBS);
  }

  // 既存 index 読み込み
  let index = { updatedAt: null, total: 0, entries: [] };
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      index = raw && typeof raw === 'object' ? raw : index;
    }
  } catch (_) {}
  if (!Array.isArray(index.entries)) index.entries = [];

  // serie-a の既存エントリを除去（再生成）
  index.entries = index.entries.filter(e => !(e.leagueSlug === LEAGUE_SLUG && e.source === 'legaseriea-official'));

  const browser = await _newBrowser();
  let totalOk = 0, totalFail = 0;
  try {
    for (const key of targets) {
      const r = await _processClub(browser, key, SERIEA_CLUBS[key], index.entries);
      totalOk  += r.ok;
      totalFail += r.fail;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  index.updatedAt = new Date().toISOString();
  index.total     = index.entries.length;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`\n🎉 Serie A 公式画像取得完了: ${totalOk} ok / ${totalFail} fail / 計 ${index.total} 選手`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { _processClub };
