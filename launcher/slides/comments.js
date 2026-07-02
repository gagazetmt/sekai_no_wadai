// launcher/slides/comments.js
// コメントバブル オーバーレイ
//   - 9行スロット制: 短コメ(≤40字)=1行, 中(≤80字)=2行, 長(≤120字)=3行
//   - 合計9スロット埋まるまでコメントを選択（bin-pack）
//   - 40字/行折り返し: font-size 36px × カード幅88% で自然に揃う
//   - ポップタイミングは perComment 実測値に完全同期

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const CMT_BG = ['#FFF9C4', '#C8EEFF', '#D4F5D4', '#EDD5FF', '#FFE8CC', '#FFD5EA'];

const SOURCE_ICONS = {
  x:      { bg: '#000000', color: '#ffffff', letter: 'X' },
  reddit: { bg: '#ff4500', color: '#ffffff', letter: 'R' },
  yahoo:  { bg: '#ffffff', color: '#e60023', letter: 'Y' },
};
const SOURCE_CYCLE = ['x', 'reddit', 'yahoo'];

// ── 9行スロット設計 ──────────────────────────────────────
// 1920x1080 overlay: top=130px, bottom=120px → 高さ830px
// 9スロット: 1スロット = 78px（余白削減）
const TOTAL_ROWS   = 9;
const OVERLAY_H_PX = 830;   // 1080 - 130 - 120
const ROW_PX       = 78;    // was 92 → 余白削減
const CMT_FONT_PX  = 43;    // was 36 → +20%
const CHARS_PER_ROW = 34;   // 43px font × card幅で収まる文字数

// テキスト長から行数を算出（1〜3行）
function _lineCount(text) {
  const len = (text || '').replace(/\s/g, '').length;
  if (len <= CHARS_PER_ROW)       return 1;
  if (len <= CHARS_PER_ROW * 2)   return 2;
  return 3;
}

// 割り当てた行数に収まるよう文字数を切り詰める（呼び出し元の切り詰め長(最大120字)が
// 3行分(CHARS_PER_ROW*3=102字)を超えてカードからテキストがはみ出す事故を防ぐ）
function _truncateForLines(text, lines) {
  const maxChars = lines * CHARS_PER_ROW;
  const t = text || '';
  return t.length > maxChars ? t.slice(0, maxChars - 1) + '…' : t;
}

// 9スロットを埋めるようコメントを貪欲選択（3行コメントは1枚まで）
function _packComments(comments) {
  const result = [];
  let used = 0;
  let tripleCount = 0;
  for (const c of comments) {
    const lines = _lineCount(c.text || '');
    if (lines === 3 && tripleCount >= 1) continue; // 3行は1個まで
    if (used + lines > TOTAL_ROWS) continue;
    result.push({ ...c, text: _truncateForLines(c.text, lines), lines });
    used += lines;
    if (lines === 3) tripleCount++;
    if (used >= TOTAL_ROWS) break;
  }
  return result;
}

// ── タイミング計算 ────────────────────────────────────────
function _computeStartTimes(comments, timing, narrationEndSec) {
  const n = comments.length;
  if (timing && Array.isArray(timing.perComment) && timing.perComment.length) {
    const pause = timing.narToCmtPauseSec ?? 0.2;
    const gap   = timing.cmtGapSec ?? 0.3;
    const narEnd = timing.narrationDurSec ?? (narrationEndSec || 0);
    const out = new Array(n).fill(null);
    let cursor = narEnd + pause;
    for (const pc of timing.perComment) {
      const i = pc.index;
      const dur = pc.durationSec || 1.2;
      if (i >= 0 && i < n) out[i] = { start: cursor, end: cursor + dur, hasActive: true };
      cursor += dur + gap;
    }
    for (let i = 0; i < n; i++) {
      if (!out[i]) out[i] = { start: cursor, end: cursor + 1.2, hasActive: false }, cursor += 1.5;
    }
    return out;
  }
  const base = (narrationEndSec && narrationEndSec > 0) ? narrationEndSec : 1.0;
  const STAGGER = 1.4;
  return comments.map((_, i) => ({
    start: base + i * STAGGER,
    end:   base + i * STAGGER + 1.2,
    hasActive: false,
  }));
}

// ── HTML/CSS 生成 ─────────────────────────────────────────
function buildCommentOverlayHTML(comments, narrationEndSec, timing, totalSec) {
  if (!comments || !comments.length) return { html: '', css: '' };

  const items = _packComments(comments);
  if (!items.length) return { html: '', css: '' };

  const T = Math.max(totalSec || 0, 8);
  const timings = _computeStartTimes(items, timing, narrationEndSec);

  const pct = (sec) => Math.max(0, Math.min(100, (sec / T) * 100));

  // active 強調 keyframes（読み上げ中だけ拡大＋グロー）
  const activeStyles = timings.map((t, i) => {
    if (!t.hasActive) return '';
    const fIn = 0.18, fOut = 0.22;
    const a = pct(t.start - fIn), b = pct(t.start), c = pct(t.end), d = pct(t.end + fOut);
    return `
@keyframes cmtActive_${i} {
  0%, ${a.toFixed(2)}%            { transform: rotate(var(--rot,0deg)) scale(1);    box-shadow: 5px 5px 0 rgba(0,0,0,0.5); }
  ${b.toFixed(2)}%, ${c.toFixed(2)}% { transform: rotate(var(--rot,0deg)) scale(1.04); box-shadow: 7px 7px 0 rgba(0,0,0,0.7), 0 0 40px rgba(252,211,77,0.55); }
  ${d.toFixed(2)}%, 100%          { transform: rotate(var(--rot,0deg)) scale(1);    box-shadow: 5px 5px 0 rgba(0,0,0,0.5); }
}
.cmt-card.cmt-active-${i} { animation: cmtActive_${i} ${T.toFixed(2)}s linear forwards; }`;
  }).join('\n');

  const firstStart = Math.min(...timings.map(t => t.start));

  const css = `
.cmt-scrim {
  position: absolute; inset: 0; z-index: 15; pointer-events: none;
  background: linear-gradient(180deg, rgba(6,14,28,0.28) 0%, rgba(6,14,28,0.62) 100%);
  opacity: 0; animation: cmtScrim 0.5s ease-out forwards;
  animation-delay: ${Math.max(0, firstStart - 0.2).toFixed(2)}s;
}
@keyframes cmtScrim { from { opacity: 0; } to { opacity: 1; } }

/* 9スロット × ${ROW_PX}px / slot = ${TOTAL_ROWS * ROW_PX}px total */
.cmt-overlay {
  position: absolute;
  top: 130px; bottom: 120px; left: 70px; right: 70px;
  display: flex; flex-direction: column;
  justify-content: flex-start; gap: 0;
  z-index: 20; pointer-events: none;
  overflow: hidden;
}
/* slot: 行数 × ROW_PX px の高さ。幅は 88% = 40字 × 36px = 1440px + カード余白 */
.cmt-slot {
  opacity: 0; flex-shrink: 0;
  max-width: 88%;
  animation: cmtSlideDown 0.45s ease-out forwards;
  display: flex; align-items: stretch;
}
@keyframes cmtSlideDown {
  from { opacity: 0; transform: translateY(-20px); }
  to   { opacity: 1; transform: translateY(0); }
}
.cmt-card {
  display: flex; align-items: center; gap: 10px;
  border: 4px solid #000; border-radius: 14px;
  padding: 0 12px 0 8px;
  box-shadow: 5px 5px 0 rgba(0,0,0,0.5);
  transform: rotate(var(--rot, 0deg));
  transform-origin: var(--rot-origin, center center);
  width: 100%; box-sizing: border-box;
}
.cmt-icon {
  width: 56px; height: 56px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 28px; font-weight: 800;
  font-family: 'Arial', 'Helvetica', sans-serif;
  border: 2px solid rgba(0,0,0,0.2);
}
/* 36px font × 88% card width ≈ 40字/行で自然折り返し */
.cmt-text {
  color: #111; font-weight: 700; line-height: 1.45;
  overflow-wrap: break-word; word-break: break-all;
  font-size: ${CMT_FONT_PX}px;
  font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
}
${activeStyles}
`;

  const cardsHtml = items.map((c, i) => {
    const t    = timings[i];
    const delay = Math.max(0, t.start - 0.15);
    const srcKey = c.source || SOURCE_CYCLE[i % SOURCE_CYCLE.length];
    const icon  = SOURCE_ICONS[srcKey] || SOURCE_ICONS.x;
    const text  = _esc(c.text || '');
    const side  = i % 2 === 0 ? 'flex-start' : 'flex-end';
    // 傾き(--rot)は左右どちらかの端を軸に回転させ、逆側(余白がある側)へだけ振れるようにする。
    // これで overflow:hidden の親コンテナからはみ出して見切れるのを防ぐ（回転自体は残す）。
    const rotOrigin = side === 'flex-start' ? 'left center' : 'right center';
    const bgC   = CMT_BG[i % CMT_BG.length];
    const rot   = (((i * 1.7) % 5) - 2).toFixed(1);
    const slotH = c.lines * ROW_PX;
    const activeClass = t.hasActive ? ` cmt-active-${i}` : '';

    return `<div class="cmt-slot" style="align-self:${side};animation-delay:${delay.toFixed(2)}s;height:${slotH}px">
  <div class="cmt-card${activeClass}" style="background:${bgC};--rot:${rot}deg;--rot-origin:${rotOrigin};height:100%">
    <div class="cmt-icon" style="background:${icon.bg};color:${icon.color}">${icon.letter}</div>
    <div class="cmt-text">${text}</div>
  </div>
</div>`;
  }).join('\n');

  const html = `<div class="cmt-scrim"></div>\n<div class="cmt-overlay">\n${cardsHtml}\n</div>`;
  return { html, css };
}

function injectCommentOverlay(slideHtml, comments, narrationEndSec, timing, totalSec) {
  const { html, css } = buildCommentOverlayHTML(comments, narrationEndSec, timing, totalSec);
  if (!html) return slideHtml;
  let result = slideHtml.replace('</style>', css + '\n</style>');
  result = result.replace(/(<\/div>)\s*(<\/body>)/, html + '\n$1$2');
  return result;
}

module.exports = { buildCommentOverlayHTML, injectCommentOverlay, packComments: _packComments };
