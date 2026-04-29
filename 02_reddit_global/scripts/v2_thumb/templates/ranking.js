// scripts/v2_thumb/templates/ranking.js
// サムネ テンプレ B: ランキング型
//   - 中央上部にタイトル「マンU歴代得点TOP3」
//   - 縦並びで #1 #2 #3 の選手 + 数字
//   - 各選手の顔写真（円形 or 切り抜き）
//
// 入力:
//   {
//     title: 'マンU 歴代得点TOP3',
//     items: [
//       { rank: 1, name: 'ロナウド', value: '145ゴール', image: '...' },
//       { rank: 2, name: 'ルーニー', value: '253ゴール', image: '...' },
//       { rank: 3, name: 'チャールトン', value: '249ゴール', image: '...' },
//     ],
//     bottomCatch: 'あなたの予想は当たってる？',
//   }

const { PALETTE, esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyle, CHANNEL_NAME } = require('../_common');

const RANK_COLORS = ['#fcd34d', '#cbd5e1', '#d97706'];  // 金・銀・銅

function buildRankingThumb(data = {}) {
  const title = data.title || 'TOPランキング';
  const items = (data.items || []).slice(0, 3);
  const bottomCatch = data.bottomCatch || '';
  const channelName = data.channelName || CHANNEL_NAME;

  // 3項目に満たない場合は埋め
  while (items.length < 3) items.push({ rank: items.length + 1, name: '?', value: '?' });

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(245,158,11,0.15) 0%, transparent 60%),
    linear-gradient(180deg, #1a2240 0%, #060a14 100%);
}

/* ── 上部タイトル（書籍風）── */
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
  color: ${PALETTE.accent};
  text-transform: uppercase;
  margin-bottom: 4px;
}
.title-jp {
  font-size: 60px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 4px;
  -webkit-text-stroke: 2px rgba(255,255,255,0.1);
  text-shadow:
    0 0 10px rgba(255,255,255,0.4),
    0 0 22px rgba(245,158,11,0.4),
    0 4px 18px rgba(0,0,0,0.9);
  white-space: nowrap;
}
.title-bar {
  width: 250px; height: 4px;
  background: linear-gradient(90deg, transparent, ${PALETTE.accent}, transparent);
  margin: 8px auto 0;
}

/* ── 3行ランキング ── */
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
  background: linear-gradient(90deg, rgba(245,158,11,0.12) 0%, rgba(6,14,28,0.4) 70%);
  border-left: 6px solid ${PALETTE.accent};
  border-radius: 0 12px 12px 0;
  height: 116px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.5);
}
.rank-row.r1 {
  background: linear-gradient(90deg, rgba(252,211,77,0.18) 0%, rgba(6,14,28,0.4) 70%);
  border-left-color: ${RANK_COLORS[0]};
  height: 132px;
}
.rank-row.r2 {
  background: linear-gradient(90deg, rgba(203,213,225,0.10) 0%, rgba(6,14,28,0.4) 70%);
  border-left-color: ${RANK_COLORS[1]};
}
.rank-row.r3 {
  background: linear-gradient(90deg, rgba(217,119,6,0.10) 0%, rgba(6,14,28,0.4) 70%);
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
.rank-row.r1 .rank-num { color: ${RANK_COLORS[0]}; text-shadow: 0 0 18px rgba(252,211,77,0.6); font-size: 100px; }
.rank-row.r2 .rank-num { color: ${RANK_COLORS[1]}; text-shadow: 0 0 14px rgba(203,213,225,0.5); }
.rank-row.r3 .rank-num { color: ${RANK_COLORS[2]}; text-shadow: 0 0 14px rgba(217,119,6,0.5); }
.rank-photo {
  width: 90px; height: 90px;
  border-radius: 50%;
  background-size: cover;
  background-position: center;
  border: 3px solid ${PALETTE.accent};
  box-shadow: 0 0 18px rgba(245,158,11,0.4);
}
.rank-row.r1 .rank-photo { border-color: ${RANK_COLORS[0]}; box-shadow: 0 0 22px rgba(252,211,77,0.5); width: 100px; height: 100px; }
.rank-name {
  font-size: 36px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 1px;
  line-height: 1.1;
  text-shadow: 0 2px 8px rgba(0,0,0,0.7);
}
.rank-row.r1 .rank-name { font-size: 42px; }
.rank-value {
  font-size: 30px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 1px;
  text-shadow: 0 0 12px rgba(245,158,11,0.5);
  font-family: 'Georgia', serif;
  font-style: italic;
  white-space: nowrap;
}
.rank-row.r1 .rank-value { font-size: 36px; }

/* ── 下部キャッチ ── */
.bottom-catch {
  position: absolute;
  bottom: 90px; left: 50%;
  transform: translateX(-50%);
  font-size: 28px;
  font-weight: 900;
  color: ${PALETTE.text};
  background: rgba(0, 0, 0, 0.65);
  border: 2px solid rgba(245, 158, 11, 0.5);
  padding: 10px 30px;
  border-radius: 8px;
  letter-spacing: 1.5px;
  z-index: 6;
  white-space: nowrap;
}

${channelLogoStyle}
`;

  const itemsHtml = items.map((it, i) => {
    const photo = imgDataUri(it.image);
    return `<div class="rank-row r${it.rank || i + 1}">
      <div class="rank-num">${esc(String(it.rank || i + 1))}</div>
      <div class="rank-photo" style="${photo ? `background-image: url('${photo}')` : `background: linear-gradient(135deg, #2a3560, #0d1220)`}"></div>
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

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail B: Ranking' });
}

module.exports = { buildRankingThumb };
