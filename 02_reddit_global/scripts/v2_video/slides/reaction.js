// scripts/v2_video/slides/reaction.js
// Reaction スライド：背景画像 + コメント吹き出しが上から順に出現 + 字幕
// テンプレート元: V1 の slide_builder.js のreaction型を踏襲

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar } = require('./_common');

function buildReactionHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const title = mod.title || '海外の声';
  const comments = (Array.isArray(mod.comments) ? mod.comments : []).slice(0, 7);
  const narr = mod.narration || '';

  // ハイライトされるコメント（一番スコアが高いやつ）
  const maxScore = Math.max(0, ...comments.map(c => c.score || 0));

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover;
  background-position: center;
  filter: brightness(0.4);
}
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(6,14,28,0.5) 0%, rgba(6,14,28,0.85) 100%);
}

/* タイトル */
.r-title {
  position: absolute;
  top: 50px;
  left: 80px;
  right: 80px;
  font-size: 56px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 2px;
  text-shadow: 0 2px 14px rgba(0,0,0,0.9);
  z-index: 5;
}

/* コメントエリア */
.comments-area {
  position: absolute;
  top: 150px;
  left: 80px;
  right: 80px;
  bottom: 130px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 20px 24px;
  align-content: start;
  z-index: 5;
}
.c-card {
  opacity: 0;
  transform: translateY(15px);
  animation: cardPop 0.5s ease-out forwards;

  background: rgba(255,255,255,0.96);
  border-radius: 20px;
  padding: 22px 28px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: relative;
  min-height: 100px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.5);
}
.c-card.hl {
  border: 5px solid ${PALETTE.accent};
  background: ${PALETTE.accent};
}
.c-text {
  font-size: 28px;
  font-weight: 700;
  color: #1a2540;
  line-height: 1.4;
}
.c-card.hl .c-text { color: #1a1a1a; }
.c-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 18px;
  color: #6b7280;
}
.c-card.hl .c-meta { color: #444; }
.c-fan { font-weight: 700; }
.c-score { font-size: 16px; }

/* 出現遅延（左→右、上→下、順番に）*/
.c-card:nth-child(1) { animation-delay: 0.6s; }
.c-card:nth-child(2) { animation-delay: 1.2s; }
.c-card:nth-child(3) { animation-delay: 1.8s; }
.c-card:nth-child(4) { animation-delay: 2.4s; }
.c-card:nth-child(5) { animation-delay: 3.0s; }
.c-card:nth-child(6) { animation-delay: 3.6s; }
.c-card:nth-child(7) { animation-delay: 4.2s; }

@keyframes cardPop {
  0%   { opacity: 0; transform: translateY(15px) scale(0.96); }
  60%  { opacity: 1; transform: translateY(-3px) scale(1.02); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}

/* 字幕 */
.sub-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 110px;
  background: rgba(0,0,0,0.92);
  border-top: 3px solid rgba(245,158,11,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 20;
}
.sub-text {
  color: ${PALETTE.text};
  font-size: 38px;
  font-weight: 800;
  text-align: center;
  padding: 0 80px;
  line-height: 1.4;
  max-height: 100px;
  overflow: hidden;
}
`;

  const cardsHtml = comments.length
    ? comments.map((c, i) => {
        const text = c.text || '';
        const isHl = (c.score || 0) === maxScore && maxScore > 0 && comments.length > 1;
        return `<div class="c-card${isHl ? ' hl' : ''}">
          <div class="c-text">${esc(text.length > 100 ? text.slice(0, 100) + '…' : text)}</div>
          <div class="c-meta">
            <span class="c-fan">@fan${i + 1}</span>
            ${c.score ? `<span class="c-score">▲ ${c.score}</span>` : ''}
          </div>
        </div>`;
      }).join('')
    : '<div style="grid-column:1/-1;text-align:center;color:#fff;font-size:24px;padding-top:60px">コメントがありません</div>';

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="r-title">&#x1F4AC; ${esc(title)}</div>
<div class="comments-area">${cardsHtml}</div>
${buildSubtitleBar(narr, { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildReactionHTML };
