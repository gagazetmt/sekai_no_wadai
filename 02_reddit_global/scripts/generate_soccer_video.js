// サッカー速報 2分動画生成スクリプト（generate_youtube.js ベース）
// 使い方: node generate_soccer_video.js [yyyy-mm-dd] [件数]
// 例: node generate_soccer_video.js 2026-03-16 1

require("dotenv").config();
const puppeteer    = require("puppeteer");
const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

// ─── 定数 ────────────────────────────────────────────────────────────────────
const FFMPEG       = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "ffmpeg";
const FFPROBE      = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffprobe.exe" : "ffprobe";
const VOICEVOX_URL = "http://localhost:50021";
const VV_SPEAKER   = 3;
const VV_SPEED     = 1.15;

const W    = 1920;
const H    = 1080;
const SAFE = 60;
const FPS  = 15;

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const today     = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const LIMIT_ARG = process.argv[3] ? parseInt(process.argv[3]) : null;

const VIDEO_DIR  = path.join(__dirname, "..", "soccer_videos");
const SLIDES_DIR = path.join(__dirname, "..", "soccer_slides");
const TEMP_DIR   = path.join(__dirname, "..", "temp");
const BGM_PATH   = path.join(__dirname, "..", "bgm.mp3");
const BEEP_PATH  = path.join(__dirname, "..", "soccer_slides", "beep.wav");

[VIDEO_DIR, SLIDES_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─── データ読み込み ───────────────────────────────────────────────────────────
function loadData() {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${today}.json`);
  if (!fs.existsSync(file)) {
    console.error(`❌ Not found: ${file}`);
    console.error("先に generate_soccer.js を実行してください");
    process.exit(1);
  }
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  return posts.map((p, i) => ({ num: i + 1, ...p }));
}

// ─── HTML エスケープ ──────────────────────────────────────────────────────────
const e = s => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ─── ラベル自動判定 ───────────────────────────────────────────────────────────
function getLabel(post) {
  if (post.label) return post.label;
  const t = post.catchLine1 || "";
  if (/悲報|敗退|負け|崩壊/.test(t)) return "【悲報】";
  if (/朗報|勝利|優勝|快挙/.test(t)) return "【朗報】";
  return "【速報】";
}

// ─── 共通 CSS ─────────────────────────────────────────────────────────────────
function baseCSS(bgStyle) {
  return `
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:${W}px;height:${H}px;overflow:hidden;
      font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif;}
    .bg{width:${W}px;height:${H}px;position:relative;overflow:hidden;}
    .bg-img{position:absolute;inset:-30px;
      ${bgStyle}
      background-size:cover;background-position:center;
      animation:kbZoom 8s linear forwards paused;transform-origin:center;}
    @keyframes kbZoom{
      from{transform:scale(1.0) translate(-2%,0)}
      to  {transform:scale(1.12) translate(2%,0)}
    }
    @keyframes fadeUp{
      from{opacity:0;transform:translateY(16px)}
      to  {opacity:1;transform:translateY(0)}
    }
  `;
}

// ─── スライド HTML 生成 ───────────────────────────────────────────────────────
function buildSlideHtml(type, data = {}) {
  const {
    catchLine1 = "", subtitle = "", subtitleBox = "",
    comments = [], labelText = "【速報】", finalComment = null,
  } = data;

  // サッカー用ダークグラデーション背景
  const bgStyle = `background:linear-gradient(135deg,#0a0e1a 0%,#0d1b2a 40%,#1a0a2e 100%);`;

  // ── S0: title_card ────────────────────────────────────────────────────────
  if (type === "title_card") {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCSS(bgStyle)}
    .overlay{position:absolute;inset:0;
      background:linear-gradient(to top,
        rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.4) 50%, rgba(0,0,0,0.1) 100%);}
    /* サッカーボールアクセント */
    .accent-line{
      position:absolute;top:0;left:0;right:0;height:6px;
      background:linear-gradient(90deg,#00c853,#1de9b6,#00c853);}
    .label{
      position:absolute;top:${SAFE + 20}px;left:${SAFE}px;
      background:rgba(0,180,80,0.92);color:#fff;
      font-size:34px;font-weight:900;padding:8px 22px;
      border-radius:8px;letter-spacing:2px;
      animation:fadeUp 0.4s ease-out both paused;}
    .soccer-badge{
      position:absolute;top:${SAFE + 20}px;right:${SAFE}px;
      color:rgba(255,255,255,0.5);font-size:28px;font-weight:700;}
    .title-band{
      position:absolute;bottom:0;left:0;right:0;
      padding:0 ${SAFE + 20}px ${SAFE + 20}px;}
    .subtitle-small{
      color:rgba(255,255,255,0.80);font-size:32px;font-weight:700;
      text-align:right;margin-bottom:12px;
      text-shadow:2px 2px 6px rgba(0,0,0,0.9);
      animation:fadeUp 0.4s 0.1s ease-out both paused;}
    .title-main{
      color:#fff;font-size:72px;font-weight:900;
      line-height:1.25;text-align:left;
      text-shadow:4px 4px 12px rgba(0,0,0,0.95);
      overflow-wrap:break-word;
      animation:fadeUp 0.45s 0.2s ease-out both paused;}
    .title-main em{color:#00e676;font-style:normal;}
    .channel{
      position:absolute;bottom:${SAFE - 20}px;right:${SAFE}px;
      color:rgba(255,255,255,0.35);font-size:24px;}
    </style></head><body><div class="bg">
      <div class="bg-img"></div>
      <div class="overlay"></div>
      <div class="accent-line"></div>
      <div class="label">${e(labelText)}</div>
      <div class="soccer-badge">⚽ サッカー海外速報</div>
      <div class="title-band">
        <div class="subtitle-small">${e(subtitle)}</div>
        <div class="title-main">${e(catchLine1)}</div>
      </div>
      <div class="channel">サッカー海外速報</div>
    </div></body></html>`;
  }

  // ── S1〜S4: content ───────────────────────────────────────────────────────
  if (type === "content") {
    const COMMENT_TIMES = [0.8, 2.4, 4.0, 5.6];
    const COMMENT_POS = [
      { bottom: 140, left: `${SAFE}px`,  right: "auto",       maxW: "900px" },
      { bottom: 330, left: "auto",        right: `${SAFE}px`,  maxW: "900px" },
      { bottom: 520, left: `${SAFE}px`,  right: "auto",       maxW: "900px" },
      { bottom: 710, left: "auto",        right: `${SAFE}px`,  maxW: "900px" },
    ];

    const commentHtml = comments.slice(0, 4).map((c, i) => {
      const text = typeof c === "string" ? c : (c.text || "");
      const user = typeof c === "string" ? "海外ファン" : (c.user || "海外ファン");
      const pos  = COMMENT_POS[i];
      return `<div class="c-box" data-start="${COMMENT_TIMES[i]}"
        style="bottom:${pos.bottom}px;left:${pos.left};right:${pos.right};max-width:${pos.maxW};">
        <span class="c-tag">${e(user)}</span>${e(text)}</div>`;
    }).join("");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCSS(bgStyle)}
    .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.50);}
    .accent-line{
      position:absolute;top:0;left:0;right:0;height:6px;
      background:linear-gradient(90deg,#00c853,#1de9b6,#00c853);}
    /* 字幕ボックス */
    .sub-box{
      position:absolute;bottom:0;left:0;right:0;
      background:rgba(0,0,0,0.85);
      border-top:3px solid #00e676;
      padding:22px ${SAFE + 20}px;
      animation:fadeUp 0.3s ease-out both paused;}
    .sub-text{
      color:#fff;font-size:44px;font-weight:800;
      text-align:center;line-height:1.45;overflow-wrap:break-word;}
    /* コメントボックス */
    .c-box{
      position:absolute;
      background:rgba(255,255,255,0.97);color:#111;
      font-size:36px;font-weight:700;
      padding:16px 26px;border-radius:10px;
      box-shadow:0 4px 20px rgba(0,0,0,0.6);
      line-height:1.4;
      border-left:5px solid #00c853;
      animation:slideUp 0.45s ease-out both paused;}
    .c-tag{
      display:inline-block;background:#1a5c2a;color:#fff;
      font-size:24px;font-weight:900;
      padding:3px 10px;border-radius:5px;
      margin-right:10px;vertical-align:middle;}
    @keyframes slideUp{
      from{opacity:0;transform:translateY(30px)}
      to  {opacity:1;transform:translateY(0)}
    }
    </style></head><body><div class="bg">
      <div class="bg-img"></div>
      <div class="overlay"></div>
      <div class="accent-line"></div>
      ${commentHtml}
      <div class="sub-box"><div class="sub-text">${e(subtitleBox)}</div></div>
    </div></body></html>`;
  }

  // ── S5: outro ─────────────────────────────────────────────────────────────
  if (type === "outro") {
    const fc   = finalComment || {};
    const text = typeof fc === "string" ? fc : (fc.text || "");
    const user = typeof fc === "string" ? "海外ファン" : (fc.user || "海外ファン");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCSS(bgStyle)}
    .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.60);}
    .accent-line{
      position:absolute;top:0;left:0;right:0;height:6px;
      background:linear-gradient(90deg,#00c853,#1de9b6,#00c853);}
    .outro-wrap{
      position:absolute;top:50%;left:50%;
      transform:translate(-50%,-50%);
      text-align:center;width:1700px;
      animation:outroIn 0.5s ease-out both paused;}
    @keyframes outroIn{
      from{opacity:0;transform:translate(-50%,-50%) scale(0.80)}
      to  {opacity:1;transform:translate(-50%,-50%) scale(1)}
    }
    .outro-box{
      background:#fff;color:#0a3d1f;
      font-size:56px;font-weight:900;
      padding:28px 48px;border-radius:16px;
      box-shadow:0 8px 36px rgba(0,0,0,0.70);
      line-height:1.45;
      border-bottom:6px solid #00c853;}
    .outro-user{
      color:rgba(255,255,255,0.65);font-size:28px;
      font-weight:700;margin-top:14px;}
    .cta{
      margin-top:40px;
      color:#00e676;font-size:44px;font-weight:900;
      border:3px solid #00e676;padding:16px 52px;
      border-radius:12px;display:inline-block;
      letter-spacing:3px;}
    .channel{
      position:absolute;bottom:${SAFE - 10}px;right:${SAFE}px;
      color:rgba(255,255,255,0.35);font-size:24px;}
    </style></head><body><div class="bg">
      <div class="bg-img"></div>
      <div class="overlay"></div>
      <div class="accent-line"></div>
      <div class="outro-wrap" data-start="0.5">
        <div class="outro-box">${e(text)}</div>
        <div class="outro-user">${e(user)}</div>
        <div class="cta">👍 チャンネル登録</div>
      </div>
      <div class="channel">サッカー海外速報</div>
    </div></body></html>`;
  }
}

// ─── PNG レンダリング ─────────────────────────────────────────────────────────
async function renderSlide(page, html, outputPath) {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  // アニメーションを最終表示状態に強制（opacity:0のままにならないよう）
  await page.evaluate(() => {
    document.querySelectorAll("*").forEach(el => {
      el.style.animationDelay     = "-5s";
      el.style.animationPlayState = "paused";
    });
  });
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: outputPath, type: "png" });
}

// ─── フレームキャプチャ → MP4 ─────────────────────────────────────────────────
async function renderVideo(page, slideHtml, durationMs, outputPath, effect = "zoom_in") {
  const duration    = durationMs / 1000;
  const totalFrames = Math.round(duration * FPS);
  const zoomTo      = effect === "zoom_in_fast" ? 1.12 : 1.08;
  const panMult     = effect === "zoom_in_fast" ? 1 : -1;

  const injectStyle = `<style id="sc-inject">
    .bg-img {
      animation:kbZoom ${duration}s linear forwards paused !important;
    }
    @keyframes kbZoom {
      from { transform: scale(1.0) translate(${panMult * -2}%, 0); }
      to   { transform: scale(${zoomTo}) translate(${panMult * 2}%, 0); }
    }
  </style>`;
  const html = slideHtml.replace("</head>", `${injectStyle}</head>`);
  await page.setContent(html, { waitUntil: "load", timeout: 120000 });

  const frameDir = outputPath.replace(/\.mp4$/, "_frames");
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    await page.evaluate((t) => {
      document.querySelectorAll(".bg-img").forEach(el => {
        el.style.animationDelay     = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      document.querySelectorAll(".title-main,.subtitle-small,.label,.sub-box,.accent-line").forEach(el => {
        el.style.animationDelay     = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      document.querySelectorAll(".c-box, .outro-wrap").forEach(el => {
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

// ─── TTS: OpenAI ─────────────────────────────────────────────────────────────
async function narrationOpenAI(text, outputPath) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ model: "tts-1", voice: "nova", input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS: ${res.status} ${await res.text()}`);
  const mp3 = outputPath.replace(/\.wav$/, ".mp3");
  fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  execSync(`"${FFMPEG}" -y -i "${mp3}" "${outputPath}"`, { stdio: "pipe" });
  fs.unlinkSync(mp3);
  return outputPath;
}

// ─── TTS: VoiceVox (fallback) ─────────────────────────────────────────────────
async function narrationVoiceVox(text, outputPath) {
  const safe = text.replace(/\n/g, "　").trim();
  const qRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(safe)}&speaker=${VV_SPEAKER}`,
    { method: "POST" }
  );
  if (!qRes.ok) throw new Error(`VoiceVox: ${qRes.status}`);
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

// ─── 音声トラック合成 ─────────────────────────────────────────────────────────
function generateAudioTrack(durationsMs, narrPaths, outputPath) {
  const total  = durationsMs.reduce((a, b) => a + b, 0) / 1000;
  let t = 0;
  const starts = durationsMs.map(d => { const s = t; t += d; return s; });
  const beeps  = starts.slice(1);
  const hasBgm = fs.existsSync(BGM_PATH);

  let inputs  = hasBgm
    ? ` -stream_loop -1 -i "${BGM_PATH}"`
    : ` -f lavfi -t ${total} -i "anullsrc=r=44100:cl=stereo"`;
  const filters = [];
  let idx = 0;

  filters.push(hasBgm
    ? `[${idx}:a]volume=0.10,atrim=0:${total},asetpts=PTS-STARTPTS[base]`
    : `[${idx}:a]atrim=0:${total}[base]`);
  idx++;

  const nLabels = [];
  narrPaths.forEach((p, i) => {
    if (!p || !fs.existsSync(p)) return;
    inputs += ` -i "${p}"`;
    filters.push(`[${idx}:a]volume=2.0,adelay=${starts[i]}|${starts[i]},apad=whole_dur=${total}[n${i}]`);
    nLabels.push(`[n${i}]`);
    idx++;
  });

  const bLabels = [];
  if (fs.existsSync(BEEP_PATH)) {
    beeps.forEach((bt, i) => {
      inputs += ` -i "${BEEP_PATH}"`;
      filters.push(`[${idx}:a]volume=0.35,adelay=${bt}|${bt},apad=whole_dur=${total}[b${i}]`);
      bLabels.push(`[b${i}]`);
      idx++;
    });
  }

  const all = `[base]${nLabels.join("")}${bLabels.join("")}`;
  filters.push(`${all}amix=inputs=${1 + nLabels.length + bLabels.length}:normalize=0,volume=1.8[aout]`);

  execSync(
    `"${FFMPEG}" -y ${inputs} -filter_complex "${filters.join(";")}" -map "[aout]" -t ${total} -ar 44100 "${outputPath}"`,
    { stdio: "pipe" }
  );
}

// ─── 動画結合＋音声ミックス ───────────────────────────────────────────────────
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
  console.log(`=== サッカー速報動画生成 [${today}] ===`);
  console.log(`TTS: ${ttsMode} | Canvas: ${W}×${H}px\n`);

  ensureBeep();

  const allPosts = loadData();
  const posts    = allPosts.slice(0, LIMIT_ARG ?? allPosts.length);
  console.log(`${posts.length}件を処理します（全${allPosts.length}件中）\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: process.platform !== "win32" ? ["--no-sandbox"] : [],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  for (const post of posts) {
    const _t0 = Date.now();
    console.log(`\n▶ 動画${post.num}「${post.catchLine1}」`);

    const slideDir = path.join(SLIDES_DIR, `${today}_${post.num}`);
    if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

    const slides = (post.slides || []).slice(0, 4);
    while (slides.length < 4) slides.push({ narration: "", subtitleBox: "", comments: [] });

    // ナレーションテキスト（S0〜S4、S5はnull）
    const narrTexts = [
      post.catchLine1,
      slides[0].narration,
      slides[1].narration,
      slides[2].narration,
      slides[3].narration,
      null,
    ];

    console.log(`  ナレーション生成中...`);
    const narrPaths = [];
    for (let i = 0; i < narrTexts.length; i++) {
      if (!narrTexts[i]) { narrPaths.push(null); continue; }
      const p = path.join(slideDir, `narr_${i}.wav`);
      try {
        await generateNarration(narrTexts[i], p);
        narrPaths.push(p);
      } catch (err) {
        console.warn(`  ⚠️ S${i}失敗: ${err.message}`);
        narrPaths.push(null);
      }
    }
    console.log(`  ✅ ナレーション完了`);

    // 尺計算
    const MIN_MS = [5000, 7000, 7000, 7000, 7000, 5500];
    const MAX_MS = [9000, 14000, 14000, 14000, 14000, 5500];
    const durMs  = narrPaths.map((p, i) => {
      if (!p) return MIN_MS[i];
      return Math.min(Math.max(MIN_MS[i], getAudioDuration(p) + 600), MAX_MS[i]);
    });
    durMs[5] = 5500;

    // HTML生成
    const label   = getLabel(post);
    const htmlArr = [
      buildSlideHtml("title_card", { catchLine1: post.catchLine1, subtitle: post.subtitle || "", labelText: label }),
      buildSlideHtml("content",    { subtitleBox: slides[0].subtitleBox, comments: slides[0].comments || [] }),
      buildSlideHtml("content",    { subtitleBox: slides[1].subtitleBox, comments: slides[1].comments || [] }),
      buildSlideHtml("content",    { subtitleBox: slides[2].subtitleBox, comments: slides[2].comments || [] }),
      buildSlideHtml("content",    { subtitleBox: slides[3].subtitleBox, comments: slides[3].comments || [] }),
      buildSlideHtml("outro",      { finalComment: post.outro?.finalComment }),
    ];

    const effects  = ["zoom_in_fast", "zoom_in", "zoom_in", "zoom_in", "zoom_in", "zoom_in"];
    const pngNames = ["s00_title","s01","s02","s03","s04","s05"];

    // サムネ用PNG保存
    const s0png = path.join(slideDir, "s00_title.png");
    console.log(`  スライド生成 & 動画変換中...`);
    await renderSlide(page, htmlArr[0], s0png);
    fs.copyFileSync(s0png, path.join(VIDEO_DIR, `${today}_${post.num}_thumb.png`));

    // フレームキャプチャ → 各スライドMP4
    const videoPaths = [];
    for (let i = 0; i < 6; i++) {
      const vidPath = path.join(slideDir, `${pngNames[i]}.mp4`);
      await renderVideo(page, htmlArr[i], durMs[i], vidPath, effects[i]);
      videoPaths.push(vidPath);
      process.stdout.write(`  S${i}完了 `);
    }
    console.log();

    // 音声トラック合成
    const audioPath = path.join(slideDir, "audio.wav");
    generateAudioTrack(durMs, narrPaths, audioPath);

    // 最終結合
    const totalMs   = durMs.reduce((a, b) => a + b, 0);
    const finalPath = path.join(VIDEO_DIR, `soccer_${today}_${post.num}.mp4`);
    concatAndMix(videoPaths, audioPath, totalMs, finalPath);

    const elapsed = ((Date.now() - _t0) / 1000).toFixed(1);
    console.log(`  ✅ 完成: ${path.basename(finalPath)}`);
    console.log(`  ${durMs.map((d,i)=>`S${i}:${(d/1000).toFixed(1)}s`).join(" → ")} (計${(totalMs/1000).toFixed(1)}s)`);
    console.log(`  生成時間: ${elapsed}s`);
  }

  await browser.close();
  console.log(`\n全${posts.length}本完了！`);
  console.log(`保存先: ${VIDEO_DIR}`);
}

main().catch(console.error);
