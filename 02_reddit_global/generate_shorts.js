// YouTube Shorts 縦型動画生成スクリプト v5
// 改善: 5スライド構成 / 感情画像オーバーレイ / 全スライドズームパン / タイトルカード冒頭
// 使い方: node generate_shorts.js [yyyy-mm-dd] [件数] [スピーカーID] [速度] [サフィックス]
// 例: node generate_shorts.js 2026-03-14 1 8 1.0 A   ← 春日部つむぎA案
//     node generate_shorts.js 2026-03-14 1 3 1.2 B   ← ずんだもんB案

require("dotenv").config();
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const VOICEVOX_URL = "http://localhost:50021";

const FFMPEG       = "C:\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE      = "C:\\ffmpeg\\bin\\ffprobe.exe";
const SHORTS_DIR   = path.join(__dirname, "shorts");
const SLIDES_DIR   = path.join(__dirname, "shorts_slides");
const EMOTIONS_DIR = path.join(__dirname, "assets", "emotions");
const TEMP_DIR     = path.join(__dirname, "temp");
const BGM_PATH     = path.join(__dirname, "bgm.mp3");
const BEEP_PATH    = path.join(__dirname, "shorts_slides", "beep.wav");
const SAFE = 288;

[SHORTS_DIR, SLIDES_DIR, EMOTIONS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const today          = process.argv[2] || new Date().toISOString().slice(0, 10);
const VOICEVOX_SPEAKER = process.argv[4] ? parseInt(process.argv[4]) : 3;  // デフォルト: ずんだもん(3)
const SPEED_SCALE      = process.argv[5] ? parseFloat(process.argv[5]) : 1.2;
const OUTPUT_SUFFIX    = process.argv[6] || "";  // 例: "A" → _1_A.mp4, "" → _1.mp4

const genFile     = path.join(TEMP_DIR, `generated_${today}.json`);
const contentFile = path.join(TEMP_DIR, `shorts_content_${today}.json`);
if (!fs.existsSync(genFile)) {
  console.error(`❌ Not found: ${genFile}`);
  console.error("先に「今日の投稿を生成して」→ make_launcher.js を実行してください");
  process.exit(1);
}
if (!fs.existsSync(contentFile)) {
  console.error(`❌ Not found: ${contentFile}`);
  console.error("Claude Code に「今日のShortsコンテンツを生成して」と伝えてください");
  process.exit(1);
}

// ─── 感情タグ → 画像パス ────────────────────────────────────────────────
const EMOTION_FILES = {
  HAPPY:    "HAPPY.png",
  SAD:      "SAD.png",
  ANGRY:    "ANGRY.png",
  SURPRISE: "SURPRISE.png",
  THINK:    "THINK.png",
};

function getEmotionImageBase64(tag) {
  const file = EMOTION_FILES[tag] || EMOTION_FILES["THINK"];
  const imgPath = path.join(EMOTIONS_DIR, file);
  if (!fs.existsSync(imgPath)) return null;
  return {
    base64: fs.readFileSync(imgPath).toString("base64"),
    mime: imgPath.endsWith(".png") ? "image/png" : "image/jpeg",
  };
}

// ─── JSONから投稿データと Shorts コンテンツを読み込み ────────────────────
function loadData() {
  const { posts: genPosts } = JSON.parse(fs.readFileSync(genFile, "utf8"));
  const { posts: contentPosts } = JSON.parse(fs.readFileSync(contentFile, "utf8"));

  return genPosts.map((p, idx) => ({
    num: idx + 1,
    time: "",
    body: p.postText,
    originalTitle: p.title,
    imagePath: p.savedImagePath || null,
    content: contentPosts[idx],
  }));
}

// ─── 画像をbase64化 ──────────────────────────────────────────────────────
function imageToBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { base64: null, mime: null };
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return { base64: fs.readFileSync(imgPath).toString("base64"), mime };
}

// ─── インパクトラベル自動判定 ──────────────────────────────────────────
function getLabelText(content) {
  if (content.label) return content.label;
  const text = `${content.catchLine1} ${content.catchLine2}`;
  if (/悲報|残念|死|崩壊|失敗|転落|廃止|敗北/.test(text)) return "【悲報】";
  if (/朗報|成功|最高|喜び|復活|解決|勝利|快挙/.test(text)) return "【朗報】";
  if (/速報|今すぐ|緊急|速|Breaking/.test(text)) return "【速報】";
  return "【衝撃】";
}

