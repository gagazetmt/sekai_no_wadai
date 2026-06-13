// v4_launcher/slides/v4_opening.js
// V4オープニング: V1 S1（タイトルカード）移植版
//   写真フルブリード + Ken Burns + 【悲報】赤バッジ + 下部黒帯タイトル
'use strict';

const { esc, imgDataUri, wrapHTML } = require('../../scripts/v2_video/slides/_common');

const SAFE = 60;

// タイトル先頭の【...】をバッジとして抽出。無ければ内容から自動判定（V1 getLabel 移植）
function _splitLabel(title) {
  const m = String(title || '').match(/^(【[^】]{1,8}】)\s*(.+)$/);
  if (m) return { label: m[1], rest: m[2] };
  const t = String(title || '');
  let label = '【速報】';
  if (/悲報|敗退|負け|崩壊|失態|離脱|引退|怪我/.test(t)) label = '【悲報】';
  else if (/朗報|勝利|優勝|快挙|大勝|復活/.test(t))      label = '【朗報】';
  return { label, rest: t };
}

function buildV4OpeningHTML(mod) {
  const m = mod || {};
  const imgPath = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc  = imgPath ? imgDataUri(imgPath) : '';
  const { label, rest } = _splitLabel(m.title);
  const badge = String(m.badge || '');

  const bgCss = imgSrc
    ? `background-image:url('${imgSrc}');background-size:cover;background-position:50% 22%;`
    : `background:linear-gradient(135deg,#1a1a3e,#2d2d60);`;

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bgCss}
  animation: kbZoom 25s linear forwards;
  transform-origin: 50% 30%;
}
@keyframes kbZoom {
  from { transform: scale(1.0)  translate(-2%, 0); }
  to   { transform: scale(1.08) translate(2%, 0); }
}
.overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.12); }
.title-area {
  position: absolute; bottom: ${SAFE}px; left: 0; right: 0;
  display: flex; flex-direction: column; align-items: flex-start; gap: 18px;
}
.badges { display: flex; flex-direction: row; gap: 80px; align-items: center; padding-left: ${SAFE}px; }
.badge-item {
  display: inline-block; font-size: 41px; font-weight: 900;
  padding: 5px 26px; border-radius: 8px; letter-spacing: 2px;
  color: #fff; width: fit-content;
  animation: fadeUp 0.45s ease-out both;
}
.badge-primary   { background: rgba(200,0,0,0.95); animation-delay: 0s; }
.badge-secondary { background: rgba(180,100,0,0.95); animation-delay: 0.35s; }
.title-main {
  color: #fff; font-size: 82px; font-weight: 900; line-height: 1.3;
  background: rgba(0,0,0,0.6);
  padding: 48px 30px; width: 100%;
  overflow-wrap: break-word; word-break: break-all;
  animation: fadeUp 0.55s 0.6s ease-out both;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="overlay"></div>
<div class="title-area">
  <div class="badges">
    <div class="badge-item badge-primary">${esc(label)}</div>
    ${badge ? `<div class="badge-item badge-secondary">${esc(badge)}</div>` : ''}
  </div>
  <div class="title-main">${esc(rest)}</div>
</div>`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildV4OpeningHTML };
