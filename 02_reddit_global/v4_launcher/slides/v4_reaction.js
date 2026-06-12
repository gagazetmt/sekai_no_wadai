// v4_launcher/slides/v4_reaction.js
// V4リアクション: 本物の2chレス欄スタイル
//   レス番号+名無しヘッダー+本文 / 最高スコア=赤レス /
//   音声と同期して読まれてるレスが黄色マーカーでハイライト
'use strict';

const {
  esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod,
  LEAD_PAD_SEC, TAIL_PAD_SEC, fitFont,
} = require('../../scripts/v2_video/slides/_common');
const { C2CH, fakeId, colorBrackets, boardBarHTML, THEME_CSS, threadDateStr } = require('./_v4_theme');

const SUB_BAR_HEIGHT = 110;

// レス番号列を決定論的に生成（14 から不規則に増える）
function _resNumbers(comments, seedBase = 14) {
  let cur = seedBase;
  return comments.map(c => {
    let h = 0;
    const s = String(c.text || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    cur += 3 + (h % 19);
    return cur;
  });
}

function buildV4ReactionHTML(mod) {
  const m = mod || {};
  const threadTitle = String(m.threadTitle || m.title || '');
  const comments = (Array.isArray(m.comments) ? m.comments : []).slice(0, 5);
  const maxScore = Math.max(0, ...comments.map(c => c.score || 0));
  const resNums  = _resNumbers(comments);

  // ── 音声同期タイミング（既存ロジック踏襲）──────────────────
  const audio      = Array.isArray(m.audio) ? m.audio : [];
  const narrCount  = Math.max(0, audio.length - comments.length);
  const chunkStarts = audio.map((_, i) =>
    LEAD_PAD_SEC + audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));
  const totalSec = audio.length
    ? (audio.reduce((s, c) => s + (c.durationSec || 0), 0) + LEAD_PAD_SEC + TAIL_PAD_SEC)
    : 8;

  const STAGGER  = 0.65;
  const FIRST_AT = 0.5;

  const timing = comments.map((_, i) => {
    const ci = narrCount + i;
    if (audio.length && ci < audio.length) {
      const s = chunkStarts[ci];
      const d = audio[ci].durationSec || 1;
      return { delay: Math.max(0, s - 0.15), activeStart: s, activeEnd: s + d, hasActive: true };
    }
    return { delay: FIRST_AT + i * STAGGER, hasActive: false };
  });

  // 読み上げ中レス: 黄色マーカー + わずかに拡大
  const activeStyles = timing.map((t, i) => {
    if (!t.hasActive) return '';
    const fadeIn = 0.20, fadeOut = 0.25;
    const p = sec => Math.max(0, Math.min(100, sec / totalSec * 100));
    return `
@keyframes resActive_${i} {
  0%, ${p(t.activeStart - fadeIn).toFixed(2)}% { background: transparent; transform: scale(1); }
  ${p(t.activeStart).toFixed(2)}%, ${p(t.activeEnd).toFixed(2)}% { background: rgba(255,235,59,0.45); transform: scale(1.015); }
  ${p(t.activeEnd + fadeOut).toFixed(2)}%, 100% { background: transparent; transform: scale(1); }
}
.res-item.active-${i} { animation: resItemIn .4s ease-out forwards, resActive_${i} ${totalSec.toFixed(2)}s linear forwards; }`;
  }).join('\n');

  const extraStyles = `
${THEME_CSS}
.res-list {
  position: absolute;
  top: 110px; bottom: ${SUB_BAR_HEIGHT + 16}px;
  left: 80px; right: 80px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}
.res-item {
  padding: 18px 26px 22px;
  border-bottom: 1px solid ${C2CH.line};
  border-radius: 6px;
  opacity: 0;
  transform: translateY(-16px);
  animation: resItemIn .4s ease-out forwards;
  transform-origin: left center;
}
.res-item:last-child { border-bottom: none; }
.res-item .rh { font-size: 25px; margin-bottom: 10px; color: ${C2CH.meta}; }
.res-item .rh .n  { color: ${C2CH.maroon}; font-weight: 900; }
.res-item .rh .nm { color: ${C2CH.name}; font-weight: 900; }
.res-body {
  font-weight: 900;
  color: ${C2CH.text};
  line-height: 1.32;
  word-break: break-word;
}
.res-body.aka { color: ${C2CH.red}; }
@keyframes resItemIn { to { opacity: 1; transform: translateY(0); } }
${activeStyles}`;

  const itemsHTML = comments.length
    ? comments.map((c, i) => {
        const text = String(c.text || '');
        const trim = text.length > 90 ? text.slice(0, 88) + '…' : text;
        const isAka = (c.score || 0) === maxScore && maxScore > 0 && comments.length > 1;
        const fz  = fitFont(trim, 54, 1680, { maxLines: 2, minFontPx: 34, charWidth: 1.0 }).fontSize;
        const t   = timing[i];
        const activeClass = t.hasActive ? ` active-${i}` : '';
        return `
<div class="res-item${activeClass}" style="animation-delay:${t.delay.toFixed(2)}s;">
  <div class="rh"><span class="n">${resNums[i]}</span> : <span class="nm">風吹けば名無し</span> ${threadDateStr(resNums[i])} ID:${fakeId(text)}</div>
  <div class="res-body${isAka ? ' aka' : ''}" style="font-size:${fz}px;">${colorBrackets(esc(trim)).replace(/\n/g, '<br>')}</div>
</div>`;
      }).join('')
    : `<div style="text-align:center;color:${C2CH.meta};font-size:32px;">コメントなし</div>`;

  const slideBody = `
<div class="board-bg"></div>
${boardBarHTML(esc(threadTitle))}
<div class="res-list">${itemsHTML}</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildV4ReactionHTML };
