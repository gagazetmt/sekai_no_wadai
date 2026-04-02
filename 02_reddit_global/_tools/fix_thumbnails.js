// fix_thumbnails.js - 一回限りの修正スクリプト
// thumbnails/ の JPEG（生画像）を Puppeteer+タイトル付き PNG に再生成する

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const puppeteer = require("puppeteer");

const THUMB_DIR = path.join(__dirname, "thumbnails");
const POSTS_DIR = path.join(__dirname, "posts");
const client = new Anthropic();

// WSL パス (/mnt/c/...) を Windows パス (C:/...) に変換して存在確認
function resolveImagePath(savedPath) {
  if (!savedPath) return null;
  if (fs.existsSync(savedPath)) return savedPath;
  if (savedPath.startsWith("/mnt/")) {
    const winPath = savedPath.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:/`);
    if (fs.existsSync(winPath)) return winPath;
  }
  return null;
}

function buildThumbnailHtml(imageBase64, imageMime, catchCopy) {
  const imgSrc = imageBase64 ? `data:${imageMime};base64,${imageBase64}` : null;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1600px; height: 900px; overflow: hidden; font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; }
  .bg { width: 1600px; height: 900px; position: relative; background: #000; }
  .bg-blur {
    position: absolute; inset: 0;
    ${imgSrc ? `background-image: url('${imgSrc}'); background-size: cover; background-position: center;` : `background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);`}
    filter: blur(28px) brightness(0.38);
    transform: scale(1.08);
  }
  .bg-image {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .bg-image img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.1) 0%, rgba(0,0,0,0.0) 40%, rgba(0,0,0,0.75) 100%); }
  .account {
    position: absolute; top: 52px; right: 48px;
    color: rgba(255,255,255,0.9); font-size: 30px; font-weight: 600;
    text-shadow: 0 1px 6px rgba(0,0,0,0.9); letter-spacing: 1px;
  }
  .bottom { position: absolute; bottom: 0; left: 0; right: 0; padding: 24px 56px 48px; }
  .label {
    display: inline-flex; align-items: center; gap: 8px;
    background: #e00; color: #fff;
    font-size: 28px; font-weight: 800;
    padding: 6px 20px; margin-bottom: 16px; border-radius: 4px; letter-spacing: 3px;
  }
  .catch-line1 {
    color: #FFD700; font-size: 105px; font-weight: 700;
    line-height: 1.15; overflow-wrap: break-word;
    text-shadow: 3px 3px 6px rgba(0,0,0,0.9), 0 0 24px rgba(0,0,0,0.7);
  }
  .catch-line2 {
    color: #fff; font-size: 105px; font-weight: 700;
    line-height: 1.15; overflow-wrap: break-word;
    text-shadow: 3px 3px 6px rgba(0,0,0,0.9), 0 0 24px rgba(0,0,0,0.7);
  }
</style>
</head>
<body>
  <div class="bg">
    <div class="bg-blur"></div>
    <div class="bg-image">${imgSrc ? `<img src="${imgSrc}">` : ""}</div>
    <div class="overlay"></div>
    <div class="account">@sekai_no_wadai</div>
    <div class="bottom">
      <div class="label">🌍 世界の話題</div>
      <div class="catch-line1">${catchCopy.line1.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
      <div class="catch-line2">${catchCopy.line2.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>
    </div>
  </div>
</body>
</html>`;
}

async function generateCatchCopy(title) {
  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: `以下の海外Reddit投稿のサムネイル用キャッチコピーを2行で生成してください。\n\n【元の投稿タイトル】\n${title}\n\n【条件】\n- 1行目：4〜8文字の超短いインパクトワード（例：「奇跡の大逆転」「え、マジで！？」「世界が震えた」）\n- 2行目：補足フレーズ、必ず12文字以内（例：「ゴール直前の奇跡」「揚げ菓子に敗北」）\n- 改行で区切って2行のみ出力\n- 絵文字・句読点不要\n- 感情を最大限に煽る表現にすること\n\n2行のみ出力してください。説明不要。` }],
  });
  const lines = message.content[0].text.trim().split("\n").filter(l => l.trim());
  return { line1: lines[0] || "衝撃の事実", line2: lines[1] || "" };
}

async function generateThumbnail(browser, imagePath, outputPath, catchCopy) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  let imageBase64 = null;
  let imageMime = "image/jpeg";
  if (imagePath && fs.existsSync(imagePath)) {
    const ext = path.extname(imagePath).toLowerCase();
    imageMime = ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg";
    imageBase64 = fs.readFileSync(imagePath).toString("base64");
  }
  const html = buildThumbnailHtml(imageBase64, imageMime, catchCopy);
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: outputPath, type: "png" });
  await page.close();
}

async function main() {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const jsonFile = path.join(__dirname, "temp", `generated_${today}.json`);
  const htmlFile = path.join(POSTS_DIR, `${today}.html`);

  if (!fs.existsSync(jsonFile)) {
    console.log(`generated_${today}.json が見つかりません`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });

  let fixed = 0;
  for (let i = 0; i < data.posts.length; i++) {
    const post = data.posts[i];
    const postNum = i + 1;
    const thumbJpeg = path.join(THUMB_DIR, `${today}_${postNum}.jpeg`);
    const thumbPng  = path.join(THUMB_DIR, `${today}_${postNum}.png`);

    // JPEG があって PNG がない投稿のみ対象
    if (!fs.existsSync(thumbJpeg)) continue;
    if (fs.existsSync(thumbPng)) {
      console.log(`Post ${postNum}: PNG 既存、JPEG だけ削除`);
      fs.unlinkSync(thumbJpeg);
      continue;
    }
    if (post.isVideo) {
      console.log(`Post ${postNum}: 動画投稿、スキップ`);
      continue;
    }

    const imagePath = resolveImagePath(post.savedImagePath);
    if (!imagePath) {
      // images/ フォルダから直接探す
      const fallback = path.join(__dirname, "images", `${today}_${postNum}.jpeg`);
      if (!fs.existsSync(fallback)) {
        console.log(`Post ${postNum}: 画像が見つからない、スキップ`);
        continue;
      }
    }
    const srcImage = imagePath || path.join(__dirname, "images", `${today}_${postNum}.jpeg`);

    console.log(`\nPost ${postNum} "${post.title.slice(0, 50)}" → Puppeteer 再生成中...`);
    const catchCopy = await generateCatchCopy(post.title);
    console.log(`  キャッチコピー: ${catchCopy.line1} / ${catchCopy.line2}`);
    await generateThumbnail(browser, srcImage, thumbPng, catchCopy);
    fs.unlinkSync(thumbJpeg);
    console.log(`  OK: ${path.basename(thumbPng)} 生成 / ${path.basename(thumbJpeg)} 削除`);
    fixed++;
  }

  await browser.close();

  // HTML ランチャーの .jpeg 参照を .png に置換
  if (fixed > 0 && fs.existsSync(htmlFile)) {
    let html = fs.readFileSync(htmlFile, "utf8");
    const before = html;
    html = html.replace(/thumbnails\/([\d-]+_\d+)\.jpeg/g, "thumbnails/$1.png");
    if (html !== before) {
      fs.writeFileSync(htmlFile, html, "utf8");
      console.log(`\nHTML ランチャーを更新しました: ${htmlFile}`);
    }
  }

  if (fixed === 0) {
    console.log("\n修正が必要なサムネイルはありませんでした");
  } else {
    console.log(`\n完了！${fixed} 件のサムネイルを再生成しました。ブラウザをリロードしてください。`);
  }
}

main().catch(console.error);
