// scripts/v2_video/slides/toc.js
// 目次スライド：書籍 / 雑誌風の Contents レイアウト + 演出強化
//   - 大きな serif 連番 (01 / 02 / 03)
//   - 上部「CONTENTS」/「目次」のバイリンガル見出し
//   - chunk連動アクティブハイライト（ナレが触れた章が光る）
//   - 背景にゴールドダスト（金粒が漂う雑誌的質感）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, LEAD_PAD_SEC, TAIL_PAD_SEC, imageAdjustCss } = require('./_common');

// 2026-05-16: MAX_ITEMS 8 → 9 に拡張（相棒指示）
const MAX_ITEMS = 9;

// 項目数で行高 / フォント / 番号フォントを動的調整
//   行高はそのままで、フォントは行高ぎりぎりまで大きく
//   numFz: line-height 1 / Georgia italic → 行高×0.85 まで
//   titleFz: line-height 1.25 → 行高×0.65 まで
//   2026-05-16: 1〜5件は現状維持、6〜9件は段階的に可変（9件サポート追加）
function _layoutForCount(n) {
  if (n <= 3) return { rowH: 130, titleFz: 84, numFz: 130 };
  if (n <= 4) return { rowH: 110, titleFz: 68, numFz: 110 };
  if (n === 5) return { rowH: 96,  titleFz: 60, numFz: 96  };
  if (n === 6) return { rowH: 84,  titleFz: 52, numFz: 84  };
  if (n === 7) return { rowH: 74,  titleFz: 44, numFz: 72  };
  if (n === 8) return { rowH: 64,  titleFz: 38, numFz: 62  };
  return         { rowH: 56,  titleFz: 32, numFz: 54  };  // 9件
}

function _itemFontSize(text, baseFz) {
  const len = String(text || '').length;
  if (len <= 12) return baseFz;
  if (len <= 18) return Math.max(baseFz - 4, 28);
  return Math.max(baseFz - 10, 26);
}

// 12粒のゴールドダスト（背景に漂う金粒）
function _buildDust() {
  const dusts = [];
  for (let i = 0; i < 12; i++) {
    const left = Math.random() * 100;
    const dur  = 6 + Math.random() * 8;       // 6〜14秒
    const delay = -Math.random() * dur;       // 開始位相をランダム化
    const size = 3 + Math.random() * 4;       // 3〜7px
    const opacity = 0.4 + Math.random() * 0.4;
    dusts.push(`<div class="dust" style="left:${left.toFixed(1)}%;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;animation-duration:${dur.toFixed(1)}s;animation-delay:${delay.toFixed(2)}s;opacity:${opacity.toFixed(2)};"></div>`);
  }
  return dusts.join('');
}

function buildTocHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const imgAdj = imageAdjustCss(mod.imageAdjust);
  let items = [];
  // 新スキーマ {text, chunkText} と旧スキーマ string[] 両対応
  const _itemText = (it) => (typeof it === 'string') ? it : String(it?.text || '');
  if (Array.isArray(mod.tocItems) && mod.tocItems.length) {
    items = mod.tocItems.slice(0, MAX_ITEMS).map(_itemText);
  } else if (Array.isArray(mod.catchphrases) && mod.catchphrases.length) {
    items = mod.catchphrases.slice(0, MAX_ITEMS).map(_itemText);
  } else if (Array.isArray(mod.dataSlots) && mod.dataSlots.length) {
    items = mod.dataSlots.slice(0, MAX_ITEMS).map(s => s.label || s.value || '');
  }
  items = items.map(s => String(s || '').trim()).filter(Boolean);

  const tocTitle = mod.title || '今日のラインナップ';
  const layout = _layoutForCount(items.length);

  // ─── 固定リビール + 順次脈動 ───
  //   ① スライド遷移直後から1秒刻みで上から item を fade-in（5秒以内に全表示）
  //   ② 全 item 表示後、1秒おきに順次脈動（拡大+ハイライト）。intro 再生中ずっと続く
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const totalSec = audio.length
    ? (audio.reduce((s, c) => s + (c.durationSec || 0), 0) + LEAD_PAD_SEC + TAIL_PAD_SEC)
    : Math.max(items.length * 1.5 + LEAD_PAD_SEC + TAIL_PAD_SEC, 5);

  const REVEAL_INTERVAL = 1.0;  // 各 item の登場間隔
  const PULSE_INTERVAL  = 2.0;  // 脈動の隣接 item 間オフセット
  const startSec = LEAD_PAD_SEC + 0.3;
  const enterDelays = items.map((_, i) => startSec + i * REVEAL_INTERVAL);
  // 全 item が表示し終わった時刻 + 0.5s から脈動開始
  const pulseStartSec = startSec + items.length * REVEAL_INTERVAL + 0.5;
  const pulseCycleSec = Math.max(items.length * PULSE_INTERVAL, 2);  // 2秒/item × items 個 = 1巡
  const pulseDelays = items.map((_, i) => pulseStartSec + i * PULSE_INTERVAL);

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: radial-gradient(ellipse at 30% 40%, #1a2240 0%, #0a0e1a 70%);`}
  background-size: ${imgAdj.isDefault ? 'cover' : `${100 * imgAdj.zoom}%`};
  background-position: ${imgAdj.bgPosition};
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

/* ─── ゴールドダスト（背景に漂う金粒）─── */
.dust-layer {
  position: absolute; inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 2;
}
.dust {
  position: absolute;
  bottom: -10px;
  background: radial-gradient(circle, rgba(245,158,11,0.95) 0%, rgba(245,158,11,0.4) 40%, transparent 70%);
  border-radius: 50%;
  animation-name: floatUp;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  filter: blur(0.5px);
}
@keyframes floatUp {
  0%   { transform: translateY(0) translateX(0); opacity: 0; }
  10%  { opacity: 0.6; }
  50%  { transform: translateY(-50vh) translateX(20px); opacity: 0.8; }
  90%  { opacity: 0.6; }
  100% { transform: translateY(-110vh) translateX(-15px); opacity: 0; }
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
/* 2026-05-16: 字幕復活に伴い bottom 180→260 に上げる（字幕バー 110px + 余白 150px） */
.toc-list {
  position: absolute;
  top: 200px; left: 80px; right: 80px; bottom: 260px;
  display: flex; flex-direction: column;
  justify-content: center;
  gap: 8px;
  z-index: 5;
}

/* 各行：書籍風グリッド（番号 / タイトル / 章バッジ）*/
.toc-row {
  display: grid;
  grid-template-columns: ${Math.round(layout.numFz * 1.5)}px 1fr auto;
  align-items: center;
  gap: 24px;
  min-height: ${layout.rowH}px;
  padding: 6px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  border-left: 0 solid transparent;
  transition: padding-left 0.2s;
  border-radius: 0 6px 6px 0;
  /* 登場アニメ + 脈動アニメを並走 */
  opacity: 0;
  transform: translateX(-40px);
  padding-left: 32px;
  animation:
    rowSlideIn 0.55s cubic-bezier(0.25, 1, 0.5, 1) forwards,
    tocPulse ${pulseCycleSec.toFixed(2)}s linear infinite;
}
@keyframes rowSlideIn {
  from { opacity: 0; transform: translateX(-40px); }
  to   { opacity: 1; transform: translateX(0); padding-left: 32px; }
}
/* 順次バイブレーション：2秒/item サイクル。
   active スロット (0.5s) のみ細かく横揺れ + 薄いアクセント。
   scale 変化なし、振幅 ±3px の控えめ振動。 */
@keyframes tocPulse {
  0%, 100%                                              { transform: translateX(0); border-left: 0 solid transparent; background: transparent; }
  ${((0.05 / pulseCycleSec) * 100).toFixed(2)}%         { transform: translateX(-3px); border-left: 2px solid ${PALETTE.accent}; background: rgba(245, 158, 11, 0.05); }
  ${((0.12 / pulseCycleSec) * 100).toFixed(2)}%         { transform: translateX(2px); }
  ${((0.20 / pulseCycleSec) * 100).toFixed(2)}%         { transform: translateX(-2px); border-left: 2px solid ${PALETTE.accent}; background: rgba(245, 158, 11, 0.06); }
  ${((0.28 / pulseCycleSec) * 100).toFixed(2)}%         { transform: translateX(1px); }
  ${((0.40 / pulseCycleSec) * 100).toFixed(2)}%         { transform: translateX(0); border-left: 1px solid rgba(245, 158, 11, 0.5); background: rgba(245, 158, 11, 0.03); }
  ${((0.55 / pulseCycleSec) * 100).toFixed(2)}%         { transform: translateX(0); border-left: 0 solid transparent; background: transparent; }
}
.toc-row:last-child { border-bottom: none; }

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
  transition: text-shadow 0.3s;
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

.toc-title {
  font-weight: 700;
  color: ${PALETTE.text};
  line-height: 1.25;
  text-shadow: 0 2px 8px rgba(0, 0, 0, 0.7);
  letter-spacing: 1px;
  position: relative;
  padding-left: 28px;
}
.toc-title::before {
  content: '';
  position: absolute;
  left: 0; top: 50%;
  width: 14px; height: 4px;
  background: ${PALETTE.accent};
  transform: translateY(-50%);
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.6);
}

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
    const enterDelay = enterDelays[i].toFixed(2);
    const pulseDelay = pulseDelays[i].toFixed(2);
    const numStr = String(i + 1).padStart(2, '0');
    // 2 アニメ並走: rowSlideIn (登場 1回) + tocPulse (脈動 無限ループ)
    const animStyle = `style="animation-delay:${enterDelay}s, ${pulseDelay}s;"`;
    return `<div class="toc-row r${i}" ${animStyle}>`
      + `<div class="toc-num"><span class="toc-num-prefix">No.</span>${numStr}</div>`
      + `<div class="toc-title" style="font-size:${fz}px;">${esc(it)}</div>`
      + `<div class="toc-badge">Chapter ${i + 1}</div>`
      + `</div>`;
  }).join('');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="dust-layer">${_buildDust()}</div>
<div class="toc-header">
  <span class="toc-header-en">Contents</span>
  <span class="toc-header-jp">${esc(tocTitle)}</span>
  <span class="toc-header-sub">${items.length} chapters</span>
</div>
<div class="toc-list">
  ${itemsHtml}
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;
  /* 2026-05-08 → 2026-05-16: 字幕復活（相棒指示）。
     toc-list の bottom を 180→260 に上げて被らないよう調整。 */

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildTocHTML };
