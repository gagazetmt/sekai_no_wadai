// scripts/v2_video/slides/toc.js
// 目次スライド：書籍 / 雑誌風の Contents レイアウト
//   - 大きな serif 連番 (01 / 02 / 03)
//   - 連番と項目タイトルの間にドットリーダー（点線）
//   - 中央にゴールド縦線で章を区切る
//   - 上部に「CONTENTS」/「目次」のバイリンガル見出し
//   - 各行が左から右へスライドイン

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod } = require('./_common');

const MAX_ITEMS = 7;

// 項目数で行高 / フォント / 番号フォントを動的調整
function _layoutForCount(n) {
  if (n <= 3) return { rowH: 130, titleFz: 60, numFz: 110 };
  if (n <= 4) return { rowH: 110, titleFz: 50, numFz: 92 };
  if (n === 5) return { rowH: 96, titleFz: 44, numFz: 80 };
  if (n === 6) return { rowH: 84, titleFz: 38, numFz: 70 };
  return        { rowH: 72, titleFz: 32, numFz: 60 };  // 7件
}

function _itemFontSize(text, baseFz) {
  const len = String(text || '').length;
  if (len <= 12) return baseFz;
  if (len <= 18) return Math.max(baseFz - 6, 26);
  return Math.max(baseFz - 12, 24);
}

function buildTocHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  let items = [];
  if (Array.isArray(mod.tocItems) && mod.tocItems.length) {
    items = mod.tocItems.slice(0, MAX_ITEMS);
  } else if (Array.isArray(mod.catchphrases) && mod.catchphrases.length) {
    items = mod.catchphrases.slice(0, MAX_ITEMS);
  } else if (Array.isArray(mod.dataSlots) && mod.dataSlots.length) {
    items = mod.dataSlots.slice(0, MAX_ITEMS).map(s => s.label || s.value || '');
  }
  items = items.map(s => String(s || '').trim()).filter(Boolean);

  const tocTitle = mod.title || '今日のラインナップ';
  const layout = _layoutForCount(items.length);

  // 各項目の登場 delay
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const chunkStarts = audio.map((_, i) =>
    audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));

  const startSec = 0.9;
  const interval = 0.4;
  const delays = items.map((_, i) =>
    audio.length === items.length
      ? chunkStarts[i] + 0.3
      : startSec + interval * i
  );

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: radial-gradient(ellipse at 30% 40%, #1a2240 0%, #0a0e1a 70%);`}
  background-size: cover; background-position: center;
  ${bg ? 'animation: bgZoom 14s ease-out forwards;' : ''}
  filter: ${bg ? 'brightness(0.45)' : 'none'};
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.06); } }
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to bottom,
    rgba(8, 12, 24, 0.55) 0%,
    rgba(8, 12, 24, 0.85) 100%);
}

/* ─── ヘッダー（CONTENTS / 目次）─── */
.toc-header {
  position: absolute;
  top: 60px; left: 80px; right: 80px;
  z-index: 5;
  display: flex; align-items: baseline; gap: 24px;
  border-bottom: 3px solid ${PALETTE.accent};
  padding-bottom: 20px;
  opacity: 0;
  animation: headerFade 0.6s 0.1s forwards;
}
@keyframes headerFade { to { opacity: 1; } }
.toc-header-en {
  font-family: 'Times New Roman', 'Georgia', serif;
  font-size: 28px;
  font-weight: 400;
  letter-spacing: 8px;
  color: ${PALETTE.accent};
  text-transform: uppercase;
}
.toc-header-jp {
  font-size: 42px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 4px;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.7);
}
.toc-header-sub {
  margin-left: auto;
  font-family: 'Times New Roman', 'Georgia', serif;
  font-size: 16px;
  color: ${PALETTE.muted};
  letter-spacing: 2px;
  font-style: italic;
}

/* ─── リスト ─── */
.toc-list {
  position: absolute;
  top: 200px; left: 80px; right: 80px; bottom: 180px;
  display: flex; flex-direction: column;
  justify-content: center;
  gap: 8px;
  z-index: 5;
}

/* 各行：番号 → ドットリーダー → タイトル の3カラム */
.toc-row {
  display: grid;
  grid-template-columns: ${Math.round(layout.numFz * 1.5)}px 1fr auto;
  align-items: center;
  gap: 24px;
  min-height: ${layout.rowH}px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  opacity: 0;
  transform: translateX(-40px);
  animation: rowSlideIn 0.55s cubic-bezier(0.25, 1, 0.5, 1) forwards;
}
@keyframes rowSlideIn {
  from { opacity: 0; transform: translateX(-40px); }
  to   { opacity: 1; transform: translateX(0); }
}
.toc-row:last-child { border-bottom: none; }

/* 章番号（書籍風 serif の大きい数字）*/
.toc-num {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: ${layout.numFz}px;
  font-weight: 700;
  font-style: italic;
  color: ${PALETTE.accent};
  text-shadow: 0 0 18px rgba(245, 158, 11, 0.45);
  line-height: 1;
  text-align: right;
  letter-spacing: -3px;
}
.toc-num-prefix {
  display: block;
  font-family: 'Georgia', serif;
  font-size: 12px;
  font-weight: 400;
  font-style: normal;
  letter-spacing: 4px;
  color: rgba(245, 158, 11, 0.65);
  margin-bottom: 2px;
  text-transform: uppercase;
}

/* タイトル（やや太め、シンプル）*/
.toc-title {
  font-weight: 700;
  color: ${PALETTE.text};
  line-height: 1.25;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
  letter-spacing: 1px;
  position: relative;
  padding-left: 28px;
}
/* タイトル左にチャプターマーク */
.toc-title::before {
  content: '';
  position: absolute;
  left: 0; top: 50%;
  width: 14px; height: 4px;
  background: ${PALETTE.accent};
  transform: translateY(-50%);
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.6);
}

/* 右端の章番号バッジ（小さい "Ch.X"）*/
.toc-badge {
  font-family: 'Georgia', serif;
  font-size: 13px;
  font-style: italic;
  color: ${PALETTE.muted};
  letter-spacing: 1px;
  padding-left: 16px;
  border-left: 1px solid rgba(255, 255, 255, 0.15);
}
`;

  const itemsHtml = items.map((it, i) => {
    const fz = _itemFontSize(it, layout.titleFz);
    const d  = delays[i].toFixed(2);
    const numStr = String(i + 1).padStart(2, '0');
    return `<div class="toc-row" style="animation-delay:${d}s;">`
      + `<div class="toc-num"><span class="toc-num-prefix">No.</span>${numStr}</div>`
      + `<div class="toc-title" style="font-size:${fz}px;">${esc(it)}</div>`
      + `<div class="toc-badge">Chapter ${i + 1}</div>`
      + `</div>`;
  }).join('');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="toc-header">
  <span class="toc-header-en">Contents</span>
  <span class="toc-header-jp">${esc(tocTitle)}</span>
  <span class="toc-header-sub">${items.length} chapters</span>
</div>
<div class="toc-list">
  ${itemsHtml}
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildTocHTML };
