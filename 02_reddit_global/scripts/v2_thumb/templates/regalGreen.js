// scripts/v2_thumb/templates/regalGreen.js
// サムネ テンプレ R-Green: REGAL REVIVAL（チャコール×ゴールド・朗報/復活系）
//   gpt-image-1 が生成した「③カゼミーロ完全復活」のレイアウトを忠実に HTML/CSS 化
//
// 真の特徴:
//   - 背景: 暗チャコール+黒（緑というより「夜のスタジアム」の暗さが主）
//           上方からだけ subtle に緑/ゴールドのスタジアム光線
//   - 選手写真: 左 30-45% に歓喜の表情（半身）、右側へチャコールに溶け込む
//   - 数字「8.4」: 右上、極大ゴールド serif italic
//   - メインタイトル: 中央右〜右下、白太ゴシック、改行で縦並び
//   - サブタイトル: 下端の単純な細字（帯なし、cinematic）
//
//   入力:
//     {
//       heroImage:  '選手写真パス',
//       heroNumber: '8.4',
//       heroLabel:  '直近試合 評定',
//       title:      'カゼミーロ\n完全復活',
//       subtitle:   'マンU救世主の証明',
//     }

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
  const titleSize = longestLine <= 4 ? 130
                  : longestLine <= 6 ? 112
                  : longestLine <= 8 ? 92
                  :                    78;

  const extraStyles = `
/* ── ベース背景：暗チャコール+黒、上方から subtle な緑光線 ── */
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 50% at 65% 10%, rgba(6,78,59,0.45) 0%, transparent 60%),
    radial-gradient(ellipse 100% 80% at 50% 50%, rgba(20,30,28,0.65) 0%, transparent 75%),
    linear-gradient(180deg, #0a1612 0%, #060c0a 60%, #020604 100%);
}
.bg-aura {
  /* 上方からのゴールド光線 subtle（スタジアム照明感）*/
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 50% 35% at 75% 5%, rgba(212,164,55,0.12) 0%, transparent 70%);
  pointer-events: none;
}

/* ── 選手写真：左 0-50%、右側へチャコールに溶ける ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 52%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 60%, #064e3b, #0a1612);'}
  background-size: cover;
  background-position: center 25%;
  filter: contrast(1.12) saturate(1.10);
}
.hero-photo::after {
  content: '';
  position: absolute;
  right: -1px; top: 0; bottom: 0;
  width: 32%;
  background: linear-gradient(to right,
    transparent 0%,
    rgba(20,30,28,0.45) 45%,
    rgba(10,18,16,0.85) 85%,
    rgba(6,12,10,1) 100%);
}
.hero-photo::before {
  content: '';
  position: absolute; inset: 0;
  background:
    linear-gradient(to bottom, rgba(0,0,0,0.32) 0%, transparent 18%, transparent 78%, rgba(0,0,0,0.55) 100%);
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

/* ── メインタイトル：中央右〜右下に縦並び ── */
.title-zone {
  position: absolute;
  right: 36px; top: 42%;
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
    0 0 14px rgba(6,78,59,0.65),
    0 0 28px rgba(16,185,129,0.30),
    -3px 3px 0 #064e3b,
    3px 3px 0 #064e3b,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.5px rgba(6,78,59,0.5);
}

/* ── サブタイトル：下端の単純な細字（帯なし、cinematic）── */
.sub-zone {
  display: ${subtitle ? 'block' : 'none'};
  position: absolute;
  left: 0; right: 0; bottom: 36px;
  text-align: center;
  z-index: 7;
}
.sub-text {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 38px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 5px;
  text-shadow:
    0 0 14px rgba(0,0,0,0.95),
    0 0 28px rgba(6,78,59,0.55),
    0 4px 18px rgba(0,0,0,0.95);
}

${channelLogoStyleFor('dark')}
`;

  const titleHtml = titleLines.map(l => esc(l)).join('<br>');

  const thumbBody = `
<div class="bg-base"></div>
<div class="bg-aura"></div>
<div class="hero-photo"></div>
<div class="num-zone">
  <div class="hero-num">${esc(heroNumber)}</div>
  ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
</div>
<div class="title-zone">
  <div class="title-text">${titleHtml}</div>
</div>
${subtitle ? `<div class="sub-zone"><div class="sub-text">${esc(subtitle)}</div></div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail R-Green: Regal Revival', tone: 'dark' });
}

module.exports = { buildRegalGreenThumb };
