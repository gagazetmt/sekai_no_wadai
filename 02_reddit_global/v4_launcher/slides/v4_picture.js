// v4_launcher/slides/v4_picture.js
// V4解説スライド: V1移植版（写真フルブリード + 帯テロップ）× 2chまとめ
//   - 背景: 画像フルスクリーン + Ken Burns ズーム（V1 の kbZoom 移植）
//   - 上部: 2chスレタイバー（板ヘッダー）
//   - 左上: 2chレス風テロップカード（レスヘッダー + スライドタイトル）
//   - 下部: ナレーション字幕バー
//   画像なしの場合は旧クリーム板レイアウトにフォールバック
'use strict';

const { esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, fitFont } = require('../../scripts/v2_video/slides/_common');
const { C2CH, colorBrackets, resHeaderHTML, boardBarHTML, THEME_CSS } = require('./_v4_theme');

const SUB_BAR_HEIGHT = 110;
const SAFE = 60;

// ── 写真フルブリード版（V1移植）──────────────────────────────
function _buildPhotoLayout(m, imgSrc) {
  const title       = String(m.title || '');
  const threadTitle = String(m.threadTitle || '');
  const resNo       = Number(m.resNo) || 2;
  const zoom        = Number(m.imageZoom) || 1.0;

  // テロップカード本文のフォントサイズ（カード幅 ~880px 想定）
  const fit = fitFont(title, 46, 820, { maxLines: 2, minFontPx: 32, charWidth: 1.0 });

  const extraStyles = `
${THEME_CSS}
/* ── V1移植: フルブリード背景 + Ken Burns ── */
.pc-bg {
  position: absolute; inset: 0;
  background-image: url('${imgSrc}');
  background-size: cover;
  background-position: 50% 22%;
  animation: kbZoom 25s linear forwards;
  transform-origin: 50% 30%;
}
@keyframes kbZoom {
  from { transform: scale(${zoom.toFixed(2)}) translate(-1.5%, 0); }
  to   { transform: scale(${(zoom + 0.08).toFixed(2)}) translate(1.5%, 0); }
}
.pc-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to top,
    rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.30) 28%,
    rgba(0,0,0,0.04) 55%, rgba(0,0,0,0.10) 100%);
}
/* ── 2chレス風テロップカード（V1 帯テロップの2ch版）── */
.pc-telop {
  position: absolute;
  top: ${86 + 40}px; left: ${SAFE}px;
  max-width: 920px;
  background: rgba(255,255,238,0.96);
  border: 1px solid ${C2CH.line};
  border-left: 8px solid ${C2CH.maroon};
  border-radius: 6px;
  padding: 18px 28px 22px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.45);
  animation: telopIn .5s cubic-bezier(.2,1.2,.4,1) .3s both;
}
.pc-telop .res-head { font-size: 21px; margin-bottom: 8px; }
.pc-telop-body {
  font-size: ${fit.fontSize}px;
  font-weight: 900;
  color: ${C2CH.text};
  line-height: 1.3;
  word-break: break-word;
}
@keyframes telopIn { from { opacity: 0; transform: translateY(-18px); } to { opacity: 1; transform: translateY(0); } }
.pc-cite {
  position: absolute;
  bottom: ${SUB_BAR_HEIGHT + 10}px; left: ${SAFE}px;
  color: rgba(255,255,255,0.30); font-size: 19px;
}
`;

  const slideBody = `
<div class="pc-bg"></div>
<div class="pc-overlay"></div>
${boardBarHTML(esc(threadTitle))}
<div class="pc-telop">
  ${resHeaderHTML(resNo, title + resNo, { fontPx: 21, offsetMin: resNo * 3 })}
  <div class="pc-telop-body">${colorBrackets(esc(title))}</div>
</div>
<div class="pc-cite">©公式素材より引用</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT })}`;

  return wrapHTML({ slideBody, extraStyles });
}

// ── 画像なしフォールバック: クリーム板レスカード ────────────────
function _buildCardLayout(m) {
  const title       = String(m.title || '');
  const threadTitle = String(m.threadTitle || '');
  const resNo       = Number(m.resNo) || 2;
  const fit = fitFont(title, 96, 1640, { maxLines: 3, minFontPx: 52, charWidth: 1.0 });

  const extraStyles = `
${THEME_CSS}
.pc-area {
  position: absolute;
  top: 86px; bottom: ${SUB_BAR_HEIGHT}px;
  left: 0; right: 0;
  display: grid; align-items: center;
  padding: 0 70px;
}
.pc-card {
  background: ${C2CH.bgPaper};
  border: 1px solid ${C2CH.line};
  border-left: 10px solid ${C2CH.maroon};
  border-radius: 6px;
  padding: 38px 46px 46px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  animation: pcCardIn .5s cubic-bezier(.2,1.2,.4,1) .2s both;
}
.pc-res-head { margin-bottom: 22px; }
.pc-anchor { color: ${C2CH.blue}; font-size: 28px; font-weight: 700; margin-bottom: 12px; }
.pc-body {
  font-size: ${fit.fontSize}px; font-weight: 900; color: ${C2CH.text};
  line-height: 1.3; word-break: break-word; white-space: pre-line;
}
@keyframes pcCardIn { from { opacity: 0; transform: translateX(-30px); } to { opacity: 1; transform: translateX(0); } }
`;

  const slideBody = `
<div class="board-bg"></div>
${boardBarHTML(esc(threadTitle))}
<div class="pc-area">
  <div class="pc-card">
    <div class="pc-res-head">${resHeaderHTML(resNo, title + resNo, { fontPx: 27, offsetMin: resNo * 3 })}</div>
    <div class="pc-anchor">&gt;&gt;1</div>
    <div class="pc-body">${colorBrackets(esc(title))}</div>
  </div>
</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT })}`;

  return wrapHTML({ slideBody, extraStyles });
}

function buildV4PictureHTML(mod) {
  const m = mod || {};
  const imgPath = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc  = imgPath ? imgDataUri(imgPath) : '';
  return imgSrc ? _buildPhotoLayout(m, imgSrc) : _buildCardLayout(m);
}

module.exports = { buildV4PictureHTML };
