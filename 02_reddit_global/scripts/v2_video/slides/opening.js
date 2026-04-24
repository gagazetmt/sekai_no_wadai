// scripts/v2_video/slides/opening.js
// オープニング：背景画像（ダーク）+ タイトルカード

const { PALETTE, esc, imgDataUri, wrapHTML } = require('./_common');

function buildOpeningHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = mod.title || mod.narration || 'OPENING';
  const sub   = mod.narration && mod.title && mod.narration !== mod.title ? mod.narration : '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : ''}
  background-size: cover;
  background-position: center;
  filter: brightness(0.35);
  ${bg ? 'animation: bgZoom 8s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.1); } }
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(6,14,28,0.55) 0%, rgba(6,14,28,0.85) 100%);
}
.title-wrap {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 120px 80px;
  text-align: center;
  z-index: 5;
}
.badge {
  display: inline-block;
  padding: 14px 42px;
  background: ${PALETTE.accent};
  color: #000;
  font-size: 36px;
  font-weight: 900;
  letter-spacing: 8px;
  border-radius: 8px;
  margin-bottom: 60px;
  animation: slideDown 0.6s ease-out 0.3s backwards;
}
.title-main {
  font-size: 140px;
  font-weight: 900;
  line-height: 1.15;
  text-shadow: 0 6px 32px rgba(0,0,0,0.9);
  max-width: 1500px;
  animation: slideUp 0.8s ease-out 0.8s backwards;
}
.title-sub {
  margin-top: 44px;
  font-size: 42px;
  font-weight: 600;
  color: ${PALETTE.accent};
  line-height: 1.5;
  max-width: 1400px;
  animation: slideUp 0.8s ease-out 1.5s backwards;
}
@keyframes slideUp { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="title-wrap">
  <div class="badge">OPENING</div>
  <div class="title-main">${esc(title)}</div>
  ${sub ? `<div class="title-sub">${esc(sub)}</div>` : ''}
</div>`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildOpeningHTML };
