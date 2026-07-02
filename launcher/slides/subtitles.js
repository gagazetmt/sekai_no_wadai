// launcher/slides/subtitles.js
// V3方式字幕バー：完全 Whisper 同期
//   - 表示テキストは原文ナレーション（ASR誤認識を画面に出さない）
//   - 原文 & Whisper words を同じ文字数ルールで並列グループ化
//   - テキストグループ i → 対応 word グループの word[0].start を字幕開始時刻に使用
//   - opening / ending は render.js 側でスキップ（字幕なし）

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
  let curLen = 0;
  for (const p of parts) {
    const pLen = p.replace(/\s/g, '').length;  // _groupWords と揃えてスペース除外
    if (curLen > 0 && curLen + pLen > groupChars) { groups.push(cur); cur = ''; curLen = 0; }
    cur += p;
    curLen += pLen;
  }
  if (cur) groups.push(cur);
  return groups;
}

// 原文の各文字 → Whisper由来の推定タイムスタンプ を編集距離アラインメントで求める。
// Whisperは同音異義語("得点"→"特典")や固有名詞("エムバペ"→"m","バ","ペ")を誤認識しやすく、
// 単純な文字数累積比率でマッピングすると誤認識区間の文字数差がそのままズレとして蓄積し、
// 後半になるほど字幕タイミングが音声からズレていく。編集距離アラインメントなら
// 誤認識区間だけを「不一致」としてスキップし、正しく認識できた文字で再同期できる。
function _alignTextToWhisperTime(textChars, words) {
  // words を文字単位に展開: 各wordの [start,end] をその文字数で均等按分
  const timeline = [];
  for (const w of words) {
    const wt = String(w.word || w.text || '').replace(/\s/g, '');
    if (!wt.length) continue;
    const s = w.start, e = Math.max(w.end, w.start);
    const span = e - s;
    for (let k = 0; k < wt.length; k++) {
      timeline.push({ ch: wt[k], t: span > 0 ? s + span * (k / wt.length) : s });
    }
  }
  const n = textChars.length;
  if (!timeline.length || !n) return textChars.map(() => null);

  const m = timeline.length;
  // 編集距離DP（置換/挿入/削除いずれもコスト1）
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = textChars[i - 1] === timeline[j - 1].ch ? 0 : 1;
      const del = dp[i - 1][j] + 1;
      const ins = dp[i][j - 1] + 1;
      const sub = dp[i - 1][j - 1] + cost;
      dp[i][j] = Math.min(del, ins, sub);
    }
  }
  // バックトレースで textIndex → timeline時刻 の対応を作る（一致/置換のペアのみ採用）
  const mapping = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const cost = textChars[i - 1] === timeline[j - 1].ch ? 0 : 1;
    if (dp[i][j] === dp[i - 1][j - 1] + cost) {
      mapping[i - 1] = timeline[j - 1].t;
      i--; j--;
    } else if (dp[i][j] === dp[i - 1][j] + 1) {
      i--; // 原文側の文字がWhisper側に対応なし(誤認識で消えた) → 後で前後から補間
    } else {
      j--; // Whisper側の余分な文字(誤認識で増えた) → 読み飛ばす
    }
  }
  // 未割当(誤認識区間)は前後の確定値から補間して埋める
  let lastT = timeline[0].t;
  for (let k = 0; k < n; k++) { if (mapping[k] == null) mapping[k] = lastT; else lastT = mapping[k]; }
  let nextT = timeline[timeline.length - 1].t;
  for (let k = n - 1; k >= 0; k--) { if (mapping[k] == null) mapping[k] = nextT; else nextT = mapping[k]; }
  return mapping;
}

// Whisper words を同じ文字数ルールでグループ化 → 各グループの先頭 word.start を使う
function _groupWords(words, groupChars) {
  const groups = [];
  let cur = { words: [], chars: 0 };
  for (const w of words) {
    const wt = String(w.word || w.text || '').replace(/\s/g, '');
    if (cur.chars > 0 && cur.chars + wt.length > groupChars) {
      groups.push(cur);
      cur = { words: [], chars: 0 };
    }
    cur.words.push(w);
    cur.chars += wt.length;
  }
  if (cur.words.length) groups.push(cur);
  return groups;
}

// narrationText(原文) + words(Whisper word timestamps) → 字幕バーHTML/CSS
//   原文を句読点分割 → Whisper words を同ルールでグループ化 → 実 word.start を使って完全同期
function buildSubtitleHTML(narrationText, words, totalDurationSec, opts = {}) {
  const text = String(narrationText || '').trim();
  if (!text) return { html: '', css: '' };

  const leadPad = opts.leadPad ?? 0;
  const maxLineLen = opts.maxLineLen || 20;
  const groupChars = maxLineLen * 2;
  const narrationDurSec = opts.narrationDurSec != null ? opts.narrationDurSec : null;

  const textGroups = _groupNarration(text, groupChars);
  let segs;

  // ナレーション区間の word のみ（コメント読み上げ中は除外）
  let nWords = Array.isArray(words) ? words.filter(w => typeof w.start === 'number') : [];
  if (narrationDurSec != null) {
    nWords = nWords.filter(w => w.start < narrationDurSec + 0.4);
  }

  if (nWords.length > 1) {
    // ── 編集距離アラインメントで原文の各文字にWhisper時刻を割り当てる ──────
    // 文字数累積比率だと、Whisperの誤認識(同音異義語・固有名詞の分解等)で
    // 生じた文字数差がそのままズレとして蓄積するため、アラインメントで
    // 誤認識区間を読み飛ばしつつ対応する時刻を求める
    const textNoSp = text.replace(/\s/g, '');
    const textChars = Array.from(textNoSp);
    const charTimeMap = _alignTextToWhisperTime(textChars, nWords);

    let cumTextChars = 0;

    segs = textGroups.map((g, i) => {
      const startIdx = Math.min(cumTextChars, charTimeMap.length - 1);
      const startLocal = charTimeMap[startIdx] ?? nWords[0].start;

      cumTextChars += g.replace(/\s/g, '').length;

      const isLast = i === textGroups.length - 1;
      let endLocal;
      if (isLast) {
        endLocal = narrationDurSec ?? nWords[nWords.length - 1].end;
      } else {
        const endIdx = Math.min(cumTextChars, charTimeMap.length - 1);
        endLocal = charTimeMap[endIdx] ?? startLocal + 1;
      }

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
    // ── フォールバック: duration 比例（words なし） ───────────────
    const dur = narrationDurSec || totalDurationSec || 1;
    let cumChars = 0;
    segs = textGroups.map((g, i) => {
      const startLocal = dur * (cumChars / (text.length || 1));
      cumChars += g.length;
      const isLast = i === textGroups.length - 1;
      const endLocal = isLast ? dur : dur * (cumChars / (text.length || 1));
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
