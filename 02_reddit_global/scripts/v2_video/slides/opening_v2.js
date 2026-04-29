// scripts/v2_video/slides/opening_v2.js
// オープニング バリエーション V2: 数字フラッシュ強調型
//   - 0.0-0.3秒: チャンネルロゴ「5分でサッカー分析」フラッシュイン
//   - 0.3-1.0秒: 巨大な数字（mod.heroNumber）が走光線とともに登場
//   - 1.0-1.6秒: 数字が左に縮小移動 → タイトル右からスライドイン
//   - データ重視チャンネルの世界観を冒頭で明示

const {
  PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle,
  buildSubtitleBar, subtitleArgFromMod, _t,
} = require('./_common');

function _inferBadge(title) {
  const t = String(title || '');
  if (/衝撃|悲報|炎上|絶望|危機|終焉|崩壊|怒り/.test(t))   return { text: '衝撃',   color: '#ef4444', textColor: '#fff' };
  if (/朗報|快挙|祝|歓喜|栄光|偉業|歴史的/.test(t))         return { text: '朗報',   color: '#10b981', textColor: '#fff' };
  if (/速報|電撃|緊急|最新/.test(t))                         return { text: '速報',   color: '#f59e0b', textColor: '#000' };
  return { text: 'TODAY', color: '#f59e0b', textColor: '#000' };
}

function buildOpeningHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = _t(mod.title || mod.narration || 'OPENING');
  const channelName = mod.channelName || '5分でサッカー分析';
  const heroNumber = String(mod.heroNumber || '').trim();  // 例: "63%" "24G" "5-4"
  const heroLabel = String(mod.heroLabel || '').trim();    // 例: "今日のキー数字"

  const badge = (mod.openingBadge && mod.openingBadge.text)
    ? { text: mod.openingBadge.text, color: mod.openingBadge.color || '#f59e0b', textColor: mod.openingBadge.textColor || '#000' }
    : _inferBadge(title);

  const { lines: titleLines } = splitSubtitle(title, 18);
  let titleFontSize = 92;
  const longest = Math.max(...titleLines.map(l => l.length), 1);
  if (longest > 14) titleFontSize = 76;
  if (longest > 18) titleFontSize = 64;
  if (longest > 22) titleFontSize = 56;
  if (longest > 28) titleFontSize = 48;

  const subBarHtml = mod.narration ? buildSubtitleBar(subtitleArgFromMod(mod), { height: 110 }) : '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : 'background: radial-gradient(ellipse at center, #1a2540 0%, #060e1c 100%);'}
  background-size: cover; background-position: center;
  filter: brightness(0.55);
  ${bg ? 'animation: bgZoom 8s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.1); } }
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(6,14,28,0.40) 0%, rgba(6,14,28,0.65) 100%);
}

/* ── チャンネルロゴ（左下フラッシュ）── */
.channel-logo {
  position: absolute;
  left: 60px; bottom: 60px;
  font-size: 24px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 4px;
  padding: 10px 22px;
  background: rgba(245, 158, 11, 0.95);
  color: #000;
  border-radius: 6px;
  box-shadow: 0 4px 20px rgba(245, 158, 11, 0.5);
  z-index: 6;
  opacity: 0;
  transform: scale(0.7);
  animation: logoFlash 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) 0.05s forwards;
}
@keyframes logoFlash {
  0%   { opacity: 0; transform: scale(0.7); }
  60%  { opacity: 1; transform: scale(1.08); }
  100% { opacity: 1; transform: scale(1); }
}

/* ── 走光線（数字登場時）── */
.sweep-line {
  position: absolute; inset: 0;
  background: linear-gradient(115deg,
    transparent 30%,
    rgba(255,255,255,0.05) 44%,
    rgba(255,255,255,0.30) 50%,
    rgba(255,255,255,0.05) 56%,
    transparent 70%);
  background-size: 280% 280%;
  background-position: 100% 100%;
  animation: sweep 0.7s ease-out 0.35s backwards;
  pointer-events: none; z-index: 4;
}
@keyframes sweep {
  from { background-position: 100% 100%; opacity: 0; }
  20%  { opacity: 1; }
  to   { background-position: 0% 0%; opacity: 0; }
}

/* ── ヒーロー数字（中央 → 左移動）── */
.hero-zone {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  z-index: 5;
}
.hero-num {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 280px;
  font-weight: 900;
  font-style: italic;
  color: ${PALETTE.accent};
  letter-spacing: -8px;
  text-shadow:
    0 0 30px rgba(245,158,11,0.6),
    0 0 80px rgba(245,158,11,0.3),
    0 8px 40px rgba(0,0,0,0.9);
  opacity: 0;
  /* 0.4s で大きく登場 → 1.2s で左へ縮小移動 */
  animation:
    heroIn 0.55s cubic-bezier(0.22, 1.5, 0.36, 1) 0.4s backwards,
    heroShift 0.7s cubic-bezier(0.4, 0, 0.2, 1) 1.2s forwards;
}
@keyframes heroIn {
  0%   { opacity: 0; transform: scale(0.4); }
  60%  { opacity: 1; transform: scale(1.12); }
  100% { opacity: 1; transform: scale(1); }
}
@keyframes heroShift {
  0%   { transform: scale(1) translateX(0); font-size: 280px; }
  100% { transform: scale(1) translateX(-560px); font-size: 160px; }
}
.hero-label {
  position: absolute;
  font-size: 18px;
  font-weight: 700;
  color: ${PALETTE.muted};
  letter-spacing: 6px;
  margin-top: 200px;
  opacity: 0;
  animation: labelFade 0.4s ease-out 0.7s forwards, labelMove 0.7s cubic-bezier(0.4, 0, 0.2, 1) 1.2s forwards;
  z-index: 5;
}
@keyframes labelFade { to { opacity: 1; } }
@keyframes labelMove {
  0%   { transform: translateX(0); }
  100% { transform: translateX(-560px); margin-top: 130px; }
}

/* ── タイトル（右からスライドイン）── */
.title-zone {
  position: absolute;
  top: 50%; right: 80px;
  transform: translateY(-50%);
  width: 950px;
  text-align: left;
  z-index: 5;
  opacity: 0;
  animation: titleSlide 0.65s cubic-bezier(0.22, 1, 0.36, 1) 1.5s forwards;
}
@keyframes titleSlide {
  from { opacity: 0; transform: translate(80px, -50%); }
  to   { opacity: 1; transform: translate(0, -50%); }
}
.badge {
  display: inline-block;
  padding: 8px 24px;
  background: ${badge.color};
  color: ${badge.textColor};
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 6px;
  border-radius: 4px;
  margin-bottom: 22px;
}
.title-main {
  font-size: ${titleFontSize}px;
  font-weight: 900;
  line-height: 1.18;
  color: #fff;
  -webkit-text-stroke: 2px rgba(255,255,255,0.18);
  text-shadow:
    0 0 8px rgba(255,255,255,0.4),
    0 0 24px rgba(245,158,11,0.4),
    0 6px 32px rgba(0,0,0,0.95);
}
.title-main .line2 { display: block; }
`;

  const titleHtml = titleLines.length > 1
    ? `${esc(titleLines[0])}<br>${esc(titleLines[1])}`
    : esc(titleLines[0] || '');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="sweep-line"></div>
<div class="channel-logo">${esc(channelName)}</div>
<div class="hero-zone">
  ${heroNumber ? `<div class="hero-num">${esc(heroNumber)}</div>` : ''}
  ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
</div>
<div class="title-zone">
  <div class="badge">${esc(badge.text)}</div>
  <div class="title-main">${titleHtml}</div>
</div>
${subBarHtml}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildOpeningHTML };
