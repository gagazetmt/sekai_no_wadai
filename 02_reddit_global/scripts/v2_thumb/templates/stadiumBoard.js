// scripts/v2_thumb/templates/stadiumBoard.js
// サムネ テンプレ M: STADIUM SCOREBOARD（夜のスタジアム電光掲示板風）
//   - 写真が縦に右半分、左半分にデジタル風スコアボード
//   - LED風数字（角張った monospace 風）+ 緑/赤のステータスインジケータ
//   - 上部に「LIVE」風バッジ + ピッチ照明感
//
// 入力:
//   {
//     heroImage: 'path',
//     title: 'タイトル',
//     scoreLabel: 'PSG vs BAYERN',  // 中央のラベル
//     scoreLeft:  '5',
//     scoreRight: '4',
//     mainStat:   { value: '+2', label: 'GOAL DIFF' },  // 大きい表示
//     subStats: [
//       { label: 'Possession', value: '58%' },
//       { label: 'Shots', value: '15' },
//     ],
//   }

const {
  PALETTE, esc, imgDataUri, wrapThumb, CHANNEL_NAME,
} = require('../_common');

function buildStadiumBoardThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const title = data.title || 'STADIUM ANALYSIS';
  const scoreLabel = data.scoreLabel || 'TODAY';
  const scoreLeft = data.scoreLeft || '';
  const scoreRight = data.scoreRight || '';
  const mainStat = data.mainStat || { value: '63%', label: 'MAIN' };
  const subStats = (data.subStats || []).slice(0, 3);
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-base { position: absolute; inset: 0; background: #000; }

/* ── 全面ピッチ風背景（緑グラデ + 縞） ── */
.pitch-bg {
  position: absolute; inset: 0;
  background:
    repeating-linear-gradient(90deg,
      rgba(0,0,0,0) 0px,
      rgba(0,0,0,0) 80px,
      rgba(255,255,255,0.025) 80px,
      rgba(255,255,255,0.025) 160px),
    radial-gradient(ellipse at 50% 50%, #1a3a1a 0%, #061a06 70%, #000 100%);
}

/* ── 右側 写真（フルブリード）── */
.hero-right {
  position: absolute;
  top: 0; right: 0; bottom: 0;
  width: 55%;
  ${heroImg ? `background-image: url('${heroImg}');` : ''}
  background-size: cover;
  background-position: center 22%;
  filter: contrast(1.18) saturate(1.18) brightness(0.95);
}
.hero-right::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 200px;
  background: linear-gradient(to right, #061a06 0%, transparent 100%);
}

/* ── 左側 スコアボード ── */
.scoreboard {
  position: absolute;
  top: 0; left: 0; bottom: 0;
  width: 55%;
  background: linear-gradient(180deg, rgba(8,16,8,0.92) 0%, rgba(0,0,0,0.95) 100%);
  border-right: 4px solid #000;
  box-shadow: 6px 0 18px rgba(0,0,0,0.6);
  display: flex; flex-direction: column;
  padding: 22px 24px;
  z-index: 4;
}

/* 上部 LIVE バッジ */
.live-badge {
  display: inline-flex; align-items: center; gap: 8px;
  background: #dc2626;
  color: #fff;
  padding: 5px 14px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 900;
  letter-spacing: 4px;
  align-self: flex-start;
  border: 2px solid #fff;
  box-shadow: 0 0 12px rgba(220,38,38,0.6);
}
.live-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #fff;
  animation: pulse 1s ease-in-out infinite;
}
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
.match-tag {
  font-family: 'Courier New', monospace;
  font-size: 12px;
  font-weight: 700;
  color: #4ade80;
  letter-spacing: 4px;
  margin-top: 12px;
  text-shadow: 0 0 8px rgba(74,222,128,0.6);
}

/* ── 中央 LED風スコア ── */
.score-display {
  flex: 1;
  display: flex; flex-direction: column; justify-content: center;
  margin-top: 8px;
}
.score-label {
  font-family: 'Courier New', monospace;
  font-size: 18px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 6px;
  text-align: center;
  margin-bottom: 12px;
  text-shadow: 0 0 14px rgba(252,211,77,0.7);
}
.score-row {
  display: flex; align-items: center; justify-content: center;
  gap: 30px;
  font-family: 'Courier New', monospace;
  font-weight: 900;
}
.score-num {
  font-size: 130px;
  color: #fcd34d;
  letter-spacing: -8px;
  line-height: 1;
  text-shadow:
    0 0 20px rgba(252,211,77,0.9),
    0 0 50px rgba(252,211,77,0.5),
    0 4px 10px rgba(0,0,0,0.8);
  -webkit-text-stroke: 2px #000;
  background: linear-gradient(180deg, #fef3c7 0%, #fcd34d 50%, #d97706 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 14px rgba(252,211,77,0.6));
}
.score-dash {
  font-size: 80px;
  color: #4ade80;
  text-shadow: 0 0 18px rgba(74,222,128,0.7);
}

/* ── メインデータ（円形）── */
.main-data {
  background: linear-gradient(160deg, rgba(0,0,0,0.85) 0%, rgba(20,40,20,0.85) 100%);
  border: 3px solid #fcd34d;
  border-radius: 12px;
  padding: 14px 24px;
  margin: 10px auto 0;
  text-align: center;
  box-shadow: 0 0 18px rgba(252,211,77,0.4), inset 0 0 20px rgba(0,0,0,0.5);
  display: inline-block;
  align-self: center;
}
.main-data .md-num {
  font-family: 'Courier New', monospace;
  font-size: 42px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: -1px;
  line-height: 1;
  text-shadow: 0 0 14px rgba(252,211,77,0.7);
  margin-bottom: 4px;
  -webkit-text-stroke: 1px #000;
  white-space: nowrap;
}
.main-data .md-label {
  font-family: 'Courier New', monospace;
  font-size: 14px;
  font-weight: 700;
  color: #4ade80;
  letter-spacing: 4px;
}

/* ── 下部 サブスタッツ行 ── */
.sub-stats {
  display: flex; gap: 8px; margin-top: 12px;
  justify-content: space-around;
}
.sub-cell {
  flex: 1;
  background: rgba(0,0,0,0.6);
  border: 2px solid #4ade80;
  padding: 8px 10px;
  border-radius: 6px;
  text-align: center;
  box-shadow: 0 0 10px rgba(74,222,128,0.3) inset;
}
.sub-cell .sc-label {
  font-family: 'Courier New', monospace;
  font-size: 11px;
  color: #4ade80;
  letter-spacing: 2px;
  margin-bottom: 4px;
}
.sub-cell .sc-value {
  font-family: 'Courier New', monospace;
  font-size: 22px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: -1px;
  text-shadow: 0 0 8px rgba(252,211,77,0.5);
}

/* ── 下部 タイトル帯 ── */
.bottom-title {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  background: linear-gradient(90deg, rgba(0,0,0,0.95) 0%, rgba(20,40,20,0.85) 50%, rgba(0,0,0,0.95) 100%);
  border-top: 4px solid #fcd34d;
  padding: 14px 36px;
  z-index: 6;
  text-align: center;
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 38px;
  font-weight: 900;
  color: #fff;
  letter-spacing: 1px;
  -webkit-text-stroke: 1px #fff;
  text-shadow: 0 0 14px rgba(252,211,77,0.6), 2px 2px 0 #000;
  box-shadow: 0 -8px 20px rgba(0,0,0,0.5);
  ${title.length > 22 ? 'font-size: 32px;' : ''}
  ${title.length > 28 ? 'font-size: 28px;' : ''}
}
.bottom-title::before {
  content: '▶';
  color: #fcd34d;
  margin-right: 12px;
  font-size: 28px;
}

/* ── 右上 チャンネル ── */
.channel-corner {
  position: absolute;
  top: 12px; right: 12px;
  background: rgba(0,0,0,0.85);
  border: 2px solid #fcd34d;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 3px;
  z-index: 9;
}
`;

  const thumbBody = `
<div class="bg-base"></div>
<div class="pitch-bg"></div>
<div class="hero-right"></div>
<div class="scoreboard">
  <div class="live-badge"><span class="live-dot"></span>LIVE DATA</div>
  <div class="match-tag">▎${esc(scoreLabel)}</div>

  <div class="score-display">
    ${(scoreLeft || scoreRight) ? `
      <div class="score-label">━ TONIGHT'S NUMBERS ━</div>
      <div class="score-row">
        <span class="score-num">${esc(scoreLeft)}</span>
        <span class="score-dash">━</span>
        <span class="score-num">${esc(scoreRight)}</span>
      </div>` : `
      <div class="score-label">━ TONIGHT'S DATA ━</div>`}

    <div class="main-data">
      <div class="md-num">${esc(mainStat.value || '')}</div>
      <div class="md-label">${esc(mainStat.label || '').toUpperCase()}</div>
    </div>

    ${subStats.length ? `<div class="sub-stats">
      ${subStats.map(s => `<div class="sub-cell">
        <div class="sc-label">${esc(String(s.label || '').toUpperCase())}</div>
        <div class="sc-value">${esc(s.value || '')}</div>
      </div>`).join('')}
    </div>` : ''}
  </div>
</div>
<div class="bottom-title">${esc(title)}</div>
<div class="channel-corner">${esc(channelName)}</div>
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail M: Stadium Scoreboard', tone: 'dark' });
}

module.exports = { buildStadiumBoardThumb };
