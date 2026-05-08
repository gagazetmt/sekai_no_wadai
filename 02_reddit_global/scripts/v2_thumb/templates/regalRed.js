// scripts/v2_thumb/templates/regalRed.js
// サムネ テンプレ R-Red: REGAL IMPACT
// gpt-image-1 が生成した「ハキミ離脱の衝撃」画像を一から再現。
// A タイプの構造・命名は一切踏襲せず、画像の座標を直接設計。

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildRegalRedThumb(data = {}) {
  const heroImg     = imgDataUri(data.heroImage);
  const metricValue = data.heroNumber || '?';
  const metricTag   = data.heroLabel  || '';
  const headlineLines = String(data.title || '').split('\n').filter(Boolean);
  const kicker      = data.subtitle || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const styles = `
/* === 全面キャンバス：暗赤スタジアム === */
.canvas {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 130% 100% at 55% 45%, rgba(127,29,29,0.88) 0%, rgba(80,15,15,0.62) 35%, rgba(20,6,8,0.95) 75%, #0a0506 100%);
}
.canvas-grain {
  position: absolute; inset: 0;
  background-image: radial-gradient(rgba(220,40,40,0.05) 1px, transparent 1px);
  background-size: 5px 5px;
  pointer-events: none;
  mix-blend-mode: screen;
}

/* === 被写体（選手写真）：四方ぼかし === */
.subject {
  position: absolute;
  left: 4%; top: 5%;
  width: 44%; height: 80%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 50%, #2a0d10, transparent);'}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.10) saturate(1.10);
  -webkit-mask-image: radial-gradient(ellipse 95% 92% at 50% 48%, #000 50%, transparent 95%);
          mask-image: radial-gradient(ellipse 95% 92% at 50% 48%, #000 50%, transparent 95%);
  -webkit-mask-size: 100% 100%;
          mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
          mask-repeat: no-repeat;
}

/* === 大数字（161）右上、極大 serif italic ゴールド === */
.metric-value {
  position: absolute;
  right: 6%; top: 1%;
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 290px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -12px;
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

/* === ヘッドライン：3行階段配置 === */
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
  font-size: 144px;
  text-shadow:
    0 0 14px rgba(127,29,29,0.70),
    0 0 28px rgba(127,29,29,0.40),
    -3px 3px 0 #7f1d1d,
     3px 3px 0 #7f1d1d,
     0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 2px rgba(127,29,29,0.55);
}

/* === 左下キッカー：赤い四角ボックス === */
.kicker {
  display: ${kicker ? 'inline-block' : 'none'};
  position: absolute;
  left: 3%; bottom: 4%;
  padding: 18px 34px;
  background: linear-gradient(135deg, #b91c1c 0%, #7f1d1d 100%);
  border: 2px solid rgba(212,164,55,0.65);
  box-shadow:
    0 0 0 3px rgba(0,0,0,0.40) inset,
    0 8px 28px rgba(0,0,0,0.65),
    0 0 22px rgba(127,29,29,0.45);
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 68px;
  font-weight: 900;
  color: #ffffff;
  letter-spacing: 2px;
  text-shadow: 0 2px 8px rgba(0,0,0,0.85);
}

${channelLogoStyleFor('dark')}
`;

  const headlineHtml = headlineLines.map(line => `<span class="line">${esc(line)}</span>`).join('');

  const body = `
<div class="canvas"></div>
<div class="canvas-grain"></div>
<div class="subject"></div>
<div class="metric-value">${esc(metricValue)}</div>
${metricTag ? `<div class="metric-tag">${esc(metricTag)}</div>` : ''}
<div class="headline">${headlineHtml}</div>
${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody: body, extraStyles: styles, title: 'R-Red Regal Impact', tone: 'dark' });
}

module.exports = { buildRegalRedThumb };
