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

  // light tone 時はテキストシャドウ控えめ
  const heroNumShadow = isLight
    ? `0 4px 12px rgba(194,116,10,0.25), 0 2px 4px rgba(0,0,0,0.15)`
    : `0 0 40px rgba(245,158,11,0.55), 0 0 100px rgba(245,158,11,0.3), 0 8px 30px rgba(0,0,0,0.95)`;
  const catchShadow = isLight
    ? `0 2px 8px rgba(0,0,0,0.10)`
    : `0 0 12px rgba(255,255,255,0.4), 0 0 28px rgba(245,158,11,0.4), 0 6px 24px rgba(0,0,0,0.95)`;

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
  display: ${badge ? 'inline-block' : 'none'};
  align-self: flex-start;
  background: ${badgeColor};
  color: #fff;
  padding: 8px 22px;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: 4px;
  border-radius: 4px;
  box-shadow: 0 4px 18px ${badgeColor}80;
  margin-bottom: 14px;
}

/* 数字ゾーン: 上寄り配置 */
.hero-num-zone {
  text-align: right;
  margin-top: ${badge ? '0' : '20px'};
  margin-bottom: 20px;
}
.hero-num {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 180px;
  font-weight: 900;
  font-style: italic;
  color: ${p.accent};
  letter-spacing: -8px;
  line-height: 0.9;
  text-shadow: ${heroNumShadow};
  display: inline-block;
}
.hero-label {
  font-size: 24px;
  font-weight: 700;
  color: ${p.text};
  letter-spacing: 4px;
  margin-top: 4px;
  text-shadow: ${isLight ? 'none' : '0 2px 10px rgba(0,0,0,0.8)'};
}

/* キャッチ: 下寄り配置で 2行折返し対応 */
.catch-zone {
  display: flex; flex-direction: column; align-items: flex-end;
  margin-top: auto;
  font-size: 44px;
  font-weight: 900;
  color: ${p.text};
  line-height: 1.22;
  ${isLight ? '' : `-webkit-text-stroke: 2px rgba(255,255,255,0.18);`}
  text-shadow: ${catchShadow};
  letter-spacing: 1px;
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
