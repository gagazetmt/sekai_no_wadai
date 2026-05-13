// scripts/v2_video/slides/insight.js
// Insight スライド：キャッチコピーが上から順に登場（左からゴーストトレイル + 本体fadeIn）
// テンプレート元: /insight/index.html（プレビュー版から editor を除外して1920x1080 に最適化）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, LEAD_PAD_SEC, TAIL_PAD_SEC, imageAdjustCss } = require('./_common');

const MAX_PHRASES = 6;

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
  return        { minHeight: 86, gap: 20, maxFont: 50 };  // 6件
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

// 🆕 catchphrase テキストを chunk 原文内の文字位置で検索し、文字数比で発話時刻を推定
//   ASR 失敗時の fallback（words 無し + 1 chunk）用
function _matchPhraseToCharPosTime(phrase, chunk) {
  const target = String(phrase || '');
  const fullText = String(chunk?.text || '');
  const dur = Number(chunk?.durationSec) || 0;
  if (!fullText || !dur) return null;
  let pos = fullText.indexOf(target);
  if (pos < 0) {
    const tokens = target
      .replace(/[の・はがをにでとや、。…!?！？「」『』【】（）\s〜ー]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2)
      .sort((a, b) => b.length - a.length);
    for (const tok of tokens) {
      const p = fullText.indexOf(tok);
      if (p >= 0) { pos = p; break; }
    }
  }
  if (pos < 0) return null;
  return dur * (pos / fullText.length);
}

// 🆕 catchphrase テキストを words[] (Gemini ASR の word timestamps) と照合して
//   発話開始時刻 (秒) を返す。マッチ無しなら null
function _matchPhraseToWordTime(phrase, words) {
  if (!Array.isArray(words) || !words.length) return null;
  // words 連結テキスト + 文字位置 → word index の逆引き
  let cumText = '';
  const charToWordIdx = [];
  for (let i = 0; i < words.length; i++) {
    const wt = String(words[i].text || '');
    for (let j = 0; j < wt.length; j++) charToWordIdx.push(i);
    cumText += wt;
  }
  if (!cumText) return null;
  const target = String(phrase || '');
  // 1) 完全一致を試す
  let pos = cumText.indexOf(target);
  // 2) ダメなら token 単位（助詞・記号除去）の最長一致
  if (pos < 0) {
    const tokens = target
      .replace(/[の・はがをにでとや、。…!?！？「」『』【】（）\s〜ー]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2)
      .sort((a, b) => b.length - a.length);  // 長い token 優先
    for (const tok of tokens) {
      const p = cumText.indexOf(tok);
      if (p >= 0) { pos = p; break; }
    }
  }
  if (pos < 0 || pos >= charToWordIdx.length) return null;
  const wIdx = charToWordIdx[pos];
  return Number(words[wIdx]?.start) || 0;
}

function buildInsightHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  const imgAdj = imageAdjustCss(mod.imageAdjust);
  // catchphrases が優先。新スキーマ {text, chunkText} と旧スキーマ string[] 両対応
  //   text     : 画面に表示する短い見出し
  //   chunkText: narration の対応文1文（音声 chunk との照合に使う・あれば優先）
  // 無ければ narrationChunks か title から
  const phrasesRich = (Array.isArray(mod.catchphrases) && mod.catchphrases.length)
    ? mod.catchphrases.slice(0, MAX_PHRASES).map(p => ({
        text: (typeof p === 'string') ? p : String(p?.text || ''),
        chunkText: (typeof p === 'object' && p) ? String(p?.chunkText || '') : '',
      })).filter(p => p.text)
    : (Array.isArray(mod.narrationChunks)
        ? mod.narrationChunks.slice(0, MAX_PHRASES).map(t => ({ text: t, chunkText: t }))
        : (mod.title ? [{ text: mod.title, chunkText: '' }] : []));
  const phrasesRaw = phrasesRich.map(p => p.text);
  const insightTitle = mod.title || '注目ポイント';
  const layout = _layoutForCount(phrasesRaw.length);

  // ── 登場タイミング決定 ───────────────────────────────────
  //   1. 各 phrase の chunkText (or text) で音声 chunk を substring match
  //   2. マッチした phrase は chunk 開始時刻 + 0.3s で登場
  //   3. マッチ無しは均等分散値にフォールバック
  //   4. 検出された delay 順に画面上下を並べ替え（早く出る phrase が画面上）
  //   ※ 旧 directMapping (chunks数==phrases数で index 一致と仮定) は廃止。
  //      AI が narration に「前置き」や「繋ぎ」を含めると 1 段ずれる事故が発生したため、
  //      常に substring match を使う。
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  // 先頭 LEAD_PAD_SEC を chunkStarts に加算、totalSec も LEAD+TAIL 含む全体時間に揃える
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audio.length ? (audioSec + LEAD_PAD_SEC + TAIL_PAD_SEC) : 8;
  const chunkStarts = audio.map((_, i) =>
    LEAD_PAD_SEC + audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));

  const startSec = LEAD_PAD_SEC + 0.5;  // 音声無し時もリードに続いて出る
  const lastSec  = Math.max(totalSec - TAIL_PAD_SEC - 1, startSec + 1);
  const evenStep = phrasesRaw.length > 1 ? (lastSec - startSec) / (phrasesRaw.length - 1) : 0;

  // 🆕 word timestamps モード判定: 1 chunk + words[] あり → ASR ベースで高精度同期
  const useWordMode = audio.length === 1 && Array.isArray(audio[0]?.words) && audio[0].words.length > 1;
  // 🆕 文字位置 fallback: 1 chunk + words 無し（ASR 失敗 or 未取得）→ chunk.text 内の文字位置比で時刻推定
  const useCharPosFallback = audio.length === 1 && !useWordMode
    && audio[0]?.text && Number(audio[0]?.durationSec) > 0;
  const wordsForMatch = useWordMode ? audio[0].words : null;

  const tempDelays = phrasesRich.map((p, i) => {
    if (!audio.length) return startSec + evenStep * i;
    // chunkText があればそっちで照合（長文なので精度高い）、無ければ短い text
    const matchTarget = p.chunkText || p.text;
    if (useWordMode) {
      // word timestamps モード: phrase 発話時刻を words から取得（±0.2s 精度）
      const wTime = _matchPhraseToWordTime(matchTarget, wordsForMatch);
      return wTime != null ? (LEAD_PAD_SEC + wTime + 0.3) : (startSec + evenStep * i);
    }
    if (useCharPosFallback) {
      // ASR 失敗時 fallback: chunk 原文内の文字位置比で発話時刻を推定
      const cTime = _matchPhraseToCharPosTime(matchTarget, audio[0]);
      return cTime != null ? (LEAD_PAD_SEC + cTime + 0.3) : (startSec + evenStep * i);
    }
    // 従来 (chunk 複数) モード: chunk 開始時刻ベース
    const cIdx = _matchPhraseToChunk(matchTarget, audio);
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
  background-size: ${imgAdj.isDefault ? 'cover' : `${100 * imgAdj.zoom}% auto`};
  background-position: ${imgAdj.bgPosition};
  background-repeat: no-repeat;
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
