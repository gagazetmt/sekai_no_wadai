// scripts/v2_video/slides/opening.js
// オープニング：背景画像（ダーク）+ タイトルカード

const { PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle, _t } = require('./_common');

function buildOpeningHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = _t(mod.title || mod.narration || 'OPENING');
  const sub   = mod.narration && mod.title && mod.narration !== mod.title ? mod.narration : '';

  // タイトルが長い場合は 2行に自然分割（読みやすさ重視）
  const { lines: titleLines, fontSize: subFont } = splitSubtitle(title, 18);
  // タイトル文字サイズは長さに応じて段階的に縮小
  let titleFontSize = 110;
  const longest = Math.max(...titleLines.map(l => l.length), 1);
  if (longest > 14) titleFontSize = 90;
  if (longest > 18) titleFontSize = 76;
  if (longest > 22) titleFontSize = 64;

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
  font-size: ${titleFontSize}px;
  font-weight: 900;
  line-height: 1.2;
  text-shadow: 0 6px 32px rgba(0,0,0,0.9);
  max-width: 1620px;
  animation: slideUp 0.8s ease-out 0.8s backwards;
}
.title-main .line2 { display: block; }
.title-sub {
  margin-top: 36px;
  font-size: 36px;
  font-weight: 600;
  color: ${PALETTE.accent};
  line-height: 1.5;
  max-width: 1400px;
  animation: slideUp 0.8s ease-out 1.5s backwards;
}
@keyframes slideUp { from { opacity: 0; transform: translateY(40px); } to { opacity: 1; transform: translateY(0); } }
@keyframes slideDown { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
`;

  // 2行に分割した場合、間に <br> を入れる
  const titleHtml = titleLines.length > 1
    ? `${esc(titleLines[0])}<br>${esc(titleLines[1])}`
    : esc(titleLines[0] || '');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="title-wrap">
  <div class="badge">OPENING</div>
  <div class="title-main">${titleHtml}</div>
  ${sub ? `<div class="title-sub">${esc(sub.slice(0, 60))}</div>` : ''}
</div>`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildOpeningHTML };
