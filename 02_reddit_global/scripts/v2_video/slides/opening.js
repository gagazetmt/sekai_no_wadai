// scripts/v2_video/slides/opening.js
// オープニング：背景画像（ダーク）+ タイトルカード + 動的バッジ + 走光線
//   バッジは mod.openingBadge が指定されていればそれを、無ければ title から推論
//   narration があれば字幕バーを表示し、TTS 音声と同期

const {
  PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle,
  buildSubtitleBar, subtitleArgFromMod, _t,
} = require('./_common');

// タイトルから煽りバッジ（テキスト + 色）を自動推論
//   優先順: 衝撃/悲報/炎上 = 赤 → 朗報/快挙 = 緑 → 速報/電撃 = 橙 → 既定 OPENING = 橙
function _inferBadge(title) {
  const t = String(title || '');
  if (/衝撃|悲報|炎上|絶望|危機|終焉|崩壊|怒り/.test(t))   return { text: '衝撃',   color: '#ef4444', textColor: '#fff' };
  if (/朗報|快挙|祝|歓喜|栄光|偉業|歴史的/.test(t))         return { text: '朗報',   color: '#10b981', textColor: '#fff' };
  if (/速報|電撃|緊急|最新/.test(t))                         return { text: '速報',   color: '#f59e0b', textColor: '#000' };
  return { text: 'OPENING', color: '#f59e0b', textColor: '#000' };
}

function buildOpeningHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = _t(mod.title || mod.narration || 'OPENING');

  // バッジ：mod.openingBadge があれば優先（AI生成想定）、なければタイトルから自動推論
  const badge = (mod.openingBadge && mod.openingBadge.text)
    ? {
        text:      mod.openingBadge.text,
        color:     mod.openingBadge.color     || '#f59e0b',
        textColor: mod.openingBadge.textColor || '#000',
      }
    : _inferBadge(title);

  // タイトルが長い場合は 2行に自然分割（読みやすさ重視）
  const { lines: titleLines } = splitSubtitle(title, 18);
  // タイトル文字サイズは長さに応じて段階的に縮小
  let titleFontSize = 110;
  const longest = Math.max(...titleLines.map(l => l.length), 1);
  if (longest > 14) titleFontSize = 90;
  if (longest > 18) titleFontSize = 76;
  if (longest > 22) titleFontSize = 64;
  if (longest > 28) titleFontSize = 56;

  // 字幕（narration があるとき）
  const subBarHtml = mod.narration ? buildSubtitleBar(subtitleArgFromMod(mod), { height: 110 }) : '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : 'background: radial-gradient(ellipse at center, #1a2540 0%, #060e1c 100%);'}
  background-size: cover;
  background-position: center;
  filter: brightness(0.62);
  ${bg ? 'animation: bgZoom 8s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.1); } }
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(6,14,28,0.30) 0%, rgba(6,14,28,0.55) 100%);
}
/* ── 走光線エフェクト：画面斜めに白い帯が1回スイープする ──
     0.8s〜1.6s の間に左下から右上へ通過 */
.sweep-line {
  position: absolute; inset: 0;
  background: linear-gradient(115deg,
    transparent 30%,
    rgba(255,255,255,0.04) 44%,
    rgba(255,255,255,0.22) 50%,
    rgba(255,255,255,0.04) 56%,
    transparent 70%);
  background-size: 280% 280%;
  background-position: 100% 100%;
  animation: sweep 0.9s ease-out 0.8s backwards;
  pointer-events: none;
  z-index: 4;
}
@keyframes sweep {
  from { background-position: 100% 100%; opacity: 0; }
  20%  { opacity: 1; }
  to   { background-position: 0% 0%;     opacity: 0; }
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
  background: ${badge.color};
  color: ${badge.textColor};
  font-size: 36px;
  font-weight: 900;
  letter-spacing: 8px;
  border-radius: 8px;
  margin-bottom: 56px;
  box-shadow: 0 4px 24px ${badge.color}aa, 0 0 0 2px rgba(255,255,255,0.12) inset;
  animation: slideDown 0.55s ease-out 0.25s backwards, badgePulse 2.4s ease-in-out 1.6s infinite;
}
@keyframes badgePulse {
  0%, 100% { transform: scale(1);    box-shadow: 0 4px 24px ${badge.color}aa, 0 0 0 2px rgba(255,255,255,0.12) inset; }
  50%      { transform: scale(1.04); box-shadow: 0 6px 32px ${badge.color}, 0 0 0 2px rgba(255,255,255,0.20) inset; }
}
/* ── タイトル本体：白縁取り + 多重グローで背景画像に負けない強さ ── */
.title-main {
  font-size: ${titleFontSize}px;
  font-weight: 900;
  line-height: 1.18;
  color: #fff;
  -webkit-text-stroke: 2px rgba(255,255,255,0.18);
  text-shadow:
    0 0 8px rgba(255,255,255,0.45),
    0 0 24px rgba(245,158,11,0.35),
    0 6px 32px rgba(0,0,0,0.95),
    0 2px 4px rgba(0,0,0,1);
  max-width: 1620px;
  animation: slideUp 0.75s ease-out 0.7s backwards;
}
.title-main .line2 { display: block; }
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
<div class="sweep-line"></div>
<div class="title-wrap">
  <div class="badge">${esc(badge.text)}</div>
  <div class="title-main">${titleHtml}</div>
</div>
${subBarHtml}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildOpeningHTML };
