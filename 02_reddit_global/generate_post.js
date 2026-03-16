// Reddit → 日本語X投稿文 自動生成スクリプト（10件/日版）
// 使い方: node generate_post.js

require("dotenv").config();
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const Anthropic = require("@anthropic-ai/sdk");
const puppeteer = require("puppeteer");

const FFMPEG = "C:\\ffmpeg\\bin\\ffmpeg.exe";

// 画像・投稿文保存フォルダの作成
const IMAGE_DIR = path.join(__dirname, "images");
if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR);
const POSTS_DIR = path.join(__dirname, "posts");
if (!fs.existsSync(POSTS_DIR)) fs.mkdirSync(POSTS_DIR);
const THUMB_DIR = path.join(__dirname, "thumbnails");
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR);
const VIDEOS_DIR = path.join(__dirname, "videos");
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR);
const TEMP_DIR = path.join(__dirname, "temp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// 朝・夜のゴールデンタイムに集中した予約投稿時間
const SCHEDULE_TIMES = [
  "06:00", "06:30", "07:00", "07:30", "08:00",
  "20:00", "20:30", "21:00", "21:30", "22:00",
];

// 画像をダウンロードして保存（リダイレクト対応・最大5回）
function downloadImage(url, filename, redirectCount = 0) {
  return new Promise((resolve) => {
    if (redirectCount > 5) return resolve(null);
    const filePath = path.join(IMAGE_DIR, filename);
    const protocol = url.startsWith("https") ? https : http;

    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
      },
    };

    const req = protocol.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        const location = res.headers.location;
        res.resume();
        if (!location) return resolve(null);
        const nextUrl = location.startsWith("http") ? location : new URL(location, url).href;
        return downloadImage(nextUrl, filename, redirectCount + 1).then(resolve);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve(null);
      }

      const file = fs.createWriteStream(filePath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(filePath); });
      file.on("error", () => resolve(null));
    });

    req.on("error", () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
  });
}

// Reddit動画をダウンロードして保存（映像+音声を合成）
async function downloadRedditVideo(videoUrl, filename) {
  const videoPath = path.join(VIDEOS_DIR, filename);
  const tempVideoPath = videoPath.replace(".mp4", "_video.mp4");
  const tempAudioPath = videoPath.replace(".mp4", "_audio.mp4");

  // 映像ストリームをDL
  const videoDownloaded = await downloadImage(videoUrl, `../_tmp_v_${filename}`);
  if (!videoDownloaded) return null;
  const rawVideoPath = path.join(IMAGE_DIR, `../_tmp_v_${filename}`);
  if (!fs.existsSync(rawVideoPath)) return null;
  fs.renameSync(rawVideoPath, tempVideoPath);

  // 音声ストリームを試みる（v.redd.it の DASH_audio.mp4）
  const audioUrl = videoUrl.replace(/DASH_\d+\.mp4.*/, "DASH_audio.mp4");
  let hasAudio = false;
  if (audioUrl !== videoUrl) {
    const audioDownloaded = await downloadImage(audioUrl, `../_tmp_a_${filename}`);
    const rawAudioPath = path.join(IMAGE_DIR, `../_tmp_a_${filename}`);
    if (audioDownloaded && fs.existsSync(rawAudioPath)) {
      fs.renameSync(rawAudioPath, tempAudioPath);
      hasAudio = true;
    }
  }

  try {
    if (hasAudio) {
      // 映像+音声を合成
      execSync(
        `"${FFMPEG}" -y -i "${tempVideoPath}" -i "${tempAudioPath}" -c:v copy -c:a aac -shortest "${videoPath}"`,
        { stdio: "pipe" }
      );
    } else {
      // 音声なしのままコピー
      fs.renameSync(tempVideoPath, videoPath);
    }
    return videoPath;
  } catch (e) {
    console.log(`⚠️  動画合成失敗: ${e.message}`);
    return null;
  } finally {
    if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
    if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
  }
}

const client = new Anthropic();

// 取得するサブレディット（8個に拡張）
const SUBREDDITS = [
  "todayilearned",        // 今日知ったこと
  "interestingasfuck",    // 面白い事実・映像
  "nextfuckinglevel",     // すごい技術・才能
  "mildlyinteresting",    // ちょっと面白いこと
  "Damnthatsinteresting", // 驚きの事実・画像
  "BeAmazed",             // 驚きの動画・事実
  "aww",                  // かわいい動物
  "Unexpected",           // 予想外の展開
];

// Redditからデータ取得
function fetchSubreddit(subreddit) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "www.reddit.com",
      path: `/r/${subreddit}/top.json?limit=10&t=day`,
      headers: { "User-Agent": "sekai-no-wadai-bot/1.0" },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const posts = json.data.children.map((child) => {
            const d = child.data;
            const isVideo = d.post_hint === "hosted:video" || d.post_hint === "rich:video" || d.is_video === true;
            let imageUrl = null;
            let videoUrl = null;
            if (!isVideo && d.post_hint === "image" && d.url) {
              imageUrl = d.url;
            } else if (d.is_gallery && d.gallery_data?.items?.length > 0) {
              // ギャラリー投稿（複数画像）→ 1枚目を取得
              const firstId = d.gallery_data.items[0].media_id;
              const meta = d.media_metadata?.[firstId];
              if (meta?.s?.u) imageUrl = meta.s.u.replace(/&amp;/g, "&");
              else if (meta?.s?.gif) imageUrl = meta.s.gif.replace(/&amp;/g, "&");
            } else if (d.preview?.images?.[0]?.source?.url) {
              imageUrl = d.preview.images[0].source.url.replace(/&amp;/g, "&");
            }
            if (isVideo && d.media?.reddit_video?.fallback_url) {
              videoUrl = d.media.reddit_video.fallback_url.replace(/&amp;/g, "&");
            }
            return {
              title: d.title,
              score: d.score,
              comments: d.num_comments,
              url: `https://www.reddit.com${d.permalink}`,
              imageUrl,
              videoUrl,
              isVideo,
            };
          });
          resolve({ subreddit, posts });
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

