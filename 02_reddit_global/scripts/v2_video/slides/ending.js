// scripts/v2_video/slides/ending.js
// エンディング：締めメッセージ + チャンネル登録促し

const { PALETTE, esc, imgDataUri, wrapHTML } = require('./_common');

function buildEndingHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = mod.title || 'ありがとう！';
  const narr  = mod.narration || '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover;
  background-position: center;
  filter: brightness(0.25);
}
.bg-overlay {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 80% 60% at 50% 60%, rgba(245,158,11,0.08) 0%, transparent 70%);
}
.end-wrap {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 100px 80px;
  text-align: center;
  z-index: 5;
}
.end-title {
  font-size: 120px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.2;
  text-shadow: 0 6px 32px rgba(0,0,0,0.9);
  max-width: 1500px;
  margin-bottom: 40px;
  animation: fadeIn 0.8s ease-out 0.3s backwards;
}
.end-narr {
  font-size: 44px;
  font-weight: 600;
  color: ${PALETTE.muted};
  line-height: 1.5;
  max-width: 1400px;
  margin-bottom: 80px;
  animation: fadeIn 0.8s ease-out 0.8s backwards;
}
.cta-box {
  background: ${PALETTE.accent};
  color: #000;
  padding: 28px 72px;
  border-radius: 16px;
  font-size: 48px;
  font-weight: 900;
  letter-spacing: 2px;
  box-shadow: 0 0 0 8px rgba(245,158,11,0.2), 0 8px 40px rgba(245,158,11,0.5);
  animation: ctaPulse 2.5s ease-in-out 1.4s infinite backwards;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ctaPulse {
  0%, 100% { transform: scale(1); box-shadow: 0 0 0 8px rgba(245,158,11,0.2), 0 8px 40px rgba(245,158,11,0.5); }
  50%      { transform: scale(1.05); box-shadow: 0 0 0 14px rgba(245,158,11,0.25), 0 12px 60px rgba(245,158,11,0.7); }
}
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="end-wrap">
  <div class="end-title">${esc(title)}</div>
  ${narr ? `<div class="end-narr">${esc(narr)}</div>` : ''}
  <div class="cta-box">🔔 チャンネル登録 &amp; 👍 いいね</div>
</div>`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildEndingHTML };
