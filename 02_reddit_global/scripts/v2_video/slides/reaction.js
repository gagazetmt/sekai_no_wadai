// scripts/v2_video/slides/reaction.js
// Reaction スライド：V1ランチャー忠実再現版
//   - カラフルな吹き出し（パステル6色循環）
//   - 左右交互配置
//   - 太い黒枠（3px、ハイライトは4px）
//   - 上から順に slideDown アニメーション

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar } = require('./_common');

// V1 の CMT_BG / CMT_BG_HL カラーパレット
const CMT_BG    = ['#FFF9C4', '#C8EEFF', '#D4F5D4', '#EDD5FF', '#FFE8CC', '#FFD5EA'];
const CMT_BG_HL = ['#FFD700', '#5BB8F5', '#5ED45E', '#B86FFF', '#FF9F43', '#FF70A6'];

function buildReactionHTML(mod) {
  const bg       = imgDataUri(mod.bgImage);
  const title    = mod.title || '海外の声';
  const comments = (Array.isArray(mod.comments) ? mod.comments : []).slice(0, 7);
  const narr     = mod.narration || '';

  // 最高スコアのコメントをハイライト
  const maxScore = Math.max(0, ...comments.map(c => c.score || 0));

  // V1 と同じ stagger（0.6s 間隔。後で TTS chunk 同期に置換予定）
  const STAGGER  = 0.6;
  const FIRST_AT = 0.5;

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover;
  background-position: center;
  filter: brightness(0.45);
}
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(6,14,28,0.40) 0%, rgba(6,14,28,0.78) 100%);
}

/* タイトル */
.r-title {
  position: absolute;
  top: 50px; left: 80px; right: 80px;
  font-size: 56px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 2px;
  text-shadow: 0 2px 14px rgba(0,0,0,0.9);
  z-index: 5;
}

/* コメント縦積みエリア（左右交互） */
.comments-area {
  position: absolute;
  top: 150px; bottom: 150px;
  left: 60px; right: 60px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  gap: 18px;
  z-index: 5;
}

/* 個別コメント吹き出し */
.c-card {
  opacity: 0;
  border: 3px solid #000;
  border-radius: 14px;
  padding: 14px 26px;
  width: fit-content;
  max-width: 86%;
  box-shadow: 4px 4px 0 rgba(0,0,0,0.5);
  position: relative;
}
.c-card.hl {
  border-width: 5px;
  box-shadow: 5px 5px 0 rgba(0,0,0,0.6);
  transform-origin: center;
}
.c-text {
  color: #111;
  font-size: 44px;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: break-word;
}
.c-card.hl .c-text {
  color: #000;
  font-weight: 900;
}

/* slideDown アニメーション（V1 互換） */
@keyframes slideDown {
  from { opacity: 0; transform: translateY(-22px) rotate(var(--rot, 0deg)); }
  to   { opacity: 1; transform: translateY(0) rotate(var(--rot, 0deg)); }
}
@keyframes hlPop {
  0%   { transform: scale(1) rotate(var(--rot, 0deg)); }
  50%  { transform: scale(1.04) rotate(var(--rot, 0deg)); }
  100% { transform: scale(1) rotate(var(--rot, 0deg)); }
}
`;

  const cardsHtml = comments.length
    ? comments.map((c, i) => {
        const text  = c.text || '';
        const trim  = text.length > 90 ? text.slice(0, 88) + '…' : text;
        const isHL  = (c.score || 0) === maxScore && maxScore > 0 && comments.length > 1;
        const side  = i % 2 === 0 ? 'flex-start' : 'flex-end';
        const bg    = isHL ? CMT_BG_HL[i % CMT_BG_HL.length] : CMT_BG[i % CMT_BG.length];
        const delay = (FIRST_AT + i * STAGGER).toFixed(2);
        // ちょっとランダムな傾き（手書き感）
        const rot   = (((i * 1.7) % 5) - 2).toFixed(1);
        const hlAnim = isHL ? `, hlPop 1.4s ${(parseFloat(delay) + 0.5).toFixed(2)}s ease-in-out infinite` : '';
        return `<div class="c-card${isHL ? ' hl' : ''}"
          style="align-self:${side};background:${bg};--rot:${rot}deg;
                 animation: slideDown 0.45s ${delay}s ease-out forwards${hlAnim};">
          <div class="c-text">${esc(trim).replace(/\n/g, '<br>')}</div>
        </div>`;
      }).join('')
    : '<div style="text-align:center;color:#fff;font-size:24px;padding-top:60px">コメントがありません</div>';

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="r-title">&#x1F4AC; ${esc(title)}</div>
<div class="comments-area">${cardsHtml}</div>
${buildSubtitleBar(narr, { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildReactionHTML };
