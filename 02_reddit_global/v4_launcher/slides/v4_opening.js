// v4_launcher/slides/v4_opening.js
// V4オープニング: 2chスレッドタイトル風
//   板ヘッダー + 「1: 風吹けば名無し」 + スレタイ超デカ文字 + 写真フレーム画像
'use strict';

const { esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, fitFont } = require('../../scripts/v2_video/slides/_common');
const { C2CH, colorBrackets, resHeaderHTML, boardBarHTML, THEME_CSS } = require('./_v4_theme');

const SUB_BAR_HEIGHT = 110;

function buildV4OpeningHTML(mod) {
  const m = mod || {};
  const title   = String(m.title || '');
  const imgPath = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc  = imgPath ? imgDataUri(imgPath) : '';

  // タイトルのフォントサイズ自動調整
  const titleWidth = imgSrc ? 1000 : 1700;
  const fit = fitFont(title, 104, titleWidth, { maxLines: 3, minFontPx: 56, charWidth: 1.0 });

  const titleHTML = colorBrackets(esc(title));

  const extraStyles = `
${THEME_CSS}
.op-area {
  position: absolute;
  top: 86px; bottom: ${SUB_BAR_HEIGHT}px;
  left: 0; right: 0;
  display: grid;
  grid-template-columns: ${imgSrc ? '58fr 42fr' : '1fr'};
  align-items: center;
  padding: 0 70px;
  gap: 50px;
}
.op-left { min-width: 0; }
.op-res-head {
  opacity: 0;
  animation: opFade .5s ease-out .25s forwards;
  margin-bottom: 26px;
}
.op-title {
  font-size: ${fit.fontSize}px;
  font-weight: 900;
  color: ${C2CH.text};
  line-height: 1.22;
  letter-spacing: 1px;
  word-break: break-word;
  white-space: pre-line;
  opacity: 0;
  transform: translateY(26px) scale(.97);
  animation: opTitleIn .55s cubic-bezier(.2,1.4,.4,1) .45s forwards;
  text-shadow: 0 1px 0 #fff;
}
.op-title::after {
  content: '';
  display: block;
  width: 220px; height: 12px;
  margin-top: 30px;
  background: ${C2CH.red};
  border-radius: 2px;
}
.op-photo {
  justify-self: center;
  transform: rotate(2.4deg) translateY(-40px);
  opacity: 0;
  animation: opPhotoIn .6s cubic-bezier(.2,1.3,.4,1) .8s forwards;
}
.op-photo img { max-width: 640px; max-height: 600px; width: auto; height: auto; }
.op-bar-anim { animation: opBarIn .45s ease-out forwards; transform: translateY(-90px); }

@keyframes opFade    { to { opacity: 1; } }
@keyframes opTitleIn { to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes opPhotoIn { to { opacity: 1; transform: rotate(2.4deg) translateY(0); } }
@keyframes opBarIn   { to { transform: translateY(0); } }
`;

  const slideBody = `
<div class="board-bg"></div>
<div class="op-bar-anim">${boardBarHTML('')}</div>
<div class="op-area">
  <div class="op-left">
    <div class="op-res-head">${resHeaderHTML(1, title, { fontPx: 30 })}</div>
    <div class="op-title">${titleHTML}</div>
  </div>
  ${imgSrc ? `<div class="op-photo"><div class="photo-frame"><img src="${imgSrc}" alt=""></div></div>` : ''}
</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildV4OpeningHTML };
