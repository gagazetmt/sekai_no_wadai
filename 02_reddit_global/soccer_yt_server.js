// soccer_yt_server.js
// サッカー YouTube 横型動画 制作ランチャー（port 3003）
//
// 起動: node soccer_yt_server.js  または  start_soccer_yt.bat
// UI  : http://localhost:3003
//
// 機能:
//   STEP1  基本情報・画像パスを編集 → S1サムネプレビュー
//   STEP2  試合結果カードを編集 → S2プレビュー
//   STEP3  コメントスライド (S3/S4) を編集
//   STEP4  アウトロ (S5) を編集
//   🎙     音声生成（OpenAI TTS）
//   🎬     ローカル動画生成（generate_soccer_yt_video.js 実行）

require("dotenv").config();
const express    = require("express");
const fs         = require("fs");
const path       = require("path");
const { spawn, execSync } = require("child_process");
const FFMPEG = process.platform === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : "ffmpeg";
const puppeteer  = require("puppeteer");
const { google }  = require("googleapis");

const app  = express();
const PORT = 3003;

// ─── YouTube OAuth2 ────────────────────────────────────────────────────────
const YT_TOKEN_PATH = path.join(__dirname, ".youtube_tokens.json");
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  process.env.YOUTUBE_REDIRECT_URI || `http://localhost:${PORT}/auth/youtube/callback`
);
if (fs.existsSync(YT_TOKEN_PATH)) {
  oauth2Client.setCredentials(JSON.parse(fs.readFileSync(YT_TOKEN_PATH, "utf8")));
  console.log("[YouTube] 保存済みトークン読み込み完了");
}
oauth2Client.on("tokens", tokens => {
  const merged = fs.existsSync(YT_TOKEN_PATH)
    ? { ...JSON.parse(fs.readFileSync(YT_TOKEN_PATH, "utf8")), ...tokens }
    : tokens;
  fs.writeFileSync(YT_TOKEN_PATH, JSON.stringify(merged, null, 2));
  console.log("[YouTube] トークン更新・保存完了");
});

const TEMP_DIR       = path.join(__dirname, "temp");
const IMG_DIR        = path.join(__dirname, "images");
const SLIDES_DIR     = path.join(__dirname, "soccer_yt_slides");
const LOGOS_DIR      = path.join(__dirname, "logos");
const LOG_FILE       = path.join(__dirname, "soccer_yt.log");
const THUMB_DIR      = path.join(__dirname, "soccer_yt_thumbnails");
const MC_DIR         = path.join(__dirname, "match_center");
const STOCK_DIR      = path.join(__dirname, "stock");
const VIDEO_DIR      = path.join(__dirname, "soccer_yt_videos");
const W = 1920, H = 1080, SAFE = 60;

if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
if (!fs.existsSync(MC_DIR))    fs.mkdirSync(MC_DIR,    { recursive: true });

app.use(express.json({ limit: "10mb" }));
app.use("/narrations",    express.static(SLIDES_DIR));
app.use("/images",        express.static(IMG_DIR));
app.use("/match-center-images", express.static(MC_DIR));
app.use("/stock",         express.static(STOCK_DIR));
app.use("/video-files",   express.static(VIDEO_DIR));

// ─── ストック素材マップ ───────────────────────────────────────────────────────
// ストック画像: searchText にフォルダ名が含まれるフォルダから取得
// 構造: stock/keyword/<name>/ , stock/team/<name>/ , stock/player/<name>/ , stock/manager/<name>/ , stock/other/
// 優先順: keyword（完全一致優先） > team/player/manager > other
function getStockImages(searchText = "", maxCount = 5) {
  const IMG_EXTS   = [".jpg", ".jpeg", ".png", ".webp"];
  const CATS       = ["team", "player", "manager"];
  const normalized = searchText.toLowerCase().replace(/[-_]/g, " ");

  const results = [];
  let matched   = false;

  function addFromDir(cat, sub) {
    const dir   = path.join(STOCK_DIR, cat, sub);
    const files = fs.readdirSync(dir)
      .filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase())).sort();
    for (const f of files) {
      if (results.length >= maxCount) break;
      results.push({ url: `/stock/${cat}/${sub}/${f}`, localPath: path.join(dir, f), isStock: true });
    }
  }

  // ① keyword/ フォルダを最優先（searchText にフォルダ名が含まれるもの）
  const kwDir = path.join(STOCK_DIR, "keyword");
  if (fs.existsSync(kwDir)) {
    const kwSubs = fs.readdirSync(kwDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name)
      .sort((a, b) => b.length - a.length); // 長い（より具体的な）キーワード優先
    for (const sub of kwSubs) {
      if (results.length >= maxCount) break;
      const kw = sub.toLowerCase().replace(/[-_]/g, " ");
      if (!normalized.includes(kw)) continue;
      matched = true;
      addFromDir("keyword", sub);
    }
  }

  // ② team / player / manager
  for (const cat of CATS) {
    if (results.length >= maxCount) break;
    const catDir = path.join(STOCK_DIR, cat);
    if (!fs.existsSync(catDir)) continue;
    const subDirs = fs.readdirSync(catDir, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    for (const sub of subDirs) {
      if (results.length >= maxCount) break;
      const kw = sub.toLowerCase().replace(/[-_]/g, " ");
      if (!normalized.includes(kw)) continue;
      matched = true;
      addFromDir(cat, sub);
    }
  }

  // ③ マッチなし → other/ から補完
  if (!matched) {
    const otherDir = path.join(STOCK_DIR, "other");
    if (fs.existsSync(otherDir)) {
      const files = fs.readdirSync(otherDir)
        .filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase())).sort();
      for (const f of files) {
        if (results.length >= maxCount) break;
        results.push({ url: `/stock/other/${f}`, localPath: path.join(otherDir, f), isStock: true });
      }
    }
  }
  return results;
}

// ─── チームロゴマップ ─────────────────────────────────────────────────────────
const TEAM_LOGOS = (() => {
  const file = path.join(LOGOS_DIR, "team_logos.json");
  if (!fs.existsSync(file)) return {};
  const { _comment, ...logos } = JSON.parse(fs.readFileSync(file, "utf8"));
  return logos;
})();

