// scripts/v2_thumb/templates/dataHero.js
// サムネ テンプレ A: データ強調型（汎用・最頻出）
//   - 左に選手の顔写真（暗い背景に切り抜き想定）
//   - 右上に巨大な数字
//   - 右下に短いキャッチ
//   - 左下にチャンネルロゴ
//   - tone: 'dark' | 'light' で配色切替

const {
  PALETTE, tonePalette, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildDataHeroThumb(data = {}) {
  const tone = data.tone || 'dark';
  const isLight = tone === 'light';
  const p = tonePalette(tone);
  const heroImg = imgDataUri(data.heroImage);
  const heroNumber = data.heroNumber || '?';
  const heroLabel = data.heroLabel || '';
  const catchText = data.catch || '';
  const badge = data.badge || '';
  const badgeColor = data.badgeColor || p.red;
  const channelName = data.channelName || CHANNEL_NAME;

  // 数字: 多層ストローク + 黒影3段 で 3D ポップ感
  const heroNumShadow = isLight
    ? `4px 4px 0 #b45309, 6px 6px 0 #000, 8px 12px 24px rgba(0,0,0,0.45)`
    : `4px 4px 0 #b45309, 6px 6px 0 #000, 0 0 36px rgba(252,211,77,0.7), 8px 16px 30px rgba(0,0,0,0.95)`;
  // キャッチ: 黒縁取り + 黄色グロー + ドロップシャドウ
  const catchShadow = isLight
    ? `2px 2px 0 #000, 3px 3px 0 #fcd34d, 4px 4px 0 #000, 0 8px 18px rgba(0,0,0,0.35)`
    : `2px 2px 0 #000, 3px 3px 0 #fcd34d, 4px 4px 0 #000, 0 0 22px rgba(252,211,77,0.55), 0 8px 22px rgba(0,0,0,0.95)`;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background: ${isLight
    ? `radial-gradient(ellipse 60% 80% at 30% 50%, rgba(245,158,11,0.12) 0%, transparent 60%),
       linear-gradient(135deg, #fefaf2 0%, #f7f3ec 60%, #f0e8d8 100%)`
    : `radial-gradient(ellipse 60% 80% at 30% 50%, rgba(245,158,11,0.18) 0%, transparent 60%),
       linear-gradient(135deg, #1f2a4a 0%, #0a0e1a 60%, #060a14 100%)`};
}
/* ── 左側：選手画像 ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 64%;
  ${heroImg ? `background-image: url('${heroImg}');` : `background: ${isLight ? 'radial-gradient(circle at 50% 60%, #d8c8a8, #b8a888)' : 'radial-gradient(circle at 50% 60%, #2a3560, #0d1220)'};`}
  background-size: cover;
  background-position: center 25%;
  filter: contrast(1.1) saturate(1.05);
}
.hero-photo::after {
  content: '';
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 110px;
  background: linear-gradient(to right, transparent 0%, ${p.bg} 100%);
}

/* ── 右側：データブロック ── */
.data-zone {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 44%;
  padding: 30px 40px 40px 50px;
  display: flex; flex-direction: column;
  z-index: 5;
}

.top-badge {
  display: ${badge ? 'inline-flex' : 'none'};
  align-items: center; gap: 10px;
  align-self: flex-start;
  background: ${badgeColor};
  color: #fff;
  padding: 10px 24px;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 26px;
  font-weight: 900;
  letter-spacing: 4px;
  border: 3px solid #000;
  border-radius: 6px;
  box-shadow: 4px 4px 0 #000, 0 6px 22px ${badgeColor}80;
  margin-bottom: 14px;
  -webkit-text-stroke: 1px #000;
  text-shadow: 2px 2px 0 #000;
}
.top-badge::before {
  content: '◆';
  font-size: 22px;
  color: #fcd34d;
  text-shadow: 1px 1px 0 #000;
}

/* 数字ゾーン: 上寄り配置 */
.hero-num-zone {
  text-align: right;
  margin-top: ${badge ? '0' : '20px'};
  margin-bottom: 20px;
}
.hero-num {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Arial Black', sans-serif;
  font-size: 230px;
  font-weight: 900;
  font-style: italic;
  color: ${p.accent};
  letter-spacing: -10px;
  line-height: 0.88;
  -webkit-text-stroke: 5px #000;
  text-shadow: ${heroNumShadow};
  display: inline-block;
  transform: skewX(-6deg);
}
.hero-label {
  display: inline-block;
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 26px;
  font-weight: 900;
  color: #000;
  background: ${p.accent};
  letter-spacing: 3px;
  padding: 6px 16px;
  margin-top: 8px;
  border: 3px solid #000;
  border-radius: 4px;
  box-shadow: 3px 3px 0 #000;
}

/* キャッチ: 下寄り配置で 2行折返し対応 */
.catch-zone {
  display: flex; flex-direction: column; align-items: flex-end;
  margin-top: auto;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Arial Black', sans-serif;
  font-size: 56px;
  font-weight: 900;
  color: ${p.text};
  line-height: 1.18;
  -webkit-text-stroke: 3px #000;
  text-shadow: ${catchShadow};
  letter-spacing: 0px;
  max-width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
  text-align: right;
}
.catch-bar {
  display: block;
  width: 80px; height: 6px;
  background: ${p.accent};
  margin-bottom: 14px;
  box-shadow: 0 0 18px ${isLight ? 'rgba(194,116,10,0.4)' : 'rgba(245,158,11,0.5)'};
  align-self: flex-end;
}

${channelLogoStyleFor(tone)}
`;

  const thumbBody = `
<div class="bg-gradient"></div>
<div class="hero-photo"></div>
<div class="data-zone">
  ${badge ? `<div class="top-badge">${esc(badge)}</div>` : '<div></div>'}
  <div class="hero-num-zone">
    <div class="hero-num">${esc(heroNumber)}</div>
    ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
  </div>
  <div class="catch-zone"><span class="catch-bar"></span>${esc(catchText)}</div>
</div>
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail A (${tone}): Data Hero`, tone });
}

module.exports = { buildDataHeroThumb };
