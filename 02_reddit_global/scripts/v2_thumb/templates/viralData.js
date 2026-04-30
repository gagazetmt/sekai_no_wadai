// scripts/v2_thumb/templates/viralData.js
// サムネ テンプレ L: BREAKING JUMBOTRON (リネカ大胆刷新版)
//   - 上部: 赤い斜めリボン「BREAKING / 衝撃の数字」
//   - 写真: フルブリード + dramatic 色調補正 + 中央バースト
//   - 中央右: 巨大グロー数字 + 放射バースト背景
//   - 下部: 斜め黄色帯（-3°）+ 多層タイトル
//   - dot pattern と pitch line で「アナリスト感」加味
//
// 入力:
//   {
//     heroImage: 'path',
//     title: 'メインタイトル',
//     titleHighlight: '赤強調語（任意）',
//     mainStat:  { value: '63%', label: 'ドリブル成功率' },
//     subStat:   { value: '+5.2', label: 'xG超過' },
//     breakingLabel: '衝撃の数字',  // 上部赤リボン (default: 'BREAKING')
//   }

const {
  PALETTE, esc, imgDataUri, wrapThumb, CHANNEL_NAME,
} = require('../_common');

function buildViralDataThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const title = data.title || '注目の試合';
  const titleHighlight = data.titleHighlight || '';
  const mainStat = data.mainStat || (data.dataBadges && data.dataBadges[0]);
  const subStat  = data.subStat  || (data.dataBadges && data.dataBadges[1]);
  const breakingLabel = data.breakingLabel || '衝撃のデータ';
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-base { position: absolute; inset: 0; background: #000; }

/* ── ベース写真（フルブリード）── */
.hero-full {
  position: absolute; inset: 0;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: linear-gradient(135deg, #1a2540, #060a14);'}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.20) saturate(1.18) brightness(0.95);
}
/* 中央光点（ジャンボトロン感）+ 周辺暗化 */
.hero-vignette {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 50% 60% at 60% 40%, rgba(252,211,77,0.18) 0%, transparent 50%),
    radial-gradient(ellipse 100% 100% at 50% 50%, transparent 30%, rgba(0,0,0,0.55) 100%);
  pointer-events: none;
}

/* ── 上部 斜め赤リボン（BREAKING）── */
.breaking-ribbon {
  position: absolute;
  top: 18px; left: -40px;
  width: 480px; height: 60px;
  background: linear-gradient(90deg, #dc2626 0%, #ef4444 100%);
  transform: rotate(-3deg);
  display: flex; align-items: center; justify-content: center;
  gap: 14px;
  box-shadow: 0 8px 22px rgba(220,38,38,0.5), 0 0 0 3px #000 inset, 0 0 0 6px rgba(252,211,77,0.6);
  z-index: 8;
}
.breaking-en {
  font-family: 'Georgia', serif;
  font-size: 14px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 8px;
  text-transform: uppercase;
}
.breaking-jp {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 26px;
  font-weight: 900;
  color: #fff;
  letter-spacing: 2px;
  -webkit-text-stroke: 1px #000;
  text-shadow: 2px 2px 0 #000;
}
.breaking-dot {
  width: 12px; height: 12px;
  border-radius: 50%;
  background: #fcd34d;
  animation: dotPulse 0.8s ease-in-out infinite;
}
@keyframes dotPulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.4); opacity: 0.6; } }

/* ── 右中央：爆発バースト + 巨大数字 ── */
.stat-burst {
  position: absolute;
  top: 50%; right: 36px;
  transform: translateY(-50%) rotate(-1deg);
  z-index: 7;
}
.burst-rays {
  position: absolute;
  inset: -80px;
  background:
    repeating-conic-gradient(
      from 0deg at 50% 50%,
      rgba(252,211,77,0.55) 0deg 8deg,
      transparent 8deg 22deg
    );
  filter: blur(2px);
  opacity: 0.85;
  border-radius: 50%;
  z-index: -1;
  animation: burstSpin 24s linear infinite;
}
@keyframes burstSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.stat-circle {
  width: 280px; height: 280px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 30%, #fff 0%, #fef9ec 60%, #fcd34d 100%);
  border: 8px solid #000;
  box-shadow:
    0 0 0 4px #fcd34d,
    0 16px 40px rgba(0,0,0,0.7),
    0 0 60px rgba(252,211,77,0.6),
    inset 0 -10px 30px rgba(252,211,77,0.4);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  position: relative;
  text-align: center;
  padding: 20px;
}
.stat-circle::before {
  content: 'KEY';
  position: absolute;
  top: -22px; left: 50%;
  transform: translateX(-50%);
  background: #ef4444;
  color: #fcd34d;
  font-family: 'Georgia', serif;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 6px;
  padding: 6px 22px;
  border-radius: 4px;
  border: 3px solid #000;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
}
.stat-num {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 78px;
  font-weight: 900;
  color: #ef4444;
  letter-spacing: -3px;
  line-height: 0.95;
  -webkit-text-stroke: 3px #000;
  text-shadow: 4px 4px 0 #000;
  white-space: nowrap;
}
.stat-label {
  font-size: 18px;
  font-weight: 900;
  color: #000;
  letter-spacing: 1px;
  margin-top: 6px;
  line-height: 1.2;
  background: #fcd34d;
  padding: 4px 14px;
  border-radius: 4px;
  border: 2px solid #000;
}

