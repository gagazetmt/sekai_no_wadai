// scripts/v2_thumb/templates/regalGreen.js
// サムネ テンプレ R-Green: REGAL REVIVAL（緑×ゴールド・復活/朗報系）
//   gpt-image-1 が生成した「③カゼミーロ完全復活」のレイアウトを HTML/CSS 化
//
//   レイアウト:
//     - 左 56% に選手の歓喜写真（ガッツポーズ等の感情的アクション）
//     - 右上に巨大数字（serif italic ゴールド）+ 直下にラベル
//     - 中央〜下中央に大きなメインタイトル（白太ゴシック、複数行）
//     - 下端にサブタイトル帯（深緑×チャコール gradient、ベージュ細字）
//   トーン:
//     エメラルドグリーン(#064e3b) × チャコール(#0a1612) × ゴールド(#d4a437) × オフホワイト
//   特徴:
//     スタジアム夜の暗緑ボケ → 「劇的な復活」感

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildRegalGreenThumb(data = {}) {
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
/* ── ベース背景：エメラルド × チャコールのスタジアム夜 ── */
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 110% 80% at 70% 50%, rgba(6,78,59,0.55) 0%, transparent 65%),
    radial-gradient(ellipse 70% 90% at 25% 60%, rgba(10,22,18,0.85) 0%, transparent 75%),
    linear-gradient(135deg, #0a1612 0%, #061c14 35%, #04140e 75%, #020a08 100%);
}
.bg-rays {
  /* 上から下への subtle なスタジアム照明感 */
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 60% 40% at 70% 0%, rgba(212,164,55,0.10) 0%, transparent 60%);
  pointer-events: none;
}

/* ── 左側：選手写真 ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 60%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 60%, #064e3b, #0a1612);'}
  background-size: cover;
  background-position: center 25%;
  filter: contrast(1.15) saturate(1.12);
}
.hero-photo::after {
  content: '';
  position: absolute;
  right: -2px; top: 0; bottom: 0;
  width: 28%;
  background: linear-gradient(to right,
    transparent 0%,
    rgba(10,22,18,0.40) 30%,
    rgba(10,22,18,0.85) 70%,
    #0a1612 100%);
}
.hero-photo::before {
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,0.32) 0%, transparent 20%, transparent 70%, rgba(0,0,0,0.55) 100%);
  pointer-events: none;
}

/* ── 右上：巨大数字 + 小ラベル ── */
.num-zone {
  position: absolute;
  right: 56px; top: 28px;
  text-align: center;
  z-index: 5;
}
.hero-num {
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 200px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -6px;
  line-height: 0.92;
  background: linear-gradient(180deg, #f3d172 0%, #d4a437 50%, #a37516 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter:
    drop-shadow(0 0 38px rgba(212,164,55,0.45))
    drop-shadow(0 8px 22px rgba(0,0,0,0.95));
}
.hero-label {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', serif;
  font-size: 26px;
  font-weight: 700;
  color: #e7d9c2;
  letter-spacing: 4px;
  margin-top: -4px;
  text-shadow: 0 2px 8px rgba(0,0,0,0.85);
}

/* ── メインタイトル（中央〜下中央）── */
.title-zone {
  position: absolute;
  right: 36px; bottom: 130px;
  max-width: 78%;
  text-align: right;
  z-index: 6;
}
.title-text {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-size: ${titleSize}px;
  font-weight: 900;
  color: #ffffff;
  line-height: 1.08;
  letter-spacing: 2px;
  text-shadow:
    0 0 14px rgba(6,78,59,0.65),
    0 0 32px rgba(16,185,129,0.30),
    -2px 2px 0 #064e3b,
    2px 2px 0 #064e3b,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.5px rgba(6,78,59,0.5);
}

/* ── 下端：サブタイトル帯 ── */
.sub-bar {
  display: ${subtitle ? 'flex' : 'none'};
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 22px 56px;
  align-items: center;
  background: linear-gradient(90deg,
    rgba(6,78,59,0.92) 0%,
    rgba(10,22,18,0.96) 60%,
    rgba(2,10,8,0.98) 100%);
  border-top: 2px solid rgba(212,164,55,0.55);
  z-index: 7;
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
<div class="bg-rays"></div>
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

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail R-Green: Regal Revival', tone: 'dark' });
}

module.exports = { buildRegalGreenThumb };
