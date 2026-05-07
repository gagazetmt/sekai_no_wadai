// scripts/fetch_psg_official_photos.js
// PSG 公式 (psg.fr) から透過 PNG の選手写真を一括取得
//
// 仕組み:
//   1. https://www.psg.fr/en/mens-football/squad ページを puppeteer で開く
//   2. media.psg.fr/image/upload/.../2526-Card-{LastName}_{hash} の Card 画像 URL を全抽出
//   3. URL の "f_avif" → "f_png" に変換して PNG 形式で取得（Cloudinary 動的変換）
//   4. 選手リンク (/players/{slug}) と Card URL の {LastName} を照合してペア確定
//   5. images_stock/players_official/ligue-1/psg/{slug}.png に保存
//   6. data/players_official_index.json を更新
//
// リーグアン公式（ligue1.com）が現在テクニカルエラーで使えないため、PSG 単体で対応。
// Serie A 公式 (legaseriea.it) と同じ思想だが、CDN は psg.fr 独自の Cloudinary。

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const puppeteerExtra = require('puppeteer-extra');
const StealthPlugin  = require('puppeteer-extra-plugin-stealth');
puppeteerExtra.use(StealthPlugin());

const LEAGUE_SLUG = 'ligue-1';
const LEAGUE_NAME = 'Ligue 1';
const CLUB_KEY    = 'psg';
const CLUB_NAME   = 'Paris Saint-Germain';
const SQUAD_URL   = 'https://www.psg.fr/en/mens-football/squad';

const ROOT       = path.join(__dirname, '..');
const STOCK_DIR  = path.join(ROOT, 'images_stock', 'players_official', LEAGUE_SLUG, CLUB_KEY);
const INDEX_FILE = path.join(ROOT, 'data', 'players_official_index.json');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// "2526-Card-Hakimi_adllwa" → "Hakimi"（snake は別）
function _extractPlayerName(cardUrl) {
  const m = String(cardUrl || '').match(/2526-Card-([^_/]+)_/i);
  return m ? m[1] : null;
}

// player URL "/en/players/achraf-hakimi" → "achraf-hakimi"
function _extractSlug(href) {
  const m = String(href || '').match(/\/players\/([\w\-]+)/i);
  return m ? m[1] : null;
}

// last name 推定（slug の最後の単語）。例: "achraf-hakimi" → "hakimi"
//   特例: "joao-neves" → "neves" だが Card URL では "JoaoNeves" のように結合の場合あり
function _slugLastWord(slug) {
  const parts = String(slug || '').split('-');
  return parts.length ? parts[parts.length - 1] : slug;
}

// f_avif → f_png 変換 + 幅 1000 程度に縮小
//   Cloudinary 動的変換で URL を変えるだけで PNG 化可能
function _convertToPng(avifUrl) {
  // 例: https://media.psg.fr/image/upload/w_3841/f_avif,q_85/2526-Card-Hakimi_xxx
  //  →   https://media.psg.fr/image/upload/w_1200/f_png,q_92/2526-Card-Hakimi_xxx
  return String(avifUrl)
    .replace(/\/w_\d+\//, '/w_1200/')
    .replace(/f_avif,q_\d+/, 'f_png,q_92')
    .replace(/f_avif/, 'f_png');
}

function _pickProxy() {
  if (!process.env.WEBSHARE_PROXY_URL) return null;
  const n = Math.floor(Math.random() * 4000) + 1;
  return process.env.WEBSHARE_PROXY_URL.replace('{N}', String(n));
}

async function _fetchSquadData(browser, proxyUrl) {
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
  try {
    const res = await page.goto(SQUAD_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    if (!res || res.status() >= 400) throw new Error('squad status ' + res?.status());
    await sleep(3000);
    return await page.evaluate(() => {
      const out = { cards: [], links: [] };
      // Card 画像 URL（位置順）
      document.querySelectorAll('img').forEach(el => {
        const src = el.src || el.getAttribute('data-src') || '';
        if (/2526-Card-/i.test(src)) {
          out.cards.push({
            src,
            top: el.getBoundingClientRect().top + window.scrollY,
            left: el.getBoundingClientRect().left + window.scrollX,
          });
        }
      });
      // 選手リンク（位置順）
      document.querySelectorAll('a[href*="/players/"]').forEach(a => {
        out.links.push({
          href: a.href || a.getAttribute('href') || '',
          text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          top: a.getBoundingClientRect().top + window.scrollY,
          left: a.getBoundingClientRect().left + window.scrollX,
        });
      });
      return out;
    });
  } finally {
    await page.close().catch(() => {});
  }
}

// Cloudinary CDN は cookie 不要なので Node.js https で直接ダウンロード（puppeteer 競合回避）
const https = require('https');
function _downloadImage(_browser, url, outPath) {
  return new Promise((resolve) => {
    const opts = { headers: { 'User-Agent': UA, 'Accept': 'image/png,image/avif,image/webp,*/*' } };
    https.get(url, opts, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // redirect 追従
        return _downloadImage(null, res.headers.location, outPath).then(resolve);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, reason: 'status ' + res.statusCode });
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          fs.writeFileSync(outPath, buf);
          resolve({ ok: true, sizeBytes: buf.length });
        } catch (e) { resolve({ ok: false, reason: 'write ' + e.message }); }
      });
      res.on('error', e => resolve({ ok: false, reason: 'recv ' + e.message }));
    }).on('error', e => resolve({ ok: false, reason: 'req ' + e.message }));
  });
}

