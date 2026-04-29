// scripts/v2_thumb/templates/ranking.js
// サムネ テンプレ B: ランキング型 (tone: 'dark' | 'light')
//   - 中央上部にタイトル
//   - 縦並びで #1 #2 #3 の選手 + 数字
//   - 各選手の顔写真（円形）

const {
  PALETTE, tonePalette, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

const RANK_COLORS = ['#fcd34d', '#cbd5e1', '#d97706'];  // 金・銀・銅

function buildRankingThumb(data = {}) {
  const tone = data.tone || 'dark';
  const isLight = tone === 'light';
  const p = tonePalette(tone);
  const title = data.title || 'TOPランキング';
  const items = (data.items || []).slice(0, 3);
  const bottomCatch = data.bottomCatch || '';
  const channelName = data.channelName || CHANNEL_NAME;

  while (items.length < 3) items.push({ rank: items.length + 1, name: '?', value: '?' });

  const titleShadow = isLight
    ? `0 2px 8px rgba(0,0,0,0.10)`
    : `0 0 10px rgba(255,255,255,0.4), 0 0 22px rgba(245,158,11,0.4), 0 4px 18px rgba(0,0,0,0.9)`;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background: ${isLight
    ? `radial-gradient(ellipse at 50% 30%, rgba(245,158,11,0.10) 0%, transparent 60%),
       linear-gradient(180deg, #fefaf2 0%, #f0e8d8 100%)`
    : `radial-gradient(ellipse at 50% 30%, rgba(245,158,11,0.15) 0%, transparent 60%),
       linear-gradient(180deg, #1a2240 0%, #060a14 100%)`};
}

.title-zone {
  position: absolute;
  top: 30px; left: 50%;
  transform: translateX(-50%);
  text-align: center;
  z-index: 5;
}
.title-en {
  font-family: 'Georgia', serif;
  font-size: 18px;
  letter-spacing: 8px;
  color: ${p.accent};
  text-transform: uppercase;
  margin-bottom: 4px;
}
.title-jp {
  font-size: 60px;
  font-weight: 900;
  color: ${p.text};
  letter-spacing: 4px;
  ${isLight ? '' : '-webkit-text-stroke: 2px rgba(255,255,255,0.1);'}
  text-shadow: ${titleShadow};
  white-space: nowrap;
}
.title-bar {
  width: 250px; height: 4px;
  background: linear-gradient(90deg, transparent, ${p.accent}, transparent);
  margin: 8px auto 0;
}

.rank-list {
  position: absolute;
  top: 180px; left: 50px; right: 50px;
  display: flex; flex-direction: column;
  gap: 14px;
  z-index: 5;
}
.rank-row {
  display: grid;
  grid-template-columns: 100px 100px 1fr auto;
  align-items: center;
  gap: 24px;
  padding: 12px 28px;
  background: ${isLight
    ? `linear-gradient(90deg, rgba(245,158,11,0.10) 0%, rgba(255,255,255,0.7) 70%)`
    : `linear-gradient(90deg, rgba(245,158,11,0.12) 0%, rgba(6,14,28,0.4) 70%)`};
  border-left: 6px solid ${p.accent};
  border-radius: 0 12px 12px 0;
  height: 116px;
  box-shadow: ${isLight ? '0 4px 16px rgba(0,0,0,0.08)' : '0 6px 24px rgba(0,0,0,0.5)'};
}
.rank-row.r1 {
  background: ${isLight
    ? `linear-gradient(90deg, rgba(252,211,77,0.30) 0%, rgba(255,255,255,0.7) 70%)`
    : `linear-gradient(90deg, rgba(252,211,77,0.18) 0%, rgba(6,14,28,0.4) 70%)`};
  border-left-color: ${RANK_COLORS[0]};
  height: 132px;
}
.rank-row.r2 {
  background: ${isLight
    ? `linear-gradient(90deg, rgba(203,213,225,0.40) 0%, rgba(255,255,255,0.7) 70%)`
    : `linear-gradient(90deg, rgba(203,213,225,0.10) 0%, rgba(6,14,28,0.4) 70%)`};
  border-left-color: ${RANK_COLORS[1]};
}
.rank-row.r3 {
  background: ${isLight
    ? `linear-gradient(90deg, rgba(217,119,6,0.20) 0%, rgba(255,255,255,0.7) 70%)`
    : `linear-gradient(90deg, rgba(217,119,6,0.10) 0%, rgba(6,14,28,0.4) 70%)`};
  border-left-color: ${RANK_COLORS[2]};
}
.rank-num {
  font-family: 'Georgia', serif;
  font-size: 88px;
  font-weight: 900;
  font-style: italic;
  text-align: center;
  letter-spacing: -4px;
  line-height: 1;
}
.rank-row.r1 .rank-num { color: ${isLight ? '#b8860b' : RANK_COLORS[0]}; text-shadow: 0 0 18px rgba(252,211,77,0.6); font-size: 100px; }
.rank-row.r2 .rank-num { color: ${isLight ? '#6b7280' : RANK_COLORS[1]}; text-shadow: 0 0 14px rgba(203,213,225,0.5); }
.rank-row.r3 .rank-num { color: ${RANK_COLORS[2]}; text-shadow: 0 0 14px rgba(217,119,6,0.5); }
.rank-photo {
  width: 90px; height: 90px;
  border-radius: 50%;
  background-size: cover;
  background-position: center;
  border: 3px solid ${p.accent};
  box-shadow: 0 0 18px rgba(245,158,11,0.4);
}
.rank-row.r1 .rank-photo { border-color: ${RANK_COLORS[0]}; box-shadow: 0 0 22px rgba(252,211,77,0.5); width: 100px; height: 100px; }
.rank-name {
  font-size: 36px;
  font-weight: 900;
  color: ${p.text};
  letter-spacing: 1px;
  line-height: 1.1;
  text-shadow: ${isLight ? 'none' : '0 2px 8px rgba(0,0,0,0.7)'};
}
.rank-row.r1 .rank-name { font-size: 42px; }
.rank-value {
  font-size: 30px;
  font-weight: 900;
  color: ${p.accent};
  letter-spacing: 1px;
  text-shadow: ${isLight ? 'none' : '0 0 12px rgba(245,158,11,0.5)'};
  font-family: 'Georgia', serif;
  font-style: italic;
  white-space: nowrap;
}
.rank-row.r1 .rank-value { font-size: 36px; }

.bottom-catch {
  position: absolute;
  bottom: 90px; left: 50%;
  transform: translateX(-50%);
  font-size: 28px;
  font-weight: 900;
  color: ${isLight ? '#fff' : p.text};
  background: ${isLight ? p.accent : 'rgba(0, 0, 0, 0.65)'};
  border: 2px solid ${isLight ? p.accent : 'rgba(245, 158, 11, 0.5)'};
  padding: 10px 30px;
  border-radius: 8px;
  letter-spacing: 1.5px;
  z-index: 6;
  white-space: nowrap;
  box-shadow: ${isLight ? '0 6px 18px rgba(245,158,11,0.4)' : 'none'};
}

${channelLogoStyleFor(tone)}
`;

  const itemsHtml = items.map((it, i) => {
    const photo = imgDataUri(it.image);
    return `<div class="rank-row r${it.rank || i + 1}">
      <div class="rank-num">${esc(String(it.rank || i + 1))}</div>
      <div class="rank-photo" style="${photo ? `background-image: url('${photo}')` : `background: linear-gradient(135deg, ${isLight ? '#d8c8a8, #b8a888' : '#2a3560, #0d1220'})`}"></div>
      <div class="rank-name">${esc(it.name || '?')}</div>
      <div class="rank-value">${esc(it.value || '?')}</div>
    </div>`;
  }).join('');

  const thumbBody = `
<div class="bg-gradient"></div>
<div class="title-zone">
  <div class="title-en">Ranking</div>
  <div class="title-jp">${esc(title)}</div>
  <div class="title-bar"></div>
</div>
<div class="rank-list">
  ${itemsHtml}
</div>
${bottomCatch ? `<div class="bottom-catch">${esc(bottomCatch)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail B (${tone}): Ranking`, tone });
}

module.exports = { buildRankingThumb };
