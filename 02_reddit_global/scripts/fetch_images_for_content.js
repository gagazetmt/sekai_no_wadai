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
const { callAI } = require("./ai_client");

// 既存モジュールをそのまま利用
const { fetchMatchImages }                                          = require("./fetch_match_images");
const { fetchXImages, fetchOfficialXImages, fetchOfficialXImagesFromQuery } = require("./fetch_x_images");
const { fetchWikimediaImages }                                      = require("./fetch_wikimedia");

const TEMP_DIR = path.join(__dirname, "..", "temp");
const IMG_DIR  = path.join(__dirname, "..", "images");
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

// ─── AI による画像選定 ───────────────────────────────────────────────────────
async function selectBestImagesWithAI(title, imageInfos) {
  if (!imageInfos || imageInfos.length === 0) return {};
  const prompt = `以下のサッカーニュースに最適な画像を、リストから選んでスライドに配置してください。
ニュースタイトル: ${title}

画像リスト:
${imageInfos.map((img, i) => `${i}: [出所:${img.source}] [検索ワード:${img.kw}]`).join("\n")}

以下のスライドに最適な画像の番号をJSON形式で返してください。なるべく違う画像を選んでください。
{"main": 番号, "s2": 番号, "s3": 番号, "s4": 番号}
- main: サムネイル用（監督・選手の顔、決定的な瞬間）
- s2: ニュース概要用（公式発表、試合結果）
- s3: 反応用1（現地の熱気、スタジアム）
- s4: 反応用2（補足的な画像）
JSONのみを返してください。`;

  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 150, messages: [{ role: "user", content: prompt }] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return {};
    return JSON.parse(m[0]);
  } catch (e) {
    console.warn(`  ⚠️ AI画像選定失敗: ${e.message}`);
    return {};
  }
}

// ─── RSS OG画像取得（既存 generate_content.js と同じロジック） ───────────────
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
  const imageInfos = []; // { path, source, kw } のリスト
  const isMatch    = meta.type === "post-match";

  console.log(`▶ [${num}] [${meta.type}] ${meta.title.slice(0, 60)}`);

  // 試合画像取得 (Post-match)
  if (isMatch && meta.matchData) {
    const { homeTeam, awayTeam } = meta.matchData;
    try {
      process.stdout.write(`  [${num}] 試合画像取得中 (${homeTeam} vs ${awayTeam})... `);
      const matchPaths = await fetchMatchImages({
        homeTeam, awayTeam, matchDate: date, saveDir: IMG_DIR, prefix, verbose: false,
      });
      imageInfos.push(...matchPaths.map(p => ({ path: p, source: "Official/Match", kw: `${homeTeam} ${awayTeam}` })));
      console.log(`${matchPaths.length}枚`);
    } catch (e) { console.warn(`⚠️ ${e.message}`); }
  } else {
    // トピック画像取得 (OG画像 + X検索)
    if (meta.source === "rss" && meta.url) {
      process.stdout.write(`  [${num}] OG画像取得中... `);
      const ogPaths = await fetchOgImage(meta.url, prefix);
      imageInfos.push(...ogPaths.map(p => ({ path: p, source: "RSS_OGP", kw: meta.title })));
      console.log(`${ogPaths.length}枚`);
    }

    if (process.env.TWITTER_API_IO_KEY && meta.xSearchQuery) {
      try {
        process.stdout.write(`  [${num}] X画像取得中 ["${meta.xSearchQuery.slice(0,30)}"]... `);
        let [xPaths, officialPaths] = await Promise.all([
          fetchXImages(`${meta.xSearchQuery} filter:images -filter:retweets`, prefix, 10, "Latest"),
          fetchOfficialXImagesFromQuery(meta.xSearchQuery, prefix, 5),
        ]);

        // しぶといフォールバック
        if (xPaths.length + officialPaths.length < 3 && meta.wikiWords && meta.wikiWords.length > 0) {
          for (let i = 0; i < meta.wikiWords.length; i++) {
            if (xPaths.length + officialPaths.length >= 5) break;
            const fallbackKw = meta.wikiWords[i];
            process.stdout.write(`(再検索[${i}]: ${fallbackKw}) `);
            const fbPaths = await fetchXImages(`${fallbackKw} filter:images -filter:retweets`, `${prefix}_fb${i}`, 5, "Latest");
            xPaths.push(...fbPaths);
          }
        }
        imageInfos.push(...officialPaths.map(p => ({ path: p, source: "Official_X", kw: meta.xSearchQuery })));
        imageInfos.push(...xPaths.map(p => ({ path: p, source: "X_Search", kw: meta.xSearchQuery })));
        console.log(`X:${xPaths.length}枚 + 公式:${officialPaths.length}枚`);
      } catch (e) { console.warn(`⚠️ ${e.message}`); }
    }
  }

  // Wikimedia取得
  const wikiWords = meta.wikiWords || [];
  if (wikiWords.length > 0) {
    process.stdout.write(`  [${num}] Wikimedia取得中 [${wikiWords.join(", ")}]... `);
    const wikiResults = await Promise.all(
      wikiWords.map((w, i) => fetchWikimediaImages(w, `${prefix}_wm${i}`).catch(() => []))
    );
    wikiResults.forEach((paths, i) => {
      imageInfos.push(...paths.map(p => ({ path: p, source: "Wikimedia", kw: wikiWords[i] })));
    });
    console.log(`${wikiResults.flat().length}枚`);
  }

  // ── AI による画像選定 ──
  process.stdout.write(`  [${num}] AIによる画像最適配置中... `);
  const selection = await selectBestImagesWithAI(meta.title, imageInfos);
  console.log("完了");

  const imagePaths = imageInfos.map(info => info.path);
  const getIdx = (key, def) => (selection[key] !== undefined && imageInfos[selection[key]]) ? imageInfos[selection[key]].path : (imagePaths[def] || null);

  return {
    ...post,
    imagePaths,
    mainImagePath:   getIdx("main", 0),
    slide2ImagePath: getIdx("s2", 1) || getIdx("main", 0),
    slide3ImagePath: getIdx("s3", 2) || getIdx("s2", 1),
    slide4ImagePath: getIdx("s4", 3) || getIdx("s3", 2),
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
