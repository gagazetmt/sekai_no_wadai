// generate_soccer_yt_video.js
// サッカー YouTube 横型動画生成（5スライド新構成）
//
// 【スライド構成】
//   S1: タイトルカード（メイン画像ぼかし背景 + ラベル + キャッチコピー）
//   S2: 試合結果カード（Googleスコア風HTML + 3秒後に試合概要テロップ）
//   S3: コメントスライド1（別画像1秒表示 → コメント積み上がり）
//   S4: コメントスライド2（別画像1秒表示 → コメント積み上がり）
//   S5: アウトロ（S1画像背景 → 3秒ため → 一言テロップ）
//
// 【入力JSON】 temp/soccer_yt_content_YYYY-MM-DD.json
// 【出力】     soccer_yt_videos/YYYY-MM-DD_N.mp4
//
// 使い方: node generate_soccer_yt_video.js [yyyy-mm-dd] [件数]
// 例:     node generate_soccer_yt_video.js 2026-03-21 1

require("dotenv").config();
const puppeteer    = require("puppeteer");
const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

// ─── 定数 ────────────────────────────────────────────────────────────────────
const FFMPEG       = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "ffmpeg";
const FFPROBE      = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffprobe.exe" : "ffprobe";
const VOICEVOX_URL = "http://localhost:50021";
const VV_SPEAKER   = 13;  // 青山龍星 ノーマル
const VV_SPEED     = 1.2;

const W    = 1920;
const H    = 1080;
const SAFE = 60;
const FPS  = 15;

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const today     = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const LIMIT_ARG = process.argv[3] ? parseInt(process.argv[3]) : null;

const VIDEO_DIR   = path.join(__dirname, "..", "soccer_yt_videos");
const SLIDES_DIR  = path.join(__dirname, "..", "soccer_yt_slides");
const TEMP_DIR    = path.join(__dirname, "..", "temp");
const BGM_PATH    = path.join(__dirname, "..", "bgm.mp3");
const BEEP_PATH   = path.join(__dirname, "..", "soccer_yt_slides", "beep.wav");
const LOGOS_DIR   = path.join(__dirname, "..", "logos");
const SERVER_PORT = process.env.PORT || 3003;
const SERVER_URL  = `http://localhost:${SERVER_PORT}`;

[VIDEO_DIR, SLIDES_DIR, TEMP_DIR, path.join(__dirname, "..", "soccer_yt_slides")].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── チームロゴマップ読み込み ─────────────────────────────────────────────────
const TEAM_LOGOS = (() => {
  const file = path.join(LOGOS_DIR, "team_logos.json");
  if (!fs.existsSync(file)) return {};
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  // _comment キーを除外して返す
  const { _comment, ...logos } = raw;
  return logos;
})();

// ─── データ読み込み ───────────────────────────────────────────────────────────
function loadData() {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${today}.json`);
  if (!fs.existsSync(file)) {
    console.error(`❌ Not found: ${file}`);
    console.error("先に soccer_yt_content_YYYY-MM-DD.json を用意してください");
    process.exit(1);
  }
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  return posts.map((p, i) => ({ num: i + 1, ...p }));
}

// ─── 画像 base64 化 ───────────────────────────────────────────────────────────
function imgBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { b64: null, mime: null };
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return { b64: fs.readFileSync(imgPath).toString("base64"), mime };
}

// ─── チームロゴ HTML ─────────────────────────────────────────────────────────
// PNGがあればそれを表示、なければイニシャル入り色付き円（ダミー）
function logoHtml(teamName, size = 120) {
  const file = TEAM_LOGOS[teamName];
  if (file) {
    const logoPath = path.join(LOGOS_DIR, file);
    if (fs.existsSync(logoPath)) {
      const { b64, mime } = imgBase64(logoPath);
      if (b64) {
        return `<img src="data:${mime};base64,${b64}"
          style="width:${size}px;height:${size}px;object-fit:contain;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.6));">`;
      }
    }
  }
  // ダミー: イニシャル3文字 + グラデーション円
  const initials = (teamName || "?").replace(/[^A-Za-z ]/g, "").trim().split(" ")
    .map(w => w[0]).join("").toUpperCase().slice(0, 3) || "???";
  const hue = [...(teamName || "")].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return `<div style="
    width:${size}px;height:${size}px;border-radius:50%;
    background:linear-gradient(135deg,hsl(${hue},60%,35%),hsl(${hue},60%,20%));
    border:3px solid rgba(255,255,255,0.25);
    color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:${Math.round(size * 0.27)}px;font-weight:900;
    text-shadow:1px 1px 4px rgba(0,0,0,0.8);
    flex-shrink:0;">${initials}</div>`;
}

