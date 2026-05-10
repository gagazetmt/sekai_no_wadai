// scripts/v2_video/slides/opening_v3.js
// オープニング バリエーション V3: タイトル爆発型 + 走光線3連続
//   - 0.0-0.3秒: 真っ黒 → ロゴ「5分でサッカー分析」が中心からズーム登場
//   - 0.3-0.6秒: ロゴが画面右上に飛び去る
//   - 0.6-1.2秒: タイトル文字が下から強烈に飛び込んでくる（zoom + spring）
//   - 1.2-1.8秒: 走光線が3回連続で交差
//   - インパクト系・短尺動画向き

const {
  PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle,
  buildSubtitleBar, subtitleArgFromMod, _t,
  imageAdjustCss,
} = require('./_common');

function _inferBadge(title) {
  const t = String(title || '');
  if (/衝撃|悲報|炎上|絶望|危機|終焉|崩壊|怒り/.test(t))   return { text: '衝撃',   color: '#ef4444', textColor: '#fff' };
  if (/朗報|快挙|祝|歓喜|栄光|偉業|歴史的/.test(t))         return { text: '朗報',   color: '#10b981', textColor: '#fff' };
  if (/速報|電撃|緊急|最新/.test(t))                         return { text: '速報',   color: '#f59e0b', textColor: '#000' };
  return { text: 'ANALYSIS', color: '#f59e0b', textColor: '#000' };
}

function buildOpeningHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const imgAdj = imageAdjustCss(mod.imageAdjust);
  const title = _t(mod.title || mod.narration || 'OPENING');
  const channelName = mod.channelName || '5分でサッカー分析';

  const badge = (mod.openingBadge && mod.openingBadge.text)
    ? { text: mod.openingBadge.text, color: mod.openingBadge.color || '#f59e0b', textColor: mod.openingBadge.textColor || '#000' }
    : _inferBadge(title);

  const { lines: titleLines } = splitSubtitle(title, 18);
  let titleFontSize = 120;
  const longest = Math.max(...titleLines.map(l => l.length), 1);
  if (longest > 14) titleFontSize = 100;
  if (longest > 18) titleFontSize = 84;
  if (longest > 22) titleFontSize = 72;
  if (longest > 28) titleFontSize = 60;

  const subBarHtml = mod.narration ? buildSubtitleBar(subtitleArgFromMod(mod), { height: 110 }) : '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : 'background: radial-gradient(ellipse at center, #1f2a4a 0%, #050b18 100%);'}
  background-size: ${imgAdj.isDefault ? 'cover' : `${100 * imgAdj.zoom}%`};
  background-position: ${imgAdj.bgPosition};
  filter: brightness(0.5);
  opacity: 0;
  animation: bgIn 0.5s ease-out 0.35s forwards${bg ? ', bgZoom 8s ease-out 0.35s forwards' : ''};
}
@keyframes bgIn { to { opacity: 1; } }
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.1); } }
.bg-overlay {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 120% 80% at 50% 50%, transparent 30%, rgba(6,14,28,0.7) 100%),
    linear-gradient(135deg, rgba(6,14,28,0.30) 0%, rgba(6,14,28,0.60) 100%);
  opacity: 0;
  animation: bgIn 0.5s ease-out 0.35s forwards;
}

/* ── 中央ロゴ（最初の0.3秒だけ画面中央）→ 右上へ飛び去る ── */
.intro-logo {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%) scale(0.5);
  font-size: 64px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 6px;
  text-shadow: 0 0 40px rgba(245,158,11,0.8), 0 0 80px rgba(245,158,11,0.4);
  z-index: 8;
  opacity: 0;
  animation:
    introLogoIn 0.3s cubic-bezier(0.22, 1.4, 0.36, 1) 0s forwards,
    introLogoOut 0.4s cubic-bezier(0.5, 0, 0.75, 0) 0.35s forwards;
}
@keyframes introLogoIn {
  0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.5); }
  100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@keyframes introLogoOut {
  0%   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(60vw, -55vh) scale(0.3); }
}

