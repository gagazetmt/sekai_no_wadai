// scripts/v2_thumb/templates/ranking.js
// サムネ テンプレ B: ランキング型（表彰台レイアウト・強化版）
//   - #1 を中央上に巨大配置（顔大きく・名前大きく・冠アイコン）
//   - #2 と #3 を下に左右配置（やや小さく）
//   - 全体に "Ranking" の章感
//   - tone: 'dark' | 'light'

const {
  PALETTE, tonePalette, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

const RANK_COLORS = ['#fcd34d', '#cbd5e1', '#d97706'];

// 王冠SVG
const SVG_CROWN = '<svg width="60" height="40" viewBox="0 0 60 40" fill="currentColor"><path d="M5 32 L8 14 L18 22 L30 6 L42 22 L52 14 L55 32 Z" stroke="rgba(255,255,255,0.3)" stroke-width="0.8"/><circle cx="8" cy="11" r="2.5"/><circle cx="30" cy="3" r="2.5"/><circle cx="52" cy="11" r="2.5"/></svg>';

function buildRankingThumb(data = {}) {
  const tone = data.tone || 'dark';
  const isLight = tone === 'light';
  const p = tonePalette(tone);
  const title = data.title || 'TOPランキング';
  const items = (data.items || []).slice(0, 3);
  const bottomCatch = data.bottomCatch || '';
  const channelName = data.channelName || CHANNEL_NAME;

  while (items.length < 3) items.push({ rank: items.length + 1, name: '?', value: '?' });

  const item1 = items[0];
  const item2 = items[1];
  const item3 = items[2];

  const photo1 = imgDataUri(item1.image);
  const photo2 = imgDataUri(item2.image);
  const photo3 = imgDataUri(item3.image);

  const titleShadow = isLight
    ? `0 2px 8px rgba(0,0,0,0.10)`
    : `0 0 10px rgba(255,255,255,0.4), 0 0 22px rgba(245,158,11,0.4), 0 4px 18px rgba(0,0,0,0.9)`;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background: ${isLight
    ? `radial-gradient(ellipse at 50% 30%, rgba(252,211,77,0.20) 0%, transparent 60%),
       linear-gradient(180deg, #fefaf2 0%, #f0e8d8 100%)`
    : `radial-gradient(ellipse at 50% 30%, rgba(252,211,77,0.20) 0%, transparent 60%),
       linear-gradient(180deg, #1a2240 0%, #060a14 100%)`};
}

/* ── タイトル（上部）── */
.title-zone {
  position: absolute;
  top: 18px; left: 50%;
  transform: translateX(-50%);
  text-align: center;
  z-index: 5;
}
.title-en {
  font-family: 'Georgia', serif;
  font-size: 16px;
  letter-spacing: 8px;
  color: ${p.accent};
  text-transform: uppercase;
  margin-bottom: 4px;
}
.title-jp {
  font-size: 38px;
  font-weight: 900;
  color: ${p.text};
  letter-spacing: 3px;
  ${isLight ? '' : '-webkit-text-stroke: 1px rgba(255,255,255,0.1);'}
  text-shadow: ${titleShadow};
  white-space: nowrap;
}

/* ── #1 巨大ゾーン（中央上）── */
.podium-1 {
  position: absolute;
  top: 100px; left: 50%;
  transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 6;
}
.crown {
  color: ${RANK_COLORS[0]};
  filter: drop-shadow(0 0 12px rgba(252,211,77,0.7));
  margin-bottom: 4px;
}
.podium-1 .photo {
  width: 220px; height: 220px;
  border-radius: 50%;
  background-size: cover;
  background-position: center 22%;
  border: 6px solid ${RANK_COLORS[0]};
  box-shadow:
    0 0 36px rgba(252,211,77,0.7),
    0 0 80px rgba(252,211,77,0.35),
    0 8px 24px rgba(0,0,0,0.5);
  margin-bottom: 12px;
}
.podium-1 .rank-num {
  position: absolute;
  top: 30px; right: -28px;
  font-family: 'Georgia', serif;
  font-size: 92px;
  font-weight: 900;
  font-style: italic;
  color: ${RANK_COLORS[0]};
  text-shadow: 0 0 24px rgba(252,211,77,0.8), 0 4px 12px rgba(0,0,0,0.8);
  line-height: 1;
}
.podium-1 .name {
  font-size: 38px;
  font-weight: 900;
  color: ${p.text};
  letter-spacing: 1px;
  ${isLight ? '' : '-webkit-text-stroke: 1.5px rgba(255,255,255,0.15);'}
  text-shadow: ${isLight ? '0 2px 8px rgba(0,0,0,0.10)' : '0 4px 14px rgba(0,0,0,0.9)'};
  white-space: nowrap;
}
.podium-1 .value {
  font-family: 'Georgia', serif;
  font-style: italic;
  font-size: 36px;
  font-weight: 900;
  color: ${p.accent};
  letter-spacing: -1px;
  text-shadow: ${isLight ? 'none' : '0 0 14px rgba(245,158,11,0.5)'};
  margin-top: 4px;
}

/* ── #2 #3 ゾーン（下部左右）── */
.podium-bottom {
  position: absolute;
  bottom: 90px; left: 0; right: 0;
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 50px;
  padding: 0 60px;
  z-index: 5;
}
.podium-side {
  display: flex; align-items: center; gap: 18px;
  background: ${isLight ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.55)'};
  padding: 14px 22px;
  border-radius: 14px;
  border: 2px solid;
  backdrop-filter: blur(4px);
  box-shadow: ${isLight ? '0 4px 16px rgba(0,0,0,0.10)' : '0 4px 18px rgba(0,0,0,0.5)'};
}
.podium-side.r2 { border-color: ${RANK_COLORS[1]}; }
.podium-side.r3 { border-color: ${RANK_COLORS[2]}; }
.podium-side .rank-num {
  font-family: 'Georgia', serif;
  font-size: 64px;
  font-weight: 900;
  font-style: italic;
  letter-spacing: -2px;
  line-height: 1;
}
.podium-side.r2 .rank-num { color: ${isLight ? '#6b7280' : RANK_COLORS[1]}; text-shadow: 0 0 12px rgba(203,213,225,0.5); }
.podium-side.r3 .rank-num { color: ${RANK_COLORS[2]}; text-shadow: 0 0 12px rgba(217,119,6,0.5); }
.podium-side .photo {
  width: 80px; height: 80px;
  border-radius: 50%;
  background-size: cover;
  background-position: center 22%;
  flex-shrink: 0;
}
.podium-side.r2 .photo { border: 3px solid ${RANK_COLORS[1]}; box-shadow: 0 0 16px rgba(203,213,225,0.5); }
.podium-side.r3 .photo { border: 3px solid ${RANK_COLORS[2]}; box-shadow: 0 0 16px rgba(217,119,6,0.5); }
.podium-side .info {
  flex: 1; min-width: 0;
}
.podium-side .name {
  font-size: 22px;
  font-weight: 900;
  color: ${p.text};
  line-height: 1.2;
  margin-bottom: 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.podium-side .value {
  font-family: 'Georgia', serif;
  font-style: italic;
  font-size: 22px;
  font-weight: 900;
  color: ${p.accent};
  letter-spacing: -0.5px;
}

/* ── 下部キャッチ ── */
.bottom-catch {
  position: absolute;
  bottom: 24px; left: 50%;
  transform: translateX(-50%);
  font-size: 22px;
  font-weight: 900;
  color: #000;
  background: ${p.accent};
  padding: 8px 24px;
  border-radius: 6px;
  letter-spacing: 1.5px;
  z-index: 7;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgba(245,158,11,0.5);
}

${channelLogoStyleFor(tone)}
.channel-logo { left: 24px; bottom: 24px; z-index: 9; }
`;

  const thumbBody = `
<div class="bg-gradient"></div>
<div class="title-zone">
  <div class="title-en">Ranking · Top 3</div>
  <div class="title-jp">${esc(title)}</div>
</div>
<div class="podium-1">
  <div class="crown">${SVG_CROWN}</div>
  <div style="position:relative;">
    <div class="photo" style="${photo1 ? `background-image: url('${photo1}')` : `background: linear-gradient(135deg, ${isLight ? '#fcd34d, #f59e0b' : '#92400e, #422006'})`}"></div>
    <div class="rank-num">1</div>
  </div>
  <div class="name">${esc(item1.name || '?')}</div>
  <div class="value">${esc(item1.value || '?')}</div>
</div>
<div class="podium-bottom">
  <div class="podium-side r2">
    <div class="rank-num">2</div>
    <div class="photo" style="${photo2 ? `background-image: url('${photo2}')` : `background: linear-gradient(135deg, ${isLight ? '#cbd5e1, #94a3b8' : '#475569, #1e293b'})`}"></div>
    <div class="info">
      <div class="name">${esc(item2.name || '?')}</div>
      <div class="value">${esc(item2.value || '?')}</div>
    </div>
  </div>
  <div class="podium-side r3">
    <div class="rank-num">3</div>
    <div class="photo" style="${photo3 ? `background-image: url('${photo3}')` : `background: linear-gradient(135deg, ${isLight ? '#d97706, #b45309' : '#92400e, #422006'})`}"></div>
    <div class="info">
      <div class="name">${esc(item3.name || '?')}</div>
      <div class="value">${esc(item3.value || '?')}</div>
    </div>
  </div>
</div>
${bottomCatch ? `<div class="bottom-catch">${esc(bottomCatch)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail B (${tone}): Podium Ranking`, tone });
}

module.exports = { buildRankingThumb };
