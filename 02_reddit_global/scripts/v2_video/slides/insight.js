// scripts/v2_video/slides/insight.js
// Insight スライド：キャッチコピーが上から順にフェードイン（V1 再現）
// テンプレート元: /insight/index.html（プレビュー版から editor を除外して1920x1080 に最適化）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod } = require('./_common');

// 数字+単位を黄色ハイライトで強調（"24ゴール" "5冠" "100億" 等）
//   esc 済み文字列を入力受け取り、span.hl-num でラップ
function _highlightNumbers(escapedText) {
  // 半角・全角数字に対応。単位は球技で頻出するもの中心
  return escapedText.replace(
    /([\d０-９]+(?:[\.,．，][\d０-９]+)?)\s*(試合|ゴール|得点|アシスト|億|万|歳|位|連勝|連敗|連覇|周年|シーズン|分|秒|度目|度|冠|勝|敗|引分|本|点|個|G|A|％|%)/g,
    '<span class="hl-num">$1$2</span>'
  );
}

// phrase 文字数からフォントサイズを段階決定（min-height 維持で枠は固定）
function _phraseFontSize(text) {
  const len = String(text || '').length;
  if (len <= 18) return 56;
  if (len <= 24) return 48;
  if (len <= 30) return 42;
  return 36;
}

function buildInsightHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  // catchphrases が優先。無ければ narrationChunks（chunk表示用）か title から
  const phrases = (Array.isArray(mod.catchphrases) && mod.catchphrases.length)
    ? mod.catchphrases.slice(0, 5)
    : (Array.isArray(mod.narrationChunks) ? mod.narrationChunks.slice(0, 5) : (mod.title ? [mod.title] : []));
  const insightTitle = mod.title || '注目ポイント';

  // ── phrase 登場タイミング：音声合計時間に均等分散（前後余裕付き）──
  //   従来は 0.2/1.2/2.2/3.2/4.2s 機械固定だったため、長尺音声で前半に偏ってた
  //   audio chunks があれば totalSec を引き出し、(totalSec - 2s) を phrases.length で等分
  const totalSec = (Array.isArray(mod.audio) && mod.audio.length)
    ? mod.audio.reduce((s, c) => s + (c.durationSec || 0), 0)
    : 8;
  // 最初の phrase は 0.5s 後、以降は等間隔。最後の phrase が音声末尾の 1.5s 前に出るよう調整
  const startSec = 0.5;
  const lastSec  = Math.max(totalSec - 1.5, startSec + 1);
  const span     = lastSec - startSec;
  const step     = phrases.length > 1 ? span / (phrases.length - 1) : 0;
  const delays   = phrases.map((_, i) => (startSec + step * i).toFixed(2));

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: ${PALETTE.bg};`}
  background-size: cover;
  background-position: center;
  ${bg ? 'animation: bgZoom 14s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.05); } }
.bg-overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    rgba(6, 14, 28, 0.92) 0%,
    rgba(6, 14, 28, 0.78) 50%,
    rgba(6, 14, 28, 0.60) 100%);
}
.insight-title {
  position: absolute;
  top: 70px;
  left: 80px;
  font-size: 52px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: 2px;
  text-shadow: 0 2px 14px rgba(0, 0, 0, 0.9);
  z-index: 5;
}
.catchphrases {
  position: absolute;
  top: 190px;
  left: 80px;
  right: 80px;
  bottom: 180px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 24px;
  z-index: 5;
}
.phrase {
  opacity: 0;
  transform: translateY(20px);
  animation: fadeInUp 0.8s ease-out forwards;

  display: flex;
  align-items: center;
  min-height: 96px;
  padding: 16px 40px;
  border-left: 12px solid ${PALETTE.accent};
  border-radius: 0 16px 16px 0;
  background: linear-gradient(to right,
    rgba(245, 158, 11, 0.22) 0%,
    rgba(245, 158, 11, 0.10) 30%,
    rgba(6, 14, 28, 0.35) 100%);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
  font-weight: 800;
  color: ${PALETTE.text};
  line-height: 1.3;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.8);
}
/* 数字+単位ハイライト：金色＋強グロー */
.hl-num {
  color: #fcd34d;
  font-weight: 900;
  text-shadow: 0 0 14px rgba(252, 211, 77, 0.7), 0 2px 10px rgba(0,0,0,0.8);
}
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(20px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

  const phrasesHtml = phrases.map((p, i) => {
    const fz = _phraseFontSize(p);
    const html = _highlightNumbers(esc(p));
    return `<div class="phrase" style="font-size:${fz}px;animation-delay:${delays[i]}s;">${html}</div>`;
  }).join('');

  const slideBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="insight-title">${esc(insightTitle)}</div>
<div class="catchphrases">
  ${phrasesHtml}
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildInsightHTML };
