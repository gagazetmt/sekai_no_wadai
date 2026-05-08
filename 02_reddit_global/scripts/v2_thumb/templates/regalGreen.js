// scripts/v2_thumb/templates/regalGreen.js
// サムネ テンプレ R-Green: REGAL REVIVAL（チャコール×ゴールド・朗報/復活系）
//
// gpt-image-1 が生成した「カゼミーロ完全復活」を A 構造に頼らず忠実再現:
//   - 背景は全面暗チャコール（左右カラム分割なし）+ 上方からのみ subtle な
//     ゴールド光線（夜のスタジアム照明感）。緑グローはわずかで、ほぼ暗い
//   - 写真は left 4%, top 5%, height 84% の単体フォトオブジェクト
//     （カゼミーロの歓喜の半身像）四方ぼかしでチャコールに溶ける
//   - 数字「8.4」: 画面右上、極大ゴールド serif italic
//   - メインタイトル: 写真の右側に重なる位置で右寄せ・改行縦割り
//   - サブタイトル: 下端中央の単純な細字（帯なし、cinematic）
//
//   入力: { heroImage, heroNumber, heroLabel, title, subtitle }

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
  const titleSize = longestLine <= 4 ? 165
                  : longestLine <= 6 ? 142
                  : longestLine <= 8 ? 116
                  :                    96;

  const extraStyles = `
/* ── 全面背景：暗チャコール（夜のスタジアム）── */
.bg-stadium {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 50% at 65% 8%, rgba(6,78,59,0.40) 0%, transparent 60%),
    radial-gradient(ellipse 100% 80% at 50% 50%, rgba(20,30,28,0.65) 0%, transparent 75%),
    linear-gradient(180deg, #0a1612 0%, #060c0a 60%, #020604 100%);
}
.bg-aura {
  /* 上方からだけ subtle なゴールド光線（スタジアム照明感）*/
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 50% 35% at 75% 5%, rgba(212,164,55,0.12) 0%, transparent 70%);
  pointer-events: none;
}

/* ── 選手写真：単体フォトオブジェクト・四方ぼかし ── */
.photo-obj {
  position: absolute;
  left: 4%; top: 5%;
  width: 44%; height: 86%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 50%, #064e3b, transparent);'}
  background-size: cover;
  background-position: center 25%;
  filter: contrast(1.12) saturate(1.10);
  -webkit-mask-image: radial-gradient(ellipse 95% 92% at 50% 48%, #000 50%, transparent 95%);
          mask-image: radial-gradient(ellipse 95% 92% at 50% 48%, #000 50%, transparent 95%);
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

/* ── メインタイトル：写真の右側に重ねて配置・改行縦割り ── */
.title-zone {
  position: absolute;
  right: 4%; top: 36%;
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
    0 0 14px rgba(6,78,59,0.65),
    0 0 28px rgba(16,185,129,0.30),
    -3px 3px 0 #064e3b,
    3px 3px 0 #064e3b,
    0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.5px rgba(6,78,59,0.5);
}

/* ── サブタイトル：下端中央の単純な細字（帯なし）── */
.sub-zone {
  display: ${subtitle ? 'block' : 'none'};
  position: absolute;
  left: 0; right: 0; bottom: 5%;
  text-align: center;
  z-index: 7;
}
.sub-text {
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 56px;
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
<div class="bg-stadium"></div>
<div class="bg-aura"></div>
<div class="photo-obj"></div>
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
