// fetch_stock_lookup.js
// ストック素材から画像パスを取得するルックアップモジュール
//
// 使い方（モジュール）:
//   const { lookupStockImages } = require("./fetch_stock_lookup");
//   const paths = lookupStockImages("Deschamps World Cup cooling break", { max: 4 });
//
// 使い方（CLI テスト）:
//   node scripts/fetch_stock_lookup.js "Deschamps World Cup cooling break"

const fs   = require("fs");
const path = require("path");

const STOCK_DIR   = path.join(__dirname, "..", "stock");
const STOCK_INDEX = path.join(STOCK_DIR, "index.json");
const IMG_EXTS    = [".jpg", ".jpeg", ".png", ".webp"];

// ─── フォルダ方式：フォルダ内の画像ファイルを全部返す ─────────────────────────
function getImagesFromFolder(folderPath) {
  if (!fs.existsSync(folderPath)) return [];
  return fs.readdirSync(folderPath)
    .filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase()))
    .sort()
    .map(f => path.join(folderPath, f));
}

// ─── ファイル名方式：プレフィックス一致でファイルを全部返す ──────────────────
function getImagesByPrefix(dir, keyword) {
  if (!fs.existsSync(dir)) return [];
  const lower = keyword.toLowerCase().replace(/\s+/g, "_");
  return fs.readdirSync(dir)
    .filter(f => {
      const base = path.basename(f, path.extname(f)).toLowerCase().replace(/\s+/g, "_");
      return IMG_EXTS.includes(path.extname(f).toLowerCase()) && base === lower;
    })
    .map(f => path.join(dir, f));
}

// ─── index.json のカテゴリマップから slug を検索 ─────────────────────────────
function findSlug(map, text) {
  // 完全一致優先
  const lower = text.toLowerCase();
  for (const [key, slug] of Object.entries(map)) {
    if (key.toLowerCase() === lower) return slug;
  }
  // 部分一致（テキスト内にキーが含まれる）
  for (const [key, slug] of Object.entries(map)) {
    if (lower.includes(key.toLowerCase())) return slug;
  }
  return null;
}

// ─── メイン：テキストからストック画像パスを返す ───────────────────────────────
// @param text  - 記事タイトルや説明文（英語）
// @param opts  - { max: number }  取得上限枚数（デフォルト5）
// @returns     - 画像パスの配列（重複なし、上限あり）
function lookupStockImages(text, opts = {}) {
  const max     = opts.max ?? 5;
  const index   = JSON.parse(fs.readFileSync(STOCK_INDEX, "utf8"));
  const results = [];
  const seen    = new Set();

  function addPaths(paths) {
    for (const p of paths) {
      if (!seen.has(p) && results.length < max) {
        seen.add(p);
        results.push(p);
      }
    }
  }

  // ── 1. manager ──────────────────────────────────────────────────────────────
  const managerSlug = findSlug(index.manager, text);
  if (managerSlug) {
    addPaths(getImagesFromFolder(path.join(STOCK_DIR, "manager", managerSlug)));
  }

  // ── 2. player ───────────────────────────────────────────────────────────────
  const playerSlug = findSlug(index.player, text);
  if (playerSlug) {
    addPaths(getImagesFromFolder(path.join(STOCK_DIR, "player", playerSlug)));
  }

  // ── 3. team ─────────────────────────────────────────────────────────────────
  const teamSlug = findSlug(index.team, text);
  if (teamSlug) {
    addPaths(getImagesFromFolder(path.join(STOCK_DIR, "team", teamSlug)));
  }

  // ── 4. keyword（ファイル名方式） ─────────────────────────────────────────────
  const keywordDir = path.join(STOCK_DIR, "keyword");
  if (fs.existsSync(keywordDir)) {
    const lower = text.toLowerCase();
    const keywordFiles = fs.readdirSync(keywordDir)
      .filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase()))
      .sort();
    for (const f of keywordFiles) {
      const base = path.basename(f, path.extname(f)).toLowerCase();
      if (lower.includes(base)) {
        addPaths([path.join(keywordDir, f)]);
      }
    }
  }

  // ── 5. other（ファイル名方式） ────────────────────────────────────────────────
  if (results.length < max) {
    const otherDir = path.join(STOCK_DIR, "other");
    if (fs.existsSync(otherDir)) {
      const lower = text.toLowerCase();
      const otherFiles = fs.readdirSync(otherDir)
        .filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase()))
        .sort();
      for (const f of otherFiles) {
        const base = path.basename(f, path.extname(f)).toLowerCase();
        if (lower.includes(base)) {
          addPaths([path.join(otherDir, f)]);
        }
      }
    }
  }

  return results;
}

module.exports = { lookupStockImages };

// ─── CLI テスト ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const text = process.argv[2];
  if (!text) {
    console.error("使い方: node scripts/fetch_stock_lookup.js \"検索テキスト\"");
    process.exit(1);
  }
  const paths = lookupStockImages(text, { max: 5 });
  if (paths.length === 0) {
    console.log("ヒットなし");
  } else {
    console.log(`${paths.length}枚ヒット:`);
    paths.forEach(p => console.log(" ", p));
  }
}
