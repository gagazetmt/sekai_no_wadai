// scripts/v2_thumb/templates/viralData.js
// サムネ テンプレ L: 5ch反応集スタイル × データ中身（洗練版）
//   - 大きな選手写真（フルブリード）+ 下部にダーク vignette
//   - 中央右にプレミアム統計バッジ1個（白×ゴールド枠）
//   - 下部 黄色帯（黒太縁）+ 黒大字タイトル + 赤強調 (多層 stack 影)
//   - 上部の極細チャンネルストライプで「分析チャンネル」感

const {
  PALETTE, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildViralDataThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const title = data.title || '注目の試合';
  const titleHighlight = data.titleHighlight || '';
  // 統計バッジは「最重要1個」+ 副次「サブ統計1個」
  const mainStat = data.mainStat || (data.dataBadges && data.dataBadges[0]);
  const subStat  = data.subStat  || (data.dataBadges && data.dataBadges[1]);
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-base { position: absolute; inset: 0; background: #000; }

/* ── 上部 極細ストライプ（チャンネル分析感）── */
.top-stripe {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 32px;
  background: linear-gradient(90deg, #000 0%, #1a1a1a 100%);
  border-bottom: 2px solid #fcd34d;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 18px;
  z-index: 9;
}
.stripe-left {
  font-family: 'Georgia', serif;
  font-size: 14px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 8px;
  text-transform: uppercase;
}
.stripe-right {
  font-size: 12px;
  font-weight: 900;
  color: #fff;
  letter-spacing: 3px;
}
.stripe-right .dot {
  display: inline-block;
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #ef4444;
  margin-right: 6px;
  animation: dotPulse 1.4s ease-in-out infinite;
  vertical-align: middle;
}
@keyframes dotPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* ── 大きな写真（フルブリード上65%）── */
.hero-photo-full {
  position: absolute;
  top: 32px; left: 0; right: 0;
  height: calc(65% - 32px);
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: linear-gradient(135deg, #1a2540, #060a14);'}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.22) saturate(1.20) brightness(1.06);
}
/* 写真下端の自然なダーク vignette（線形グラデで黄帯へ繋ぐ）*/
.hero-vignette {
  position: absolute;
  top: 32px; left: 0; right: 0;
  height: calc(65% - 32px);
  background:
    radial-gradient(ellipse 70% 100% at 50% 30%, transparent 50%, rgba(0,0,0,0.4) 100%),
    linear-gradient(to bottom, transparent 70%, rgba(0,0,0,0.5) 100%);
  pointer-events: none;
  z-index: 4;
}

/* ── プレミアム統計バッジ（中央右に大きめ1個）── */
.premium-stat {
  position: absolute;
  top: 80px; right: 36px;
  background: linear-gradient(160deg, #ffffff 0%, #fef9ec 100%);
  border: 4px solid #000;
  box-shadow:
    0 0 0 3px #fcd34d,
    0 12px 28px rgba(0,0,0,0.55),
    0 0 30px rgba(252,211,77,0.5);
  padding: 20px 28px 18px;
  border-radius: 10px;
  z-index: 7;
  transform: rotate(-2deg);
  min-width: 200px;
  text-align: center;
}
.premium-stat::before {
  content: 'KEY DATA';
  position: absolute;
  top: -14px; left: 50%;
  transform: translateX(-50%);
  background: #ef4444;
  color: #fff;
  font-size: 11px;
  font-weight: 900;
  letter-spacing: 3px;
  padding: 4px 14px;
  border-radius: 4px;
  border: 2px solid #000;
  box-shadow: 0 2px 6px rgba(0,0,0,0.4);
}
.premium-stat .ps-num {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 56px;
  font-weight: 900;
  color: #ef4444;
  letter-spacing: -2px;
  line-height: 1;
  -webkit-text-stroke: 2px #000;
  text-shadow: 3px 3px 0 #000;
  display: block;
  margin-bottom: 4px;
  white-space: nowrap;
}
.premium-stat .ps-label {
  font-size: 16px;
  font-weight: 900;
  color: #000;
  letter-spacing: 1px;
  line-height: 1.2;
}

/* ── サブ統計（小さめ・写真の左下）── */
.sub-stat {
  position: absolute;
  top: 80px; left: 36px;
  background: rgba(0,0,0,0.85);
  border: 3px solid #fcd34d;
  padding: 8px 16px;
  border-radius: 6px;
  z-index: 6;
  display: ${subStat ? 'flex' : 'none'};
  align-items: center; gap: 10px;
  transform: rotate(1.5deg);
  box-shadow: 0 6px 18px rgba(0,0,0,0.5);
}
.sub-stat .ss-num {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 30px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: -1px;
  line-height: 1;
  -webkit-text-stroke: 1px #000;
}
.sub-stat .ss-label {
  font-size: 14px;
  font-weight: 900;
  color: #fff;
  letter-spacing: 0.5px;
  line-height: 1.15;
}

/* ── 黄色帯（下30%）+ 黒太縁 ── */
.yellow-banner {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 30%;
  background: linear-gradient(180deg, #fde047 0%, #fbbf24 100%);
  display: flex; flex-direction: column; justify-content: center;
  padding: 14px 32px 16px;
  border-top: 7px solid #000;
  z-index: 5;
}
.yellow-banner::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: #fcd34d;
  box-shadow: 0 0 8px rgba(252,211,77,0.8);
}

/* タイトル1行目: 黒太字 + 多層シャドウ（5ch厚み）*/
.banner-line1 {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'メイリオ', sans-serif;
  font-size: 56px;
  font-weight: 900;
  color: #000;
  line-height: 1.05;
  letter-spacing: -1px;
  text-align: center;
  word-break: keep-all;
  text-shadow:
    2px 2px 0 #fcd34d,
    3px 3px 0 #000,
    4px 4px 0 #fcd34d;
  margin-bottom: 8px;
  ${title.length > 18 ? 'font-size: 48px;' : ''}
  ${title.length > 24 ? 'font-size: 42px;' : ''}
  ${title.length > 30 ? 'font-size: 36px;' : ''}
}
/* タイトル2行目: 赤 + 黒3重縁取り + 黄色グロー */
.banner-line2 {
  display: ${titleHighlight ? 'block' : 'none'};
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 68px;
  font-weight: 900;
  color: #ef4444;
  line-height: 1;
  letter-spacing: -2px;
  text-align: center;
  -webkit-text-stroke: 2.5px #000;
  text-shadow:
    -2px -2px 0 #000,
    2px -2px 0 #000,
    -2px 2px 0 #000,
    4px 4px 0 #000,
    5px 5px 0 #fcd34d,
    6px 6px 0 #000;
  word-break: keep-all;
  ${titleHighlight && titleHighlight.length > 14 ? 'font-size: 56px;' : ''}
  ${titleHighlight && titleHighlight.length > 20 ? 'font-size: 46px;' : ''}
}

${channelLogoStyleFor('dark')}
.channel-logo {
  display: none;  /* テンプレL は上部ストライプにブランド入れてるので非表示 */
}
`;

  const thumbBody = `
<div class="bg-base"></div>
<div class="hero-photo-full"></div>
<div class="hero-vignette"></div>
<div class="top-stripe">
  <span class="stripe-left">${esc(channelName)}</span>
  <span class="stripe-right"><span class="dot"></span>DATA ANALYSIS</span>
</div>
${subStat ? `<div class="sub-stat">
  <span class="ss-num">${esc(subStat.value || '')}</span>
  <span class="ss-label">${esc(subStat.label || '')}</span>
</div>` : ''}
${mainStat ? `<div class="premium-stat">
  <span class="ps-num">${esc(mainStat.value || '')}</span>
  <span class="ps-label">${esc(mainStat.label || '')}</span>
</div>` : ''}
<div class="yellow-banner">
  <div class="banner-line1">${esc(title)}</div>
  ${titleHighlight ? `<div class="banner-line2">${esc(titleHighlight)}</div>` : ''}
</div>
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail L: Viral Data (refined)', tone: 'dark' });
}

module.exports = { buildViralDataThumb };
