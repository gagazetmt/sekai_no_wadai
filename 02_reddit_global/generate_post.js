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

// Claudeに日本語投稿文を生成させる
async function generatePost(post) {
  const prompt = `
以下の海外Reddit投稿を、日本語のX（Twitter）投稿文に変換してください。

【元の投稿タイトル】
${post.title}

【絶対に守るルール】
- ハッシュタグは一切つけないこと（アルゴリズムに不利なため）
- URLは含めないこと
- 140文字以内に収めること

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
    const { postNum, scheduleTime, subreddit, title, score, savedImagePath, savedVideoPath, thumbPath, isVideo, finalPost, sourceUrl } = item;
    const intentUrl = "https://x.com/intent/tweet?text=" + encodeURIComponent(finalPost);
    const imgTag = isVideo
      ? `<div class="no-image video">🎬 動画投稿</div>`
      : thumbPath
        ? `<img src="/thumbnails/${path.basename(thumbPath)}" alt="サムネイル">`
        : `<div class="no-image">画像なし</div>`;
    const imgNote = isVideo && savedVideoPath
      ? `<div class="img-note video-note">🎬 添付動画: <code>videos/${path.basename(savedVideoPath)}</code></div>`
      : isVideo
        ? `<div class="img-note warn">⚠️ 動画DL失敗 — Redditから直接保存してください</div>`
        : thumbPath
          ? `<div class="img-note">📎 添付画像: <code>thumbnails/${path.basename(thumbPath)}</code></div>`
          : `<div class="img-note warn">⚠️ サムネイルなし</div>`;
    const thumbAbsPath = thumbPath ? thumbPath.replace(/\\/g, "\\\\") : "";
    const safeSourceUrl = sourceUrl.replace(/'/g, "\\'");

    return `
    <div class="card" id="card-${postNum}">
      <div class="card-header">
        <span class="post-num">投稿 ${postNum}</span>
        <span class="source">r/${subreddit} 👍${score.toLocaleString()}</span>
        <span class="status-badge" id="status-${postNum}">未予約</span>
      </div>
      <div class="card-body">
        <div class="image-box">${imgTag}</div>
        <div class="content">
          <textarea class="post-textarea" id="text-${postNum}" rows="5">${finalPost}</textarea>
          ${imgNote}
          <div class="btn-row">
            <label class="time-label">🕐 投稿時間</label>
            <input type="time" class="time-input" id="time-${postNum}" value="${scheduleTime}">
            <button class="btn-schedule" id="btn-${postNum}"
              onclick="schedulePost(${postNum}, '${safeSourceUrl}', '${thumbAbsPath}')">
              📅 投稿予約
            </button>
            <button class="btn-cancel" id="cancel-${postNum}" style="display:none"
              onclick="cancelPost(${postNum})">
              🚫 キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>【速報】世界の話題 投稿ランチャー ${today}</title>
  <style>
    body { font-family: sans-serif; background: #f0f2f5; margin: 0; padding: 20px; }
    h1 { color: #1da1f2; font-size: 1.3em; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 0.9em; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
    .card.scheduled { border: 2px solid #f39c12; }
    .card.posted { border: 2px solid #27ae60; opacity: 0.75; }
    .card-header { background: #1da1f2; color: #fff; padding: 10px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .post-num { font-weight: bold; font-size: 1.1em; }
    .schedule-time { font-size: 1em; }
    .source { margin-left: auto; font-size: 0.85em; opacity: 0.85; }
    .status-badge { background: rgba(0,0,0,0.25); color: #fff; font-size: 0.8em; font-weight: bold; padding: 3px 10px; border-radius: 12px; }
    .status-badge.scheduled { background: #f39c12; }
    .status-badge.posted { background: #27ae60; }
    .card-body { display: flex; gap: 16px; padding: 16px; }
    .image-box { flex: 0 0 220px; }
    .image-box img { width: 220px; height: 160px; object-fit: cover; border-radius: 8px; border: 1px solid #eee; }
    .no-image { width: 220px; height: 160px; background: #eee; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #999; font-size: 0.85em; }
    .no-image.video { background: #1a1a2e; color: #fff; font-size: 1em; }
    .video-note { color: #8e44ad; font-weight: bold; }
    .content { flex: 1; display: flex; flex-direction: column; gap: 10px; }
    .post-textarea { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 0.95em; line-height: 1.7; font-family: sans-serif; resize: vertical; box-sizing: border-box; }
    .post-textarea:focus { outline: none; border-color: #1da1f2; }
    .img-note { font-size: 0.82em; color: #555; }
    .img-note.warn { color: #e67e22; }
    .img-note code { background: #eee; padding: 2px 6px; border-radius: 4px; }
    .btn-row { display: flex; gap: 10px; margin-top: 4px; flex-wrap: wrap; }
    .time-label { font-size: 0.9em; font-weight: bold; color: #555; align-self: center; }
    .time-input { padding: 8px 12px; border: 2px solid #1da1f2; border-radius: 8px; font-size: 1em; font-weight: bold; color: #333; cursor: pointer; }
    .time-input:focus { outline: none; border-color: #0d8ecf; }
    .btn-schedule { background: #1da1f2; color: #fff; border: none; padding: 10px 24px; border-radius: 24px; font-weight: bold; font-size: 1em; cursor: pointer; transition: background 0.2s; }
    .btn-schedule:hover { background: #0d8ecf; }
    .btn-schedule:disabled { background: #aaa; cursor: default; }
    .btn-cancel { background: #e74c3c; color: #fff; border: none; padding: 10px 20px; border-radius: 24px; font-weight: bold; font-size: 0.9em; cursor: pointer; }
    .btn-cancel:hover { background: #c0392b; }
    .steps { background: #e8f4fd; border: 1px solid #1da1f2; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; font-size: 0.9em; line-height: 1.9; }
    .steps .note { color: #c0392b; font-size: 0.88em; margin-top: 6px; }
  </style>
  <script>
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
          badge.textContent = '予約済み ✓';
          badge.className = 'status-badge scheduled';
          btn.textContent = '✅ ' + data.scheduledAt + ' に予約済み';
          btn.style.background = '#f39c12';
          document.getElementById('card-' + postNum).classList.add('scheduled');
          document.getElementById('cancel-' + postNum).style.display = 'inline-block';
        } else {
          btn.disabled = false;
          btn.textContent = '📅 ' + scheduleTime + ' に投稿予約';
          alert('予約失敗: サーバーに接続できません。node post_server.js を起動してください。');
        }
      } catch(e) {
        btn.disabled = false;
        btn.textContent = '📅 ' + scheduleTime + ' に投稿予約';
        alert('サーバーに接続できません。\nターミナルで: node post_server.js を実行してください。');
      }
    }

    async function shutdownServer() {
      if (!confirm('サーバーを停止しますか？\n⚠️ 予約済みの投稿もすべてキャンセルされます。')) return;
      try {
        await fetch('http://localhost:3000/api/shutdown', { method: 'POST' });
      } catch(e) {}
      window.close();
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
        badge.className = 'status-badge';
        const btn = document.getElementById('btn-' + postNum);
        btn.disabled = false;
        btn.textContent = '📅 に投稿予約';
        btn.style.background = '';
        document.getElementById('card-' + postNum).classList.remove('scheduled');
        document.getElementById('cancel-' + postNum).style.display = 'none';
      }
    }
  </script>
</head>
<body>
  <h1>【速報】世界の話題 投稿ランチャー</h1>
  <div class="subtitle">${today} ／ 全10件</div>
  <div style="display:flex;gap:12px;margin-bottom:16px;">
    <span style="background:#1da1f2;color:#fff;padding:8px 20px;border-radius:20px;font-weight:bold;font-size:0.9em;">𝕏 X投稿ランチャー（現在）</span>
    <a href="http://localhost:3000/youtube" target="_blank" style="background:#ff0000;color:#fff;padding:8px 20px;border-radius:20px;text-decoration:none;font-weight:bold;font-size:0.9em;">▶ YouTube Shortsランチャーへ</a>
  </div>
  <div class="steps">
    <strong>🚀 自動投稿の手順</strong><br>
    ① ターミナルで <code>node post_server.js</code> を起動したまま、このページを開く<br>
    ② 必要なら投稿文を編集（テキストボックスは直接編集OK）<br>
    ③ 「📅 HH:MM に投稿予約」ボタンを押す → サーバーが指定時刻に自動投稿<br>
    ④ 投稿完了後、元ネタURLは<strong>自動でリプ欄に送信</strong>される<br>
    <div class="note">⚠️ post_server.js を停止するとスケジュールがキャンセルされます。投稿完了まで起動したままにしてください。</div>
  </div>
  ${cards}
  <div style="text-align:center;margin-top:32px;padding-bottom:40px;">
    <button onclick="shutdownServer()" style="background:#e74c3c;color:#fff;border:none;padding:12px 36px;border-radius:24px;font-weight:bold;font-size:1em;cursor:pointer;">🔌 ランチャーを閉じる（サーバー停止）</button>
  </div>
</body>
</html>`;
}

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
  const today = new Date().toISOString().slice(0, 10);
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

    const generatedPost = await generatePost(post);
    const finalPost = generatedPost.trim();
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

    htmlItems.push({ postNum, scheduleTime, subreddit: post.subreddit, title: post.title, score: post.score, savedImagePath, savedVideoPath, thumbPath, isVideo: post.isVideo, finalPost, sourceUrl });
  }

  // テキストファイル保存
  await browser.close();

  fs.writeFileSync(saveFile, lines.join("\n"), "utf8");
  console.log(`\n✅ 投稿文を保存しました: ${saveFile}`);

  // HTMLランチャー生成・保存
  const htmlFile = path.join(POSTS_DIR, `${today}.html`);
  fs.writeFileSync(htmlFile, generateHtml(today, htmlItems), "utf8");
  console.log(`✅ 投稿ランチャーを保存しました: ${htmlFile}`);

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

  console.log("\n👉 HTMLファイルをブラウザで開いて「Xで開く」ボタンを押してください！");
}

main().catch(console.error);