// ─── HTML エスケープ ──────────────────────────────────────────────────────────
const esc = s => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ─── ラベル自動判定 ───────────────────────────────────────────────────────────
function getLabel(post) {
  if (post.label) return post.label;
  const t = post.catchLine1 || "";
  if (/悲報|敗退|負け|崩壊|失態/.test(t)) return "【悲報】";
  if (/朗報|勝利|優勝|快挙|大勝/.test(t)) return "【朗報】";
  return "【速報】";
}

// ─── 共通 CSS ─────────────────────────────────────────────────────────────────
const COMMON_CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  body{
    width:${W}px;height:${H}px;overflow:hidden;
    font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif;
  }
  .bg{width:${W}px;height:${H}px;position:relative;overflow:hidden;}
  @keyframes fadeUp{
    from{opacity:0;transform:translateY(16px)}
    to  {opacity:1;transform:translateY(0)}
  }
  @keyframes slideUp{
    from{opacity:0;transform:translateY(30px)}
    to  {opacity:1;transform:translateY(0)}
  }
  @keyframes scaleIn{
    from{opacity:0;transform:scale(0.88)}
    to  {opacity:1;transform:scale(1)}
  }
  @keyframes kbZoom{
    from{transform:scale(1.0) translate(-2%,0)}
    to  {transform:scale(1.12) translate(2%,0)}
  }
