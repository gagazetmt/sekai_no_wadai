// launcher/slides/subtitles.js
// V3方式字幕バー：原文ナレーションを句読点で自然分割 → Whisper word timestamp で同期
//   - 表示テキストは「原文ナレーション」（ASR誤認識を画面に出さない）
//   - 「、。！？」で文節/文末区切り → 2行に収まる文字数でグループ化（自然な位置で区切る）
//   - 各グループを word timestamp で時間配分（二段=2行構成）
//   - 字幕はナレーション区間のみ（コメント読み上げ中は出さない）

const SUB_FONT_PX     = 50;
const SUB_LINE_HEIGHT = 1.2;
const SUB_LINE_PX     = Math.ceil(SUB_FONT_PX * SUB_LINE_HEIGHT);
const SUB_PADDING_PX  = 12;
const SUB_INNER_W_PX  = 1920 - 70 * 2;
const SUB_MIN_FONT_PX = 32;
const SUB_CHAR_W_RATIO = 1.10;

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _heightForLines(lineCount) {
  return SUB_LINE_PX * Math.max(1, lineCount) + SUB_PADDING_PX;
}
function _fontSizeForLines(lines) {
  const maxLen = lines.reduce((m, l) => Math.max(m, String(l || '').length), 0);
  if (maxLen === 0) return SUB_FONT_PX;
  const maxByFit = Math.floor(SUB_INNER_W_PX / (maxLen * SUB_CHAR_W_RATIO));
  return Math.max(SUB_MIN_FONT_PX, Math.min(SUB_FONT_PX, maxByFit));
}

