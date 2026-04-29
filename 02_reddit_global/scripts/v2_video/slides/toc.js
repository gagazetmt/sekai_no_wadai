// scripts/v2_video/slides/toc.js
// 目次スライド：オープニング直後に挿入し、本日の構成を視聴者に提示
//   章タイトルが上から順に降ってきて、番号付きで縦並び表示
//   テンプレ元: insight.js の構造を流用しつつ「項目降下」演出に特化

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod } = require('./_common');

const MAX_ITEMS = 7;

// 項目数で min-height / gap / 最大フォントを動的調整（container 高 720px 想定）
function _layoutForCount(n) {
  if (n <= 3) return { minHeight: 110, gap: 24, maxFont: 56 };
  if (n <= 5) return { minHeight: 92,  gap: 20, maxFont: 48 };
  if (n === 6) return { minHeight: 80, gap: 16, maxFont: 42 };
  return        { minHeight: 70, gap: 14, maxFont: 38 };  // 7件
}

// 項目文字列の長さに応じてフォントサイズ縮小
function _itemFontSize(text, layout) {
  const len = String(text || '').length;
  const max = layout.maxFont;
  if (len <= 14) return max;
  if (len <= 20) return Math.max(max - 6,  30);
  if (len <= 26) return Math.max(max - 12, 28);
  return Math.max(max - 16, 26);
}

function buildTocHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  // tocItems が優先。catchphrases や dataSlots を fallback にも対応
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

  // 各項目の登場 delay（順番に降ってくる）
  //   音声 chunks があれば chunk 開始時刻に同期、無ければ均等 0.4s 間隔
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const totalSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 5;
  const chunkStarts = audio.map((_, i) =>
    audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));

  const startSec = 0.6;  // タイトル降下後に開始
  const interval = 0.45; // 通常 0.45s 間隔
  const delays = items.map((_, i) =>
    audio.length === items.length
      ? chunkStarts[i] + 0.3
      : startSec + interval * i
  );

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(135deg, #1a1f3a 0%, #0d1220 100%);`}
  background-size: cover; background-position: center;
  ${bg ? 'animation: bgZoom 14s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.08); } }
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    rgba(6, 14, 28, 0.92) 0%,
    rgba(6, 14, 28, 0.85) 50%,
    rgba(6, 14, 28, 0.75) 100%);
}
.toc-title {
  position: absolute;
  top: 70px; left: 80px; right: 80px;
  font-size: 56px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 3px;
  text-shadow: 0 2px 18px rgba(0, 0, 0, 0.9), 0 0 24px rgba(245, 158, 11, 0.4);
  z-index: 5;
  opacity: 0;
  transform: translateY(-30px);
  animation: titleDrop 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s forwards;
}
@keyframes titleDrop {
  from { opacity: 0; transform: translateY(-30px); }
  to   { opacity: 1; transform: translateY(0); }
}
.toc-title-bar {
  position: absolute;
  top: 150px; left: 80px;
  width: 120px; height: 5px;
  background: linear-gradient(to right, ${PALETTE.accent}, transparent);
  z-index: 5;
  opacity: 0;
  animation: barFade 0.5s 0.6s forwards;
}
@keyframes barFade { to { opacity: 1; } }

.toc-list {
  position: absolute;
  top: 200px; left: 80px; right: 80px; bottom: 180px;
  display: flex; flex-direction: column;
  justify-content: center;
  gap: ${layout.gap}px;
  z-index: 5;
}
/* 各項目：上から降ってきて反発し定位置へ */
.toc-item {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: ${layout.minHeight}px;
  padding: 14px 30px;
  background: linear-gradient(to right,
    rgba(245, 158, 11, 0.18) 0%,
    rgba(6, 14, 28, 0.55) 60%,
    rgba(6, 14, 28, 0.35) 100%);
  border-left: 8px solid ${PALETTE.accent};
  border-radius: 0 14px 14px 0;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.45);
  opacity: 0;
  transform: translateY(-60px);
  animation: itemDrop 0.6s cubic-bezier(0.34, 1.4, 0.64, 1) forwards;
}
@keyframes itemDrop {
  0%   { opacity: 0; transform: translateY(-60px); }
  60%  { opacity: 1; transform: translateY(8px); }
  100% { opacity: 1; transform: translateY(0); }
}
.toc-num {
  font-size: ${Math.max(layout.maxFont - 8, 28)}px;
  font-weight: 900;
  color: ${PALETTE.accent};
  text-shadow: 0 0 14px rgba(245, 158, 11, 0.6);
  min-width: 50px;
  letter-spacing: -2px;
}
.toc-text {
  flex: 1;
  font-weight: 800;
  color: ${PALETTE.text};
  line-height: 1.25;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
}
`;

  const itemsHtml = items.map((it, i) => {
    const fz = _itemFontSize(it, layout);
    const d  = delays[i].toFixed(2);
    return `<div class="toc-item" style="animation-delay:${d}s;">`
      + `<span class="toc-num">${i + 1}</span>`
      + `<span class="toc-text" style="font-size:${fz}px;">${esc(it)}</span>`
      + `</div>`;
  }).join('');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="toc-title">${esc(tocTitle)}</div>
<div class="toc-title-bar"></div>
<div class="toc-list">
  ${itemsHtml}
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildTocHTML };
