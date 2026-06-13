// v4_launcher/slides/v4_picture.js
// V4解説スライド: V1 S2（ソーススライド）移植版
//   写真フルブリード + Ken Burns + 左上パステルカード(スライドタイトル)
//   + 右上ソースカード + 下部字幕バー
'use strict';

const { esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, fitFont } = require('../../scripts/v2_video/slides/_common');

const SAFE = 60;
const SUB_BAR_HEIGHT = 110;

function buildV4PictureHTML(mod) {
  const m = mod || {};
  const title      = String(m.title || '');
  const sourceHost = String(m.sourceHost || '');
  const kbDir      = (Number(m.kbDir) === -1) ? -1 : 1;  // Ken Burns の移動方向（②③で逆向きに）
  const imgPath    = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc     = imgPath ? imgDataUri(imgPath) : '';

  const bgCss = imgSrc
    ? `background-image:url('${imgSrc}');background-size:cover;background-position:50% 22%;`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;

  // 左上カードのフォントサイズ（V1 c-card 準拠 49px ベース）
  const fit = fitFont(title, 49, 820, { maxLines: 2, minFontPx: 34, charWidth: 1.0 });

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bgCss}
  animation: kbZoom 25s linear forwards;
  transform-origin: 50% 30%;
}
@keyframes kbZoom {
  from { transform: scale(1.0)  translate(${(-1.5 * kbDir).toFixed(1)}%, 0); }
  to   { transform: scale(1.08) translate(${(1.5 * kbDir).toFixed(1)}%, 0); }
}
.overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to top,
    rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.40) 35%,
    rgba(0,0,0,0.05) 65%, rgba(0,0,0,0) 100%);
}
/* ── 左上: パステルカード（V1 c-card の見た目）── */
.t-card {
  position: absolute;
  top: ${SAFE}px; left: ${SAFE}px;
  max-width: 920px;
  background: #FFF9C4;
  border: 3px solid #000;
  border-radius: 8px;
  padding: 12px 22px;
  animation: slideDown 0.45s 0.3s ease-out both;
}
.t-card .t-text {
  color: #111; font-size: ${fit.fontSize}px; font-weight: 900;
  line-height: 1.35; overflow-wrap: break-word;
}
@keyframes slideDown { from { opacity: 0; transform: translateY(-30px); } to { opacity: 1; transform: translateY(0); } }
/* ── 右上: ソースカード（V1 S2 移植）── */
.source-card {
  position: absolute; top: ${SAFE}px; right: ${SAFE}px;
  background: rgba(0,0,0,0.78);
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 14px; padding: 18px 24px;
  animation: cardIn 0.45s 0.2s ease-out both;
}
@keyframes cardIn { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
.src-author { color: #fff; font-size: 18px; font-weight: 900; display: flex; align-items: center; gap: 8px; }
.src-check  { color: #1DA1F2; font-size: 14px; }
.src-handle { color: rgba(255,255,255,0.40); font-size: 13px; margin-top: 2px; }
.account {
  position: absolute; bottom: ${SUB_BAR_HEIGHT + 14}px; left: ${SAFE}px;
  color: rgba(255,255,255,0.22); font-size: 20px;
  animation: fadeUp 0.3s 1.5s ease-out both;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="overlay"></div>
${title ? `<div class="t-card"><div class="t-text">${esc(title)}</div></div>` : ''}
${sourceHost ? `
<div class="source-card">
  <div class="src-author">${esc(sourceHost)}<span class="src-check">✓</span></div>
  <div class="src-handle">@${esc(sourceHost.toLowerCase().replace(/[^\w.]/g, ''))}</div>
</div>` : ''}
<div class="account">@sekai_no_wadai</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildV4PictureHTML };
