// YouTube 横型動画生成スクリプト v1.0
// Canvas  : 1920×1080 (16:9)
// 構成    : S0:title_card + S1〜S4:content + S5:outro = 6スライド
// TTS     : OPENAI_API_KEY があれば OpenAI TTS、なければ VoiceVox fallback
// コメント: youtube_content JSON に含まれる（外部APIまたはローカル取得済み）
//
// 使い方  : node generate_youtube.js [yyyy-mm-dd] [件数] [サフィックス]
// 例      : node generate_youtube.js 2026-03-15 1
//           node generate_youtube.js 2026-03-15 3 A
//
// ─── youtube_content JSON スキーマ ──────────────────────────────────────
// {
//   "date": "yyyy-mm-dd",
//   "posts": [{
//     "catchLine1" : "メインタイトル（下部大テロップ）",
//     "subtitle"   : "サブタイトル（右上小テロップ）",
//     "label"      : "【悲報】",          // 省略可 → 自動判定
//     "imagePath"  : "path/to/image.jpg", // 省略可
//     "slides": [                          // 4件固定
//       {
//         "narration"  : "ナレーション文",
//         "subtitleBox": "字幕ボックステキスト",
//         "comments"   : [                 // 2〜4件推奨（20〜30文字以内）
//           { "user": "名無しさん", "text": "コメント本文" },
//           { "user": "匿名",      "text": "コメント本文" }
//         ]
//       }
//     ],
//     "outro": {
//       "finalComment": { "user": "名無し", "text": "オチのひと言w" }
//     }
//   }]
// }

require("dotenv").config();
const puppeteer    = require("puppeteer");
const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");

// ─── 定数 ────────────────────────────────────────────────────────────────
const FFMPEG       = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "ffmpeg";
const FFPROBE      = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffprobe.exe" : "ffprobe";
const VOICEVOX_URL = "http://localhost:50021";
const VV_SPEAKER   = 3;    // VoiceVox fallback: ずんだもん
const VV_SPEED     = 1.15;

const W    = 1920;   // キャンバス幅
const H    = 1080;   // キャンバス高さ
const SAFE = 60;     // セーフゾーン(px)
const FPS  = 15;     // フレームレート（Puppeteer キャプチャ）

const YT_DIR     = path.join(__dirname, "..", "youtube");
const SLIDES_DIR = path.join(__dirname, "..", "youtube_slides");
const TEMP_DIR   = path.join(__dirname, "..", "temp");
const BGM_PATH   = path.join(__dirname, "..", "bgm.mp3");
const BEEP_PATH  = path.join(__dirname, "..", "youtube_slides", "beep.wav");

[YT_DIR, SLIDES_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const today        = process.argv[2] || new Date().toISOString().slice(0, 10);
const LIMIT_ARG    = process.argv[3] ? parseInt(process.argv[3]) : null;
const OUTPUT_SUFFIX = process.argv[4] || "";

// ─── データ読み込み ───────────────────────────────────────────────────────
function loadData() {
  const file = path.join(TEMP_DIR, `youtube_content_${today}.json`);
  if (!fs.existsSync(file)) {
    console.error(`❌ Not found: ${file}`);
    console.error(`   temp/youtube_content_${today}.json を用意してから実行してください`);
    process.exit(1);
  }
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  return posts.map((p, i) => ({ num: i + 1, ...p }));
}

// ─── 画像 base64 化 ───────────────────────────────────────────────────────
function imgBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { b64: null, mime: null };
  const mime = imgPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return { b64: fs.readFileSync(imgPath).toString("base64"), mime };
}

// ─── ラベル自動判定 ───────────────────────────────────────────────────────
function getLabel(post) {
  if (post.label) return post.label;
  const t = post.catchLine1 || "";
  if (/悲報|死|崩壊|失敗|転落|廃止/.test(t))  return "【悲報】";
  if (/朗報|成功|快挙|復活|勝利/.test(t))      return "【朗報】";
  if (/速報|緊急|Breaking/.test(t))           return "【速報】";
  return "【衝撃】";
}

