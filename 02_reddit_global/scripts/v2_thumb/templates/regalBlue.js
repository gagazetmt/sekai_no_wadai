// scripts/v2_thumb/templates/regalBlue.js
// サムネ テンプレ R-Blue: REGAL ANALYSIS
// gpt-image-1 が生成した「オリーセ覚醒の真相」画像を一から再現。
// A タイプの構造・命名は一切踏襲せず、画像の座標を直接設計。

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildRegalBlueThumb(data = {}) {
  const heroImg     = imgDataUri(data.heroImage);
  const metricValue = data.heroNumber || '?';
  const metricTag   = data.heroLabel  || '';
  const headline    = String(data.title || '').replace(/\n/g, '');
  const kicker      = data.subtitle || '';
  const channelName = data.channelName || CHANNEL_NAME;

  // ヘッドラインは 1 行で画面を横切るので文字数で動的スケール
  const hLen = [...headline].length;
  const headlineSize = hLen <=  6 ? 150
                     : hLen <=  9 ? 128
                     : hLen <= 12 ? 108
                     : hLen <= 15 ?  92
                     :               78;

  const styles = `
/* === 全面キャンバス：ロイヤルブルー radial === */
.canvas {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 110% 90% at 55% 50%, rgba(30,58,138,0.88) 0%, rgba(15,30,80,0.62) 35%, rgba(8,16,40,0.95) 75%, #050a1a 100%);
}
.canvas-dots {
  position: absolute; inset: 0;
  background-image:
    radial-gradient(rgba(212,164,55,0.10) 1px, transparent 1px),
    radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 22px 22px, 7px 7px;
  background-position: 0 0, 11px 11px;
  pointer-events: none;
}

/* === 被写体（ドリブル全身）：下端まで伸びる === */
.subject {
  position: absolute;
  left: 3%; bottom: 0;
  width: 52%; height: 98%;
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

/* === 大数字（+5.2）右上 === */
.metric-value {
  position: absolute;
  right: 5%; top: 1%;
  font-family: 'Bodoni 72', 'Didot', 'Times New Roman', serif;
  font-size: 280px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -8px;
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
  right: 5%; top: 39%;
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 44px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 6px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.85);
}

/* === ヘッドライン横切り：画面の縦中央を 1行で貫く === */
.headline-strip {
  position: absolute;
  left: 2%; right: 2%;
  top: 56%;
  transform: translateY(-50%);
  text-align: center;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-size: ${headlineSize}px;
  font-weight: 900;
  color: #ffffff;
  letter-spacing: 4px;
  line-height: 1.05;
  text-shadow:
    0 0 14px rgba(30,58,138,0.80),
    0 0 28px rgba(212,164,55,0.30),
    -3px 3px 0 #0c1e4a,
     3px 3px 0 #0c1e4a,
     0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 1.5px rgba(212,164,55,0.45);
  white-space: nowrap;
}

/* === ヘッドライン直下のキッカー（細字明朝） === */
.kicker-line {
  display: ${kicker ? 'block' : 'none'};
  position: absolute;
  left: 2%; right: 2%;
  top: calc(56% + ${headlineSize * 0.65}px);
  text-align: center;
  font-family: 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
  font-size: 60px;
  font-weight: 700;
  color: #f3e8c7;
  letter-spacing: 4px;
  text-shadow:
    0 0 12px rgba(8,16,40,0.85),
    0 4px 16px rgba(0,0,0,0.95);
}

${channelLogoStyleFor('dark')}
`;

  const body = `
<div class="canvas"></div>
<div class="canvas-dots"></div>
<div class="subject"></div>
<div class="metric-value">${esc(metricValue)}</div>
${metricTag ? `<div class="metric-tag">${esc(metricTag)}</div>` : ''}
<div class="headline-strip">${esc(headline)}</div>
${kicker ? `<div class="kicker-line">${esc(kicker)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody: body, extraStyles: styles, title: 'R-Blue Regal Analysis', tone: 'dark' });
}

module.exports = { buildRegalBlueThumb };
