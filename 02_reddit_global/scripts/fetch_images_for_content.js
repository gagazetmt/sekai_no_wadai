// fetch_images_for_content.js
// VPS 定刻実行: content_YYYY-MM-DD.json を読み込み、
// 既存の画像取得モジュールで X/Wikimedia/OG 画像を取得して
// soccer_yt_content_YYYY-MM-DD.json に保存する
//
// 使い方:
//   node scripts/fetch_images_for_content.js [YYYY-MM-DD]

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs   = require("fs");
const path = require("path");
const axios = require("axios");

// 既存モジュールをそのまま利用
const { fetchMatchImages }                                          = require("./fetch_match_images");
const { fetchXImages, fetchOfficialXImages, fetchOfficialXImagesFromQuery } = require("./fetch_x_images");
const { fetchWikimediaImages }                                      = require("./fetch_wikimedia");

const TEMP_DIR = path.join(__dirname, "..", "temp");
const IMG_DIR  = path.join(__dirname, "..", "images");
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const dateArg   = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);

const CONCURRENCY = 3;

// ─── RSS OG画像取得（既存 generate_content.js と同じロジック） ───────────────
async function fetchOgImage(articleUrl, prefix) {
  try {
    const res  = await axios.get(articleUrl, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
    const html = res.data;
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return [];
    const imgUrl = m[1].startsWith("//") ? "https:" + m[1] : m[1];
    const ext    = imgUrl.includes(".png") ? "png" : "jpg";
    const dest   = path.join(IMG_DIR, `${prefix}_og.${ext}`);
    const imgRes = await axios.get(imgUrl, { responseType: "arraybuffer", timeout: 12000 });
    fs.writeFileSync(dest, imgRes.data);
    return [dest];
  } catch { return []; }
}

// ─── 1投稿の画像取得 ─────────────────────────────────────────────────────────
async function fetchImagesForPost(post, num, date) {
  const meta   = post._imgMeta;
  if (!meta) { console.warn(`  [${num}] _imgMeta なし、スキップ`); return post; }
  if (meta.imgFetched) { console.log(`  [${num}] 取得済み、スキップ`); return post; }

  const prefix     = `${date}_${num}`;
  const imagePaths = [];
  const isMatch    = meta.type === "post-match";

  console.log(`▶ [${num}] [${meta.type}] ${meta.title.slice(0, 60)}`);

  if (isMatch && meta.matchData) {
    // ── 試合: fetchMatchImages（X公式×2 + KW検索）──────────────────────────
    const { homeTeam, awayTeam } = meta.matchData;
    try {
      process.stdout.write(`  [${num}] 試合画像取得中 (${homeTeam} vs ${awayTeam})... `);
      const matchPaths = await fetchMatchImages({
        homeTeam, awayTeam, matchDate: date, saveDir: IMG_DIR, prefix, verbose: false,
      });
      imagePaths.push(...matchPaths);
      console.log(`${matchPaths.length}枚`);
    } catch (e) { console.warn(`⚠️ ${e.message}`); }
  } else {
    // ── トピック: OG画像（RSS のみ）+ X公式 + KW検索 ──────────────────────
    if (meta.source === "rss" && meta.url) {
      process.stdout.write(`  [${num}] OG画像取得中... `);
      const ogPaths = await fetchOgImage(meta.url, prefix);
      imagePaths.push(...ogPaths);
      console.log(`${ogPaths.length}枚`);
    }

    if (process.env.TWITTER_API_IO_KEY && meta.xSearchQuery) {
      try {
        process.stdout.write(`  [${num}] X画像取得中 ["${meta.xSearchQuery.slice(0,30)}"]... `);
        const [xPaths, officialPaths] = await Promise.all([
          fetchXImages(`${meta.xSearchQuery} filter:images -filter:retweets`, prefix, 10, "Top"),
          fetchOfficialXImagesFromQuery(meta.xSearchQuery, prefix, 5),
        ]);
        imagePaths.push(...officialPaths, ...xPaths);
        console.log(`X:${xPaths.length}枚 + 公式:${officialPaths.length}枚`);
      } catch (e) { console.warn(`⚠️ ${e.message}`); }
    }
  }

  // ── Wikimedia（選手・監督名）─────────────────────────────────────────────
  const wikiWords = meta.wikiWords || [];
  if (wikiWords.length > 0) {
    process.stdout.write(`  [${num}] Wikimedia取得中 [${wikiWords.join(", ")}]... `);
    const wikiResults = await Promise.all(
      wikiWords.map((w, i) => fetchWikimediaImages(w, `${prefix}_wm${i}`).catch(() => []))
    );
    const wikiPaths = wikiResults.flat();
    imagePaths.push(...wikiPaths);
    console.log(`${wikiPaths.length}枚`);
  }

  // 画像をスライドに割り当て
  return {
    ...post,
    imagePaths,
    mainImagePath:   imagePaths[0] || null,
    slide2ImagePath: imagePaths[1] || imagePaths[0] || null,
    slide3ImagePath: imagePaths[1] || null,
    slide4ImagePath: imagePaths[2] || null,
    slide5ImagePath: null,
    _imgMeta: { ...meta, imgFetched: true, fetchedAt: new Date(now.getTime() + jstOffset).toISOString() },
  };
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const contentFile = path.join(TEMP_DIR, `content_${dateArg}.json`);
  if (!fs.existsSync(contentFile)) {
    console.error(`❌ content_${dateArg}.json が見つかりません (${contentFile})`);
    process.exit(1);
  }

  const data  = JSON.parse(fs.readFileSync(contentFile, "utf8"));
  const posts = data.posts || [];
  const todo  = posts.filter(p => !p._imgMeta?.imgFetched);

  console.log(`\n🖼  画像取得開始 (${dateArg}) — 対象: ${todo.length}件 / 取得済み: ${posts.length - todo.length}件`);
  console.log("─".repeat(50));

  // 並列処理（concurrency=3）
  const updated = [...posts];
  for (let i = 0; i < updated.length; i++) {
    if (updated[i]._imgMeta?.imgFetched) continue;
    updated[i] = await fetchImagesForPost(updated[i], i + 1, dateArg);
  }

  // soccer_yt_content_YYYY-MM-DD.json として保存（ランチャーが読む標準フォーマット）
  const outputFile = path.join(TEMP_DIR, `soccer_yt_content_${dateArg}.json`);
  const output = { date: dateArg, posts: updated };
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

  // content JSON の imgFetched フラグも更新
  data.posts = updated;
  fs.writeFileSync(contentFile, JSON.stringify(data, null, 2));

  const fetchedCount = updated.filter(p => p.imagePaths?.length > 0).length;
  console.log(`\n✅ 画像取得完了: ${fetchedCount}/${updated.length}件に画像あり`);
  console.log(`   → ${outputFile}`);
}

main().catch(e => { console.error(`❌ Fatal: ${e.message}`); process.exit(1); });
