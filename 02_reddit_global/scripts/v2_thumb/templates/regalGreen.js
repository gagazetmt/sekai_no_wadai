// scripts/v2_thumb/templates/regalGreen.js
// サムネ テンプレ R-Green: REGAL REVIVAL
// gpt-image-1 が生成した「カゼミーロ完全復活」画像を一から再現。
// A タイプの構造・命名は一切踏襲せず、画像の座標を直接設計。

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildRegalGreenThumb(data = {}) {
  const heroImg     = imgDataUri(data.heroImage);
  const metricValue = data.heroNumber || '?';
  const metricTag   = data.heroLabel  || '';
  const headlineLines = String(data.title || '').split('\n').filter(Boolean);
  const kicker      = data.subtitle || '';
  const channelName = data.channelName || CHANNEL_NAME;

  // ヘッドラインは縦並び（行ごとに同サイズ）
  const longestLine = Math.max(...headlineLines.map(l => [...l].length), 0);
  const lineSize = longestLine <= 4 ? 168
                 : longestLine <= 6 ? 144
                 : longestLine <= 8 ? 116
                 :                     96;

  const styles = `
/* === 全面キャンバス：暗チャコール === */
.canvas {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 80% 50% at 65% 8%, rgba(6,78,59,0.40) 0%, transparent 60%),
    radial-gradient(ellipse 100% 80% at 50% 50%, rgba(20,30,28,0.65) 0%, transparent 75%),
    linear-gradient(180deg, #0a1612 0%, #060c0a 60%, #020604 100%);
}
.canvas-aura {
  /* 上方からだけ subtle なゴールド光線（夜のスタジアム）*/
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 50% 35% at 75% 5%, rgba(212,164,55,0.12) 0%, transparent 70%);
  pointer-events: none;
}

/* === 被写体（歓喜の半身）：四方ぼかし === */
.subject {
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

/* === 大数字（8.4）右上 === */
.metric-value {
  position: absolute;
  right: 6%; top: 1%;
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 290px;
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

/* === 数字直下のラベル === */
.metric-tag {
  position: absolute;
  right: 6%; top: 41%;
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 44px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 5px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.85);
}

/* === ヘッドライン：右寄せ縦並び === */
.headline {
  position: absolute;
  right: 4%; top: 49%;
  text-align: right;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-weight: 900;
  color: #ffffff;
  letter-spacing: 2px;
  line-height: 1.0;
}
.headline .line {
  display: block;
  font-size: ${lineSize}px;
  text-shadow:
    0 0 14px rgba(6,78,59,0.65),
    0 0 28px rgba(16,185,129,0.30),
    -3px 3px 0 #064e3b,
     3px 3px 0 #064e3b,
     0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.8px rgba(6,78,59,0.55);
}

/* === 下端中央キッカー（細字明朝） === */
.kicker-line {
  display: ${kicker ? 'block' : 'none'};
  position: absolute;
  left: 0; right: 0; bottom: 5%;
  text-align: center;
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 56px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 6px;
  text-shadow:
    0 0 14px rgba(0,0,0,0.95),
    0 0 28px rgba(6,78,59,0.55),
    0 4px 18px rgba(0,0,0,0.95);
}

${channelLogoStyleFor('dark')}
`;

  const headlineHtml = headlineLines.map(l => `<span class="line">${esc(l)}</span>`).join('');

  const body = `
<div class="canvas"></div>
<div class="canvas-aura"></div>
<div class="subject"></div>
<div class="metric-value">${esc(metricValue)}</div>
${metricTag ? `<div class="metric-tag">${esc(metricTag)}</div>` : ''}
<div class="headline">${headlineHtml}</div>
${kicker ? `<div class="kicker-line">${esc(kicker)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody: body, extraStyles: styles, title: 'R-Green Regal Revival', tone: 'dark' });
}

module.exports = { buildRegalGreenThumb };
