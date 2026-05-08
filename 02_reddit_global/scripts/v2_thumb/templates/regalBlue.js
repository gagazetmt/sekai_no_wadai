// scripts/v2_thumb/templates/regalBlue.js
// サムネ テンプレ R-Blue: REGAL ANALYSIS（青×ゴールド・知的分析系）
//
// gpt-image-1 が生成した「オリーセ覚醒の真相」を A 構造に頼らず忠実再現:
//   - 背景は全面ロイヤルブルー radial（左右カラム分割なし）+ 微細ドット
//   - 写真は left 5%, bottom 0%, height 92% の単体フォトオブジェクト
//     （オリーセはドリブル全身で下端まで伸びる）
//     四方ぼかしで青背景に溶ける
//   - 数字「+5.2」: 画面右上、極大ゴールド serif italic
//   - メインタイトル: 画面の縦中央 (top 56%) を横切る 1行 中央配置
//   - サブタイトル: タイトル直下、薄ベージュ細字
//
//   入力: { heroImage, heroNumber, heroLabel, title, subtitle }

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

  const titleLen = [...String(title).replace('\n', '')].length;
  // AI画像で1文字 ≒ 縦14-16% (720px換算で 100-115px)
  const titleLen_safe = Math.max(titleLen, 1);
  const titleSize = titleLen_safe <=  6 ? 140
                  : titleLen_safe <=  9 ? 120
                  : titleLen_safe <= 12 ? 100
                  : titleLen_safe <= 15 ? 84
                  :                       72;

  const extraStyles = `
/* ── 全面背景：ロイヤルブルー radial + ドット（左右カラム分割なし）── */
.bg-stadium {
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

/* ── 選手写真：単体フォトオブジェクト・四方ぼかし ── */
/*   オリーセはドリブル全身で下端まで伸びる構図 */
.photo-obj {
  position: absolute;
  left: 4%; bottom: 0;
  width: 52%; height: 96%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 60%, #1e3a8a, transparent);'}
  background-size: cover;
  background-position: center 30%;
  filter: contrast(1.10) saturate(1.15);
  -webkit-mask-image: radial-gradient(ellipse 95% 95% at 50% 55%, #000 55%, transparent 96%);
          mask-image: radial-gradient(ellipse 95% 95% at 50% 55%, #000 55%, transparent 96%);
  -webkit-mask-size: 100% 100%;
          mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
}

/* ── 右上：巨大数字 + 直下ラベル ── */
.num-zone {
  position: absolute;
  right: 5%; top: 4%;
  text-align: center;
  z-index: 5;
}
.hero-num {
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 250px;
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
  font-size: 40px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 4px;
  margin-top: -10px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.85);
}

/* ── メインタイトル：画面縦中央 56% を横切る 1行 中央配置 ── */
.title-zone {
  position: absolute;
  left: 0; right: 0;
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

/* ── サブタイトル：タイトル直下、細字 ── */
.sub-zone {
  display: ${subtitle ? 'block' : 'none'};
  position: absolute;
  left: 0; right: 0;
  top: 56%;
  transform: translateY(calc(-50% + ${titleSize * 0.7}px));
  text-align: center;
  z-index: 6;
}
.sub-text {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 56px;
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
<div class="bg-stadium"></div>
<div class="bg-dots"></div>
<div class="photo-obj"></div>
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
