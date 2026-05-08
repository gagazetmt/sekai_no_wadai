// scripts/v2_thumb/templates/regalBlue.js
// サムネ テンプレ R-Blue: REGAL ANALYSIS（青×ゴールド・知的分析系）
//   gpt-image-1 が生成した「②オリーセ覚醒の真相」のレイアウトを HTML/CSS 化
//
//   レイアウト:
//     - 左 55% に選手の躍動的写真（ドリブル等の全身〜半身）
//     - 右上に巨大数字（serif italic ゴールド）+ 直下にラベル
//     - 中央〜下中央に大きなメインタイトル（白太ゴシック、1-2行）
//     - 下端にサブタイトル帯（白い水平線アクセント、ベージュ細字）
//   トーン:
//     ロイヤルブルー(#1e3a8a) × ネイビー(#0c1e4a) × ゴールド(#d4a437) × オフホワイト
//   特徴:
//     背景に微細なドットパターン → 「データ・分析感」の格調

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildRegalBlueThumb(data = {}) {
  const heroImg    = imgDataUri(data.heroImage);
  const heroNumber = data.heroNumber || '?';
  const heroLabel  = data.heroLabel  || '';
  const title      = data.title      || '';
  const subtitle   = data.subtitle   || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const titleLines = String(title).split('\n');
  const longestLine = Math.max(...titleLines.map(l => [...l].length), 0);
  const titleSize = longestLine <= 5 ? 124
                  : longestLine <= 7 ? 110
                  : longestLine <= 9 ? 96
                  :                    82;

  const extraStyles = `
/* ── ベース背景：ロイヤルブルー × ドットパターン ── */
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 90% 70% at 50% 50%, rgba(30,58,138,0.55) 0%, transparent 70%),
    linear-gradient(135deg, #0c1e4a 0%, #0a1838 40%, #060a1f 100%);
}
.bg-dots {
  position: absolute; inset: 0;
  background-image:
    radial-gradient(rgba(212,164,55,0.10) 1px, transparent 1px),
    radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 18px 18px, 6px 6px;
  background-position: 0 0, 9px 9px;
  pointer-events: none;
}

/* ── 左側：選手写真（フルブリード+右フェード）── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 62%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 60%, #1e3a8a, #0a0e1a);'}
  background-size: cover;
  background-position: center 30%;
  filter: contrast(1.10) saturate(1.18);
}
.hero-photo::after {
  content: '';
  position: absolute;
  right: -2px; top: 0; bottom: 0;
  width: 28%;
  background: linear-gradient(to right,
    transparent 0%,
    rgba(12,30,74,0.35) 30%,
    rgba(12,30,74,0.82) 70%,
    #0c1e4a 100%);
}
.hero-photo::before {
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,0.30) 0%, transparent 22%, transparent 75%, rgba(0,0,0,0.55) 100%);
  pointer-events: none;
}

/* ── 右上：巨大数字 + 小ラベル ── */
.num-zone {
  position: absolute;
  right: 50px; top: 32px;
  text-align: center;
  z-index: 5;
}
.hero-num {
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 180px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -4px;
  line-height: 0.92;
  background: linear-gradient(180deg, #f3d172 0%, #d4a437 50%, #a37516 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  text-shadow:
    0 0 38px rgba(212,164,55,0.45),
    0 8px 24px rgba(0,0,0,0.95);
  /* シャドウは要素全体にかけるため filter で */
  filter: drop-shadow(0 4px 16px rgba(212,164,55,0.4));
}
.hero-label {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', serif;
  font-size: 28px;
  font-weight: 700;
  color: #e7d9c2;
  letter-spacing: 5px;
  margin-top: -4px;
  text-shadow: 0 2px 8px rgba(0,0,0,0.85);
}

/* ── 中央メインタイトル（横ストリップ風） ── */
.title-zone {
  position: absolute;
  left: 24px; right: 24px; bottom: 168px;
  text-align: center;
  z-index: 6;
}
.title-text {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-size: ${titleSize}px;
  font-weight: 900;
  color: #ffffff;
  line-height: 1.08;
  letter-spacing: 4px;
  text-shadow:
    0 0 14px rgba(30,58,138,0.65),
    0 0 32px rgba(212,164,55,0.25),
    -2px 2px 0 #0c1e4a,
    2px 2px 0 #0c1e4a,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1px rgba(212,164,55,0.35);
}

/* ── 下端：サブタイトル帯（白い水平線アクセント）── */
.sub-bar {
  display: ${subtitle ? 'block' : 'none'};
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 28px 56px 32px;
  background: linear-gradient(180deg, rgba(12,30,74,0) 0%, rgba(12,30,74,0.92) 50%, rgba(6,10,31,0.98) 100%);
  text-align: center;
  z-index: 7;
}
.sub-bar::before {
  /* 上端の白い水平線 */
  content: '';
  position: absolute;
  left: 50%; top: 12px;
  transform: translateX(-50%);
  width: 60%;
  height: 2px;
  background: linear-gradient(90deg, transparent 0%, #d4a437 30%, #d4a437 70%, transparent 100%);
}
.sub-text {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 36px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 3px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.85);
}

${channelLogoStyleFor('dark')}
`;

  const titleHtml = titleLines.map(l => esc(l)).join('<br>');

  const thumbBody = `
<div class="bg-base"></div>
<div class="bg-dots"></div>
<div class="hero-photo"></div>
<div class="num-zone">
  <div class="hero-num">${esc(heroNumber)}</div>
  ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
</div>
<div class="title-zone">
  <div class="title-text">${titleHtml}</div>
</div>
${subtitle ? `<div class="sub-bar"><div class="sub-text">${esc(subtitle)}</div></div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail R-Blue: Regal Analysis', tone: 'dark' });
}

module.exports = { buildRegalBlueThumb };