`;

// ─── S1: タイトルカード ───────────────────────────────────────────────────────
// メイン画像（ぼかしなし）+ 複数バッジ + キャッチコピー
function buildS1(post) {
  const { b64, mime } = imgBase64(post.mainImagePath);
  const bgStyle = b64
    ? `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:center top;`
    : `background:linear-gradient(135deg,#1a1a3e,#2d2d60);`;
  const label = getLabel(post);
  const badge = post.badge || "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  .bg-img{
    position:absolute;inset:0;
    ${bgStyle}
    animation:kbZoom 10s linear forwards paused;
    transform-origin:center top;
  }
  .overlay{
    position:absolute;inset:0;
    background:linear-gradient(
      to top,
      rgba(0,0,0,0.92) 0%,
      rgba(0,0,0,0.60) 35%,
      rgba(0,0,0,0.10) 65%,
      rgba(0,0,0,0) 100%
    );
  }
  .badges{
    position:absolute;top:${SAFE}px;left:${SAFE}px;
    display:flex;flex-direction:column;gap:12px;
    animation:fadeUp 0.4s ease-out both paused;
  }
  .badge-item{
    display:inline-block;font-size:34px;font-weight:900;
    padding:9px 22px;border-radius:8px;letter-spacing:2px;color:#fff;
    width:fit-content;
  }
  .badge-primary{background:rgba(200,0,0,0.95);}
  .badge-secondary{background:rgba(180,100,0,0.95);}
  .title-main{
    position:absolute;bottom:${SAFE + 30}px;left:${SAFE}px;right:${SAFE}px;
    color:#FFD700;font-size:82px;font-weight:900;
    line-height:1.3;
    text-shadow:3px 3px 0px rgba(0,0,0,1),6px 6px 24px rgba(0,0,0,0.9);
    overflow-wrap:break-word;word-break:break-all;
    animation:fadeUp 0.45s ease-out both paused;
  }
  .account{
    position:absolute;bottom:${SAFE - 24}px;right:${SAFE}px;
    color:rgba(255,255,255,0.35);font-size:22px;
  }
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    <div class="badges" data-start="0">
      <div class="badge-item badge-primary">${esc(label)}</div>
      ${badge ? `<div class="badge-item badge-secondary">${esc(badge)}</div>` : ""}
    </div>
    <div class="title-main" data-start="0.2">${esc(post.catchLine1)}</div>
    <div class="account">@sekai_no_wadai</div>
  </div></body></html>`;
}

// ─── S2: ソーススライド（ツイートカード風） ──────────────────────────────────
// Fabrizio Romano風ツイートカード。3秒後に概要テロップ出現
function buildS2(post) {
  const author = post.sourceAuthor || "情報筋";
  const text   = post.sourceText   || "";

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  .bg{background:#0d0d12;}

  /* ── 右上バッジ群 ── */
  .badge-group{
    position:absolute;top:${SAFE}px;right:${SAFE}px;
    display:flex;flex-direction:column;align-items:flex-end;gap:12px;
    animation:fadeUp 0.3s ease-out both paused;
  }
  .badge-source{
    background:#f59e0b;color:#000;
    font-size:28px;font-weight:900;
    padding:9px 24px;border-radius:22px;letter-spacing:1px;
  }
  .badge-ja{
    background:rgba(255,255,255,0.10);color:#fff;
    border:1px solid rgba(255,255,255,0.25);
    font-size:22px;font-weight:700;
    padding:6px 18px;border-radius:16px;
  }

  /* ── ツイートカード ── */
  .tweet-card{
    position:absolute;top:50%;left:50%;
    transform:translate(-50%,-50%);
    width:1480px;
    background:rgba(255,255,255,0.06);
    border:1px solid rgba(255,255,255,0.16);
    border-radius:22px;
    padding:54px 72px;
    animation:scaleIn 0.4s ease-out both paused;
  }
  .tweet-header{
    display:flex;align-items:center;gap:24px;margin-bottom:38px;
  }
  .tweet-icon{
    width:88px;height:88px;border-radius:50%;
    background:linear-gradient(135deg,#1DA1F2,#0a6fa8);
    display:flex;align-items:center;justify-content:center;
    font-size:44px;flex-shrink:0;
  }
  .tweet-author{
    color:#fff;font-size:36px;font-weight:900;
    display:flex;align-items:center;gap:10px;
  }
  .tweet-check{color:#1DA1F2;font-size:30px;}
  .tweet-handle{color:rgba(255,255,255,0.42);font-size:24px;margin-top:6px;}
  .tweet-body{
    color:#e8e8e8;font-size:46px;font-weight:700;
    line-height:1.65;overflow-wrap:break-word;
    white-space:pre-line;
  }

  /* ── テロップ（3秒後） ── */
  .sub-box{
    position:absolute;bottom:0;left:0;right:0;
    background:rgba(10,16,32,0.97);border-top:2px solid rgba(245,158,11,0.5);
    padding:22px ${SAFE + 20}px;
    animation:fadeUp 0.35s ease-out both paused;
  }
  .sub-text{color:#fff;font-size:38px;font-weight:800;text-align:center;line-height:1.55;overflow-wrap:break-word;}
  .account{position:absolute;bottom:${SAFE - 10}px;left:${SAFE}px;color:rgba(255,255,255,0.22);font-size:20px;}
  </style></head><body><div class="bg">
    <div class="badge-group" data-start="0">
      <div class="badge-source">♦ ソース（反応15秒〜）</div>
      <div class="badge-ja">日本語訳</div>
    </div>
    <div class="tweet-card" data-start="0">
      <div class="tweet-header">
        <div class="tweet-icon">🐦</div>
        <div>
          <div class="tweet-author">${esc(author)}<span class="tweet-check">✓</span></div>
          <div class="tweet-handle">@${esc(author.toLowerCase().replace(/\s+/g, ""))}</div>
        </div>
      </div>
      <div class="tweet-body">${esc(text)}</div>
    </div>
    <div class="sub-box" data-start="3.0">
      <div class="sub-text">${esc(post.overviewTelop || "")}</div>
    </div>
    <div class="account">@sekai_no_wadai</div>
  </div></body></html>`;
}

// ─── S3/S4: コメントスライド（シンプル積み上がりカード） ─────────────────────
// 背景暗め + topicTag右上（ティール） + コメントカード順次出現（1枚ハイライト）
function buildCommentSlide(post, slideKey) {
  const slide    = post[slideKey] || {};
  const imgKey   = slideKey === "slide3" ? "slide3ImagePath" : "slide4ImagePath";
  const { b64, mime } = imgBase64(post[imgKey]);
  const bgStyle  = b64
    ? `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;

  const topicTag    = slide.topicTag || "";
  const highlightIdx = slide.highlightIdx !== undefined ? parseInt(slide.highlightIdx) : 0;

  const COMMENT_TIMES = [0.3, 0.9, 1.5, 2.1];
  const comments = (slide.comments || []).slice(0, 4);

  const commentsHtml = comments.map((c, i) => {
    const text = typeof c === "string" ? c : (c.text || "");
    const user = typeof c === "string" ? "" : (c.user || "");
    const isHL = i === highlightIdx;
    return `<div class="c-card${isHL ? " c-hl" : ""}" data-start="${COMMENT_TIMES[i]}">
      ${user ? `<div class="c-user">${esc(user)}</div>` : ""}
      <div class="c-text">${esc(text)}</div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  .bg-img{
    position:absolute;inset:0;
    ${bgStyle}
    filter:brightness(0.28);
    animation:kbZoom 10s linear forwards paused;
  }
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.30);}
  .topic-tag{
    position:absolute;top:${SAFE}px;right:${SAFE}px;
    background:#1aa8a8;color:#fff;
    font-size:28px;font-weight:900;
    padding:8px 22px;border-radius:6px;
    animation:fadeUp 0.3s ease-out both paused;
  }
  .comments-area{
    position:absolute;
    top:${SAFE + 20}px;bottom:110px;
    left:${SAFE}px;right:${SAFE}px;
    display:flex;flex-direction:column;justify-content:center;
    gap:20px;
  }
  .c-card{
    background:rgba(0,0,0,0.72);
    border-radius:10px;padding:20px 30px;
    border-left:4px solid rgba(255,255,255,0.10);
    animation:slideUp 0.4s ease-out both paused;
  }
  .c-card.c-hl{
    background:rgba(0,40,100,0.88);
    border-left:4px solid #4a9eff;
    box-shadow:0 0 28px rgba(74,158,255,0.15);
  }
  .c-user{
    color:rgba(255,255,255,0.42);font-size:22px;font-weight:700;
    margin-bottom:8px;
  }
  .c-text{
    color:#f0f0f0;font-size:42px;font-weight:700;
    line-height:1.5;overflow-wrap:break-word;
  }
  .c-hl .c-text{color:#fff;font-weight:900;}
  .sub-box{
    position:absolute;bottom:0;left:0;right:0;
    background:rgba(0,0,0,0.88);border-top:1px solid rgba(255,255,255,0.08);
    padding:18px ${SAFE}px;
    animation:fadeUp 0.3s ease-out both paused;
  }
  .sub-text{color:#fff;font-size:34px;font-weight:800;text-align:center;line-height:1.5;}
  .citation{position:absolute;bottom:14px;left:${SAFE}px;color:rgba(255,255,255,0.28);font-size:20px;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    ${topicTag ? `<div class="topic-tag" data-start="0">${esc(topicTag)}</div>` : ""}
    <div class="comments-area">${commentsHtml}</div>
    <div class="sub-box" data-start="1.0">
      <div class="sub-text">${esc(slide.subtitleBox || "")}</div>
    </div>
    <div class="citation">©Fotmobより引用</div>
  </div></body></html>`;
}

// ─── S5: アウトロ ────────────────────────────────────────────────────────────
// S1と同じ画像（ぼかしなし）＋ 3秒ため → 白ボックス青文字テロップ
function buildS5(post) {
  const { b64, mime } = imgBase64(post.mainImagePath);
  const bgStyle = b64
    ? `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:center;`
    : `background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  .bg-img{
    position:absolute;inset:0;
    ${bgStyle}
    filter:brightness(0.48);
    animation:kbZoom 10s linear forwards paused;
  }
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.22);}
  .outro-wrap{
    position:absolute;bottom:${SAFE + 60}px;left:${SAFE}px;right:${SAFE}px;
    text-align:center;
    animation:scaleIn 0.5s ease-out both paused;
  }
  .outro-box{
    display:inline-block;
    background:#fff;color:#1a6ef5;
    font-size:68px;font-weight:900;
    padding:38px 68px;border-radius:16px;
    box-shadow:0 8px 40px rgba(0,0,0,0.6);
    line-height:1.4;
    max-width:1680px;overflow-wrap:break-word;
  }
  .account{
    position:absolute;bottom:${SAFE - 10}px;right:${SAFE}px;
    color:rgba(255,255,255,0.35);font-size:22px;
  }
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    <div class="outro-wrap" data-start="3.0">
      <div class="outro-box">${esc(post.outroTelop || "")}</div>
    </div>
    <div class="account">@sekai_no_wadai</div>
    <div style="position:absolute;bottom:14px;left:${SAFE}px;color:rgba(255,255,255,0.30);font-size:20px;">※Fotmobより引用</div>
  </div></body></html>`;
}

// ─── TTS: OpenAI ──────────────────────────────────────────────────────────────
async function narrationOpenAI(text, outputPath) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: "tts-1", voice: "nova",
      input: text, response_format: "mp3",
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS: ${res.status} ${await res.text()}`);
  const mp3 = outputPath.replace(/\.wav$/, ".mp3");
  fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  execSync(`"${FFMPEG}" -y -i "${mp3}" "${outputPath}"`, { stdio: "pipe" });
  fs.unlinkSync(mp3);
  return outputPath;
}

// ─── TTS: VoiceVox (fallback) ────────────────────────────────────────────────
async function narrationVoiceVox(text, outputPath) {
  const safe = text.replace(/\n/g, "　").trim();
  const qRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(safe)}&speaker=${VV_SPEAKER}`,
    { method: "POST" }
  );
  if (!qRes.ok) throw new Error(`VoiceVox query: ${qRes.status}`);
  const query = await qRes.json();
  query.speedScale = VV_SPEED;
  const sRes = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${VV_SPEAKER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!sRes.ok) throw new Error(`VoiceVox synthesis: ${sRes.status}`);
  fs.writeFileSync(outputPath, Buffer.from(await sRes.arrayBuffer()));
  return outputPath;
}

async function generateNarration(text, outputPath) {
  return narrationVoiceVox(text, outputPath);
}

// ─── 音声長取得（ms） ─────────────────────────────────────────────────────────
function getAudioDuration(p) {
  if (!fs.existsSync(p)) return 5000;
  try {
    const r = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`,
      { stdio: "pipe" }
    ).toString().trim();
    return Math.round(parseFloat(r) * 1000);
  } catch { return 5000; }
}

// ─── フレームキャプチャ → MP4 ─────────────────────────────────────────────────
async function renderVideo(page, slideHtml, durationMs, outputPath) {
  const duration    = durationMs / 1000;
  const totalFrames = Math.round(duration * FPS);

  // 背景Ken Burnsアニメーションを実際の尺に合わせて上書き
  const injectStyle = `<style id="yt-inject">
    .bg-img{animation:kbZoom ${duration}s linear forwards paused !important;}
  </style>`;
  const html = slideHtml.replace("</head>", `${injectStyle}</head>`);

  await page.setContent(html, { waitUntil: "load", timeout: 120000 });

  const frameDir = outputPath.replace(/\.mp4$/, "_frames");
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    await page.evaluate((t) => {
      // 背景Ken Burns
      document.querySelectorAll(".bg-img").forEach(el => {
        el.style.animationDelay     = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      // data-start 属性を持つ全要素：指定時刻以降に出現
      document.querySelectorAll("[data-start]").forEach(el => {
        const startAt = parseFloat(el.dataset.start || "0");
        const animT   = Math.max(0, t - startAt);
        el.style.animationDelay     = `-${animT}s`;
        el.style.animationPlayState = "paused";
      });
    }, t);

    await page.screenshot({
      path: path.join(frameDir, `f${String(f).padStart(4, "0")}.png`),
    });
  }

  execSync([
    `"${FFMPEG}" -y`,
    `-framerate ${FPS}`,
    `-i "${path.join(frameDir, "f%04d.png")}"`,
    `-r 30 -c:v libx264 -pix_fmt yuv420p`,
    `-vf "scale=${W}:${H}"`,
    `"${outputPath}"`,
  ].join(" "), { stdio: "pipe" });

  fs.rmSync(frameDir, { recursive: true });
}

// ─── 音声トラック合成 ─────────────────────────────────────────────────────────
// phaseOffsets: 各スライド内でナレーション開始を遅らせるミリ秒
// （S2は3秒後にカード→テロップ、S3/S4は1秒後に画像→コメント、S5は3秒後）
function generateAudioTrack(durationsMs, narrPaths, phaseOffsets, outputPath) {
  const totalSec    = durationsMs.reduce((a, b) => a + b, 0) / 1000;
  let cumSec = 0;
  const slideStarts = durationsMs.map(d => { const s = cumSec; cumSec += d / 1000; return s; });

  // 各ナレーションの絶対開始時刻（秒） = スライド開始 + フェーズオフセット
  const narrStartsSec = slideStarts.map((s, i) => s + (phaseOffsets[i] || 0) / 1000);

  // スライド切り替えのbeepタイミング（ms）= スライド境界
  const beepStartsMs = slideStarts.slice(1).map(s => Math.round(s * 1000));

  const hasBgm = fs.existsSync(BGM_PATH);
  let inputs = hasBgm
    ? ` -stream_loop -1 -i "${BGM_PATH}"`
    : ` -f lavfi -t ${totalSec} -i "anullsrc=r=44100:cl=stereo"`;

  const filters = [];
  let idx = 0;

  filters.push(hasBgm
    ? `[${idx}:a]volume=0.10,atrim=0:${totalSec},asetpts=PTS-STARTPTS[base]`
    : `[${idx}:a]atrim=0:${totalSec}[base]`);
  idx++;

  const nLabels = [];
  narrPaths.forEach((p, i) => {
    if (!p || !fs.existsSync(p)) return;
    const delayMs = Math.round(narrStartsSec[i] * 1000);
    inputs += ` -i "${p}"`;
    filters.push(`[${idx}:a]volume=2.0,adelay=${delayMs}|${delayMs},apad=whole_dur=${totalSec}[n${i}]`);
    nLabels.push(`[n${i}]`);
    idx++;
  });

  const bLabels = [];
  beepStartsMs.forEach((btMs, i) => {
    if (!fs.existsSync(BEEP_PATH)) return;
    inputs += ` -i "${BEEP_PATH}"`;
    filters.push(`[${idx}:a]volume=0.35,adelay=${btMs}|${btMs},apad=whole_dur=${totalSec}[b${i}]`);
    bLabels.push(`[b${i}]`);
    idx++;
  });

  const all = `[base]${nLabels.join("")}${bLabels.join("")}`;
  filters.push(`${all}amix=inputs=${1 + nLabels.length + bLabels.length}:normalize=0,volume=1.8[aout]`);

  execSync(
    `"${FFMPEG}" -y ${inputs} -filter_complex "${filters.join(";")}" -map "[aout]" -t ${totalSec} -ar 44100 "${outputPath}"`,
    { stdio: "pipe" }
  );
}

// ─── 動画結合 + 音声ミックス ──────────────────────────────────────────────────
function concatAndMix(videoPaths, audioPath, totalMs, outputPath) {
  const listFile = outputPath.replace(".mp4", "_list.txt");
  fs.writeFileSync(
    listFile,
    videoPaths.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"),
    "utf8"
  );
  execSync(
    `"${FFMPEG}" -y -f concat -safe 0 -i "${listFile}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -shortest -t ${totalMs / 1000} "${outputPath}"`,
    { stdio: "pipe" }
  );
  fs.unlinkSync(listFile);
}

// ─── beep 生成 ────────────────────────────────────────────────────────────────
function ensureBeep() {
  if (fs.existsSync(BEEP_PATH)) return;
  execSync(
    `"${FFMPEG}" -y -f lavfi -i "sine=frequency=900:duration=0.08" -ar 44100 "${BEEP_PATH}"`,
    { stdio: "pipe" }
  );
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const ttsMode = process.env.OPENAI_API_KEY ? "OpenAI TTS (nova)" : "VoiceVox (fallback)";
  console.log(`=== サッカー YouTube 横型動画生成 [${today}] ===`);
  console.log(`🎙️  TTS    : ${ttsMode}`);
  console.log(`📐 Canvas : ${W}×${H}px  FPS:${FPS}\n`);

  // VoiceVox 起動確認（OpenAI Key がない場合のみ）
  if (!process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch(`${VOICEVOX_URL}/version`);
      if (!r.ok) throw new Error();
      console.log(`✅ VoiceVox 接続確認\n`);
    } catch {
      console.error(`❌ VoiceVox 未起動 / OPENAI_API_KEY も未設定`);
      process.exit(1);
    }
  }

  ensureBeep();

  const allPosts = loadData();
  const posts    = allPosts.slice(0, LIMIT_ARG ?? allPosts.length);
  console.log(`📄 ${posts.length}件を処理します（全${allPosts.length}件中）\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: process.platform !== "win32" ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  for (let postArrayIdx = 0; postArrayIdx < posts.length; postArrayIdx++) {
    const post = posts[postArrayIdx];
    const _t0 = Date.now();
    console.log(`\n▶ 動画${post.num}「${post.catchLine1}」`);

    const slideDir = path.join(SLIDES_DIR, `${today}_${post.num}`);
    if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

    // ── HTML 取得（サーバーのプレビューAPIから） ────────────────────────────
    const idx = postArrayIdx;  // サーバーのidxは0始まり（配列上の位置）
    const [h1, h2, h3, h4, h5] = await Promise.all([
      fetch(`${SERVER_URL}/api/preview/s1/${today}/${idx}`).then(r => r.text()),
      fetch(`${SERVER_URL}/api/preview/s2/${today}/${idx}`).then(r => r.text()),
      fetch(`${SERVER_URL}/api/preview/s3/${today}/${idx}`).then(r => r.text()),
      fetch(`${SERVER_URL}/api/preview/s4/${today}/${idx}`).then(r => r.text()),
      fetch(`${SERVER_URL}/api/preview/s5/${today}/${idx}`).then(r => r.text()),
    ]);
    const htmlArr = [h1, h2, h3, h4, h5];

    // ── ナレーションテキスト ────────────────────────────────────────────────
    const narrTexts = [
      post.catchLine1,            // S1
      post.overviewNarration,     // S2（3秒後から読み上げ）
      post.slide3?.narration,     // S3（1秒後から読み上げ）
      post.slide4?.narration,     // S4（1秒後から読み上げ）
      post.outroNarration,        // S5（3秒後から読み上げ）
    ];

    // ── フェーズオフセット（ナレーション開始遅延 ms） ──────────────────────
    const PHASE_OFFSETS = [0, 3000, 1000, 1000, 3000];

    // ── ナレーション生成 ────────────────────────────────────────────────────
    console.log(`  🎙️  ナレーション生成中...`);
    const narrPaths = [];
    let failCount = 0;
    for (let i = 0; i < narrTexts.length; i++) {
      if (!narrTexts[i]?.trim()) { narrPaths.push(null); continue; }
      const p = path.join(slideDir, `narr_${i}.wav`);
      try {
        await generateNarration(narrTexts[i], p);
        narrPaths.push(p);
      } catch (err) {
        console.warn(`  ⚠️ S${i + 1} ナレーション失敗: ${err.message}`);
        narrPaths.push(null);
        failCount++;
      }
    }
    if (failCount === 0) console.log(`  ✅ ナレーション5件完了`);
    else console.warn(`  ⚠️ ${failCount}件失敗 → BGMのみで続行`);

    // ── スライド尺計算 ──────────────────────────────────────────────────────
    // 各スライドの尺 = フェーズオフセット + ナレーション長 + 余白
    // ナレーションなし時はデフォルト尺を使用
    const MIN_NO_NARR = [5000, 7000, 5000, 5000, 6500]; // ナレーションなし時
    const MAX_MS      = [9000, 15000, 12000, 12000, 11000];
    const PADDING_MS  = 700;

    const durMs = narrPaths.map((p, i) => {
      const narrDur = p ? getAudioDuration(p) + PADDING_MS : 0;
      const total   = PHASE_OFFSETS[i] + (narrDur > 0 ? narrDur : MIN_NO_NARR[i]);
      return Math.min(total, MAX_MS[i]);
    });

    const totalMs = durMs.reduce((a, b) => a + b, 0);
    console.log(`  ⏱️  尺: ${durMs.map((d, i) => `S${i + 1}:${(d/1000).toFixed(1)}s`).join(" | ")} → 計${(totalMs/1000).toFixed(1)}s`);

    // ── スライド動画生成 ────────────────────────────────────────────────────
    const videoPaths = [];
    for (let i = 0; i < htmlArr.length; i++) {
      console.log(`  🎬 S${i + 1} レンダリング中...`);
      const vPath = path.join(slideDir, `slide_${i + 1}.mp4`);
      await renderVideo(page, htmlArr[i], durMs[i], vPath);
      videoPaths.push(vPath);
    }

    // ── 音声トラック合成 ────────────────────────────────────────────────────
    console.log(`  🔊 音声ミックス中...`);
    const audioPath = path.join(slideDir, "audio.wav");
    generateAudioTrack(durMs, narrPaths, PHASE_OFFSETS, audioPath);

    // ── 最終動画出力 ────────────────────────────────────────────────────────
    const outPath = path.join(VIDEO_DIR, `${today}_${post.num}.mp4`);
    concatAndMix(videoPaths, audioPath, totalMs, outPath);

    const elapsed = ((Date.now() - _t0) / 1000).toFixed(1);
    console.log(`  ✅ 完成: ${outPath}  (処理時間: ${elapsed}s)`);
  }

  await browser.close();
  console.log(`\n🎉 全動画生成完了！`);
}

main().catch(err => {
  console.error(`\n❌ エラー: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
