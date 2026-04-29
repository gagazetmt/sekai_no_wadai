// scripts/v2_video/slides/ending_v2.js
// エンディング バリエーション V2: 要点サマリ型
//   - 動画の主要数字 3つを最後にもう一度フリップ表示
//   - 「データで覚えるサッカー」のコンセプト体現
//   - 中央: 3つの数字カード / 下: ロゴ + 登録 CTA
//   - mod.summaryStats = [{value:"63%", label:"ドリブル成功率"}, ...] で受け取る

const {
  PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle,
  buildSubtitleBar, subtitleArgFromMod, _t,
} = require('./_common');

const SVG_BELL = '<svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22zm6.6-6.6V10A6.6 6.6 0 0 0 13 3.5V2.6a1 1 0 1 0-2 0v.9A6.6 6.6 0 0 0 5.4 10v5.4L4 17v.8h16V17l-1.4-1.6z"/></svg>';
const SVG_THUMB = '<svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;"><path d="M2 10h4.5v11H2zm6.5 11V10l5.5-9c.9 0 1.7.7 1.7 1.7v6.6h6.7c1 0 1.7.7 1.7 1.7l-1.7 8.4c-.2.9-.9 1.6-1.8 1.6H8.5z"/></svg>';

function buildEndingHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const channelName = mod.channelName || '5分でサッカー分析';
  const ctaText = (mod.endingCta && mod.endingCta.text) || 'チャンネル登録お願い';

  // 要点 3つの数字（動画振り返り用）
  //   AI が summaryStats を生成（無ければ catchphrases や dataSlots から fallback）
  let stats = [];
  if (Array.isArray(mod.summaryStats) && mod.summaryStats.length) {
    stats = mod.summaryStats.slice(0, 3);
  } else if (Array.isArray(mod.catchphrases) && mod.catchphrases.length) {
    // catchphrases から数字+キーワード抽出を試みる
    stats = mod.catchphrases.slice(0, 3).map(p => ({ value: '', label: String(p || '') }));
  }
  while (stats.length < 3) stats.push({ value: '', label: '' });

  const subBarHtml = mod.narration ? buildSubtitleBar(subtitleArgFromMod(mod), { height: 110 }) : '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover; background-position: center;
  filter: brightness(0.55);
  ${bg ? 'animation: bgZoom 12s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.05); } }
.bg-overlay {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 50% 60%, rgba(245,158,11,0.12) 0%, transparent 70%),
    linear-gradient(135deg, rgba(6,14,28,0.50) 0%, rgba(6,14,28,0.70) 100%);
}

/* ── ヘッダ ── */
.recap-header {
  position: absolute;
  top: 60px; left: 0; right: 0;
  text-align: center;
  z-index: 5;
  opacity: 0;
  animation: fadeUp 0.6s ease-out 0.2s forwards;
}
.recap-header-en {
  font-family: 'Georgia', serif;
  font-size: 22px;
  font-weight: 400;
  letter-spacing: 8px;
  color: ${PALETTE.accent};
  text-transform: uppercase;
  margin-bottom: 6px;
}
.recap-header-jp {
  font-size: 56px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 6px;
  text-shadow: 0 2px 16px rgba(0,0,0,0.8);
}
.recap-bar {
  width: 200px; height: 4px;
  background: linear-gradient(90deg, transparent, ${PALETTE.accent}, transparent);
  margin: 14px auto 0;
}

/* ── 3 数字カード ── */
.stats-grid {
  position: absolute;
  top: 290px; left: 0; right: 0;
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 36px;
  padding: 0 80px;
  z-index: 5;
}
.stat-card {
  background: linear-gradient(160deg, rgba(245,158,11,0.18) 0%, rgba(6,14,28,0.6) 100%);
  border: 2px solid rgba(245,158,11,0.4);
  border-radius: 16px;
  padding: 36px 24px;
  text-align: center;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  opacity: 0;
  transform: translateY(40px) rotateX(15deg);
  animation: cardFlip 0.7s cubic-bezier(0.22, 1, 0.36, 1) forwards;
}
@keyframes cardFlip {
  from { opacity: 0; transform: translateY(40px) rotateX(15deg); }
  to   { opacity: 1; transform: translateY(0) rotateX(0); }
}
.stat-card:nth-child(1) { animation-delay: 0.6s; }
.stat-card:nth-child(2) { animation-delay: 0.85s; }
.stat-card:nth-child(3) { animation-delay: 1.1s; }
.stat-value {
  font-family: 'Georgia', serif;
  font-size: 110px;
  font-weight: 900;
  font-style: italic;
  color: ${PALETTE.accent};
  letter-spacing: -3px;
  line-height: 1;
  text-shadow: 0 0 24px rgba(245,158,11,0.5);
  margin-bottom: 14px;
}
.stat-label {
  font-size: 22px;
  font-weight: 700;
  color: ${PALETTE.text};
  letter-spacing: 1px;
  line-height: 1.3;
}

/* ── ロゴ + CTA（下部）── */
.cta-zone {
  position: absolute;
  bottom: ${mod.narration ? 180 : 80}px;
  left: 0; right: 0;
  text-align: center;
  z-index: 5;
}
.channel-logo-end {
  font-size: 32px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 8px;
  margin-bottom: 26px;
  opacity: 0;
  animation: fadeUp 0.6s ease-out 1.5s forwards;
  text-shadow: 0 0 18px rgba(245,158,11,0.4);
}
.cta-box {
  display: inline-flex; align-items: center; gap: 18px;
  background: ${PALETTE.accent};
  color: #000;
  padding: 22px 48px;
  border-radius: 14px;
  font-size: 38px;
  font-weight: 900;
  letter-spacing: 2px;
  box-shadow: 0 0 0 6px rgba(245,158,11,0.18), 0 8px 32px rgba(245,158,11,0.5);
  opacity: 0;
  animation: fadeUp 0.6s ease-out 1.7s forwards, ctaPulse 2.4s ease-in-out 2.5s infinite;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ctaPulse {
  0%, 100% { transform: scale(1);    box-shadow: 0 0 0 6px rgba(245,158,11,0.18), 0 8px 32px rgba(245,158,11,0.5); }
  50%      { transform: scale(1.04); box-shadow: 0 0 0 12px rgba(245,158,11,0.25), 0 12px 48px rgba(245,158,11,0.7); }
}
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="recap-header">
  <div class="recap-header-en">Today's Key Numbers</div>
  <div class="recap-header-jp">今日のポイント</div>
  <div class="recap-bar"></div>
</div>
<div class="stats-grid">
  ${stats.map(s => `<div class="stat-card">
    ${s.value ? `<div class="stat-value">${esc(s.value)}</div>` : ''}
    <div class="stat-label">${esc(s.label || '')}</div>
  </div>`).join('')}
</div>
<div class="cta-zone">
  <div class="channel-logo-end">${esc(channelName)}</div>
  <div class="cta-box">${SVG_BELL}<span>${esc(ctaText)}</span>${SVG_THUMB}</div>
</div>
${subBarHtml}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildEndingHTML };
