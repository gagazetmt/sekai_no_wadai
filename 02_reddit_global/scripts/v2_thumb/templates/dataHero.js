// scripts/v2_thumb/templates/dataHero.js
// サムネ テンプレ A: データ強調型（汎用・最頻出）
//   - 左に選手の顔写真（暗い背景に切り抜き想定）
//   - 右上に巨大な数字
//   - 右下に短いキャッチ
//   - 左下にチャンネルロゴ
//
// 入力:
//   {
//     heroImage: 'path/to/player.jpg',  // 左側の顔写真
//     heroNumber: '63%',                // 大きな数字
//     heroLabel: 'ドリブル成功率',       // 数字の意味（小さく）
//     catch: '今期PSGの真の主役',         // 太字キャッチ（2行可）
//     badge: '衝撃',                     // 上部小さいラベル（任意）
//     badgeColor: '#ef4444',
//     channelName: '5分でサッカー分析',
//   }

const { PALETTE, esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyle, CHANNEL_NAME } = require('../_common');

function buildDataHeroThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const heroNumber = data.heroNumber || '?';
  const heroLabel = data.heroLabel || '';
  const catchText = data.catch || '';
  const badge = data.badge || '';
  const badgeColor = data.badgeColor || PALETTE.red;
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 60% 80% at 30% 50%, rgba(245,158,11,0.18) 0%, transparent 60%),
    linear-gradient(135deg, #1f2a4a 0%, #0a0e1a 60%, #060a14 100%);
}
/* ── 左側：選手画像 ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 50%;
  ${heroImg ? `background-image: url('${heroImg}');` : `background: radial-gradient(circle at 50% 60%, #2a3560, #0d1220);`}
  background-size: cover;
  background-position: center 25%;
  filter: contrast(1.1) saturate(1.05);
}
.hero-photo::after {
  content: '';
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 200px;
  background: linear-gradient(to right, transparent 0%, ${PALETTE.bg} 100%);
}

/* ── 右側：データブロック ── */
.data-zone {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 60%;
  padding: 50px 50px 50px 80px;
  display: flex; flex-direction: column; justify-content: space-between;
  z-index: 5;
}

/* ── 上部 バッジ ── */
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
}

/* ── 巨大な数字 ── */
.hero-num-zone {
  text-align: right;
}
.hero-num {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 240px;
  font-weight: 900;
  font-style: italic;
  color: ${PALETTE.accent};
  letter-spacing: -10px;
  line-height: 0.9;
  text-shadow:
    0 0 40px rgba(245,158,11,0.55),
    0 0 100px rgba(245,158,11,0.3),
    0 8px 30px rgba(0,0,0,0.95);
  display: inline-block;
}
.hero-label {
  font-size: 26px;
  font-weight: 700;
  color: ${PALETTE.text};
  letter-spacing: 4px;
  margin-top: 8px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.8);
}

/* ── キャッチ ── */
.catch-zone {
  font-size: 56px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.18;
  -webkit-text-stroke: 2px rgba(255,255,255,0.18);
  text-shadow:
    0 0 12px rgba(255,255,255,0.4),
    0 0 28px rgba(245,158,11,0.4),
    0 6px 24px rgba(0,0,0,0.95);
  letter-spacing: 1px;
  max-width: 100%;
  word-break: keep-all;
  text-align: right;
}
.catch-zone::before {
  content: '';
  display: inline-block;
  width: 60px; height: 6px;
  background: ${PALETTE.accent};
  margin-bottom: 18px;
  margin-right: auto;
  margin-left: 0;
  box-shadow: 0 0 18px rgba(245,158,11,0.5);
}

${channelLogoStyle}
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
  <div class="catch-zone">${esc(catchText)}</div>
</div>
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail A: Data Hero' });
}

module.exports = { buildDataHeroThumb };
