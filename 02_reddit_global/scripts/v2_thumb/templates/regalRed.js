// scripts/v2_thumb/templates/regalRed.js
// サムネ テンプレ R-Red: REGAL IMPACT（赤×ネイビー×ゴールド・衝撃系）
//   gpt-image-1 が生成した「①ハキミ離脱の衝撃」のレイアウトを HTML/CSS 化
//
//   レイアウト:
//     - 左 56% に選手写真（バストアップ、右にフェード）
//     - 右上に巨大数字（serif italic ゴールド 200px）+ 直下に小ラベル
//     - 中央〜下中央に大きなメインタイトル（白太ゴシック、複数行 OK）
//     - 下端にサブタイトル帯（深紅×ネイビー gradient、ベージュ細字）
//   トーン:
//     深紅(#7f1d1d) × ネイビー(#0f172a) × ゴールド(#d4a437) × オフホワイト
//
//   入力:
//     {
//       heroImage:   '選手写真パス',
//       heroNumber:  '161',
//       heroLabel:   'PSG在籍試合',
//       title:       'ハキミ離脱の衝撃',  // 改行 \n で複数行可
//       subtitle:    'PSG崩壊の予兆',
//     }

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildRegalRedThumb(data = {}) {
  const heroImg    = imgDataUri(data.heroImage);
  const heroNumber = data.heroNumber || '?';
  const heroLabel  = data.heroLabel  || '';
  const title      = data.title      || '';
  const subtitle   = data.subtitle   || '';
  const channelName = data.channelName || CHANNEL_NAME;

  // タイトル文字数で自動スケール（複数行想定）
  const titleLines = String(title).split('\n');
  const longestLine = Math.max(...titleLines.map(l => [...l].length), 0);
  const titleSize = longestLine <= 5 ? 124
                  : longestLine <= 7 ? 110
                  : longestLine <= 9 ? 96
                  :                    82;

  const extraStyles = `
/* ── ベース背景：深紅×ネイビーのドラマチックグラデーション ── */
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 120% 90% at 78% 40%, rgba(127,29,29,0.65) 0%, transparent 60%),
    radial-gradient(ellipse 80% 100% at 20% 50%, rgba(15,23,42,0.85) 0%, transparent 70%),
    linear-gradient(135deg, #1a0809 0%, #2a0d10 30%, #0f172a 75%, #060a14 100%);
}
/* 微細な暗いノイズ感（高級感） */
.bg-noise {
  position: absolute; inset: 0;
  background-image:
    radial-gradient(rgba(127,29,29,0.06) 1px, transparent 1px);
  background-size: 4px 4px;
  pointer-events: none;
}

/* ── 左側：選手写真（フルブリード+右フェード）── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 60%;
  ${heroImg ? `background-image: url('${heroImg}');` : `background: radial-gradient(circle at 50% 60%, #2a0d10, #0a0a14);`}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.12) saturate(1.15);
}
.hero-photo::after {
  /* 写真右端から背景色へ滑らかなフェード */
  content: '';
  position: absolute;
  right: -2px; top: 0; bottom: 0;
  width: 26%;
  background: linear-gradient(to right,
    transparent 0%,
    rgba(15,23,42,0.45) 35%,
    rgba(15,23,42,0.85) 70%,
    #0f172a 100%);
}
.hero-photo::before {
  /* 写真上下にも subtle な暗フェード（被写体へ視線誘導）*/
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,0.35) 0%, transparent 20%, transparent 70%, rgba(0,0,0,0.55) 100%);
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
  color: #d4a437;
  letter-spacing: -6px;
  line-height: 0.92;
  text-shadow:
    0 0 40px rgba(212,164,55,0.45),
    0 0 80px rgba(127,29,29,0.35),
    0 8px 22px rgba(0,0,0,0.95);
  background: linear-gradient(180deg, #f3d172 0%, #d4a437 50%, #a37516 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero-label {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', serif;
  font-size: 26px;
  font-weight: 700;
  color: #e7d9c2;
  letter-spacing: 4px;
  margin-top: -8px;
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
    0 0 14px rgba(127,29,29,0.55),
    0 0 28px rgba(127,29,29,0.35),
    -2px 2px 0 #7f1d1d,
    2px 2px 0 #7f1d1d,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.5px rgba(127,29,29,0.5);
}

/* ── 下端：サブタイトル帯 ── */
.sub-bar {
  display: ${subtitle ? 'flex' : 'none'};
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 22px 56px;
  align-items: center;
  background: linear-gradient(90deg,
    rgba(127,29,29,0.92) 0%,
    rgba(15,23,42,0.96) 60%,
    rgba(15,23,42,0.98) 100%);
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

  // タイトル本文（改行 \n を <br> に）
  const titleHtml = titleLines.map(l => esc(l)).join('<br>');

  const thumbBody = `
<div class="bg-base"></div>
<div class="bg-noise"></div>
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

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail R-Red: Regal Impact', tone: 'dark' });
}

module.exports = { buildRegalRedThumb };