// Claudeに日本人受けする10件を選ばせる
async function selectTopPosts(posts) {
  const postList = posts
    .map((p, i) => `${i + 1}. [r/${p.subreddit}] ${p.title} (👍${p.score})`)
    .join("\n");

  const prompt = `
以下は海外Redditの人気投稿です。日本のX（Twitter）で最もバズりそうな10件を選んでください。

${postList}

【選定基準】
- 日本人が「え、マジで！？」と反応しやすいもの
- 感情（驚き・笑い・感動・共感）を強く刺激するもの
- 文化的背景の説明が少なくても伝わるもの
- 科学・自然・動物・歴史・医学・テクノロジー系を優先する
- 画像や映像がありそうなネタを優先する（タイトルに具体的なビジュアルが想像できるもの）
- 個人の日常エピソード系（「私の〇〇が〜した」など）は除外する
- 文化的背景の説明が長く必要なものは除外する
- 政治・宗教・戦争ネタは避ける
- なるべく多様なジャンルから選ぶ（同じジャンルが連続しないようにする）

以下のJSON形式のみで出力してください。説明文は不要です。
{"selected": [番号, 番号, 番号, 番号, 番号, 番号, 番号, 番号, 番号, 番号], "reasons": ["理由1", "理由2", "理由3", "理由4", "理由5", "理由6", "理由7", "理由8", "理由9", "理由10"]}
`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.replace(/```json|```/g, "").trim();
  const json = JSON.parse(raw);
  return json;
}

// 140文字超えた場合に短縮
async function trimPost(text) {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: `以下のX投稿文を130文字以内に短縮してください。フック・驚き・問いかけの構成は保つこと。絵文字もそのまま。投稿文のみ出力。\n\n${text}` }],
  });
  return msg.content[0].text.trim();
}

// Claudeに日本語投稿文を生成させる
async function generatePost(post) {
  const prompt = `
以下の海外Reddit投稿を、日本語のX（Twitter）投稿文に変換してください。

【元の投稿タイトル】
${post.title}

【絶対に守るルール】
- ハッシュタグは一切つけないこと（アルゴリズムに不利なため）
- URLは含めないこと
- 必ず130文字以内に収めること（超えた場合は文章を削ること。絵文字・問いかけは残す）

【構成テンプレート（この順番で書くこと）】
① 1行目：【衝撃】【驚愕】【速報】【朗報】【やばい】などのフックワード＋核心を1行で
② 2〜3行：具体的な事実・数字・驚きのポイントを簡潔に（伝聞形「〜らしい」「〜とのこと」）
③ 最終行：読者に問いかける締め（例：「あなたはどう思う？👇」「知らなかった人RT↑」「〇〇か△△、どっちだと思う？」）

【文体のポイント】
- 絵文字は2〜3個、感情強調に使う（⚡😮🌍💡🔴など）
- 「日本では〇〇なのに海外では△△」の対比があれば積極的に使う
- 数字・統計があれば必ず入れる（「〇〇人に1人」「世界の△△%」など）
- 1行目で「続きが気になる」と思わせることが最重要

投稿文のみ出力してください。説明は不要です。
`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [{ role: "user", content: prompt }],
  });

  return message.content[0].text;
}

