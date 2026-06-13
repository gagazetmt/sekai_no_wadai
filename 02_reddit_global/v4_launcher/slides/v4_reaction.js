// v4_launcher/slides/v4_reaction.js
// V4リアクション: V1 buildCommentSlide 移植版
//   写真フルブリード + Ken Burns + パステルコメントカード（左右交互・黒枠）
//   + 右上 teal トピックタグ + 下部字幕バー
//   音声同期（読み上げ中カードの拡大ハイライト）は V4 機構を維持
'use strict';

const {
  esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod,
  LEAD_PAD_SEC, TAIL_PAD_SEC, fitFont,
} = require('../../scripts/v2_video/slides/_common');

const SAFE = 60;
const SUB_BAR_HEIGHT = 110;

// V1 のパステル6色 + ハイライト6色
const CMT_BG    = ['#FFF9C4', '#C8EEFF', '#D4F5D4', '#EDD5FF', '#FFE8CC', '#FFD5EA'];
const CMT_BG_HL = ['#FFD700', '#5BB8F5', '#5ED45E', '#B86FFF', '#FF9F43', '#FF70A6'];

function buildV4ReactionHTML(mod) {
  const m = mod || {};
  const topicTag = String(m.topicTag || m.title || '');
  const comments = (Array.isArray(m.comments) ? m.comments : []).slice(0, 5);
  const maxScore = Math.max(0, ...comments.map(c => c.score || 0));
  const imgPath  = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc   = imgPath ? imgDataUri(imgPath) : '';

  const bgCss = imgSrc
    ? `background-image:url('${imgSrc}');background-size:cover;background-position:50% 22%;`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;

  // ── 音声同期タイミング（V4機構維持）──────────────────────
  const audio       = Array.isArray(m.audio) ? m.audio : [];
  const narrCount   = Math.max(0, audio.length - comments.length);
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

  // 読み上げ中カード: 拡大 + 金色グロー
  const activeStyles = timing.map((t, i) => {
    if (!t.hasActive) return '';
    const fadeIn = 0.20, fadeOut = 0.25;
    const p = sec => Math.max(0, Math.min(100, sec / totalSec * 100));
    return `
@keyframes cmtActive_${i} {
  0%, ${p(t.activeStart - fadeIn).toFixed(2)}% { transform: scale(1); box-shadow: 4px 4px 0 rgba(0,0,0,0.4); }
  ${p(t.activeStart).toFixed(2)}%, ${p(t.activeEnd).toFixed(2)}% { transform: scale(1.05); box-shadow: 6px 6px 0 rgba(0,0,0,0.55), 0 0 32px rgba(252,211,77,0.55); }
  ${p(t.activeEnd + fadeOut).toFixed(2)}%, 100% { transform: scale(1); box-shadow: 4px 4px 0 rgba(0,0,0,0.4); }
}
.c-card.active-${i} { animation: cmtActive_${i} ${totalSec.toFixed(2)}s linear forwards; }`;
  }).join('\n');

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bgCss}
  animation: kbZoom 25s linear forwards;
  transform-origin: 50% 30%;
}
@keyframes kbZoom {
  from { transform: scale(1.0)  translate(-2%, 0); }
  to   { transform: scale(1.08) translate(2%, 0); }
}
.overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.10); }
.topic-tag {
  position: absolute; top: ${SAFE}px; right: ${SAFE}px;
  background: #1aa8a8; color: #fff;
  font-size: 28px; font-weight: 900;
  padding: 8px 22px; border-radius: 6px;
  animation: fadeUp 0.35s 0s ease-out both;
  z-index: 5;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
.comments-area {
  position: absolute;
  top: ${SAFE + 60}px; bottom: ${SUB_BAR_HEIGHT + 20}px;
  left: ${SAFE}px; right: ${SAFE}px;
  display: flex; flex-direction: column;
  justify-content: flex-start; gap: 20px;
  z-index: 5;
}
.c-slot {
  opacity: 0; width: fit-content; max-width: 90%;
  animation: slideDown 0.45s ease-out forwards;
}
@keyframes slideDown { from { opacity: 0; transform: translateY(-30px); } to { opacity: 1; transform: translateY(0); } }
.c-card {
  border: 3px solid #000; border-radius: 8px;
  padding: 10px 18px;
  box-shadow: 4px 4px 0 rgba(0,0,0,0.4);
}
.c-text { color: #111; font-weight: 700; line-height: 1.4; overflow-wrap: break-word; }
.c-card.hl .c-text { color: #000; font-weight: 900; }
${activeStyles}`;

  const cardsHtml = comments.length
    ? comments.map((c, i) => {
        const text = String(c.text || '');
        const trim = text.length > 100 ? text.slice(0, 98) + '…' : text;
        const isHL = (c.score || 0) === maxScore && maxScore > 0 && comments.length > 1;
        const side = i % 2 === 0 ? 'flex-start' : 'flex-end';
        const bgC  = isHL ? CMT_BG_HL[i % CMT_BG_HL.length] : CMT_BG[i % CMT_BG.length];
        const fz   = fitFont(trim, 49, 1500, { maxLines: 2, minFontPx: 32, charWidth: 1.0 }).fontSize;
        const t    = timing[i];
        const activeClass = t.hasActive ? ` active-${i}` : '';
        return `<div class="c-slot" style="align-self:${side};animation-delay:${t.delay.toFixed(2)}s;">
  <div class="c-card${isHL ? ' hl' : ''}${activeClass}" style="background:${bgC};">
    <div class="c-text" style="font-size:${fz}px;">${esc(trim).replace(/\n/g, '<br>')}</div>
  </div>
</div>`;
      }).join('')
    : '<div style="text-align:center;color:#fff;font-size:32px;padding-top:60px">コメントなし</div>';

  const slideBody = `
<div class="bg-img"></div>
<div class="overlay"></div>
${topicTag ? `<div class="topic-tag">${esc(topicTag)}</div>` : ''}
<div class="comments-area">${cardsHtml}</div>
${buildSubtitleBar(subtitleArgFromMod(m), { height: SUB_BAR_HEIGHT, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildV4ReactionHTML };