// ─── HTML エスケープ ──────────────────────────────────────────────────────
const e = s => String(s || "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

// ─── 共通 CSS ─────────────────────────────────────────────────────────────
function baseCSS(bgStyle) {
  return `
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:${W}px;height:${H}px;overflow:hidden;
      font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;}
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

// ─── スライド HTML 生成 ───────────────────────────────────────────────────
function buildSlideHtml(type, data = {}) {
  const {
    catchLine1 = "", subtitle = "", subtitleBox = "",
    comments = [], labelText = "【衝撃】", finalComment = null,
    imagePath,
  } = data;

  const { b64, mime } = imgBase64(imagePath);
  const bgStyle = b64
    ? `background-image:url('data:${mime};base64,${b64}');`
    : `background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);`;

  // ── S0: title_card ────────────────────────────────────────────────────
  if (type === "title_card") {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCSS(bgStyle)}
    .overlay{position:absolute;inset:0;
      background:linear-gradient(to top,
        rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0.08) 100%);}
    .label{
      position:absolute;top:${SAFE}px;left:${SAFE}px;
      background:rgba(210,0,0,0.92);color:#fff;
      font-size:34px;font-weight:900;padding:8px 22px;
      border-radius:8px;letter-spacing:2px;
      animation:fadeUp 0.4s ease-out both paused;}
    .title-band{
      position:absolute;bottom:0;left:0;right:0;
      padding:0 ${SAFE + 20}px ${SAFE + 10}px;}
    .subtitle-small{
      color:rgba(255,255,255,0.88);font-size:32px;font-weight:700;
      text-align:right;margin-bottom:10px;
      text-shadow:2px 2px 6px rgba(0,0,0,0.9);
      animation:fadeUp 0.4s 0.1s ease-out both paused;}
    .title-main{
      color:#FFD700;font-size:70px;font-weight:900;
      line-height:1.25;text-align:left;
      text-shadow:4px 4px 12px rgba(0,0,0,0.95);
      overflow-wrap:break-word;
      animation:fadeUp 0.45s 0.2s ease-out both paused;}
    .account{
      position:absolute;bottom:${SAFE - 20}px;right:${SAFE}px;
      color:rgba(255,255,255,0.38);font-size:24px;}
    </style></head><body><div class="bg">
      <div class="bg-img"></div>
      <div class="overlay"></div>
      <div class="label">${e(labelText)}</div>
      <div class="title-band">
        <div class="subtitle-small">${e(subtitle)}</div>
        <div class="title-main">${e(catchLine1)}</div>
      </div>
      <div class="account">@sekai_no_wadai</div>
    </div></body></html>`;
  }

  // ── S1〜S4: content ───────────────────────────────────────────────────
  // コメント出現タイミング（秒） ← data-start 属性で Puppeteer 側が制御
  if (type === "content") {
    const COMMENT_TIMES = [0.8, 2.2, 3.6, 5.0];
    // 左右交互・上に積み上がる
    const COMMENT_POS = [
      { bottom: 130, left: `${SAFE}px`,  right: "auto",       maxW: "860px" },
      { bottom: 310, left: "auto",        right: `${SAFE}px`,  maxW: "860px" },
      { bottom: 490, left: `${SAFE}px`,  right: "auto",       maxW: "860px" },
      { bottom: 670, left: "auto",        right: `${SAFE}px`,  maxW: "860px" },
    ];

    const commentHtml = comments.slice(0, 4).map((c, i) => {
      const text = typeof c === "string" ? c : (c.text || "");
      const user = typeof c === "string" ? "匿名" : (c.user || "匿名");
      const pos  = COMMENT_POS[i];
      return `<div class="c-box" data-start="${COMMENT_TIMES[i]}"
        style="bottom:${pos.bottom}px;left:${pos.left};right:${pos.right};max-width:${pos.maxW};">
        <span class="c-tag">${e(user)}</span>${e(text)}</div>`;
    }).join("");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCSS(bgStyle)}
    .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.42);}
    /* 字幕ボックス（常時表示） */
    .sub-box{
      position:absolute;bottom:0;left:0;right:0;
      background:rgba(0,0,0,0.78);padding:20px ${SAFE + 20}px;
      animation:fadeUp 0.3s ease-out both paused;}
    .sub-text{
      color:#fff;font-size:42px;font-weight:800;
      text-align:center;line-height:1.45;overflow-wrap:break-word;}
    /* コメントボックス */
    .c-box{
      position:absolute;
      background:rgba(255,255,255,0.96);color:#111;
      font-size:36px;font-weight:700;
      padding:18px 28px;border-radius:12px;
      box-shadow:0 4px 18px rgba(0,0,0,0.5);
      line-height:1.45;
      animation:slideUp 0.45s ease-out both paused;}
    .c-tag{
      display:inline-block;background:#666;color:#fff;
      font-size:26px;font-weight:900;
      padding:3px 10px;border-radius:5px;
      margin-right:10px;vertical-align:middle;}
    @keyframes slideUp{
      from{opacity:0;transform:translateY(30px)}
      to  {opacity:1;transform:translateY(0)}
    }
    </style></head><body><div class="bg">
      <div class="bg-img"></div>
      <div class="overlay"></div>
      ${commentHtml}
      <div class="sub-box"><div class="sub-text">${e(subtitleBox)}</div></div>
    </div></body></html>`;
  }

  // ── S5: outro ─────────────────────────────────────────────────────────
  if (type === "outro") {
    const fc   = finalComment || {};
    const text = typeof fc === "string" ? fc : (fc.text || "");
    const user = typeof fc === "string" ? "匿名" : (fc.user || "匿名");

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCSS(bgStyle)}
    .bg-img{
      animation:kbZoom 6s linear forwards paused;}
    @keyframes kbZoom{from{transform:scale(1.0)}to{transform:scale(1.08)}}
    .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.5);}
    /* 4秒後に出現（data-start="4.0" を Puppeteer 側が制御） */
    .outro-wrap{
      position:absolute;top:50%;left:50%;
      transform:translate(-50%,-50%);
      text-align:center;
      animation:outroIn 0.5s ease-out both paused;}
    @keyframes outroIn{
      from{opacity:0;transform:translate(-50%,-50%) scale(0.75)}
      to  {opacity:1;transform:translate(-50%,-50%) scale(1)}
    }
    .outro-box{
      background:#fff;color:#d00;
      font-size:58px;font-weight:900;
      padding:30px 52px;border-radius:16px;
      box-shadow:0 8px 32px rgba(0,0,0,0.65);
      line-height:1.4;max-width:1600px;}
    .outro-user{
      color:rgba(255,255,255,0.7);font-size:28px;
      font-weight:700;margin-top:12px;}
    .account{
      position:absolute;bottom:${SAFE - 10}px;right:${SAFE}px;
      color:rgba(255,255,255,0.38);font-size:24px;}
    </style></head><body><div class="bg">
      <div class="bg-img"></div>
      <div class="overlay"></div>
      <div class="outro-wrap" data-start="4.0">
        <div class="outro-box">${e(text)}</div>
        <div class="outro-user">${e(user)}</div>
      </div>
      <div class="account">@sekai_no_wadai</div>
    </div></body></html>`;
  }
}

