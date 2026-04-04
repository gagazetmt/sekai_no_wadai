// fetch_images_for_content.js
// VPS 定刻実行: content_YYYY-MM-DD.json を読み込み、
// DeepSeekが最適な検索戦略を立て X/Wikimedia/OG 画像を取得して
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
const { fetchMatchImages }                          = require("./fetch_match_images");
const { fetchXImages, fetchOfficialXImages }        = require("./fetch_x_images");
const { fetchWikimediaImages }                      = require("./fetch_wikimedia");

const TEMP_DIR = path.join(__dirname, "..", "temp");
const IMG_DIR  = path.join(__dirname, "..", "images");
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const dateArg   = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);

// ─── 公式Xアカウント辞書（チーム名一覧） ────────────────────────────────────────
const TEAM_X_ACCOUNTS = (() => {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "logos", "team_x_accounts.json"), "utf8"));
    return raw.teams || raw;
  } catch { return {}; }
})();
const TEAM_NAMES_LIST = Object.keys(TEAM_X_ACCOUNTS).join(", ");

// ─── OG画像取得 ──────────────────────────────────────────────────────────────
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

// ─── DeepSeek による画像検索プラン生成 ──────────────────────────────────────────
async function planImageSearch(post) {
  const meta = post._imgMeta;
  const prompt = `あなたはサッカーニュースのYouTube動画用画像収集の専門家です。
以下の投稿について、最も効果的な画像取得戦略をJSON形式で返してください。

【投稿情報】
元タイトル(英): ${meta.title}
日本語タイトル: ${post.youtubeTitle || post.catchLine1 || ""}
ハッシュタグ: ${post.hashtagsText || ""}
概要: ${(post.overviewNarration || "").slice(0, 200)}

【取得方法と上限】
1. X検索 (最大6枚): 英語キーワードで一般ツイートから画像検索
2. チーム公式X (最大6枚): 以下の辞書に登録されたチーム名を指定すると公式アカウントから取得
   登録チーム: ${TEAM_NAMES_LIST}
3. Wikimedia (残りを多段検索): 選手名・監督名・チーム名等で百科事典画像を取得

【返却形式】JSONのみ（説明不要）:
{
  "xKeywords": "英語検索クエリ（具体的な人名・チーム名・事象を含む3-5ワード。filter:imagesは不要）",
  "officialTeams": ["辞書に登録されているチーム名"],
  "wikiWords": ["優先度順の検索ワード（選手名・監督名・チーム名を英語で）"]
}`;

  try {
    const raw = await callAI({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
      system: "あなたはサッカー画像検索の専門家です。JSONのみを返してください。",
    });
    const m = raw.match(/\{[\s\S]*?\}/);
    if (!m) throw new Error("JSON not found");
    const plan = JSON.parse(m[0]);
    // officialTeams は辞書に存在するものだけに絞る
    if (Array.isArray(plan.officialTeams)) {
      plan.officialTeams = plan.officialTeams.filter(name =>
        Object.keys(TEAM_X_ACCOUNTS).some(k => k.toLowerCase() === (name || "").toLowerCase())
      );
    }
    return plan;
  } catch (e) {
    console.warn(`  ⚠️ プラン生成失敗: ${e.message} → フォールバック`);
    return {
      xKeywords: meta.xSearchQuery || meta.title.slice(0, 60),
      officialTeams: [],
      wikiWords: meta.wikiWords || [],
    };
  }
}

// ─── AI による画像スライド配置選定 ──────────────────────────────────────────────
async function selectBestImagesWithAI(title, imageInfos) {
  if (!imageInfos || imageInfos.length === 0) return {};
  const prompt = `以下のサッカーニュースに最適な画像を選んでスライドに配置してください。
ニュースタイトル: ${title}

画像リスト:
${imageInfos.map((img, i) => `${i}: [出所:${img.source}] [KW:${img.kw}]`).join("\n")}

以下のJSONのみを返してください（なるべく異なる画像を選択）:
{"main": 番号, "s2": 番号, "s3": 番号, "s4": 番号}
- main: サムネイル用（選手・監督の顔、インパクトある場面）
- s2: 概要用（公式発表、試合シーン）
- s3: 反応用1（スタジアム、現地の熱気）
- s4: 反応用2（補足画像）`;

  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 150, messages: [{ role: "user", content: prompt }] });
    const m = raw.match(/\{[\s\S]*?\}/);
    if (!m) return {};
    return JSON.parse(m[0]);
  } catch (e) {
    console.warn(`  ⚠️ AI画像選定失敗: ${e.message}`);
    return {};
  }
}

