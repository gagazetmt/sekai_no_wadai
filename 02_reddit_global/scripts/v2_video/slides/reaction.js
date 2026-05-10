// scripts/v2_video/slides/reaction.js
// Reaction スライド：V1ランチャー忠実再現版 + 音声 chunk 連動
//   - カラフルな吹き出し（パステル6色循環）
//   - 左右交互配置
//   - 太い黒枠（3px、ハイライトは5px）
//   - 上から順に slideDown アニメーション
//   - 各 comment は対応する音声 chunk が読まれる瞬間に登場 + 読まれてる間 active

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, LEAD_PAD_SEC, TAIL_PAD_SEC, imageAdjustCss } = require('./_common');

// V1 の CMT_BG / CMT_BG_HL カラーパレット
const CMT_BG    = ['#FFF9C4', '#C8EEFF', '#D4F5D4', '#EDD5FF', '#FFE8CC', '#FFD5EA'];
const CMT_BG_HL = ['#FFD700', '#5BB8F5', '#5ED45E', '#B86FFF', '#FF9F43', '#FF70A6'];

// 文字数からフォントサイズを段階決定
function _commentFont(text) {
  const len = String(text || '').length;
  if (len <= 30) return 44;
  if (len <= 50) return 38;
  if (len <= 70) return 32;
  if (len <= 90) return 28;
  return 24;
}

function buildReactionHTML(mod) {
  const bg       = imgDataUri(mod.bgImage);
  const imgAdj   = imageAdjustCss(mod.imageAdjust);
  const title    = mod.title || '海外の声';
  const comments = (Array.isArray(mod.comments) ? mod.comments : []).slice(0, 7);

  // 最高スコアのコメントをハイライト（HL色 + 5px枠のみ。脈動は無し）
  const maxScore = Math.max(0, ...comments.map(c => c.score || 0));

  // ── 音声 chunk 連動の準備 ─────────────────────────────
  //   buildChunksForModule は [narration_chunks..., comment0, comment1, ...] を返す
  //   → narration_count = audio.length - comments.length
  //   → comment[i] が読まれる音声 chunk = audio[narrCount + i]
  const audio    = Array.isArray(mod.audio) ? mod.audio : [];
  const narrCount = Math.max(0, audio.length - comments.length);
  // 先頭 LEAD_PAD_SEC を chunkStarts に加算 / totalSec も LEAD+TAIL 含む全体時間に揃える
  const chunkStarts = audio.map((_, i) =>
    LEAD_PAD_SEC + audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));
  const totalSec = audio.length
    ? (audio.reduce((s, c) => s + (c.durationSec || 0), 0) + LEAD_PAD_SEC + TAIL_PAD_SEC)
    : 8;

  // フォールバック登場間隔（音声チャンク不在時）
  const STAGGER  = 0.6;
  const FIRST_AT = 0.5;

  // 各 comment ごとに：
  //   delay        = 登場（slideDown）開始時刻
  //   activeStart  = 読まれ始める時刻（active 強調 ON）
  //   activeEnd    = 読み終わる時刻（active 強調 OFF）
  //   hasActive    = 音声が紐付くか（true なら active animation 付与）
  const commentTiming = comments.map((_, i) => {
    const ci = narrCount + i;
    if (audio.length && ci < audio.length) {
      const s = chunkStarts[ci];
      const d = audio[ci].durationSec || 1;
      // 登場は読み始めの 0.15s 前（0以下は0）に少し早めて自然な流れ
      return {
        delay: Math.max(0, s - 0.15),
        activeStart: s,
        activeEnd:   s + d,
        hasActive:   true,
      };
    }
    // 音声無し → 機械固定
    return {
      delay: FIRST_AT + i * STAGGER,
      hasActive: false,
    };
  });

  // 各 comment の active 用 keyframes を生成
  const activeStyles = commentTiming.map((t, i) => {
    if (!t.hasActive) return '';
    const fadeIn = 0.20, fadeOut = 0.25;
    const p = (sec) => Math.max(0, Math.min(100, sec / totalSec * 100));
    const preStartPct = p(t.activeStart - fadeIn);
    const startPct    = p(t.activeStart);
    const endPct      = p(t.activeEnd);
    const postEndPct  = p(t.activeEnd + fadeOut);
    return `
@keyframes commentActive_${i} {
  0%, ${preStartPct.toFixed(2)}%      { transform: rotate(var(--rot, 0deg)) scale(1);    box-shadow: 4px 4px 0 rgba(0,0,0,0.5); }
  ${startPct.toFixed(2)}%, ${endPct.toFixed(2)}%  { transform: rotate(var(--rot, 0deg)) scale(1.06); box-shadow: 6px 6px 0 rgba(0,0,0,0.7), 0 0 36px rgba(252,211,77,0.55); }
  ${postEndPct.toFixed(2)}%, 100%     { transform: rotate(var(--rot, 0deg)) scale(1);    box-shadow: 4px 4px 0 rgba(0,0,0,0.5); }
}
.c-card.active-${i} { animation: commentActive_${i} ${totalSec.toFixed(2)}s linear forwards; }`;
  }).join('\n');

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: ${imgAdj.isDefault ? 'cover' : `${100 * imgAdj.zoom}%`};
  background-position: ${imgAdj.bgPosition};
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

/* slot：登場 (slideDown) を担当。中の c-card は active を担当 */
.c-slot {
  opacity: 0;
  width: fit-content;
  max-width: 86%;
  animation: slideDown 0.45s ease-out forwards;
}
@keyframes slideDown {
  from { opacity: 0; transform: translateY(-22px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* 個別コメント吹き出し */
.c-card {
  border: 3px solid #000;
  border-radius: 14px;
  padding: 14px 26px;
  box-shadow: 4px 4px 0 rgba(0,0,0,0.5);
  position: relative;
  transform: rotate(var(--rot, 0deg));
}
.c-card.hl {
  border-width: 5px;
  box-shadow: 5px 5px 0 rgba(0,0,0,0.6);
}
.c-text {
  color: #111;
  font-weight: 700;
  line-height: 1.35;
  overflow-wrap: break-word;
}
.c-card.hl .c-text {
  color: #000;
  font-weight: 900;
}

/* active 用 keyframes（音声有り comment だけ生成） */
${activeStyles}
`;

  const cardsHtml = comments.length
    ? comments.map((c, i) => {
        const text  = c.text || '';
        const trim  = text.length > 110 ? text.slice(0, 108) + '…' : text;
        const isHL  = (c.score || 0) === maxScore && maxScore > 0 && comments.length > 1;
        const side  = i % 2 === 0 ? 'flex-start' : 'flex-end';
        const bgC   = isHL ? CMT_BG_HL[i % CMT_BG_HL.length] : CMT_BG[i % CMT_BG.length];
        const fz    = _commentFont(trim);
        const t     = commentTiming[i];
        const rot   = (((i * 1.7) % 5) - 2).toFixed(1);
        const activeClass = t.hasActive ? ` active-${i}` : '';
        return `<div class="c-slot" style="align-self:${side};animation-delay:${t.delay.toFixed(2)}s;">
          <div class="c-card${isHL ? ' hl' : ''}${activeClass}" style="background:${bgC};--rot:${rot}deg;">
            <div class="c-text" style="font-size:${fz}px;">${esc(trim).replace(/\n/g, '<br>')}</div>
          </div>
        </div>`;
      }).join('')
    : '<div style="text-align:center;color:#fff;font-size:24px;padding-top:60px">コメントがありません</div>';

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="r-title">&#x1F4AC; ${esc(title)}</div>
<div class="comments-area">${cardsHtml}</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildReactionHTML };
