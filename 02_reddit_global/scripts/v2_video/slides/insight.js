// scripts/v2_video/slides/insight.js
// Insight スライド：キャッチコピーが上から順にフェードイン（V1 再現）
// テンプレート元: /insight/index.html（プレビュー版から editor を除外して1920x1080 に最適化）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod } = require('./_common');

function buildInsightHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  // catchphrases が優先。無ければ narrationChunks（chunk表示用）か title から
  const phrases = (Array.isArray(mod.catchphrases) && mod.catchphrases.length)
    ? mod.catchphrases.slice(0, 5)
    : (Array.isArray(mod.narrationChunks) ? mod.narrationChunks.slice(0, 5) : (mod.title ? [mod.title] : []));
  const subText = mod.narration || '';
  const insightTitle = mod.title || 'KEY POINTS';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: ${PALETTE.bg};`}
  background-size: cover;
  background-position: center;
}
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    rgba(6, 14, 28, 0.92) 0%,
    rgba(6, 14, 28, 0.78) 50%,
    rgba(6, 14, 28, 0.60) 100%);
}
.insight-title {
  position: absolute;
  top: 70px;
  left: 80px;
  font-size: 52px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 2px;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
  z-index: 5;
}
.catchphrases {
  position: absolute;
  top: 190px;
  left: 80px;
  right: 80px;
  bottom: 180px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 28px;
  z-index: 5;
}
.phrase {
  opacity: 0;
  transform: translateY(20px);
  animation: fadeInUp 0.8s ease-out forwards;

  display: flex;
  align-items: center;
  min-height: 96px;
  padding: 18px 40px;
  border-left: 12px solid ${PALETTE.accent};
  border-radius: 0 16px 16px 0;
  background: linear-gradient(to right,
    rgba(245, 158, 11, 0.22) 0%,
    rgba(245, 158, 11, 0.10) 30%,
    rgba(6, 14, 28, 0.35) 100%);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  font-size: 56px;
  font-weight: 800;
  color: ${PALETTE.text};
  line-height: 1.3;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.8);
}
.phrase:nth-child(1) { animation-delay: 0.2s; }
.phrase:nth-child(2) { animation-delay: 1.2s; }
.phrase:nth-child(3) { animation-delay: 2.2s; }
.phrase:nth-child(4) { animation-delay: 3.2s; }
.phrase:nth-child(5) { animation-delay: 4.2s; }
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="insight-title">${esc(insightTitle)}</div>
<div class="catchphrases">
  ${phrases.map(p => `<div class="phrase">${esc(p)}</div>`).join('')}
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildInsightHTML };
