// scripts/utilities/fetch_flags.js
// flagcdn.com から全国旗 SVG を images_stock/flags/ にダウンロード
//
// 使い方:
//   node scripts/utilities/fetch_flags.js
//
// flagcdn は無料 / API キー不要 / SVG を提供。
//   /en/codes.json で全 ISO3166-1 alpha-2 コード取得
//   /{code}.svg で SVG 取得
//   /gb-eng /gb-sct /gb-wls /gb-nir は UK 4地域用に別途追加

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const OUT_DIR = path.join(__dirname, '..', '..', 'images_stock', 'flags');
const CDN     = 'https://flagcdn.com';

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function fetchBinary(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        // 404 等でも次に進めるよう reject せずに空ファイルを残さない
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log('Fetching country code list...');
  const codesJson = await fetchText(`${CDN}/en/codes.json`);
  const codes = JSON.parse(codesJson);

  // UK 4 地域を追加（FIFA は別協会扱い）
  Object.assign(codes, {
    'gb-eng': 'England',
    'gb-sct': 'Scotland',
    'gb-wls': 'Wales',
    'gb-nir': 'Northern Ireland',
  });

  const total = Object.keys(codes).length;
  console.log(`${total} flags to download`);

  let downloaded = 0, skipped = 0, failed = 0;
  const failedList = [];

  // 並列度 8 で fetch（CDN 負担抑え）
  const entries = Object.entries(codes);
  const POOL = 8;
  const queue = entries.slice();

  async function worker() {
    while (queue.length) {
      const [code, name] = queue.shift();
      const dest = path.join(OUT_DIR, `${code}.svg`);
      if (fs.existsSync(dest) && fs.statSync(dest).size > 50) {
        skipped++;
        continue;
      }
      try {
        await fetchBinary(`${CDN}/${code}.svg`, dest);
        downloaded++;
        if (downloaded % 20 === 0) {
          process.stdout.write(`\r downloaded=${downloaded}/${total} skip=${skipped} fail=${failed}`);
        }
      } catch (e) {
        failed++;
        failedList.push({ code, name, error: e.message });
        try { fs.unlinkSync(dest); } catch (_) {}
      }
    }
  }

  await Promise.all(Array.from({ length: POOL }, () => worker()));

  console.log(`\n✅ done. downloaded=${downloaded} skipped=${skipped} failed=${failed}`);
  if (failedList.length) {
    console.log('Failed entries:');
    failedList.slice(0, 20).forEach(f => console.log(' -', f.code, f.name, '|', f.error));
  }
  console.log(`flags saved to: ${OUT_DIR}`);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
