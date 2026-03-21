// fetch_reddit_images.js
// Reddit から画像を最大N枚検索してローカルにダウンロードするモジュール
//
// 使い方 (CLI):
//   node fetch_reddit_images.js --query "chelsea arsenal" --subreddit soccer --count 3 --prefix 2026-03-21_1
//
// 使い方 (require):
//   const { fetchImagesFromReddit } = require("./fetch_reddit_images");
//   const paths = await fetchImagesFromReddit({ query: "chelsea", count: 3, prefix: "2026-03-21_1" });

require("dotenv").config();
const fs   = require("fs");
const path = require("path");

const DEFAULT_IMAGE_DIR = path.join(__dirname, "..", "images");

async function fetchImagesFromReddit({
  subreddit = "soccer",
  query,
  count     = 3,
  saveDir   = DEFAULT_IMAGE_DIR,
  prefix    = "img",
}) {
  if (!query) throw new Error("query が必要です");
  if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

  console.log(`[Reddit画像] r/${subreddit} で "${query}" を検索中...`);

  const searchUrl =
    `https://www.reddit.com/r/${subreddit}/search.json?` +
    `q=${encodeURIComponent(query)}&sort=hot&limit=25&restrict_sr=1&type=link`;

  const res = await fetch(searchUrl, {
    headers: { "User-Agent": "yt-img-fetcher/1.0" },
  });
  if (!res.ok) throw new Error(`Reddit search: ${res.status}`);

  const data  = await res.json();
  const posts = data?.data?.children || [];

  if (!posts.length) {
    console.warn("[Reddit画像] 投稿が見つかりませんでした");
    return [];
  }

  // ── 画像URL候補を収集 ──────────────────────────────────────────────────────
  const candidates = [];

  for (const post of posts) {
    const d = post.data;

    // ① 直接画像投稿（i.redd.it）
    if (d.post_hint === "image" && d.url && /\.(jpg|jpeg|png)(\?|$)/i.test(d.url)) {
      candidates.push({ url: d.url, title: d.title });
    }
    // ② プレビュー画像（最大解像度）
    else if (d.preview?.images?.[0]?.source?.url) {
      const url = d.preview.images[0].source.url.replace(/&amp;/g, "&");
      candidates.push({ url, title: d.title });
    }
    // ③ ギャラリー投稿（複数画像）
    else if (d.is_gallery && d.media_metadata) {
      for (const item of Object.values(d.media_metadata)) {
        if (item.status !== "valid" || !item.s?.u) continue;
        candidates.push({
          url:   item.s.u.replace(/&amp;/g, "&"),
          title: d.title,
        });
        if (candidates.length >= count * 3) break;
      }
    }

    if (candidates.length >= count * 3) break;
  }

  console.log(`[Reddit画像] ${candidates.length}件の候補を発見`);

  // ── ダウンロード ───────────────────────────────────────────────────────────
  const savedPaths = [];

  for (let i = 0; i < candidates.length && savedPaths.length < count; i++) {
    const { url, title } = candidates[i];
    const ext     = url.match(/\.(jpg|jpeg|png)/i)?.[1]?.toLowerCase() || "jpg";
    const outPath = path.join(saveDir, `${prefix}_${savedPaths.length + 1}.${ext}`);

    try {
      const imgRes = await fetch(url, {
        headers: {
          "User-Agent": "yt-img-fetcher/1.0",
          "Referer":    "https://www.reddit.com/",
        },
      });
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);

      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length < 10000) throw new Error("ファイルサイズが小さすぎます（10KB未満）");

      fs.writeFileSync(outPath, buf);
      savedPaths.push(outPath);
      console.log(`  ✅ 画像${savedPaths.length}: ${path.basename(outPath)} (${Math.round(buf.length / 1024)}KB)`);
    } catch (err) {
      console.warn(`  ⚠️ スキップ [${i + 1}]: ${err.message}`);
    }
  }

  if (savedPaths.length === 0) {
    console.warn("[Reddit画像] 保存できた画像が0件でした");
  } else {
    console.log(`[Reddit画像] 完了: ${savedPaths.length}枚保存`);
  }

  return savedPaths;
}

module.exports = { fetchImagesFromReddit };

// ── CLI 実行 ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    args[process.argv[i]?.replace(/^--/, "")] = process.argv[i + 1];
  }

  if (!args.query) {
    console.error("使い方: node fetch_reddit_images.js --query \"chelsea\" --subreddit soccer --count 3 --prefix 2026-03-21_1");
    process.exit(1);
  }

  fetchImagesFromReddit({
    query:     args.query,
    subreddit: args.subreddit || "soccer",
    count:     parseInt(args.count || "3"),
    prefix:    args.prefix || "img",
    saveDir:   args.savedir || path.join(__dirname, "..", "images"),
  }).then(paths => {
    console.log(`\n取得完了: ${paths.length}枚`);
    paths.forEach(p => console.log(`  ${p}`));
  }).catch(err => {
    console.error(`エラー: ${err.message}`);
    process.exit(1);
  });
}
