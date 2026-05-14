// scripts/v2_video/slides/timeline.js
// 時系列チャートスライド：折れ線グラフ（クラブ順位推移・市場価値推移など）
//
// データ:
//   mod.type   = 'timeline'
//   mod.title  = '市場価値推移'
//   mod.subtitle = '2022-26 / 単位: €M' (任意)
//   mod.xLabel = 'Season' (任意)
//   mod.yLabel = '€M' (任意)
//   mod.yMin / mod.yMax = 軸範囲固定（省略可、データから自動算出）
//   mod.invertY = true なら y 軸反転（順位用、1 が上）
//   mod.series[] = [
//     {
//       name: 'Bellingham',
//       color: '#fcd34d',      (任意、未指定なら自動アサイン)
//       points: [
//         { x: '22/23', y: 80 },
//         { x: '23/24', y: 120 },
//         ...
//       ]
//     },
//     ...
//   ]

const { PALETTE, esc, wrapHTML, buildSubtitleBar, subtitleArgFromMod, LEAD_PAD_SEC, TAIL_PAD_SEC } = require('./_common');

const MAX_SERIES = 4;

// シリーズに自動アサインする色（指定なし時）
const SERIES_COLORS = ['#fcd34d', '#7dd3fc', '#fca5a5', '#86efac'];

// SVG ビューポート（1920x1080 内のチャート領域）
const CHART = {
  x:      120,
  y:      230,
  width:  1680,
  height: 620,
};
const PADDING = { top: 30, right: 80, bottom: 70, left: 120 };

function _niceRange(min, max) {
  // Y 軸の min/max を「キリの良い数字」に丸める
  if (min === max) { min -= 1; max += 1; }
  const span = max - min;
  const step = Math.pow(10, Math.floor(Math.log10(span)));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  return [niceMin, niceMax];
}

function buildTimelineHTML(mod) {
  const seriesRaw = Array.isArray(mod.series) ? mod.series.slice(0, MAX_SERIES) : [];
  const series = seriesRaw.map((s, idx) => ({
    name: String(s.name || `series${idx+1}`),
    color: s.color || SERIES_COLORS[idx % SERIES_COLORS.length],
    points: Array.isArray(s.points)
      ? s.points.filter(p => p && p.y != null).map(p => ({ x: String(p.x ?? ''), y: Number(p.y) }))
      : [],
  })).filter(s => s.points.length >= 2);

  const title = String(mod.title || 'Timeline');
  const subtitle = String(mod.subtitle || '');
  const xLabel = String(mod.xLabel || '');
  const yLabel = String(mod.yLabel || '');
  const invertY = !!mod.invertY;

  // 全 series の x 軸ラベルを統合（順序維持・重複除外）
  const xLabelsSet = new Set();
  const xLabels = [];
  for (const s of series) {
    for (const p of s.points) {
      if (!xLabelsSet.has(p.x)) { xLabelsSet.add(p.x); xLabels.push(p.x); }
    }
  }
  const nX = xLabels.length;

  // Y 軸範囲決定
  let yMin = mod.yMin, yMax = mod.yMax;
  if (yMin == null || yMax == null) {
    let allY = series.flatMap(s => s.points.map(p => p.y));
    if (!allY.length) allY = [0, 1];
    const minRaw = Math.min(...allY);
    const maxRaw = Math.max(...allY);
    [yMin, yMax] = _niceRange(minRaw, maxRaw);
  }

  // チャート内部領域
  const innerX = PADDING.left;
  const innerY = PADDING.top;
  const innerW = CHART.width  - PADDING.left - PADDING.right;
  const innerH = CHART.height - PADDING.top  - PADDING.bottom;

  // x 値（ラベル index）→ SVG x 座標
  function xCoord(labelIdx) {
    if (nX <= 1) return innerX + innerW / 2;
    return innerX + (labelIdx / (nX - 1)) * innerW;
  }
  // y 値 → SVG y 座標
  function yCoord(yVal) {
    const ratio = (yVal - yMin) / (yMax - yMin || 1);
    return invertY
      ? innerY + ratio * innerH
      : innerY + (1 - ratio) * innerH;
  }

  // タイミング: audio durationSec ベース、線描画は線形に進む
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audio.length ? (audioSec + LEAD_PAD_SEC + TAIL_PAD_SEC) : 8;
  const drawStartSec = LEAD_PAD_SEC + 0.3;
  const drawDurSec = Math.max(2, totalSec - LEAD_PAD_SEC - TAIL_PAD_SEC - 1);

  // 各 series の path d 文字列を作成
  const pathsHtml = series.map((s, sIdx) => {
    const segs = s.points.map(p => {
      const idx = xLabels.indexOf(p.x);
      return idx < 0 ? null : { x: xCoord(idx), y: yCoord(p.y), val: p.y };
    }).filter(Boolean);
    if (segs.length < 2) return '';
    const d = segs.map((pt, i) => (i === 0 ? `M${pt.x},${pt.y}` : `L${pt.x},${pt.y}`)).join(' ');
    // path の長さ（dasharray アニメ用）はだいたいの推定
    const totalLen = segs.reduce((sum, pt, i) =>
      i === 0 ? 0 : sum + Math.hypot(pt.x - segs[i-1].x, pt.y - segs[i-1].y), 0);
    return `
      <path class="series-path series-path-${sIdx}" d="${d}"
            fill="none" stroke="${s.color}" stroke-width="5"
            stroke-linecap="round" stroke-linejoin="round"
            style="stroke-dasharray: ${totalLen.toFixed(1)}; stroke-dashoffset: ${totalLen.toFixed(1)};"/>
      ${segs.map((pt, i) => `
        <circle class="series-dot series-dot-${sIdx}" cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="8"
                fill="${s.color}" stroke="${PALETTE.bg}" stroke-width="3"
                style="opacity: 0;"/>
        <text class="series-val series-val-${sIdx}" x="${pt.x.toFixed(1)}" y="${(pt.y - 18).toFixed(1)}"
              text-anchor="middle" fill="${s.color}" font-size="22" font-weight="800"
              style="opacity: 0;">${esc(String(pt.val))}</text>
      `).join('')}
    `;
  }).join('');

  // 凡例
  const legendHtml = series.map(s => `
    <span class="legend-item">
      <span class="legend-swatch" style="background: ${s.color}"></span>
      <span class="legend-name">${esc(s.name)}</span>
    </span>
  `).join('');

  // x 軸ラベル
  const xAxisHtml = xLabels.map((lbl, i) => `
    <text x="${xCoord(i).toFixed(1)}" y="${(innerY + innerH + 32).toFixed(1)}"
          text-anchor="middle" fill="${PALETTE.muted}" font-size="22" font-weight="600">${esc(lbl)}</text>
  `).join('');

  // y 軸 5 グリッド
  const yTicks = 5;
  const gridHtml = Array.from({ length: yTicks + 1 }, (_, i) => {
    const ratio = i / yTicks;
    const yVal = yMin + (yMax - yMin) * (invertY ? ratio : (1 - ratio));
    const yPx = innerY + ratio * innerH;
    return `
      <line x1="${innerX}" x2="${innerX + innerW}" y1="${yPx.toFixed(1)}" y2="${yPx.toFixed(1)}"
            stroke="rgba(148,163,184,0.18)" stroke-width="1"/>
      <text x="${(innerX - 16).toFixed(1)}" y="${(yPx + 7).toFixed(1)}"
            text-anchor="end" fill="${PALETTE.muted}" font-size="22" font-weight="600">${esc(String(Math.round(yVal)))}</text>
    `;
  }).join('');

  // 軸線
  const axisHtml = `
    <line x1="${innerX}" x2="${innerX + innerW}" y1="${innerY + innerH}" y2="${innerY + innerH}"
          stroke="${PALETTE.muted}" stroke-width="2" opacity="0.5"/>
    <line x1="${innerX}" x2="${innerX}" y1="${innerY}" y2="${innerY + innerH}"
          stroke="${PALETTE.muted}" stroke-width="2" opacity="0.5"/>
  `;

  const extraStyles = `
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 30% 20%, rgba(125,211,252,0.10), transparent 50%),
    radial-gradient(circle at 70% 80%, rgba(252,165,165,0.08), transparent 50%),
    linear-gradient(135deg, #0a1428 0%, #060e1c 50%, #0d1830 100%);
}
.tl-title {
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
.tl-subtitle {
  position: absolute;
  top: 140px;
  left: 80px;
  font-size: 24px;
  color: ${PALETTE.muted};
  letter-spacing: 1px;
  z-index: 5;
}
.tl-legend {
  position: absolute;
  top: 80px;
  right: 80px;
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 800px;
  z-index: 5;
}
.legend-item { display: inline-flex; align-items: center; gap: 8px; }
.legend-swatch { width: 24px; height: 8px; border-radius: 2px; }
.legend-name { color: ${PALETTE.text}; font-size: 22px; font-weight: 700; }
.tl-chart {
  position: absolute;
  top: 230px;
  left: 0;
  right: 0;
  z-index: 5;
}
.tl-ylabel {
  position: absolute;
  top: 250px;
  left: 24px;
  font-size: 20px;
  color: ${PALETTE.muted};
  writing-mode: vertical-rl;
  letter-spacing: 1px;
  z-index: 5;
}
.tl-xlabel {
  position: absolute;
  bottom: 220px;
  right: 80px;
  font-size: 20px;
  color: ${PALETTE.muted};
  letter-spacing: 1px;
  z-index: 5;
}
@keyframes drawLine {
  to { stroke-dashoffset: 0; }
}
@keyframes popIn {
  0%   { opacity: 0; transform: scale(0.5); }
  60%  { opacity: 1; transform: scale(1.15); }
  100% { opacity: 1; transform: scale(1); }
}
${series.map((_, sIdx) => `
.series-path-${sIdx} {
  animation: drawLine ${drawDurSec.toFixed(2)}s ease-in-out forwards;
  animation-delay: ${drawStartSec.toFixed(2)}s;
}
.series-dot-${sIdx}, .series-val-${sIdx} {
  animation: popIn 0.4s ease-out forwards;
  animation-delay: ${(drawStartSec + drawDurSec * 0.8).toFixed(2)}s;
  transform-origin: center;
}
`).join('\n')}
`;

  const slideBody = `
<div class="bg-base"></div>
<div class="tl-title">${esc(title)}</div>
${subtitle ? `<div class="tl-subtitle">${esc(subtitle)}</div>` : ''}
${yLabel ? `<div class="tl-ylabel">${esc(yLabel)}</div>` : ''}
${xLabel ? `<div class="tl-xlabel">${esc(xLabel)}</div>` : ''}
${series.length ? `<div class="tl-legend">${legendHtml}</div>` : ''}
<svg class="tl-chart" viewBox="0 0 ${CHART.width} ${CHART.height}" preserveAspectRatio="none"
     style="width: ${CHART.width}px; height: ${CHART.height}px; left: ${CHART.x - PADDING.left/2}px;">
  ${gridHtml}
  ${axisHtml}
  ${pathsHtml}
  ${xAxisHtml}
</svg>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildTimelineHTML };
