// scripts/v2_video/slides/ending.js
// エンディング：締めメッセージ + チャンネル登録促し
//   - タイトルは長さで自動2行分割＋自動縮小（opening と同じ思想）
//   - narration は字幕バーで音声同期表示（end-narr 廃止でオーバーフロー解消）
//   - CTA文言は mod.endingCta.text で差し替え可（AI生成想定）
//   - 背景は軽くズームで余韻を出す
//   - emoji は SVG 化で環境依存の四角化を回避

const {
  PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle,
  buildSubtitleBar, subtitleArgFromMod, _t,
} = require('./_common');

// SVG アイコン（emoji 環境依存回避）
const SVG_BELL = '<svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22zm6.6-6.6V10A6.6 6.6 0 0 0 13 3.5V2.6a1 1 0 1 0-2 0v.9A6.6 6.6 0 0 0 5.4 10v5.4L4 17v.8h16V17l-1.4-1.6z"/></svg>';
const SVG_THUMB = '<svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;"><path d="M2 10h4.5v11H2zm6.5 11V10l5.5-9c.9 0 1.7.7 1.7 1.7v6.6h6.7c1 0 1.7.7 1.7 1.7l-1.7 8.4c-.2.9-.9 1.6-1.8 1.6H8.5z"/></svg>';
const SVG_ARROW_DOWN = '<svg width="56" height="56" viewBox="0 0 24 24" fill="currentColor"><path d="M12 16.5l-7-7h14z"/></svg>';

function buildEndingHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = _t(mod.title) || '次回もお楽しみに！';

  // タイトルが長い場合は 2行に自然分割 + 文字サイズ自動縮小
  //   maxLineLen=14 で 15字以上は 2行に強制（CSS auto-wrap で 1字オーファン化を防ぐ）
  const { lines: titleLines } = splitSubtitle(title, 14);
  let titleFontSize = 120;
  const longest = Math.max(...titleLines.map(l => l.length), 1);
  if (longest > 14) titleFontSize = 100;
  if (longest > 18) titleFontSize = 84;
  if (longest > 22) titleFontSize = 70;
  if (longest > 28) titleFontSize = 60;
  // ── 安全クランプ ──
  //   max-width 1620px 内に必ず収まるよう、日本語1字 ≈ font-size px と仮定して
  //   font を動的に縮める。これで CSS auto-wrap (1字 trail) が発生しなくなる
  const safeFontMax = Math.floor((1620 / longest) * 0.95);
  if (titleFontSize > safeFontMax) titleFontSize = Math.max(safeFontMax, 48);
  const titleHtml = titleLines.length > 1
    ? `${esc(titleLines[0])}<br>${esc(titleLines[1])}`
    : esc(titleLines[0] || '');

  // CTA テキスト：mod.endingCta.text 優先。無ければデフォルト
  const ctaText = (mod.endingCta && mod.endingCta.text) || 'チャンネル登録 & いいね';

  // 字幕バー（narration あれば）
  const hasNarr = !!String(mod.narration || '').trim();
  const subBarHtml = hasNarr ? buildSubtitleBar(subtitleArgFromMod(mod), { height: 110 }) : '';

  // 字幕バー有り(110px)時は下方パディングを増やしCTA重なり回避
  const wrapPadBottom = hasNarr ? 180 : 80;
  const arrowBottom   = hasNarr ? 188 : 88;

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover;
  background-position: center;
  filter: brightness(0.62);
  ${bg ? 'animation: bgZoom 12s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.05); } }
.bg-overlay {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 60% at 50% 60%, rgba(245,158,11,0.10) 0%, transparent 70%),
    linear-gradient(135deg, rgba(6,14,28,0.30) 0%, rgba(6,14,28,0.55) 100%);
}
.end-wrap {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; justify-content: center; align-items: center;
  padding: 80px 80px ${wrapPadBottom}px;
  text-align: center;
  z-index: 5;
}
.end-title {
  font-size: ${titleFontSize}px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.18;
  -webkit-text-stroke: 2px rgba(255,255,255,0.18);
  text-shadow:
    0 0 8px rgba(255,255,255,0.45),
    0 0 24px rgba(245,158,11,0.35),
    0 6px 32px rgba(0,0,0,0.95);
  max-width: 1620px;
  margin-bottom: 56px;
  animation: fadeIn 0.8s ease-out 0.3s backwards;
}
.cta-box {
  background: ${PALETTE.accent};
  color: #000;
  padding: 24px 56px;
  border-radius: 16px;
  font-size: 46px;
  font-weight: 900;
  letter-spacing: 2px;
  box-shadow: 0 0 0 8px rgba(245,158,11,0.2), 0 8px 40px rgba(245,158,11,0.5);
  animation: fadeIn 0.8s ease-out 0.9s backwards, ctaPulse 2.5s ease-in-out 1.6s infinite backwards;
  display: inline-flex; align-items: center; gap: 22px;
}
.cta-arrow-down {
  position: absolute;
  bottom: ${arrowBottom}px;
  left: 50%;
  transform: translateX(-50%) translateY(0);
  color: ${PALETTE.accent};
  filter: drop-shadow(0 0 12px rgba(245,158,11,0.7));
  animation: fadeIn 0.6s ease-out 1.4s backwards, arrowBounce 1.5s ease-in-out 2s infinite backwards;
  z-index: 6;
  pointer-events: none;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ctaPulse {
  0%, 100% { transform: scale(1);    box-shadow: 0 0 0 8px rgba(245,158,11,0.2), 0 8px 40px rgba(245,158,11,0.5); }
  50%      { transform: scale(1.05); box-shadow: 0 0 0 14px rgba(245,158,11,0.25), 0 12px 60px rgba(245,158,11,0.7); }
}
@keyframes arrowBounce {
  0%, 100% { opacity: 0.85; transform: translateX(-50%) translateY(0); }
  50%      { opacity: 1.0;  transform: translateX(-50%) translateY(14px); }
}
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="end-wrap">
  <div class="end-title">${titleHtml}</div>
  <div class="cta-box">${SVG_BELL}<span>${esc(ctaText)}</span>${SVG_THUMB}</div>
</div>
<div class="cta-arrow-down">${SVG_ARROW_DOWN}</div>
${subBarHtml}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildEndingHTML };
