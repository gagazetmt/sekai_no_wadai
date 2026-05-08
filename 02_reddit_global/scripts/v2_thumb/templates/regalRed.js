// scripts/v2_thumb/templates/regalRed.js
// サムネ テンプレ R-Red: REGAL IMPACT（赤×ゴールド・衝撃系）
//
// gpt-image-1 が生成した「ハキミ離脱の衝撃」を A 構造に頼らず忠実再現:
//   - 背景は全面暗赤のスタジアム radial グロー（左カラム/右カラム分割なし）
//   - 写真は left 4%, top 4%, height 78% の単体フォトオブジェクト
//     四方すべてに mask radial gradient で自然にフェード（背景に溶ける）
//   - 数字「161」: 画面右上 (top 4%, right 5%)、極大ゴールド serif italic
//   - 「PSG在籍試合」: 数字直下
//   - メインタイトル: 写真の右側に重ねて配置 (top 28%, right 4%) 改行縦割り
//   - 左下: 「PSG崩壊の予兆」赤い四角ボックス
//
//   入力: { heroImage, heroNumber, heroLabel, title, subtitle }

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

  const titleLines = String(title).split('\n');
  const longestLine = Math.max(...titleLines.map(l => [...l].length), 0);
  // AI画像の文字 1字 ≒ 縦18-20% (720px換算で 130-145px)
  const titleSize = longestLine <= 4 ? 165
                  : longestLine <= 6 ? 142
                  : longestLine <= 8 ? 116
                  :                    96;

  const extraStyles = `
/* ── 全面背景：暗赤スタジアム radial（左右カラム分割なし）── */
.bg-stadium {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 130% 100% at 55% 50%, rgba(127,29,29,0.85) 0%, rgba(80,15,15,0.65) 35%, rgba(20,6,8,0.95) 75%, #0a0506 100%),
    linear-gradient(180deg, #1a0608 0%, #0a0304 100%);
}
.bg-grain {
  position: absolute; inset: 0;
  background-image: radial-gradient(rgba(220,40,40,0.05) 1px, transparent 1px);
  background-size: 5px 5px;
  pointer-events: none;
  mix-blend-mode: screen;
}

/* ── 選手写真：単体フォトオブジェクト・四方ぼかし ── */
.photo-obj {
  position: absolute;
  left: 4%; top: 4%;
  width: 44%; height: 80%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 50%, #2a0d10, transparent);'}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.10) saturate(1.10);
  /* mask で四方すべてに soft フェード → 背景の暗赤に溶け込む */
  -webkit-mask-image: radial-gradient(ellipse 95% 92% at 50% 48%, #000 50%, transparent 95%);
          mask-image: radial-gradient(ellipse 95% 92% at 50% 48%, #000 50%, transparent 95%);
  -webkit-mask-size: 100% 100%;
          mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
}

/* ── 右上：巨大数字 + 直下ラベル（中央寄せ）── */
.num-zone {
  position: absolute;
  right: 5%; top: 4%;
  text-align: center;
  z-index: 5;
}
.hero-num {
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 260px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -10px;
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

/* ── メインタイトル：写真と重なる位置で右寄せ・縦割り ── */
.title-zone {
  position: absolute;
  right: 4%; top: 32%;
  max-width: 80%;
  text-align: right;
  z-index: 6;
}
.title-text {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-size: ${titleSize}px;
  font-weight: 900;
  color: #ffffff;
  line-height: 1.05;
  letter-spacing: 2px;
  text-shadow:
    0 0 14px rgba(127,29,29,0.65),
    0 0 28px rgba(127,29,29,0.40),
    -3px 3px 0 #7f1d1d,
    3px 3px 0 #7f1d1d,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.5px rgba(127,29,29,0.5);
}

/* ── 左下：「赤い四角ボックス」サブタイトル ── */
.sub-box {
  display: ${subtitle ? 'inline-block' : 'none'};
  position: absolute;
  left: 3%; bottom: 5%;
  padding: 16px 28px;
  background: linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%);
  border: 2px solid rgba(212,164,55,0.65);
  box-shadow:
    0 0 0 3px rgba(0,0,0,0.40) inset,
    0 6px 22px rgba(0,0,0,0.65),
    0 0 18px rgba(127,29,29,0.45);
  z-index: 7;
}
.sub-text {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 64px;
  font-weight: 900;
  color: #ffffff;
  letter-spacing: 2px;
  text-shadow: 0 2px 8px rgba(0,0,0,0.85);
}

${channelLogoStyleFor('dark')}
`;

  const titleHtml = titleLines.map(l => esc(l)).join('<br>');

  const thumbBody = `
<div class="bg-stadium"></div>
<div class="bg-grain"></div>
<div class="photo-obj"></div>
<div class="num-zone">
  <div class="hero-num">${esc(heroNumber)}</div>
  ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
</div>
<div class="title-zone">
  <div class="title-text">${titleHtml}</div>
</div>
${subtitle ? `<div class="sub-box"><div class="sub-text">${esc(subtitle)}</div></div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail R-Red: Regal Impact', tone: 'dark' });
}

module.exports = { buildRegalRedThumb };
