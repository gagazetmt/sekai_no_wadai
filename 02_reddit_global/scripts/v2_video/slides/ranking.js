// scripts/v2_video/slides/ranking.js
// ランキングスライド：得点王・順位表など 1〜5 件の順位比較
//
// データ:
//   mod.type   = 'ranking'
//   mod.title  = 'プレミアリーグ 得点ランキング'
//   mod.subtitle = '2025-26 シーズン 5月時点' (任意)
//   mod.items[] = [
//     { rank: 1, name: 'Erling Haaland', value: '27 ゴール', subtext?: 'Manchester City', logo?: '/path' },
//     ...
//   ]
//
// レイアウト: 縦リスト型、上から rank=1〜N で並べる。1位は金、2位銀、3位銅、4-5位は通常カード。

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, LEAD_PAD_SEC, TAIL_PAD_SEC } = require('./_common');

const MAX_ITEMS = 5;

// 順位別カラー（金/銀/銅 + 4-5位用）
const RANK_STYLE = {
  1: { ring: '#fbbf24', glow: 'rgba(251,191,36,0.45)', numColor: '#fcd34d', medal: '🥇' },
  2: { ring: '#cbd5e1', glow: 'rgba(203,213,225,0.35)', numColor: '#e2e8f0', medal: '🥈' },
  3: { ring: '#fb923c', glow: 'rgba(251,146,60,0.35)', numColor: '#fdba74', medal: '🥉' },
  4: { ring: '#475569', glow: 'rgba(71,85,105,0.25)',  numColor: '#94a3b8', medal: '' },
  5: { ring: '#475569', glow: 'rgba(71,85,105,0.25)',  numColor: '#94a3b8', medal: '' },
};

// item 数に応じてカード高さを動的調整（1080 - title 200 - subtitle 60 - padding 80 = 約 740）
function _layoutForCount(n) {
  if (n === 1) return { cardH: 540, gap: 20, nameSize: 78, valueSize: 64, logoSize: 240 };
  if (n === 2) return { cardH: 330, gap: 24, nameSize: 60, valueSize: 50, logoSize: 170 };
  if (n === 3) return { cardH: 220, gap: 22, nameSize: 52, valueSize: 44, logoSize: 130 };
  if (n === 4) return { cardH: 160, gap: 20, nameSize: 44, valueSize: 38, logoSize: 110 };
  return        { cardH: 130, gap: 18, nameSize: 38, valueSize: 32, logoSize: 92 };  // 5件
}

