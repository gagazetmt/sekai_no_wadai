// fetch_wikimedia_images.js
// Wikimedia Commons API で画像検索 → 上位N件をダウンロード
// Module export: fetchWikimediaImages(searchTerm, prefix, limit, opts) → Promise<string[]>
// CLI:           node scripts/fetch_wikimedia_images.js "search term" "prefix"

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const IMG_DIR     = path.join(__dirname, "..", "images");
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

// Wikimedia User-Agent ポリシー準拠: ツール名/バージョン (連絡先) ライブラリ/バージョン
const UA = "soccer-yt-fetcher/1.0 (https://github.com/gagazetmt/sekai_no_wadai; gagazetmt@gmail.com) axios/1.x";

if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// ── 画像ダウンロード ──
async function downloadImage(url, filePath) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 15000,
    headers: { "User-Agent": UA, "Accept": "image/*" },
  });
  fs.writeFileSync(filePath, res.data);
}

// ── 拡張子推定 ──
function inferExt(url, mime) {
  const u = (url || "").toLowerCase();
  if (u.includes(".png") || mime === "image/png")  return "png";
  if (u.includes(".jpg") || u.includes(".jpeg") || mime === "image/jpeg") return "jpg";
  if (u.includes(".gif") || mime === "image/gif")  return "gif";
  if (u.includes(".webp") || mime === "image/webp") return "webp";
  return "jpg";
}

// ── メイン: 検索→DL ──
async function fetchWikimediaImages(searchTerm, prefix, limit = 3, opts = {}) {
  if (!searchTerm) return [];

  const outDir   = opts.outDir   || IMG_DIR;
  const thumbW   = opts.thumbWidth || 1280;
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 検索: namespace=6 (File) で limit*3 件取得し、画像のみ抽出
  let pages = [];
  try {
    const res = await axios.get(COMMONS_API, {
      params: {
        action:       "query",
        generator:    "search",
        gsrsearch:    searchTerm,
        gsrnamespace: 6,
        gsrlimit:     Math.max(limit * 3, 9),
        prop:         "imageinfo",
        iiprop:       "url|size|mime|extmetadata",
        iiurlwidth:   thumbW,
        format:       "json",
      },
      headers: { "User-Agent": UA, "Accept": "application/json" },
      timeout: 15000,
    });
    pages = Object.values(res.data?.query?.pages || {});
  } catch (e) {
    console.warn("[Wikimedia] search failed:", e.message);
    return [];
  }

  // 画像のみ・最低サイズ条件で絞る
  const candidates = pages
    .map(p => p.imageinfo?.[0])
    .filter(Boolean)
    .filter(ii => {
      const mime = ii.mime || "";
      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime)) return false;
      // SVG / アイコン的な小さい画像は除外
      if ((ii.width || 0) < 400) return false;
      if ((ii.height || 0) < 300) return false;
      return true;
    });

  const imagePaths = [];
  const seenUrls   = new Set();
  for (const ii of candidates) {
    if (imagePaths.length >= limit) break;
    const url = ii.thumburl || ii.url;
    if (!url || seenUrls.has(url)) continue;
    try {
      const ext      = inferExt(url, ii.mime);
      const fileName = prefix + "_wiki" + (imagePaths.length + 1) + "." + ext;
      const filePath = path.join(outDir, fileName);
      await downloadImage(url, filePath);
      imagePaths.push(filePath);
      seenUrls.add(url);
    } catch (e) {
      // skip
    }
  }

  return imagePaths;
}

module.exports = { fetchWikimediaImages };

// ── CLI ──
if (require.main === module) {
  const term   = process.argv[2] || "";
  const prefix = process.argv[3] || "wiki_img";
  const limit  = parseInt(process.argv[4] || "3", 10);
  fetchWikimediaImages(term, prefix, limit)
    .then(paths => { process.stdout.write(JSON.stringify(paths, null, 2)); })
    .catch(e   => { process.stderr.write(e.message); process.stdout.write("[]"); process.exit(1); });
}
