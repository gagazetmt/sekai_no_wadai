// scripts/v2_thumb/templates/regalRed.js
// サムネ テンプレ R-Red: REGAL IMPACT
// gpt-image-1 が生成した「ハキミ離脱の衝撃」画像を一から再現。
//
// 2026-05-08 修正1-5 反映:
//   ① metric-value: 280px / fw 1200 / top 3% / ゴールドグラデ
//   ② metric-tag  : 60px  / fw 900  / top 36% / 字間 8 / ゴールドグラデ
//   ③ headline    : 220px / fw 1200 / top 48% / 字間 6 / line-height 1.25 /
//                   color #f6edd7 (white + gold 20%) / 最大2行
//   ④ kicker      : 90px  / fw 1200 / 装飾なし / color red / 黒影
//   ⑤ canvas      : 左=暗赤スタジアム / 右=黒 (上 30% パール混じり、中段以降
//                   真っ黒) / 境界はグラデーションでブレンド
//
// font-family は試行錯誤用に data で差替可能（後で UI ドロップダウン化予定）
//   metricValueFontFamily : .metric-value 用 serif italic 系
//   metricTagFontFamily   : .metric-tag 用 serif 系

const {
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

const DEFAULT_VALUE_FONT = `'Bodoni 72', 'Didot', 'Times New Roman', serif`;
const DEFAULT_TAG_FONT   = `'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif`;

function buildRegalRedThumb(data = {}) {
  const heroImg     = imgDataUri(data.heroImage);
  const metricValue = data.heroNumber || '?';
  const metricTag   = data.heroLabel  || '';
  const titleStr    = String(data.title || '');
  const kicker      = data.subtitle || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const valueFontFamily = data.metricValueFontFamily || DEFAULT_VALUE_FONT;
  const tagFontFamily   = data.metricTagFontFamily   || DEFAULT_TAG_FONT;

  const styles = `
/* ════════ 背景：左=暗赤スタジアム / 右=黒(上パール) ════════ */
/* base canvas: 縦グラデで「上 30% パール混じり黒 → 中段以降 真っ黒」*/
.canvas {
  position: absolute; inset: 0;
  background: linear-gradient(180deg,
    #4b4845 0%,
    #4b4845 22%,
    #2a2724 32%,
    #0a0a09 48%,
    #000000 60%,
    #000000 100%);
}
/* left overlay: 左カラムの暗赤スタジアム。右へ自然にフェードして黒に溶ける */
.canvas-left {
  position: absolute; inset: 0;
  background: radial-gradient(ellipse 92% 100% at 22% 50%,
    rgba(127,29,29,0.92) 0%,
    rgba(95,18,22,0.78) 22%,
    rgba(60,12,15,0.55) 40%,
    rgba(20,6,8,0.25) 62%,
    transparent 80%);
}
.canvas-grain {
  position: absolute; inset: 0;
  background-image: radial-gradient(rgba(220,40,40,0.05) 1px, transparent 1px);
  background-size: 5px 5px;
  pointer-events: none;
  mix-blend-mode: screen;
}

/* ════════ 被写体（選手写真）四方ぼかし ════════ */
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

/* ════════ ① 大数字（修正1）════════ */
.metric-value {
  position: absolute;
  right: 6%; top: 3%;
  font-family: ${valueFontFamily};
  font-size: 280px;
  font-weight: 1200;
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

/* ════════ ② 数字直下ラベル（修正2）════════ */
.metric-tag {
  position: absolute;
  right: 6%; top: 36%;
  font-family: ${tagFontFamily};
  font-size: 60px;
  font-weight: 900;
  letter-spacing: 8px;
  background: linear-gradient(180deg, #f5d27a 0%, #d4a437 50%, #a37516 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 2px 10px rgba(0,0,0,0.85));
}

/* ════════ ③ ヘッドライン（修正3）最大2行折り返し ════════ */
.headline {
  position: absolute;
  right: 4%; top: 48%;
  max-width: 92%;
  text-align: right;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Noto Sans JP', sans-serif;
  font-size: 220px;
  font-weight: 1200;
  letter-spacing: 6px;
  line-height: 1.25;
  /* color: #fff にゴールド (#d4a437) を 20% 混ぜた値 */
  color: #f6edd7;
  text-shadow:
    0 0 14px rgba(127,29,29,0.70),
    0 0 28px rgba(127,29,29,0.40),
    -3px 3px 0 #7f1d1d,
     3px 3px 0 #7f1d1d,
     0 6px 22px rgba(0,0,0,0.95);
  -webkit-text-stroke: 2px rgba(127,29,29,0.55);
  /* 2行まで折り返し */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* ════════ ④ 左下キッカー（修正4）装飾なし・赤太文字 ════════ */
.kicker {
  display: ${kicker ? 'block' : 'none'};
  position: absolute;
  left: 3%; bottom: 4%;
  padding: 18px 34px;
  border: none;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 90px;
  font-weight: 1200;
  letter-spacing: 2px;
  color: red;
  text-shadow:
    0 2px 8px rgba(0,0,0,0.95),
    0 4px 22px rgba(0,0,0,0.85);
}

${channelLogoStyleFor('dark')}
`;

  // title 内の改行 \n は <br> に変換（ただし line-clamp で 2 行に制限）
  const titleHtml = esc(titleStr).replace(/\n/g, '<br>');

  const body = `
<div class="canvas"></div>
<div class="canvas-left"></div>
<div class="canvas-grain"></div>
<div class="subject"></div>
<div class="metric-value">${esc(metricValue)}</div>
${metricTag ? `<div class="metric-tag">${esc(metricTag)}</div>` : ''}
<div class="headline">${titleHtml}</div>
${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody: body, extraStyles: styles, title: 'R-Red Regal Impact', tone: 'dark' });
}

// font-family 候補リスト（後で UI ドロップダウンで使う）
const FONT_FAMILY_OPTIONS = [
  { label: 'Bodoni 72 (default)',     value: `'Bodoni 72', 'Didot', 'Times New Roman', serif` },
  { label: 'Didot',                   value: `'Didot', 'Bodoni 72', 'Times New Roman', serif` },
  { label: 'Playfair Display',        value: `'Playfair Display', 'Georgia', serif` },
  { label: 'DM Serif Display',        value: `'DM Serif Display', 'Times New Roman', serif` },
  { label: 'Cinzel',                  value: `'Cinzel', 'Trajan Pro', 'Times New Roman', serif` },
  { label: 'Cormorant Garamond',      value: `'Cormorant Garamond', 'Garamond', serif` },
  { label: 'EB Garamond',             value: `'EB Garamond', 'Georgia', serif` },
  { label: 'Old Standard TT',         value: `'Old Standard TT', 'Times New Roman', serif` },
  { label: 'Big Caslon',              value: `'Big Caslon', 'Times New Roman', serif` },
  { label: 'Hiragino Mincho ProN',    value: `'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif` },
  { label: 'Yu Mincho',               value: `'Yu Mincho', 'Hiragino Mincho ProN', 'Noto Serif JP', serif` },
  { label: 'Noto Serif JP',           value: `'Noto Serif JP', 'Hiragino Mincho ProN', serif` },
];

module.exports = { buildRegalRedThumb, FONT_FAMILY_OPTIONS };
