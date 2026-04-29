// scripts/v2_video/slides/insight.js
// Insight スライド：キャッチコピーが上から順に登場（左からゴーストトレイル + 本体fadeIn）
// テンプレート元: /insight/index.html（プレビュー版から editor を除外して1920x1080 に最適化）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod } = require('./_common');

const MAX_PHRASES = 7;

// 数字+単位を黄色ハイライトで強調（"24ゴール" "5冠" "100億" 等）
function _highlightNumbers(escapedText) {
  return escapedText.replace(
    /([\d０-９]+(?:[\.,．，][\d０-９]+)?)\s*(試合|ゴール|得点|アシスト|億|万|歳|位|連勝|連敗|連覇|周年|シーズン|分|秒|度目|度|冠|勝|敗|引分|本|点|個|G|A|％|%)/g,
    '<span class="hl-num">$1$2</span>'
  );
}

// phrase 件数で min-height / gap / 最大フォントを動的調整
//   1〜7 件まで対応。container 高 710px に収まるよう調整
function _layoutForCount(n) {
  if (n <= 3) return { minHeight: 110, gap: 32, maxFont: 60 };
  if (n <= 5) return { minHeight: 96,  gap: 24, maxFont: 56 };
  if (n === 6) return { minHeight: 86, gap: 20, maxFont: 50 };
  return        { minHeight: 76,  gap: 16, maxFont: 44 };  // 7件
}

// phrase 文字長 + 件数から個別フォントサイズを決定
function _phraseFontSize(text, layout) {
  const len = String(text || '').length;
  const max = layout.maxFont;
  if (len <= 18) return max;
  if (len <= 24) return Math.max(max - 8,  32);
  if (len <= 30) return Math.max(max - 14, 30);
  return Math.max(max - 18, 28);
}

// catchphrase に含まれる重要トークン（数字+単位 / 2文字以上の語）を音声 chunk と照合し、
// ベストマッチの chunk index を返す（マッチ無しなら -1）
function _matchPhraseToChunk(phrase, chunks) {
  const tokens = String(phrase || '')
    .replace(/[の・はがをにでとや、。…!?！？「」『』【】（）\s〜ー]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
  if (!tokens.length || !chunks.length) return -1;
  let bestIdx = -1, bestScore = 0;
  chunks.forEach((c, i) => {
    const text = String(c.text || '');
    const score = tokens.reduce((s, tok) => s + (text.includes(tok) ? tok.length : 0), 0);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  return bestScore > 0 ? bestIdx : -1;
}

function buildInsightHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  // catchphrases が優先。無ければ narrationChunks か title から
  const phrasesRaw = (Array.isArray(mod.catchphrases) && mod.catchphrases.length)
    ? mod.catchphrases.slice(0, MAX_PHRASES)
    : (Array.isArray(mod.narrationChunks)
        ? mod.narrationChunks.slice(0, MAX_PHRASES)
        : (mod.title ? [mod.title] : []));
  const insightTitle = mod.title || '注目ポイント';
  const layout = _layoutForCount(phrasesRaw.length);

  // ── 登場タイミング決定 ───────────────────────────────────
  //   1. 各 phrase に対応する音声 chunk を substring match で探索
  //   2. マッチした phrase は chunk 開始時刻 + 0.3s で登場
  //   3. マッチ無しは均等分散値にフォールバック
  //   4. 検出された delay 順に画面上下を並べ替え（早く出る phrase が画面上）
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const totalSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 8;
  const chunkStarts = audio.map((_, i) =>
    audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));

  const startSec = 0.5;
  const lastSec  = Math.max(totalSec - 1.5, startSec + 1);
  const evenStep = phrasesRaw.length > 1 ? (lastSec - startSec) / (phrasesRaw.length - 1) : 0;

  // 1:1 対応を優先：chunks 数 == phrases 数なら index ベースで直接マッピング
  //   （AI が narrationChunks を catchphrases と同数で返した場合）
  const directMapping = audio.length === phrasesRaw.length;
  const tempDelays = phrasesRaw.map((p, i) => {
    if (directMapping) return chunkStarts[i] + 0.3;
    const cIdx = audio.length ? _matchPhraseToChunk(p, audio) : -1;
    return cIdx >= 0 ? chunkStarts[cIdx] + 0.3 : (startSec + evenStep * i);
  });

  // 検出 delay の昇順に index を並べ替え（同値は元順を維持）
  const orderIdx = phrasesRaw.map((_, i) => i)
    .sort((a, b) => (tempDelays[a] - tempDelays[b]) || (a - b));
  const phrases = orderIdx.map(i => phrasesRaw[i]);
  const delays  = orderIdx.map(i => tempDelays[i]);

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
  gap: ${layout.gap}px;
  z-index: 5;
}
/* ── 単一動作：左にちょっとずれた状態 + opacity0 → 元位置 + opacity1 ──
     本体が「すっと自然に左から入ってくる」演出。ghost 不要 */
.phrase {
  display: flex;
  align-items: center;
  min-height: ${layout.minHeight}px;
  padding: 12px 36px;
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
  opacity: 0;
  transform: translateX(-80px);
  animation: phraseSlideIn 0.6s ease-out forwards;
}
@keyframes phraseSlideIn {
  from { transform: translateX(-80px); opacity: 0; }
  to   { transform: translateX(0);     opacity: 1; }
}
/* 数字+単位ハイライト：金色＋強グロー */
.hl-num {
  color: #fcd34d;
  font-weight: 900;
  text-shadow: 0 0 14px rgba(252, 211, 77, 0.7), 0 2px 10px rgba(0,0,0,0.8);
}
`;

  const phrasesHtml = phrases.map((p, displayIdx) => {
    const fz   = _phraseFontSize(p, layout);
    const html = _highlightNumbers(esc(p));
    const d    = delays[displayIdx].toFixed(2);
    return `<div class="phrase" style="font-size:${fz}px;animation-delay:${d}s;">${html}</div>`;
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