// ─── PNG レンダリング（サムネイル用） ─────────────────────────────────────
async function renderSlide(page, html, outputPath) {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: outputPath, type: "png" });
}

// ─── フレームキャプチャ → MP4 ─────────────────────────────────────────────
async function renderVideo(page, slideHtml, durationMs, outputPath, effect = "zoom_in") {
  const duration    = durationMs / 1000;
  const totalFrames = Math.round(duration * FPS);

  // Ken Burns のパラメータ
  const zoomTo  = effect === "zoom_in_fast" ? 1.12 : effect === "zoom_in" ? 1.08 : 1.0;
  const panMult = effect === "zoom_in_fast" ? 1 : -1;

  // inject: kbZoom アニメーションを実際の尺に合わせて上書き
  const injectStyle = `<style id="yt-inject">
    .bg-img {
      overflow:hidden !important;
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
      // Ken Burns（背景画像）
      document.querySelectorAll(".bg-img").forEach(el => {
        el.style.animationDelay     = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      // テキストフェードイン
      document.querySelectorAll(".title-main,.subtitle-small,.label,.sub-box").forEach(el => {
        el.style.animationDelay     = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      // コメントボックス：data-start で個別タイミング制御
      document.querySelectorAll(".c-box, .outro-wrap").forEach(el => {
        const startAt = parseFloat(el.dataset.start || "0");
        // startAt 前は from フレーム（opacity:0）のまま固定
        const animT = Math.max(0, t - startAt);
        el.style.animationDelay     = `-${animT}s`;
        el.style.animationPlayState = "paused";
      });
    }, t);

    await page.screenshot({
      path: path.join(frameDir, `f${String(f).padStart(4, "0")}.png`),
    });
  }

  const cmd = [
    `"${FFMPEG}" -y`,
    `-framerate ${FPS}`,
    `-i "${path.join(frameDir, "f%04d.png")}"`,
    `-r 30 -c:v libx264 -pix_fmt yuv420p`,
    `-vf "scale=${W}:${H}"`,
    `"${outputPath}"`,
  ].join(" ");
  execSync(cmd, { stdio: "pipe" });
  fs.rmSync(frameDir, { recursive: true });
}

// ─── TTS: OpenAI ─────────────────────────────────────────────────────────
async function narrationOpenAI(text, outputPath) {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model:           "tts-1",
      voice:           "nova",   // nova=女性 / onyx=男性 / shimmer=落ち着いた女性
      input:           text,
      response_format: "mp3",
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS: ${res.status} ${await res.text()}`);
  const mp3 = outputPath.replace(/\.wav$/, ".mp3");
  fs.writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  execSync(`"${FFMPEG}" -y -i "${mp3}" "${outputPath}"`, { stdio: "pipe" });
  fs.unlinkSync(mp3);
  return outputPath;
}

// ─── TTS: VoiceVox (fallback) ─────────────────────────────────────────────
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
  return process.env.OPENAI_API_KEY
    ? narrationOpenAI(text, outputPath)
    : narrationVoiceVox(text, outputPath);
}

// ─── 音声長取得（ms） ─────────────────────────────────────────────────────
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

// ─── 音声トラック合成（ナレーション＋BGM＋beep） ─────────────────────────
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
  beeps.forEach((bt, i) => {
    inputs += ` -i "${BEEP_PATH}"`;
    filters.push(`[${idx}:a]volume=0.35,adelay=${bt}|${bt},apad=whole_dur=${total}[b${i}]`);
    bLabels.push(`[b${i}]`);
    idx++;
  });

  const all = `[base]${nLabels.join("")}${bLabels.join("")}`;
  filters.push(`${all}amix=inputs=${1 + nLabels.length + bLabels.length}:normalize=0,volume=1.8[aout]`);

  execSync(
    `"${FFMPEG}" -y ${inputs} -filter_complex "${filters.join(";")}" -map "[aout]" -t ${total} -ar 44100 "${outputPath}"`,
    { stdio: "pipe" }
  );
}

// ─── 動画結合＋音声ミックス ───────────────────────────────────────────────
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

// ─── beep 生成 ────────────────────────────────────────────────────────────
function ensureBeep() {
  if (fs.existsSync(BEEP_PATH)) return;
  execSync(
    `"${FFMPEG}" -y -f lavfi -i "sine=frequency=900:duration=0.08" -ar 44100 "${BEEP_PATH}"`,
    { stdio: "pipe" }
  );
}

// ─── メイン ───────────────────────────────────────────────────────────────
async function main() {
  const ttsMode = process.env.OPENAI_API_KEY ? "OpenAI TTS (nova)" : "VoiceVox (fallback)";
  console.log(`=== YouTube 横型動画生成 v1.0 [${today}] ===`);
  console.log(`🎙️  TTS : ${ttsMode}`);
  console.log(`📐 Canvas: ${W}×${H}px\n`);

  // VoiceVox 起動確認（OpenAI Key がない場合のみ）
  if (!process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch(`${VOICEVOX_URL}/version`);
      if (!r.ok) throw new Error();
      console.log(`✅ VoiceVox 接続確認`);
    } catch {
      if (process.platform !== "win32") {
        console.warn(`⚠️ VoiceVox 未起動 かつ OPENAI_API_KEY 未設定 → BGMのみで続行`);
      } else {
        console.error(`❌ VoiceVox 未起動 かつ OPENAI_API_KEY も未設定`);
        console.error(`   VoiceVox を起動するか .env に OPENAI_API_KEY を設定してください`);
        process.exit(1);
      }
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
  const page    = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  for (const post of posts) {
    const _t0 = Date.now();
    console.log(`\n▶ 動画${post.num}「${post.catchLine1}」`);

    const slideDir = path.join(SLIDES_DIR, `${today}_${post.num}`);
    if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

    // slides を4件に正規化（不足はダミー埋め）
    const slides = (post.slides || []).slice(0, 4);
    while (slides.length < 4) slides.push({ narration: "", subtitleBox: "", comments: [] });

    // ─── ナレーション生成（S0〜S4 = 5本、S5 = null） ───────────────────
    const narrTexts = [
      post.catchLine1,            // S0: title
      slides[0].narration,        // S1
      slides[1].narration,        // S2
      slides[2].narration,        // S3
      slides[3].narration,        // S4
      null,                        // S5: outro（ナレーションなし）
    ];

    console.log(`  🎙️ ナレーション生成中...`);
    const narrPaths = [];
    let failCount = 0;
    for (let i = 0; i < narrTexts.length; i++) {
      if (!narrTexts[i]) { narrPaths.push(null); continue; }
      const p = path.join(slideDir, `narr_${i}.wav`);
      try {
        await generateNarration(narrTexts[i], p);
        narrPaths.push(p);
      } catch (err) {
        console.warn(`  ⚠️ S${i} ナレーション失敗: ${err.message}`);
        narrPaths.push(null);
        failCount++;
      }
    }
    if (failCount === 0) console.log(`  ✅ ナレーション5件完了`);
    else console.warn(`  ⚠️ ${failCount}件失敗 → BGMのみで続行`);

    // ─── スライド尺計算 ─────────────────────────────────────────────────
    //   min: [title:5s, content×4:7s, outro:5.5s]
    //   max: [title:9s, content×4:12s, outro:5.5s]
    const MIN_MS = [5000, 7000, 7000, 7000, 7000, 5500];
    const MAX_MS = [9000, 12000, 12000, 12000, 12000, 5500];
    const durMs  = narrPaths.map((p, i) => {
      if (!p) return MIN_MS[i];
      return Math.min(Math.max(MIN_MS[i], getAudioDuration(p) + 600), MAX_MS[i]);
    });
    durMs[5] = 5500; // outro 固定

    // ─── HTML 生成（6枚） ───────────────────────────────────────────────
    const imgPath  = post.imagePath || null;
    const label    = getLabel(post);

    const htmlArr = [
      buildSlideHtml("title_card", { catchLine1: post.catchLine1, subtitle: post.subtitle || "", labelText: label, imagePath: imgPath }),
      buildSlideHtml("content",    { subtitleBox: slides[0].subtitleBox, comments: slides[0].comments || [], imagePath: imgPath }),
      buildSlideHtml("content",    { subtitleBox: slides[1].subtitleBox, comments: slides[1].comments || [], imagePath: imgPath }),
      buildSlideHtml("content",    { subtitleBox: slides[2].subtitleBox, comments: slides[2].comments || [], imagePath: imgPath }),
      buildSlideHtml("content",    { subtitleBox: slides[3].subtitleBox, comments: slides[3].comments || [], imagePath: imgPath }),
      buildSlideHtml("outro",      { finalComment: post.outro?.finalComment, imagePath: imgPath }),
    ];

    const effects = ["zoom_in_fast", "zoom_in", "zoom_in", "zoom_in", "zoom_in", "static"];
    const pngNames = ["s00_title","s01","s02","s03","s04","s05"];

    // サムネイル用にS0だけ先に PNG 保存
    const s0png = path.join(slideDir, "s00_title.png");
    console.log(`  🖼️ スライド生成 & 動画変換中...`);
    await renderSlide(page, htmlArr[0], s0png);
    fs.copyFileSync(s0png, path.join(YT_DIR, `${today}_${post.num}_thumb.png`));

    // ─── フレームキャプチャ → 各スライド MP4 ──────────────────────────
    const videoPaths = [];
    for (let i = 0; i < 6; i++) {
      const vidPath = path.join(slideDir, `${pngNames[i]}.mp4`);
      await renderVideo(page, htmlArr[i], durMs[i], vidPath, effects[i]);
      videoPaths.push(vidPath);
    }
    console.log(`  ✅ スライド6枚 → 動画変換完了`);

    // ─── 音声トラック合成 ───────────────────────────────────────────────
    const audioPath = path.join(slideDir, "audio.wav");
    generateAudioTrack(durMs, narrPaths, audioPath);

    // ─── 最終結合 ───────────────────────────────────────────────────────
    const totalMs   = durMs.reduce((a, b) => a + b, 0);
    const sfx       = OUTPUT_SUFFIX ? `_${OUTPUT_SUFFIX}` : "";
    const finalPath = path.join(YT_DIR, `${today}_${post.num}${sfx}.mp4`);
    concatAndMix(videoPaths, audioPath, totalMs, finalPath);

    const elapsed = ((Date.now() - _t0) / 1000).toFixed(1);
    console.log(`  ✅ 完成: ${path.basename(finalPath)}`);
    console.log(`  📊 ${durMs.map((d,i)=>`S${i}:${(d/1000).toFixed(1)}s`).join(" → ")} (計${(totalMs/1000).toFixed(1)}s)`);
    console.log(`  ⏱️  生成時間: ${elapsed}s`);
  }

  await browser.close();
  console.log(`\n🎉 全${posts.length}本の動画生成完了！`);
  console.log(`📁 保存先: ${YT_DIR}`);
  if (!fs.existsSync(BGM_PATH)) {
    console.log(`💡 BGMを追加するには "${BGM_PATH}" にMP3を置いてください`);
  }
}

main().catch(console.error);