/* ── サブ統計（左下、小さめ）── */
.sub-stat {
  display: ${subStat ? 'flex' : 'none'};
  position: absolute;
  bottom: 38%; left: 28px;
  align-items: center; gap: 10px;
  background: rgba(0,0,0,0.92);
  border: 3px solid #fcd34d;
  padding: 10px 18px;
  border-radius: 6px;
  z-index: 6;
  transform: rotate(2deg);
  box-shadow: 0 8px 22px rgba(0,0,0,0.6), 0 0 18px rgba(252,211,77,0.4);
}
.ss-num {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 36px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: -1px;
  line-height: 1;
  -webkit-text-stroke: 1.5px #000;
  text-shadow: 2px 2px 0 #000;
}
.ss-label {
  font-size: 13px;
  font-weight: 900;
  color: #fff;
  letter-spacing: 1px;
}

/* ── 下部 斜め黄色帯（-3°傾き）── */
.tilt-banner {
  position: absolute;
  bottom: 28px; left: -30px; right: -30px;
  background: linear-gradient(180deg, #fde047 0%, #fbbf24 100%);
  border-top: 6px solid #000;
  border-bottom: 6px solid #000;
  padding: 14px 60px 16px;
  transform: rotate(-2.5deg);
  box-shadow: 0 12px 30px rgba(0,0,0,0.6), 0 0 0 4px #ef4444 inset;
  z-index: 5;
}
.tilt-banner-inner {
  transform: rotate(0deg);
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.banner-line1 {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'メイリオ', sans-serif;
  font-size: 50px;
  font-weight: 900;
  color: #000;
  line-height: 1.05;
  letter-spacing: -1px;
  text-align: center;
  word-break: keep-all;
  text-shadow:
    2px 2px 0 #fcd34d,
    3px 3px 0 #000;
  ${title.length > 18 ? 'font-size: 42px;' : ''}
  ${title.length > 24 ? 'font-size: 36px;' : ''}
}
.banner-line2 {
  display: ${titleHighlight ? 'inline-block' : 'none'};
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 60px;
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
  ${titleHighlight && titleHighlight.length > 14 ? 'font-size: 50px;' : ''}
  ${titleHighlight && titleHighlight.length > 20 ? 'font-size: 42px;' : ''}
}

/* ── 装飾: dot pattern オーバーレイ ── */
.dot-overlay {
  position: absolute;
  top: 0; right: 0;
  width: 280px; height: 100%;
  background-image: radial-gradient(circle, rgba(252,211,77,0.18) 1.5px, transparent 2px);
  background-size: 12px 12px;
  pointer-events: none;
  z-index: 3;
  mix-blend-mode: screen;
}

/* ── 左サイドの縦カウンタ風ライン（ピッチ感）── */
.side-gauge {
  position: absolute;
  top: 100px; left: 12px;
  width: 6px; height: 240px;
  background: linear-gradient(180deg, #fcd34d 0%, #ef4444 100%);
  border-radius: 3px;
  box-shadow: 0 0 18px rgba(252,211,77,0.6);
  z-index: 4;
}

/* ── 上部 細チャンネルバー（控えめ）── */
.channel-bar {
  position: absolute;
  top: 0; right: 0;
  background: rgba(0,0,0,0.85);
  border-bottom: 3px solid #fcd34d;
  border-left: 3px solid #fcd34d;
  padding: 6px 16px 6px 22px;
  font-size: 13px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 4px;
  z-index: 9;
  border-radius: 0 0 0 8px;
}
`;

  const thumbBody = `
<div class="bg-base"></div>
<div class="hero-full"></div>
<div class="hero-vignette"></div>
<div class="dot-overlay"></div>
<div class="side-gauge"></div>
<div class="channel-bar">${esc(channelName)}</div>

<div class="breaking-ribbon">
  <span class="breaking-dot"></span>
  <span class="breaking-en">Breaking</span>
  <span class="breaking-jp">${esc(breakingLabel)}</span>
</div>

${mainStat ? `<div class="stat-burst">
  <div class="burst-rays"></div>
  <div class="stat-circle">
    <div class="stat-num">${esc(mainStat.value || '')}</div>
    <div class="stat-label">${esc(mainStat.label || '')}</div>
  </div>
</div>` : ''}

${subStat ? `<div class="sub-stat">
  <span class="ss-num">${esc(subStat.value || '')}</span>
  <span class="ss-label">${esc(subStat.label || '')}</span>
</div>` : ''}

<div class="tilt-banner">
  <div class="tilt-banner-inner">
    <div class="banner-line1">${esc(title)}</div>
    ${titleHighlight ? `<div class="banner-line2">${esc(titleHighlight)}</div>` : ''}
  </div>
</div>
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail L: Breaking Jumbotron', tone: 'dark' });
}

module.exports = { buildViralDataThumb };