async function main() {
  fs.mkdirSync(STOCK_DIR, { recursive: true });
  const proxyUrl = _pickProxy();
  const args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'];
  if (proxyUrl) args.push(`--proxy-server=${new URL(proxyUrl).host}`);
  const browser = await puppeteerExtra.launch({ headless: 'new', args });

  // 既存 index 読み込み
  let index = { updatedAt: null, total: 0, entries: [] };
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      index = raw && typeof raw === 'object' ? raw : index;
    }
  } catch (_) {}
  if (!Array.isArray(index.entries)) index.entries = [];
  // PSG psg-official の既存エントリを除去（再生成）
  index.entries = index.entries.filter(e => !(e.leagueSlug === LEAGUE_SLUG && e.club === CLUB_KEY && e.source === 'psg-official'));

  let ok = 0, fail = 0;

  try {
    // proxy リトライ機構：TUNNEL/timeout エラー時に最大 5 回別 IP でリトライ
    //   ハズレ IP を引くと ERR_TUNNEL_CONNECTION_FAILED が出るので別 proxy で再試行
    let squad = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const px = (attempt === 1) ? proxyUrl : _pickProxy();
      console.log(`━━━ PSG squad ページ取得 (attempt ${attempt}/5${px ? ' via Webshare' : ' direct'})`);
      try {
        squad = await _fetchSquadData(browser, px);
        if (squad?.cards?.length) break;
      } catch (e) {
        lastErr = e;
        if (/TUNNEL|net::ERR|timeout/.test(e.message)) {
          console.warn(`  ⚠️ proxy 失敗、別 IP で再試行: ${e.message.slice(0, 80)}`);
          await sleep(2000);
          continue;
        }
        throw e;
      }
    }
    if (!squad || !squad.cards?.length) throw lastErr || new Error('全 5 回 proxy 取得失敗');

    // dedup: src 単位
    const seenSrc = new Set();
    const cards = squad.cards.filter(c => { if (seenSrc.has(c.src)) return false; seenSrc.add(c.src); return true; });
    // dedup: href 単位
    const seenHref = new Set();
    const links = squad.links.filter(l => { if (seenHref.has(l.href)) return false; seenHref.add(l.href); return true; });

    console.log(`  cards: ${cards.length} / links: ${links.length}`);

    // Card URL の "2526-Card-{LastName}" を抽出して、選手リンク slug の最終単語と照合
    const slugByLastName = {};   // "Hakimi" (lower) → "achraf-hakimi"
    links.forEach(l => {
      const slug = _extractSlug(l.href);
      if (!slug) return;
      const last = _slugLastWord(slug).toLowerCase();
      if (!slugByLastName[last]) slugByLastName[last] = slug;
      // 結合形式の last name (例: joao-neves → neves) でも引けるようフルスラグからの「-」除去版もキー化
      const noHyphen = slug.replace(/-/g, '').toLowerCase();
      if (!slugByLastName[noHyphen]) slugByLastName[noHyphen] = slug;
    });

    for (const card of cards) {
      const last = _extractPlayerName(card.src);
      if (!last) { fail++; console.warn('  ⚠️ Name 抽出失敗:', card.src.slice(0, 100)); continue; }
      const lastLc = last.toLowerCase();
      // last name でマッチ。失敗時は noHyphen で再マッチ
      let slug = slugByLastName[lastLc] || slugByLastName[lastLc.replace(/[^a-z0-9]/g, '')];
      if (!slug) {
        // 部分一致フォールバック（"JoaoNeves" のような結合形式に対応）
        const cleaned = lastLc.replace(/[^a-z0-9]/g, '');
        for (const k of Object.keys(slugByLastName)) {
          if (k.includes(cleaned) || cleaned.includes(k)) { slug = slugByLastName[k]; break; }
        }
      }
      if (!slug) {
        // それでも見つからない → last name そのものを slug にする（最終手段）
        slug = last.toLowerCase();
        console.warn('  ⚠️ slug照合失敗、last name 流用:', last);
      }

      const pngUrl = _convertToPng(card.src);
      const outPath = path.join(STOCK_DIR, `${slug}.png`);
      const dl = await _downloadImage(browser, pngUrl, outPath);
      await sleep(600);
      if (!dl.ok) {
        console.warn(`  ❌ ${slug}: ${dl.reason}`);
        fail++; continue;
      }
      const kb = (dl.sizeBytes / 1024).toFixed(0);
      console.log(`  ✅ ${slug.padEnd(30)} ← ${last} (${kb}KB)`);
      index.entries.push({
        league:     LEAGUE_NAME,
        leagueSlug: LEAGUE_SLUG,
        club:       CLUB_KEY,
        playerSlug: slug,
        name:       last,
        photoUrl:   pngUrl,
        localPath:  path.relative(ROOT, outPath).replace(/\\/g, '/'),
        sizeBytes:  dl.sizeBytes,
        source:     'psg-official',
      });
      ok++;
    }
  } finally {
    await browser.close().catch(() => {});
  }

  index.updatedAt = new Date().toISOString();
  index.total     = index.entries.length;
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  console.log(`\n🎉 PSG 公式画像取得完了: ${ok} ok / ${fail} fail / 計 ${index.total} 選手 (全リーグ累計)`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