// 日本語テキストを自然に2行分割（二段構成）
function splitSubtitle(text, maxLineLen = 20) {
  let t = String(text || '').trim();
  if (!t) return { lines: [] };

  if (t.length <= maxLineLen) return { lines: [t] };

  const candidates = [];
  const breaks = ['。', '！', '？', '!', '?', '、', ',', ' ', '・'];
  for (let i = Math.floor(t.length * 0.3); i < Math.floor(t.length * 0.7); i++) {
    if (breaks.includes(t[i])) candidates.push({ pos: i + 1, score: 10 - Math.abs(t.length / 2 - i) / 10 });
  }
  const verbEnds = ['だ', 'ます', 'です', 'のだ', 'んだ', 'けど', 'から', 'って'];
  for (const v of verbEnds) {
    let idx = t.indexOf(v);
    while (idx !== -1) {
      const end = idx + v.length;
      if (end > t.length * 0.3 && end < t.length * 0.7) candidates.push({ pos: end, score: 8 });
      idx = t.indexOf(v, idx + 1);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const splitAt = candidates.length ? candidates[0].pos : Math.floor(t.length / 2);

  let line1 = t.slice(0, splitAt).trim();
  let line2 = t.slice(splitAt).trim();

  const balanceRatio = Math.max(line1.length, line2.length) / Math.max(Math.min(line1.length, line2.length), 1);
  const tooShortTail = line2.length > 0 && line2.length < 4;
  if (tooShortTail || balanceRatio > 1.7) {
    const total = line1 + line2;
    const mid = Math.floor(total.length / 2);
    let bestPos = mid, bestDist = Infinity;
    for (let i = Math.floor(total.length * 0.4); i <= Math.floor(total.length * 0.6); i++) {
      if (breaks.includes(total[i])) { const d = Math.abs(mid - i); if (d < bestDist) { bestDist = d; bestPos = i + 1; } }
    }
    line1 = total.slice(0, bestPos).trim();
    line2 = total.slice(bestPos).trim();
  }
  return { lines: [line1, line2] };
}

// 原文を「、。！？」で文節分割 → 2行に収まる文字数でグループ化
function _groupNarration(text, groupChars) {
  let parts = String(text).split(/(?<=[、。！？!?])/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) parts = [String(text)];
  const groups = [];
  let cur = '';
  for (const p of parts) {
    // 1パートが長すぎる場合はそのまま1グループ（splitSubtitleが2行化）
    if (cur.length + p.length > groupChars && cur) { groups.push(cur); cur = ''; }
    cur += p;
  }
  if (cur) groups.push(cur);
  return groups;
}

// narration words から「文字位置 → 時刻」関数を構築
function _buildCharToTime(words, fullTextLen) {
  const charStart = [];
  let cumLen = 0;
  for (const w of words) {
    const wt = String(w.word || w.text || '');
    const start = typeof w.start === 'number' ? w.start : 0;
    for (let j = 0; j < wt.length; j++) charStart.push(start);
    cumLen += wt.length;
  }
  const wordsChars = cumLen || 1;
  return (charPos) => {
    const wp = Math.round((charPos / (fullTextLen || 1)) * wordsChars);
    return charStart[Math.min(Math.max(wp, 0), charStart.length - 1)] ?? 0;
  };
}

// narrationText(原文) + words(Whisper word timestamps) → 字幕バーHTML/CSS
//   opts: { leadPad, narrationDurSec, maxLineLen, segments }
//   segments があれば segment タイムスタンプ優先（speech-2.6-hd でより正確）
function buildSubtitleHTML(narrationText, words, totalDurationSec, opts = {}) {
  const text = String(narrationText || '').trim();
  if (!text) return { html: '', css: '' };

  const leadPad = opts.leadPad ?? 0;
  const maxLineLen = opts.maxLineLen || 20;
  const groupChars = maxLineLen * 2;
  const narrationDurSec = opts.narrationDurSec != null ? opts.narrationDurSec : null;
  const rawSegments = Array.isArray(opts.segments) ? opts.segments : [];

  // ナレーション区間の segment のみ（コメント区間のセグメントは除外）
  const narSegs = rawSegments.filter(s => typeof s.start === 'number'
    && (narrationDurSec == null || s.start < narrationDurSec + 0.4));

  const groups = _groupNarration(text, groupChars);
  let segs;

  if (narSegs.length > 0) {
    // ── Segment ベース（正確なタイムスタンプを使用） ──────────────
    // 原文グループをセグメント数に比例マッピング
    let cumChars = 0;
    segs = groups.map((g, i) => {
      const startFrac = cumChars / (text.length || 1);
      cumChars += g.length;

      const segIdx = Math.min(Math.floor(startFrac * narSegs.length), narSegs.length - 1);
      const nextSegIdx = Math.min(segIdx + 1, narSegs.length - 1);
      const startLocal = narSegs[segIdx].start;
      const isLast = i === groups.length - 1;
      const endLocal = isLast
        ? (narrationDurSec != null ? narrationDurSec : narSegs[segIdx].end)
        : narSegs[nextSegIdx].start;

      const { lines } = splitSubtitle(g, maxLineLen);
      return {
        idx: i,
        start: leadPad + startLocal,
        end:   leadPad + Math.max(startLocal + 0.3, endLocal),
        lines,
        fontSize: _fontSizeForLines(lines),
      };
    });
  } else {
    // ── フォールバック: word 比例マッピング ──────────────────────
    let nWords = Array.isArray(words) ? words.slice() : [];
    if (narrationDurSec != null) {
      nWords = nWords.filter(w => (typeof w.start === 'number' ? w.start : 0) < narrationDurSec + 0.4);
    }
    const hasWords = nWords.length > 1;
    const charToTime = hasWords
      ? _buildCharToTime(nWords, text.length || 1)
      : (cp) => (narrationDurSec || totalDurationSec || 1) * (cp / (text.length || 1));

    let charPos = 0;
    segs = groups.map((g, i) => {
      const startLocal = charToTime(charPos);
      charPos += g.length;
      const isLast = i === groups.length - 1;
      let endLocal = isLast
        ? (narrationDurSec != null ? narrationDurSec : charToTime(charPos))
        : charToTime(charPos);
      if (endLocal <= startLocal) endLocal = startLocal + 0.5;
      const { lines } = splitSubtitle(g, maxLineLen);
      return {
        idx: i,
        start: leadPad + startLocal,
        end:   leadPad + Math.max(startLocal + 0.3, endLocal),
        lines,
        fontSize: _fontSizeForLines(lines),
      };
    });
  }
  if (!segs.length) return { html: '', css: '' };

  const totalSec = totalDurationSec || (segs[segs.length - 1].end + 1);
  const FADE_SEC = 0.14;
  const fadePct = (FADE_SEC / totalSec) * 100;

  const maxLines = segs.reduce((m, s) => Math.max(m, s.lines.length), 1);
  const height = Math.max(110, _heightForLines(maxLines));

  const keyframes = segs.map(s => {
    const sPct = (s.start / totalSec) * 100;
    const ePct = (s.end / totalSec) * 100;
    const sIn = Math.min(sPct + fadePct, ePct);
    const eOut = Math.max(ePct - fadePct, sPct);
    return `@keyframes v2subc_${s.idx}{`
      + `0%{opacity:0;transform:translateY(14px);filter:blur(2px)}`
      + `${sPct.toFixed(3)}%{opacity:0;transform:translateY(14px);filter:blur(2px)}`
      + `${sIn.toFixed(3)}%{opacity:1;transform:translateY(0);filter:blur(0)}`
      + `${eOut.toFixed(3)}%{opacity:1;transform:translateY(0);filter:blur(0)}`
      + `${ePct.toFixed(3)}%{opacity:0;transform:translateY(-8px);filter:blur(1px)}`
      + `100%{opacity:0;transform:translateY(-8px);filter:blur(1px)}}`;
  }).join('\n');

  const chunkDivs = segs.map(s => {
    const linesHtml = s.lines.map(l => `<div>${_esc(l)}</div>`).join('');
    return `<div class="v2-sub-chunk" style="opacity:0;animation:v2subc_${s.idx} ${totalSec.toFixed(3)}s linear forwards;">`
      + `<div class="v2-sub-text" style="font-size:${s.fontSize}px;">${linesHtml}</div></div>`;
  }).join('');

  const css = `${keyframes}
.v2-sub-bar-wrapper{position:absolute;bottom:0;left:0;right:0;height:${height}px;background:linear-gradient(180deg,rgba(5,8,14,0.88),rgba(0,0,0,0.96));border-top:3px solid rgba(245,158,11,0.5);box-shadow:0 -18px 40px rgba(0,0,0,0.35);z-index:20;}
.v2-sub-chunk{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-top:8px;gap:2px;}
.v2-sub-text{color:#fff;font-size:${SUB_FONT_PX}px;font-weight:800;text-align:center;padding:0 70px;line-height:${SUB_LINE_HEIGHT};text-shadow:0 2px 14px rgba(0,0,0,0.9);}
.v2-sub-text > div{white-space:nowrap;}`;

  const html = `<div class="v2-sub-bar-wrapper">${chunkDivs}</div>`;
  return { html, css };
}

// slideHtml に字幕を注入。narrationText + words から構築（コメントは含まない）
function injectSubtitles(slideHtml, narrationText, words, totalDurationSec, opts = {}) {
  const { html, css } = buildSubtitleHTML(narrationText, words, totalDurationSec, opts);
  if (!html) return slideHtml;
  let result = slideHtml.replace('</style>', css + '\n</style>');
  result = result.replace(/(<\/div>)\s*(<\/body>)/, html + '\n$1$2');
  return result;
}

module.exports = { buildSubtitleHTML, injectSubtitles, splitSubtitle };