/* ── 右上ロゴ（恒常表示） ── */
.corner-logo {
  position: absolute;
  top: 40px; right: 50px;
  font-size: 22px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 4px;
  padding: 8px 18px;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(245, 158, 11, 0.5);
  border-radius: 4px;
  z-index: 6;
  opacity: 0;
  animation: cornerIn 0.4s ease-out 0.75s forwards;
}
@keyframes cornerIn { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }

/* ── 走光線（3連続） ── */
.sweep-line, .sweep-line-2, .sweep-line-3 {
  position: absolute; inset: 0;
  pointer-events: none; z-index: 4;
  background-size: 280% 280%;
  background-position: 100% 100%;
  opacity: 0;
}
.sweep-line {
  background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.04) 44%, rgba(255,255,255,0.28) 50%, rgba(255,255,255,0.04) 56%, transparent 70%);
  animation: sweep 0.45s ease-out 1.1s backwards;
}
.sweep-line-2 {
  background: linear-gradient(65deg, transparent 30%, rgba(245,158,11,0.06) 44%, rgba(245,158,11,0.32) 50%, rgba(245,158,11,0.06) 56%, transparent 70%);
  animation: sweep 0.45s ease-out 1.35s backwards;
}
.sweep-line-3 {
  background: linear-gradient(115deg, transparent 30%, rgba(255,255,255,0.04) 44%, rgba(255,255,255,0.20) 50%, rgba(255,255,255,0.04) 56%, transparent 70%);
  animation: sweep 0.45s ease-out 1.6s backwards;
}
@keyframes sweep {
  0%   { background-position: 100% 100%; opacity: 0; }
  25%  { opacity: 1; }
  100% { background-position: 0% 0%; opacity: 0; }
}

/* ── タイトル（下から爆発的にズームイン） ── */
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
  background: ${badge.color};
  color: ${badge.textColor};
  font-size: 32px;
  font-weight: 900;
  letter-spacing: 8px;
  border-radius: 6px;
  margin-bottom: 40px;
  box-shadow: 0 4px 24px ${badge.color}aa, 0 0 0 2px rgba(255,255,255,0.12) inset;
  opacity: 0;
  animation: badgeIn 0.45s cubic-bezier(0.22, 1.5, 0.36, 1) 1.0s forwards, badgePulse 2.4s ease-in-out 2.0s infinite;
}
@keyframes badgeIn { from { opacity: 0; transform: translateY(-30px); } to { opacity: 1; transform: translateY(0); } }
@keyframes badgePulse {
  0%, 100% { transform: scale(1);    box-shadow: 0 4px 24px ${badge.color}aa, 0 0 0 2px rgba(255,255,255,0.12) inset; }
  50%      { transform: scale(1.05); box-shadow: 0 6px 32px ${badge.color}, 0 0 0 2px rgba(255,255,255,0.20) inset; }
}
/* タイトル：下から飛び込んでくる → 一瞬大きく → 元サイズ */
.title-main {
  font-size: ${titleFontSize}px;
  font-weight: 900;
  line-height: 1.16;
  color: #fff;
  -webkit-text-stroke: 2.5px rgba(255,255,255,0.2);
  text-shadow:
    0 0 12px rgba(255,255,255,0.5),
    0 0 32px rgba(245,158,11,0.5),
    0 8px 40px rgba(0,0,0,0.95),
    0 2px 6px rgba(0,0,0,1);
  max-width: 1620px;
  opacity: 0;
  animation: titleExplode 0.7s cubic-bezier(0.22, 1.5, 0.36, 1) 0.85s forwards;
}
@keyframes titleExplode {
  0%   { opacity: 0; transform: translateY(180px) scale(0.4); filter: blur(8px); }
  60%  { opacity: 1; transform: translateY(-12px) scale(1.08); filter: blur(0); }
  100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
.title-main .line2 { display: block; }
`;

  const titleHtml = titleLines.length > 1
    ? `${esc(titleLines[0])}<br>${esc(titleLines[1])}`
    : esc(titleLines[0] || '');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="intro-logo">${esc(channelName)}</div>
<div class="corner-logo">${esc(channelName)}</div>
<div class="sweep-line"></div>
<div class="sweep-line-2"></div>
<div class="sweep-line-3"></div>
<div class="title-wrap">
  <div class="badge">${esc(badge.text)}</div>
  <div class="title-main">${titleHtml}</div>
</div>
${subBarHtml}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildOpeningHTML };
