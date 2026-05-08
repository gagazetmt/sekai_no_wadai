// scripts/v2_thumb/templates/regalBlue.js
// サムネ テンプレ R-Blue: REGAL ANALYSIS（青×ゴールド・知的分析系）
//   gpt-image-1 が生成した「②オリーセ覚醒の真相」のレイアウトを忠実に HTML/CSS 化
//
// 真の特徴:
//   - 背景: 全面ロイヤルブルーの中央 radial（深 #0c1e4a → #1e3a8a）+ 微細ドット
//   - 選手写真: 左 0-55% にドリブル全身、右側へ青背景に溶け込むフェード
//   - 数字「+5.2」: 右上、極大ゴールド serif italic
//   - メインタイトル: 画面の縦中央を横切る 1行 白太ゴシック（中央配置）
//   - サブタイトル: タイトル直下、薄ベージュ／ゴールドの細字（帯なし）
//
//   入力:
//     {
//       heroImage:  '選手写真パス',
//       heroNumber: '+5.2',
//       heroLabel:  'xG超過',
//       title:      'オリーセ覚醒の真相',
//       subtitle:   'バイエルンが200億で奪う理由',
//     }

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

  // R-Blue は中央配置 1行想定（折り返し起きないようサイズ調整）
  const titleLen = [...String(title).replace('\n', '')].length;
  const titleSize = titleLen <=  6 ? 110
                  : titleLen <=  9 ? 92
                  : titleLen <= 12 ? 76
                  : titleLen <= 15 ? 64
                  :                  54;

  const extraStyles = `
/* ── ベース背景：ロイヤルブルー中央 radial + ドット ── */
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 110% 90% at 55% 50%, rgba(30,58,138,0.85) 0%, rgba(15,30,80,0.65) 35%, rgba(8,16,40,0.95) 75%, #050a1a 100%),
    linear-gradient(180deg, #060b1f 0%, #03060f 100%);
}
.bg-dots {
  position: absolute; inset: 0;
  background-image:
    radial-gradient(rgba(212,164,55,0.10) 1px, transparent 1px),
    radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 22px 22px, 7px 7px;
  background-position: 0 0, 11px 11px;
  pointer-events: none;
}

/* ── 選手写真：左 0-55%、右側へ青背景にフェード ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 56%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 60%, #1e3a8a, #0a0e1a);'}
  background-size: cover;
  background-position: center 30%;
  filter: contrast(1.10) saturate(1.15);
}
.hero-photo::after {
  /* 写真右端は青背景に溶ける（フェード幅広め）*/
  content: '';
  position: absolute;
  right: -1px; top: 0; bottom: 0;
  width: 35%;
  background: linear-gradient(to right,
    transparent 0%,
    rgba(15,30,80,0.45) 45%,
    rgba(8,16,40,0.85) 85%,
    rgba(8,16,40,1) 100%);
}
.hero-photo::before {
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,0.28) 0%, transparent 18%, transparent 75%, rgba(0,0,0,0.45) 100%);
  pointer-events: none;
}

/* ── 右上：巨大数字 + 直下ラベル ── */
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
  background: linear-gradient(180deg, #f5d27a 0%, #d4a437 50%, #a37516 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter:
    drop-shadow(0 0 36px rgba(212,164,55,0.55))
    drop-shadow(0 8px 18px rgba(0,0,0,0.95));
}
.hero-label {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 32px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 4px;
  margin-top: -10px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.85);
}

/* ── メインタイトル：画面の縦中央を横切る・中央配置 1行 ── */
.title-zone {
  position: absolute;
  left: 24px; right: 24px;
  top: 56%;
  transform: translateY(-50%);
  text-align: center;
  z-index: 6;
}
.title-text {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-size: ${titleSize}px;
  font-weight: 900;
  color: #ffffff;
  line-height: 1.06;
  letter-spacing: 4px;
  text-shadow:
    0 0 14px rgba(30,58,138,0.75),
    0 0 28px rgba(212,164,55,0.30),
    -2px 2px 0 #0c1e4a,
    2px 2px 0 #0c1e4a,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.2px rgba(212,164,55,0.45);
  white-space: nowrap;
}

/* ── サブタイトル：タイトル直下、薄ゴールド細字（帯なし）── */
.sub-zone {
  display: ${subtitle ? 'block' : 'none'};
  position: absolute;
  left: 24px; right: 24px;
  top: 56%;
  transform: translateY(calc(-50% + ${titleSize * 0.7}px));
  text-align: center;
  z-index: 6;
}
.sub-text {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 38px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 4px;
  text-shadow:
    0 0 12px rgba(8,16,40,0.85),
    0 4px 16px rgba(0,0,0,0.95);
}

${channelLogoStyleFor('dark')}
`;

  const titleSingle = String(title).replace(/\n/g, '');

  const thumbBody = `
<div class="bg-base"></div>
<div class="bg-dots"></div>
<div class="hero-photo"></div>
<div class="num-zone">
  <div class="hero-num">${esc(heroNumber)}</div>
  ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
</div>
<div class="title-zone">
  <div class="title-text">${esc(titleSingle)}</div>
</div>
${subtitle ? `<div class="sub-zone"><div class="sub-text">${esc(subtitle)}</div></div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail R-Blue: Regal Analysis', tone: 'dark' });
}

module.exports = { buildRegalBlueThumb };
