// scripts/v2_thumb/templates/tradingCard.js
// サムネ テンプレ O: TRADING CARD（スポーツトレカ風）
//   - 中央にカード（プレイヤー名+ポジション+大きな写真+ステータス）
//   - ホログラフィック風の枠
//   - 背景は色付き光彩で動的
//
// 入力:
//   {
//     heroImage: 'path',
//     playerName: '選手名',
//     position: 'RB / DF',
//     team: 'PSG',
//     overallRating: 92,    // 大きな総合評価
//     stats: [
//       { label: 'GOL', value: 16 },
//       { label: 'AST', value: 24 },
//       { label: 'RAT', value: '8.4' },
//       { label: 'XG', value: '+5.2' },
//     ],
//     bottomCatch: '今季の主役',
//   }

const {
  PALETTE, esc, imgDataUri, wrapThumb, CHANNEL_NAME,
} = require('../_common');

function buildTradingCardThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const playerName = data.playerName || '?';
  const position = data.position || '';
  const team = data.team || '';
  const overall = data.overallRating || '?';
  const stats = (data.stats || []).slice(0, 4);
  const bottomCatch = data.bottomCatch || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse 70% 70% at 50% 50%, rgba(252,211,77,0.18) 0%, transparent 60%),
    linear-gradient(135deg, #1a1f3a 0%, #050810 100%);
}
/* 背景に光放射エフェクト */
.bg-rays {
  position: absolute; inset: 0;
  background:
    repeating-conic-gradient(
      from 30deg at 50% 50%,
      rgba(252,211,77,0.10) 0deg 4deg,
      transparent 4deg 16deg
    );
  filter: blur(1px);
  opacity: 0.55;
  animation: raysSpin 60s linear infinite;
}
@keyframes raysSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* ── トレカ ── */
.card {
  position: absolute;
  top: 30px; bottom: 30px; left: 50%;
  transform: translateX(-50%);
  width: 480px;
  background: linear-gradient(160deg, #fcd34d 0%, #f59e0b 50%, #b45309 100%);
  border-radius: 24px;
  padding: 8px;
  box-shadow:
    0 0 0 4px #000,
    0 0 0 8px #fcd34d,
    0 0 36px rgba(252,211,77,0.7),
    0 16px 48px rgba(0,0,0,0.8);
  z-index: 5;
}
.card-inner {
  position: relative;
  width: 100%; height: 100%;
  background: linear-gradient(180deg, #1a1f3a 0%, #061220 100%);
  border-radius: 18px;
  overflow: hidden;
  border: 3px solid rgba(252,211,77,0.5);
}

/* ホログラフィック風光沢 */
.card-shine {
  position: absolute;
  top: 0; left: -50%;
  width: 200%; height: 100%;
  background: linear-gradient(115deg,
    transparent 30%,
    rgba(252,211,77,0.15) 45%,
    rgba(255,255,255,0.18) 50%,
    rgba(252,211,77,0.15) 55%,
    transparent 70%);
  pointer-events: none;
}

/* カード内ヘッダ：選手名 / ポジション / 総合評価 */
.card-header {
  position: absolute;
  top: 12px; left: 12px; right: 12px;
  display: flex; justify-content: space-between; align-items: flex-start;
  z-index: 4;
}
.card-name-block {
  flex: 1;
}
.card-team {
  font-family: 'Georgia', serif;
  font-style: italic;
  font-size: 16px;
  font-weight: 700;
  color: #fcd34d;
  letter-spacing: 4px;
  text-transform: uppercase;
  margin-bottom: 2px;
}
.card-name {
  font-size: 32px;
  font-weight: 900;
  color: #fff;
  line-height: 1;
  letter-spacing: 1px;
  -webkit-text-stroke: 1px #fcd34d;
  text-shadow: 0 0 10px rgba(252,211,77,0.5), 2px 2px 0 #000;
  margin-bottom: 4px;
}
.card-position {
  display: inline-block;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  font-weight: 900;
  color: #000;
  background: #fcd34d;
  padding: 3px 12px;
  border-radius: 4px;
  letter-spacing: 2px;
  border: 2px solid #000;
}

/* 総合評価（右上の大きな数字）*/
.card-overall {
  position: relative;
  width: 110px; height: 110px;
  background: radial-gradient(circle at 35% 30%, #fef3c7 0%, #fcd34d 60%, #b45309 100%);
  border: 4px solid #000;
  border-radius: 50%;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  box-shadow: 0 6px 18px rgba(0,0,0,0.6), inset 0 -6px 16px rgba(180,83,9,0.4);
  flex-shrink: 0;
}
.card-overall-num {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 56px;
  font-weight: 900;
  color: #000;
  letter-spacing: -2px;
  line-height: 1;
  -webkit-text-stroke: 1px #000;
}
.card-overall-label {
  font-family: 'Georgia', serif;
  font-size: 11px;
  font-weight: 900;
  color: #000;
  letter-spacing: 4px;
  margin-top: -2px;
}

/* 写真エリア（中央）*/
.card-photo {
  position: absolute;
  top: 145px; left: 0; right: 0;
  height: 350px;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: radial-gradient(circle at 50% 60%, #2a3560, #0d1220);'}
  background-size: cover;
  background-position: center 20%;
  filter: contrast(1.18) saturate(1.18) brightness(1.05);
  -webkit-mask-image: linear-gradient(180deg, black 80%, transparent 100%);
  mask-image: linear-gradient(180deg, black 80%, transparent 100%);
}

/* スタッツグリッド（下部） */
.card-stats {
  position: absolute;
  bottom: 56px; left: 16px; right: 16px;
  display: grid; grid-template-columns: repeat(${stats.length || 4}, 1fr);
  gap: 8px;
  z-index: 4;
}
.stat-cell {
  background: rgba(0,0,0,0.78);
  border: 2px solid #fcd34d;
  border-radius: 8px;
  padding: 8px 4px;
  text-align: center;
  box-shadow: 0 0 10px rgba(252,211,77,0.3) inset;
}
.stat-cell .sc-label {
  font-family: 'Courier New', monospace;
  font-size: 11px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 2px;
  margin-bottom: 4px;
}
.stat-cell .sc-value {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 26px;
  font-weight: 900;
  color: #fff;
  letter-spacing: -1px;
  line-height: 1;
  text-shadow: 0 0 8px rgba(252,211,77,0.5);
}

/* カード下部 タグ */
.card-bottom-tag {
  position: absolute;
  bottom: 14px; left: 50%;
  transform: translateX(-50%);
  font-family: 'Georgia', serif;
  font-size: 12px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 6px;
  text-transform: uppercase;
}

/* ── 左側 縦テキスト ── */
.left-vertical {
  position: absolute;
  top: 50%; left: 28px;
  transform: translateY(-50%) rotate(-90deg);
  transform-origin: left center;
  font-family: 'Georgia', serif;
  font-size: 18px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 12px;
  text-transform: uppercase;
  white-space: nowrap;
  z-index: 4;
  text-shadow: 0 0 12px rgba(252,211,77,0.5);
}

/* ── 右側 縦タグ ── */
.right-tag {
  position: absolute;
  top: 50%; right: 28px;
  transform: translateY(-50%);
  display: flex; flex-direction: column;
  gap: 12px;
  z-index: 4;
}
.right-tag-item {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 16px;
  font-weight: 900;
  color: #fff;
  background: rgba(0,0,0,0.85);
  border-left: 4px solid #ef4444;
  padding: 8px 14px;
  border-radius: 0 6px 6px 0;
  letter-spacing: 2px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.5);
  white-space: nowrap;
}

/* ── 下部 キャッチ ── */
.bottom-catch {
  display: ${bottomCatch ? 'block' : 'none'};
  position: absolute;
  bottom: 22px; left: 50%;
  transform: translateX(-50%) rotate(-1deg);
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 36px;
  font-weight: 900;
  color: #000;
  background: #fcd34d;
  padding: 10px 28px;
  border-radius: 8px;
  border: 3px solid #000;
  box-shadow: 0 8px 24px rgba(0,0,0,0.6);
  letter-spacing: 2px;
  z-index: 9;
  -webkit-text-stroke: 0.5px #000;
  text-shadow: 2px 2px 0 #fcd34d;
  white-space: nowrap;
}

/* ── 上部 チャンネルバナー ── */
.channel-top {
  position: absolute;
  top: 12px; left: 12px;
  background: rgba(0,0,0,0.85);
  border: 2px solid #fcd34d;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 13px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 4px;
  z-index: 9;
}
`;

  const teamLabel = team ? `${team} · ` : '';

  const thumbBody = `
<div class="bg-base"></div>
<div class="bg-rays"></div>
<div class="left-vertical">PLAYER CARD · ANALYSIS</div>
<div class="card">
  <div class="card-inner">
    <div class="card-shine"></div>
    <div class="card-header">
      <div class="card-name-block">
        <div class="card-team">${esc(teamLabel)}OFFICIAL</div>
        <div class="card-name">${esc(playerName)}</div>
        ${position ? `<div class="card-position">${esc(position)}</div>` : ''}
      </div>
      <div class="card-overall">
        <div class="card-overall-num">${esc(String(overall))}</div>
        <div class="card-overall-label">OVR</div>
      </div>
    </div>
    <div class="card-photo"></div>
    ${stats.length ? `<div class="card-stats">
      ${stats.map(s => `<div class="stat-cell">
        <div class="sc-label">${esc(String(s.label || '').toUpperCase())}</div>
        <div class="sc-value">${esc(String(s.value || ''))}</div>
      </div>`).join('')}
    </div>` : ''}
    <div class="card-bottom-tag">2026 SEASON · DATA ANALYSIS</div>
  </div>
</div>
${bottomCatch ? `<div class="bottom-catch">${esc(bottomCatch)}</div>` : ''}
<div class="channel-top">${esc(channelName)}</div>
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail O: Trading Card', tone: 'dark' });
}

module.exports = { buildTradingCardThumb };
