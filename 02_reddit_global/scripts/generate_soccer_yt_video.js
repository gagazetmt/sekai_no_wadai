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
function buildS2(post) {
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
  const S2_START = 1.0;
  let _t = S2_START;
  const subHtml = subParts.map((p, i) => {
    const start = _t.toFixed(1);
    const dur = Math.max(1.5, p.replace(/\s/g, "").length / 8.0);
    _t += dur;
    const isLast = i === subParts.length - 1;
    const fadeOut = isLast ? "" : `,fadeOut 0.3s ${(_t - 0.3).toFixed(1)}s ease-out forwards`;
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
  .sub-box{position:absolute;bottom:0;left:0;right:0;background:rgba(10,16,32,0.97);border-top:2px solid rgba(245,158,11,0.5);min-height:${subH}px;animation:slideUp 0.4s 1.0s ease-out both;}
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

// ─── S3/S4: コメントスライド ──────────────────────────────────────────────────
// narrDurSec: 実際のナレーション秒数（省略時は文字数から推定）
function buildCommentSlide(post, slideKey, narrDurSec = null) {
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
  const CMT_AFTER_NARR = 2.0;
  const CMT_GAP        = 0.8;

  const FONT_SIZE      = 49;
  const LINE_H_PX      = Math.round(FONT_SIZE * 1.4);
  const CARD_PAD_V     = 20;
  const GAP            = 20;
  const AREA_TOP_PX    = SAFE + 60;
  const AREA_BOTTOM_PX = 110;
  const AVAILABLE_H    = H - AREA_TOP_PX - AREA_BOTTOM_PX;
  const CHARS_PER_LINE = Math.floor((W - 2 * SAFE - 2 * 18) / FONT_SIZE);

  function estimateLines(text) {
    return (text || "").split("\\n").reduce(
      (sum, seg) => sum + Math.max(1, Math.ceil(seg.length / CHARS_PER_LINE)), 0
    );
  }
  function cardH(text) { return CARD_PAD_V + estimateLines(text) * LINE_H_PX; }

  const allComments = (slide.comments || []).slice(0, 7);
  let count = Math.min(allComments.length, 7);
  while (count > 4) {
    const sel    = allComments.slice(0, count);
    const totalH = sel.reduce((s, c) => s + cardH(typeof c === "string" ? c : (c.text || "")), 0)
                 + (count - 1) * GAP;
    if (totalH <= AVAILABLE_H) break;
    count--;
  }
  const comments = allComments.slice(0, count);

  const narrText   = slide.narration || slide.subtitleBox || "";
  const narrEstSec = narrDurSec !== null
    ? narrDurSec
    : (slide.noNarration ? 0 : Math.max(1.2, narrText.replace(/\s/g, "").length / 8.0));
  let _ct = narrEstSec + CMT_AFTER_NARR;
  const commentDelays = comments.map(c => {
    const start = _ct;
    const txt = typeof c === "string" ? c : (c.text || "");
    _ct += Math.max(1.2, txt.replace(/\s/g, "").length / 8.0) + CMT_GAP;
    return start;
  });

  const CMT_BG    = ["#FFF9C4","#C8EEFF","#D4F5D4","#EDD5FF","#FFE8CC","#FFD5EA"];
  const CMT_BG_HL = ["#FFD700","#5BB8F5","#5ED45E","#B86FFF","#FF9F43","#FF70A6"];

  const commentsHtml = comments.map((c, i) => {
    const text = typeof c === "string" ? c : (c.text || "");
    const isHL = i === highlightIdx;
    const side = i % 2 === 0 ? "flex-start" : "flex-end";
    const bg   = isHL ? CMT_BG_HL[i % CMT_BG_HL.length] : CMT_BG[i % CMT_BG.length];
    return `<div class="c-card${isHL ? " c-hl" : ""}" style="align-self:${side};background:${bg};animation:slideDown 0.45s ${commentDelays[i]}s ease-out both;">
      <div class="c-text">${esc(text).replace(/\\n/g, "<br>")}</div>
    </div>`;
  }).join("");

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
  .sub-box{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.88);border-top:1px solid rgba(255,255,255,0.08);padding:18px ${SAFE}px;animation:slideUp 0.6s 0s ease-out both, subFadeOut 0.3s ${(narrEstSec + CMT_AFTER_NARR).toFixed(1)}s ease-out forwards;}
  .sub-text{color:#fff;font-size:48px;font-weight:800;text-align:center;line-height:1.5;}
  .citation{position:absolute;bottom:14px;left:${SAFE}px;color:rgba(255,255,255,0.28);font-size:20px;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    ${topicTag ? `<div class="topic-tag">${esc(topicTag)}</div>` : ""}
    <div class="comments-area">${commentsHtml}</div>
    ${(!slide.noNarration && narrText) ? `<div class="sub-box"><div class="sub-text">${esc(narrText)}</div></div>` : ""}
    <div class="citation">©Fotmobより引用</div>
  </div></body></html>`;
}

// S3/S4の期待スライド尺を計算（ms）
function calcCommentSlideDurMs(narrDurMs, slide) {
  const CMT_AFTER_NARR = 2.0;
  const CMT_GAP        = 0.8;
  const PADDING        = 1500;
  const comments = (slide.comments || []).slice(0, 4);
  let t = (narrDurMs / 1000) + CMT_AFTER_NARR;
  for (const c of comments) {
    const txt = typeof c === "string" ? c : (c.text || "");
    t += Math.max(1.2, txt.replace(/\s/g, "").length / 8.0) + CMT_GAP;
  }
  return Math.round(t * 1000) + PADDING;
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
  .outro-wrap{position:absolute;top:50%;left:${SAFE}px;right:${SAFE}px;transform:translateY(-50%);text-align:center;animation:scaleIn 0.6s 4.0s ease-out both;}
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

  // bg-img アニメーション尺をスライド全体に合わせて上書き（kbZoom / panDown 両対応）
  const injectStyle = `<style id="yt-inject">.bg-img{animation-duration:${duration}s !important;}</style>`;
  const html = slideHtml.replace("</head>", `${injectStyle}</head>`);

  await page.setContent(html, { waitUntil: "load", timeout: 120000 });

  const frameDir = outputPath.replace(/\.mp4$/, "_frames");
  if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });

  for (let f = 0; f < totalFrames; f++) {
    const tMs = Math.round((f / FPS) * 1000);
    // Web Animations API で全アニメーションを一括制御
    // currentTime はアニメーション固有のタイムライン（delay 込み）なので
    // CSS animation-delay が自動的に考慮される
    await page.evaluate((tMs) => {
      document.getAnimations().forEach(anim => {
        anim.pause();
        try { anim.currentTime = tMs; } catch (_) {}
      });
    }, tMs);

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

  const SLIDE_COUNT = 5;

  const browser = await puppeteer.launch({
    headless: true,
    args: process.platform !== "win32" ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  // スライド数分のページを事前作成（並列レンダリング用）
  const pages = await Promise.all(
    Array.from({ length: SLIDE_COUNT }, () =>
      browser.newPage().then(p => { p.setViewport({ width: W, height: H }); return p; })
    )
  );

  for (let postArrayIdx = 0; postArrayIdx < posts.length; postArrayIdx++) {
    const post = posts[postArrayIdx];
    const _t0 = Date.now();
    console.log(`\n▶ 動画${post.num}「${post.catchLine1}」`);

    const slideDir = path.join(SLIDES_DIR, `${today}_${post.num}`);
    if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

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

    // ── ① ナレーション生成（並列） ─────────────────────────────────────────
    console.log(`  🎙️  ナレーション生成中（並列）...`);
    const narrResults = await Promise.all(
      narrTexts.map(async (text, i) => {
        if (!text?.trim()) return null;
        const p = path.join(slideDir, `narr_${i}.wav`);
        try {
          await generateNarration(text, p);
          return p;
        } catch (err) {
          console.warn(`  ⚠️ S${i + 1} ナレーション失敗: ${err.message}`);
          return null;
        }
      })
    );
    const narrPaths  = narrResults;
    const failCount  = narrPaths.filter(p => p === null).length;
    if (failCount === 0) console.log(`  ✅ ナレーション5件完了`);
    else console.warn(`  ⚠️ ${failCount}件失敗 → BGMのみで続行`);

    // ── ② スライド尺計算 ───────────────────────────────────────────────────
    const MIN_NO_NARR = [5000, 7000, 5000, 5000, 6500];
    const MAX_MS      = [15000, 40000, 90000, 90000, 25000];
    const PADDING_MS  = 700;

    const narrDurMs = narrPaths.map(p => p ? getAudioDuration(p) : 0);

    const durMs = narrDurMs.map((nd, i) => {
      if (i === 2 || i === 3) {
        const slideData = i === 2 ? post.slide3 : post.slide4;
        if (nd > 0) return Math.min(calcCommentSlideDurMs(nd, slideData), MAX_MS[i]);
        return MIN_NO_NARR[i];
      }
      const narrDur = nd > 0 ? nd + PADDING_MS : 0;
      const total   = PHASE_OFFSETS[i] + (narrDur > 0 ? narrDur : MIN_NO_NARR[i]);
      return Math.min(total, MAX_MS[i]);
    });

    // ── ③ HTML 生成 ────────────────────────────────────────────────────────
    const htmlArr = [
      buildS1(post),
      buildS2(post),
      buildCommentSlide(post, "slide3", narrDurMs[2] > 0 ? narrDurMs[2] / 1000 : null),
      buildCommentSlide(post, "slide4", narrDurMs[3] > 0 ? narrDurMs[3] / 1000 : null),
      buildS5(post),
    ];

    const totalMs = durMs.reduce((a, b) => a + b, 0);
    console.log(`  ⏱️  尺: ${durMs.map((d, i) => `S${i + 1}:${(d/1000).toFixed(1)}s`).join(" | ")} → 計${(totalMs/1000).toFixed(1)}s`);

    // ── ④ スライド動画生成（並列） ─────────────────────────────────────────
    console.log(`  🎬 S1〜S5 並列レンダリング中...`);
    const videoPaths = await Promise.all(
      htmlArr.map(async (html, i) => {
        const vPath = path.join(slideDir, `slide_${i + 1}.mp4`);
        await renderVideo(pages[i], html, durMs[i], vPath);
        return vPath;
      })
    );

    // ── ⑤ 音声トラック合成 ─────────────────────────────────────────────────
    console.log(`  🔊 音声ミックス中...`);
    const audioPath = path.join(slideDir, "audio.wav");
    generateAudioTrack(durMs, narrPaths, PHASE_OFFSETS, audioPath);

    // ── ⑥ 最終動画出力 ─────────────────────────────────────────────────────
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