// ─── スライドHTML生成 ────────────────────────────────────────────────────
function buildSlideHtml(type, data = {}) {
  const {
    catchLine1 = "", catchLine2 = "", subtitle = "",
    badgeText = "ニュース", imagePath, emotionTag = null, labelText = "【衝撃】",
  } = data;

  const { base64, mime } = imageToBase64(imagePath);
  const emotion = emotionTag ? getEmotionImageBase64(emotionTag) : null;

  const emotionOverlay = emotion
    ? `<div class="emotion-overlay"><img src="data:${emotion.mime};base64,${emotion.base64}" /></div>`
    : "";

  const bgFull = base64
    ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;`
    : `background:linear-gradient(160deg,#0f0c29 0%,#302b63 60%,#24243e 100%);`;

  const bgBlur = base64
    ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;filter:blur(28px) brightness(0.38);`
    : `background:linear-gradient(160deg,#0f0c29 0%,#302b63 60%,#24243e 100%);`;

  // ── スライド0：タイトルカード（縮小16:9サムネ＋キャッチコピー）──
  if (type === "title_card") {
    const thumbH   = 608;
    const thumbTop = Math.round((1920 - thumbH) / 2) + 50;  // 50px下げて上部テキストに余裕
    const thumbBottom = thumbTop + thumbH;

    const thumbStyle = base64
      ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;`
      : `background:#1a1a2e;`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1080px;height:1920px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#000;}
    .bg{width:1080px;height:1920px;position:relative;}
    .blurred-bg{position:absolute;inset:-40px;${bgBlur}}
    .dark-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.55);}
    .upper{position:absolute;top:${SAFE}px;left:0;right:0;height:${thumbTop - SAFE}px;
      display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:30px 56px 0;gap:16px;}
    .badge{background:#e00;color:#fff;font-size:44px;font-weight:900;padding:8px 28px;border-radius:8px;letter-spacing:3px;}
    .impact-label{color:#ff2020;font-size:64px;font-weight:900;letter-spacing:4px;
      text-shadow:2px 2px 6px rgba(0,0,0,0.9),-1px -1px 0 #000,1px -1px 0 #000,-1px 1px 0 #000,1px 1px 0 #000;}
    .line1{color:#FFD700;font-size:96px;font-weight:900;text-align:center;line-height:1.2;
      text-shadow:4px 4px 10px rgba(0,0,0,0.95);overflow-wrap:break-word;}
    .thumb{position:absolute;top:${thumbTop}px;left:0;right:0;height:${thumbH}px;
      ${thumbStyle}
      border-top:4px solid rgba(255,255,255,0.3);border-bottom:4px solid rgba(255,255,255,0.3);}
    .lower{position:absolute;top:${thumbBottom}px;left:0;right:0;bottom:${SAFE}px;
      display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 56px;}
    .line2{color:#fff;font-size:72px;font-weight:900;text-align:center;line-height:1.3;
      text-shadow:3px 3px 8px rgba(0,0,0,0.95);overflow-wrap:break-word;}
    .account{position:absolute;bottom:${Math.max(SAFE - 60, 20)}px;right:0;left:0;text-align:center;
      color:rgba(255,255,255,0.5);font-size:30px;}
    </style></head><body><div class="bg">
      <div class="blurred-bg"></div><div class="dark-overlay"></div>
      <div class="upper">
        <div class="badge">【衝撃】世界の話題</div>
        <div class="impact-label">${labelText.replace(/</g,"&lt;")}</div>
        <div class="line1">${catchLine1.replace(/</g,"&lt;")}</div>
      </div>
      <div class="thumb"></div>
      <div class="lower">
        <div class="line2">${catchLine2.replace(/</g,"&lt;")}</div>
      </div>
      <div class="account">@sekai_no_wadai</div>
    </div></body></html>`;
  }

  // ── スライド1・2・3：コンテンツ（上=ニュース画像、下=字幕）──
  if (type === "content") {
    const imgH      = 760;
    const imgBottom = SAFE + imgH;  // 288 + 760 = 1048

    const upperStyle = base64
      ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;`
      : `background:#1a1a2e;`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1080px;height:1920px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#000;}
    .bg{width:1080px;height:1920px;position:relative;}
    .blurred-bg{position:absolute;inset:-40px;${bgBlur}}
    .dark-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.55);}
    .upper-image{position:absolute;top:${SAFE}px;left:0;right:0;height:${imgH}px;overflow:hidden;${upperStyle}}
    .badge{position:absolute;top:${imgBottom + 12}px;left:40px;background:#e00;color:#fff;font-size:34px;font-weight:900;padding:5px 18px;border-radius:6px;letter-spacing:3px;z-index:2;}
    .lower{position:absolute;top:${imgBottom + 68}px;left:0;right:0;bottom:${SAFE}px;
      display:flex;align-items:center;justify-content:center;padding:0 48px;}
    .subtitle{color:#FFD700;font-size:76px;font-weight:900;text-align:center;line-height:1.4;
      text-shadow:3px 3px 8px rgba(0,0,0,0.95);overflow-wrap:break-word;}
    .footer{position:absolute;bottom:${Math.max(SAFE - 60, 20)}px;left:0;right:0;text-align:center;
      color:rgba(255,255,255,0.4);font-size:28px;}
    </style></head><body><div class="bg">
      <div class="blurred-bg"></div><div class="dark-overlay"></div>
      <div class="upper-image"></div>
      <div class="badge">${badgeText.replace(/</g,"&lt;")}</div>
      <div class="lower">
        <div class="subtitle">${subtitle.replace(/</g,"&lt;").replace(/>/g,"&gt;")}</div>
      </div>
      <div class="footer">@sekai_no_wadai</div>
    </div></body></html>`;
  }

  // ── スライド4：CTA（問いかけ + フォロー誘導）──
  if (type === "cta") {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1080px;height:1920px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
      background:linear-gradient(160deg,#0f0c29 0%,#302b63 60%,#24243e 100%);}
    .bg{width:1080px;height:1920px;display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:${SAFE}px 80px;gap:56px;}
    .question{color:#FFD700;font-size:82px;font-weight:900;text-align:center;line-height:1.4;
      text-shadow:3px 3px 8px rgba(0,0,0,0.8);overflow-wrap:break-word;}
    .divider{width:200px;height:4px;background:rgba(255,255,255,0.3);border-radius:2px;}
    .cta-text{color:#fff;font-size:56px;font-weight:700;text-align:center;line-height:1.5;}
    .account{color:#1da1f2;font-size:64px;font-weight:900;}
    .follow{color:rgba(255,255,255,0.7);font-size:46px;text-align:center;}
    </style></head><body><div class="bg">
      <div class="question">${subtitle.replace(/</g,"&lt;")}</div>
      <div class="divider"></div>
      <div class="cta-text">もっと世界の話題なら</div>
      <div class="account">@sekai_no_wadai</div>
      <div class="follow">をフォロー！</div>
    </div></body></html>`;
  }
}

// ─── Puppeteerでスライド画像をレンダリング ──────────────────────────────
async function renderSlide(page, html, outputPath) {
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: outputPath, type: "png" });
}

// ─── ナレーション生成（VoiceVox HTTP API） ───────────────────────────────
async function generateNarration(text, outputPath) {
  const wavPath = outputPath.replace(/\.mp3$/, ".wav");
  const safeText = text.replace(/\n/g, "　").trim();

  // 1. audio_query取得
  const queryRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(safeText)}&speaker=${VOICEVOX_SPEAKER}`,
    { method: "POST" }
  );
  if (!queryRes.ok) throw new Error(`audio_query failed: ${queryRes.status}`);
  const query = await queryRes.json();

  query.speedScale = SPEED_SCALE;

  // 2. 音声合成
  const synthRes = await fetch(
    `${VOICEVOX_URL}/synthesis?speaker=${VOICEVOX_SPEAKER}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query) }
  );
  if (!synthRes.ok) throw new Error(`synthesis failed: ${synthRes.status}`);

  const wavBuffer = Buffer.from(await synthRes.arrayBuffer());
  fs.writeFileSync(wavPath, wavBuffer);
  return wavPath;
}

// ─── 音声ファイルの実際の長さを取得（ms単位） ───────────────────────────
function getAudioDuration(audioPath) {
  if (!fs.existsSync(audioPath)) return 3000;
  try {
    const result = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
      { stdio: "pipe" }
    ).toString().trim();
    return Math.round(parseFloat(result) * 1000);
  } catch {
    return 3000;
  }
}

// ─── Puppeteerフレームキャプチャによる動画生成（zoompan代替）────────────
// slideHtml: buildSlideHtml()の戻り値を渡すとズーム+テキストアニメが合成される
async function imageToVideoViaPuppeteer(page, imgPath, durationMs, outputPath, effect = "static", emotionImgPath = null, slideHtml = null) {
  const duration = durationMs / 1000;

  // staticかつ感情画像なし かつ slideHtmlなし → ffmpegで高速処理
  if (effect === "static" && (!emotionImgPath || !fs.existsSync(emotionImgPath)) && !slideHtml) {
    const cmd = `"${FFMPEG}" -y -loop 1 -r 30 -i "${imgPath}" -t ${duration} -vf "scale=1080:1920" -c:v libx264 -pix_fmt yuv420p "${outputPath}"`;
    execSync(cmd, { stdio: "pipe" });
    return;
  }

  const FPS         = 15;
  const zoomEnd     = effect === "zoom_in_fast" ? 1.35 : effect === "zoom_in" ? 1.25 : 1.0;
  const totalFrames = Math.round(duration * FPS);

  let html;

  if (slideHtml) {
    // ─ スライドHTML直接レンダリング：画像ズーム＋パン + テキストフェードイン + 感情 ─
    // zoom-rootでの全体ズームは廃止 → 画像要素のみズーム＋パン、テキストは静止フェードイン

    // effectに応じてパン方向を変える（LTR: 左→右, RTL: 右→左）
    const isLTR = (effect === "zoom_in_fast");
    const panFrom = isLTR
      ? "translate(-55px,-12px) scale(1.28)"
      : "translate(55px,12px) scale(1.28)";
    const panTo = isLTR
      ? "translate(55px,12px) scale(1.28)"
      : "translate(-55px,-12px) scale(1.28)";

    let emoDiv = "";
    if (emotionImgPath && fs.existsSync(emotionImgPath)) {
      const emoBase64 = fs.readFileSync(emotionImgPath).toString("base64");
      const emoY = 1920 - 230 - 25;   // 字幕エリア下（テキストと被らない位置）
      const emoX = 1080 - 230 - 30;   // 右端
      emoDiv = `<div id="emo-overlay" style="position:fixed;width:230px;height:230px;top:${emoY}px;left:${emoX}px;z-index:999;">
        <img src="data:image/png;base64,${emoBase64}" style="width:100%;height:100%;" />
      </div>`;
    }

    const injectStyle = `<style id="anim-inject">
      /* 画像要素だけズーム＋パン（overflow:hiddenで枠からはみ出ない） */
      .upper-image, .thumb {
        overflow: hidden !important;
        animation: imgZoomPan ${duration}s linear forwards paused;
        transform-origin: center center;
      }
      @keyframes imgZoomPan {
        from { transform: ${panFrom}; }
        to   { transform: ${panTo}; }
      }
      /* 動画中はバッジ非表示 */
      .badge { display: none !important; }
      /* テキストフェードイン（テキストは静止） */
      .line1 { animation: fadeInUp 0.5s 0.1s ease-out both paused; }
      .line2 { animation: fadeInUp 0.5s 0.25s ease-out both paused; }
      .subtitle { animation: fadeInUp 0.45s ease-out both paused; }
      .question, .cta-text { animation: fadeInUp 0.4s ease-out both paused; }
      @keyframes fadeInUp {
        from { opacity: 0; transform: translateY(20px); }
        to   { opacity: 1; transform: translateY(0px); }
      }
      /* 感情キャラのぷるぷる */
      #emo-overlay {
        animation: wobble 0.8s linear infinite paused;
        transform-origin: center bottom;
      }
      @keyframes wobble {
        0%   { transform: translate(0,0) rotate(0deg); }
        25%  { transform: translate(4px,-3px) rotate(2deg); }
        50%  { transform: translate(-4px,3px) rotate(-2deg); }
        75%  { transform: translate(3px,4px) rotate(1deg); }
        100% { transform: translate(0,0) rotate(0deg); }
      }
    </style>`;

    html = slideHtml
      .replace('</head>', `${injectStyle}</head>`)
      .replace('</body></html>', `${emoDiv}</body></html>`);
    // ※ zoom-rootラッパーなし → スライド全体はズームしない

  } else {
    // ─ 旧来パス：PNG画像をズームするシンプル版 ─
    const imgBase64 = fs.readFileSync(imgPath).toString("base64");
    const imgMime   = imgPath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

    let emoHtml = "";
    let emoStyle = "";
    if (emotionImgPath && fs.existsSync(emotionImgPath)) {
      const emoBase64 = fs.readFileSync(emotionImgPath).toString("base64");
      const emoY = 1920 - SAFE - 20 - 230;
      emoHtml = `<img id="emo" src="data:image/png;base64,${emoBase64}" />`;
      emoStyle = `
        #emo { position:absolute; width:230px; height:230px; top:${emoY}px; left:425px;
          animation:wobble 0.8s linear infinite paused; transform-origin:center center; }
        @keyframes wobble {
          0%{transform:translate(0,0);} 25%{transform:translate(4px,-3px);}
          50%{transform:translate(-4px,3px);} 75%{transform:translate(3px,4px);}
          100%{transform:translate(0,0);}
        }`;
    }

    html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
html,body{width:1080px;height:1920px;overflow:hidden;background:#000;}
#container{width:1080px;height:1920px;position:relative;overflow:hidden;
  transform-origin:center center;animation:zoom ${duration}s linear forwards paused;}
#bg{width:100%;height:100%;object-fit:cover;display:block;}
@keyframes zoom{from{transform:scale(1);}to{transform:scale(${zoomEnd});}}
${emoStyle}
</style></head><body>
<div id="container"><img id="bg" src="data:${imgMime};base64,${imgBase64}" />${emoHtml}</div>
</body></html>`;
  }

  await page.setContent(html, { waitUntil: "load", timeout: 120000 });

  // フレームディレクトリ作成
  const frameDir = outputPath.replace(/\.mp4$/, "_frames");
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

  // CSSアニメーションを各フレーム時刻に凍結してスクリーンショット
  for (let f = 0; f < totalFrames; f++) {
    const t = f / FPS;
    await page.evaluate((t) => {
      // 画像ズーム＋パン（slideHtmlパス）
      document.querySelectorAll(".upper-image,.thumb").forEach(el => {
        el.style.animationDelay = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      // テキストフェードイン（共通）
      document.querySelectorAll(".line1,.line2,.subtitle,.question,.cta-text").forEach(el => {
        el.style.animationDelay = `-${t}s`;
        el.style.animationPlayState = "paused";
      });
      // 感情オーバーレイ（slideHtmlパス）
      const emoOv = document.getElementById("emo-overlay");
      if (emoOv) { emoOv.style.animationDelay = `-${(t % 0.8).toFixed(3)}s`; emoOv.style.animationPlayState = "paused"; }
      // ズームコンテナ（旧来パス）
      const cont = document.getElementById("container");
      if (cont) { cont.style.animationDelay = `-${t}s`; cont.style.animationPlayState = "paused"; }
      // 感情画像（旧来パス）
      const emo = document.getElementById("emo");
      if (emo) { emo.style.animationDelay = `-${(t % 0.8).toFixed(3)}s`; emo.style.animationPlayState = "paused"; }
    }, t);
    const framePath = path.join(frameDir, `f${String(f).padStart(4, "0")}.png`);
    await page.screenshot({ path: framePath });
  }

  // ffmpegで画像列 → MP4
  const framePattern = path.join(frameDir, "f%04d.png");
  const cmd = `"${FFMPEG}" -y -framerate ${FPS} -i "${framePattern}" -r 30 -c:v libx264 -pix_fmt yuv420p -vf "scale=1080:1920" "${outputPath}"`;
  execSync(cmd, { stdio: "pipe" });

  fs.rmSync(frameDir, { recursive: true });
}

function ensureBeep() {
  if (fs.existsSync(BEEP_PATH)) return;
  const cmd = `"${FFMPEG}" -y -f lavfi -i "sine=frequency=1000:duration=0.09" -ar 44100 "${BEEP_PATH}"`;
  execSync(cmd, { stdio: "pipe" });
  console.log("🔔 効果音生成完了");
}

// 音声トラック生成（ナレーション + BGM + 効果音）
function generateAudioTrack(durationsMs, narrationPaths, outputPath) {
  const totalMs = durationsMs.reduce((a, b) => a + b, 0);
  const total   = totalMs / 1000;

  const startTimesMs = [];
  let t = 0;
  for (let i = 0; i < durationsMs.length; i++) {
    startTimesMs.push(t);
    t += durationsMs[i];
  }

  const beepPositions = startTimesMs.slice(1);
  const hasBgm = fs.existsSync(BGM_PATH);
  let inputArgs = "";
  let filters = [];
  let idx = 0;

  if (hasBgm) {
    inputArgs += ` -stream_loop -1 -i "${BGM_PATH}"`;
    filters.push(`[${idx}:a]volume=0.12,atrim=0:${total},asetpts=PTS-STARTPTS[base]`);
  } else {
    inputArgs += ` -f lavfi -t ${total} -i "anullsrc=r=44100:cl=stereo"`;
    filters.push(`[${idx}:a]atrim=0:${total}[base]`);
  }
  idx++;

  const narrLabels = [];
  for (let i = 0; i < narrationPaths.length; i++) {
    if (!narrationPaths[i] || !fs.existsSync(narrationPaths[i])) continue;
    inputArgs += ` -i "${narrationPaths[i]}"`;
    filters.push(`[${idx}:a]volume=2.0,adelay=${startTimesMs[i]}|${startTimesMs[i]},apad=whole_dur=${total}[n${i}]`);
    narrLabels.push(`[n${i}]`);
    idx++;
  }

  const beepLabels = [];
  for (let i = 0; i < beepPositions.length; i++) {
    inputArgs += ` -i "${BEEP_PATH}"`;
    filters.push(`[${idx}:a]volume=0.5,adelay=${beepPositions[i]}|${beepPositions[i]},apad=whole_dur=${total}[b${i}]`);
    beepLabels.push(`[b${i}]`);
    idx++;
  }

  const allLabels = `[base]${narrLabels.join("")}${beepLabels.join("")}`;
  const numInputs = 1 + narrLabels.length + beepLabels.length;
  filters.push(`${allLabels}amix=inputs=${numInputs}:normalize=0,volume=1.8[aout]`);

  const cmd = `"${FFMPEG}" -y ${inputArgs} -filter_complex "${filters.join(";")}" -map "[aout]" -t ${total} -ar 44100 "${outputPath}"`;
  execSync(cmd, { stdio: "pipe" });
}

function concatAndMix(videoPaths, audioPath, totalMs, outputPath) {
  const total = totalMs / 1000;
  const listFile = outputPath.replace(".mp4", "_list.txt");
  fs.writeFileSync(listFile, videoPaths.map(p => `file '${p.replace(/\\/g, "/")}'`).join("\n"), "utf8");
  const cmd = `"${FFMPEG}" -y -f concat -safe 0 -i "${listFile}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -shortest -t ${total} "${outputPath}"`;
  execSync(cmd, { stdio: "pipe" });
  fs.unlinkSync(listFile);
}

// ─── メイン ──────────────────────────────────────────────────────────────
async function main() {
  const speakerNames = { 3: "ずんだもん", 8: "春日部つむぎ", 2: "四国めたん", 9: "波音リツ" };
  const speakerLabel = speakerNames[VOICEVOX_SPEAKER] || `ID:${VOICEVOX_SPEAKER}`;
  const suffixLabel  = OUTPUT_SUFFIX ? ` [${OUTPUT_SUFFIX}案]` : "";
  console.log(`=== YouTube Shorts v5 生成 ${today}${suffixLabel} ===`);
  console.log(`🎙️  声: ${speakerLabel} (ID:${VOICEVOX_SPEAKER}) / 速度: ${SPEED_SCALE}\n`);

  // ── VoiceVox 起動確認（未起動なら即終了） ───────────────────────────────
  try {
    const vvRes = await fetch(`${VOICEVOX_URL}/version`);
    if (!vvRes.ok) throw new Error();
    const vvVer = await vvRes.json();
    console.log(`✅ VoiceVox v${vvVer} 接続確認`);
  } catch {
    console.error(`\n❌ VoiceVox に接続できません（${VOICEVOX_URL}）`);
    console.error(`   VoiceVox を起動してから再実行してください`);
    console.error(`   起動確認: http://localhost:50021/version\n`);
    process.exit(1);
  }

  ensureBeep();

  // 感情画像の読み込み状況確認
  const emotionCount = Object.values(EMOTION_FILES).filter(f =>
    fs.existsSync(path.join(EMOTIONS_DIR, f))
  ).length;
  console.log(`😊 感情画像: ${emotionCount}/5 読み込み済み`);
  if (emotionCount === 0) {
    console.log(`  ⚠️  assets/emotions/ に画像がありません。感情オーバーレイなしで続行します。`);
  }

  const allPosts = loadData();
  const limit = process.argv[3] ? parseInt(process.argv[3]) : allPosts.length;
  const posts = allPosts.slice(0, limit);
  console.log(`📄 ${posts.length}件を処理します（全${allPosts.length}件中）\n`);

  const browser = await puppeteer.launch({ headless: true });
  const page    = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });

  for (const post of posts) {
    const _startTime = Date.now();
    console.log(`\n▶ 投稿${post.num} (${post.time}) の動画を生成中...`);

    const slideDir = path.join(SLIDES_DIR, `${today}_${post.num}`);
    if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

    // JSONからコンテンツ読み込み（Claude Code が生成済み）
    const content = post.content;

    // ナレーション原稿（5スライド分）
    const narrTexts = [
      `${content.catchLine1}。${content.catchLine2}`,  // S0: title_card
      content.slide1.narration,                          // S1: content①
      content.slide2.narration,                          // S2: content②
      content.slide3.narration,                          // S3: surprise
      content.slide4.narration,                          // S4: cta
    ];

    // ナレーション生成
    console.log(`  🎙️ ナレーション生成中...`);
    const narrationPaths = [];
    let narrFailCount = 0;
    for (let i = 0; i < narrTexts.length; i++) {
      const narrPath = path.join(slideDir, `narr_${i}.wav`);
      try {
        await generateNarration(narrTexts[i], narrPath);
        narrationPaths.push(narrPath);
      } catch (e) {
        console.warn(`  ⚠️ S${i}ナレーション失敗: ${e.message}`);
        narrationPaths.push(null);
        narrFailCount++;
      }
    }
    if (narrFailCount > 0) {
      console.warn(`  ⚠️ ${narrFailCount}件のナレーションが失敗。BGMのみで続行します。`);
    } else {
      console.log(`  ✅ ナレーション5件生成完了`);
    }

    // 実際の音声長さを取得してスライド尺を決定（min〜maxでキャップ）
    const minDurationsMs = [5000, 5000, 5000, 5000, 4000];
    const maxDurationsMs = [8000, 7000, 7000, 7000, 5000];  // 最大7秒制約
    const durationsMs = narrationPaths.map((p, i) => {
      if (!p) return minDurationsMs[i];
      const audioDurMs = getAudioDuration(p);
      const raw = Math.max(minDurationsMs[i], audioDurMs + 500);
      return Math.min(raw, maxDurationsMs[i]);
    });

    // スライドHTML生成（5枚）+ 動画用にHTML文字列も保持
    console.log(`  🖼️ スライド生成中...`);

    const getEmotionPath = (tag) => {
      const file = EMOTION_FILES[tag] || EMOTION_FILES["THINK"];
      const p = path.join(EMOTIONS_DIR, file);
      return fs.existsSync(p) ? p : null;
    };

    // S0: タイトルカード
    const html_s0 = buildSlideHtml("title_card", {
      catchLine1: content.catchLine1,
      catchLine2: content.catchLine2,
      imagePath: post.imagePath,
      labelText: getLabelText(content),
    });
    const s0 = path.join(slideDir, "s00_title.png");
    await renderSlide(page, html_s0, s0);

    // S1: 内容①
    const html_s1 = buildSlideHtml("content", {
      catchLine1: content.catchLine1,
      subtitle: content.slide1.subtitle,
      badgeText: "ニュース",
      imagePath: post.imagePath,
      emotionTag: content.slide1.emotion,
    });
    const s1 = path.join(slideDir, "s01_content1.png");
    await renderSlide(page, html_s1, s1);

    // S2: 内容②（背景知識）
    const html_s2 = buildSlideHtml("content", {
      catchLine1: "背景を知ると…",
      subtitle: content.slide2.subtitle,
      badgeText: "豆知識",
      imagePath: post.imagePath,
      emotionTag: content.slide2.emotion,
    });
    const s2 = path.join(slideDir, "s02_content2.png");
    await renderSlide(page, html_s2, s2);

    // S3: 驚き
    const html_s3 = buildSlideHtml("content", {
      catchLine1: "実は…",
      subtitle: content.slide3.subtitle,
      badgeText: "衝撃の事実",
      imagePath: post.imagePath,
      emotionTag: content.slide3.emotion,
    });
    const s3 = path.join(slideDir, "s03_surprise.png");
    await renderSlide(page, html_s3, s3);

    // S4: CTA（静止のまま）
    const html_s4 = buildSlideHtml("cta", { subtitle: content.slide4.subtitle });
    const s4 = path.join(slideDir, "s04_cta.png");
    await renderSlide(page, html_s4, s4);

    // Xサムネイル用にS0を別途コピー
    const thumbPath = path.join(SHORTS_DIR, `${today}_${post.num}_thumb.png`);
    fs.copyFileSync(s0, thumbPath);

    console.log(`  ✅ スライド5枚生成 (Xサムネ保存済み)`);

    // 動画変換
    // S0/S3: zoom_in_fast（タイトル・驚き → 強めのズームで掴む）
    // S1/S2: zoom_in（コンテンツ → 緩やかなズーム）
    // S4: static（CTA → 安定させる）
    const slideEffects = [
      { img: s0, effect: "zoom_in_fast", emo: null,                                   html: html_s0 },
      { img: s1, effect: "zoom_in",      emo: getEmotionPath(content.slide1.emotion), html: html_s1 },
      { img: s2, effect: "zoom_in",      emo: getEmotionPath(content.slide2.emotion), html: html_s2 },
      { img: s3, effect: "zoom_in_fast", emo: getEmotionPath(content.slide3.emotion), html: html_s3 },
      { img: s4, effect: "static",       emo: null,                                   html: null    },
    ];

    const videoPaths = [];
    for (let i = 0; i < slideEffects.length; i++) {
      const { img, effect, emo, html } = slideEffects[i];
      const vid = img.replace(".png", ".mp4");
      await imageToVideoViaPuppeteer(page, img, durationsMs[i], vid, effect, emo, html);
      videoPaths.push(vid);
    }
    console.log(`  ✅ 動画変換完了`);

    // 音声トラック生成
    const audioPath = path.join(slideDir, "audio.wav");
    generateAudioTrack(durationsMs, narrationPaths, audioPath);

    // 結合・Mix
    const totalMs   = durationsMs.reduce((a, b) => a + b, 0);
    const suffix    = OUTPUT_SUFFIX ? `_${OUTPUT_SUFFIX}` : "";
    const finalPath = path.join(SHORTS_DIR, `${today}_${post.num}${suffix}.mp4`);
    concatAndMix(videoPaths, audioPath, totalMs, finalPath);

    const _elapsed = ((Date.now() - _startTime) / 1000).toFixed(1);
    console.log(`  ✅ 完成: ${finalPath}`);
    console.log(`  📊 構成: ${durationsMs.map((d, i) => `S${i}:${(d/1000).toFixed(1)}秒`).join(" → ")} (計${(totalMs/1000).toFixed(1)}秒)`);
    console.log(`  ⏱️  生成時間: ${_elapsed}秒`);
  }

  await browser.close();
  console.log(`\n🎉 全${posts.length}本の動画生成完了！`);
  console.log(`📁 保存先: ${SHORTS_DIR}`);
  if (!fs.existsSync(BGM_PATH)) {
    console.log(`\n💡 BGMを追加するには "${BGM_PATH}" にMP3ファイルを置いてください！`);
  }
}

main().catch(console.error);