function buildRankingHTML(mod) {
  const itemsRaw = Array.isArray(mod.items) ? mod.items.slice(0, MAX_ITEMS) : [];
  const items = itemsRaw.map((it, idx) => ({
    rank: Number(it.rank) || (idx + 1),
    name: String(it.name || ''),
    value: String(it.value || ''),
    subtext: String(it.subtext || ''),
    logo: it.logo ? imgDataUri(it.logo) : null,
  })).filter(it => it.name);

  const title = String(mod.title || 'ランキング');
  const subtitle = String(mod.subtitle || '');
  const layout = _layoutForCount(items.length || 3);

  // タイミング: audio durationSec ベース、各 item を順次出す
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audio.length ? (audioSec + LEAD_PAD_SEC + TAIL_PAD_SEC) : 8;

  const startSec = LEAD_PAD_SEC + 0.4;
  const lastSec  = Math.max(totalSec - TAIL_PAD_SEC - 0.5, startSec + 1);
  const step = items.length > 1 ? (lastSec - startSec) / items.length : 0;
  const delays = items.map((_, i) => startSec + step * i);

  const extraStyles = `
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 20% 10%, rgba(251,191,36,0.10), transparent 50%),
    radial-gradient(circle at 80% 90%, rgba(147,197,253,0.08), transparent 50%),
    linear-gradient(135deg, #0a1428 0%, #060e1c 50%, #0d1830 100%);
}
.bg-grid {
  position: absolute; inset: 0;
  background-image:
    linear-gradient(rgba(245,158,11,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(245,158,11,0.04) 1px, transparent 1px);
  background-size: 80px 80px;
  opacity: 0.6;
}
.rank-title {
  position: absolute;
  top: 60px;
  left: 80px;
  right: 80px;
  font-size: 60px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 2px;
  text-shadow: 0 4px 18px rgba(0,0,0,0.8);
  line-height: 1.1;
  z-index: 5;
}
.rank-subtitle {
  position: absolute;
  top: 140px;
  left: 80px;
  font-size: 24px;
  color: ${PALETTE.muted};
  letter-spacing: 1px;
  z-index: 5;
}
.rank-list {
  position: absolute;
  top: ${subtitle ? 200 : 180}px;
  left: 80px;
  right: 80px;
  bottom: 180px;
  display: flex;
  flex-direction: column;
  gap: ${layout.gap}px;
  z-index: 5;
}
.rank-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 28px;
  height: ${layout.cardH}px;
  padding: 0 36px 0 28px;
  background: linear-gradient(95deg, rgba(13,24,48,0.95) 0%, rgba(20,33,62,0.78) 100%);
  border: 2px solid var(--ring-color);
  border-radius: 14px;
  box-shadow: 0 0 24px var(--glow-color), inset 0 0 30px rgba(0,0,0,0.4);
  opacity: 0;
  transform: translateX(-30px);
}
.rank-number {
  font-size: ${Math.round(layout.cardH * 0.55)}px;
  font-weight: 900;
  color: var(--num-color);
  font-family: 'Bebas Neue', 'Oswald', system-ui, sans-serif;
  letter-spacing: -2px;
  min-width: ${Math.round(layout.cardH * 0.6)}px;
  text-align: center;
  line-height: 1;
  text-shadow: 0 4px 12px rgba(0,0,0,0.7);
}
.rank-medal {
  position: absolute;
  top: 6px;
  left: 6px;
  font-size: 42px;
  filter: drop-shadow(0 2px 6px rgba(0,0,0,0.7));
}
.rank-logo {
  width: ${layout.logoSize}px;
  height: ${layout.logoSize}px;
  flex: 0 0 auto;
  border-radius: 8px;
  background: rgba(255,255,255,0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid rgba(255,255,255,0.12);
}
.rank-logo img {
  max-width: 88%;
  max-height: 88%;
  object-fit: contain;
}
.rank-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  min-width: 0;
}
.rank-name {
  font-size: ${layout.nameSize}px;
  font-weight: 800;
  color: ${PALETTE.text};
  line-height: 1.1;
  text-shadow: 0 2px 8px rgba(0,0,0,0.6);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rank-subtext {
  font-size: ${Math.round(layout.nameSize * 0.42)}px;
  color: ${PALETTE.muted};
  letter-spacing: 0.5px;
}
.rank-value {
  flex: 0 0 auto;
  font-size: ${layout.valueSize}px;
  font-weight: 900;
  color: var(--num-color);
  font-family: 'Bebas Neue', 'Oswald', system-ui, sans-serif;
  letter-spacing: 1px;
  text-shadow: 0 2px 10px rgba(0,0,0,0.7);
}
.hl-num {
  color: ${PALETTE.accent};
  font-weight: 900;
}
@keyframes rankCardIn {
  0%   { opacity: 0; transform: translateX(-30px); }
  60%  { opacity: 1; transform: translateX(4px); }
  100% { opacity: 1; transform: translateX(0); }
}
${items.map((_, i) => {
  const sPct = (delays[i] / totalSec * 100).toFixed(3);
  const eDur = 0.6;
  const ePct = ((delays[i] + eDur) / totalSec * 100).toFixed(3);
  return `.rank-card-${i} { animation: rankCardIn ${eDur}s ease-out forwards; animation-delay: ${delays[i].toFixed(3)}s; }`;
}).join('\n')}
`;

  const itemsHtml = items.map((it, i) => {
    const s = RANK_STYLE[it.rank] || RANK_STYLE[5];
    const valueHtml = it.value.replace(
      /([\d０-９]+(?:[\.,．，][\d０-９]+)?)/g,
      '<span class="hl-num">$1</span>'
    );
    return `<div class="rank-card rank-card-${i}" style="--ring-color: ${s.ring}; --glow-color: ${s.glow}; --num-color: ${s.numColor};">
      ${s.medal ? `<div class="rank-medal">${s.medal}</div>` : ''}
      <div class="rank-number">${it.rank}</div>
      ${it.logo ? `<div class="rank-logo"><img src="${it.logo}" alt=""></div>` : ''}
      <div class="rank-body">
        <div class="rank-name">${esc(it.name)}</div>
        ${it.subtext ? `<div class="rank-subtext">${esc(it.subtext)}</div>` : ''}
      </div>
      ${it.value ? `<div class="rank-value">${valueHtml}</div>` : ''}
    </div>`;
  }).join('');

  const slideBody = `
<div class="bg-base"></div>
<div class="bg-grid"></div>
<div class="rank-title">${esc(title)}</div>
${subtitle ? `<div class="rank-subtitle">${esc(subtitle)}</div>` : ''}
<div class="rank-list">${itemsHtml}</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildRankingHTML };
