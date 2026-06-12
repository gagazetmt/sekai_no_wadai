// v4_launcher/slides/v4_picture.js
// V4解説スライド: 2chレス風
//   板ヘッダー(スレタイ常駐) + レスカード(番号+名無し+本文デカ文字) + 写真フレーム画像
'use strict';

const { esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, fitFont } = require('../../scripts/v2_video/slides/_common');
const { C2CH, colorBrackets, resHeaderHTML, boardBarHTML, THEME_CSS } = require('./_v4_theme');

const SUB_BAR_HEIGHT = 110;

function buildV4PictureHTML(mod) {
  const m = mod || {};
  const title       = String(m.title || '');
  const threadTitle = String(m.threadTitle || '');
  const resNo       = Number(m.resNo) || 2;
  const imgPath     = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc      = imgPath ? imgDataUri(imgPath) : '';

  // レス本文（スライドタイトル）のフォントサイズ自動調整
  const bodyWidth = imgSrc ? 880 : 1640;
  const fit = fitFont(title, 96, bodyWidth, { maxLines: 3, minFontPx: 52, charWidth: 1.0 });

  const extraStyles = `
${THEME_CSS}
.pc-area {
  position: absolute;
  top: 86px; bottom: ${SUB_BAR_HEIGHT}px;
  left: 0; right: 0;
  display: grid;
  grid-template-columns: ${imgSrc ? '55fr 45fr' : '1fr'};
  align-items: center;
  padding: 0 70px;
  gap: 50px;
}
.pc-card {
  background: ${C2CH.bgPaper};
  border: 1px solid ${C2CH.line};
  border-left: 10px solid ${C2CH.maroon};
  border-radius: 6px;
  padding: 38px 46px 46px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  min-width: 0;
  opacity: 0;
  transform: translateX(-30px);
  animation: pcCardIn .5s cubic-bezier(.2,1.2,.4,1) .2s forwards;
}
.pc-res-head { margin-bottom: 22px; }
.pc-body {
  font-size: ${fit.fontSize}px;
  font-weight: 900;
  color: ${C2CH.text};
  line-height: 1.3;
  word-break: break-word;
  white-space: pre-line;
}
.pc-anchor {
  color: ${C2CH.blue};
  font-size: 28px; font-weight: 700;
  margin-bottom: 12px;
}
.pc-photo {
  justify-self: center;
  transform: rotate(-2deg);
  opacity: 0;
  animation: pcPhotoIn .55s cubic-bezier(.2,1.3,.4,1) .5s forwards;
}
.pc-photo img { max-width: 600px; max-height: 560px; width: auto; height: auto; }

@keyframes pcCardIn  { to { opacity: 1; transform: translateX(0); } }
@keyframes pcPhotoIn { to { opacity: 1; transform: rotate(-2deg) translateY(0); } from { opacity: 0; transform: rotate(-2deg) translateY(-30px); } }
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
  ${imgSrc ? `<div class="pc-photo"><div class="photo-frame"><img src="${imgSrc}" alt=""></div></div>` : ''}
</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildV4PictureHTML };