// サムネイルHTML生成（3分割レイアウト：画像への文字被りなし）
function buildThumbnailHtml(imageBase64, imageMime, catchCopy) {
  const imageStyle = imageBase64
    ? `background-image: url('data:${imageMime};base64,${imageBase64}'); background-size: cover; background-position: center;`
    : `background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1600px; height: 900px; overflow: hidden; font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif; }
  .bg { width: 1600px; height: 900px; position: relative; background: #000; }
  .bg-image {
    position: absolute; inset: 0;
    ${imageStyle}
    filter: brightness(1.0);
  }
  .overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.0) 30%, rgba(0,0,0,0.7) 100%); }
  .account {
    position: absolute; top: 52px; right: 48px;
    color: rgba(255,255,255,0.9); font-size: 30px; font-weight: 600;
    text-shadow: 0 1px 6px rgba(0,0,0,0.9);
    letter-spacing: 1px;
  }
  .bottom { position: absolute; bottom: 0; left: 0; right: 0; padding: 24px 56px 48px; }
  .label {
    display: inline-flex; align-items: center; gap: 8px;
    background: #e00; color: #fff;
    font-size: 28px; font-weight: 800;
    padding: 6px 20px; margin-bottom: 16px; border-radius: 4px;
    letter-spacing: 3px;
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
    <div class="bg-image"></div>
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

// Claudeにキャッチコピーを2行生成させる
async function generateCatchCopy(post) {
  const prompt = `
以下の海外Reddit投稿のサムネイル用キャッチコピーを2行で生成してください。

【元の投稿タイトル】
${post.title}

【条件】
- 1行目：4〜8文字の超短いインパクトワード（例：「奇跡の大逆転」「え、マジで！？」「世界が震えた」）
- 2行目：補足フレーズ、必ず12文字以内（例：「ゴール直前の奇跡」「揚げ菓子に敗北」）
- 改行で区切って2行のみ出力
- 絵文字・句読点不要
- 感情を最大限に煽る表現にすること

2行のみ出力してください。説明不要。
`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  const lines = message.content[0].text.trim().split("\n").filter(l => l.trim());
  return {
    line1: lines[0] || "衝撃の事実",
    line2: lines[1] || "",
  };
}

// Puppeteerでサムネイル画像を生成
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

// HTML投稿ランチャーを生成
function generateHtml(today, posts) {
  const cards = posts.map((item, idx) => {
    const { postNum, scheduleTime, subreddit, title, score, savedImagePath, savedVideoPath, thumbPath, isVideo, finalPost, sourceUrl, videoDuration = 0 } = item;
    const thumbAbsPath = thumbPath ? thumbPath.replace(/\\/g, "\\\\") : "";
    const safeSourceUrl = sourceUrl.replace(/'/g, "\\'");
    const charCount = finalPost.length;
    const videoOverLimit = isVideo && videoDuration > 140;
    const durationStr = videoDuration > 0
      ? `${Math.floor(videoDuration/60)}:${String(videoDuration%60).padStart(2,'0')}`
      : "";

    const mediaBlock = isVideo && savedVideoPath
      ? `<video src="/videos/${path.basename(savedVideoPath)}" controls muted playsinline
           style="width:100%;max-height:320px;border-radius:16px;object-fit:cover;background:#000;display:block;margin-top:12px;"></video>`
      : isVideo
        ? `<div class="media-placeholder">🎬 動画（DL失敗）</div>`
        : thumbPath
          ? `<img src="/thumbnails/${path.basename(thumbPath)}" alt="サムネイル"
               style="width:100%;max-height:320px;object-fit:cover;border-radius:16px;display:block;margin-top:12px;border:1px solid #eff3f4;">`
          : "";

    const sourcePreview = `
      <div class="source-preview">
        <span class="source-label">r/${subreddit}</span>
        <span class="source-score">👍 ${score.toLocaleString()}</span>
        <span class="source-title">${title.length > 60 ? title.slice(0, 60) + "…" : title}</span>
      </div>`;

    return `
    <div class="x-card" id="card-${postNum}">
      <div class="x-card-inner">

        <!-- 左：ツイート編集ボックス -->
        <div class="compose-box">
          <div class="compose-header">
            <div class="x-avatar">世</div>
            <div>
              <span class="x-name">【速報】世界の話題</span>
              <span class="x-handle">@sekai_no_wadai</span>
            </div>
            <div class="compose-header-right">
              ${videoOverLimit ? `<span class="x-over-badge">⚠️ 時間超過 ${durationStr}</span>` : ""}
              <span class="x-status-badge" id="status-${postNum}">未予約 #${postNum}</span>
            </div>
          </div>
          <textarea class="x-textarea" id="text-${postNum}"
            oninput="updateCount(${postNum})">${finalPost}</textarea>
          ${mediaBlock}
          ${sourcePreview}
          <div class="x-actions">
            <div class="x-left-actions">
              <div class="x-time-wrap">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1d9bf0" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <select class="x-time-input" id="time-${postNum}">
                  ${["06:00","06:30","07:00","07:30","08:00","08:30","09:00","09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30","21:00","21:30","22:00","22:30","23:00","23:30"]
                    .map(t => `<option value="${t}"${t === scheduleTime ? " selected" : ""}>${t}</option>`)
                    .join("")}
                </select>
              </div>
            </div>
            <div class="x-right-actions">
              <span class="x-char-count" id="count-${postNum}"
                style="color:${charCount > 120 ? (charCount > 140 ? '#f4212e' : '#ffd400') : '#536471'}">
                ${charCount}/140
              </span>
              <button class="x-post-btn" id="btn-${postNum}"
                onclick="schedulePost(${postNum}, '${safeSourceUrl}', '${thumbAbsPath}')">
                予約投稿
              </button>
              <button class="x-cancel-btn" id="cancel-${postNum}" style="display:none"
                onclick="cancelPost(${postNum})">
                キャンセル
              </button>
            </div>
          </div>
        </div>

        <!-- コネクター -->
        <div class="reply-connector">
          <div class="connector-dot"></div>
          <div class="connector-line"></div>
          <div class="connector-dot"></div>
        </div>

        <!-- 右：リプライボックス（80%サイズ） -->
        <div class="reply-box">
          <div class="compose-header">
            <div class="x-avatar x-avatar-sm">世</div>
            <div>
              <span class="x-name" style="font-size:0.88em;">【速報】世界の話題</span>
              <span class="x-handle">@sekai_no_wadai</span>
            </div>
          </div>
          <div class="reply-to-label">
            <span class="reply-mention">@sekai_no_wadai</span> への返信
          </div>
          <a class="reply-url" href="${sourceUrl}" target="_blank">${sourceUrl}</a>
          <div class="reply-source-tag">
            <span class="source-label">r/${subreddit}</span>
            <span style="color:#536471;font-size:0.82em;">👍 ${score.toLocaleString()}</span>
          </div>
        </div>

      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>【速報】世界の話題 投稿ランチャー ${today}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, "Segoe UI", sans-serif;
      background: #f7f9f9;
      color: #0f1419;
      min-height: 100vh;
    }

    /* ── トップバー ── */
    .top-bar {
      position: sticky; top: 0; z-index: 100;
      background: rgba(255,255,255,0.9); backdrop-filter: blur(12px);
      border-bottom: 1px solid #eff3f4;
      padding: 12px 20px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .top-bar-left { display: flex; align-items: center; gap: 12px; }
    .x-logo { font-size: 22px; font-weight: 900; color: #0f1419; }
    .top-title { font-size: 1em; font-weight: 700; color: #0f1419; }
    .top-date { font-size: 0.82em; color: #536471; margin-left: 8px; }
    .top-bar-right { display: flex; gap: 10px; align-items: center; }
    .nav-btn {
      padding: 7px 16px; border-radius: 20px; font-size: 0.85em; font-weight: 700;
      text-decoration: none; border: 1px solid #cfd9de; cursor: pointer;
      background: transparent; color: #0f1419; transition: background 0.15s;
    }
    .nav-btn:hover { background: #e7e9ea; }
    .nav-btn.yt { border-color: #ff0000; color: #ff0000; }
    .nav-btn.yt:hover { background: rgba(255,0,0,0.07); }
    .nav-btn.shutdown { border-color: #f4212e; color: #f4212e; }
    .nav-btn.shutdown:hover { background: rgba(244,33,46,0.07); }
    .nav-btn.github { background: #0f1419; color: #fff; border-color: #0f1419; }
    .nav-btn.github:hover { background: #272c30; }
    .nav-btn.github.pushed { background: #00ba7c; border-color: #00ba7c; }

    /* ── トースト通知 ── */
    #toast {
      position: fixed; bottom: 32px; left: 50%; transform: translateX(-50%);
      background: #0f1419; color: #fff;
      padding: 12px 28px; border-radius: 24px;
      font-size: 0.95em; font-weight: 600;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      opacity: 0; pointer-events: none;
      transition: opacity 0.25s ease;
      z-index: 999; white-space: nowrap;
    }
    #toast.show { opacity: 1; }

    /* ── メインコンテナ ── */
    .container {
      max-width: 1100px; margin: 0 auto; padding: 16px 0 60px;
      border-left: 1px solid #eff3f4; border-right: 1px solid #eff3f4;
      background: #fff; min-height: 100vh;
    }

    /* ── ヘッダー情報 ── */
    .info-bar {
      padding: 12px 16px;
      border-bottom: 1px solid #eff3f4;
      font-size: 0.82em; color: #536471;
    }
    .info-bar strong { color: #0f1419; }

    /* ── Xカード ── */
    .x-card {
      border-bottom: 1px solid #eff3f4;
      padding: 20px 16px;
      transition: background 0.15s;
    }
    .x-card:hover { background: rgba(0,0,0,0.01); }
    .x-card.scheduled { background: #fffbea; border-left: 3px solid #ffd400; }
    .x-card-inner {
      display: flex; align-items: flex-start; gap: 0;
    }

    /* ── ツイート編集ボックス（左） ── */
    .compose-box {
      flex: 5; min-width: 0;
      border: 1.5px solid #cfd9de; border-radius: 16px;
      padding: 16px; background: #fff;
    }
    .compose-header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 10px; flex-wrap: wrap;
    }
    .compose-header-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }

    /* ── コネクター ── */
    .reply-connector {
      flex: 0 0 36px;
      display: flex; flex-direction: column; align-items: center;
      justify-content: center; padding-top: 28px; gap: 3px;
    }
    .connector-dot {
      width: 5px; height: 5px; border-radius: 50%; background: #cfd9de;
    }
    .connector-line { width: 2px; height: 28px; background: #cfd9de; }

    /* ── リプライボックス（右・80%） ── */
    .reply-box {
      flex: 4; min-width: 0;
      border: 1.5px solid #eff3f4; border-radius: 16px;
      padding: 14px; background: #f7f9f9;
      display: flex; flex-direction: column; gap: 8px;
    }
    .reply-to-label {
      font-size: 0.82em; color: #536471;
    }
    .reply-mention { color: #1d9bf0; }
    .reply-url {
      font-size: 0.82em; color: #1d9bf0; word-break: break-all;
      text-decoration: none; line-height: 1.5;
    }
    .reply-url:hover { text-decoration: underline; }
    .reply-source-tag { display: flex; align-items: center; gap: 8px; }

    /* ── アバター ── */
    .x-avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: linear-gradient(135deg, #1d9bf0, #0d6eac);
      display: flex; align-items: center; justify-content: center;
      font-size: 1.1em; font-weight: 900; color: #fff; flex-shrink: 0;
    }
    .x-avatar-sm { width: 32px; height: 32px; font-size: 0.9em; }
    .x-user-row {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 8px; flex-wrap: wrap;
    }
    .x-name { font-weight: 700; font-size: 0.95em; color: #0f1419; }
    .x-handle { font-size: 0.88em; color: #536471; }
    .x-post-num { font-size: 0.78em; color: #536471; margin-left: auto; }
    .x-status-badge {
      font-size: 0.75em; font-weight: 700; padding: 2px 10px;
      border-radius: 20px; background: #eff3f4; color: #536471;
    }
    .x-status-badge.scheduled { background: #fff3cd; color: #856404; }

    /* ── テキストエリア ── */
    .x-textarea {
      width: 100%; background: transparent; border: none; outline: none;
      color: #0f1419; font-size: 1.05em; line-height: 1.65;
      font-family: inherit; resize: vertical;
      min-height: 220px;
      border-bottom: 1px solid #eff3f4;
      padding-bottom: 12px; margin-bottom: 4px;
      display: block;
    }
    .x-textarea:focus { border-bottom-color: #1d9bf0; }
    .x-textarea::placeholder { color: #536471; }

    /* ── 時間超過バッジ ── */
    .x-over-badge {
      font-size: 0.75em; font-weight: 700; padding: 2px 10px;
      border-radius: 20px; background: #fef0f0; color: #f4212e;
      border: 1px solid #f4212e;
    }

    /* ── 元ネタプレビュー ── */
    .source-preview {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 8px 12px; border: 1px solid #eff3f4; border-radius: 12px;
      margin-top: 10px; font-size: 0.82em; color: #536471;
      background: #f7f9f9;
    }
    .source-label {
      background: #ff4500; color: #fff; padding: 2px 8px;
      border-radius: 4px; font-weight: 700; font-size: 0.9em;
    }
    .source-score { color: #536471; }
    .source-title { color: #536471; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── アクションバー ── */
    .x-actions {
      display: flex; align-items: center; justify-content: space-between;
      margin-top: 12px; padding-top: 8px; border-top: 1px solid #eff3f4;
      gap: 8px; flex-wrap: wrap;
    }
    .x-left-actions { display: flex; align-items: center; gap: 8px; }
    .x-right-actions { display: flex; align-items: center; gap: 10px; }

    /* ── 時間インプット ── */
    .x-time-wrap {
      display: flex; align-items: center; gap: 6px;
      background: #eff3f4; border-radius: 20px; padding: 5px 12px;
    }
    .x-time-input {
      background: transparent; border: none; outline: none;
      color: #1d9bf0; font-size: 0.9em; font-weight: 700; cursor: pointer;
    }

    /* ── 文字数カウント ── */
    .x-char-count { font-size: 0.88em; font-weight: 700; }

    /* ── 予約投稿ボタン ── */
    .x-post-btn {
      background: #0f1419; color: #fff; border: none;
      padding: 8px 20px; border-radius: 20px;
      font-weight: 700; font-size: 0.92em; cursor: pointer;
      transition: background 0.15s;
    }
    .x-post-btn:hover { background: #272c30; }
    .x-post-btn:disabled { background: #cfd9de; color: #fff; cursor: default; }
    .x-post-btn.done { background: #00ba7c; }

    /* ── キャンセルボタン ── */
    .x-cancel-btn {
      background: transparent; color: #f4212e;
      border: 1px solid #f4212e; padding: 7px 16px;
      border-radius: 20px; font-weight: 700; font-size: 0.88em;
      cursor: pointer; transition: background 0.15s;
    }
    .x-cancel-btn:hover { background: rgba(244,33,46,0.07); }

    /* ── 素材なし ── */
    .media-placeholder {
      width: 100%; height: 120px; background: #f7f9f9; border-radius: 16px;
      border: 1px solid #eff3f4;
      display: flex; align-items: center; justify-content: center;
      color: #536471; font-size: 0.9em; margin-top: 12px;
    }

    /* ── GitHub予約済み投稿セクション ── */
    .approved-section { border-bottom: 2px solid #eff3f4; }
    .approved-header {
      padding: 12px 16px; display: flex; align-items: center; gap: 8px;
      cursor: pointer; user-select: none; font-weight: 700; font-size: 0.9em;
      color: #0f1419; background: #f7f9f9;
    }
    .approved-header:hover { background: #edf0f1; }
    .approved-badge {
      background: #1d9bf0; color: #fff; font-size: 0.75em; font-weight: 700;
      padding: 2px 10px; border-radius: 20px;
    }
    .approved-body { padding: 12px 16px; }
    .approved-day { margin-bottom: 10px; border: 1px solid #eff3f4; border-radius: 10px; overflow: hidden; }
    .approved-day-header {
      background: #e7e9ea; padding: 8px 12px; display: flex; align-items: center; gap: 8px;
      font-size: 0.85em; font-weight: 700;
    }
    .approved-date { color: #0f1419; }
    .approved-count { color: #536471; font-weight: normal; }
    .btn-del-day {
      margin-left: auto; padding: 3px 10px; border-radius: 14px; border: none;
      font-size: 0.78em; font-weight: 700; cursor: pointer; background: #f4212e; color: #fff;
    }
    .btn-del-day:hover { background: #cc1a27; }
    .btn-push-after {
      padding: 3px 10px; border-radius: 14px; border: none;
      font-size: 0.78em; font-weight: 700; cursor: pointer; background: #0f1419; color: #fff;
    }
    .btn-push-after:hover { background: #272c30; }
    .approved-posts { background: #fff; }
    .approved-post {
      display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      border-bottom: 1px solid #f7f9f9; font-size: 0.83em;
    }
    .approved-post:last-child { border-bottom: none; }
    .ap-time { font-weight: 700; color: #1d9bf0; flex-shrink: 0; width: 46px; }
    .ap-text { flex: 1; color: #536471; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .btn-del-post {
      background: none; border: 1px solid #cfd9de; color: #536471;
      width: 24px; height: 24px; border-radius: 50%; font-size: 0.75em; cursor: pointer;
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    }
    .btn-del-post:hover { border-color: #f4212e; color: #f4212e; }
    .approved-empty { color: #536471; font-size: 0.85em; text-align: center; padding: 16px; }
  </style>
  <script>
    let toastTimer;
    function showToast(msg, color) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.style.background = color || '#0f1419';
      t.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
    }

    async function pushGitHub() {
      const btn = document.getElementById('push-btn');
      btn.textContent = '送信中...';
      btn.disabled = true;
      try {
        const res = await fetch('http://localhost:3000/api/push-github', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          btn.textContent = '✅ Push済み';
          btn.classList.add('pushed');
          showToast('✅ GitHubにPush完了！自動投稿が有効になりました', '#00ba7c');
        } else {
          btn.textContent = '↑ GitHubにPush';
          btn.disabled = false;
          showToast('❌ Push失敗: ' + data.message, '#f4212e');
        }
      } catch(e) {
        btn.textContent = '↑ GitHubにPush';
        btn.disabled = false;
        showToast('❌ サーバーに接続できません', '#f4212e');
      }
    }

    function autoResize(el) {
      el.style.height = '0px';
      el.style.height = el.scrollHeight + 'px';
    }
    async function loadApproved() {
      try {
        const res = await fetch('http://localhost:3000/api/approved-posts');
        const data = await res.json();
        renderApproved(data.days);
      } catch(e) {
        document.getElementById('approvedBadge').textContent = '取得失敗（サーバー未起動？）';
      }
    }

    function renderApproved(days) {
      const badge = document.getElementById('approvedBadge');
      const body = document.getElementById('approvedBody');
      const total = days.reduce((s, d) => s + d.posts.length, 0);
      badge.textContent = days.length + '日分 / ' + total + '件';
      if (total === 0) {
        body.innerHTML = '<div class="approved-empty">予約済み投稿はありません</div>';
        return;
      }
      body.innerHTML = days.map(day =>
        '<div class="approved-day">'
        + '<div class="approved-day-header">'
        + '<span class="approved-date">' + day.date + '</span>'
        + '<span class="approved-count">（' + day.posts.length + '件）</span>'
        + '<button class="btn-del-day" data-date="' + day.date + '" onclick="deleteDay(this.dataset.date)">🗑️ 全削除</button>'
        + '<button class="btn-push-after" onclick="pushGitHub()">↑ Push</button>'
        + '</div>'
        + '<div class="approved-posts">'
        + day.posts.map(p =>
          '<div class="approved-post">'
          + '<span class="ap-time">' + p.scheduleTime + '</span>'
          + '<span class="ap-text">' + p.text.replace(/\n/g, ' ').replace(/</g, '&lt;').slice(0, 60) + '…</span>'
          + '<button class="btn-del-post" data-date="' + day.date + '" data-num="' + p.postNum + '" onclick="deletePost(this.dataset.date, +this.dataset.num)">✕</button>'
          + '</div>'
        ).join('')
        + '</div></div>'
      ).join('');
    }

    function toggleApproved() {
      const body = document.getElementById('approvedBody');
      const icon = document.getElementById('approvedToggleIcon');
      const visible = body.style.display === 'block';
      body.style.display = visible ? 'none' : 'block';
      icon.textContent = visible ? '▶' : '▼';
    }

    async function deleteDay(date) {
      if (!confirm(date + ' の投稿を全て削除しますか？\\n削除後「↑ Push」を押してGitHubに反映してください。')) return;
      const res = await fetch('http://localhost:3000/api/delete-approved', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ date })
      });
      const data = await res.json();
      if (data.success) { showToast('✅ ' + date + ' の投稿を削除しました'); await loadApproved(); }
      else showToast('❌ 削除失敗: ' + data.message, '#f4212e');
    }

    async function deletePost(date, postNum) {
      const res = await fetch('http://localhost:3000/api/delete-approved', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ date, postNum })
      });
      const data = await res.json();
      if (data.success) { showToast('✅ 削除しました'); await loadApproved(); }
      else showToast('❌ 削除失敗: ' + data.message, '#f4212e');
    }

    window.addEventListener('load', () => {
      loadApproved();
      document.querySelectorAll('.x-textarea').forEach(ta => autoResize(ta));
    });

    function updateCount(postNum) {
      const ta = document.getElementById('text-' + postNum);
      autoResize(ta);
      const len = ta.value.length;
      const el = document.getElementById('count-' + postNum);
      el.textContent = len + '/140';
      el.style.color = len > 140 ? '#f4212e' : len > 120 ? '#ffd400' : '#536471';
    }

    async function schedulePost(postNum, sourceUrl, thumbPath) {
      const text = document.getElementById('text-' + postNum).value.trim();
      const scheduleTime = document.getElementById('time-' + postNum).value;
      if (!text) { alert('投稿文が空です'); return; }
      if (!scheduleTime) { alert('投稿時間を設定してください'); return; }

      const btn = document.getElementById('btn-' + postNum);
      btn.disabled = true;
      btn.textContent = '予約中...';

      try {
        const res = await fetch('http://localhost:3000/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postNum, text, scheduleTime, sourceUrl, thumbPath })
        });
        const data = await res.json();

        if (data.success) {
          const badge = document.getElementById('status-' + postNum);
          badge.textContent = scheduleTime + ' 予約済み ✓';
          badge.className = 'x-status-badge scheduled';
          btn.textContent = '✓ ' + scheduleTime;
          btn.classList.add('done');
          document.getElementById('card-' + postNum).classList.add('scheduled');
          document.getElementById('cancel-' + postNum).style.display = 'inline-block';
          showToast('✅ 投稿' + postNum + ' を ' + scheduleTime + ' に予約しました！GitHubにPushを忘れずに↑');
        } else {
          btn.disabled = false;
          btn.textContent = '予約投稿';
          alert('予約失敗: サーバーに接続できません。node post_server.js を起動してください。');
        }
      } catch(e) {
        btn.disabled = false;
        btn.textContent = '予約投稿';
        alert('サーバーに接続できません。\\nターミナルで: node post_server.js を実行してください。');
      }
    }

    async function shutdownServer() {
      if (!confirm('サーバーを停止しますか？\\n⚠️ 予約済みの投稿もすべてキャンセルされます。')) return;
      try {
        await fetch('http://localhost:3000/api/shutdown', { method: 'POST' });
      } catch(e) {}
      document.body.innerHTML = '<div style="font-family:sans-serif;text-align:center;padding:80px;color:#e7e9ea;background:#000;min-height:100vh;"><h2>✅ サーバーを停止しました</h2><p style="color:#71767b;margin-top:12px;">このタブは閉じてください。</p></div>';
    }

    async function cancelPost(postNum) {
      if (!confirm('予約をキャンセルしますか？')) return;
      const res = await fetch('http://localhost:3000/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postNum })
      });
      const data = await res.json();
      if (data.success) {
        const badge = document.getElementById('status-' + postNum);
        badge.textContent = '未予約';
        badge.className = 'x-status-badge';
        const btn = document.getElementById('btn-' + postNum);
        btn.disabled = false;
        btn.textContent = '予約投稿';
        btn.classList.remove('done');
        document.getElementById('card-' + postNum).classList.remove('scheduled');
        document.getElementById('cancel-' + postNum).style.display = 'none';
      }
    }
  </script>
</head>
<body>
  <div class="top-bar">
    <div class="top-bar-left">
      <span class="x-logo">𝕏</span>
      <span class="top-title">投稿ランチャー</span>
      <span class="top-date">${today}</span>
    </div>
    <div class="top-bar-right">
      <a href="http://localhost:3000/youtube" target="_blank" class="nav-btn yt">▶ YouTube</a>
      <button id="push-btn" onclick="pushGitHub()" class="nav-btn github">↑ GitHubにPush</button>
      <button onclick="shutdownServer()" class="nav-btn shutdown">停止</button>
    </div>
  </div>
  <div id="toast"></div>
  <div class="container">
    <div class="info-bar">
      <strong>全${posts.length}件</strong>　予約した投稿は GitHub Actions が自動でXに投稿します
    </div>
    <div class="approved-section" id="approvedSection">
      <div class="approved-header" onclick="toggleApproved()">
        <span id="approvedToggleIcon">▶</span> 📋 GitHub予約済み投稿
        <span class="approved-badge" id="approvedBadge">読込中…</span>
      </div>
      <div class="approved-body" id="approvedBody" style="display:none"></div>
    </div>
    ${cards}
  </div>
</body>
</html>`;}


// メイン処理
async function main() {
  console.log("=== 【速報】世界の話題 投稿文生成（10件/日） ===\n");
  console.log("Redditからネタを取得中...\n");

  // 全サブレディットからネタ取得
  const allPosts = [];
  for (const subreddit of SUBREDDITS) {
    try {
      const result = await fetchSubreddit(subreddit);
      allPosts.push(...result.posts.map((p) => ({ ...p, subreddit })));
    } catch (e) {
      console.log(`r/${subreddit}: 取得失敗`);
    }
  }

  // スコア上位20件を候補として渡す
  const top20Posts = allPosts.sort((a, b) => b.score - a.score).slice(0, 40);

  console.log(`候補: ${top20Posts.length}件 → Claudeが厳選10件を選定中...\n`);
  const selection = await selectTopPosts(top20Posts);

  const selectedPosts = selection.selected.map((i) => top20Posts[i - 1]);

  console.log("【選ばれた10件】");
  selectedPosts.forEach((post, i) => {
    console.log(`  ${i + 1}. ${post.title}`);
    console.log(`     理由: ${selection.reasons[i]}\n`);
  });

  console.log("投稿文を生成中...\n");
  console.log("━".repeat(50));

  // 保存ファイルの準備
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); // JST
  const browser = await puppeteer.launch({ headless: true });
  const saveFile = path.join(POSTS_DIR, `${today}.txt`);
  const lines = [
    `【速報】世界の話題 投稿文ログ ${today}`,
    `予約投稿時間: ${SCHEDULE_TIMES.join(" / ")}`,
    "",
  ];
  const htmlItems = [];

  for (const [idx, post] of selectedPosts.entries()) {
    const postNum = idx + 1;
    const scheduleTime = SCHEDULE_TIMES[idx];

    console.log(`\n【投稿${postNum} / 予約時間: ${scheduleTime}】`);
    console.log(`元ネタ: r/${post.subreddit}`);
    console.log(`原文: ${post.title}`);
    console.log(`👍 ${post.score} | URL: ${post.url}`);

    // 画像 or 動画ダウンロード（日付＋番号でリネーム）
    let savedImagePath = null;
    let savedVideoPath = null;
    if (post.isVideo && post.videoUrl) {
      const filename = `${today}_${postNum}.mp4`;
      savedVideoPath = await downloadRedditVideo(post.videoUrl, filename);
      if (savedVideoPath) {
        console.log(`🎬 動画: ${savedVideoPath}`);
      } else {
        console.log(`⚠️  動画取得失敗（URLから直接添付してください）`);
      }
      // 動画投稿のプレビュー画像も取得（ショート動画のスライド背景用）
      if (post.imageUrl) {
        const ext = post.imageUrl.split("?")[0].split(".").pop() || "jpg";
        const imgFilename = `${today}_${postNum}.${ext}`;
        savedImagePath = await downloadImage(post.imageUrl, imgFilename);
        if (savedImagePath) {
          console.log(`🖼️  プレビュー画像: ${savedImagePath}`);
        }
      }
    } else if (post.imageUrl) {
      const ext = post.imageUrl.split("?")[0].split(".").pop() || "jpg";
      const filename = `${today}_${postNum}.${ext}`;
      savedImagePath = await downloadImage(post.imageUrl, filename);
      if (savedImagePath) {
        console.log(`🖼️  画像: ${savedImagePath}`);
      } else {
        console.log(`⚠️  画像取得失敗`);
      }
    } else {
      console.log(`⚠️  画像なし`);
    }

    let generatedPost = await generatePost(post);
    generatedPost = generatedPost.trim();
    const finalPost = generatedPost.length > 140 ? await trimPost(generatedPost) : generatedPost;
    if (generatedPost.length > 140) console.log(`✂️  投稿${postNum} 短縮: ${generatedPost.length}→${finalPost.length}文字`);
    const sourceUrl = post.url;

    // 動画の場合はサムネイル生成スキップ
    let thumbPath = null;
    if (post.isVideo) {
      console.log(`🎬 動画投稿 - サムネイル生成スキップ`);
    } else {
      const catchCopy = await generateCatchCopy(post);
      console.log(`💬 キャッチコピー: ${catchCopy.line1} / ${catchCopy.line2}`);
      thumbPath = path.join(THUMB_DIR, `${today}_${postNum}.png`);
      await generateThumbnail(browser, savedImagePath, thumbPath, catchCopy);
      console.log(`🖼️  サムネイル生成: ${thumbPath}`);
    }

    console.log("\n▼ 投稿文（コピペ用）:");
    console.log(finalPost);
    console.log("\n" + "━".repeat(50));

    // ファイルに記録
    lines.push("━".repeat(40));
    lines.push(`【投稿${postNum}】予約時間: ${scheduleTime}`);
    lines.push(`元ネタ: r/${post.subreddit}`);
    lines.push(`原文: ${post.title}`);
    lines.push(`👍 ${post.score}`);
    lines.push(`種別: ${post.isVideo ? "🎬 動画" : "🖼️ 画像"}`);
    lines.push(`動画: ${savedVideoPath || "なし"}`);
    lines.push(`画像: ${savedImagePath || "なし"}`);
    lines.push(`\n▼ 投稿文（コピペ用）:\n${finalPost}\n`);
    lines.push(`▼ リプ欄に貼るURL:\n${sourceUrl}\n`);

    // 動画の秒数を取得（X無料版は140秒まで）
    let videoDuration = 0;
    if (savedVideoPath) {
      try {
        const ffprobeResult = execSync(
          `"C:\\ffmpeg\\bin\\ffprobe.exe" -v quiet -print_format json -show_format "${savedVideoPath}"`,
          { stdio: "pipe" }
        ).toString();
        videoDuration = Math.round(parseFloat(JSON.parse(ffprobeResult).format.duration) || 0);
      } catch (e) { /* 取得失敗時は0のまま */ }
    }

    htmlItems.push({ postNum, scheduleTime, subreddit: post.subreddit, title: post.title, score: post.score, savedImagePath, savedVideoPath, thumbPath, isVideo: post.isVideo, finalPost, sourceUrl, videoDuration });
  }

  // テキストファイル保存
  await browser.close();

  fs.writeFileSync(saveFile, lines.join("\n"), "utf8");
  console.log(`\n✅ 投稿文を保存しました: ${saveFile}`);

  // ランチャーHTML保存（post_server.js の /launcher が参照する）
  const htmlFile = path.join(POSTS_DIR, `${today}.html`);
  fs.writeFileSync(htmlFile, generateHtml(today, htmlItems), "utf8");

  // generate_shorts.js 用の JSON を保存
  const genJson = {
    date: today,
    posts: htmlItems.map(item => ({
      title: item.title,
      postText: item.finalPost,
      sourceUrl: item.sourceUrl,
      scheduleTime: item.scheduleTime,
      savedImagePath: item.savedImagePath || null,
      isVideo: item.isVideo,
      subreddit: item.subreddit,
      score: item.score,
    })),
  };
  const genFile = path.join(TEMP_DIR, `generated_${today}.json`);
  fs.writeFileSync(genFile, JSON.stringify(genJson, null, 2), "utf8");
  console.log(`✅ Shortsデータを保存しました: ${genFile}`);

  // generated JSONをすぐにGitHubへ自動push（承認・push忘れでも投稿できるようにフォールバック用）
  try {
    const repoRoot = path.join(__dirname, "..");
    execSync(`git -C "${repoRoot}" add 02_reddit_global/temp/generated_${today}.json`, { stdio: "pipe" });
    execSync(`git -C "${repoRoot}" commit -m "auto: generated_${today}.json"`, { stdio: "pipe" });
    execSync(`git -C "${repoRoot}" push origin main`, { stdio: "pipe" });
    console.log(`✅ generated_${today}.json を GitHub に自動push完了`);
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    if (msg.includes("nothing to commit")) {
      console.log("GitHub: 変更なし（既にpush済み）");
    } else {
      console.log(`⚠️ GitHub auto-push 失敗（ランチャーから手動pushしてください）: ${msg}`);
    }
  }

  console.log("\n👉 HTMLファイルをブラウザで開いて「Xで開く」ボタンを押してください！");
}

main().catch(console.error);
