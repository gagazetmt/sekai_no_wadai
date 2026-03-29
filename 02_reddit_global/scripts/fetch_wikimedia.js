// fetch_wikimedia.js
// Wikimedia Commons から画像を検索・ダウンロード
// Module export: fetchWikimediaImages(keyword, prefix, limit) → Promise<string[]>

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const axios = require("axios");
const fs    = require("fs");
const path  = require("path");

const IMG_DIR = path.join(__dirname, "..", "images");
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

/**
 * Wikimedia Commons からキーワード検索して画像をダウンロード
 * @param {string} keyword  検索キーワード（英語）
 * @param {string} prefix   保存ファイル名のプレフィックス
 * @param {number} limit    取得枚数（デフォルト5）
 * @returns {Promise<string[]>} ダウンロードしたファイルパスの配列
 */
async function fetchWikimediaImages(keyword, prefix, limit = 5) {
  if (!keyword) return [];

  const query = keyword.trim() + " football";

  let pages = [];
  try {
    const res = await axios.get(COMMONS_API, {
      params: {
        action:       "query",
        generator:    "search",
        gsrnamespace: 6,          // File: 名前空間のみ
        gsrsearch:    query,
        gsrlimit:     Math.min(limit * 8, 50),  // 多めに取ってSVG除外後に絞る
        prop:         "imageinfo",
        iiprop:       "url|mime|size|thumburl",
        iiurlwidth:   800,          // 800pxサムネイルURLを取得
        format:       "json",
        origin:       "*",
      },
      headers: { "User-Agent": "soccer-news-bot/1.0 (https://github.com/soccer-news)" },
      timeout: 12000,
    });
    pages = Object.values(res.data?.query?.pages || {});
  } catch (e) {
    console.warn(`  [Wikimedia] 検索失敗 "${query}": ${e.message}`);
    return [];
  }

  // SVG・小さすぎる画像を除外してダウンロード
  const imagePaths = [];
  for (const page of pages) {
    if (imagePaths.length >= limit) break;
    const info = page.imageinfo?.[0];
    if (!info?.url) continue;
    const mime = info.mime || "";
    if (!mime.startsWith("image/") || mime === "image/svg+xml") continue;
    if ((info.size || 0) < 10000) continue; // 10KB未満はスキップ

    const ext      = mime.includes("png") ? "png" : "jpg";
    const fileName = `${prefix}_wiki${imagePaths.length + 1}.${ext}`;
    const filePath = path.join(IMG_DIR, fileName);

    try {
      // サムネイルURL優先（オリジナルは大きすぎてレートリミットになりやすい）
    const downloadUrl = info.thumburl || info.url;
    const imgRes = await axios.get(downloadUrl, {
        responseType: "arraybuffer",
        timeout:      15000,
        headers:      { "User-Agent": "soccer-news-bot/1.0" },
      });
      fs.writeFileSync(filePath, imgRes.data);
      imagePaths.push(filePath);
      await new Promise(r => setTimeout(r, 150)); // レートリミット対策
    } catch { /* ダウンロード失敗はスキップ */ }
  }

  return imagePaths;
}

module.exports = { fetchWikimediaImages };

// ── CLI実行 ──
if (require.main === module) {
  const keyword = process.argv[2] || "Manchester City";
  const prefix  = process.argv[3] || "wiki_test";
  fetchWikimediaImages(keyword, prefix, 5)
    .then(paths => console.log(`取得: ${paths.length}枚\n`, paths))
    .catch(e => console.error(e.message));
}