// ─── 1投稿の画像取得（DeepSeek戦略ベース） ──────────────────────────────────────
async function fetchImagesForPost(post, num, date) {
  const meta = post._imgMeta;
  if (!meta) { console.warn(`  [${num}] _imgMeta なし、スキップ`); return post; }
  if (meta.imgFetched) { console.log(`  [${num}] 取得済み、スキップ`); return post; }

  const prefix     = `${date}_${num}`;
  const imageInfos = [];
  const isMatch    = meta.type === "post-match";

  console.log(`▶ [${num}] [${meta.type}] ${meta.title.slice(0, 60)}`);

  // ── 試合画像（post-match） ─────────────────────────────────────────────────
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
    // ── DeepSeek で検索プランを生成 ──────────────────────────────────────────
    process.stdout.write(`  [${num}] DeepSeekが検索戦略を立案中... `);
    const plan = await planImageSearch(post);
    console.log(`完了`);
    console.log(`       X:"${plan.xKeywords}" / 公式:${JSON.stringify(plan.officialTeams)} / Wiki(${plan.wikiWords?.length || 0}ワード):${(plan.wikiWords || []).join(", ")}`);

    // OG画像（RSSのみ）
    if (meta.source === "rss" && meta.url) {
      const ogPaths = await fetchOgImage(meta.url, prefix);
      imageInfos.push(...ogPaths.map(p => ({ path: p, source: "RSS_OGP", kw: meta.title })));
    }

    // ── ① X検索（最大6枚） ────────────────────────────────────────────────
    if (process.env.TWITTER_API_IO_KEY && plan.xKeywords) {
      try {
        process.stdout.write(`  [${num}] X検索(最大6枚)... `);
        const xPaths = await fetchXImages(
          `${plan.xKeywords} filter:images -filter:retweets`,
          prefix, 6, "Latest"
        );
        imageInfos.push(...xPaths.map(p => ({ path: p, source: "X_Search", kw: plan.xKeywords })));
        console.log(`${xPaths.length}枚`);
      } catch (e) { console.warn(`⚠️ ${e.message}`); }
    }

    // ── ② 公式チームX（最大6枚・複数チームは均等配分） ──────────────────────
    if (process.env.TWITTER_API_IO_KEY && plan.officialTeams?.length > 0) {
      try {
        process.stdout.write(`  [${num}] 公式X(${plan.officialTeams.join(", ")})... `);
        const perTeam = Math.ceil(6 / plan.officialTeams.length);
        const results = await Promise.all(
          plan.officialTeams.map((name, i) =>
            fetchOfficialXImages(name, `${prefix}_nt${i}`, perTeam).catch(() => [])
          )
        );
        const officialPaths = results.flat().slice(0, 6);
        imageInfos.push(...officialPaths.map(p => ({ path: p, source: "Official_X", kw: plan.officialTeams.join(", ") })));
        console.log(`${officialPaths.length}枚`);
      } catch (e) { console.warn(`⚠️ ${e.message}`); }
    }

    // ── ③ Wikimedia 多段検索（15枚以上集まるまでワードを順に試す） ────────────
    if (plan.wikiWords?.length > 0) {
      process.stdout.write(`  [${num}] Wikimedia多段検索(${plan.wikiWords.length}ワード)... `);
      let wikiTotal = 0;
      for (let i = 0; i < plan.wikiWords.length; i++) {
        if (imageInfos.length >= 15) break;
        const wikiPaths = await fetchWikimediaImages(plan.wikiWords[i], `${prefix}_wm${i}`).catch(() => []);
        imageInfos.push(...wikiPaths.map(p => ({ path: p, source: "Wikimedia", kw: plan.wikiWords[i] })));
        wikiTotal += wikiPaths.length;
      }
      console.log(`${wikiTotal}枚`);
    }
  }

  // ── AI による画像スライド配置 ─────────────────────────────────────────────
  process.stdout.write(`  [${num}] AI画像配置(${imageInfos.length}枚から選定)... `);
  const selection = await selectBestImagesWithAI(meta.title, imageInfos);
  console.log("完了");

  const imagePaths = imageInfos.map(info => info.path);
  const getIdx = (key, def) =>
    (selection[key] !== undefined && imageInfos[selection[key]])
      ? imageInfos[selection[key]].path
      : (imagePaths[def] || null);

  return {
    ...post,
    imagePaths,
    mainImagePath:   getIdx("main", 0),
    slide2ImagePath: getIdx("s2",   1) || getIdx("main", 0),
    slide3ImagePath: getIdx("s3",   2) || getIdx("s2",   1),
    slide4ImagePath: getIdx("s4",   3) || getIdx("s3",   2),
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

  const updated = [...posts];
  for (let i = 0; i < updated.length; i++) {
    if (updated[i]._imgMeta?.imgFetched) continue;
    updated[i] = await fetchImagesForPost(updated[i], i + 1, dateArg);
  }

  // soccer_yt_content_YYYY-MM-DD.json として保存（ランチャー読み込み用）
  const outputFile = path.join(TEMP_DIR, `soccer_yt_content_${dateArg}.json`);
  fs.writeFileSync(outputFile, JSON.stringify({ date: dateArg, posts: updated }, null, 2));

  // content JSON の imgFetched フラグも更新
  data.posts = updated;
  fs.writeFileSync(contentFile, JSON.stringify(data, null, 2));

  const fetchedCount = updated.filter(p => p.imagePaths?.length > 0).length;
  console.log(`\n✅ 画像取得完了: ${fetchedCount}/${updated.length}件に画像あり`);
  console.log(`   → ${outputFile}`);
}

main().catch(e => { console.error(`❌ Fatal: ${e.message}`); process.exit(1); });
