// scripts/v2_thumb/templates/viralData.js
// サムネ テンプレ L: 5ch反応集スタイル × データ中身
//   - 大きな選手の顔写真（感情MAXの瞬間）
//   - 黄色ベタ帯 + 黒太字タイトル + 赤強調語
//   - 右上に2-3枚の「データ箱」(白背景 × 赤太字) — ファン反応の代わりに数字
//   - 高コントラスト・派手・即視認
//
// 入力:
//   {
//     heroImage: 'path',          // 大きな顔写真
//     title: '堅守対決 アーセナルVSアトレティコ',  // 黒太字
//     titleHighlight: 'とんでもない結果に',         // 赤太字 (黄帯下段)
//     dataBadges: [
//       { value: '63%', label: 'ドリブル成功率' },
//       { value: '+5.2', label: 'xG超過' },
//     ],
//     channelName: '5分でサッカー分析',
//   }

const {
  PALETTE, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildViralDataThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const title = data.title || '注目の試合';
  const titleHighlight = data.titleHighlight || '';
  const dataBadges = (data.dataBadges || []).slice(0, 3);
  const channelName = data.channelName || CHANNEL_NAME;
  // tone は基本このテンプレ専用（5ch風＝派手）なので無視

  const extraStyles = `
.bg-base {
  position: absolute; inset: 0;
  background: #000;
}
/* 大きな顔写真（上 0〜65%）*/
.hero-photo-full {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 65%;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: linear-gradient(135deg, #1a2540, #060a14);'}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.18) saturate(1.18) brightness(1.05);
}
.hero-photo-full::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 80px;
  background: linear-gradient(to bottom, transparent, #fcd34d 100%);
}

/* 右上のデータ箱（ファン反応の代わり）*/
.data-badges {
  position: absolute;
  top: 24px; right: 24px;
  display: flex; flex-direction: column; gap: 8px;
  z-index: 8;
  max-width: 380px;
}
.data-badge {
  background: #fff;
  border: 4px solid #dc2626;
  padding: 10px 18px;
  border-radius: 4px;
  box-shadow: 0 6px 18px rgba(0,0,0,0.45), 0 0 0 2px rgba(0,0,0,0.85) inset;
  display: flex; align-items: center; gap: 14px;
  transform: rotate(-2deg);  /* 5ch反応集の傾き感 */
}
.data-badge:nth-child(2) { transform: rotate(1.5deg); }
.data-badge:nth-child(3) { transform: rotate(-1deg); }
.data-badge .b-num {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 38px;
  font-weight: 900;
  color: #dc2626;
  letter-spacing: -1px;
  line-height: 1;
  white-space: nowrap;
  text-shadow: 0 2px 0 rgba(0,0,0,0.10);
}
.data-badge .b-label {
  font-size: 16px;
  font-weight: 900;
  color: #111;
  letter-spacing: 0.5px;
  line-height: 1.15;
}

/* 下半分の黄色帯（タイトルゾーン）*/
.yellow-banner {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 35%;
  background: #fcd34d;
  display: flex; flex-direction: column; justify-content: center;
  padding: 18px 30px 20px;
  border-top: 6px solid #000;
  z-index: 5;
}
.banner-line1 {
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 56px;
  font-weight: 900;
  color: #000;
  line-height: 1.1;
  letter-spacing: -1px;
  text-align: center;
  word-break: keep-all;
  text-shadow: 0 0 1px #000;
  margin-bottom: 6px;
  /* 文字長で縮小 */
  ${title.length > 18 ? 'font-size: 48px;' : ''}
  ${title.length > 24 ? 'font-size: 42px;' : ''}
}
.banner-line2 {
  display: ${titleHighlight ? 'block' : 'none'};
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 64px;
  font-weight: 900;
  color: #dc2626;
  line-height: 1;
  letter-spacing: -2px;
  text-align: center;
  -webkit-text-stroke: 1.5px #000;
  text-shadow: 3px 3px 0 #000, -1px -1px 0 #000;
  word-break: keep-all;
  ${titleHighlight && titleHighlight.length > 14 ? 'font-size: 54px;' : ''}
  ${titleHighlight && titleHighlight.length > 20 ? 'font-size: 46px;' : ''}
}

${channelLogoStyleFor('dark')}
.channel-logo {
  left: 24px; bottom: auto; top: 24px;
  background: rgba(0,0,0,0.85);
  border-color: #fcd34d;
}
.channel-logo .channel-icon { color: #fcd34d; }
`;

  const thumbBody = `
<div class="bg-base"></div>
<div class="hero-photo-full"></div>
<div class="data-badges">
  ${dataBadges.map(b => `<div class="data-badge">
    <span class="b-num">${esc(b.value || '')}</span>
    <span class="b-label">${esc(b.label || '')}</span>
  </div>`).join('')}
</div>
<div class="yellow-banner">
  <div class="banner-line1">${esc(title)}</div>
  ${titleHighlight ? `<div class="banner-line2">${esc(titleHighlight)}</div>` : ''}
</div>
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail L: Viral Data', tone: 'dark' });
}

module.exports = { buildViralDataThumb };
