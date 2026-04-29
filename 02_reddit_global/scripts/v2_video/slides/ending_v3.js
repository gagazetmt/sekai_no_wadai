// scripts/v2_video/slides/ending_v3.js
// エンディング バリエーション V3: 次回予告型
//   - 「次回はXXXを徹底分析」の予告で視聴維持率UP
//   - 大きな登録ボタン + 関連動画スマートリンク用余白
//   - mod.nextTopic = "次回予告のテキスト" で受け取る
//   - mod.endingCta.text もカスタマイズ可

const {
  PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle,
  buildSubtitleBar, subtitleArgFromMod, _t,
} = require('./_common');

const SVG_BELL = '<svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;"><path d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22zm6.6-6.6V10A6.6 6.6 0 0 0 13 3.5V2.6a1 1 0 1 0-2 0v.9A6.6 6.6 0 0 0 5.4 10v5.4L4 17v.8h16V17l-1.4-1.6z"/></svg>';
const SVG_THUMB = '<svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;flex-shrink:0;"><path d="M2 10h4.5v11H2zm6.5 11V10l5.5-9c.9 0 1.7.7 1.7 1.7v6.6h6.7c1 0 1.7.7 1.7 1.7l-1.7 8.4c-.2.9-.9 1.6-1.8 1.6H8.5z"/></svg>';
const SVG_PLAY  = '<svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:middle;"><path d="M8 5v14l11-7z"/></svg>';

function buildEndingHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const channelName = mod.channelName || '5分でサッカー分析';
  const ctaText = (mod.endingCta && mod.endingCta.text) || 'チャンネル登録お願い';
  const nextTopic = mod.nextTopic || mod.title || '次回もデータでサッカーを分析';
  const commentPrompt = mod.commentPrompt || 'あなたの予想をコメントで！';

  const subBarHtml = mod.narration ? buildSubtitleBar(subtitleArgFromMod(mod), { height: 110 }) : '';

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(135deg, #1a1f3a 0%, #060c1a 100%);`}
  background-size: cover; background-position: center;
  filter: brightness(0.5);
  ${bg ? 'animation: bgZoom 12s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.06); } }
.bg-overlay {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(245,158,11,0.10) 0%, transparent 60%),
    linear-gradient(135deg, rgba(6,14,28,0.50) 0%, rgba(6,14,28,0.75) 100%);
}

/* ── 「NEXT」ヘッダ ── */
.next-header {
  position: absolute;
  top: 70px; left: 80px; right: 80px;
  z-index: 5;
  display: flex; align-items: baseline; gap: 24px;
  border-bottom: 3px solid ${PALETTE.accent};
  padding-bottom: 18px;
  opacity: 0;
  animation: fadeUp 0.6s ease-out 0.2s forwards;
}
.next-header-en {
  font-family: 'Georgia', serif;
  font-size: 26px;
  letter-spacing: 8px;
  color: ${PALETTE.accent};
  text-transform: uppercase;
}
.next-header-jp {
  font-size: 38px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 4px;
  text-shadow: 0 2px 12px rgba(0,0,0,0.7);
}

/* ── 次回予告本文 ── */
.next-topic {
  position: absolute;
  top: 220px; left: 80px; right: 80px;
  font-size: 64px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.25;
  letter-spacing: 1px;
  text-shadow:
    0 0 14px rgba(245,158,11,0.4),
    0 4px 24px rgba(0,0,0,0.9);
  opacity: 0;
  animation: titleIn 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.5s forwards;
  z-index: 5;
}
@keyframes titleIn {
  from { opacity: 0; transform: translateX(-30px); filter: blur(4px); }
  to   { opacity: 1; transform: translateX(0); filter: blur(0); }
}
.next-topic::before {
  content: '▶';
  color: ${PALETTE.accent};
  margin-right: 16px;
  font-size: 50px;
  display: inline-block;
}

/* ── 「コメントで教えて」誘導 ── */
.comment-prompt {
  position: absolute;
  top: 460px; left: 80px;
  font-size: 28px;
  font-weight: 700;
  color: ${PALETTE.muted};
  letter-spacing: 2px;
  padding: 12px 24px;
  background: rgba(245, 158, 11, 0.12);
  border-left: 4px solid ${PALETTE.accent};
  border-radius: 0 8px 8px 0;
  opacity: 0;
  animation: fadeUp 0.5s ease-out 1.0s forwards;
  z-index: 5;
}
.comment-prompt-icon {
  font-size: 32px;
  margin-right: 12px;
}

/* ── ロゴ（中央寄り）+ CTA 大型ボタン ── */
.cta-zone-v3 {
  position: absolute;
  bottom: ${mod.narration ? 180 : 80}px;
  left: 0; right: 0;
  display: flex; flex-direction: column; align-items: center;
  z-index: 5;
}
.channel-logo-end {
  font-size: 40px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 10px;
  margin-bottom: 30px;
  text-shadow: 0 0 24px rgba(245,158,11,0.6), 0 0 50px rgba(245,158,11,0.3);
  opacity: 0;
  animation: fadeUp 0.6s ease-out 1.4s forwards;
}
.cta-mega {
  display: inline-flex; align-items: center; gap: 24px;
  background: ${PALETTE.accent};
  color: #000;
  padding: 28px 60px;
  border-radius: 18px;
  font-size: 48px;
  font-weight: 900;
  letter-spacing: 3px;
  box-shadow: 0 0 0 8px rgba(245,158,11,0.25), 0 12px 48px rgba(245,158,11,0.6);
  opacity: 0;
  animation: fadeUp 0.6s ease-out 1.7s forwards, ctaPulse 2.4s ease-in-out 2.5s infinite;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
@keyframes ctaPulse {
  0%, 100% { transform: scale(1);    box-shadow: 0 0 0 8px rgba(245,158,11,0.25), 0 12px 48px rgba(245,158,11,0.6); }
  50%      { transform: scale(1.05); box-shadow: 0 0 0 16px rgba(245,158,11,0.32), 0 16px 64px rgba(245,158,11,0.8); }
}
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="next-header">
  <span class="next-header-en">Next Episode</span>
  <span class="next-header-jp">次回予告</span>
</div>
<div class="next-topic">${esc(nextTopic)}</div>
<div class="comment-prompt"><span class="comment-prompt-icon">💬</span>${esc(commentPrompt)}</div>
<div class="cta-zone-v3">
  <div class="channel-logo-end">${esc(channelName)}</div>
  <div class="cta-mega">${SVG_BELL}<span>${esc(ctaText)}</span>${SVG_THUMB}</div>
</div>
${subBarHtml}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildEndingHTML };
