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
const { execSync, spawn } = require("child_process");

// ─── 定数 ────────────────────────────────────────────────────────────────────
const FFMPEG       = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "ffmpeg";
const FFPROBE      = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffprobe.exe" : "ffprobe";
const VOICEVOX_URL = "http://localhost:50021";
const VV_SPEAKER   = 13;  // 青山龍星 ノーマル（ナレーション用）
const VV_SPEED     = 1.2;
const VV_CMT_SPEAKERS = [13, 11, 3, 11, 13, 3, 0];  // コメント用: 青山龍星/玄野武宏/ずんだもん ローテ + 四国めたん×1

const W    = 1920;
const H    = 1080;
const SAFE = 60;
const FPS  = 15;

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const today     = process.argv[2] || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const TARGET_ARG = process.argv[3] ? String(process.argv[3]) : null;

// ターゲットとなるインデックスを解析
let targetIndices = null;
if (TARGET_ARG) {
  if (TARGET_ARG.includes(",")) {
    targetIndices = TARGET_ARG.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  } else {
    const limit = parseInt(TARGET_ARG);
    if (!isNaN(limit)) {
      targetIndices = Array.from({ length: limit }, (_, i) => i);
    }
  }
}

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
  
  // 元のインデックスを保持したままマッピング
  const allMapped = posts.map((p, i) => ({ index: i, num: i + 1, ...p }));

  if (targetIndices) {
    console.log(`🎯 指定されたインデックスのみを処理します: ${targetIndices.join(", ")}`);
    return allMapped.filter(p => targetIndices.includes(p.index));
  }
  return allMapped;
}

// ─── 画像 base64 化 ───────────────────────────────────────────────────────────
function imgBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { b64: null, mime: null };
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return { b64: fs.readFileSync(imgPath).toString("base64"), mime };
}

// ─── 画像サイズ取得（PNG/JPEG バイナリ解析） ──────────────────────────────────
function getImageSize(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return null;
  try {
    const buf = fs.readFileSync(imgPath);
    const ext = path.extname(imgPath).toLowerCase();
    if (ext === ".png") return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) break;
      const m = buf[i + 1];
      if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(m)) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch (_) {}
  return null;
}

function imgMeta(imgPath) {
  const { b64, mime } = imgBase64(imgPath);
  const size = getImageSize(imgPath);
  return { b64, mime, isPortrait: size ? size.height > size.width : false };
}

function getImgZoom(post, key) {
  return (post.imgZoom && post.imgZoom[key]) || { zoom: 1.0, x: 50, y: 50 };
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
const esc     = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escRed  = s => esc(s).replace(/\[r\](.*?)\[\/r\]/g, '<span style="color:#c00000">$1</span>');
const escLine = s => escRed(String(s || "").replace(/\\n/g, "\n")).replace(/\n/g, "<br>");

function splitSubText(text) {
  const parts = [];
  let current = "", w = 0;
  for (const c of (text || "")) {
    current += c;
    w += /[\u3040-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(c) ? 2 : 1;
    if ((c === "、" || c === "。") && w >= 40) { parts.push(current.trim()); current = ""; w = 0; }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length >= 2 ? parts : [text || ""];
}

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
  body{width:${W}px;height:${H}px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif;}
  .bg{width:${W}px;height:${H}px;position:relative;overflow:hidden;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes slideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
  @keyframes scaleIn{from{opacity:0;transform:scale(0.88)}to{opacity:1;transform:scale(1)}}
  @keyframes kbZoom{from{transform:scale(1.0)}to{transform:scale(1.1)}}
  @keyframes slideDown{from{opacity:0;transform:translateY(-30px)}to{opacity:1;transform:translateY(0)}}
`;

// ─── S1: タイトルカード ───────────────────────────────────────────────────────
function buildS1(post) {
  const { b64, mime, isPortrait } = imgMeta(post.mainImagePath);
  const iz = getImgZoom(post, "s1");
  const bgPos = `${iz.x}% ${iz.y}%`;
  const bgStyle = b64
    ? isPortrait
      ? `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`
      : `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${bgPos};`
    : `background:linear-gradient(135deg,#1a1a3e,#2d2d60);`;
  const kbExtra = isPortrait
    ? `@keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}`
    : iz.zoom !== 1.0
      ? `@keyframes kbZoom{from{transform:scale(${iz.zoom}) translate(-2%,0)}to{transform:scale(${(iz.zoom+0.12).toFixed(2)}) translate(2%,0)}}`
      : "";
  const bgImgCss = isPortrait
    ? `position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;`
    : `position:absolute;inset:0;${bgStyle}animation:kbZoom 10s linear forwards;transform-origin:${bgPos};`;
  const label = getLabel(post);
  const badge = post.badge || "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  ${kbExtra}
  .bg-img{${bgImgCss}}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.12);}
  .title-area{position:absolute;bottom:${SAFE}px;left:0;right:0;display:flex;flex-direction:column;align-items:flex-start;gap:18px;}
  .badges{display:flex;flex-direction:row;gap:80px;align-items:center;padding-left:${SAFE}px;}
  .badge-item{display:inline-block;font-size:41px;font-weight:900;padding:5px 26px;border-radius:8px;letter-spacing:2px;color:#fff;width:fit-content;animation:fadeUp 0.45s ease-out both;}
  .badge-primary{background:rgba(200,0,0,0.95);animation-delay:0s;}
  .badge-secondary{background:rgba(180,100,0,0.95);animation-delay:0.35s;}
  .title-main{color:#fff;font-size:82px;font-weight:900;line-height:1.3;background:rgba(0,0,0,0.6);border-radius:0;padding:48px 30px;width:100%;overflow-wrap:break-word;word-break:break-all;animation:fadeUp 0.55s 0.6s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="title-area">
      <div class="badges">
        <div class="badge-item badge-primary">${esc(label)}</div>
        ${badge ? `<div class="badge-item badge-secondary">${esc(badge)}</div>` : ""}
      </div>
      <div class="title-main">${escLine(post.catchLine1)}</div>
    </div>
  </div></body></html>`;
}

// ─── S2: ソーススライド（背景画像 + ソースカード + テロップ分割表示） ─────────
function buildS2(post, narrDurSec = null) {
  const author = post.sourceAuthor || "情報筋";
  const { b64, mime, isPortrait } = imgMeta(post.slide2ImagePath || post.mainImagePath);
  const iz = getImgZoom(post, "s2");
  const bgPos = `${iz.x}% ${iz.y}%`;
  const bgStyle = b64
    ? isPortrait
      ? `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`
      : `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${bgPos};`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;
  const kbExtra = isPortrait
    ? `@keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}`
    : iz.zoom !== 1.0
      ? `@keyframes kbZoom{from{transform:scale(${iz.zoom}) translate(-2%,0)}to{transform:scale(${(iz.zoom+0.12).toFixed(2)}) translate(2%,0)}}`
      : "";
  const bgImgCss = isPortrait
    ? `position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;`
    : `position:absolute;inset:0;${bgStyle}animation:kbZoom 10s linear forwards;transform-origin:${bgPos};`;

  const subParts = splitSubText(post.overviewNarration || post.overviewTelop || "");
  const S2_BOX_START  = 0.5;
  const S2_TEXT_START = W_S2_START; // 遷移1秒後に字幕表示開始
  
  let _st = S2_TEXT_START;
  const STN_DUR = narrDurSec !== null ? narrDurSec : subParts.reduce((s, p) => s + Math.max(1.5, p.replace(/\s/g, "").length / 8.0), 0);
  const totalCharsS2 = subParts.reduce((s, p) => s + Math.max(1, p.replace(/\s/g, "").length), 0);

  const subHtml = subParts.map((p, i) => {
    const start = _st.toFixed(2);
    const chars = Math.max(1, p.replace(/\s/g, "").length);
    const dur   = STN_DUR * (chars / totalCharsS2);
    _st += dur;
    const isLast = i === subParts.length - 1;
    const fadeOut = isLast ? "" : `,fadeOut 0.3s ${(_st - 0.3).toFixed(2)}s ease-out forwards`;
    return `<div class="sub-part" style="animation:fadeIn 0.3s ${start}s ease-out both${fadeOut}">${esc(p)}</div>`;
  }).join("");
  const subH = Math.round((Math.round(53 * 1.55) + 44) * 1.21);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  ${kbExtra}
  @keyframes cardIn{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes fadeOut{to{opacity:0}}
  .bg-img{${bgImgCss}}
  .overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.40) 35%,rgba(0,0,0,0.05) 65%,rgba(0,0,0,0) 100%);}
  .source-card{position:absolute;top:${SAFE}px;right:${SAFE}px;background:rgba(0,0,0,0.78);border:1px solid rgba(255,255,255,0.14);border-radius:14px;padding:18px 24px;animation:cardIn 0.45s 0.2s ease-out both;}
  .tweet-author{color:#fff;font-size:18px;font-weight:900;display:flex;align-items:center;gap:8px;}
  .tweet-check{color:#1DA1F2;font-size:14px;}
  .tweet-handle{color:rgba(255,255,255,0.40);font-size:13px;margin-top:2px;}
  .sub-box{position:absolute;bottom:0;left:0;right:0;background:rgba(10,16,32,0.97);border-top:2px solid rgba(245,158,11,0.5);min-height:${subH}px;animation:slideUp 0.4s ${S2_BOX_START}s ease-out both;}
  .sub-part{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:22px ${SAFE+20}px;color:#fff;font-size:53px;font-weight:800;text-align:center;line-height:1.55;overflow-wrap:break-word;opacity:0;}
  .account{position:absolute;bottom:${SAFE-10}px;left:${SAFE}px;color:rgba(255,255,255,0.22);font-size:20px;animation:fadeUp 0.3s 1.5s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="source-card">
      <div class="tweet-author">${esc(author)}<span class="tweet-check">✓</span></div>
      <div class="tweet-handle">@${esc(author.toLowerCase().replace(/\s+/g,""))}</div>
    </div>
    <div class="sub-box">${subHtml}</div>
    <div class="account">@sekai_no_wadai</div>
  </div></body></html>`;
}

// ─── 相棒の設計図：待機時間定数 ──────────────────────────────────────────
const W_S1_START = 1.0; // S1開始後の待機（TBN前）
const W_S1_END   = 3.0; // S1-TBN終了後の待機
const W_S2_START = 1.0; // S2遷移後の待機（ST/STN開始まで）
const W_S2_END   = 2.0; // S2-STN終了後の待機
const W_S3_START = 1.0; // S3/S4遷移後の待機（ST/STN開始まで）
const W_S3_CB_DELAY = 2.0; // S3/S4-STN終了からCB表示開始までの待機
const W_CBN_GAP  = 1.0; // 前のCBN終了から次のCBN開始までの待機
const W_S5_WAIT  = 4.0; // S5遷移後の待機（アウトロ表示まで）
const W_S5_END   = 2.0; // S5-TBN終了後の余韻

// ─── コメントタイミング計算（相棒の設計図：実測ベース） ──────────────────────
// narrDurSec: STNの実測秒数
// cmtDurs: CBNの実測秒数の配列
function calcCommentTiming(slide, narrDurSec, cmtDurs = []) {
  const STN_DUR = narrDurSec || 0;
  
  // CB表示開始タイミング（STN終了から2秒後）
  let _ct = STN_DUR + W_S3_CB_DELAY;
  
  const delays = (cmtDurs || []).map((dur, i) => {
    const start = _ct;
    _ct += dur + W_CBN_GAP; // 次のコメントは前回の終了から1秒後
    return start;
  });

  return { 
    delays, 
    narrEstSec: STN_DUR, 
    endTimeSec: _ct, 
    comments: (slide?.comments || []).slice(0, cmtDurs.length) 
  };
}

// ─── S3/S4: コメントスライド ──────────────────────────────────────────────────
// narrDurSec: 実際のナレーション秒数（STNの実測秒数）
// cmtDurs: CBNの実測秒数の配列
function buildCommentSlide(post, slideKey, narrDurSec = null, cmtDurs = []) {
  const slide   = post[slideKey] || {};
  const imgKey  = slideKey === "slide3" ? "slide3ImagePath" : "slide4ImagePath";
  const { b64, mime, isPortrait } = imgMeta(post[imgKey]);
  const iz = getImgZoom(post, slideKey === "slide3" ? "s3" : "s4");
  const bgPos = `${iz.x}% ${iz.y}%`;
  const bgStyle = b64
    ? isPortrait
      ? `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`
      : `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${bgPos};`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;
  const kbExtra = isPortrait
    ? `@keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}`
    : iz.zoom !== 1.0
      ? `@keyframes kbZoom{from{transform:scale(${iz.zoom}) translate(-2%,0)}to{transform:scale(${(iz.zoom+0.12).toFixed(2)}) translate(2%,0)}}`
      : "";
  const bgImgCss = isPortrait
    ? `position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;`
    : `position:absolute;inset:0;${bgStyle}animation:kbZoom 10s linear forwards;transform-origin:${bgPos};`;

  const topicTag     = slide.topicTag || "";
  const highlightIdx = slide.highlightIdx !== undefined ? parseInt(slide.highlightIdx) : 0;

  // タイミング計算（実測ベース）
  const { delays: commentDelays, narrEstSec: STN_DUR, endTimeSec, comments } = calcCommentTiming(slide, narrDurSec, cmtDurs);
  const narrText = slide.narration || slide.subtitleBox || "";

  const CMT_BG    = ["#FFF9C4","#C8EEFF","#D4F5D4","#EDD5FF","#FFE8CC","#FFD5EA"];
  const CMT_BG_HL = ["#FFD700","#5BB8F5","#5ED45E","#B86FFF","#FF9F43","#FF70A6"];

  const FONT_SIZE      = 49;
  const AREA_TOP_PX    = SAFE + 60;
  const AREA_BOTTOM_PX = 110;
  const GAP            = 20;

  const commentsHtml = comments.map((c, i) => {
    const text = typeof c === "string" ? c : (c.text || "");
    const isHL = i === highlightIdx;
    const side = i % 2 === 0 ? "flex-start" : "flex-end";
    const bg   = isHL ? CMT_BG_HL[i % CMT_BG_HL.length] : CMT_BG[i % CMT_BG.length];
    // CB表示開始（CBN開始と同時）
    return `<div class="c-card${isHL ? " c-hl" : ""}" style="align-self:${side};background:${bg};animation:slideDown 0.45s ${commentDelays[i].toFixed(2)}s ease-out both;">
      <div class="c-text">${esc(text).replace(/\n/g, "<br>")}</div>
    </div>`;
  }).join("");

  // 字幕同期（STN実測ベースの比例配分）
  const subParts = splitSubText(narrText);
  const subH = 130;
  let _st = W_S3_START;
  const totalCharsCmt = subParts.reduce((s, p) => s + Math.max(1, p.replace(/\s/g, "").length), 0);
  const subPartsHtml = subParts.map((p, i) => {
    const start = _st.toFixed(2);
    const chars = Math.max(1, p.replace(/\s/g, "").length);
    const dur   = STN_DUR * (chars / totalCharsCmt);
    _st += dur;
    const isLast = i === subParts.length - 1;
    // ST表示終了（STN終了まで。BOX自体はBOX_START/ENDのアニメで制御）
    const fadeOut = isLast ? "" : `,subPtFadeOut 0.3s ${(_st - 0.3).toFixed(2)}s ease-out forwards`;
    return `<div class="sub-part" style="animation:subPtFadeIn 0.3s ${start}s ease-out both${fadeOut}">${esc(p)}</div>`;
  }).join("");

  // ST表示ボックス（STN終了から2秒後まで表示）
  const boxFadeOutTime = (W_S3_START + STN_DUR + W_S3_CB_DELAY).toFixed(2);

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  ${kbExtra}
  .bg-img{${bgImgCss}}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.10);}
  .topic-tag{position:absolute;top:${SAFE}px;right:${SAFE}px;background:#1aa8a8;color:#fff;font-size:28px;font-weight:900;padding:8px 22px;border-radius:6px;animation:fadeUp 0.35s 0s ease-out both;}
  .comments-area{position:absolute;top:${AREA_TOP_PX}px;bottom:${AREA_BOTTOM_PX}px;left:${SAFE}px;right:${SAFE}px;display:flex;flex-direction:column;justify-content:flex-start;gap:${GAP}px;}
  .c-card{border:3px solid #000;border-radius:8px;padding:10px 18px;width:fit-content;max-width:100%;}
  .c-card.c-hl{border:3px solid #000;}
  .c-text{color:#111;font-size:${FONT_SIZE}px;font-weight:700;line-height:1.4;overflow-wrap:break-word;}
  .c-hl .c-text{color:#000;font-weight:900;}
  @keyframes subFadeOut{to{opacity:0;visibility:hidden;}}
  @keyframes subPtFadeIn{from{opacity:0}to{opacity:1}}
  @keyframes subPtFadeOut{to{opacity:0}}
  .sub-box{position:absolute;bottom:0;left:0;right:0;min-height:${subH}px;background:rgba(0,0,0,0.88);border-top:1px solid rgba(255,255,255,0.08);animation:slideUp 0.6s 0s ease-out both, subFadeOut 0.3s ${boxFadeOutTime}s ease-out forwards;}
  .sub-part{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:18px ${SAFE}px;color:#fff;font-size:48px;font-weight:800;text-align:center;line-height:1.5;overflow-wrap:break-word;opacity:0;}
  .citation{position:absolute;bottom:14px;left:${SAFE}px;color:rgba(255,255,255,0.28);font-size:20px;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    ${topicTag ? `<div class="topic-tag">${esc(topicTag)}</div>` : ""}
    <div class="comments-area">${commentsHtml}</div>
    ${(!slide.noNarration && narrText) ? `<div class="sub-box">${subPartsHtml}</div>` : ""}
    <div class="citation">©Fotmobより引用</div>
  </div></body></html>`;
}

// S3/S4 スライド尺計算（ms）
// narrDurMs: STNの実測ms（0 = 失敗 → デフォルト想定）
// cmtDurs: CBNの実測秒数の配列
function calcCommentSlideDurMs(slide, narrDurMs, cmtDurs = []) {
  const PADDING  = 1000; // 最終CBN終了後の余韻
  const narrDurSec = narrDurMs > 0 ? narrDurMs / 1000 : 2.0; // 失敗時は2秒想定
  const { endTimeSec } = calcCommentTiming(slide, narrDurSec, cmtDurs);
  // S3全体の尺: 遷移(0) + 待機(1) + STN(実測) + 待機(2) + (全CBN + 1s間隔) + 余韻(1)
  return Math.round((W_S3_START + endTimeSec) * 1000) + PADDING;
}

// ─── S5: アウトロ ─────────────────────────────────────────────────────────────
function buildS5(post) {
  const { b64, mime, isPortrait } = imgMeta(post.slide5ImagePath || post.mainImagePath);
  const iz = getImgZoom(post, "s5");
  const bgPos = `${iz.x}% ${iz.y}%`;
  const bgStyle = b64
    ? isPortrait
      ? `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`
      : `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${bgPos};`
    : `background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);`;
  const kbExtra = isPortrait
    ? `@keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}`
    : iz.zoom !== 1.0
      ? `@keyframes kbZoom{from{transform:scale(${iz.zoom}) translate(-2%,0)}to{transform:scale(${(iz.zoom+0.12).toFixed(2)}) translate(2%,0)}}`
      : "";
  const bgImgCss = isPortrait
    ? `position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;`
    : `position:absolute;inset:0;${bgStyle}animation:kbZoom 10s linear forwards;transform-origin:${bgPos};`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  ${kbExtra}
  .bg-img{${bgImgCss}}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.22);}
  .outro-wrap{position:absolute;top:50%;left:${SAFE}px;right:${SAFE}px;transform:translateY(-50%);text-align:center;animation:scaleIn 0.6s ${W_S5_WAIT.toFixed(1)}s ease-out both;}
  .outro-box{display:inline-block;background:#fff;color:#1a6ef5;font-size:68px;font-weight:900;padding:38px 68px;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.6);line-height:1.4;max-width:1680px;overflow-wrap:break-word;}
  .account{position:absolute;bottom:${SAFE-10}px;right:${SAFE}px;color:rgba(255,255,255,0.35);font-size:22px;animation:fadeUp 0.4s 1.0s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    <div class="outro-wrap"><div class="outro-box">${esc(post.outroTelop || "")}</div></div>
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

// ─── S1タイトルコールに自然な読点を挿入 ──────────────────────────────────────
function addTitlePunctuation(text) {
  if (!text) return text;
  // 既に十分な区切りがあれば何もしない（！？は区切り効果あり）
  if ((text.match(/[、。！？]/g) || []).length >= 2) return text;
  return text
    // 漢字の直後に数字が来る場合（例：当確19人 → 当確、19人）
    .replace(/([\u3000-\u9FFF\u30A0-\u30FF])(\d)/g, "$1、$2")
    // 特定キーワードの後に文章が続く場合
    .replace(/(当確|決定|確定|発覚|発表|覚醒|復帰|移籍|招集|炎上|批判|退場|活躍|処分|辞任|就任)(?=[^\s！？。、]{2,})/g, "$1、")
    // ！や？の後に文章が続く場合（スペースを挿入してVoiceVoxが一呼吸おけるように）
    .replace(/([！？])(?=[^\s！？。、]{2,})/g, "$1　");
}

// ─── サッカー用語の読み補正（VoiceVox が苦手なものを変換） ──────────────────
function sanitizeForVoiceVox(text) {
  return (text || "")
    // ─ 大会名 ─
    .replace(/W杯/g, "ワールドカップ")
    .replace(/W・杯/g, "ワールドカップ")
    .replace(/CLグループ|チャンピオンズL/g, "チャンピオンズリーグ")
    .replace(/\bCL\b/g, "チャンピオンズリーグ")
    .replace(/\bEL\b/g, "ヨーロッパリーグ")
    .replace(/\bECL\b/g, "カンファレンスリーグ")
    .replace(/\bPL\b/g, "プレミアリーグ")
    .replace(/\bBL\b/g, "ブンデスリーガ")
    .replace(/\bSA\b/g, "セリエエー")
    .replace(/ラ・リーガ|LaLiga/g, "ラリーガ")
    .replace(/\bUEFA\b/g, "ウエファ")
    .replace(/\bFIFA\b/g, "フィファ")
    .replace(/\bAFCアジア|AFCアジア/g, "エーエフシーアジア")
    // ─ ポジション ─
    .replace(/\bFW\b/g, "フォワード")
    .replace(/\bMF\b/g, "ミッドフィールダー")
    .replace(/\bDF\b/g, "ディフェンダー")
    .replace(/\bGK\b/g, "ゴールキーパー")
    .replace(/\bCB\b/g, "センターバック")
    .replace(/\bSB\b/g, "サイドバック")
    .replace(/\bSH\b/g, "サイドハーフ")
    .replace(/\bCH\b/g, "セントラルミッドフィールダー")
    .replace(/\bDMF?\b/g, "ボランチ")
    .replace(/\bOH\b/g, "トップ下")
    .replace(/\bSS\b/g, "セカンドストライカー")
    .replace(/\bCF\b/g, "センターフォワード")
    // ─ 審判・ルール用語 ─
    .replace(/\bVAR\b/g, "ビデオ判定")
    .replace(/\bFK\b/g, "フリーキック")
    .replace(/\bCK\b/g, "コーナーキック")
    .replace(/\bPK\b/g, "ペナルティキック")
    .replace(/\bOG\b/g, "オウンゴール")
    .replace(/\bPP\b/g, "ペナルティポイント")
    // ─ リーグ名 ─
    .replace(/\bJ1\b/g, "ジェイワン")
    .replace(/\bJ2\b/g, "ジェイツー")
    .replace(/\bJ3\b/g, "ジェイスリー")
    // ─ 日本代表選手（難読・読み間違いやすい） ─
    .replace(/三笘(?:薫)?/g, "みとま")
    .replace(/久保(?:建英)?/g, "くぼたけふさ")
    .replace(/上田(?:綺世)?/g, "うえだあやせ")
    .replace(/鎌田(?:大地)?/g, "かまただいち")
    .replace(/中村(?:敬斗)?/g, "なかむらけいと")
    .replace(/堂安(?:律)?/g, "どうあんりつ")
    .replace(/板倉(?:滉)?/g, "いたくらこう")
    .replace(/冨安(?:健洋)?/g, "とみやすたけひろ")
    .replace(/谷口(?:彰悟)?/g, "たにぐちしょうご")
    .replace(/守田(?:英正)?/g, "もりたひでまさ")
    .replace(/遠藤(?:航)?/g, "えんどうわたる")
    .replace(/伊東(?:純也)?/g, "いとうじゅんや")
    .replace(/南野(?:拓実)?/g, "みなみのたくみ")
    .replace(/旗手(?:怜央)?/g, "はたてれお")
    .replace(/前田(?:大然)?/g, "まえだだいぜん")
    .replace(/毎熊(?:晟矢)?/g, "まいくません")
    .replace(/古橋(?:亨梧)?/g, "ふるはしきょうご")
    .replace(/西村(?:拓真)?/g, "にしむらたくま")
    .replace(/森保(?:一)?/g, "もりやすはじめ")
    // ─ 記号・特殊文字 ─
    .replace(/→/g, "から")
    .replace(/×/g, "たい")
    .replace(/【([^】]+)】/g, "$1")
    .replace(/〝([^〟]+)〟/g, "$1")
    .replace(/\n/g, "　")
    .trim();
}

// ─── TTS: VoiceVox ────────────────────────────────────────────────────────────
async function narrationVoiceVox(text, outputPath, speaker = VV_SPEAKER) {
  const safe = sanitizeForVoiceVox(text);
  const qRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(safe)}&speaker=${speaker}`,
    { method: "POST" }
  );
  if (!qRes.ok) throw new Error(`VoiceVox query: ${qRes.status}`);
  const query = await qRes.json();
  query.speedScale      = VV_SPEED;
  query.intonationScale = 1.35;  // 抑揚を強める（デフォルト1.0）
  query.volumeScale     = 1.1;   // 少し大きめ
  const sRes = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!sRes.ok) throw new Error(`VoiceVox synthesis: ${sRes.status}`);
  fs.writeFileSync(outputPath, Buffer.from(await sRes.arrayBuffer()));
  return outputPath;
}

async function generateNarration(text, outputPath) {
  // 相棒の要望により VoiceVox を最優先（OpenAI APIキーがあっても無視）
  try {
    return await narrationVoiceVox(text, outputPath);
  } catch (err) {
    console.warn(`  ⚠️ VoiceVox生成エラー: ${err.message}`);
    // もしどうしても OpenAI を使いたい場合はここにフォールバックを書けるけど、
    // 今は VoiceVox が基本だから、そのままエラーを投げるね！
    throw err;
  }
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
// Page.startScreencast (CDP) でブラウザ側からフレームをプッシュ受信する低負荷実装。
// pull型の page.screenshot() と異なり、フレームごとのラウンドトリップが不要。
//
// 同期フロー:
//   page.evaluate → アニメーション更新 + requestAnimationFrame 登録
//   → rAF コールバック実行 (paint 前) → evaluate 解決
//   → paint / composite → Page.screencastFrame イベント到着
//   → nextFrame() が解決 → FFmpeg stdin へパイプ
async function renderVideo(page, slideHtml, durationMs, outputPath) {
  const duration    = durationMs / 1000;
  const totalFrames = Math.round(duration * FPS);

  // 背景ズーム/パンは固定40秒（スライド尺に依存させない）
  const BG_ANIM_SECS = 40;
  const injectStyle = `<style id="yt-inject">.bg-img{animation-duration:${BG_ANIM_SECS}s !important;}</style>`;
  const html = slideHtml.replace("</head>", `${injectStyle}</head>`);
  await page.setContent(html, { waitUntil: "load", timeout: 120000 });

  // FFmpeg を stdin パイプで先に起動
  const ffmpegProc = spawn(FFMPEG, [
    "-y",
    "-f",       "image2pipe",
    "-vcodec",  "mjpeg",
    "-r",       String(FPS),
    "-i",       "pipe:0",
    "-r",       "30",
    "-c:v",     "libx264",
    "-preset",  "veryfast",
    "-pix_fmt", "yuv420p",
    "-vf",      `scale=${W}:${H}`,
    outputPath,
  ], { stdio: ["pipe", "pipe", "pipe"] });

  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpegProc.on("close", code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
    ffmpegProc.stderr.on("data", () => {}); // drain
  });

  for (let f = 0; f < totalFrames; f++) {
    const tMs = Math.round((f / FPS) * 1000);

    // アニメーション時刻をセットしてrAFで描画完了を待つ（screencastは使わない）
    await page.evaluate((tMs) => new Promise(resolve => {
      document.getAnimations().forEach(a => {
        a.pause();
        try { a.currentTime = tMs; } catch (_) {}
      });
      requestAnimationFrame(resolve);
    }), tMs);

    // rAF後に screenshot でキャプチャ（screencastのイベントキュー遅延を排除）
    const buf = await page.screenshot({ type: "jpeg", quality: 80 });

    const ok = ffmpegProc.stdin.write(buf);
    if (!ok) await new Promise(r => ffmpegProc.stdin.once("drain", r));
  }

  ffmpegProc.stdin.end();
  await ffmpegDone;
}

// ─── 音声トラック合成 ─────────────────────────────────────────────────────────
// phaseOffsets: 各スライド内でナレーション開始を遅らせるミリ秒
// extraAudios: [{path, startMs}] コメント個別音声など絶対時刻指定の追加音声
function generateAudioTrack(durationsMs, narrPaths, phaseOffsets, outputPath, extraAudios = []) {
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

  // コメント個別音声（ランチャーが生成した cmt_*.wav）
  const eLabels = [];
  extraAudios.forEach(({ path: p, startMs }, i) => {
    if (!p || !fs.existsSync(p)) return;
    inputs += ` -i "${p}"`;
    filters.push(`[${idx}:a]volume=2.5,adelay=${startMs}|${startMs},apad=whole_dur=${totalSec}[e${i}]`);
    eLabels.push(`[e${i}]`);
    idx++;
  });

  const mixCount = 1 + nLabels.length + bLabels.length + eLabels.length;
  const all = `[base]${nLabels.join("")}${bLabels.join("")}${eLabels.join("")}`;
  filters.push(`${all}amix=inputs=${mixCount}:normalize=0,volume=1.8[aout]`);

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

// ─── ページプール ─────────────────────────────────────────────────────────────
// 固定数のPuppeteerページを共有し、同時レンダリング数を一定に保つ
function createPagePool(pages) {
  const pool    = [...pages];
  const waiters = [];
  return {
    async acquire() {
      if (pool.length > 0) return pool.pop();
      return new Promise(resolve => waiters.push(resolve));
    },
    release(page) {
      if (waiters.length > 0) waiters.shift()(page);
      else pool.push(page);
    },
  };
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
  const posts = allPosts;
  console.log(`📄 ${posts.length}件を処理します（全${allPosts.length}件中）\n`);

  const POOL_SIZE   = 3;    // 同時レンダリング数（RAM 8GB考慮）
  const STAGGER_MS  = 3000; // 投稿スタートをずらしてCPUスパイクを平滑化

  const browser = await puppeteer.launch({
    headless: "shell",
    protocolTimeout: 300000,
    args: [
      // ── 基本サンドボックス解除 ──
      "--no-sandbox",
      "--disable-setuid-sandbox",
      // ── メモリ最適化 ──
      "--disable-dev-shm-usage",       // /dev/shm をメインメモリで代替
      "--no-zygote",                   // zygate プロセスを省略
      "--single-process",              // VPS 向け: 全処理を1プロセスに集約
      "--renderer-process-limit=1",    // レンダラープロセス数上限
      "--memory-pressure-off",         // メモリ圧力通知を無視
      // ── GPU / レンダリング機能削減 ──
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-accelerated-2d-canvas",
      "--disable-accelerated-video-decode",
      "--disable-features=VizDisplayCompositor,TranslateUI",
      "--disable-canvas-aa",           // アンチエイリアス無効（動画用に不要）
      "--disable-2d-canvas-clip-aa",
      // ── バックグラウンドスロットリング無効 ──
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-ipc-flooding-protection",
      // ── 不要機能の無効化 ──
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--mute-audio",
      "--hide-scrollbars",
      "--no-first-run",
      // ── ビューポートをHTML設計値に合わせる（1920×1080横型固定） ──
      `--window-size=${W},${H}`,
    ],
  });

  // 固定サイズのページプールを作成
  const poolPages = await Promise.all(
    Array.from({ length: POOL_SIZE }, () =>
      browser.newPage().then(p => {
        p.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
        p.setDefaultTimeout(0);
        return p;
      })
    )
  );
  const pagePool = createPagePool(poolPages);

  // 全投稿を並列スタート（Staggered: STAGGER_MS ずつずらして CPU スパイクを分散）
  await Promise.all(
    posts.map(async (post, postArrayIdx) => {
      if (postArrayIdx > 0)
        await new Promise(r => setTimeout(r, postArrayIdx * STAGGER_MS));

      const _t0 = Date.now();
      console.log(`\n▶ [${postArrayIdx + 1}/${posts.length}] 動画${post.num}「${post.catchLine1}」`);

      const slideDir = path.join(SLIDES_DIR, `${today}_${post.num}`);
      if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

      // ── ナレーションテキスト ──────────────────────────────────────────────
      const narrTexts = [
        addTitlePunctuation(post.catchLine1),  // S1 タイトルコール（句読点で自然な間を追加）
        post.overviewNarration,
        post.slide3?.narration,
        post.slide4?.narration,
        post.outroTelop || post.outroNarration,
      ];
      const PHASE_OFFSETS = [0, 3000, 1000, 1000, 4000];

      // ── ① ナレーション/コメント音声の先行生成 ─────────────────────────────
      const narrPaths = [];
      for (let i = 0; i < narrTexts.length; i++) {
        if (!narrTexts[i]?.trim()) { narrPaths.push(null); continue; }
        const p = path.join(slideDir, `narr_${i}.wav`);
        try { await generateNarration(narrTexts[i], p); narrPaths.push(p); }
        catch (err) { console.warn(`  ⚠️ S${i + 1} TBN/STN失敗: ${err.message}`); narrPaths.push(null); }
      }

      const cmtDursBySlide = { slide3: [], slide4: [] };
      let cmtGlobalIdx = 0;
      for (const [si, slideKey] of [[2, "slide3"], [3, "slide4"]]) {
        const slideData = post[slideKey];
        if (!slideData?.comments?.length) continue;
        const cmtKey = si === 2 ? "2" : "3";
        for (let ci = 0; ci < slideData.comments.length; ci++) {
          const p = path.join(slideDir, `cmt_${cmtKey}_${ci}.wav`);
          const text = (slideData.comments[ci].text || "").replace(/\n/g, "　").trim();
          if (!text) { cmtDursBySlide[slideKey].push(0); cmtGlobalIdx++; continue; }
          if (!fs.existsSync(p)) {
            const speaker = VV_CMT_SPEAKERS[cmtGlobalIdx % VV_CMT_SPEAKERS.length];
            try { await narrationVoiceVox(text, p, speaker); }
            catch (e) { console.warn(`  ⚠️ CBN失敗 [cmt_${cmtKey}_${ci}]: ${e.message}`); }
          }
          cmtDursBySlide[slideKey].push(fs.existsSync(p) ? getAudioDuration(p) : 0);
          cmtGlobalIdx++;
        }
      }

      // ── ② スライド尺計算（相棒の設計図：実測ベース） ──────────────────────
      const narrDurs = narrPaths.map(p => p ? getAudioDuration(p) : 0);
      const durMs = [
        Math.round((W_S1_START + narrDurs[0] + W_S1_END) * 1000),
        Math.round((W_S2_START + narrDurs[1] + W_S2_END) * 1000),
        calcCommentSlideDurMs(post.slide3, narrDurs[2] * 1000, cmtDursBySlide.slide3),
        calcCommentSlideDurMs(post.slide4, narrDurs[3] * 1000, cmtDursBySlide.slide4),
        Math.round((W_S5_WAIT + narrDurs[4] + W_S5_END) * 1000),
      ];

      // ── ③ HTML 生成 ──────────────────────────────────────────────────────
      const htmlArr = [
        buildS1(post),
        buildS2(post, narrDurs[1]),
        buildCommentSlide(post, "slide3", narrDurs[2], cmtDursBySlide.slide3),
        buildCommentSlide(post, "slide4", narrDurs[3], cmtDursBySlide.slide4),
        buildS5(post),
      ];

      const totalMs = durMs.reduce((a, b) => a + b, 0);
      console.log(`  ⏱️  [動画${post.num}] ${durMs.map((d, i) => `S${i + 1}:${(d/1000).toFixed(1)}s`).join(" | ")} → 計${(totalMs/1000).toFixed(1)}s`);

      // ── ④ スライド動画生成 ───────────────────────────────────────────────
      const videoPaths = await Promise.all(
        htmlArr.map(async (html, i) => {
          const vPath = path.join(slideDir, `slide_${i + 1}.mp4`);
          const pg = await pagePool.acquire();
          try { await renderVideo(pg, html, durMs[i], vPath); }
          finally { pagePool.release(pg); }
          return vPath;
        })
      );

      // ── ⑤ 音声トラック合成（相棒の設計図どおりに配置） ────────────────────
      const extraAudios = [];
      const PHASE_STARTS = [0];
      for (let i = 0; i < durMs.length - 1; i++) PHASE_STARTS.push(PHASE_STARTS[i] + durMs[i]);

      const narrStartOffsets = [W_S1_START, W_S2_START, W_S3_START, W_S3_START, W_S5_WAIT];
      narrPaths.forEach((p, i) => {
        if (!p) return;
        extraAudios.push({ path: p, startMs: Math.round(PHASE_STARTS[i] + narrStartOffsets[i] * 1000) });
      });

      for (const [si, slideKey] of [[2, "slide3"], [3, "slide4"]]) {
        const slideData = post[slideKey];
        if (!slideData?.comments?.length) continue;
        const { delays } = calcCommentTiming(slideData, narrDurs[si], cmtDursBySlide[slideKey]);
        const cmtKey = si === 2 ? "2" : "3";
        for (let ci = 0; ci < delays.length; ci++) {
          const p = path.join(slideDir, `cmt_${cmtKey}_${ci}.wav`);
          if (fs.existsSync(p)) {
            extraAudios.push({ path: p, startMs: Math.round(PHASE_STARTS[si] + delays[ci] * 1000) });
          }
        }
      }

      const audioPath = path.join(slideDir, "audio.wav");
      generateAudioTrack(durMs, [null,null,null,null,null], [0,0,0,0,0], audioPath, extraAudios);

      // ── ⑥ 最終動画出力 ───────────────────────────────────────────────────
      const outPath = path.join(VIDEO_DIR, `${today}_${post.num}.mp4`);
      concatAndMix(videoPaths, audioPath, totalMs, outPath);

      // 生成済みフラグを JSON に書き込む
      updateGeneratedStatus(postArrayIdx);

      const elapsed = ((Date.now() - _t0) / 1000).toFixed(1);
      console.log(`  ✅ [動画${post.num}] 完成: ${outPath}  (処理時間: ${elapsed}s)`);
    })
  );

  await browser.close();
  console.log(`\n🎉 全動画生成完了！`);
}

// ─── 生成ステータス更新 ────────────────────────────────────────────────────────
function updateGeneratedStatus(originalIndex) {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${today}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data.posts && data.posts[originalIndex]) {
      data.posts[originalIndex].isGenerated = true;
      data.posts[originalIndex].generatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    }
  } catch (e) {
    console.warn(`  ⚠️ JSON更新失敗: ${e.message}`);
  }
}

main().catch(err => {
  console.error(`\n❌ エラー: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
