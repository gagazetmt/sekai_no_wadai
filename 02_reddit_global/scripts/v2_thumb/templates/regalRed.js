// scripts/v2_thumb/templates/regalRed.js
// サムネ テンプレ R-Red: REGAL IMPACT（赤×ゴールド・衝撃系）
//   gpt-image-1 が生成した「①ハキミ離脱の衝撃」のレイアウトを忠実に HTML/CSS 化
//
// 真の特徴:
//   - 背景: 全面暗赤のスタジアム radial グロー（深紅 #7f1d1d 系）
//   - 選手写真: 左 30-50% に胸像、右側へは緩やかにフェード（赤背景に溶ける）
//   - 数字「161」: 右上、極大ゴールド serif italic
//   - メインタイトル: 写真の右〜画面中央右に重なる白太ゴシック + 赤縁
//                  改行可（"ハキミ" / "離敗の衝撃" のような縦割り）
//   - サブタイトル: 左下に「赤い四角ボックス」（横長帯ではない）
//
//   入力:
//     {
//       heroImage:  '選手写真パス',
//       heroNumber: '161',
//       heroLabel:  'PSG在籍試合',
//       title:      'ハキミ\n離脱の衝撃',
//       subtitle:   'PSG崩壊の予兆',
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

  const titleLines = String(title).split('\n');
  const longestLine = Math.max(...titleLines.map(l => [...l].length), 0);
  const titleSize = longestLine <= 4 ? 130
                  : longestLine <= 6 ? 112
                  : longestLine <= 8 ? 92
                  :                    78;

  const extraStyles = `
/* ── ベース背景：全面に暗赤のスタジアムグロー ── */
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 130% 100% at 60% 50%, rgba(127,29,29,0.85) 0%, rgba(80,15,15,0.65) 35%, rgba(20,6,8,0.95) 75%, #0a0506 100%),
    linear-gradient(180deg, #1a0608 0%, #0a0304 100%);
}
.bg-haze {
  /* 微細な赤いノイズグレイン感（高級グラデの息継ぎ）*/
  position: absolute; inset: 0;
  background-image:
    radial-gradient(rgba(220,40,40,0.05) 1px, transparent 1px);
  background-size: 5px 5px;
  pointer-events: none;
  mix-blend-mode: screen;
}

/* ── 選手写真：左 35-50%、右側へ自然にフェード ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 52%;
  ${heroImg ? `background-image: url('${heroImg}');` : `background: radial-gradient(circle at 50% 60%, #2a0d10, #0a0306);`}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.10) saturate(1.10) brightness(1.02);
}
.hero-photo::after {
  /* 写真右端は赤い背景に溶け込む（フェード幅は控えめ）*/
  content: '';
  position: absolute;
  right: -1px; top: 0; bottom: 0;
  width: 30%;
  background: linear-gradient(to right,
    transparent 0%,
    rgba(80,15,15,0.45) 50%,
    rgba(40,8,10,0.85) 90%,
    rgba(20,6,8,1) 100%);
}
.hero-photo::before {
  /* 上下にも subtle な暗フェード（被写体を引き立てる）*/
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,0.30) 0%, transparent 18%, transparent 75%, rgba(0,0,0,0.50) 100%);
  pointer-events: none;
}

/* ── 右上：巨大数字 + 直下ラベル ── */
.num-zone {
  position: absolute;
  right: 56px; top: 26px;
  text-align: center;
  z-index: 5;
}
.hero-num {
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 220px;
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
  font-size: 32px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 4px;
  margin-top: -10px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.85);
}

/* ── メインタイトル：写真の右〜画面中央寄り、複数行 ── */
.title-zone {
  position: absolute;
  right: 36px; top: 40%;
  transform: translateY(-25%);
  max-width: 78%;
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

/* ── サブタイトル：左下の「赤い四角ボックス」 ── */
.sub-box {
  display: ${subtitle ? 'inline-block' : 'none'};
  position: absolute;
  left: 28px; bottom: 32px;
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
  font-size: 44px;
  font-weight: 900;
  color: #ffffff;
  letter-spacing: 2px;
  text-shadow: 0 2px 8px rgba(0,0,0,0.85);
}

${channelLogoStyleFor('dark')}
`;

  const titleHtml = titleLines.map(l => esc(l)).join('<br>');

  const thumbBody = `
<div class="bg-base"></div>
<div class="bg-haze"></div>
<div class="hero-photo"></div>
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