// ─── ジョブ管理 ───────────────────────────────────────────────────────────────
let ttsJob      = { running: false, results: [], done: false, error: null };
let videoJob    = { running: false, log: [], done: false, exitCode: null };
let imgFetchJob = { running: false, log: [], done: false, exitCode: null, date: null };

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function imgBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { b64: null, mime: null };
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return { b64: fs.readFileSync(imgPath).toString("base64"), mime };
}
function getImageSize(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return null;
  try {
    const buf = fs.readFileSync(imgPath);
    const ext = path.extname(imgPath).toLowerCase();
    if (ext === '.png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
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

function logoHtml(teamName, size = 120) {
  const file = TEAM_LOGOS[teamName];
  if (file) {
    const logoPath = path.join(LOGOS_DIR, file);
    if (fs.existsSync(logoPath)) {
      const { b64, mime } = imgBase64(logoPath);
      if (b64) return `<img src="data:${mime};base64,${b64}" style="width:${size}px;height:${size}px;object-fit:contain;">`;
    }
  }
  const initials = (teamName || "?").replace(/[^A-Za-z ]/g, "").trim().split(" ")
    .map(w => w[0]).join("").toUpperCase().slice(0, 3) || "???";
  const hue = [...(teamName || "")].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,hsl(${hue},60%,35%),hsl(${hue},60%,20%));border:3px solid rgba(255,255,255,0.2);color:#fff;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.27)}px;font-weight:900;flex-shrink:0;">${initials}</div>`;
}

const esc    = s => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const escRed = s => esc(s).replace(/\[r\](.*?)\[\/r\]/g, '<span style="color:#c00000">$1</span>');
const escLine = s => escRed(String(s||"").replace(/\\n/g,"\n")).replace(/\n/g,"<br>");

function splitSubText(text) {
  const parts = [];
  let current = "";
  let w = 0;
  for (const c of (text || "")) {
    current += c;
    w += /[\u3040-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(c) ? 2 : 1;
    if ((c === "、" || c === "。") && w >= 40) {
      parts.push(current.trim());
      current = "";
      w = 0;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.length >= 2 ? parts : [text || ""];
}

function getLabel(post) {
  if (post.label) return post.label;
  const t = post.catchLine1 || "";
  if (/悲報|敗退|負け|崩壊/.test(t)) return "【悲報】";
  if (/朗報|勝利|優勝|快挙/.test(t)) return "【朗報】";
  return "【速報】";
}

const COMMON_CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  body{width:${W}px;height:${H}px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif;}
  .bg{width:${W}px;height:${H}px;position:relative;overflow:hidden;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes slideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
  @keyframes scaleIn{from{opacity:0;transform:scale(0.88)}to{opacity:1;transform:scale(1)}}
  @keyframes kbZoom{from{transform:scale(1.0)}to{transform:scale(1.1)}}
`;

// ─── HTML ビルダー（generate_soccer_yt_video.js と同等） ─────────────────────
function getImgZoom(post, key) {
  return (post.imgZoom && post.imgZoom[key]) || { zoom: 1.0, x: 50, y: 50 };
}

function buildS1(post) {
  const { b64, mime, isPortrait } = imgMeta(post.mainImagePath);
  const iz = getImgZoom(post, 's1');
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
      : '';
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

function buildS2(post) {
  const author = post.sourceAuthor || "情報筋";
  const { b64, mime, isPortrait } = imgMeta(post.slide2ImagePath || post.mainImagePath);
  const iz = getImgZoom(post, 's2');
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
      : '';
  const bgImgCss = isPortrait
    ? `position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;`
    : `position:absolute;inset:0;${bgStyle}animation:kbZoom 10s linear forwards;transform-origin:${bgPos};`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  ${kbExtra}
  .bg-img{${bgImgCss}}
  .overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.85) 0%,rgba(0,0,0,0.40) 35%,rgba(0,0,0,0.05) 65%,rgba(0,0,0,0) 100%);}
  @keyframes cardIn{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}
  .source-card{position:absolute;top:${SAFE}px;right:${SAFE}px;background:rgba(0,0,0,0.78);border:1px solid rgba(255,255,255,0.14);border-radius:14px;padding:18px 24px;animation:cardIn 0.45s 0.2s ease-out both;}
  .tweet-header{display:flex;align-items:center;gap:12px;}
  .tweet-author{color:#fff;font-size:18px;font-weight:900;display:flex;align-items:center;gap:8px;}
  .tweet-check{color:#1DA1F2;font-size:14px;}
  .tweet-handle{color:rgba(255,255,255,0.40);font-size:13px;margin-top:2px;}
  .sub-box{position:absolute;bottom:0;left:0;right:0;background:rgba(10,16,32,0.97);border-top:2px solid rgba(245,158,11,0.5);min-height:${Math.round((Math.round(53*1.55)+44)*1.21)}px;animation:slideUp 0.4s 1.0s ease-out both;}
  .sub-part{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:22px ${SAFE+20}px;color:#fff;font-size:53px;font-weight:800;text-align:center;line-height:1.55;overflow-wrap:break-word;opacity:0;}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes fadeOut{to{opacity:0}}
  .account{position:absolute;bottom:${SAFE-10}px;left:${SAFE}px;color:rgba(255,255,255,0.22);font-size:20px;animation:fadeUp 0.3s 1.5s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="source-card">
      <div class="tweet-header">
        <div>
          <div class="tweet-author">${esc(author)}<span class="tweet-check">✓</span></div>
          <div class="tweet-handle">@${esc(author.toLowerCase().replace(/\s+/g,""))}</div>
        </div>
      </div>
    </div>
    <div class="sub-box">${(() => {
      const subParts = splitSubText(post.overviewNarration || post.overviewTelop || "");
      const S2_START = 1.0;
      let _t = S2_START;
      return subParts.map((p, i) => {
        const start = _t.toFixed(1);
        const dur = Math.max(1.5, p.replace(/\s/g, "").length / 8.0);
        _t += dur;
        const isLast = i === subParts.length - 1;
        const fadeOut = isLast ? "" : `,fadeOut 0.3s ${(_t - 0.3).toFixed(1)}s ease-out forwards`;
        return `<div class="sub-part" style="animation:fadeIn 0.3s ${start}s ease-out both${fadeOut}">${esc(p)}</div>`;
      }).join("");
    })()}</div>
    <div class="account">@sekai_no_wadai</div>
  </div></body></html>`;
}

function buildCommentSlide(post, slideKey) {
  const slide    = post[slideKey] || {};
  const imgKey   = slideKey === "slide3" ? "slide3ImagePath" : "slide4ImagePath";
  const { b64, mime, isPortrait } = imgMeta(post[imgKey]);
  const iz = getImgZoom(post, slideKey === "slide3" ? "s3" : "s4");
  const bgPos = `${iz.x}% ${iz.y}%`;
  const bgStyle  = b64
    ? isPortrait
      ? `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`
      : `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${bgPos};`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;
  const kbExtra = isPortrait
    ? `@keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}`
    : iz.zoom !== 1.0
      ? `@keyframes kbZoom{from{transform:scale(${iz.zoom}) translate(-2%,0)}to{transform:scale(${(iz.zoom+0.12).toFixed(2)}) translate(2%,0)}}`
      : '';
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
  function cardH(text) {
    return CARD_PAD_V + estimateLines(text) * LINE_H_PX;
  }

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
  const narrEstSec = slide.noNarration ? 0 : Math.max(1.2, narrText.replace(/\s/g, "").length / 8.0);
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
  @keyframes slideDown{from{opacity:0;transform:translateY(-30px)}to{opacity:1;transform:translateY(0)}}
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
    ${(!slide.noNarration && (slide.narration||slide.subtitleBox)) ? `<div class="sub-box"><div class="sub-text">${esc(slide.narration||slide.subtitleBox||"")}</div></div>` : ""}
    <div class="citation">©Fotmobより引用</div>
  </div></body></html>`;
}

function buildS5(post) {
  const { b64, mime, isPortrait } = imgMeta(post.slide5ImagePath || post.mainImagePath);
  const iz = getImgZoom(post, 's5');
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
      : '';
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

// ─── サムネイル HTML (1280×720) ───────────────────────────────────────────────
function buildThumbnailHtml(post) {
  const TW = 1280, TH = 720, SAFE = 40;
  const { b64, mime } = imgBase64(post.mainImagePath);
  const iz = getImgZoom(post, 'tn');
  const bgPos = `${iz.x}% ${iz.y}%`;
  const bgStyle = b64
    ? `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${iz.x}% ${iz.y}%;background-repeat:no-repeat;background-color:#111;`
    : `background:linear-gradient(135deg,#1a1a3e,#2d2d60);`;
  const zoomStyle = `transform:scale(${iz.zoom});transform-origin:${iz.x}% ${iz.y}%;`;
  const label = getLabel(post);
  const badge = post.badge || "";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{width:${TW}px;height:${TH}px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif;}
  .bg{width:${TW}px;height:${TH}px;position:relative;overflow:hidden;}
  .bg-img{position:absolute;inset:0;${bgStyle}${zoomStyle}}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.12);}
  .title-area{position:absolute;bottom:${SAFE}px;left:0;right:0;display:flex;flex-direction:column;align-items:flex-start;gap:12px;}
  .badges{display:flex;flex-direction:row;gap:60px;align-items:center;padding-left:${SAFE}px;}
  .badge-item{display:inline-block;font-size:36px;font-weight:900;padding:3px 23px;border-radius:8px;letter-spacing:2px;color:#fff;width:fit-content;}
  .badge-primary{background:rgba(200,0,0,0.95);}
  .badge-secondary{background:rgba(180,100,0,0.95);}
  .title-main{color:#1a1a1a;font-size:55px;font-weight:900;line-height:1.3;background:#D4A800;border-radius:0;padding:32px 30px;margin-left:32px;margin-right:32px;width:calc(100% - 64px);overflow-wrap:break-word;word-break:break-all;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="title-area">
      <div class="badges">
        <div class="badge-item badge-primary">${esc(label)}</div>
        ${badge ? `<div class="badge-item badge-secondary">${esc(badge)}</div>` : ""}
      </div>
      <div class="title-main">${escLine(post.catchLine1 || "")}</div>
    </div>
  </div></body></html>`;
}

// ─── プレビュー尺計算ヘルパー ────────────────────────────────────────────────
function estTtsSec(text) {
  return Math.max(1.2, (text || "").replace(/\s/g, "").length / 8.0);
}
function calcLoopMs(post, slideKey) {
  const CMT_OFFSET = 2.0, CMT_GAP = 0.8;
  if (slideKey === "s1") return 7000;
  if (slideKey === "s2") return Math.round((3.0 + estTtsSec(post.overviewTelop || post.overviewNarration) + 1.5) * 1000);
  if (slideKey === "s3" || slideKey === "s4") {
    const slide = post[slideKey === "s3" ? "slide3" : "slide4"];
    const narrSec = slide?.noNarration ? 0 : estTtsSec(slide?.narration || slide?.subtitleBox);
    // buildCommentSlideと同じく最大4件に制限
    const comments = (slide?.comments || []).slice(0, 4).filter(c => (typeof c === "string" ? c : (c.text||"")).trim());
    let t = narrSec + CMT_OFFSET;
    for (const c of comments) { t += estTtsSec(typeof c === "string" ? c : (c.text||"")) + CMT_GAP; }
    return Math.round((t + 1.5) * 1000);
  }
  if (slideKey === "s5") return Math.round((3.0 + estTtsSec(post.outroTelop || post.outroNarration) + 1.5) * 1000);
  return 9000;
}

// ─── プレビューループ注入 ─────────────────────────────────────────────────────
function withLoop(html, ms) {
  const s = `<script>window.addEventListener("load",function(){setTimeout(function(){location.reload()},${ms});});<\/script>`;
  return html.replace("</body>", s + "</body>");
}

// ─── API: コンテンツ読み込み ───────────────────────────────────────────────────
app.get("/api/content/:date", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.json({ posts: [], pendingPosts: [], generatedPosts: [] });
  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  const posts = data.posts || [];
  // 実画像が10枚未満のpostにstock5枚を補完
  for (const post of posts) {
    const realCount = (post.imagePaths || []).length;
    if (realCount < 10) {
      const searchText = [
        post.matchResult?.homeTeam,
        post.matchResult?.awayTeam,
        post.catchLine1,
        post.youtubeTitle,
        post.hashtagsText,
      ].filter(Boolean).join(" ");
      post._stockImages = getStockImages(searchText, 5);
    } else {
      post._stockImages = [];
    }
  }

  // 未生成と生成済みに振り分け
  data.pendingPosts   = posts.filter(p => !p.isGenerated);
  data.generatedPosts = posts.filter(p => p.isGenerated);

  res.json(data);
});

// ─── API: コンテンツ保存 ───────────────────────────────────────────────────────
app.post("/api/content/:date", (req, res) => {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2), "utf8");
  res.json({ ok: true, path: file });
});

// ─── API: S1 プレビュー HTML ───────────────────────────────────────────────────
app.get("/api/preview/s1/:date/:idx", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const post = posts[parseInt(req.params.idx)];
  if (!post) return res.status(404).send("Post not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const h1 = buildS1(post);
  res.send(req.query.loop === "1" ? withLoop(h1, calcLoopMs(post, "s1")) : h1);
});

// ─── API: S2 プレビュー HTML ───────────────────────────────────────────────────
app.get("/api/preview/s2/:date/:idx", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const post = posts[parseInt(req.params.idx)];
  if (!post) return res.status(404).send("Post not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const h2 = buildS2(post);
  res.send(req.query.loop === "1" ? withLoop(h2, calcLoopMs(post, "s2")) : h2);
});

// ─── API: S3/S4 プレビュー HTML ───────────────────────────────────────────────
app.get("/api/preview/s3/:date/:idx", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const post = posts[parseInt(req.params.idx)];
  if (!post) return res.status(404).send("Post not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const h3 = buildCommentSlide(post, "slide3");
  res.send(req.query.loop === "1" ? withLoop(h3, calcLoopMs(post, "s3")) : h3);
});

app.get("/api/preview/s4/:date/:idx", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const post = posts[parseInt(req.params.idx)];
  if (!post) return res.status(404).send("Post not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const h4 = buildCommentSlide(post, "slide4");
  res.send(req.query.loop === "1" ? withLoop(h4, calcLoopMs(post, "s4")) : h4);
});

// ─── API: S5 プレビュー HTML ───────────────────────────────────────────────────
app.get("/api/preview/s5/:date/:idx", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const post = posts[parseInt(req.params.idx)];
  if (!post) return res.status(404).send("Post not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const h5 = buildS5(post);
  res.send(req.query.loop === "1" ? withLoop(h5, calcLoopMs(post, "s5")) : h5);
});

// ─── API: サムネイル プレビュー HTML ───────────────────────────────────────────
app.get("/api/thumbnail/preview/:date/:idx", (req, res) => {
  const file = path.join(TEMP_DIR, `soccer_yt_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.status(404).send("Not found");
  const { posts } = JSON.parse(fs.readFileSync(file, "utf8"));
  const post = posts[parseInt(req.params.idx)];
  if (!post) return res.status(404).send("Post not found");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  const qZoom  = parseFloat(req.query.zoom);
  const qX     = parseFloat(req.query.px);
  const qY     = parseFloat(req.query.py);
  const qImg   = req.query.img;   // "/images/filename.jpg" → IMG_DIR/filename
  const qCatch = req.query.catch; // catchLine1 テキスト上書き
  if (!isNaN(qZoom) || !isNaN(qX) || !isNaN(qY) || qImg || qCatch !== undefined) {
    const cur = (post.imgZoom && post.imgZoom.tn) || { zoom: 1.0, x: 50, y: 50 };
    const overridePost = Object.assign({}, post, {
      mainImagePath: qImg ? path.join(IMG_DIR, path.basename(qImg)) : post.mainImagePath,
      catchLine1:    qCatch !== undefined ? qCatch : post.catchLine1,
      imgZoom: Object.assign({}, post.imgZoom, {
        tn: { zoom: isNaN(qZoom) ? cur.zoom : qZoom, x: isNaN(qX) ? cur.x : qX, y: isNaN(qY) ? cur.y : qY }
      })
    });
    return res.send(buildThumbnailHtml(overridePost));
  }
  res.send(buildThumbnailHtml(post));
});

// ─── API: サムネイル PNG 書き出し ─────────────────────────────────────────────
app.post("/api/thumbnail/export", async (req, res) => {
  const { date, postIdx, post, selectedImgUrl } = req.body;
  if (!date || postIdx === undefined || !post)
    return res.status(400).json({ error: "date / postIdx / post が必要" });
  const num     = postIdx + 1;
  const outPath = path.join(THUMB_DIR, `${date}_${num}_thumb.png`);
  try {
    if (selectedImgUrl) post.mainImagePath = path.join(IMG_DIR, path.basename(selectedImgUrl));
    const html    = buildThumbnailHtml(post);
    const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
    const page    = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.screenshot({ path: outPath, type: "png" });
    await browser.close();
    res.json({ ok: true, path: outPath, filename: path.basename(outPath) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: 画像アップロード ──────────────────────────────────────────────────────
app.post("/api/upload-image", (req, res) => {
  const { dataUrl, filename } = req.body;
  if (!dataUrl || !filename) return res.status(400).json({ error: "dataUrl / filename が必要" });
  const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) return res.status(400).json({ error: "不正な dataUrl" });
  const ext      = match[1].split("/")[1].replace("jpeg", "jpg");
  const safeName = filename.replace(/[^a-zA-Z0-9_\-.]/g, "_").replace(/\.[^.]+$/, "") + "." + ext;
  const outPath  = path.join(IMG_DIR, safeName);
  fs.writeFileSync(outPath, Buffer.from(match[2], "base64"));
  res.json({ ok: true, path: outPath });
});

// ─── API: YouTubeランチャー ギャラリー画像追加 ──────────────────────────────────
app.post("/api/gallery/add-image", express.json({ limit: "30mb" }), (req, res) => {
  const { date, postIdx, filename, data } = req.body;
  if (!date || postIdx === undefined || !data)
    return res.status(400).json({ error: "date / postIdx / data が必要" });
  try {
    const ext      = (filename || "image.jpg").split(".").pop().toLowerCase().replace("jpeg", "jpg");
    const saveName = `${date}_${Number(postIdx) + 1}_custom_${Date.now()}.${ext}`;
    const savePath = path.join(IMG_DIR, saveName);
    if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
    fs.writeFileSync(savePath, Buffer.from(data, "base64"));
    // content JSON の imagePaths にも追記（再読込後も残る）
    const contentFile = path.join(TEMP_DIR, `soccer_yt_content_${date}.json`);
    if (fs.existsSync(contentFile)) {
      const content = JSON.parse(fs.readFileSync(contentFile, "utf8"));
      if (content.posts && content.posts[postIdx]) {
        content.posts[postIdx].imagePaths = content.posts[postIdx].imagePaths || [];
        content.posts[postIdx].imagePaths.push(savePath);
        fs.writeFileSync(contentFile, JSON.stringify(content, null, 2));
      }
    }
    res.json({ ok: true, url: `/images/${saveName}` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ヘルパー: VoiceVox TTS → WAV ───────────────────────────────────────────
const VOICEVOX_URL    = "http://localhost:50021";
const VV_NARR_SPEAKER = 13;   // 青山龍星 ノーマル（S1/S2/S3/S4/S5 ナレーション）
const VV_NARR_SPEED   = 1.2;
const VV_CMT_SPEAKERS = [13, 13, 13, 13, 0];  // コメントバブル: 青山龍星×4 + 四国めたん×1（男80%/女20%）
const VV_CMT_SPEED    = 1.2;

function defaultTtsSettings(key) {
  if (key.startsWith("cmt_")) {
    // cmt_2_0 → index=0, cmt_3_2 → index=2
    const idx = parseInt(key.split("_").pop()) || 0;
    return { speaker: VV_CMT_SPEAKERS[idx % VV_CMT_SPEAKERS.length], speed: VV_CMT_SPEED, intonationScale: 1.0 };
  }
  return { speaker: VV_NARR_SPEAKER, speed: VV_NARR_SPEED, intonationScale: 1.0 };
}

function sanitizeForTts(text) {
  return text
    .replace(/\b(\d{1,2})-(\d{1,2})\b/g, "$1対$2")
    .replace(/\bCL\b/g,   "チャンピオンズリーグ")
    .replace(/\bEL\b/g,   "ヨーロッパリーグ")
    .replace(/\bPL\b/g,   "プレミアリーグ")
    .replace(/\bW杯/g,    "ワールドカップ")
    .replace(/\bDAZN\b/gi,"ダゾーン")
    .replace(/\bPK\b/g,   "ピーケー")
    .replace(/\bVAR\b/g,  "ブイエーアール")
    .replace(/\bOG\b/g,   "オウンゴール")
    .replace(/\bMF\b/g,   "ミッドフィールダー")
    .replace(/\bFW\b/g,   "フォワード")
    .replace(/\bDF\b/g,   "ディフェンダー")
    .replace(/\bGK\b/g,   "ゴールキーパー")
    .replace(/→/g, "から")
    .replace(/%/g,  "パーセント")
    .replace(/&/g,  "アンド")
    .replace(/×/g,  "かける")
    .replace(/今節/g,   "こんせつ")
    .replace(/得点王/g, "とくてんおう")
    .replace(/退場/g,   "たいじょう")
    .replace(/警告/g,   "けいこく");
}

async function voiceVoxTts(text, outPath, opts = {}) {
  const speaker = opts.speaker ?? VV_NARR_SPEAKER;
  const speed   = opts.speed   ?? VV_NARR_SPEED;
  const safe = sanitizeForTts((text || "").replace(/\\n/g, "").replace(/\n/g, "　").trim());
  const qRes = await fetch(
    `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(safe)}&speaker=${speaker}`,
    { method: "POST" }
  );
  if (!qRes.ok) throw new Error(`VoiceVox query: ${qRes.status}`);
  const query = await qRes.json();
  query.speedScale      = speed;
  if (opts.intonationScale != null) query.intonationScale = opts.intonationScale;
  const sRes = await fetch(`${VOICEVOX_URL}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
  });
  if (!sRes.ok) throw new Error(`VoiceVox synthesis: ${sRes.status}`);
  fs.writeFileSync(outPath, Buffer.from(await sRes.arrayBuffer()));
}

// ─── OpenAI TTS（一時停止中）────────────────────────────────────────────────
// const TTS_EMOTION_INSTRUCTIONS = { ... };
// async function openAiTts(text, outPath, opts = {}) { ... }

// シーン定義: scene キー → 生成すべきファイルリストを返す
function getSceneItems(scene, post) {
  const c3 = (post.slide3?.comments || []).slice(0, 7);
  const c4 = (post.slide4?.comments || []).slice(0, 7);
  const map = {
    s1: [{ text: post.catchLine1,                          file: "narr_0.wav", label: "S1 キャッチコピー" }],
    s2: [{ text: post.overviewNarration,                   file: "narr_1.wav", label: "S2 ナレーション"   }],
    s3: [
      { text: post.slide3?.noNarration ? "" : post.slide3?.narration, file: "narr_2.wav", label: "S3 ナレーション"   },
      ...c3.map((c, i) => ({ text: c?.text || "", file: `cmt_2_${i}.wav`, label: `S3 コメント${i + 1}` })),
    ],
    s4: [
      { text: post.slide4?.noNarration ? "" : post.slide4?.narration, file: "narr_3.wav", label: "S4 ナレーション"   },
      ...c4.map((c, i) => ({ text: c?.text || "", file: `cmt_3_${i}.wav`, label: `S4 コメント${i + 1}` })),
    ],
    s5: [{ text: post.outroTelop || post.outroNarration,   file: "narr_4.wav", label: "S5 アウトロ"       }],
  };
  return map[scene] || [];
}

async function generateSceneAudio(items, slideDir, date, num, ttsSettings = {}) {
  const results = [];
  for (const { text, file, label } of items) {
    const t = (text || "").trim();
    if (!t) { results.push({ label, ok: false, error: "テキストなし" }); continue; }
    const outPath = path.join(slideDir, file);
    const fileKey = file.replace(/\.wav$/, "");
    try {
      await voiceVoxTts(t, outPath, ttsSettings[fileKey] || defaultTtsSettings(fileKey));
      const url = `/narrations/${date}_${num}/${file}`;
      results.push({ label, ok: true, url });
    } catch (e) {
      console.error(`[TTS ERROR] ${label}: ${e.message}`);
      results.push({ label, ok: false, error: e.message });
    }
  }
  return results;
}

// ─── API: TTS 生成（全シーン）────────────────────────────────────────────────
app.post("/api/tts", async (req, res) => {
  if (ttsJob.running)
    return res.status(409).json({ error: "TTS 生成中です" });

  const { date, postIdx, post } = req.body;
  if (!date || postIdx === undefined || !post)
    return res.status(400).json({ error: "date / postIdx / post が必要です" });

  ttsJob = { running: true, results: [], done: false, error: null };
  res.json({ ok: true });

  const num      = postIdx + 1;
  const slideDir = path.join(SLIDES_DIR, `${date}_${num}`);
  if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

  const ttsSettings = post.ttsSettings || {};
  for (const scene of ["s1", "s2", "s3", "s4", "s5"]) {
    const items = getSceneItems(scene, post);
    const results = await generateSceneAudio(items, slideDir, date, num, ttsSettings);
    ttsJob.results.push(...results);
  }

  ttsJob.running = false;
  ttsJob.done    = true;
});

app.get("/api/tts-status", (req, res) => res.json(ttsJob));

// ─── API: TTS 生成（シーン単体）──────────────────────────────────────────────
app.post("/api/tts/scene", async (req, res) => {
  const { date, postIdx, post, scene } = req.body;
  if (!date || postIdx === undefined || !post || !scene)
    return res.status(400).json({ error: "date / postIdx / post / scene が必要です" });

  const num      = postIdx + 1;
  const slideDir = path.join(SLIDES_DIR, `${date}_${num}`);
  if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

  const items       = getSceneItems(scene, post);
  const ttsSettings = post.ttsSettings || {};
  const results     = await generateSceneAudio(items, slideDir, date, num, ttsSettings);
  res.json({ ok: true, scene, results });
});

// ─── API: 動画生成実行 ────────────────────────────────────────────────────────
app.post("/api/run-video", (req, res) => {
  if (videoJob.running) return res.json({ ok: false, message: "生成中です" });
  const { date, count, indices } = req.body;
  if (!date) return res.status(400).json({ error: "date が必要です" });

  videoJob = { running: true, log: [], done: false, exitCode: null };
  const args = [path.join(__dirname, "scripts", "generate_soccer_yt_video.js"), date];
  
  if (indices && indices.length > 0) {
    // 特定のインデックス指定（例: "0,2,5"）末尾カンマで件数指定と区別
    args.push(indices.join(",") + ",");
  } else if (count) {
    // 従来の件数指定
    args.push(String(count));
  }

  const proc = spawn(process.execPath, args, { cwd: __dirname, env: process.env });
  proc.stdout.on("data", d => videoJob.log.push(d.toString()));
  proc.stderr.on("data", d => videoJob.log.push(d.toString()));
  proc.on("close", code => {
    videoJob.running  = false;
    videoJob.done     = true;
    videoJob.exitCode = code;
  });
  res.json({ ok: true });
});

app.get("/api/video-status", (req, res) => res.json({
  running:  videoJob.running,
  done:     videoJob.done,
  exitCode: videoJob.exitCode,
  log:      videoJob.log.join(""),
}));

// ─── API: コンテンツ自動生成 ──────────────────────────────────────────────────
app.post("/api/run-generate", (req, res) => {
  const { date } = req.body;
  if (videoJob.running) return res.json({ ok: false, message: "別のジョブが実行中です" });

  videoJob = { running: true, log: [], done: false, exitCode: null };
  const args = [path.join(__dirname, "scripts", "generate_soccer_yt.js")];
  if (date) args.push(date);

  const proc = spawn(process.execPath, args, { cwd: __dirname, env: process.env });
  proc.stdout.on("data", d => videoJob.log.push(d.toString()));
  proc.stderr.on("data", d => videoJob.log.push(d.toString()));
  proc.on("close", code => {
    videoJob.running  = false;
    videoJob.done     = true;
    videoJob.exitCode = code;
    fs.writeFileSync(LOG_FILE, `[自動生成 ${new Date().toLocaleString("ja-JP")}]\n` + videoJob.log.join(""));
  });

  // Match Center 画像も並列生成（バックグラウンド・fire-and-forget）
  if (date) {
    const mcScript = path.join(__dirname, "scripts", "fetch_match_center.js");
    const mcProc   = spawn(process.execPath, [mcScript, date], { cwd: __dirname, env: process.env });
    mcProc.stdout.on("data", d => process.stdout.write("[MC] " + d));
    mcProc.stderr.on("data", d => process.stderr.write("[MC] " + d));
    mcProc.on("close", code => console.log(`[MC] 完了 (exit:${code})`));
  }

  res.json({ ok: true });
});

// ─── UI（3カラム: 投稿リスト | スライドエディタ | ループプレビュー） ──────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>⚽ サッカー YT ランチャー</title>
<style>
:root{--bg:#0d0d0d;--panel:#1a1a1a;--border:#2e2e2e;--accent:#e00;--yellow:#ffd700;--text:#e8e8e8;--sub:#888;--blue:#4a9eff;--green:#3cb371;--orange:#ff9900;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:"Hiragino Kaku Gothic ProN",sans-serif;font-size:13px;overflow:hidden;height:100vh;display:flex;flex-direction:column;}
header{background:var(--panel);border-bottom:1px solid var(--border);padding:8px 14px;display:flex;align-items:center;gap:8px;flex-shrink:0;}
header h1{font-size:14px;font-weight:900;color:var(--yellow);white-space:nowrap;}
input[type=date]{background:#222;border:1px solid var(--border);color:var(--text);padding:4px 8px;border-radius:5px;font-size:12px;}
button{cursor:pointer;border:none;border-radius:5px;padding:6px 11px;font-size:12px;font-weight:700;transition:opacity .15s;}
button:hover{opacity:.8;}button:disabled{opacity:.4;cursor:not-allowed;}
.btn-load{background:#333;color:var(--text);}.btn-save{background:#2a4a2a;color:var(--green);}
.btn-gen{background:#2a1a3a;color:#c084fc;}.btn-tts{background:#1a3a4a;color:#67e8f9;}
.btn-video{background:var(--accent);color:#fff;}.btn-yt{background:#ff0000;color:#fff;font-weight:900;}.ml-auto{margin-left:auto;}
/* 3カラム */
.main{display:grid;grid-template-columns:170px 0.7fr 1.3fr;flex:1;overflow:hidden;}
/* 左: 投稿リスト */
.sidebar{background:var(--panel);border-right:1px solid var(--border);padding:10px;overflow-y:auto;}
.sidebar-title{font-size:10px;color:var(--sub);margin-bottom:8px;letter-spacing:1px;text-transform:uppercase;}
.post-item{display:flex;align-items:center;gap:4px;padding:5px 6px 5px 8px;border-radius:5px;cursor:pointer;font-size:11px;border:1px solid transparent;margin-bottom:3px;line-height:1.4;}
.post-item:hover{background:#222;}.post-item.active{background:#1a1a2e;border-color:var(--blue);color:var(--blue);}
.post-item-label{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.post-del{flex-shrink:0;background:none;border:none;color:#555;font-size:14px;cursor:pointer;padding:0 2px;line-height:1;border-radius:3px;}
.post-del:hover{color:#e05;background:#2a1020;}
/* 中: スライドエディタ */
.editor-col{display:flex;flex-direction:column;overflow:hidden;border-right:1px solid var(--border);}
.slide-tabs{display:flex;border-bottom:2px solid var(--border);flex-shrink:0;background:var(--panel);}
.slide-tab{flex:1;padding:9px 2px;text-align:center;cursor:pointer;font-size:11px;font-weight:700;color:var(--sub);border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .12s,border-color .12s;}
.slide-tab:hover{color:var(--text);}.slide-tab.active{color:var(--yellow);border-bottom-color:var(--yellow);}
.slide-tab .sn{font-size:14px;font-weight:900;display:block;}.slide-tab .sl{font-size:9px;font-weight:400;display:block;margin-top:1px;}
.slide-editor{flex:1;overflow-y:auto;padding:12px 14px;}
/* フィールド */
.sec-lbl{font-size:11px;font-weight:700;color:var(--yellow);margin:0 0 8px;padding-bottom:5px;border-bottom:1px solid var(--border);}
.sec-lbl+.sec-lbl,.sec-lbl+.g-wrap{margin-top:14px;}
.field{margin-bottom:10px;}.field label{display:block;font-size:10px;color:var(--sub);margin-bottom:3px;}
.field input,.field textarea,.field select{width:100%;background:#111;border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:5px;font-size:12px;font-family:inherit;}
.field textarea{resize:vertical;min-height:52px;line-height:1.5;}
.field input:focus,.field textarea:focus{outline:none;border-color:var(--blue);}
.frow{display:flex;gap:8px;margin-bottom:10px;}.frow .field{flex:1;margin-bottom:0;}
/* 画像ギャラリー */
.g-wrap{margin-bottom:10px;}
.gallery{display:flex;flex-wrap:wrap;gap:5px;}
.g-thumb{border-radius:4px;overflow:hidden;border:2px solid var(--border);cursor:pointer;transition:border-color .12s;flex-shrink:0;position:relative;}
.g-thumb:hover{border-color:#555;}.g-thumb.sel{border-color:var(--yellow);box-shadow:0 0 6px rgba(255,215,0,0.45);}
.g-thumb img{width:108px;height:61px;object-fit:contain;background:#111;display:block;}
.g-badge{position:absolute;top:2px;left:2px;background:var(--yellow);color:#000;font-size:9px;font-weight:900;padding:1px 5px;border-radius:3px;display:none;}
.g-thumb.sel .g-badge{display:block;}
.g-badge-stock{position:absolute;top:2px;right:2px;background:#444;color:#aaa;font-size:8px;font-weight:900;padding:1px 4px;border-radius:3px;}
/* コメント行 */
.c-row{display:flex;gap:4px;margin-bottom:5px;align-items:center;}
.c-row input{background:#111;border:1px solid var(--border);color:var(--text);padding:4px 7px;border-radius:4px;font-size:11px;}
.c-row .ct{flex:1;}
.hl-dot{width:20px;height:20px;border-radius:50%;border:2px solid var(--border);cursor:pointer;flex-shrink:0;background:transparent;transition:background .12s,border-color .12s;}
.hl-dot.on{background:var(--blue);border-color:var(--blue);}
/* 右: プレビューカラム */
.preview-col{display:flex;flex-direction:column;background:#0a0a0a;overflow:hidden;}
.pvtabs{display:flex;border-bottom:2px solid var(--border);flex-shrink:0;background:var(--panel);}
.pvtab{flex:1;padding:9px 2px;text-align:center;cursor:pointer;font-size:12px;font-weight:700;color:var(--sub);border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .12s;}
.pvtab:hover{color:var(--text);}.pvtab.active{color:var(--blue);border-bottom-color:var(--blue);}
.pv-wrap{width:768px;height:432px;flex-shrink:0;position:relative;background:#111;overflow:hidden;}
.pv-wrap iframe{width:1920px;height:1080px;transform:scale(0.4);transform-origin:top left;border:0;}
.pv-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--sub);font-size:12px;pointer-events:none;}
.pv-bottom{flex:1;overflow-y:auto;padding:10px;border-top:1px solid var(--border);}
.tts-r{font-size:11px;padding:3px 8px;border-radius:4px;margin-bottom:3px;}
.tts-r.ok{background:#1a2a1a;color:var(--green);}.tts-r.err{background:#2a1a1a;color:#e66;}
.tts-r.active{border:1px solid #67e8f9;}
.tts-ctrl{background:#0d1a2a;border:1px solid #1a3a5a;border-radius:6px;padding:8px 10px;margin-bottom:8px;}
.tts-ctrl-title{font-size:10px;color:#67e8f9;font-weight:700;margin-bottom:6px;}
.tts-ctrl-row{display:flex;align-items:center;gap:6px;margin-bottom:4px;flex-wrap:wrap;}
.tts-ctrl-lbl{font-size:10px;color:var(--sub);min-width:30px;}
.tts-ctrl select{background:#0a0a0a;border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;padding:2px 5px;}
.tts-ctrl input[type=number]{background:#0a0a0a;border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:11px;padding:2px 4px;width:46px;}
.tts-ctrl input[type=range]{width:80px;accent-color:#67e8f9;cursor:pointer;}
.tts-gender{display:flex;gap:6px;}.tts-gender label{display:flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;color:var(--text);}
.tts-item{display:flex;align-items:center;gap:5px;padding:4px 0;border-bottom:1px solid #1a2a3a;flex-wrap:nowrap;}.tts-item:last-child{border-bottom:none;}
.tts-sym{background:#1a3a5a;color:#67e8f9;font-size:10px;font-weight:700;border-radius:3px;padding:1px 5px;flex-shrink:0;min-width:20px;text-align:center;}
.tts-item-txt{font-size:10px;color:var(--sub);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;max-width:90px;}
/* 右カラム 画像ギャラリー */
.rg-section{padding:8px 0 4px;border-bottom:1px solid var(--border);margin-bottom:8px;}
.rg-lbl{font-size:10px;color:var(--sub);margin-bottom:5px;}
#rg-gallery{display:flex;flex-wrap:wrap;gap:5px;}
.rg-card{border:2px solid var(--border);border-radius:4px;overflow:hidden;background:#111;flex-shrink:0;transition:border-color .12s;}
.rg-card img{width:88px;height:50px;object-fit:contain;background:#111;display:block;}
.rg-card.sel-main{border-color:var(--accent);}.rg-card.sel-s2{border-color:#9b59b6;}.rg-card.sel-s3{border-color:#1aa8a8;}.rg-card.sel-s4{border-color:var(--blue);}.rg-card.sel-s5{border-color:#e67e22;}
.rg-btns{display:flex;}.rg-btn{flex:1;border:none;cursor:pointer;font-size:8px;font-weight:700;padding:2px 0;opacity:.7;transition:opacity .1s;}.rg-btn:hover{opacity:1;}
.rg-b1{background:#500;color:#f88;}.rg-b2{background:#305;color:#c7f;}.rg-b3{background:#054;color:#7ee;}.rg-b4{background:#025;color:#7ae;}.rg-b5{background:#531;color:#fa8;}
#pv-progress{height:18px;background:#0a0a0a;display:flex;align-items:center;gap:8px;padding:0 10px;flex-shrink:0;border-top:1px solid var(--border);}
#pv-timer{font-size:10px;color:#666;width:80px;flex-shrink:0;font-family:monospace;}
#pv-bar-bg{flex:1;height:3px;background:#2a2a2a;border-radius:2px;overflow:hidden;}
#pv-bar-fill{height:100%;width:0%;background:var(--blue);}
.rg-card img[data-err]{opacity:.25;}
.rg-card[draggable]{cursor:grab;}.rg-card[draggable]:active{cursor:grabbing;}
.pv-wrap.drag-over{outline:3px solid var(--yellow);outline-offset:-3px;}
.rg-drop-hint{display:none;position:absolute;bottom:8px;left:50%;transform:translateX(-50%);background:#000d;color:var(--yellow);font-size:12px;font-weight:700;padding:4px 12px;border-radius:5px;pointer-events:none;white-space:nowrap;}
#log-box{background:#000;border:1px solid var(--border);border-radius:5px;padding:8px;font-size:11px;font-family:monospace;color:#aaa;white-space:pre-wrap;max-height:180px;overflow-y:auto;margin-top:8px;display:none;}
#status-bar{background:#111;border-top:1px solid var(--border);padding:5px 14px;font-size:11px;color:var(--sub);flex-shrink:0;}
#status-bar.ok{color:var(--green);}#status-bar.err{color:var(--accent);}#status-bar.running{color:var(--orange);}
/* 案件選択モーダル */
#candidate-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:2000;overflow-y:auto;padding:30px 16px;}
.cm-box{max-width:680px;margin:0 auto;background:#1a1a1a;border:1px solid #444;border-radius:10px;padding:20px;}
.cm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;}
.cm-head h2{font-size:15px;color:#fff;font-weight:700;}
.cm-close{background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;}
.cm-section-title{font-size:10px;color:var(--yellow);font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin:14px 0 6px;padding-bottom:4px;border-bottom:1px solid #333;}
.cm-item{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:6px;border:1px solid transparent;margin-bottom:4px;cursor:pointer;transition:background .1s;}
.cm-item:hover{background:#252525;}
.cm-item.checked{background:#1a1f2e;border-color:#4a90e2;}
.cm-item input[type=checkbox]{margin-top:2px;flex-shrink:0;accent-color:#4a90e2;}
.cm-badge{font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;flex-shrink:0;margin-top:1px;}
.badge-post-match{background:#1a4a1e;color:#5dbb6a;}
.badge-transfer{background:#4a3010;color:#f0a040;}
.badge-injury{background:#4a1010;color:#f06060;}
.badge-manager{background:#1a1a4a;color:#6090f0;}
.badge-finance{background:#3a1a3a;color:#c070c0;}
.badge-topic{background:#2a2a2a;color:#aaa;}
.badge-src-merged{background:#1a3a4a;color:#60c0f0;margin-left:4px;}
.badge-src-common{background:#2a1a3a;color:#c084fc;margin-left:4px;}
.badge-src-reddit{background:#2a1a10;color:#ff6314;margin-left:4px;}
.cm-rss-match{display:block;font-size:10px;color:#888;margin-top:3px;padding-left:2px;}
.badge-src-fivech{background:#1a2a1a;color:#80cc80;margin-left:4px;}
.badge-src-rss{background:#1a2a1a;color:#4caf50;margin-left:4px;}
.badge-src-x{background:#1a1a2a;color:#1d9bf0;margin-left:4px;}
.cm-title{font-size:12px;color:#ddd;line-height:1.4;flex:1;}
.cm-meta{font-size:10px;color:#666;flex-shrink:0;white-space:nowrap;}
.cm-footer{margin-top:16px;display:flex;justify-content:space-between;align-items:center;}
.cm-count{font-size:12px;color:#888;}
#btn-process{background:#4a90e2;color:#fff;border:none;padding:8px 22px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;}
#btn-process:disabled{opacity:.4;cursor:not-allowed;}
#cm-log{background:#000;border:1px solid #333;border-radius:5px;padding:8px;font-size:11px;font-family:monospace;color:#aaa;white-space:pre-wrap;max-height:160px;overflow-y:auto;margin-top:12px;display:none;}
/* 生コメントモーダル */
#raw-cmt-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:3000;overflow-y:auto;padding:30px 16px;}
.rcm-box{max-width:560px;margin:0 auto;background:#1a1a1a;border:1px solid #444;border-radius:10px;padding:18px;}
.rcm-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;}
.rcm-head h2{font-size:14px;color:#fff;font-weight:700;}
.rcm-close{background:none;border:none;color:#888;font-size:20px;cursor:pointer;line-height:1;}
.rcm-section{font-size:10px;color:var(--yellow);font-weight:700;letter-spacing:1px;margin:10px 0 5px;text-transform:uppercase;}
.rcm-item{display:flex;align-items:flex-start;gap:6px;padding:5px 0;border-bottom:1px solid #2a2a2a;}
.rcm-item:last-child{border-bottom:none;}
.rcm-text{font-size:11px;color:#ccc;flex:1;line-height:1.5;word-break:break-word;}
.rcm-copy{flex-shrink:0;background:#1a2a1a;color:var(--green);border:1px solid #2a4a2a;border-radius:3px;padding:2px 7px;font-size:10px;cursor:pointer;}

/* ── モバイルタブバー ── */
.mobile-tabs{display:none;}
.mob-tab{flex:1;padding:10px 4px;text-align:center;font-size:11px;font-weight:700;color:var(--sub);cursor:pointer;border-top:3px solid transparent;transition:color .12s,border-color .12s;user-select:none;}
.mob-tab.active{color:var(--yellow);border-top-color:var(--yellow);}

/* ── スマホ対応 (〜767px) ── */
@media(max-width:767px){
  body{overflow:auto;height:auto;min-height:100dvh;}
  header{flex-wrap:wrap;gap:5px;padding:7px 10px;}
  header h1{font-size:12px;}
  input[type=date]{font-size:11px;padding:4px 6px;}
  button{font-size:11px;padding:5px 8px;}
  .ml-auto{margin-left:0;width:100%;}
  .btn-video{width:100%;}
  .main{grid-template-columns:1fr;flex:none;height:auto;overflow:visible;}
  .sidebar,.editor-col,.preview-col{display:none !important;}
  .sidebar.mob-active{display:block !important;overflow-y:auto;max-height:calc(100dvh - 120px);border-right:none;}
  .editor-col.mob-active{display:flex !important;flex-direction:column;min-height:calc(100dvh - 130px);border-right:none;}
  .preview-col.mob-active{display:flex !important;flex-direction:column;min-height:calc(100dvh - 130px);}
  .pv-wrap{width:100% !important;}
  #status-bar{margin-bottom:44px;}
  .mobile-tabs{display:flex;background:var(--panel);border-top:1px solid var(--border);position:fixed;bottom:0;left:0;right:0;z-index:100;}
}
</style></head><body>

<div id="raw-cmt-modal" onclick="if(event.target===this)closeRawCmt()">
  <div class="rcm-box">
    <div class="rcm-head">
      <h2>📋 生コメント一覧</h2>
      <button class="rcm-close" onclick="closeRawCmt()">✕</button>
    </div>
    <div id="rcm-body"></div>
  </div>
</div>

<header>
  <h1>⚽ サッカー YT ランチャー</h1>
  <input type="date" id="date-input">
  <button class="btn-load" onclick="loadContent()">📂 読み込み</button>
  <button class="btn-gen"  onclick="openCandidateModal()">📋 案件抽出</button>
  <button class="btn-video" id="btn-video" onclick="runVideo()">🎬 動画生成</button>
  <div class="ml-auto">
    <button class="btn-yt" onclick="openYoutubeLauncher()">▶ YouTube投稿</button>
  </div>
</header>

<div class="main">
  <!-- 左: 投稿リスト -->
  <div class="sidebar">
    <div class="sidebar-title">投稿一覧</div>
    <div id="post-list"></div>
  </div>

  <!-- 中: スライドエディタ -->
  <div class="editor-col">
    <div class="slide-tabs">
      <div class="slide-tab" id="tab-1" onclick="switchSlide(1)"><span class="sn">S1</span><span class="sl">タイトル</span></div>
      <div class="slide-tab" id="tab-2" onclick="switchSlide(2)"><span class="sn">S2</span><span class="sl">情報源</span></div>
      <div class="slide-tab" id="tab-3" onclick="switchSlide(3)"><span class="sn">S3</span><span class="sl">反応①</span></div>
      <div class="slide-tab" id="tab-4" onclick="switchSlide(4)"><span class="sn">S4</span><span class="sl">反応②</span></div>
      <div class="slide-tab" id="tab-5" onclick="switchSlide(5)"><span class="sn">S5</span><span class="sl">まとめ</span></div>
      <div class="slide-tab" id="tab-6" onclick="switchSlide(6)"><span class="sn">SI</span><span class="sl">ソース情報</span></div>
    </div>
    <div class="slide-editor" id="slide-editor">
      <div style="color:var(--sub);text-align:center;margin-top:80px;">← 日付を選択して「読み込み」してください</div>
    </div>
  </div>

  <!-- 右: ループプレビュー -->
  <div class="preview-col">
    <div class="pvtabs">
      <div class="pvtab" id="ptab-1" onclick="switchSlide(1)">S1</div>
      <div class="pvtab" id="ptab-2" onclick="switchSlide(2)">S2</div>
      <div class="pvtab" id="ptab-3" onclick="switchSlide(3)">S3</div>
      <div class="pvtab" id="ptab-4" onclick="switchSlide(4)">S4</div>
      <div class="pvtab" id="ptab-5" onclick="switchSlide(5)">S5</div>
      <div class="pvtab" id="ptab-6" onclick="switchSlide(6)">ソース</div>
    </div>
    <div class="pv-wrap" id="pv-wrap"
      ondragover="onPreviewDragOver(event)"
      ondragleave="onPreviewDragLeave(event)"
      ondrop="onPreviewDrop(event,this)">
      <div class="pv-hint" id="pv-hint">投稿を選択してください</div>
      <div class="rg-drop-hint" id="drop-hint"></div>
      <iframe id="pv-frame" style="display:none;"
        onload="if(!this.src||this.src==='about:blank')return;this.style.display='block';document.getElementById('pv-hint').style.display='none';startProgressBar();"></iframe>
    </div>
    <div id="pv-progress">
      <div id="pv-timer">0.0s / 9.0s</div>
      <div id="pv-bar-bg"><div id="pv-bar-fill"></div></div>
    </div>
    <div class="pv-bottom">
      <div id="tts-ctrl"></div>
      <div style="font-size:10px;color:var(--sub);margin-bottom:6px;">🎙 音声生成結果</div>
      <div id="tts-results"></div>
      <div id="log-box"></div>
    </div>
  </div>
</div>

<div id="status-bar" style="display:flex;align-items:center;justify-content:space-between;">
  <span id="status-bar-text">準備完了</span>
  <button onclick="showLastLog()" style="background:#1a2a3a;color:#67e8f9;border:1px solid #2a4a6a;border-radius:4px;padding:2px 10px;font-size:10px;cursor:pointer;flex-shrink:0;">📋 最終ログ</button>
</div>

<!-- モバイルタブバー -->
<div class="mobile-tabs">
  <div class="mob-tab" id="mobtab-list"    onclick="switchMobPanel('sidebar')">📋 リスト</div>
  <div class="mob-tab" id="mobtab-editor"  onclick="switchMobPanel('editor')">✏️ エディタ</div>
  <div class="mob-tab" id="mobtab-preview" onclick="switchMobPanel('preview')">👁️ プレビュー</div>
</div>
<div id="last-log-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:5000;overflow-y:auto;padding:20px 16px;">
  <div style="max-width:860px;margin:0 auto;background:#0d1117;border:1px solid #333;border-radius:8px;padding:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="color:#67e8f9;font-weight:700;">📋 最終ログ</span>
      <button onclick="document.getElementById('last-log-modal').style.display='none'" style="background:#333;color:#fff;border:none;border-radius:4px;padding:4px 12px;cursor:pointer;">✕ 閉じる</button>
    </div>
    <pre id="last-log-content" style="background:#000;color:#aaa;font-size:10px;font-family:monospace;white-space:pre-wrap;word-break:break-all;padding:10px;border-radius:4px;max-height:70vh;overflow-y:auto;margin:0;"></pre>
  </div>
</div>

<script>
// ── ユーティリティ ─────────────────────────────────────────────────────────────
const esc = s => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
function insertRed() {
  const el = document.getElementById("f-catchLine1");
  if (!el) return;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + "[r]" + el.value.slice(start, end) + "[/r]" + el.value.slice(end);
  el.focus();
  el.selectionStart = start + 3;
  el.selectionEnd   = end + 3;
  schedulePreview();
}

// ── 状態 ──────────────────────────────────────────────────────────────────────
let data      = { posts: [] };
let idx       = -1;
let slide     = 1;
let saveTimer = null;
let hlIdx3    = 0;
let hlIdx4    = 0;
let draggedPath = null;

document.getElementById("date-input").value = new Date(Date.now() + 9*60*60*1000).toISOString().slice(0, 10);

function status(msg, cls) {
  const bar = document.getElementById("status-bar");
  const txt = document.getElementById("status-bar-text");
  if (txt) txt.textContent = msg; else bar.textContent = msg;
  bar.className = cls || "";
}

async function showLastLog() {
  const modal = document.getElementById("last-log-modal");
  const pre   = document.getElementById("last-log-content");
  pre.textContent = "読み込み中...";
  modal.style.display = "block";
  try {
    const j = await (await fetch("/api/last-log")).json();
    pre.textContent = j.log || "（ログなし）";
    pre.scrollTop = pre.scrollHeight;
  } catch(e) {
    pre.textContent = "取得エラー: " + e.message;
  }
}

// ── 読み込み ──────────────────────────────────────────────────────────────────
async function loadContent() {
  const date = document.getElementById("date-input").value;
  if (!date) return status("日付を選択してください", "err");
  const r = await fetch("/api/content/" + date);
  const d = await r.json();
  data = d.posts?.length ? d : { posts: [], pendingPosts: [], generatedPosts: [] };
  status(data.posts.length ? data.posts.length + "件読み込み完了" : "コンテンツなし",
         data.posts.length ? "ok" : "err");
  renderSidebar();
  
  // 未生成があればそれを、なければ最初を選択
  if (data.pendingPosts && data.pendingPosts.length > 0) {
    const firstPendingIdx = data.posts.indexOf(data.pendingPosts[0]);
    selectPost(firstPendingIdx);
  } else if (data.posts.length > 0) {
    selectPost(0);
  } else {
    idx = -1; renderRightGallery();
  }
}

// ── 保存 ──────────────────────────────────────────────────────────────────────
async function saveLocal(silent) {
  const date = document.getElementById("date-input").value;
  if (!date) return;
  syncPost();
  const r = await fetch("/api/content/" + date, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...data, date }),
  });
  const j = await r.json();
  if (!silent) status(j.ok ? "保存完了" : "保存失敗: " + j.error, j.ok ? "ok" : "err");
  return j.ok;
}

// ── 自動保存 + プレビュー更新 ─────────────────────────────────────────────────
function schedulePreview() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await saveLocal(true); refreshPreview(); }, 900);
}

// ── サイドバー ────────────────────────────────────────────────────────────────
function renderSidebar() {
  const container = document.getElementById("post-list");
  
  // 未生成セクション
  let html = "<div style='font-size:10px; color:#aaa; padding:8px 4px 4px; font-weight:bold;'>📝 未生成</div>";
  html += "<div style='display:flex;gap:4px;margin-bottom:8px;padding:0 4px;'>" +
          "<button onclick='toggleAll(true)' style='flex:1;font-size:9px;padding:2px;background:#333;color:#ccc;'>全選択</button>" +
          "<button onclick='toggleAll(false)' style='flex:1;font-size:9px;padding:2px;background:#333;color:#ccc;'>解除</button>" +
          "</div>";
  
  const pending = (data.posts || []).filter(p => !p.isGenerated);
  html += pending.map(p => {
    const i = data.posts.indexOf(p);
    return "<div class='post-item" + (i === idx ? " active" : "") + "' onclick='selectPost(" + i + ")'>" +
           "<input type='checkbox' class='post-check' data-idx='" + i + "' onclick='event.stopPropagation()' style='margin-right:6px;cursor:pointer;'>" +
           "<span class='post-item-label'>" + esc(p.catchLine1 || "（無題）") + "</span>" +
           "<button class='post-del' onclick='event.stopPropagation();deletePost(" + i + ")' title='削除'>×</button>" +
           "</div>";
  }).join("");

  // 生成済みセクション
  const generated = (data.posts || []).filter(p => p.isGenerated);
  if (generated.length > 0) {
    html += "<div style='font-size:10px; color:#4ea; padding:16px 4px 4px; font-weight:bold; border-top:1px solid #333;'>🎬 生成済み</div>";
    html += generated.map(p => {
      const i = data.posts.indexOf(p);
      return "<div class='post-item" + (i === idx ? " active" : "") + "' style='background:rgba(78,238,170,0.05);' onclick='selectPost(" + i + ")'>" +
             "<span style='margin-right:6px; font-size:11px;'>✅</span>" +
             "<span class='post-item-label' style='color:#aaa;'>" + esc(p.catchLine1 || "（無題）") + "</span>" +
             "<button class='post-del' onclick='event.stopPropagation();deletePost(" + i + ")' title='削除'>×</button>" +
             "</div>";
    }).join("");
  }

  container.innerHTML = html;
}

function toggleAll(checked) {
  document.querySelectorAll(".post-check").forEach(cb => cb.checked = checked);
}

function deletePost(i) {
  if (!confirm("「" + (data.posts[i]?.catchLine1 || "この案件") + "」を削除しますか？")) return;
  data.posts.splice(i, 1);
  if (idx >= data.posts.length) idx = data.posts.length - 1;
  renderSidebar();
  if (data.posts.length === 0) { idx = -1; return; }
  if (idx < 0) idx = 0;
  renderSlide(); updateTabs(); refreshPreview(); renderRightGallery();
  schedulePreview();
}

function selectPost(i) {
  if (idx >= 0) syncPost();
  idx = i;
  renderSidebar();
  renderSlide();
  updateTabs();
  refreshPreview();
  renderRightGallery();
}

// ── スライド切り替え ──────────────────────────────────────────────────────────
function switchSlide(n) {
  if (idx < 0) return;
  syncPost();
  slide = n;
  renderSlide();
  updateTabs();
  refreshPreview();
}

function updateTabs() {
  [1, 2, 3, 4, 5, 6].forEach(n => {
    document.getElementById("tab-" + n)?.classList.toggle("active", n === slide);
    document.getElementById("ptab-" + n)?.classList.toggle("active", n === slide);
  });
}

// ── プレビュー ────────────────────────────────────────────────────────────────
function _estTts(text) { return Math.max(1.2, (text||"").replace(/\s/g,"").length/8.0); }
function calcSlideMs(post, n) {
  const CMT_OFF=2.0, CMT_GAP=0.8;
  if (n===1) return 7000;
  if (n===2) return Math.round((1.0+_estTts(post.overviewNarration)+1.5)*1000);
  if (n===3||n===4) {
    const sl=post[n===3?"slide3":"slide4"];
    const narrSec=n===3?_estTts(sl?.narration||sl?.subtitleBox):0;
    const cmts=(sl?.comments||[]).filter(c=>(typeof c==="string"?c:(c.text||"")).trim());
    let t=narrSec+CMT_OFF;
    for(const c of cmts){t+=_estTts(typeof c==="string"?c:(c.text||""))+CMT_GAP;}
    return Math.round((t+1.5)*1000);
  }
  if (n===5) return Math.round((4.0+_estTts(post.outroTelop||post.outroNarration)+1.5)*1000);
  return 9000;
}
let slideDurations = { 1: 7000, 2: 9000, 3: 30000, 4: 30000, 5: 9000 };
let pvStartTime = 0;
let pvRafId = null;

function refreshPreview() {
  const date = document.getElementById("date-input").value;
  if (!date || idx < 0) return;
  if (data.posts[idx]) {
    for (let n=1;n<=5;n++) slideDurations[n] = calcSlideMs(data.posts[idx], n);
  }
  const fr = document.getElementById("pv-frame");
  document.getElementById("pv-hint").style.display = "none";
  fr.style.display = "none";
  cancelAnimationFrame(pvRafId);
  const dur = slideDurations[slide] || 9000;
  const bar = document.getElementById("pv-bar-fill");
  const timer = document.getElementById("pv-timer");
  if (bar) bar.style.width = "0%";
  if (timer) timer.textContent = "0.0s / " + (dur / 1000).toFixed(1) + "s";
  if (slide === 6) {
    // SIタブ: プレビュー不要
    document.getElementById("pv-progress").style.display = "none";
    document.getElementById("pv-hint").style.display = "block";
    document.getElementById("pv-hint").textContent = "ソース情報タブ";
    return;
  } else {
    fr.style.width  = "1920px";
    fr.style.height = "1080px";
    fr.style.transform = "scale(0.4)";
    document.getElementById("pv-progress").style.display = "";
    fr.src = "/api/preview/s" + slide + "/" + date + "/" + idx + "?loop=1&t=" + Date.now();
  }
}

function startProgressBar() {
  pvStartTime = performance.now();
  cancelAnimationFrame(pvRafId);
  tickProgressBar();
}

function tickProgressBar() {
  const dur = slideDurations[slide] || 9000;
  const elapsed = performance.now() - pvStartTime;
  const pct = Math.min(elapsed / dur * 100, 100);
  const bar = document.getElementById("pv-bar-fill");
  const timer = document.getElementById("pv-timer");
  if (bar) bar.style.width = pct + "%";
  if (timer) timer.textContent = (elapsed / 1000).toFixed(1) + "s / " + (dur / 1000).toFixed(1) + "s";
  if (elapsed < dur) pvRafId = requestAnimationFrame(tickProgressBar);
}

// ── スライドエディタ描画 ──────────────────────────────────────────────────────
function renderSlide() {
  if (idx < 0) return;
  const post = data.posts[idx];
  const el   = document.getElementById("slide-editor");
  if (slide === 1) el.innerHTML = buildS1(post);
  else if (slide === 6) el.innerHTML = buildSI(post);
  else if (slide === 2) el.innerHTML = buildS2(post);
  else if (slide === 3) el.innerHTML = buildS3(post);
  else if (slide === 4) el.innerHTML = buildS4(post);
  else                  el.innerHTML = buildS5(post);
  el.querySelectorAll("input,textarea,select").forEach(inp => {
    inp.addEventListener("input",  schedulePreview);
    inp.addEventListener("change", schedulePreview);
  });
  updateGallery(post);
  renderTtsCtrl();
}

// ── 画像ギャラリー ────────────────────────────────────────────────────────────
function galleryHtml(slot) {
  const post  = data.posts[idx];
  const paths = post.imagePaths ||
    [post.mainImagePath, post.slide3ImagePath, post.slide4ImagePath].filter(Boolean);

  let thumbsHtml = paths.map((p, i) => {
    const fn  = p.replace(/\\\\/g, "/").split("/").pop();
    const url = "/images/" + fn;
    return "<div class='g-thumb' id='gt-" + slot + "-" + i + "' data-path='" + esc(p) +
           "' data-slot='" + slot + "' onclick='setImg(this)'>" +
           "<img src='" + url + "' onerror='this.parentElement.hidden=true'>" +
           "<div class='g-badge'>✓</div></div>";
  }).join("");

  // stock補完（実画像が少ない場合）
  const stock = post._stockImages || [];
  if (stock.length) {
    thumbsHtml += stock.map((s, i) => {
      return "<div class='g-thumb' id='gt-" + slot + "-st-" + i + "' data-path='" + esc(s.localPath) +
             "' data-stock-url='" + esc(s.url) + "' data-slot='" + slot + "' onclick='setImg(this)'>" +
             "<img src='" + s.url + "' onerror='this.parentElement.hidden=true'>" +
             "<div class='g-badge'>✓</div>" +
             "<div class='g-badge-stock'>素材</div></div>";
    }).join("");
  }

  if (!thumbsHtml) thumbsHtml = "<div style='color:var(--sub);font-size:11px;'>画像なし</div>";

  return "<div class='gallery'>" + thumbsHtml +
    "<label style='display:flex;align-items:center;justify-content:center;width:64px;height:64px;border:2px dashed #555;border-radius:4px;cursor:pointer;color:#888;font-size:22px;flex-shrink:0;' title='画像を追加'>" +
    "＋<input type='file' accept='image/*' style='display:none' onchange='uploadImage(this,\\"" + slot + "\\")'></label>" +
    "</div>";
}

function setImg(card) {
  const p  = card.dataset.path;
  const sl = card.dataset.slot;
  const post = data.posts[idx];
  if (sl === "main")  post.mainImagePath   = p;
  if (sl === "s2")    post.slide2ImagePath = p;
  if (sl === "s3")    post.slide3ImagePath = p;
  if (sl === "s4")    post.slide4ImagePath = p;
  if (sl === "s5")    post.slide5ImagePath = p;
  updateGallery(post);
  schedulePreview();
}

function updateGallery(post) {
  document.querySelectorAll(".g-thumb").forEach(card => {
    const sl  = card.dataset.slot;
    const cur = sl === "main" ? post.mainImagePath
              : sl === "s2"   ? post.slide2ImagePath
              : sl === "s3"   ? post.slide3ImagePath
              : sl === "s4"   ? post.slide4ImagePath
              : post.slide5ImagePath;
    card.classList.toggle("sel", card.dataset.path === cur);
  });
}

// ── S1 ───────────────────────────────────────────────────────────────────────
function buildS1(post) {
  return "<div class='sec-lbl'>🎬 S1 タイトルカード</div>" +
    "<div class='field'><label>キャッチコピー（ナレーション兼用）</label>" +
    "<div style='display:flex;gap:8px;align-items:flex-start'>" +
    "<textarea id='f-catchLine1' rows='3' style='flex:1'>" + esc(post.catchLine1) + "</textarea>" +
    "<button onclick='insertRed()' title='選択テキストを赤字にする' style='background:#c00000;color:#fff;border:none;padding:10px 14px;border-radius:6px;cursor:pointer;font-weight:900;font-size:20px;flex-shrink:0'>🔴</button>" +
    "</div></div>" +
    "<div class='frow'>" +
    "<div class='field'><label>ラベル</label>" +
    "<input type='text' id='f-label' value='" + esc(post.label || "") + "' placeholder='【速報】' style='width:140px'></div>" +
    "<div class='field'><label>バッジ</label>" +
    "<input type='text' id='f-badge' value='" + esc(post.badge || "") + "'></div>" +
    "</div>" +
    "<div class='sec-lbl'>🖼 背景画像（S1・S5共通）</div>" +
    "<div class='g-wrap'>" + galleryHtml("main") + "</div>";
}

// ── SI（ソース情報）────────────────────────────────────────────────────────────
function buildSI(post) {
  const snippets = post._imgMeta?.serperSnippets || [];
  const primaryLinks = snippets.filter(s => s.link).map(s =>
    "<div style='margin-bottom:4px;'><a href='" + esc(s.link) + "' target='_blank' style='color:#7ab8e8;font-size:12px;word-break:break-all;'>" + esc(s.title || s.link) + "</a>" +
    (s.date ? "<span style='color:#666;margin-left:6px;font-size:11px;'>" + esc(s.date) + "</span>" : "") + "</div>"
  ).join("");
  const fallbackUrl = post._meta?.redditUrl || post._imgMeta?.url || "";
  const fallbackHtml = fallbackUrl
    ? "<div style='margin-bottom:4px;'><a href='" + esc(fallbackUrl) + "' target='_blank' style='color:#7ab8e8;font-size:12px;word-break:break-all;'>" + esc(fallbackUrl) + "</a></div>"
    : "<div style='color:#555;font-size:12px;margin-bottom:4px;'>URLなし</div>";
  return "<div class='sec-lbl'>📺 YouTube 投稿情報</div>" +
    "<div class='field'><label>動画タイトル（SEO用）</label>" +
    "<input type='text' id='f-youtubeTitle' value='" + esc(post.youtubeTitle || "") + "' placeholder='【速報】〇〇さん、〇〇！！！！'></div>" +
    "<div class='field'><label>ハッシュタグ</label>" +
    "<textarea id='f-hashtagsText' rows='2' placeholder='#サッカー #海外の反応 #レアルマドリード'>" + esc(post.hashtagsText || "") + "</textarea></div>" +
    "<div class='sec-lbl'>📰 ソース情報（一次情報）</div>" +
    (primaryLinks || fallbackHtml) +
    "<div style='background:#0d1f30;border:1px solid #2a4a6b;border-radius:6px;padding:8px 10px;font-size:12px;color:#bbb;white-space:pre-wrap;line-height:1.5;margin-top:6px;'>" +
    esc((post.overviewNarration || "（概要なし）").slice(0, 400)) + "</div>";
}

// ── S2 ───────────────────────────────────────────────────────────────────────
function buildS2(post) {
  const s2Skip = !!post.skipS2;
  return "<div class='sec-lbl'>📰 S2 情報源カード" +
    "<label style='margin-left:16px;font-size:11px;font-weight:400;color:var(--sub);cursor:pointer;'>" +
    "<input type='checkbox' id='f-skip-s2'" + (s2Skip ? " checked" : "") + " onchange='schedulePreview()'> スキップ</label></div>" +
    "<div id='s2-fields' style='" + (s2Skip ? "opacity:0.4;pointer-events:none;" : "") + "'>" +
    "<div class='field'><label>ソース名</label>" +
    "<input type='text' id='f-sourceAuthor' value='" + esc(post.sourceAuthor || "") + "'></div>" +
    "<div class='field'><label>テロップ / ナレーション（共通）</label>" +
    "<textarea id='f-overviewNarration' rows='4'>" + esc(post.overviewNarration || post.overviewTelop || "") + "</textarea></div>" +
    "<div class='sec-lbl'>🖼 背景画像（S2）</div>" +
    "<div class='g-wrap'>" + galleryHtml("s2") + "</div>" +
    "</div>";
}

// ── S3/S4 共通 ───────────────────────────────────────────────────────────────
function buildCommentEditor(post, key) {
  const sl    = post[key] || {};
  const isS3  = key === "slide3";
  const slot  = isS3 ? "s3" : "s4";
  const hlSet = isS3 ? "setHl3" : "setHl4";
  const cur   = isS3 ? hlIdx3 : hlIdx4;
  // 初期表示を最低7件に揃える（足りない分は空白行で補完）
  const rawCs = sl.comments || [];
  const cs = rawCs.length >= 7 ? rawCs : [...rawCs, ...Array(7 - rawCs.length).fill({ text: "" })];
  const lbl     = isS3 ? "S3 Reddit反応①" : "S4 Reddit反応②";
  const skipKey = isS3 ? "skipS3" : "skipS4";
  const skipId  = isS3 ? "f-skip-s3" : "f-skip-s4";
  const isSkip  = !!post[skipKey];

  const rows = cs.map((c, i) => {
    const src = c.source || "";
    const badgeMap = { reddit: ["🟠", "#c05c00", "#3a1a00"], x: ["🔵", "#1a6aaa", "#0a1a2a"], matome: ["🟢", "#2a8a4a", "#0a2a1a"], ai: ["✨", "#666", "#1a1a2a"] };
    const [icon, color, bg] = badgeMap[src] || ["", "", ""];
    const badge = src ? "<span style='flex-shrink:0;font-size:9px;padding:1px 5px;border-radius:3px;background:" + bg + ";color:" + color + ";border:1px solid " + color + ";line-height:1.6;'>" + icon + " " + src.toUpperCase() + "</span>" : "<span style='flex-shrink:0;width:44px;'></span>";
    return "<div class='c-row'>" +
      "<div class='hl-dot" + (cur === i ? " on" : "") + "' onclick='" + hlSet + "(" + i + ")'></div>" +
      badge +
      "<input class='ct' id='f-" + key + "-t-" + i + "' placeholder='コメント本文' value='" + esc(c.text || "") + "'>" +
      "<button onclick='deleteCmt(\\"" + key + "\\"," + i + ")' style='flex-shrink:0;background:#3a1a1a;color:#e66;border:1px solid #e66;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;'>×</button>" +
      "</div>";
  }).join("");

  return "<div class='sec-lbl'>💬 " + lbl +
    "<label style='margin-left:16px;font-size:11px;font-weight:400;color:var(--sub);cursor:pointer;'>" +
    "<input type='checkbox' id='" + skipId + "'" + (isSkip ? " checked" : "") + " onchange='schedulePreview()'> スキップ</label></div>" +
    "<div id='" + (isS3 ? "s3" : "s4") + "-fields' style='" + (isSkip ? "opacity:0.4;pointer-events:none;" : "") + "'>" +
    "<div class='field'><label>トピックタグ（右上）</label>" +
    "<input type='text' id='f-" + key + "-topicTag' value='" + esc(sl.topicTag || "") + "'></div>" +
    "<div class='field'><label>字幕 / ナレーション" +
    "<label style='margin-left:12px;font-size:11px;font-weight:400;color:var(--sub);cursor:pointer;'>" +
    "<input type='checkbox' id='f-" + key + "-noNarration'" + (sl.noNarration ? " checked" : "") +
    " onchange='toggleNarr(this)'> なし</label></label>" +
    "<div class='narr-wrap' style='opacity:" + (sl.noNarration ? "0.3" : "1") + "'>" +
    "<textarea id='f-" + key + "-narration' rows='3'>" + esc(sl.narration || sl.subtitleBox || "") + "</textarea></div></div>" +
    "<div class='field'><label>コメント（● でハイライト選択）</label>" +
    "<div id='cmt-list-" + key + "'>" + rows + "</div>" +
    "<div style='display:flex;gap:6px;margin-top:5px;'>" +
    "<button onclick='addCmt(\\"" + key + "\\")' style='background:#1a3a2a;color:#3cb371;border:1px solid #3cb371;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;'>＋ コメント追加</button>" +
    "<button data-key='" + key + "' onclick='showRawCmt(this.dataset.key)' style='background:#1a2a3a;color:#67e8f9;border:1px solid #2a4a6a;border-radius:4px;padding:4px 12px;font-size:11px;font-weight:700;cursor:pointer;'>📋 元コメ表示</button>" +
    "</div>" +
    "</div>" +
    "<div class='sec-lbl'>🖼 背景画像</div>" +
    "<div class='g-wrap'>" + galleryHtml(slot) + "</div>" +
    "</div>";
}

function buildS3(post) {
  const sl = post.slide3 || {};
  hlIdx3 = sl.highlightIdx !== undefined ? sl.highlightIdx : 0;
  return buildCommentEditor(post, "slide3");
}

function buildS4(post) {
  const sl = post.slide4 || {};
  hlIdx4 = sl.highlightIdx !== undefined ? sl.highlightIdx : 0;
  return buildCommentEditor(post, "slide4");
}

// ── S5 ───────────────────────────────────────────────────────────────────────
function buildS5(post) {
  return "<div class='sec-lbl'>🏁 S5 まとめ（アウトロ）</div>" +
    "<div class='field'><label>エンドコメント（読み上げ＋表示）</label>" +
    "<input type='text' id='f-outroTelop' value='" + esc(post.outroTelop || "") + "'></div>" +
    "<div class='sec-lbl'>🖼 背景画像（S5独立）</div>" +
    "<div class='g-wrap'>" + galleryHtml("s5") + "</div>";
}

// ── ナレーション有無切り替え ──────────────────────────────────────────────────
function toggleNarr(cb) {
  const wrap = cb.closest(".field").querySelector(".narr-wrap");
  if (wrap) wrap.style.opacity = cb.checked ? "0.3" : "1";
  schedulePreview();
}

// ── ハイライト切り替え ────────────────────────────────────────────────────────
function setHl3(i) {
  hlIdx3 = i;
  document.querySelectorAll("#slide-editor .hl-dot").forEach((el, j) => el.classList.toggle("on", j === i));
  schedulePreview();
}
function setHl4(i) {
  hlIdx4 = i;
  document.querySelectorAll("#slide-editor .hl-dot").forEach((el, j) => el.classList.toggle("on", j === i));
  schedulePreview();
}

// ── 画像アップロード ──────────────────────────────────────────────────────────
async function uploadImage(input, slot) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const r = await fetch("/api/upload-image", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: e.target.result, filename: file.name }),
    });
    const j = await r.json();
    if (!j.ok) return status("アップロード失敗: " + j.error, "err");
    const post = data.posts[idx];
    if (!post.imagePaths) post.imagePaths = [];
    post.imagePaths.push(j.path);
    // スロットに自動セット
    if (slot === "main") post.mainImagePath   = j.path;
    if (slot === "s2")   post.slide2ImagePath = j.path;
    if (slot === "s3")   post.slide3ImagePath = j.path;
    if (slot === "s4")   post.slide4ImagePath = j.path;
    if (slot === "s5")   post.slide5ImagePath = j.path;
    renderSlide();
    schedulePreview();
    status("画像を追加しました", "ok");
  };
  reader.readAsDataURL(file);
}

function showRawCmt(key) {
  const post = data.posts[idx];
  const raw   = post._rawCommentsJa || post._rawComments || {};
  const reddit = raw.reddit || [];
  const x      = raw.x      || [];
  if (!reddit.length && !x.length) {
    alert("元コメデータがありません。\\n（このJSONは古いバージョンで生成された可能性があります）");
    return;
  }
  function itemHtml(text) {
    const safe = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/'/g,"&#39;");
    return "<div class='rcm-item'><span class='rcm-text'>" + safe + "</span>" +
      "<button class='rcm-copy' data-txt='" + safe + "' onclick='copyRcm(this)'>コピー</button></div>";
  }
  let html = "";
  if (reddit.length) {
    html += "<div class='rcm-section'>掲示板コメント（" + reddit.length + "件）</div>";
    html += reddit.map(itemHtml).join("");
  }
  if (x.length) {
    html += "<div class='rcm-section'>X / Twitter（" + x.length + "件）</div>";
    html += x.map(itemHtml).join("");
  }
  document.getElementById("rcm-body").innerHTML = html;
  document.getElementById("raw-cmt-modal").style.display = "block";
}
function closeRawCmt() {
  document.getElementById("raw-cmt-modal").style.display = "none";
}
function copyRcm(btn) {
  const txt = btn.dataset.txt.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#39;/g,"'");
  navigator.clipboard.writeText(txt).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✓";
    setTimeout(() => { btn.textContent = orig; }, 1200);
  });
}

function addCmt(key) {
  syncPost();
  const post = data.posts[idx];
  if (!post[key]) post[key] = {};
  if (!post[key].comments) post[key].comments = [];
  post[key].comments.push({ user: "", text: "" });
  renderSlide();
  schedulePreview();
}

function deleteCmt(key, i) {
  syncPost();
  const post = data.posts[idx];
  if (!post[key]?.comments) return;
  post[key].comments.splice(i, 1);
  if (key === "slide3") hlIdx3 = Math.min(hlIdx3, Math.max(0, post[key].comments.length - 1));
  if (key === "slide4") hlIdx4 = Math.min(hlIdx4, Math.max(0, post[key].comments.length - 1));
  renderSlide();
  schedulePreview();
}

// ── データ同期 ────────────────────────────────────────────────────────────────
function g(id) { return document.getElementById(id)?.value ?? ""; }

function syncPost() {
  if (idx < 0) return;
  const post = data.posts[idx];
  if (document.getElementById("f-catchLine1"))     post.catchLine1       = g("f-catchLine1");
  if (document.getElementById("f-label"))          post.label            = g("f-label");
  if (document.getElementById("f-badge"))          post.badge            = g("f-badge");
  if (document.getElementById("f-sourceAuthor"))   post.sourceAuthor     = g("f-sourceAuthor");
  if (document.getElementById("f-overviewNarration")) {
    const v = g("f-overviewNarration");
    post.overviewNarration = v;
    post.overviewTelop     = v;
  }
  if (document.getElementById("f-outroTelop"))     post.outroTelop       = g("f-outroTelop");
  if (document.getElementById("f-outroNarration")) post.outroNarration   = g("f-outroNarration");
  // スキップフラグ
  const skipS2El = document.getElementById("f-skip-s2");
  const skipS3El = document.getElementById("f-skip-s3");
  const skipS4El = document.getElementById("f-skip-s4");
  if (skipS2El) post.skipS2 = skipS2El.checked;
  if (skipS3El) post.skipS3 = skipS3El.checked;
  if (skipS4El) post.skipS4 = skipS4El.checked;
  if (document.getElementById("f-youtubeTitle"))   post.youtubeTitle     = g("f-youtubeTitle");
  if (document.getElementById("f-hashtagsText"))   post.hashtagsText     = g("f-hashtagsText");
  // S3
  if (document.getElementById("f-slide3-topicTag")) {
    if (!post.slide3) post.slide3 = {};
    post.slide3.topicTag     = g("f-slide3-topicTag");
    post.slide3.noNarration  = !!document.getElementById("f-slide3-noNarration")?.checked;
    const n3 = g("f-slide3-narration");
    post.slide3.narration   = n3;
    post.slide3.subtitleBox = n3;
    post.slide3.highlightIdx = hlIdx3;
    const rows3 = document.querySelectorAll("#cmt-list-slide3 .c-row").length;
    post.slide3.comments = Array.from({length: rows3}, (_, i) => ({ text: g("f-slide3-t-" + i) }))
      .filter(c => c.text);
  }
  // S4
  if (document.getElementById("f-slide4-topicTag")) {
    if (!post.slide4) post.slide4 = {};
    post.slide4.topicTag     = g("f-slide4-topicTag");
    post.slide4.noNarration  = !!document.getElementById("f-slide4-noNarration")?.checked;
    const n4 = g("f-slide4-narration");
    post.slide4.narration    = n4;
    post.slide4.subtitleBox  = n4;
    post.slide4.highlightIdx = hlIdx4;
    const rows4 = document.querySelectorAll("#cmt-list-slide4 .c-row").length;
    post.slide4.comments = Array.from({length: rows4}, (_, i) => ({ text: g("f-slide4-t-" + i) }))
      .filter(c => c.text);
  }
}


// ── 自動生成 ──────────────────────────────────────────────────────────────────
async function runGenerate() {
  const date = document.getElementById("date-input").value;
  if (!date) return status("日付を選択してください", "err");
  if (!confirm("generate_soccer_yt.js を実行します。よろしいですか？")) return;
  await fetch("/api/run-generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date }) });
  status("🤖 自動生成中...", "running");
  showLog(true);
  pollJob(() => loadContent());
}


// ── TTS 音声設定パネル（VoiceVox）────────────────────────────────────────────
const VV_SPEAKERS = {
  male:   [{ id: 13, name: "青山龍星" }, { id: 11, name: "玄野武宏" }, { id: 3, name: "ずんだもん" }],
  female: [{ id: 0,  name: "四国めたん" }, { id: 9, name: "春日部つむぎ" }],
};
const VV_CMT_ROTATION = [13, 11, 3, 11, 13, 3, 0];  // 青山龍星/玄野武宏/ずんだもん ローテ + 四国めたん×1
function defaultTtsSettings(key) {
  if (key.startsWith("cmt_")) {
    const idx = parseInt(key.split("_").pop()) || 0;
    return { speaker: VV_CMT_ROTATION[idx % VV_CMT_ROTATION.length], speed: 1.2, intonationScale: 1.0 };
  }
  return { speaker: 13, speed: 1.2, intonationScale: 1.0 };
}
const TTS_SCENE_LABEL = { 1:"S1", 2:"S2", 3:"S3", 4:"S4", 5:"S5" };

function ttsShortSym(label) {
  if (label === "キャッチコピー") return "K";
  if (label === "ナレーション")   return "N";
  if (label === "アウトロ")       return "O";
  const m = label.match(/(\d+)/);
  return "C" + (m ? m[1] : "");
}

function buildSceneItemList(slideNum, post) {
  const items = [];
  if (slideNum === 1) {
    items.push({ key: "narr_0", label: "キャッチコピー", text: post.catchLine1 || "" });
  } else if (slideNum === 2) {
    items.push({ key: "narr_1", label: "ナレーション", text: post.overviewNarration || "" });
  } else if (slideNum === 3) {
    const narr = post.slide3?.narration || post.slide3?.subtitleBox || "";
    if (narr.trim()) items.push({ key: "narr_2", label: "ナレーション", text: narr });
    (post.slide3?.comments || []).forEach((c, i) => {
      if ((c.text || "").trim()) items.push({ key: "cmt_2_" + i, label: "コメント " + (i + 1), text: c.text });
    });
  } else if (slideNum === 4) {
    const narr4 = post.slide4?.narration || "";
    if (!post.slide4?.noNarration && narr4.trim()) items.push({ key: "narr_3", label: "ナレーション", text: narr4 });
    (post.slide4?.comments || []).forEach((c, i) => {
      if ((c.text || "").trim()) items.push({ key: "cmt_3_" + i, label: "コメント " + (i + 1), text: c.text });
    });
  } else if (slideNum === 5) {
    const t = post.outroTelop || post.outroNarration || "";
    if (t.trim()) items.push({ key: "narr_4", label: "アウトロ", text: t });
  }
  return items.map(item => ({ ...item, sym: ttsShortSym(item.label) }));
}

function renderTtsCtrl() {
  const el = document.getElementById("tts-ctrl");
  if (!el) return;
  if (idx < 0 || slide === 6) { el.innerHTML = ""; return; }
  const post  = data.posts[idx];
  const items = buildSceneItemList(slide, post);
  if (!items.length) { el.innerHTML = ""; return; }
  if (!post.ttsSettings) post.ttsSettings = {};

  const sceneKey = "s" + slide;
  let html = "<div class='tts-ctrl'>" +
    "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;'>" +
      "<div class='tts-ctrl-title' style='margin-bottom:0;'>🎙 " + TTS_SCENE_LABEL[slide] + " 音声設定</div>" +
      "<button onclick='runTtsScene(this.dataset.scene)' data-scene='" + sceneKey + "' style='font-size:10px;padding:2px 8px;cursor:pointer;border-radius:3px;'>🔄 このシーンを再生成</button>" +
    "</div>";
  items.forEach(({ key, text, sym }) => {
    const s       = post.ttsSettings[key] || defaultTtsSettings(key);
    if (!post.ttsSettings[key]) post.ttsSettings[key] = s;
    const spkId   = s.speaker ?? 13;
    const gender  = VV_SPEAKERS.female.some(x => x.id === spkId) ? "female" : "male";
    const allSpk  = [...VV_SPEAKERS.male, ...VV_SPEAKERS.female];
    const preview = (text || "").slice(0, 20) + (text?.length > 20 ? "…" : "");
    html +=
      "<div class='tts-item'>" +
        "<span class='tts-sym'>" + sym + "</span>" +
        "<span class='tts-item-txt'>" + esc(preview) + "</span>" +
        "<div class='tts-gender'>" +
          "<label><input type='radio' name='tts-g-" + key + "' data-key='" + key + "' value='female'" + (gender === "female" ? " checked" : "") + " onchange='onTtsGenderChange(this)'> 女</label>" +
          "<label><input type='radio' name='tts-g-" + key + "' data-key='" + key + "' value='male'"   + (gender === "male"   ? " checked" : "") + " onchange='onTtsGenderChange(this)'> 男</label>" +
        "</div>" +
        "<select id='tts-v-" + key + "' onchange='saveTtsItem(this)'>" +
          allSpk.map(x => "<option value='" + x.id + "'" + (x.id === spkId ? " selected" : "") + ">" + x.name + "</option>").join("") +
        "</select>" +
        "<span style='font-size:9px;color:#888;margin-left:4px;'>速</span>" +
        "<input type='range' id='tts-sr-" + key + "' min='0.5' max='2.0' step='0.1' value='" + s.speed + "' oninput='onTtsSpeedInput(this)'>" +
        "<input type='number' id='tts-sn-" + key + "' min='0.5' max='2.0' step='0.1' value='" + s.speed + "' onchange='onTtsSpeedChange(this)'>" +
        "<span style='font-size:9px;color:#888;margin-left:4px;'>抑</span>" +
        "<input type='range' id='tts-ir-" + key + "' min='0.0' max='2.0' step='0.1' value='" + (s.intonationScale ?? 1.0) + "' oninput='onTtsIntonInput(this)'>" +
        "<input type='number' id='tts-in-" + key + "' min='0.0' max='2.0' step='0.1' value='" + (s.intonationScale ?? 1.0) + "' onchange='onTtsIntonChange(this)'>" +
      "</div>";
  });
  html += "</div>";
  el.innerHTML = html;
}

function onTtsGenderChange(el) {
  const key     = el.dataset.key;
  const spkList = VV_SPEAKERS[el.value];
  const sel     = document.getElementById("tts-v-" + key);
  sel.innerHTML = spkList.map(x => "<option value='" + x.id + "'>" + x.name + "</option>").join("");
  sel.value = spkList[0].id;
  saveTtsItem(key);
}

function onTtsSpeedInput(el) {
  const key   = el.id.replace("tts-sr-", "");
  const numEl = document.getElementById("tts-sn-" + key);
  if (numEl) numEl.value = el.value;
  saveTtsItem(key);
}

function onTtsSpeedChange(el) {
  const key     = el.id.replace("tts-sn-", "");
  const rangeEl = document.getElementById("tts-sr-" + key);
  if (rangeEl) rangeEl.value = el.value;
  saveTtsItem(key);
}

function onTtsIntonInput(el) {
  const key   = el.id.replace("tts-ir-", "");
  const numEl = document.getElementById("tts-in-" + key);
  if (numEl) numEl.value = el.value;
  saveTtsItem(key);
}

function onTtsIntonChange(el) {
  const key     = el.id.replace("tts-in-", "");
  const rangeEl = document.getElementById("tts-ir-" + key);
  if (rangeEl) rangeEl.value = el.value;
  saveTtsItem(key);
}

function saveTtsItem(elOrKey) {
  if (idx < 0) return;
  const key  = typeof elOrKey === "string" ? elOrKey : elOrKey.id.replace(/^tts-[vei]-/, "");
  const post = data.posts[idx];
  if (!post.ttsSettings) post.ttsSettings = {};
  post.ttsSettings[key] = {
    speaker:        parseInt(document.getElementById("tts-v-"  + key)?.value) || defaultTtsSettings(key).speaker,
    speed:          parseFloat(document.getElementById("tts-sn-" + key)?.value || "1.2"),
    intonationScale: parseFloat(document.getElementById("tts-in-" + key)?.value ?? "1.0"),
  };
}

// ── TTS ───────────────────────────────────────────────────────────────────────
function renderTtsResults(results) {
  const scenes = ["s1","s2","s3","s4","s5"];
  const sceneLabel = { s1:"S1", s2:"S2", s3:"S3", s4:"S4", s5:"S5" };
  const groups = { s1:[], s2:[], s3:[], s4:[], s5:[], other:[] };
  for (const r of results) {
    const key = scenes.find(s => r.label.startsWith(sceneLabel[s])) || "other";
    groups[key].push(r);
  }
  const currentScene = "s" + slide;
  const ts = Date.now();
  let html = "";
  for (const s of scenes) {
    const items = groups[s];
    if (!items.length) continue;
    const allOk = items.every(r => r.ok);
    const isActive = s === currentScene;
    html += "<div class='tts-r " + (allOk ? "ok" : "err") + (isActive ? " active" : "") + "' style='margin-bottom:4px;padding:4px 6px;'>" +
      "<div style='display:flex;align-items:center;gap:6px;margin-bottom:2px;'>" +
        "<span>" + (allOk ? "✅" : "⚠️") + " " + sceneLabel[s] + " (" + items.filter(r=>r.ok).length + "/" + items.length + ")</span>" +
        "<button onclick='runTtsScene(this.dataset.scene)' data-scene='" + s + "' style='font-size:10px;padding:2px 6px;cursor:pointer;border-radius:3px;'>🔄</button>" +
      "</div>" +
      items.filter(r => r.ok && r.url).map(r =>
        "<div style='display:flex;align-items:center;gap:4px;font-size:10px;margin-top:2px;'>" +
          "<span style='width:90px;flex-shrink:0;color:#aaa;'>" + r.label + "</span>" +
          "<audio controls style='height:18px;flex:1;min-width:0;' src='" + r.url + "?t=" + ts + "'></audio>" +
        "</div>"
      ).join("") +
      "</div>";
  }
  document.getElementById("tts-results").innerHTML = html;
}

async function runTts() {
  const date = document.getElementById("date-input").value;
  if (!date || idx < 0) return status("投稿を選択してください", "err");
  syncPost();
  const post = data.posts[idx];
  document.getElementById("btn-tts").disabled = true;
  status("🎙 音声生成中...", "running");
  document.getElementById("tts-results").innerHTML = "";
  await saveLocal(true);
  await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, postIdx: idx, post }) });
  const poll = setInterval(async () => {
    const j = await (await fetch("/api/tts-status")).json();
    renderTtsResults(j.results);
    if (j.done || !j.running) {
      clearInterval(poll);
      document.getElementById("btn-tts").disabled = false;
      status(j.results.filter(r => r.ok).length + "件の音声生成完了", "ok");
    }
  }, 1000);
}

async function runTtsScene(scene) {
  const date = document.getElementById("date-input").value;
  if (!date || idx < 0) return;
  syncPost();
  const post = data.posts[idx];
  await saveLocal(true);
  status("🔄 " + scene.toUpperCase() + " 音声生成中...", "running");
  try {
    const res  = await fetch("/api/tts/scene", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date, postIdx: idx, post, scene }) });
    const j    = await res.json();
    // 現在の全結果を取得してシーン分だけ差し替え
    const cur    = await (await fetch("/api/tts-status")).json();
    const prefix = { s1:"S1", s2:"S2", s3:"S3", s4:"S4", s5:"S5" }[scene];
    const merged = cur.results.filter(r => !r.label.startsWith(prefix)).concat(j.results);
    renderTtsResults(merged);
    status(scene.toUpperCase() + " 音声生成完了", "ok");
  } catch(e) {
    status("❌ " + e.message, "err");
  }
}

// ── 動画生成 ──────────────────────────────────────────────────────────────────
async function runVideo() {
  const date = document.getElementById("date-input").value;
  if (!date) return status("日付を選択してください", "err");
  
  // チェックされているインデックスを収集
  const checks = document.querySelectorAll(".post-check:checked");
  const indices = Array.from(checks).map(cb => parseInt(cb.dataset.idx));
  
  if (indices.length === 0) {
    return status("動画を生成する案件にチェックを入れてください", "err");
  }

  if (!confirm(indices.length + "件の動画を生成します（数分かかります）。よろしいですか？")) return;
  
  await saveLocal();
  await fetch("/api/run-video", { 
    method: "POST", 
    headers: { "Content-Type": "application/json" }, 
    body: JSON.stringify({ date, indices }) 
  });
  
  document.getElementById("btn-video").disabled = true;
  status("🎬 動画生成中...", "running");
  showLog(true);
  pollJob(() => { document.getElementById("btn-video").disabled = false; status("🎬 動画生成完了！", "ok"); });
}

function pollJob(onDone) {
  const poll = setInterval(async () => {
    const j = await (await fetch("/api/video-status")).json();
    const logEl = document.getElementById("log-box");
    if (logEl) { logEl.textContent = j.log; logEl.scrollTop = logEl.scrollHeight; }
    if (j.done || !j.running) {
      clearInterval(poll);
      status(j.exitCode === 0 ? "✅ 完了" : "⚠️ 完了（終了コード:" + j.exitCode + "）", j.exitCode === 0 ? "ok" : "err");
      if (onDone) onDone();
    }
  }, 1500);
}

function showLog(show) {
  const el = document.getElementById("log-box");
  if (el) el.style.display = show ? "block" : "none";
}

// ── YouTube投稿ランチャーを開く ───────────────────────────────────────────────
function openYoutubeLauncher() {
  const date = document.getElementById("date-input").value;
  if (!date) return status("日付を選択してください", "err");
  window.open("/youtube?date=" + date, "_blank");
}

// ── 右カラム 画像ギャラリー ────────────────────────────────────────────────────
function renderRightGallery() {
  const el = document.getElementById("rg-gallery");
  if (!el) return;
  if (idx < 0) { el.innerHTML = ""; return; }
  const post  = data.posts[idx];
  const paths = (post.imagePaths || []).filter(Boolean);
  if (!paths.length) {
    el.innerHTML = "<div style='font-size:11px;color:var(--sub);'>画像なし</div>";
    return;
  }
  el.innerHTML = paths.map((p, i) => {
    const fn  = p.replace(/\\\\/g, "/").split("/").pop();
    const url = "/images/" + fn;
    const cm  = post.mainImagePath   === p ? " sel-main" : "";
    const c2  = post.slide2ImagePath === p ? " sel-s2"   : "";
    const c3  = post.slide3ImagePath === p ? " sel-s3"   : "";
    const c4  = post.slide4ImagePath === p ? " sel-s4"   : "";
    const c5  = post.slide5ImagePath === p ? " sel-s5"   : "";
    return "<div class='rg-card" + cm + c2 + c3 + c4 + c5 + "' draggable='true' ondragstart='startDrag(" + i + ")'>" +
      "<img src='" + url + "' onerror='this.dataset.err=1'>" +
      "<div class='rg-btns'>" +
      "<button class='rg-btn rg-b1' data-i='" + i + "' data-slot='main' onclick='assignImgBtn(this)'>S1</button>" +
      "<button class='rg-btn rg-b2' data-i='" + i + "' data-slot='s2'   onclick='assignImgBtn(this)'>S2</button>" +
      "<button class='rg-btn rg-b3' data-i='" + i + "' data-slot='s3'   onclick='assignImgBtn(this)'>S3</button>" +
      "<button class='rg-btn rg-b4' data-i='" + i + "' data-slot='s4'   onclick='assignImgBtn(this)'>S4</button>" +
      "<button class='rg-btn rg-b5' data-i='" + i + "' data-slot='s5'   onclick='assignImgBtn(this)'>S5</button>" +
      "</div></div>";
  }).join("");
}

function assignImgBtn(btn) {
  if (idx < 0) return;
  const i    = parseInt(btn.dataset.i);
  const slot = btn.dataset.slot;
  const post  = data.posts[idx];
  const paths = (post.imagePaths || []).filter(Boolean);
  const p = paths[i];
  if (!p) return;
  if (slot === "main") post.mainImagePath   = p;
  if (slot === "s2")   post.slide2ImagePath = p;
  if (slot === "s3")   post.slide3ImagePath = p;
  if (slot === "s4")   post.slide4ImagePath = p;
  if (slot === "s5")   post.slide5ImagePath = p;
  renderRightGallery();
  schedulePreview();
}

// ── ドラッグ&ドロップ ─────────────────────────────────────────────────────────
function startDrag(i) {
  if (idx < 0) return;
  const paths = (data.posts[idx].imagePaths || []).filter(Boolean);
  draggedPath = paths[i] || null;
}

function onPreviewDragOver(e) {
  e.preventDefault();
  document.getElementById("pv-wrap").classList.add("drag-over");
  const hint = document.getElementById("drop-hint");
  if (!hint) return;
  const names = { 1: "S1", 2: "S2", 3: "S3", 4: "S4", 5: "S5" };
  const name = names[slide] || null;
  if (name) { hint.textContent = "▼ " + name + " に割り当て"; hint.style.display = "block"; }
}

function onPreviewDragLeave(e) {
  document.getElementById("pv-wrap").classList.remove("drag-over");
  const hint = document.getElementById("drop-hint");
  if (hint) hint.style.display = "none";
}

function onPreviewDrop(e, wrap) {
  e.preventDefault();
  wrap.classList.remove("drag-over");
  const hint = document.getElementById("drop-hint");
  if (hint) hint.style.display = "none";
  if (!draggedPath || idx < 0) { draggedPath = null; return; }
  const post = data.posts[idx];
  if (slide === 1)      post.mainImagePath   = draggedPath;
  else if (slide === 2) post.slide2ImagePath = draggedPath;
  else if (slide === 3) post.slide3ImagePath = draggedPath;
  else if (slide === 4) post.slide4ImagePath = draggedPath;
  else if (slide === 5) post.slide5ImagePath = draggedPath;
  draggedPath = null;
  renderRightGallery();
  schedulePreview();
}

window.addEventListener("beforeunload", syncPost);

// ═══════════════════════════════════════════════════════════════
// 案件選択モーダル
// ═══════════════════════════════════════════════════════════════

var candidateData = null;
var _preloadedComments = null;  // 事前取得済みコメント（load-daily-candidates 使用時にセット）

function openCandidateModal() {
  var date = document.getElementById("date-input").value;
  if (!date) { alert("まず日付を選択してください"); return; }
  _preloadedComments = null;
  document.getElementById("candidate-modal").style.display = "block";
  var content = document.getElementById("cm-content");
  content.innerHTML = '<div style="color:#888;padding:20px 0;text-align:center;">Reddit 取得中...</div>';
  document.getElementById("btn-process").disabled = true;
  document.getElementById("cm-count").textContent = "0件選択中";
  document.getElementById("cm-log").style.display = "none";

  fetch("/api/soccer-yt/fetch-candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: date })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.ok) {
      content.innerHTML = '<div style="color:#e66;padding:20px;">エラー: ' + (data.error || "不明") + '</div>';
      return;
    }
    candidateData = data;
    renderCandidates(data);
  })
  .catch(function(e) {
    content.innerHTML = '<div style="color:#e66;padding:20px;">通信エラー: ' + e.message + '</div>';
  });
}

function closeCandidateModal() {
  document.getElementById("candidate-modal").style.display = "none";
}

// ── 事前取得済み日次候補を読み込む ────────────────────────────────────────────
function loadDailyCandidates() {
  var date = document.getElementById("date-input").value;
  if (!date) { alert("まず日付を選択してください"); return; }
  _preloadedComments = null;
  document.getElementById("candidate-modal").style.display = "block";
  var content = document.getElementById("cm-content");
  content.innerHTML = '<div style="color:#888;padding:20px 0;text-align:center;">📥 事前取得済みデータを読み込み中...</div>';
  document.getElementById("btn-process").disabled = true;
  document.getElementById("cm-count").textContent = "0件選択中";
  document.getElementById("cm-log").style.display = "none";
  document.getElementById("cm-source-badge").textContent = "";

  fetch("/api/soccer-yt/load-daily-candidates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: date })
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.ok) {
      content.innerHTML = '<div style="color:#e66;padding:20px;">⚠️ ' + (data.error || "読み込み失敗") + '</div>';
      return;
    }
    _preloadedComments = data.preloadedComments || {};
    candidateData = data;
    var badge = document.getElementById("cm-source-badge");
    if (badge) badge.textContent = "📥 事前取得済み (" + (data.last_updated || "").slice(11,16) + " 更新)";
    renderCandidates(data);
  })
  .catch(function(e) {
    content.innerHTML = '<div style="color:#e66;padding:20px;">通信エラー: ' + e.message + '</div>';
  });
}

function badgeClass(type) {
  var map = { "post-match": "badge-post-match", "transfer": "badge-transfer",
              "injury": "badge-injury", "manager": "badge-manager",
              "finance": "badge-finance", "topic": "badge-topic" };
  return map[type] || "badge-topic";
}

function badgeLabel(type) {
  var map = { "post-match": "試合結果", "transfer": "移籍", "injury": "怪我",
              "manager": "監督", "finance": "財務", "topic": "話題" };
  return map[type] || "話題";
}

function sourceBadgeHtml(source) {
  if (source === "common")  return '<span class="cm-badge badge-src-common">🔗 共通</span>';
  if (source === "reddit")  return '<span class="cm-badge badge-src-reddit">Reddit</span>';
  if (source === "rss")     return '<span class="cm-badge badge-src-rss">ブログ</span>';
  if (source === "x-trend") return '<span class="cm-badge badge-src-x">X</span>';
  return "";
}

function candidateItemHtml(t, id) {
  var permalink  = t.permalink || (t.reddit && t.reddit.permalink) || "";
  var fivechUrl  = (t.fivech && t.fivech.url) || t.url || "";
  var title      = t.title || (t.reddit && t.reddit.title) || "";
  var titleJa    = t.titleJa || (t.reddit && t.reddit.titleJa) || title;
  var score      = t.score || (t.reddit && t.reddit.score) || 0;
  var created    = t.created_utc || (t.reddit && t.reddit.created_utc) || 0;
  var metaText   = t.source === "5ch"
    ? "レス" + ((t.resCount || t.fivech && t.fivech.resCount) || 0)
    : "▲" + score.toLocaleString();
  var timeText = "";
  if (created) {
    var hOld = (Date.now() / 1000 - created) / 3600;
    if (hOld < 1) timeText = " · " + Math.round(hOld * 60) + "m前";
    else if (hOld < 24) timeText = " · " + Math.round(hOld) + "h前";
    else timeText = " · " + Math.round(hOld / 24) + "d前";
  }
  return '<div class="cm-item" id="' + id + '" onclick="toggleCandidate(this)">' +
    '<input type="checkbox"' +
      ' data-type="'       + esc(t.type || "topic")  + '"' +
      ' data-source="'     + esc(t.source || "reddit") + '"' +
      ' data-permalink="'  + esc(permalink)            + '"' +
      ' data-fivech-url="' + esc(fivechUrl)            + '"' +
      ' data-title="'      + esc(title)                + '"' +
      ' data-title-ja="'   + esc(titleJa)              + '"' +
      ' data-created="'    + (created || 0)            + '"' +
      ' data-score="'      + (score   || 0)            + '">' +
    '<span class="cm-badge ' + badgeClass(t.type) + '">' + badgeLabel(t.type) + '</span>' +
    sourceBadgeHtml(t.source) +
    '<span class="cm-title">' + esc(titleJa.slice(0, 90)) + '</span>' +
    '<span class="cm-meta">' + metaText + timeText + '</span>' +
    (t.rssMatch ? '<span class="cm-rss-match">📰 ' + esc((t.rssMatch.title || "").slice(0, 60)) + '</span>' : '') +
    '</div>';
}

function renderCandidates(data) {
  var content = document.getElementById("cm-content");
  var html = "";

  var com = data.commonTopics || [];
  var pm  = data.postMatchThreads || [];
  var rdt = data.redditTopics || data.topicThreads || [];
  var rss = data.rssTopics || [];

  if (com.length) {
    html += '<div class="cm-section-title">🔗 共通ネタ（Reddit＆国内ブログ） (' + com.length + '件)</div>';
    com.forEach(function(t, i) { html += candidateItemHtml(t, "ci-com-" + i); });
  }

  html += '<div class="cm-section-title">⚽ ポストマッチ (' + pm.length + '件)</div>';
  if (!pm.length) html += '<div style="color:#666;font-size:12px;padding:8px;">見つかりませんでした</div>';
  pm.forEach(function(t, i) { html += candidateItemHtml(t, "ci-pm-" + i); });

  if (rdt.length) {
    html += '<div class="cm-section-title">🌐 Reddit トピック (' + rdt.length + '件)</div>';
    rdt.forEach(function(t, i) { html += candidateItemHtml(t, "ci-rdt-" + i); });
  }
  if (rss.length) {
    html += '<div class="cm-section-title">📰 国内ブログ (' + rss.length + '件)</div>';
    rss.forEach(function(t, i) { html += candidateItemHtml(t, "ci-rss-" + i); });
  }

  content.innerHTML = html;
  updateCandidateCount();
}

function toggleCandidate(el) {
  var cb = el.querySelector("input[type=checkbox]");
  if (!cb) return;
  cb.checked = !cb.checked;
  el.classList.toggle("checked", cb.checked);
  updateCandidateCount();
}

function updateCandidateCount() {
  var checked = document.querySelectorAll("#cm-content input[type=checkbox]:checked");
  var n = checked.length;
  document.getElementById("cm-count").textContent = n + "件選択中";
  document.getElementById("btn-process").disabled = (n === 0);
  document.getElementById("btn-process").textContent = "自動生成（" + n + "件）";
}

function processSelected() {
  var date = document.getElementById("date-input").value;
  var checked = document.querySelectorAll("#cm-content input[type=checkbox]:checked");
  if (!checked.length) return;

  var threads = [];
  checked.forEach(function(cb) {
    threads.push({
      permalink:   cb.dataset.permalink  || "",
      fivechUrl:   cb.dataset.fivechUrl  || "",
      source:      cb.dataset.source     || "reddit",
      type:        cb.dataset.type       || "topic",
      title:       cb.dataset.title      || "",
      titleJa:     cb.dataset.titleJa    || cb.dataset.title || "",
      created_utc: parseInt(cb.dataset.created) || 0,
      score:       parseInt(cb.dataset.score)   || 0,
    });
  });

  document.getElementById("btn-process").disabled = true;
  document.getElementById("btn-process").textContent = "処理中...";
  var logEl = document.getElementById("cm-log");
  logEl.style.display = "block";
  logEl.textContent = "処理開始...";

  // 事前取得済みコメントがあれば import-selected（Reddit再取得スキップ）を使う
  var endpoint = _preloadedComments ? "/api/soccer-yt/import-selected" : "/api/soccer-yt/process-selected";
  var body = { date: date, threads: threads };
  if (_preloadedComments) body.preloadedComments = _preloadedComments;

  fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    if (!data.ok) {
      logEl.textContent = "エラー: " + (data.message || "不明");
      return;
    }
    // 進捗ポーリング
    var poll = setInterval(function() {
      fetch("/api/video-status").then(function(r) { return r.json(); }).then(function(j) {
        logEl.textContent = j.log || "";
        logEl.scrollTop = logEl.scrollHeight;
        if (j.done || !j.running) {
          clearInterval(poll);
          var ok = j.exitCode === 0;
          document.getElementById("btn-process").disabled = false;
          document.getElementById("btn-process").textContent = ok ? "✅ 完了！読み込んで確認してください" : "⚠️ エラー";
          if (ok) {
            setTimeout(function() { closeCandidateModal(); loadContent(); }, 1200);
          }
        }
      });
    }, 1500);
  })
  .catch(function(e) {
    logEl.textContent = "通信エラー: " + e.message;
  });
}

// ── モバイルパネル切り替え ─────────────────────────────────────────────────────
const MOB_PANELS = { sidebar: '.sidebar', editor: '.editor-col', preview: '.preview-col' };
const MOB_TABS   = { sidebar: 'mobtab-list', editor: 'mobtab-editor', preview: 'mobtab-preview' };

function isMobile() { return window.innerWidth <= 767; }

function switchMobPanel(panel) {
  if (!isMobile()) return;
  Object.entries(MOB_PANELS).forEach(function([k, sel]) {
    document.querySelector(sel).classList.toggle('mob-active', k === panel);
    document.getElementById(MOB_TABS[k]).classList.toggle('active', k === panel);
  });
  if (panel === 'preview') scaleMobilePreview();
}

function scaleMobilePreview() {
  if (!isMobile()) return;
  const wrap   = document.getElementById('pv-wrap');
  const iframe = document.getElementById('pv-frame');
  if (!wrap || !iframe) return;
  const scale  = window.innerWidth / 1920;
  wrap.style.height = Math.round(1080 * scale) + 'px';
  iframe.style.transform = 'scale(' + scale + ')';
}

function initMobile() {
  if (!isMobile()) return;
  switchMobPanel('editor');
}

window.addEventListener('resize', function() { if (isMobile()) scaleMobilePreview(); });
window.addEventListener('DOMContentLoaded', initMobile);
initMobile();

// ── Reddit をブラウザから直接取得するユーティリティ ────────────────────────────
function redditClientFetch(url) {
  return fetch(url).then(function(r) {
    if (!r.ok) throw new Error("Reddit HTTP " + r.status);
    return r.json();
  });
}

function buildThreadObj(p, sub) {
  var nowSec = Date.now() / 1000;
  var hoursOld = Math.round((nowSec - p.created_utc) / 360) / 10;
  return {
    source: "reddit", type: "topic",
    title: p.title, titleJa: p.title,
    permalink: p.permalink,
    url: "https://www.reddit.com" + p.permalink,
    score: p.score, hoursOld: hoursOld,
    created_utc: p.created_utc,
    numComments: p.num_comments,
    subreddit: sub || p.subreddit,
    comments: [],
  };
}

// ── ワード検索 ─────────────────────────────────────────────────────────────────
function openWordSearch() {
  var date = document.getElementById("date-input").value;
  if (!date) { alert("まず日付を選択してください"); return; }
  _preloadedComments = null;
  document.getElementById("candidate-modal").style.display = "block";
  document.getElementById("cm-source-badge").textContent = "🔍 ワード検索";
  document.getElementById("cm-count").textContent = "0件選択中";
  document.getElementById("btn-process").disabled = true;
  document.getElementById("cm-log").style.display = "none";
  document.getElementById("cm-content").innerHTML =
    '<div style="padding:12px 0;">' +
    '<div style="display:flex;gap:8px;margin-bottom:8px;">' +
    '<input id="cm-search-input" type="text" placeholder="例：ハーランド、移籍、Champions League..." ' +
    'style="flex:1;background:#111;border:1px solid #444;color:#e0e0e0;padding:7px 10px;border-radius:6px;font-size:13px;" ' +
    'onkeydown="if(event.keyCode===13)doWordSearch()">' +
    '<button onclick="doWordSearch()" style="background:#4a90e2;color:#fff;border:none;padding:7px 16px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;">検索</button>' +
    '</div>' +
    '<div style="font-size:11px;color:#666;">日本語もOK（自動で英訳してReddit検索します）</div>' +
    '</div>' +
    '<div id="cm-search-results"></div>';
  setTimeout(function() {
    var inp = document.getElementById("cm-search-input");
    if (inp) inp.focus();
  }, 50);
}

function doWordSearch() {
  var q = ((document.getElementById("cm-search-input") || {}).value || "").trim();
  if (!q) return;
  var resultsEl = document.getElementById("cm-search-results");
  if (!resultsEl) return;
  resultsEl.innerHTML = '<div style="color:#888;padding:20px 0;text-align:center;">🔍 検索中...</div>';
  document.getElementById("btn-process").disabled = true;

  var hasJapanese = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(q);
  var translatePromise = hasJapanese
    ? fetch("/api/soccer-yt/translate-query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q })
      }).then(function(r) { return r.json(); }).then(function(d) { return d.translatedQuery || q; })
    : Promise.resolve(q);

  translatePromise.then(function(engQuery) {
    var encoded = encodeURIComponent(engQuery);
    return redditClientFetch(
      "https://www.reddit.com/r/soccer+football+PremierLeague+LaLiga+Bundesliga+SerieA/search.json?q=" + encoded + "&restrict_sr=1&sort=hot&t=month&limit=30"
    ).then(function(json) {
      var threads = (json.data && json.data.children || [])
        .filter(function(c) { return !c.data.stickied; })
        .slice(0, 25)
        .map(function(c) { return buildThreadObj(c.data); });

      if (!threads.length) {
        resultsEl.innerHTML = '<div style="color:#888;padding:20px 0;text-align:center;">該当スレッドが見つかりませんでした</div>';
        return;
      }
      var label = engQuery !== q
        ? esc(q) + " → " + esc(engQuery)
        : esc(q);
      var html = '<div class="cm-section-title">🔍 検索結果 (' + threads.length + '件) — ' + label + '</div>';
      threads.forEach(function(t, i) { html += candidateItemHtml(t, "ci-srch-" + i); });
      resultsEl.innerHTML = html;
      updateCandidateCount();
    });
  }).catch(function(e) {
    resultsEl.innerHTML = '<div style="color:#e66;padding:20px;">エラー: ' + e.message + '</div>';
  });
}

// ── スレッド一覧 ───────────────────────────────────────────────────────────────
function loadRedditTop() {
  var date = document.getElementById("date-input").value;
  if (!date) { alert("まず日付を選択してください"); return; }
  _preloadedComments = null;
  document.getElementById("candidate-modal").style.display = "block";
  var content = document.getElementById("cm-content");
  content.innerHTML = '<div style="color:#888;padding:20px 0;text-align:center;">📋 Reddit 上位スレ取得中...</div>';
  document.getElementById("btn-process").disabled = true;
  document.getElementById("cm-count").textContent = "0件選択中";
  document.getElementById("cm-source-badge").textContent = "📋 スレッド一覧";
  document.getElementById("cm-log").style.display = "none";

  var SUBS = ["soccer", "football", "PremierLeague", "LaLiga", "Bundesliga"];
  var WINDOWS = [6, 12];
  var TARGET = 30;

  Promise.allSettled(
    SUBS.map(function(sub) {
      return redditClientFetch("https://www.reddit.com/r/" + sub + "/hot.json?limit=50")
        .then(function(json) {
          return (json.data && json.data.children || []).map(function(c) {
            return { data: c.data, sub: sub };
          });
        })
        .catch(function() { return []; });
    })
  ).then(function(results) {
    var nowSec = Date.now() / 1000;
    var seenIds = {};
    var posts = [];
    results.forEach(function(r) {
      if (r.status !== "fulfilled") return;
      r.value.forEach(function(item) {
        var p = item.data;
        if (p.stickied || p.score < 10 || seenIds[p.id]) return;
        seenIds[p.id] = true;
        posts.push({ p: p, sub: item.sub });
      });
    });

    // ウォーターフォール 6h → 12h
    var win = WINDOWS[0];
    var fresh = posts.filter(function(x) { return (nowSec - x.p.created_utc) <= win * 3600; });
    if (fresh.length < 10) {
      win = WINDOWS[1];
      fresh = posts.filter(function(x) { return (nowSec - x.p.created_utc) <= win * 3600; });
    }

    // velocity降順で30件
    var threads = fresh
      .map(function(x) {
        var h = Math.max((nowSec - x.p.created_utc) / 3600, 0.5);
        return { obj: buildThreadObj(x.p, x.sub), vel: x.p.score / h };
      })
      .sort(function(a, b) { return b.vel - a.vel; })
      .slice(0, TARGET)
      .map(function(x) { return x.obj; });

    if (!threads.length) {
      content.innerHTML = '<div style="color:#888;padding:20px 0;text-align:center;">スレッドが取得できませんでした</div>';
      return;
    }
    var html = '<div class="cm-section-title">⚡ 急上昇スレ (' + threads.length + '件・' + win + '時間以内)</div>';
    threads.forEach(function(t, i) { html += candidateItemHtml(t, "ci-top-" + i); });
    content.innerHTML = html;
    updateCandidateCount();
  }).catch(function(e) {
    content.innerHTML = '<div style="color:#e66;padding:20px;">エラー: ' + e.message + '</div>';
  });
}
</script>

<!-- 案件選択モーダル -->
<div id="candidate-modal">
  <div class="cm-box">
    <div class="cm-head">
      <h2>📋 案件選択</h2>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span id="cm-source-badge" style="font-size:11px;color:#a78bfa;background:rgba(139,92,246,0.15);padding:3px 10px;border-radius:12px;"></span>
        <button onclick="loadDailyCandidates()" style="background:#1a3a2a;color:#4ade80;border:1px solid #2a5a3a;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:700;">📥 事前取得済み</button>
        <button onclick="loadRedditTop()" style="background:#1a2a3a;color:#60c0f0;border:1px solid #2a4a6a;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:700;">📋 スレッド一覧</button>
        <button onclick="openWordSearch()" style="background:#2a1a3a;color:#c084fc;border:1px solid #4a2a6a;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-weight:700;">🔍 ワード検索</button>
        <button class="cm-close" onclick="closeCandidateModal()">✕</button>
      </div>
    </div>
    <div id="cm-content" style="min-height:80px;"></div>
    <div class="cm-footer">
      <span class="cm-count" id="cm-count">0件選択中</span>
      <button id="btn-process" onclick="processSelected()" disabled>自動生成（0件）</button>
    </div>
    <div id="cm-log"></div>
  </div>
</div>

</body></html>`);
});


// ─── Match Center: 画像リスト API ─────────────────────────────────────────────
app.get("/api/match-center/list/:date", (req, res) => {
  const date    = req.params.date;
  const files   = fs.existsSync(MC_DIR)
    ? fs.readdirSync(MC_DIR).filter(f => f.startsWith(date) && f.endsWith(".png")).sort()
    : [];
  const indexFile = path.join(TEMP_DIR, `match_center_${date}.json`);
  let meta = {};
  if (fs.existsSync(indexFile)) {
    try { meta = JSON.parse(fs.readFileSync(indexFile, "utf8")); } catch {}
  }
  const matches = (meta.matches || []);
  const items   = files.map(fn => {
    const fid   = parseInt(fn.replace(`${date}_`, "").replace(".png", ""));
    const m     = matches.find(x => x.fixtureId === fid) || {};
    return { file: fn, url: `/match-center-images/${fn}`, fixtureId: fid, ...m };
  });
  res.json({ date, items });
});

// ─── Match Center: ギャラリーページ ──────────────────────────────────────────
app.get("/match-center", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Match Center Gallery</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0d0d0d;color:#e0e0e0;font-family:system-ui,sans-serif;padding:16px;}
h1{font-size:18px;font-weight:700;margin-bottom:12px;color:#fff;}
.controls{display:flex;gap:8px;align-items:center;margin-bottom:16px;flex-wrap:wrap;}
input[type=date]{background:#1a1a1a;border:1px solid #333;color:#e0e0e0;padding:6px 10px;border-radius:6px;font-size:13px;}
button{background:#1a6ef5;color:#fff;border:none;padding:7px 16px;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600;}
button:hover{background:#1558c9;}
.btn-run{background:#2e7d32;} .btn-run:hover{background:#1b5e20;}
.status{font-size:12px;color:#888;margin-left:4px;}
.grid{display:flex;flex-wrap:wrap;gap:12px;}
.card{background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;cursor:pointer;transition:border-color .15s;}
.card:hover{border-color:#555;}
.card img{display:block;width:640px;height:360px;object-fit:cover;}
.card .info{padding:8px 10px;font-size:12px;color:#aaa;}
.card .score{font-size:15px;font-weight:700;color:#fff;margin-bottom:2px;}
.empty{color:#555;font-size:13px;padding:20px 0;}
</style></head><body>
<h1>Match Center Gallery</h1>
<div class="controls">
  <input type="date" id="dt" value="${today}">
  <button onclick="load()">読み込み</button>
  <button class="btn-run" onclick="runFetch()">取得・生成</button>
  <span class="status" id="status"></span>
</div>
<div class="grid" id="grid"><div class="empty">日付を選んで「読み込み」してください</div></div>
<script>
async function load() {
  const date = document.getElementById("dt").value;
  document.getElementById("status").textContent = "読み込み中...";
  const res  = await fetch("/api/match-center/list/" + date);
  const data = await res.json();
  const grid = document.getElementById("grid");
  if (!data.items.length) {
    grid.innerHTML = "<div class='empty'>画像なし（「取得・生成」で生成できます）</div>";
    document.getElementById("status").textContent = "0件";
    return;
  }
  grid.innerHTML = data.items.map(item => \`
    <div class="card" onclick="window.open('\${item.url}','_blank')">
      <img src="\${item.url}" loading="lazy">
      <div class="info">
        <div class="score">\${item.home || ""} \${item.score || ""} \${item.away || ""}</div>
        <div>\${item.league || ""} · \${item.status || ""}</div>
      </div>
    </div>\`).join("");
  document.getElementById("status").textContent = data.items.length + "件";
}
async function runFetch() {
  const date = document.getElementById("dt").value;
  document.getElementById("status").textContent = "生成中（しばらくかかります）...";
  const res  = await fetch("/api/match-center/run", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ date }) });
  const data = await res.json();
  document.getElementById("status").textContent = data.message || "完了";
  await load();
}
load();
</script></body></html>`);
});

// ─── Match Center: スクリプト実行 ─────────────────────────────────────────────
app.post("/api/match-center/run", (req, res) => {
  const { date, leagues } = req.body;
  const dateStr = date || new Date().toISOString().slice(0, 10);
  const script  = path.join(__dirname, "scripts", "fetch_match_center.js");
  const args    = leagues ? [dateStr, leagues] : [dateStr];
  const child   = spawn("node", [script, ...args], { cwd: __dirname });
  let out = "";
  child.stdout.on("data", d => { out += d.toString(); process.stdout.write(d); });
  child.stderr.on("data", d => { out += d.toString(); process.stderr.write(d); });
  child.on("close", code => {
    res.json({ ok: code === 0, message: code === 0 ? "生成完了！" : "エラー（コンソール確認）", log: out });
  });
});

// ─── 事前取得済み日次候補を読み込む ──────────────────────────────────────────
// fetch_daily_candidates.js がローカルPCで取得してSCP送信した
// temp/candidates_YYYY-MM-DD.json を読み込んでランチャーに渡す
app.post("/api/soccer-yt/load-daily-candidates", (req, res) => {
  const { date } = req.body;
  if (!date) return res.json({ ok: false, error: "date が指定されていません" });

  const file = path.join(TEMP_DIR, `candidates_${date}.json`);
  if (!fs.existsSync(file)) {
    return res.json({
      ok:    false,
      error: `candidates_${date}.json が見つかりません。ローカルPCからSCP送信されているか確認してください（temp/ フォルダ）`,
    });
  }

  try {
    const raw  = JSON.parse(fs.readFileSync(file, "utf8"));
    const LEAGUE_KW = ["Premier League","La Liga","Bundesliga","Ligue 1","Serie A",
      "Champions League","Europa League","Conference League","World Cup","FA Cup","Copa del Rey"];

    function detectType(title) {
      const lower = title.toLowerCase();
      const isPost  = lower.includes("post match thread") || lower.includes("post-match thread");
      const hasLeague = LEAGUE_KW.some(k => title.includes(k));
      if (isPost && hasLeague) return "post-match";
      if (/transfer|signs for|joins|loan deal|contract extension|here we go/i.test(lower)) return "transfer";
      if (/injur|ruled out|muscle|hamstring|knee|ligament/i.test(lower)) return "injury";
      if (/sacked|fired|resign|appointed|new manager|new head coach/i.test(lower)) return "manager";
      if (/\bffp\b|financial fair play|ban|suspend|charged|breach/i.test(lower)) return "finance";
      return "topic";
    }

    const posts = (raw.posts || []).map(p => ({
      ...p,
      type: detectType(p.title || ""),
    }));

    // preloadedComments: permalink → { selftext, comments: string[] }
    // generate_content.js が fetchThreadFull() の代わりに使う
    const preloadedComments = {};
    for (const p of posts) {
      if (p.permalink && p.comments?.length) {
        preloadedComments[p.permalink] = {
          selftext: "",
          comments: p.comments.map(c => `[👍${c.score || 0}] ${c.body || ""}`),
        };
      }
    }

    // renderCandidates() が期待するフォーマットに変換
    const postMatchThreads = posts.filter(p => p.type === "post-match");
    const redditTopics     = posts.filter(p => p.source === "reddit" && p.type !== "post-match");
    const rssTopics        = posts.filter(p => p.source === "rss");

    res.json({
      ok:               true,
      date:             raw.date,
      last_updated:     raw.last_updated || raw.created_at || "",
      source:           "daily-fetch",
      commonTopics:     [],
      postMatchThreads,
      redditTopics,
      rssTopics,
      preloadedComments,
    });
  } catch (e) {
    res.json({ ok: false, error: `JSON解析エラー: ${e.message}` });
  }
});

// ─── 画像取得ジョブ起動（ローカルPCのSCP送信後に呼ばれる） ────────────────────
app.post("/api/soccer-yt/start-image-fetch", (req, res) => {
  const { date } = req.body;
  if (!date) return res.json({ ok: false, error: "date が必要です" });

  const contentFile = path.join(TEMP_DIR, `content_${date}.json`);
  if (!fs.existsSync(contentFile)) {
    return res.json({ ok: false, error: `content_${date}.json が見つかりません` });
  }
  if (imgFetchJob.running) {
    return res.json({ ok: false, error: `画像取得ジョブが既に実行中です (${imgFetchJob.date})` });
  }

  imgFetchJob = { running: true, log: [], done: false, exitCode: null, date };
  const script = path.join(__dirname, "scripts", "fetch_images_for_content.js");
  const proc   = spawn(process.execPath, [script, date], { cwd: __dirname, env: process.env });
  proc.stdout.on("data", d => { process.stdout.write(d); imgFetchJob.log.push(d.toString()); });
  proc.stderr.on("data", d => { process.stderr.write(d); imgFetchJob.log.push(d.toString()); });
  proc.on("close", code => {
    imgFetchJob.running  = false;
    imgFetchJob.done     = true;
    imgFetchJob.exitCode = code;
    fs.writeFileSync(LOG_FILE, `[画像取得 ${date} ${new Date().toLocaleString("ja-JP")}]\n` + imgFetchJob.log.join(""), { flag: "a" });
    console.log(`[画像取得] 完了 exit:${code}`);
  });

  res.json({ ok: true, message: `画像取得ジョブ開始: ${date}` });
});

// ─── 画像取得ジョブ状態確認 ──────────────────────────────────────────────────
app.get("/api/img-fetch-status", (req, res) => {
  res.json({
    running:  imgFetchJob.running,
    done:     imgFetchJob.done,
    exitCode: imgFetchJob.exitCode,
    date:     imgFetchJob.date,
    log:      imgFetchJob.log.join("").slice(-3000),
  });
});

// ─── 案件候補取得 ─────────────────────────────────────────────────────────────
app.post("/api/soccer-yt/fetch-candidates", (req, res) => {
  const { date } = req.body;
  const script   = path.join(__dirname, "scripts", "fetch_candidates.js");
  const args     = date ? [script, date] : [script];
  let stdout = "", stderr = "";
  const proc = spawn(process.execPath, args, { cwd: __dirname, env: process.env });
  proc.stdout.on("data", d => { stdout += d.toString(); });
  proc.stderr.on("data", d => { stderr += d.toString(); });
  proc.on("close", code => {
    if (code !== 0) return res.json({ ok: false, error: stderr.slice(0, 300) });
    try {
      // dotenv v17 が stdout にログを出すことがあるため JSON 部分のみ抽出
      const jsonMatch = stdout.match(/(\{[\s\S]*\})/);
      if (!jsonMatch) throw new Error("JSON not found in output");
      const data = JSON.parse(jsonMatch[1]);
      res.json({ ok: true, ...data });
    } catch (e) {
      res.json({ ok: false, error: "Parse error: " + stdout.slice(0, 200) });
    }
  });
});

// ─── 選択済みスレッド処理 ───────────────────────────────────────────────────
app.post("/api/soccer-yt/process-selected", (req, res) => {
  const { date, threads } = req.body;
  if (!threads?.length) return res.json({ ok: false, message: "スレッドが選択されていません" });
  if (videoJob.running)  return res.json({ ok: false, message: "別のジョブが実行中です" });

  const tmpFile = path.join(TEMP_DIR, `selected_${date}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ date, threads }, null, 2));

  videoJob = { running: true, log: [], done: false, exitCode: null };
  const script = path.join(__dirname, "scripts", "generate_content.js");
  const proc   = spawn(process.execPath, [script, `--selected=${tmpFile}`, date], { cwd: __dirname, env: process.env });
  proc.stdout.on("data", d => videoJob.log.push(d.toString()));
  proc.stderr.on("data", d => videoJob.log.push(d.toString()));
  proc.on("close", code => {
    videoJob.running  = false;
    videoJob.done     = true;
    videoJob.exitCode = code;
    fs.writeFileSync(LOG_FILE, `[案件生成 ${new Date().toLocaleString("ja-JP")}]\n` + videoJob.log.join(""));
  });
  res.json({ ok: true });
});

// ─── ホームランチャーからの案件インポート ────────────────────────────────────
app.post("/api/soccer-yt/import-selected", (req, res) => {
  const { date, threads, preloadedComments } = req.body;
  if (!threads?.length) return res.json({ ok: false, message: "スレッドが選択されていません" });
  if (videoJob.running)  return res.json({ ok: false, message: "別のジョブが実行中です" });

  const tmpFile = path.join(TEMP_DIR, `selected_${date}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify({ date, threads, preloadedComments: preloadedComments || {} }, null, 2));

  videoJob = { running: true, log: [], done: false, exitCode: null };
  const script = path.join(__dirname, "scripts", "generate_content.js");
  const proc   = spawn(process.execPath, [script, `--selected=${tmpFile}`, date], { cwd: __dirname, env: process.env });
  proc.stdout.on("data", d => videoJob.log.push(d.toString()));
  proc.stderr.on("data", d => videoJob.log.push(d.toString()));
  proc.on("close", code => {
    videoJob.running  = false;
    videoJob.done     = true;
    videoJob.exitCode = code;
    fs.writeFileSync(LOG_FILE, `[ホームインポート ${new Date().toLocaleString("ja-JP")}]\n` + videoJob.log.join(""));
  });
  res.json({ ok: true });
});

// ─── Reddit fetch helper（プロキシフォールバック付き） ────────────────────────
async function redditFetch(url) {
  const headers = { "User-Agent": "soccer-news-bot/1.0" };
  const proxy   = process.env.REDDIT_PROXY_URL || null;

  // まず直接アクセス
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) return res.json();
  } catch { /* fallthrough to proxy */ }

  // プロキシ経由フォールバック
  if (proxy) {
    const proxyUrl = `${proxy}/fetch?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) return res.json();
    throw new Error(`Reddit proxy HTTP ${res.status}`);
  }

  throw new Error("Reddit fetch failed (no proxy configured)");
}

// ─── 翻訳クエリ API（日本語→英語、ブラウザ側のワード検索で使用） ────────────
app.post("/api/soccer-yt/translate-query", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ ok: false, translatedQuery: query });
  try {
    const { callAI } = require("./scripts/ai_client");
    const raw = await callAI({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: "Translate to English for Reddit soccer search (return only the translation, no explanation): " + query }],
    });
    const translatedQuery = raw.trim().replace(/^["'「」]|["'「」]$/g, "");
    res.json({ ok: true, translatedQuery });
  } catch (e) {
    res.json({ ok: false, translatedQuery: query, error: e.message });
  }
});

// ─── ワード検索 API ───────────────────────────────────────────────────────────
app.post("/api/soccer-yt/reddit-search", async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ ok: false, error: "query が指定されていません" });

  try {
    // 日本語・漢字・ひらがな・カタカナ含む場合は英訳
    const hasJapanese = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(query);
    let translatedQuery = query;
    if (hasJapanese) {
      const { callAI } = require("./scripts/ai_client");
      const raw = await callAI({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        messages: [{ role: "user", content: `Translate the following to English for a Reddit soccer search query (return only the translated text, no explanation): ${query}` }],
      });
      translatedQuery = raw.trim().replace(/^["'「」]|["'「」]$/g, "");
    }

    const encoded = encodeURIComponent(translatedQuery);
    const json = await redditFetch(
      `https://www.reddit.com/r/soccer+football+PremierLeague+LaLiga+Bundesliga+SerieA/search.json?q=${encoded}&restrict_sr=1&sort=hot&t=month&limit=30`
    );

    const nowSec = Date.now() / 1000;
    const threads = (json.data?.children || [])
      .map(c => c.data)
      .filter(p => !p.stickied)
      .slice(0, 25)
      .map(p => {
        const hoursOld = (nowSec - p.created_utc) / 3600;
        return {
          source:      "reddit",
          type:        "topic",
          title:       p.title,
          titleJa:     p.title,
          permalink:   p.permalink,
          url:         "https://www.reddit.com" + p.permalink,
          score:       p.score,
          hoursOld:    Math.round(hoursOld * 10) / 10,
          created_utc: p.created_utc,
          numComments: p.num_comments,
          comments:    [],
        };
      });

    res.json({ ok: true, threads, translatedQuery });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── スレッド一覧 API ─────────────────────────────────────────────────────────
app.post("/api/soccer-yt/reddit-top", async (req, res) => {
  const SUBREDDITS = ["soccer", "football", "PremierLeague", "LaLiga", "Bundesliga", "SerieA"];
  const WINDOWS    = [6, 12]; // 6h以内 → 足りなければ12h
  const TARGET     = 30;
  const MIN_SCORE  = 10;

  try {
    const nowSec = Date.now() / 1000;

    const results = await Promise.allSettled(
      SUBREDDITS.map(sub =>
        redditFetch(`https://www.reddit.com/r/${sub}/hot.json?limit=50`)
          .then(json => (json.data?.children || []).map(c => ({ ...c.data, _sub: sub })))
          .catch(() => [])
      )
    );

    // 全サブレをマージ・重複除去（同一スレIDを1件に）
    const seenIds = new Set();
    let posts = results
      .filter(r => r.status === "fulfilled")
      .flatMap(r => r.value)
      .filter(p => {
        if (p.stickied || p.score < MIN_SCORE) return false;
        if (seenIds.has(p.id)) return false;
        seenIds.add(p.id);
        return true;
      });

    // ウォーターフォール: 6h → 12h
    let window = WINDOWS[0];
    let fresh = posts.filter(p => (nowSec - p.created_utc) <= window * 3600);
    if (fresh.length < 10) {
      window = WINDOWS[1];
      fresh = posts.filter(p => (nowSec - p.created_utc) <= window * 3600);
    }

    // velocity（upvotes/h）降順で30件
    const threads = fresh
      .map(p => {
        const hoursOld = Math.max((nowSec - p.created_utc) / 3600, 0.5);
        return { ...p, _velocity: Math.round(p.score / hoursOld), _hoursOld: Math.round(hoursOld * 10) / 10 };
      })
      .sort((a, b) => b._velocity - a._velocity)
      .slice(0, TARGET)
      .map(p => ({
        source:      "reddit",
        type:        "topic",
        title:       p.title,
        titleJa:     p.title,
        permalink:   p.permalink,
        url:         "https://www.reddit.com" + p.permalink,
        score:       p.score,
        hoursOld:    p._hoursOld,
        created_utc: p.created_utc,
        numComments: p.num_comments,
        subreddit:   p._sub,
        comments:    [],
      }));

    res.json({ ok: true, threads, window });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ─── 最終ログ取得 ─────────────────────────────────────────────────────────────
app.get("/api/last-log", (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json({ ok: false, log: "ログファイルがありません" });
  res.json({ ok: true, log: fs.readFileSync(LOG_FILE, "utf8") });
});

// ─── 動画一覧API ──────────────────────────────────────────────────────────────
app.get("/api/videos", (req, res) => {
  if (!fs.existsSync(VIDEO_DIR)) return res.json({ videos: [] });
  const files = fs.readdirSync(VIDEO_DIR)
    .filter(f => f.endsWith(".mp4"))
    .sort((a, b) => b.localeCompare(a))
    .map(f => {
      const thumb = f.replace(".mp4", "_thumb.png");
      return {
        name: f,
        url: `/video-files/${f}`,
        thumb: fs.existsSync(path.join(VIDEO_DIR, thumb)) ? `/video-files/${thumb}` : null,
        size: Math.round(fs.statSync(path.join(VIDEO_DIR, f)).size / 1024 / 1024 * 10) / 10,
      };
    });
  res.json({ videos: files });
});

// ─── 動画一覧ページ ───────────────────────────────────────────────────────────
app.get("/videos", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>🎬 動画一覧</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: sans-serif; background: #0d0d1a; color: #eee; padding: 12px; max-width: 700px; margin: 0 auto; }
h1 { font-size: 18px; margin-bottom: 14px; color: #e94560; }
.back { display: inline-block; margin-bottom: 14px; color: #aaa; font-size: 13px; text-decoration: none; }
.card { background: #16213e; border-radius: 10px; margin-bottom: 16px; overflow: hidden; }
.thumb { width: 100%; aspect-ratio: 16/9; background: #0a0a1a; object-fit: cover; display: block; }
.thumb-placeholder { width: 100%; aspect-ratio: 16/9; background: #0a0a1a; display: flex; align-items: center; justify-content: center; font-size: 40px; }
.info { padding: 10px 12px; }
.filename { font-size: 13px; color: #ccc; margin-bottom: 8px; word-break: break-all; }
.meta { font-size: 11px; color: #888; margin-bottom: 10px; }
.btns { display: flex; gap: 8px; }
button, a.btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 13px; font-weight: bold; text-decoration: none; display: inline-block; }
.btn-play { background: #e94560; color: #fff; }
.btn-dl { background: #0f3460; color: #eee; }
.player-wrap { display: none; padding: 0 12px 12px; }
video { width: 100%; border-radius: 6px; }
.empty { text-align: center; padding: 40px; color: #666; }
</style>
</head>
<body>
<a href="/" class="back">← ランチャーに戻る</a>
<h1>🎬 生成済み動画</h1>
<div id="list"><div class="empty">読み込み中...</div></div>
<script>
async function load() {
  const res = await fetch('/api/videos');
  const { videos } = await res.json();
  const el = document.getElementById('list');
  if (!videos.length) { el.innerHTML = '<div class="empty">動画がまだありません</div>'; return; }
  el.innerHTML = videos.map((v, i) => \`
    <div class="card">
      \${v.thumb
        ? '<img class="thumb" src="' + v.thumb + '" loading="lazy">'
        : '<div class="thumb-placeholder">🎬</div>'}
      <div class="info">
        <div class="filename">\${v.name}</div>
        <div class="meta">\${v.size} MB</div>
        <div class="btns">
          <button class="btn-play" onclick="togglePlay(\${i})">▶ 再生</button>
          <a class="btn btn-dl" href="\${v.url}" download="\${v.name}">⬇ DL</a>
        </div>
      </div>
      <div class="player-wrap" id="pw_\${i}">
        <video controls src="\${v.url}" id="vid_\${i}"></video>
      </div>
    </div>
  \`).join('');
}
function togglePlay(i) {
  const pw = document.getElementById('pw_' + i);
  const vid = document.getElementById('vid_' + i);
  const open = pw.style.display === 'block';
  pw.style.display = open ? 'none' : 'block';
  if (open) vid.pause(); else vid.play();
}
load();
</script>
</body>
</html>`);
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────────
// ─── 古いファイル自動削除（5日以上前） ──────────────────────────────────────
function cleanupOldFiles() {
  const KEEP_DAYS = 5;
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  const dateRe  = /(\d{4}-\d{2}-\d{2})/;
  let count = 0;

  function removeIfOld(filePath, dateStr) {
    const d = new Date(dateStr + "T00:00:00+09:00").getTime();
    if (d < cutoff) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
        else fs.unlinkSync(filePath);
        count++;
      } catch { /* skip */ }
    }
  }

  // ファイル名に日付が含まれるディレクトリ群
  const targets = [
    path.join(__dirname, "soccer_yt_videos"),
    path.join(__dirname, "soccer_yt_thumbnails"),
    path.join(__dirname, "soccer_yt_slides"),
    path.join(__dirname, "images"),
    path.join(__dirname, "temp"),
  ];

  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = name.match(dateRe);
      if (m) removeIfOld(path.join(dir, name), m[1]);
    }
  }

  if (count > 0) console.log(`🗑  古いファイルを ${count} 件削除しました（${KEEP_DAYS}日以上前）`);
}

// ─── YouTube投稿ランチャー: データAPI ────────────────────────────────────────
app.get("/api/youtube-launcher/:date", (req, res) => {
  const date = req.params.date;
  const contentFile = path.join(TEMP_DIR, `soccer_yt_content_${date}.json`);
  if (!fs.existsSync(contentFile)) return res.json({ ok: false, error: `soccer_yt_content_${date}.json が見つかりません` });

  const data  = JSON.parse(fs.readFileSync(contentFile, "utf8"));
  const posts = (data.posts || []).map((p, i) => {
    const num       = p.num || (i + 1);
    const videoName = `${date}_${num}.mp4`;
    const videoPath = path.join(VIDEO_DIR, videoName);
    const imagePaths = (p.imagePaths || []).filter(Boolean);
    const thumbName  = p.mainImagePath ? p.mainImagePath.replace(/\\\\/g, "/").split("/").pop() : null;
    const desc = [
      p.overviewNarration || "",
      "",
      p.hashtagsText || "",
    ].join("\n").trim();
    return {
      idx:         i,
      num,
      catchLine1:  p.catchLine1 || "",
      youtubeTitle: p.youtubeTitle || p.catchLine1 || "",
      description: desc,
      hashtagsText: p.hashtagsText || "",
      hasVideo:    fs.existsSync(videoPath),
      videoUrl:    fs.existsSync(videoPath) ? `/video-files/${videoName}` : null,
      videoName,
      isGenerated: p.isGenerated || false,
      thumbUrl:     thumbName ? `/images/${thumbName}` : null,
      imageUrls:    imagePaths.map(p2 => `/images/${p2.replace(/\\\\/g, "/").split("/").pop()}`),
      commentPool:  (p._commentPool || []).slice(0, 40),
      sourceUrl:    p._meta?.redditUrl || p._imgMeta?.url || "",
      sourceOverview: (p.overviewNarration || "").slice(0, 400),
      serperSnippets: (p._imgMeta?.serperSnippets || []).slice(0, 3),
      thumbExportPost: {
        mainImagePath: p.mainImagePath || null,
        catchLine1:    p.catchLine1 || "",
        label:         p.label || "",
        badge:         p.badge || "",
        imgZoom:       p.imgZoom || {},
      },
    };
  });
  res.json({ ok: true, date, posts });
});

// ─── YouTube投稿ランチャー: ページ ────────────────────────────────────────────
app.get("/youtube", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>▶ YouTube投稿ランチャー</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0d0d0d;color:#e8e8e8;font-family:"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;font-size:15px;}
header{background:#1a1a1a;border-bottom:2px solid #2e2e2e;padding:14px 24px;display:flex;align-items:center;gap:14px;}
header h1{font-size:20px;font-weight:900;color:#ffd700;letter-spacing:1px;}
.date-lbl{color:#888;font-size:14px;}
#date-val{color:#ffd700;font-weight:700;}
.btn{cursor:pointer;border:none;border-radius:6px;padding:9px 20px;font-size:14px;font-weight:700;transition:opacity .15s;}
.btn:hover{opacity:.8;}.btn:disabled{opacity:.35;cursor:not-allowed;}
.btn-load{background:#3a3a3a;color:#e8e8e8;}
.btn-upload{background:#ff0000;color:#fff;font-size:15px;padding:10px 24px;}
.btn-upload-all{background:#cc0000;color:#fff;font-size:15px;padding:10px 24px;}
.ml-auto{margin-left:auto;}
.container{max-width:1800px;margin:0 auto;padding:20px 24px;}
.toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px;}
.global-status{padding:10px 24px;background:#111;border-bottom:1px solid #2e2e2e;font-size:14px;color:#888;min-height:38px;}
.status-ok{background:#1a3a1a;color:#3cb371;}
.status-err{background:#3a1a1a;color:#e05555;}
.status-run{background:#1a2a3a;color:#4a9eff;}

/* ── カード ── */
.post-card{background:#1a1a1a;border:2px solid #2e2e2e;border-radius:12px;padding:20px;margin-bottom:24px;display:grid;grid-template-columns:504px minmax(0,600px);gap:20px;}
.post-card.has-video{border-color:#3a3a3a;}
.post-card.no-video{opacity:.55;}
.card-num{font-size:13px;color:#666;margin-bottom:6px;}
.card-title{font-size:15px;font-weight:700;color:#ffd700;margin-bottom:10px;line-height:1.4;overflow-wrap:break-word;}
.check-row{display:flex;align-items:center;gap:10px;margin-bottom:14px;}
.check-row input[type=checkbox]{width:20px;height:20px;cursor:pointer;accent-color:#ff0000;}
.check-row label{font-size:14px;font-weight:700;color:#ccc;cursor:pointer;}

/* ── 左列: サムネ + ギャラリー ── */
.left-col{display:flex;flex-direction:column;gap:12px;}
.tn-wrapper{width:456px;height:257px;overflow:hidden;border-radius:8px;border:2px solid #333;background:#000;position:relative;}
.tn-wrapper iframe{width:1280px;height:720px;transform:scale(0.35625);transform-origin:0 0;border:none;pointer-events:none;}
.no-thumb{width:456px;height:257px;background:#222;border-radius:8px;display:flex;align-items:center;justify-content:center;color:#555;font-size:13px;}
.gallery-label{font-size:12px;color:#666;margin-bottom:6px;}
.zoom-ctrl{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px 12px;margin-bottom:8px;}
.zoom-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.zoom-row:last-child{margin-bottom:0;}
.zoom-lbl{font-size:11px;color:#888;width:40px;flex-shrink:0;}
.zoom-row input[type=range]{flex:1;accent-color:#ffd700;height:4px;}
.zoom-val{font-size:11px;color:#ffd700;width:36px;text-align:right;flex-shrink:0;}
.gallery{display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow-y:auto;}
.gallery img{width:56px;height:56px;object-fit:cover;border-radius:4px;cursor:pointer;border:2px solid transparent;opacity:.65;transition:all .15s;}
.gallery img:hover,.gallery img.selected{border-color:#ff0000;opacity:1;}

/* ── 中列: テキスト編集 ── */
.meta-col{display:flex;flex-direction:column;gap:14px;}
.field-lbl{font-size:12px;color:#888;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px;}
input[type=text],textarea{width:100%;background:#111;border:1px solid #333;color:#e8e8e8;border-radius:6px;padding:10px 12px;font-size:14px;font-family:inherit;line-height:1.5;}
input[type=text]:focus,textarea:focus{border-color:#ffd700;outline:none;}
textarea{resize:vertical;min-height:120px;}
.textarea-desc{min-height:160px;}

/* ── コメントプール ── */
.comment-pool{margin-top:14px;}
.comment-pool-label{font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px;}
.comment-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;}
.comment-item{background:#0d0d0d;border:1px solid #2a2a2a;border-radius:6px;padding:8px 10px;font-size:13px;line-height:1.5;color:#ccc;display:flex;gap:8px;align-items:flex-start;}
.badge{font-size:10px;font-weight:900;padding:2px 7px;border-radius:4px;white-space:nowrap;flex-shrink:0;margin-top:2px;}
.badge-reddit{background:#ff6314;color:#fff;}
.badge-rss{background:#009688;color:#fff;}
.badge-xjp{background:#e00010;color:#fff;}
.btn-source{background:#1e3a5a;color:#7ab8e8;font-size:12px;padding:5px 12px;margin-top:6px;}
.source-panel{display:none;background:#0d1f30;border:1px solid #2a4a6b;border-radius:6px;padding:10px 12px;margin-top:8px;font-size:12px;line-height:1.6;}
.source-panel.open{display:block;}
.source-url{margin-bottom:6px;}.source-url a{color:#7ab8e8;word-break:break-all;}
.source-overview{color:#bbb;white-space:pre-wrap;}
.serper-snippets{margin-top:8px;border-top:1px solid #2a4a6b;padding-top:8px;}
.serper-snippet{margin-bottom:6px;color:#aaa;}.serper-snippet b{color:#ddd;}
.badge-xother{background:#1a1a2e;color:#aad4ff;border:1px solid #3a5a8a;}
.video-preview{width:100%;border-radius:8px;background:#000;display:block;margin-bottom:14px;}
.post-actions{display:flex;gap:10px;align-items:center;margin-top:8px;}
.status-msg{font-size:13px;padding:5px 10px;border-radius:5px;flex:1;}
/* ── アップロードモーダル ── */
#upload-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;overflow-y:auto;padding:40px 20px;}
.upload-modal-inner{max-width:700px;margin:0 auto;background:#1a1a1a;border:1px solid #444;border-radius:12px;padding:28px;}
.upload-modal-inner h2{color:#ffd700;font-size:18px;margin-bottom:20px;}
.copy-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:16px;}
.copy-row textarea,.copy-row input{flex:1;background:#111;border:1px solid #333;color:#e8e8e8;border-radius:6px;padding:10px;font-size:13px;font-family:inherit;resize:vertical;}
.btn-copy{background:#2a4a6b;color:#7ab8e8;border:none;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:13px;white-space:nowrap;flex-shrink:0;}
.btn-copy.ok{background:#1a3a1a;color:#3cb371;}
.upload-modal-actions{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap;}
.btn-yt-open{background:#ff0000;color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer;}
.btn-dl{background:#333;color:#ccc;border:none;border-radius:8px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
.btn-close-modal{background:#333;color:#aaa;border:none;border-radius:8px;padding:12px 20px;font-size:14px;cursor:pointer;margin-left:auto;}

/* ── レスポンシブ（スマホ対応） ── */
@media(max-width:768px){
  header{flex-wrap:wrap;gap:8px;padding:10px 14px;}
  header h1{font-size:15px;width:100%;}
  #yt-auth-badge{font-size:11px;}
  .btn{padding:8px 12px;font-size:13px;}
  .btn-upload{font-size:13px;padding:8px 14px;}
  .btn-upload-all{font-size:13px;padding:8px 14px;}
  .container{padding:12px 10px;}
  .post-card{grid-template-columns:1fr;gap:14px;padding:14px;}
  .tn-wrapper{width:100%;height:0;padding-bottom:56.25%;position:relative;}
  .tn-wrapper iframe{width:1280px;height:720px;transform-origin:0 0;position:absolute;top:0;left:0;}
  .no-thumb{width:100%;height:180px;}
  .upload-modal-inner{padding:16px;}
  .upload-modal-actions{flex-direction:column;}
  .btn-yt-open,.btn-dl,.btn-close-modal{width:100%;text-align:center;margin-left:0;}
  select#modal-privacy{width:100%;}
  .global-status{padding:8px 12px;font-size:13px;}
}
</style>
</head>
<body>
<header>
  <h1>▶ YouTube投稿ランチャー</h1>
  <input type="date" id="date-input-yt" style="background:#222;color:#ffd700;border:1px solid #555;border-radius:6px;padding:6px 10px;font-size:14px;font-weight:700;">
  <button class="btn btn-load" onclick="changeDate()">読み込み</button>
  <div class="ml-auto" style="display:flex;gap:10px;align-items:center;">
    <span id="yt-auth-badge" style="font-size:13px;padding:5px 12px;border-radius:6px;background:#333;color:#888;">認証確認中...</span>
    <button class="btn btn-load" id="yt-auth-btn" onclick="window.open('/auth/youtube','_blank','width=600,height=700')" style="display:none">🔑 YouTube認証</button>
    <button class="btn btn-load" onclick="loadPosts()">再読み込み</button>
    <button class="btn btn-upload-all" onclick="uploadAll()">▶ チェック済みを一括投稿</button>
  </div>
</header>
<div class="global-status" id="global-status">読み込み中...</div>
<div class="container" id="posts-container"></div>

<div id="upload-modal">
  <div class="upload-modal-inner">
    <h2>📤 YouTube アップロード</h2>
    <div style="font-size:12px;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">タイトル</div>
    <div class="copy-row">
      <input type="text" id="modal-title">
      <button class="btn-copy" onclick="copyField('modal-title',this)">コピー</button>
    </div>
    <div style="font-size:12px;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">説明文</div>
    <div class="copy-row">
      <textarea id="modal-desc" rows="5"></textarea>
      <button class="btn-copy" onclick="copyField('modal-desc',this)">コピー</button>
    </div>
    <div style="font-size:12px;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">ハッシュタグ</div>
    <div class="copy-row">
      <input type="text" id="modal-tags">
      <button class="btn-copy" onclick="copyField('modal-tags',this)">コピー</button>
    </div>
    <div style="font-size:12px;color:#aaa;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px;">公開設定</div>
    <select id="modal-privacy" style="background:#111;border:1px solid #333;color:#e8e8e8;border-radius:6px;padding:8px 12px;font-size:13px;margin-bottom:16px;">
      <option value="public">公開</option>
      <option value="unlisted">限定公開</option>
      <option value="private">非公開</option>
    </select>
    <div id="modal-upload-status" style="display:none;padding:10px 14px;border-radius:8px;font-size:14px;margin-bottom:12px;"></div>
    <div class="upload-modal-actions">
      <button class="btn-yt-open" id="btn-do-upload" onclick="doUpload()">🚀 YouTubeにアップロード</button>
      <a id="modal-dl-link" class="btn-dl" download>⬇ 動画をダウンロード</a>
      <button class="btn-close-modal" onclick="closeUploadModal()">✕ 閉じる</button>
    </div>
  </div>
</div>

<script>
const urlParams = new URLSearchParams(location.search);
let DATE = urlParams.get("date") || new Date(Date.now() + 9*60*60*1000).toISOString().slice(0,10);
const dateInputYt = document.getElementById("date-input-yt");
dateInputYt.value = DATE;

function changeDate() {
  DATE = dateInputYt.value;
  if (!DATE) return;
  history.replaceState(null, "", "/youtube?date=" + DATE);
  loadPosts();
}

let postsData = [];
let selectedThumbs = {};
let currentUploadIdx = -1;

// ─── YouTube認証状態チェック ────────────────────────────────────────────
async function checkYtAuth() {
  try {
    const r = await fetch("/auth/youtube/status");
    const j = await r.json();
    const badge = document.getElementById("yt-auth-badge");
    const btn   = document.getElementById("yt-auth-btn");
    if (j.authenticated) {
      badge.textContent = "✅ YouTube認証済み";
      badge.style.background = "#1a3a1a";
      badge.style.color = "#3cb371";
      btn.style.display = "none";
    } else {
      badge.textContent = "⚠️ YouTube未認証";
      badge.style.background = "#3a1a1a";
      badge.style.color = "#e66";
      btn.style.display = "";
    }
  } catch(e) {}
}
checkYtAuth();

// サムネiframeのスケールをウィンドウ幅に合わせて動的調整
function adjustTnScale() {
  document.querySelectorAll(".tn-wrapper").forEach(wrap => {
    const w = wrap.offsetWidth;
    if (!w) return;
    const scale = w / 1280;
    const iframe = wrap.querySelector("iframe");
    if (iframe) {
      iframe.style.transform = \`scale(\${scale})\`;
      wrap.style.height = (720 * scale) + "px";
    }
  });
}
window.addEventListener("resize", adjustTnScale);

async function loadPosts() {
  if (!DATE) { setGlobalStatus("日付が指定されていません", "err"); return; }
  setGlobalStatus("読み込み中...", "run");
  try {
    const res = await fetch("/api/youtube-launcher/" + DATE);
    const j   = await res.json();
    if (!j.ok) { setGlobalStatus("❌ " + j.error, "err"); return; }
    postsData = j.posts.filter(p => p.hasVideo);
    renderPosts();
    setGlobalStatus("✅ " + postsData.length + "件（動画生成済み）読み込み完了", postsData.length > 0 ? "ok" : "run");
  } catch(e) { setGlobalStatus("❌ " + e.message, "err"); }
}

function renderPosts() {
  const container = document.getElementById("posts-container");
  container.innerHTML = postsData.map((p, i) => {
    const tnHtml = \`<div class='tn-wrapper'><iframe src='/api/thumbnail/preview/\${DATE}/\${p.idx}?t=\${Date.now()}' scrolling='no'></iframe></div>\`;
    const swapImgs = p.imageUrls.map((url, j) =>
      "<img src='" + url + "' class='" + (url === p.thumbUrl ? "selected" : "") + "' onclick='swapThumb(" + i + "," + j + "," + JSON.stringify(url) + ")' title='サムネに設定'>"
    ).join("");
    return \`
<div class='post-card has-video' id='card-\${i}'>
  <div class='left-col'>
    <div>
      <div class='card-num'>#\${p.num}</div>
      <div style='display:flex;gap:6px;align-items:flex-start;margin-bottom:8px;'>
        <textarea id='catch-\${i}' rows='3' style='flex:1;background:#111;border:1px solid #333;color:#e8e8e8;border-radius:6px;padding:8px;font-size:13px;line-height:1.5;resize:vertical;' oninput='updateTnPreview(\${i})'>\${esc(p.catchLine1)}</textarea>
        <button onclick='insertRedYT(\${i})' title='選択テキストを赤字' style='background:#c00000;color:#fff;border:none;padding:10px 12px;border-radius:6px;cursor:pointer;font-weight:900;font-size:18px;flex-shrink:0;'>🔴</button>
      </div>
      <div class='check-row'>
        <input type='checkbox' id='chk-\${i}' data-idx='\${i}'>
        <label for='chk-\${i}'>投稿対象に含める</label>
      </div>
    </div>
    <div class='tn-wrapper' id='tn-wrap-\${i}'><iframe id='tn-frame-\${i}' src='/api/thumbnail/preview/\${DATE}/\${p.idx}?t=\${Date.now()}' scrolling='no'></iframe></div>
    <div class='zoom-ctrl'>
      <div class='zoom-row'>
        <span class='zoom-lbl'>ズーム</span>
        <input type='range' min='1.0' max='2.5' step='0.05' value='1.0' id='zoom-z-\${i}' oninput='updateTnZoom(\${i})'>
        <span class='zoom-val' id='zoom-zv-\${i}'>1.0</span>
      </div>
      <div class='zoom-row'>
        <span class='zoom-lbl'>X位置</span>
        <input type='range' min='0' max='100' step='1' value='50' id='zoom-x-\${i}' oninput='updateTnZoom(\${i})'>
        <span class='zoom-val' id='zoom-xv-\${i}'>50</span>
      </div>
      <div class='zoom-row'>
        <span class='zoom-lbl'>Y位置</span>
        <input type='range' min='0' max='100' step='1' value='50' id='zoom-y-\${i}' oninput='updateTnZoom(\${i})'>
        <span class='zoom-val' id='zoom-yv-\${i}'>50</span>
      </div>
    </div>
    <div>
      <div class='gallery-label' style='display:flex;align-items:center;justify-content:space-between;'>
        <span>サムネ画像を変更</span>
        <label style='cursor:pointer;background:#1a3a1a;color:#7f7;border:1px solid #3a6a3a;border-radius:4px;padding:2px 10px;font-size:11px;white-space:nowrap;'>
          ＋ 画像追加
          <input type='file' accept='image/*' style='display:none' onchange='addGalleryImage(\${i}, this)'>
        </label>
      </div>
      <div class='gallery' id='thumbs-\${i}'>\${swapImgs}</div>
    </div>
    <button class='btn btn-load' id='btn-tn-\${i}' onclick='exportThumb(\${i})' style='margin-top:8px;width:100%;'>🖼 サムネイル生成</button>
  </div>
  <div class='meta-col'>
    <video class='video-preview' controls preload='metadata' src='\${p.videoUrl}'></video>
    <div>
      <div class='field-lbl'>YouTubeタイトル</div>
      <input type='text' id='title-\${i}' value='\${esc(p.youtubeTitle)}'>
    </div>
    <div>
      <div class='field-lbl'>説明文・概要欄</div>
      <textarea class='textarea-desc' id='desc-\${i}'>\${esc(p.description)}</textarea>
    </div>
    <div>
      <div class='field-lbl'>ハッシュタグ</div>
      <input type='text' id='tags-\${i}' value='\${esc(p.hashtagsText)}'>
    </div>
    <div class='post-actions'>
      <button class='btn btn-upload' onclick='uploadSingle(\${i})'>📤 投稿準備</button>
      <span class='status-msg' id='st-\${i}'></span>
    </div>
  </div>
</div>\`;
  }).join("");
  setTimeout(adjustTnScale, 100);
}

function esc(s) { return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }

function swapThumb(postIdx, imgIdx, url) {
  selectedThumbs[postIdx] = url;
  const container = document.getElementById("thumbs-" + postIdx);
  if (container) container.querySelectorAll("img").forEach((img, j) => {
    img.classList.toggle("selected", j === imgIdx);
  });
  // iframeプレビューを更新
  const frame = document.getElementById("tn-frame-" + postIdx);
  if (frame) frame.src = buildPreviewSrc(postIdx);
}

async function addGalleryImage(i, input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result.split(",")[1];
    const post = postsData[i];
    setPostStatus(i, "⏳ アップロード中...", "run");
    try {
      const r = await fetch("/api/gallery/add-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: DATE, postIdx: post.idx, filename: file.name, data: base64 })
      });
      const j = await r.json();
      if (j.ok) {
        const newIdx = postsData[i].imageUrls.length;
        postsData[i].imageUrls.push(j.url);
        const container = document.getElementById("thumbs-" + i);
        const img = document.createElement("img");
        img.src = j.url;
        img.title = "サムネに設定";
        img.onclick = () => swapThumb(i, newIdx, j.url);
        container.appendChild(img);
        swapThumb(i, newIdx, j.url); // 追加直後に選択状態に
        setPostStatus(i, "✅ 画像追加完了", "ok");
      } else {
        setPostStatus(i, "❌ " + (j.error || "失敗"), "err");
      }
    } catch(e) { setPostStatus(i, "❌ " + e.message, "err"); }
    input.value = "";
  };
  reader.readAsDataURL(file);
}

function setGlobalStatus(msg, type) {
  const el = document.getElementById("global-status");
  el.textContent = msg;
  el.className = "global-status" + (type === "ok" ? " status-ok" : type === "err" ? " status-err" : type === "run" ? " status-run" : "");
}

function setPostStatus(i, msg, type) {
  const el = document.getElementById("st-" + i);
  if (el) { el.textContent = msg; el.className = "status-msg status-" + type; }
}

function buildPreviewSrc(i) {
  const post  = postsData[i];
  const z     = parseFloat(document.getElementById("zoom-z-" + i)?.value || 1.0);
  const x     = parseFloat(document.getElementById("zoom-x-" + i)?.value || 50);
  const y     = parseFloat(document.getElementById("zoom-y-" + i)?.value || 50);
  const catchText = document.getElementById("catch-" + i)?.value ?? "";
  const selectedImg = selectedThumbs[i];
  let src = "/api/thumbnail/preview/" + DATE + "/" + post.idx +
    "?zoom=" + z + "&px=" + x + "&py=" + y +
    "&catch=" + encodeURIComponent(catchText) + "&t=" + Date.now();
  if (selectedImg) src += "&img=" + encodeURIComponent(selectedImg);
  return src;
}

function updateTnZoom(i) {
  const z  = parseFloat(document.getElementById("zoom-z-" + i).value);
  const x  = parseFloat(document.getElementById("zoom-x-" + i).value);
  const y  = parseFloat(document.getElementById("zoom-y-" + i).value);
  document.getElementById("zoom-zv-" + i).textContent = z.toFixed(2);
  document.getElementById("zoom-xv-" + i).textContent = x;
  document.getElementById("zoom-yv-" + i).textContent = y;
  document.getElementById("tn-frame-" + i).src = buildPreviewSrc(i);
}

const _tnDebounce = {};
function updateTnPreview(i) {
  clearTimeout(_tnDebounce[i]);
  _tnDebounce[i] = setTimeout(() => {
    document.getElementById("tn-frame-" + i).src = buildPreviewSrc(i);
  }, 500);
}

function insertRedYT(i) {
  const el = document.getElementById("catch-" + i);
  if (!el) return;
  const start = el.selectionStart, end = el.selectionEnd;
  el.value = el.value.slice(0, start) + "[r]" + el.value.slice(start, end) + "[/r]" + el.value.slice(end);
  el.focus();
  el.selectionStart = start + 3;
  el.selectionEnd   = end + 3;
}

async function exportThumb(i) {
  const post = postsData[i];
  const catchLine1 = document.getElementById("catch-" + i)?.value || post.thumbExportPost.catchLine1;
  const zoom = parseFloat(document.getElementById("zoom-z-" + i)?.value || 1.0);
  const px   = parseFloat(document.getElementById("zoom-x-" + i)?.value || 50);
  const py   = parseFloat(document.getElementById("zoom-y-" + i)?.value || 50);
  const btn = document.getElementById("btn-tn-" + i);
  if (btn) btn.disabled = true;
  setPostStatus(i, "🖼 サムネ生成中...", "run");
  try {
    const exportPost = Object.assign({}, post.thumbExportPost, {
      catchLine1,
      imgZoom: { tn: { zoom, x: px, y: py } }
    });
    const r = await fetch("/api/thumbnail/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: DATE, postIdx: post.idx, post: exportPost, selectedImgUrl: selectedThumbs[i] || null }),
    });
    const j = await r.json();
    if (j.ok) setPostStatus(i, "✅ " + j.filename, "ok");
    else setPostStatus(i, "❌ " + (j.error || "失敗"), "err");
  } catch(e) { setPostStatus(i, "❌ " + e.message, "err"); }
  if (btn) btn.disabled = false;
}

function uploadSingle(i) {
  const post  = postsData[i];
  const title = document.getElementById("title-" + i).value;
  const desc  = document.getElementById("desc-" + i).value;
  const tags  = document.getElementById("tags-" + i).value;
  currentUploadIdx = i;
  document.getElementById("modal-title").value = title;
  document.getElementById("modal-desc").value  = desc;
  document.getElementById("modal-tags").value  = tags;
  document.getElementById("modal-privacy").value = "public";
  const dlLink = document.getElementById("modal-dl-link");
  dlLink.href     = post.videoUrl;
  dlLink.download = post.videoName || "video.mp4";
  const statusEl = document.getElementById("modal-upload-status");
  statusEl.style.display = "none";
  statusEl.textContent = "";
  document.querySelectorAll(".btn-copy").forEach(b => b.classList.remove("ok"));
  document.getElementById("btn-do-upload").disabled = false;
  document.getElementById("upload-modal").style.display = "block";
}

async function doUpload() {
  if (currentUploadIdx < 0) return;
  const post    = postsData[currentUploadIdx];
  const title   = document.getElementById("modal-title").value;
  const desc    = document.getElementById("modal-desc").value;
  const tags    = document.getElementById("modal-tags").value;
  const privacy = document.getElementById("modal-privacy").value;
  const statusEl = document.getElementById("modal-upload-status");
  const btn      = document.getElementById("btn-do-upload");

  btn.disabled = true;
  statusEl.style.display = "block";
  statusEl.style.background = "#1a2a3a";
  statusEl.style.color = "#7ab8e8";
  statusEl.textContent = "⏳ アップロード中... 動画サイズによって数分かかります";
  setPostStatus(currentUploadIdx, "⏳ アップロード中...", "run");

  try {
    const r = await fetch("/api/youtube/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: DATE,
        videoName: post.videoName,
        thumbName: DATE + "_" + (post.idx + 1) + "_thumb.png",
        title, description: desc, tags,
        privacyStatus: privacy,
      }),
    });
    const j = await r.json();
    if (j.ok) {
      statusEl.style.background = "#1a3a1a";
      statusEl.style.color = "#3cb371";
      const thumbMsg = j.thumbSet ? " ｜ 🖼 サムネイル設定済み" : " ｜ ⚠️ サムネイル未生成（先に🖼ボタンを押してください）";
      statusEl.innerHTML = \`✅ アップロード完了！\${thumbMsg}<br><a href="\${j.url}" target="_blank" style="color:#ffd700">\${j.url}</a>\`;
      setPostStatus(currentUploadIdx, "✅ YouTube投稿済み", "ok");
    } else {
      statusEl.style.background = "#3a1a1a";
      statusEl.style.color = "#e66";
      statusEl.textContent = "❌ " + (j.error || "アップロード失敗");
      setPostStatus(currentUploadIdx, "❌ 失敗: " + (j.error || ""), "err");
      btn.disabled = false;
    }
  } catch(e) {
    statusEl.style.background = "#3a1a1a";
    statusEl.style.color = "#e66";
    statusEl.textContent = "❌ " + e.message;
    btn.disabled = false;
  }
}

function closeUploadModal() {
  document.getElementById("upload-modal").style.display = "none";
  currentUploadIdx = -1;
}

function copyField(id, btn) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.value).then(() => {
    btn.textContent = "✅ コピー済";
    btn.classList.add("ok");
  });
}

async function uploadDirect(i) {
  const post    = postsData[i];
  const title   = document.getElementById("title-" + i).value;
  const desc    = document.getElementById("desc-" + i).value;
  const tags    = document.getElementById("tags-" + i).value;
  setPostStatus(i, "⏳ アップロード中...", "run");
  try {
    const r = await fetch("/api/youtube/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: DATE, videoName: post.videoName,
        thumbName: DATE + "_" + (post.idx + 1) + "_thumb.png",
        title, description: desc, tags, privacyStatus: "public",
      }),
    });
    const j = await r.json();
    if (j.ok) {
      const thumbMsg = j.thumbSet ? " ｜ 🖼サムネ設定済み" : "";
      setPostStatus(i, "✅ 投稿完了" + thumbMsg, "ok");
    } else {
      setPostStatus(i, "❌ " + (j.error || "アップロード失敗"), "err");
    }
  } catch(e) {
    setPostStatus(i, "❌ " + e.message, "err");
  }
}

async function uploadAll() {
  const checks = document.querySelectorAll("input[type=checkbox]:checked");
  if (!checks.length) { setGlobalStatus("チェックを入れてください", "err"); return; }
  if (!confirm(checks.length + "件を投稿しますか？")) return;
  for (const cb of checks) {
    await uploadDirect(parseInt(cb.dataset.idx));
    await new Promise(r => setTimeout(r, 2000));
  }
  setGlobalStatus("✅ 一括投稿完了", "ok");
}

loadPosts();
</script>
</body></html>`);
});

// ─── YouTube OAuth: 認証開始 ──────────────────────────────────────────────
app.get("/auth/youtube", (req, res) => {
  if (!process.env.YOUTUBE_CLIENT_ID) {
    return res.send("❌ .env に YOUTUBE_CLIENT_ID が設定されていません");
  }
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/youtube.upload"],
    prompt: "consent",
  });
  res.redirect(url);
});

// ─── YouTube OAuth: コールバック ──────────────────────────────────────────
app.get("/auth/youtube/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2 style="color:red">認証エラー: ${error}</h2>`);
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    fs.writeFileSync(YT_TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="background:#0d0d0d;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <div style="font-size:64px;margin-bottom:16px">✅</div>
  <h2 style="color:#ffd700;margin-bottom:8px">YouTube認証完了！</h2>
  <p style="color:#888">このウィンドウを閉じてください</p>
  <script>setTimeout(()=>{try{opener.location.reload();}catch(e){}window.close();},2000)</script>
</div></body></html>`);
  } catch (e) {
    res.send(`<h2 style="color:red">❌ トークン取得失敗: ${e.message}</h2>`);
  }
});

// ─── YouTube OAuth: 認証状態確認 ─────────────────────────────────────────
app.get("/auth/youtube/status", (req, res) => {
  res.json({ authenticated: fs.existsSync(YT_TOKEN_PATH) && !!oauth2Client.credentials.access_token });
});

// ─── YouTube 動画アップロード ─────────────────────────────────────────────
app.post("/api/youtube/upload", async (req, res) => {
  if (!fs.existsSync(YT_TOKEN_PATH) || !oauth2Client.credentials.access_token) {
    return res.json({ ok: false, error: "YouTube未認証。/auth/youtube から認証してください。" });
  }

  const { date, videoName, thumbName, title, description, tags, privacyStatus = "public" } = req.body;
  const videoFile = path.join(__dirname, "soccer_yt_videos", videoName);
  const thumbFile = thumbName ? path.join(__dirname, "soccer_yt_thumbnails", thumbName) : null;

  if (!fs.existsSync(videoFile)) {
    return res.json({ ok: false, error: `動画ファイルが見つかりません: ${videoName}` });
  }

  try {
    const youtube  = google.youtube({ version: "v3", auth: oauth2Client });
    const fileSize = fs.statSync(videoFile).size;
    console.log(`[YouTube Upload] 開始: ${videoName} (${(fileSize/1024/1024).toFixed(1)}MB)`);

    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title:           title || "（タイトルなし）",
          description:     description || "",
          tags:            tags ? tags.split(",").map(t => t.trim()).filter(Boolean) : [],
          categoryId:      "17",
          defaultLanguage: "ja",
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: { body: fs.createReadStream(videoFile) },
    });

    const videoId = response.data.id;
    console.log(`[YouTube Upload] 動画完了: https://youtu.be/${videoId}`);

    // サムネイルをセット
    if (thumbFile && fs.existsSync(thumbFile)) {
      try {
        await youtube.thumbnails.set({
          videoId,
          media: {
            mimeType: "image/png",
            body: fs.createReadStream(thumbFile),
          },
        });
        console.log(`[YouTube Upload] サムネイル設定完了: ${thumbName}`);
      } catch (tErr) {
        console.warn(`[YouTube Upload] サムネイル設定失敗（動画は投稿済み）: ${tErr.message}`);
      }
    } else {
      console.log(`[YouTube Upload] サムネイルなし（先に「🖼 サムネイル生成」を押してください）`);
    }

    res.json({ ok: true, videoId, url: `https://youtu.be/${videoId}`, thumbSet: !!(thumbFile && fs.existsSync(thumbFile)) });
  } catch (e) {
    console.error("[YouTube Upload Error]", e.message);
    res.json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  cleanupOldFiles();
  console.log(`\n⚽ サッカー YT 動画ランチャー起動`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n📝 使い方:`);
  console.log(`   1. 日付を選択して「読み込み」（または「🤖 自動生成」）`);
  console.log(`   2. 各セクションを編集 → 「🖼 S1/📊 S2プレビュー更新」で確認`);
  console.log(`   3. 「💾 保存」でローカル保存`);
  console.log(`   4. 「🎙 音声生成」でナレーション試聴`);
  console.log(`   5. 「🎬 動画生成」でMP4出力\n`);
});
