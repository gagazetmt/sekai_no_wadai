// scripts/v2_video/slides/_common.js
// 全スライドテンプレート共通のベース CSS・カラーパレット・ユーティリティ

const fs   = require('fs');
const path = require('path');

const W = 1920, H = 1080;

// 全スライド共通: 音声前後の無音インターバル
//   - 各スライド開始時、音声 / 字幕 / chunk 連動アニメは LEAD_PAD_SEC だけ遅らせて始まる
//   - 末尾も TAIL_PAD_SEC の余韻を取る（次スライド遷移までの呼吸）
//   - render.js の buildSlideAudio が先頭に silence pad、slideDurationMs が前後 pad を含めた長さを返す
//   2026-05-08: 1.5s → 1.43s に 5% 短縮（テンポ感UP）
//   2026-05-16: env で 0 化可能に (INTEGRATED_AUDIO_MODE で combined.mp3 直接利用時に使用)
//   2026-05-17 (修正): 2.43 → 1.43 に戻す
//     旧: 2.43 に上げて「スライド前後の暗転 +1秒」を実装したつもりだったが、
//         LEAD_PAD は音声前 silence であり、暗転（fadeblack）とは別物。
//         結果として xfade 1.5s 後に 0.93s の無音帯が発生 → 字幕ズレ感
//     新: LEAD/TAIL は元値、 暗転は render.js の TRANSITION_SEC (1.5→2.5) で +1秒
const LEAD_PAD_SEC = parseFloat(process.env.LEAD_PAD_SEC ?? '1.43');
const TAIL_PAD_SEC = parseFloat(process.env.TAIL_PAD_SEC ?? '1.43');

// 型3 ダークネイビー基調（全スライド共通）
const PALETTE = {
  bg:      '#060e1c',
  surface: '#0d1830',
  accent:  '#f59e0b',
  text:    '#ffffff',
  muted:   '#94a3b8',
  blue:    '#93c5fd',   // 対比左
  red:     '#fca5a5',   // 対比右
  green:   '#10b981',
};

// HTMLエスケープ
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 2026-05-18: 改行対応エスケープ
//   ユーザーが Step4 のテキストボックスで Enter で改行入力した場合 (\n)、
//   もしくは AI が JSON で "value": "...\\n..." と literal 文字列で返した場合、
//   どちらも <br> に変換して表示する。
//   esc() 後に変換することでタグ注入を防ぐ。
//
// 重要: 余分な改行を正規化する:
//   - 先頭・末尾の改行は除去（AI 出力に「スペイン\n」が混じると line-clamp 1 で省略事故）
//   - 連続改行 \n\n+ は 1 つにまとめる（過剰な空行を防止）
function _normNl(s) {
  return String(s ?? '')
    .replace(/\\n/g, '\n')        // literal \\n を実改行に
    .replace(/\r\n/g, '\n')       // CRLF を LF に
    .replace(/^\n+|\n+$/g, '')    // 先頭・末尾の改行除去
    .replace(/\n{2,}/g, '\n');    // 連続改行を 1 つに
}
function escBr(s) {
  return esc(_normNl(s)).replace(/\n/g, '<br>');
}
// 改行を含むか判定 (line-clamp の動的拡張用)
//   正規化後に改行が残ってるかで判定（末尾だけの改行は無視される）
function hasNewline(s) {
  return /\n/.test(_normNl(s));
}

// 画像を base64 で埋め込み（Puppeteer の file:// アクセス回避）
// ブラウザpreview用: `/` 始まりのパスはURLとしてそのまま返す（base64変換なし）
//   → mapImagesToModulePreview と組み合わせて使う
function imgDataUri(imgPath) {
  if (!imgPath) return null;
  if (imgPath.startsWith('data:'))    return imgPath; // already base64
  if (imgPath.startsWith('/'))        return imgPath; // HTTP URL, let browser fetch directly
  if (imgPath.startsWith('https://') || imgPath.startsWith('http://')) return imgPath; // 外部URL素通し
  try {
    // 絶対パスじゃなければプロジェクトルート基準で解決
    const abs = path.isAbsolute(imgPath)
      ? imgPath
      : path.join(__dirname, '..', '..', '..', imgPath.replace(/^\//, ''));
    if (!fs.existsSync(abs)) return null;
    const ext  = path.extname(abs).toLowerCase();
    const mime = ext === '.png'  ? 'image/png'
               : ext === '.svg'  ? 'image/svg+xml'
               : ext === '.webp' ? 'image/webp'
               : ext === '.gif'  ? 'image/gif'
               : 'image/jpeg';
    const b64  = fs.readFileSync(abs).toString('base64');
    return `data:${mime};base64,${b64}`;
  } catch (_) { return null; }
}

// 共通 HTML wrapper。slideBody にスライド本体を渡すと 1920×1080 の完全な HTML を返す
function wrapHTML({ slideBody, extraStyles = '' }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>V2 Slide</title>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: ${W}px;
  height: ${H}px;
  overflow: hidden;
  background: ${PALETTE.bg};
  font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", sans-serif;
}
.slide {
  width: ${W}px;
  height: ${H}px;
  position: relative;
  color: ${PALETTE.text};
  overflow: hidden;
}
.slide::before {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 18;
  background:
    radial-gradient(circle at 50% 45%, rgba(255,255,255,0.035), transparent 34%),
    radial-gradient(circle at 50% 50%, transparent 48%, rgba(0,0,0,0.42) 100%);
  mix-blend-mode: screen;
  opacity: 0.55;
}
.slide::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 19;
  background:
    linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(245,158,11,0.025), transparent 34%, rgba(96,165,250,0.018) 70%, transparent);
  background-size: 100% 5px, 220% 100%;
  opacity: 0.22;
  animation: v2AmbientShift 9s ease-in-out infinite alternate;
}
@keyframes v2AmbientShift {
  from { background-position: 0 0, 0% 0; opacity: 0.16; }
  to   { background-position: 0 6px, 100% 0; opacity: 0.25; }
}
${extraStyles}
</style>
</head>
<body>
<div class="slide">${slideBody}</div>
</body>
</html>`;
}

// mod.images[] を type 別に bgImage / leftImage / rightImage / homeImage / awayImage に展開
//   - opening/ending/insight/reaction/stats/history: bgImage = images[0]
//   - profile: bgImage(左カラム), awayImage(右カラム上 右側), homeImage(右カラム上 左側)
//   - comparison: leftImage = images[0], rightImage = images[1]
//   - matchcard: 既存ロゴ運用なのでスキップ
//   ※ leading "/" を剥がして imgDataUri が project-root 相対で解決できるようにする
function mapImagesToModule(mod) {
  if (!mod) return mod;
  const imgs = (Array.isArray(mod.images) ? mod.images : []).map(p => String(p || '').replace(/^\//, ''));
  if (!imgs.length) return mod;
  // m.images 自体も normalize 済みに置き換える
  //   理由: picture.js は m.images[0] を直接読むが、leading "/" 付きパスを渡すと
  //         imgDataUri 内の path.isAbsolute 判定で true となり (POSIX/Windows 両方)
  //         fs.existsSync がファイルシステムルートを探して null → 画像未選択になる
  const m = { ...mod, images: imgs };
  switch (mod.type) {
    case 'opening':
    case 'ending':
    case 'insight':
    case 'reaction':
    case 'stats':
    case 'history':
      if (!m.bgImage) m.bgImage = imgs[0];
      break;
    case 'profile':
      if (!m.bgImage)   m.bgImage   = imgs[0];   // 左カラム メイン
      if (!m.awayImage) m.awayImage = imgs[1];   // 右カラム上 右側
      if (!m.homeImage) m.homeImage = imgs[2];   // 右カラム上 左側
      break;
    case 'comparison':
      if (!m.leftImage)  m.leftImage  = imgs[0];
      if (!m.rightImage) m.rightImage = imgs[1];
      break;
    case 'matchcard':
      // 既存運用維持
      break;
    default:
      if (!m.bgImage) m.bgImage = imgs[0];
  }
  return m;
}

// ブラウザpreview用: 画像をURLパスとして渡す（base64変換しない）
//   imgDataUri が `/` 始まりのパスをそのまま返すため、
//   スライドビルダーが imgDataUri(m.bgImage) しても軽量なURLが返る
function mapImagesToModulePreview(mod) {
  if (!mod) return mod;
  const imgs = (Array.isArray(mod.images) ? mod.images : [])
    .map(p => {
      const clean = String(p || '').replace(/^\/+/, '');
      return clean ? '/' + clean : null;
    })
    .filter(Boolean);
  if (!imgs.length) return mod;
  const m = { ...mod, images: imgs };
  switch (mod.type) {
    case 'opening': case 'ending': case 'insight': case 'reaction':
    case 'stats':   case 'history':
      if (!m.bgImage) m.bgImage = imgs[0];
      break;
    case 'profile':
      if (!m.bgImage)   m.bgImage   = imgs[0];
      if (!m.awayImage) m.awayImage = imgs[1];
      if (!m.homeImage) m.homeImage = imgs[2];
      break;
    case 'comparison':
      if (!m.leftImage)  m.leftImage  = imgs[0];
      if (!m.rightImage) m.rightImage = imgs[1];
      break;
    default:
      if (!m.bgImage) m.bgImage = imgs[0];
  }
  return m;
}

// 字幕テキストを 2 行に自然分割（日本語向け、各行〜20文字目安）
//   - 入力が長すぎる場合は最初の文 (。！？で終わる) または ~40文字 で truncate
//   - 句読点・スペース・「だ」「ます」「です」「！」「？」等の区切りを優先
//   - 区切りなければ中央付近で強制分割
function splitSubtitle(text, maxLineLen = 20) {
  let t = String(text || '').trim();
  if (!t) return { lines: [], fontSize: null };

  // ── 長文を最初の文で truncate ──
  const TARGET_TOTAL = maxLineLen * 2;
  if (t.length > TARGET_TOTAL + 10) {
    // 最初の強い区切り（。！？!?）を探す
    const m = t.match(/^([\s\S]{1,55}?[。！？!?])/);
    if (m && m[1].length <= TARGET_TOTAL + 15) {
      t = m[1].trim();
    } else {
      // 強い区切りがなければ TARGET_TOTAL で読点系で切る
      const softIdx = (function() {
        const soft = ['、', ',', ' ', '・'];
        for (let i = Math.min(TARGET_TOTAL + 5, t.length - 1); i > TARGET_TOTAL * 0.5; i--) {
          if (soft.includes(t[i])) return i;
        }
        return -1;
      })();
      t = (softIdx > 0 ? t.slice(0, softIdx) : t.slice(0, TARGET_TOTAL)).trim();
    }
  }

  if (t.length <= maxLineLen) return { lines: [t], fontSize: null };

  // 自然な区切り候補（位置, 強さ）を抽出
  const candidates = [];
  const breaks = ['。', '！', '？', '!', '?', '、', ',', ' ', '・'];
  for (let i = Math.floor(t.length * 0.3); i < Math.floor(t.length * 0.7); i++) {
    if (breaks.includes(t[i])) candidates.push({ pos: i + 1, score: 10 - Math.abs(t.length / 2 - i) / 10 });
  }
  // 動詞の末尾「だ」「だ。」「ます」「です」も自然区切り
  const verbEnds = ['だ', 'ます', 'です', 'のだ', 'んだ'];
  for (const v of verbEnds) {
    let idx = t.indexOf(v);
    while (idx !== -1) {
      const end = idx + v.length;
      if (end > t.length * 0.3 && end < t.length * 0.7) {
        candidates.push({ pos: end, score: 8 });
      }
      idx = t.indexOf(v, idx + 1);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const splitAt = candidates.length ? candidates[0].pos : Math.floor(t.length / 2);

  let line1 = t.slice(0, splitAt).trim();
  let line2 = t.slice(splitAt).trim();

  // ── オーファン回避 ＆ 偏り是正 ──
  //   1) line2 が 1〜3字 (極端に短い): "...まし\nた" のような 1字 trail
  //   2) 偏り比率 > 1.7倍: "ご視聴いただ(6)\nきありがとうございました(11)" のような verbEnd 過剰反応
  //   どちらの場合も中央寄りに rebalance する
  const balanceRatio = Math.max(line1.length, line2.length) /
                        Math.max(Math.min(line1.length, line2.length), 1);
  const tooShortTail = line2.length > 0 && line2.length < 4;
  if (tooShortTail || balanceRatio > 1.7) {
    const total = line1 + line2;
    const mid = Math.floor(total.length / 2);
    const breaks = ['。', '！', '？', '!', '?', '、', ',', ' ', '・'];
    let bestPos = mid;
    let bestDist = Infinity;
    // 中央 40-60% で natural break を再探索（見つからなければ midpoint）
    for (let i = Math.floor(total.length * 0.4); i <= Math.floor(total.length * 0.6); i++) {
      if (breaks.includes(total[i])) {
        const d = Math.abs(mid - i);
        if (d < bestDist) { bestDist = d; bestPos = i + 1; }
      }
    }
    line1 = total.slice(0, bestPos).trim();
    line2 = total.slice(bestPos).trim();
  }

  return { lines: [line1, line2], fontSize: null };
}

// 字幕バー HTML を生成（共通）
//   引数1: テキスト文字列 OR チャンク配列 [{ text, durationSec }, ...]
//   options.height（px）: 字幕バー高さ。デフォルト 110
//   options.maxLineLen   : 1行最大文字数。デフォルト 32
//   options.leadPadMs    : 先頭の無音時間ms（音声側 LEAD_PAD と揃える）。デフォルト LEAD_PAD_SEC*1000
//   options.tailPadMs    : 末尾余韻ms（音声側 TAIL_PAD と揃える）。デフォルト TAIL_PAD_SEC*1000
//
// 文字列が渡された場合（or items が1つだけ）は静的字幕。lead/tail パディングを跨いで常時表示。
// チャンク配列が複数の場合は各チャンクのテキストを音声タイミングに合わせて切替表示。
// フォント定数 (50px) / line-height 1.2 = 1行 60px
//   1行: 60 + padding 12 = 72px (実際は minHeight 110 で打ち切り)
//   2行: 120 + padding 12 = 132px
//   3行: 180 + padding 12 = 192px
const SUB_FONT_PX     = 50;
const SUB_LINE_HEIGHT = 1.2;
const SUB_LINE_PX     = Math.ceil(SUB_FONT_PX * SUB_LINE_HEIGHT);  // 60
const SUB_PADDING_PX  = 12;
const SUB_INNER_W_PX  = 1920 - 70 * 2;  // padding 70 を引いた描画幅 = 1780
const SUB_MIN_FONT_PX = 32;             // 縮小下限（これ以上小さくしない）
const SUB_CHAR_W_RATIO = 1.10;          // 太字日本語の実測経験値（折返し回避の安全係数込み）
function _heightForLines(lineCount) {
  return SUB_LINE_PX * Math.max(1, lineCount) + SUB_PADDING_PX;
}
// 2026-05-19: 字幕「3行はみ出し」対策
//   各行が SUB_INNER_W_PX に収まるフォントサイズを算出。SUB_FONT_PX を超えず、SUB_MIN_FONT_PX を下回らない
//   buildSubtitleBar の各 chunk / 静的字幕パスで個別に適用
function _fontSizeForLines(lines) {
  const maxLen = lines.reduce((m, l) => Math.max(m, String(l || '').length), 0);
  if (maxLen === 0) return SUB_FONT_PX;
  const maxByFit = Math.floor(SUB_INNER_W_PX / (maxLen * SUB_CHAR_W_RATIO));
  return Math.max(SUB_MIN_FONT_PX, Math.min(SUB_FONT_PX, maxByFit));
}

function buildSubtitleBar(textOrChunks, options = {}) {
  const minHeight  = options.height || 110;
  const maxLineLen = options.maxLineLen || 20;
  const leadPadSec = (options.leadPadMs ?? LEAD_PAD_SEC * 1000) / 1000;
  const tailPadSec = (options.tailPadMs ?? TAIL_PAD_SEC * 1000) / 1000;
  const syncOffsetSec = Number(options.syncOffsetSec ?? process.env.SUBTITLE_SYNC_OFFSET_SEC ?? 0) || 0;

  // 🆕 単一 chunk + (words[] あり or 無し) → 原文ナレーションを字幕単位に分割
  //   words あり: 字幕タイミングを ASR の word timestamps で完全同期（2026-05-14）
  //   words 無し: 原文の文字位置比で時間配分（ASR 失敗時 fallback）
  //   ⚠️ 字幕に表示するテキストは「原文ナレーション」(chunk.text) であって、ASR の認識結果ではない
  //      ASR は誤認識（W杯→WPF など）を含むので、画面には絶対に出さない
  if (Array.isArray(textOrChunks) && textOrChunks.length === 1
      && textOrChunks[0]?.text && Number(textOrChunks[0]?.durationSec) > 0) {
    const chunk = textOrChunks[0];
    const fullText = String(chunk.text);
    const groupChars = maxLineLen * 2;  // 2 行収まる文字数

    // 原文を「、」「。」で文末/節末分割し、字幕単位に再結合
    let parts = fullText.split(/(?<=[、。！？!?])/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) parts = [fullText];
    const groups = [];
    let curText = '';
    for (const p of parts) {
      if (curText.length + p.length > groupChars && curText) {
        groups.push(curText);
        curText = '';
      }
      curText += p;
    }
    if (curText) groups.push(curText);

    if (groups.length > 1) {
      // 各 group の開始時刻を決定
      //   words あり: 文字位置 → words 連結内の同比率位置の word.start を取得
      //   words 無し: chunk.durationSec を文字数比で按分（線形配分）
      const hasWords = Array.isArray(chunk.words) && chunk.words.length > 1;
      let charToTime;
      if (hasWords) {
        let wordsCumText = '';
        const wordsCharToStart = [];
        for (const w of chunk.words) {
          const wt = String(w.text || '');
          for (let j = 0; j < wt.length; j++) wordsCharToStart.push(w.start);
          wordsCumText += wt;
        }
        const wordsTotalChars = wordsCumText.length || 1;
        const totalChars = fullText.length || 1;
        charToTime = (charPos) => {
          const wordsPos = Math.round((charPos / totalChars) * wordsTotalChars);
          return wordsCharToStart[Math.min(wordsPos, wordsCharToStart.length - 1)] || 0;
        };
      } else {
        const totalChars = fullText.length || 1;
        const dur = Number(chunk.durationSec) || 1;
        charToTime = (charPos) => dur * (charPos / totalChars);
      }

      let charPos = 0;
      const pseudoChunks = groups.map((g, i) => {
        const startSec = charToTime(charPos);
        charPos += g.length;
        const endSec = i < groups.length - 1
          ? charToTime(charPos)
          : Number(chunk.durationSec) || (startSec + 1);
        return {
          text: g,
          // 2026-05-17: startSec を保持 (mp3 内 LOCAL 時刻、word.start ベース)
          //   下流の items 経路で leadPadSec + startSec を絶対時刻に使う
          //   これ無しだと group[0] の breath 分 (~0.4s) 早く字幕が出てズレ感
          startSec: startSec,
          durationSec: Math.max(0.3, endSec - startSec),
        };
      });
      return buildSubtitleBar(pseudoChunks, options);
    }
  }

  // チャンク配列 → タイミング連動字幕
  if (Array.isArray(textOrChunks) && textOrChunks.length) {
    const items = textOrChunks
      .map(c => ({
        text: String(c?.text || '').trim(),
        durationSec: Number(c?.durationSec) || 0,
        startSec: c?.startSec != null ? Number(c.startSec) : null,
      }))
      .filter(c => c.text);
    if (items.length === 0) return '';
    if (items.length === 1) return buildSubtitleBar(items[0].text, options);

    // 2026-05-17: c.startSec があれば mp3 内 LOCAL 時刻として活用
    //   start = leadPadSec + c.startSec (絶対時刻、 音声 breath を考慮)
    //   無ければ従来の累積方式 (durationSec を順に積み上げ)
    let cum = leadPadSec;
    const segs = items.map((c, i) => {
      const start = Math.max(0, (c.startSec != null ? (leadPadSec + c.startSec) : cum) + syncOffsetSec);
      cum = start + (Number(c.durationSec) || 0);
      const end = cum;
      const { lines } = splitSubtitle(c.text, maxLineLen);
      const fontSize = _fontSizeForLines(lines);
      return { idx: i, start, end, lines, fontSize };
    });
    const totalSec = cum + tailPadSec;
    if (totalSec <= 0) return buildSubtitleBar(items[0].text, options);

    // 全 chunk の最大行数からバー高さを決定（はみ出し時は上に拡張）
    const maxLines = segs.reduce((m, s) => Math.max(m, s.lines.length), 1);
    const height   = Math.max(minHeight, _heightForLines(maxLines));

    const FADE_SEC = 0.12;
    const fadePct  = (FADE_SEC / totalSec * 100);

    const keyframes = segs.map(s => {
      const sPct = (s.start / totalSec * 100);
      const ePct = (s.end / totalSec * 100);
      const sIn  = Math.min(sPct + fadePct, ePct);
      const eOut = Math.max(ePct - fadePct, sPct);
      return `@keyframes v2subc_${s.idx} {`
        + `0%{opacity:0;transform:translateY(12px);filter:blur(2px)}`
        + `${sPct.toFixed(3)}%{opacity:0;transform:translateY(12px);filter:blur(2px)}`
        + `${sIn.toFixed(3)}%{opacity:1;transform:translateY(0);filter:blur(0)}`
        + `${eOut.toFixed(3)}%{opacity:1;transform:translateY(0);filter:blur(0)}`
        + `${ePct.toFixed(3)}%{opacity:0;transform:translateY(-8px);filter:blur(1px)}`
        + `100%{opacity:0;transform:translateY(-8px);filter:blur(1px)}}`;
    }).join('\n');

    const chunkDivs = segs.map(s => {
      const linesHtml = s.lines.map(l => `<div>${esc(l)}</div>`).join('');
      return `<div class="v2-sub-chunk" style="opacity:0;animation:v2subc_${s.idx} ${totalSec.toFixed(3)}s linear forwards;">`
        + `<div class="v2-sub-text" style="font-size:${s.fontSize}px;">${linesHtml}</div></div>`;
    }).join('');

    return `<style>${keyframes}
      .v2-sub-bar-wrapper{position:absolute;bottom:0;left:0;right:0;height:${height}px;background:linear-gradient(180deg,rgba(5,8,14,0.88),rgba(0,0,0,0.96));border-top:3px solid rgba(245,158,11,0.5);box-shadow:0 -18px 40px rgba(0,0,0,0.35);z-index:20;}
      .v2-sub-chunk{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding-top:8px;}
      .v2-sub-text{color:#fff;font-size:${SUB_FONT_PX}px;font-weight:800;text-align:center;padding:0 70px;line-height:${SUB_LINE_HEIGHT};text-shadow:0 2px 14px rgba(0,0,0,0.9);}
      .v2-sub-text > div{white-space:nowrap;}
    </style><div class="v2-sub-bar-wrapper">${chunkDivs}</div>`;
  }

  // 従来パス（単一テキスト・静的字幕）
  const t = String(textOrChunks || '').trim();
  if (!t) return '';
  const { lines } = splitSubtitle(t, maxLineLen);
  const fontSize = _fontSizeForLines(lines);
  const height = Math.max(minHeight, _heightForLines(lines.length));
  const linesHtml = lines.map(l => `<div style="white-space:nowrap">${esc(l)}</div>`).join('');

  return `<div class="v2-sub-bar" style="position:absolute;bottom:0;left:0;right:0;height:${height}px;`
    + `background:linear-gradient(180deg,rgba(5,8,14,0.88),rgba(0,0,0,0.96));border-top:3px solid rgba(245,158,11,0.5);box-shadow:0 -18px 40px rgba(0,0,0,0.35);`
    + `display:flex;align-items:center;justify-content:center;padding-top:8px;z-index:20">`
    + `<div style="color:#fff;font-size:${fontSize}px;font-weight:800;text-align:center;`
    + `padding:0 70px;line-height:${SUB_LINE_HEIGHT};text-shadow:0 2px 14px rgba(0,0,0,0.9);">${linesHtml}</div></div>`;
}

// modから「字幕の入力」を作る。audioチャンクがあれば配列、無ければ narration 文字列。
// overlayComments 付きスライド: ナレーションチャンクのみ字幕対象（transition・コメントは除外）
function subtitleArgFromMod(mod) {
  if (mod && Array.isArray(mod.audio) && mod.audio.length) {
    let audioForSub = mod.audio;
    if (Array.isArray(mod.overlayComments) && mod.overlayComments.length) {
      const narrText = String(mod.narration || '').trim();
      const narrCount = narrText ? 1 : 0;
      audioForSub = mod.audio.slice(0, narrCount);
      if (!audioForSub.length) return mod?.narration || '';
    }
    if (audioForSub.length > 1) return audioForSub;
    if (audioForSub.length === 1
        && Number(audioForSub[0]?.durationSec) > 0
        && String(audioForSub[0]?.text || '').trim()) {
      return audioForSub;
    }
  }
  return mod?.narration || '';
}

// ═══════════════════════════════════════════════════════════
// 全スライド共通: 大会名/会場/チーム名 → 日本語化マップ
// ═══════════════════════════════════════════════════════════
const I18N = {
  // 大会
  'FA Cup': 'FAカップ',
  'EFL Cup': 'リーグカップ',
  'Premier League': 'プレミアリーグ',
  'La Liga': 'ラ・リーガ',                    'LaLiga': 'ラ・リーガ',
  'Bundesliga': 'ブンデスリーガ',
  'Serie A': 'セリエA',
  'Ligue 1': 'リーグ・アン',
  'Eredivisie': 'エールディヴィジ',
  'UEFA Champions League': 'UEFAチャンピオンズリーグ',  'Champions League': 'チャンピオンズリーグ',
  'UEFA Europa League': 'UEFAヨーロッパリーグ',         'Europa League': 'ヨーロッパリーグ',
  'UEFA Conference League': 'UEFAカンファレンスリーグ',
  'FIFA World Cup': 'FIFAワールドカップ',
  'UEFA European Championship': 'UEFA欧州選手権',
  'Copa America': 'コパ・アメリカ',
  'Copa del Rey': 'コパ・デル・レイ',
  'DFB-Pokal': 'DFBポカール',
  'Coppa Italia': 'コッパ・イタリア',
  'Coupe de France': 'クープ・ドゥ・フランス',
  'Supercopa de España': 'スーパーコパ・デ・エスパーニャ',
  'Community Shield': 'コミュニティ・シールド',
  // 会場
  'Wembley Stadium': 'ウェンブリー',                    'Wembley': 'ウェンブリー',
  'Old Trafford': 'オールド・トラッフォード',
  'Anfield': 'アンフィールド',
  'Etihad Stadium': 'エティハド',
  'Stamford Bridge': 'スタンフォード・ブリッジ',
  'Emirates Stadium': 'エミレーツ',
  'Tottenham Hotspur Stadium': 'トッテナム・ホットスパー・スタジアム',
  'St. James\' Park': 'セント・ジェームズ・パーク',
  'Goodison Park': 'グディソン・パーク',
  'Santiago Bernabéu': 'サンチアゴ・ベルナベウ',
  'Camp Nou': 'カンプ・ノウ',                            'Spotify Camp Nou': 'カンプ・ノウ',
  'Wanda Metropolitano': 'メトロポリターノ',             'Cívitas Metropolitano': 'メトロポリターノ',
  'Allianz Arena': 'アリアンツ・アレーナ',
  'Signal Iduna Park': 'ジグナル・イドゥナ・パルク',
  'San Siro': 'サン・シーロ',                            'Giuseppe Meazza': 'サン・シーロ',
  'Allianz Stadium': 'アリアンツ・スタジアム',
  'Stadio Olimpico': 'スタディオ・オリンピコ',
  'Parc des Princes': 'パルク・デ・プランス',
  // 主要チーム（プレミア）
  'Manchester City': 'マンチェスター・シティ',
  'Manchester United': 'マンチェスター・ユナイテッド',
  'Liverpool': 'リヴァプール',
  'Arsenal': 'アーセナル',
  'Chelsea': 'チェルシー',
  'Tottenham Hotspur': 'トッテナム',                      'Tottenham': 'トッテナム',
  'Newcastle United': 'ニューカッスル',                   'Newcastle': 'ニューカッスル',
  'Aston Villa': 'アストン・ヴィラ',
  'West Ham United': 'ウェストハム',                      'West Ham': 'ウェストハム',
  'Brighton & Hove Albion': 'ブライトン',                 'Brighton': 'ブライトン',
  'Crystal Palace': 'クリスタル・パレス',
  'Everton': 'エヴァートン',
  'Wolverhampton Wanderers': 'ウルブス',                  'Wolves': 'ウルブス',
  'Brentford': 'ブレントフォード',
  'Fulham': 'フラム',
  'Bournemouth': 'ボーンマス',
  'Nottingham Forest': 'ノッティンガム・フォレスト',
  'Leicester City': 'レスター',                           'Leicester': 'レスター',
  'Leeds United': 'リーズ',
  'Southampton': 'サウサンプトン',
  // ラ・リーガ
  'Real Madrid': 'レアル・マドリード',                    'Real Madrid CF': 'レアル・マドリード',
  'Barcelona': 'バルセロナ',                              'FC Barcelona': 'バルセロナ',
  'Atlético Madrid': 'アトレティコ・マドリード',          'Atletico Madrid': 'アトレティコ・マドリード',
  'Atlético de Madrid': 'アトレティコ・マドリード',
  'Real Betis': 'ベティス',
  'Real Sociedad': 'レアル・ソシエダ',
  'Athletic Bilbao': 'ビルバオ',                          'Athletic Club': 'ビルバオ',
  'Sevilla': 'セビージャ',
  'Valencia': 'バレンシア',
  'Villarreal': 'ビジャレアル',
  // ブンデスリーガ
  'Bayern Munich': 'バイエルン・ミュンヘン',              'FC Bayern München': 'バイエルン・ミュンヘン',
  'Borussia Dortmund': 'ドルトムント',
  'RB Leipzig': 'ライプツィヒ',
  'Bayer Leverkusen': 'レヴァークーゼン',
  'Eintracht Frankfurt': 'フランクフルト',
  'Borussia Mönchengladbach': 'ボルシアMG',
  // セリエA
  'Juventus': 'ユヴェントス',
  'Inter': 'インテル',                                    'Inter Milan': 'インテル',
  'AC Milan': 'ミラン',                                   'Milan': 'ミラン',
  'Napoli': 'ナポリ',
  'Roma': 'ローマ',                                       'AS Roma': 'ローマ',
  'Lazio': 'ラツィオ',
  'Atalanta': 'アタランタ',
  // リーグ・アン
  'PSG': 'パリ・サン＝ジェルマン',                        'Paris Saint-Germain': 'パリ・サン＝ジェルマン',
  'Marseille': 'マルセイユ',                              'Olympique de Marseille': 'マルセイユ',
  'Lyon': 'リヨン',                                       'Olympique Lyonnais': 'リヨン',
  'Monaco': 'モナコ',                                     'AS Monaco': 'モナコ',
};
function _t(s) { return s == null ? '' : (I18N[String(s).trim()] || s); }

// ═══════════════════════════════════════════════════════════
// チーム名 → 3文字略称（matchcard専用、他スライドでは未使用）
// ═══════════════════════════════════════════════════════════
const TEAM_ABBR = {
  'Manchester City': 'MCI', 'Manchester United': 'MUN', 'Liverpool': 'LIV', 'Arsenal': 'ARS', 'Chelsea': 'CHE',
  'Tottenham Hotspur': 'TOT', 'Tottenham': 'TOT', 'Newcastle United': 'NEW', 'Newcastle': 'NEW',
  'Aston Villa': 'AVL', 'West Ham United': 'WHU', 'West Ham': 'WHU', 'Brighton & Hove Albion': 'BHA', 'Brighton': 'BHA',
  'Crystal Palace': 'CRY', 'Everton': 'EVE', 'Wolverhampton Wanderers': 'WOL', 'Wolves': 'WOL',
  'Brentford': 'BRE', 'Fulham': 'FUL', 'Bournemouth': 'BOU', 'Nottingham Forest': 'NFO',
  'Leicester City': 'LEI', 'Leicester': 'LEI', 'Leeds United': 'LEE', 'Southampton': 'SOU',
  'Burnley': 'BUR', 'Sheffield United': 'SHU',
  'Real Madrid': 'RMA', 'Real Madrid CF': 'RMA', 'Barcelona': 'BAR', 'FC Barcelona': 'BAR',
  'Atlético Madrid': 'ATM', 'Atletico Madrid': 'ATM', 'Atlético de Madrid': 'ATM',
  'Real Betis': 'BET', 'Real Sociedad': 'RSO', 'Athletic Bilbao': 'ATH', 'Athletic Club': 'ATH',
  'Sevilla': 'SEV', 'Valencia': 'VAL', 'Villarreal': 'VIL',
  'Bayern Munich': 'BAY', 'FC Bayern München': 'BAY', 'Borussia Dortmund': 'BVB',
  'RB Leipzig': 'RBL', 'Bayer Leverkusen': 'B04', 'Eintracht Frankfurt': 'SGE', 'Borussia Mönchengladbach': 'BMG',
  'Juventus': 'JUV', 'Inter': 'INT', 'Inter Milan': 'INT', 'AC Milan': 'MIL', 'Milan': 'MIL',
  'Napoli': 'NAP', 'Roma': 'ROM', 'AS Roma': 'ROM', 'Lazio': 'LAZ', 'Atalanta': 'ATA',
  'PSG': 'PSG', 'Paris Saint-Germain': 'PSG', 'Marseille': 'OM', 'Olympique de Marseille': 'OM',
  'Lyon': 'OL', 'Olympique Lyonnais': 'OL', 'Monaco': 'MON', 'AS Monaco': 'MON',
};
function _abbr(name) {
  if (!name) return '???';
  const trimmed = String(name).trim();
  if (TEAM_ABBR[trimmed]) return TEAM_ABBR[trimmed];
  const cleaned = trimmed.replace(/^(FC|AC|AS|SC|SK|RC|CD)\s+/i, '');
  const words = cleaned.split(/\s+/);
  if (words.length >= 2) return words.map(w => w[0] || '').join('').slice(0, 3).toUpperCase();
  return cleaned.slice(0, 3).toUpperCase();
}

// ═══════════════════════════════════════════════════════════
// 選手名 → カタカナ短縮（マップ外は last word のみ）
// ═══════════════════════════════════════════════════════════
const PLAYER_NAMES = {
  // === Manchester City ===
  'Ederson': 'エデルソン', 'James Trafford': 'トラッフォード', 'Stefan Ortega': 'オルテガ',
  'Rúben Dias': 'ディアス', 'Ruben Dias': 'ディアス', 'John Stones': 'ストーンズ', 'Manuel Akanji': 'アカンジ',
  'Joško Gvardiol': 'グヴァルディオル', 'Josko Gvardiol': 'グヴァルディオル',
  'Nathan Aké': 'アケ', 'Nathan Ake': 'アケ',
  'Rayan Aït-Nouri': 'アイト＝ヌーリ', 'Rayan Ait-Nouri': 'アイト＝ヌーリ',
  'Kyle Walker': 'ウォーカー', 'Rodri': 'ロドリ',
  'Mateo Kovačić': 'コヴァチッチ', 'Mateo Kovacic': 'コヴァチッチ',
  'Matheus Nunes': 'M.ヌネス', 'Tijani Reijnders': 'レイナース', 'Bernardo Silva': 'B.シウバ',
  'Phil Foden': 'フォーデン', 'Kevin De Bruyne': 'デ・ブライネ', 'Jack Grealish': 'グリーリッシュ',
  'Rayan Cherki': 'シェルキ', 'Savinho': 'サビーニョ',
  'Jérémy Doku': 'ドク', 'Jeremy Doku': 'ドク',
  'Erling Haaland': 'ハーランド', 'Omar Marmoush': 'マルムーシュ',
  'Nico González': 'N.ゴンサレス', 'Nico Gonzalez': 'N.ゴンサレス',
  'Ilkay Gündoğan': 'ギュンドアン', 'Ilkay Gundogan': 'ギュンドアン',
  // === Southampton ===
  'Aaron Ramsdale': 'ラムズデール', 'Gavin Bazunu': 'バズヌ', 'Alex McCarthy': 'マッカーシー',
  'Kyle Walker-Peters': 'ウォーカー＝ピータース', 'Jan Bednarek': 'ベドナレク',
  'Taylor Harwood-Bellis': 'ハーウッド＝ベリス',
  'Welington': 'ウェリントン', 'Wellington': 'ウェリントン',
  'James Bree': 'ブリー', 'Nathan Wood': 'ウッド', 'Mateus Fernandes': 'M.フェルナンデス',
  'Flynn Downes': 'ダウンズ', 'Adam Lallana': 'ララーナ', 'Joe Aribo': 'アリボ',
  'Caspar Jander': 'ヤンダー', 'Will Smallbone': 'スモールボーン', 'Cameron Archer': 'アーチャー',
  'Ross Stewart': 'R.スチュワート', 'Finn Azaz': 'アザズ', 'Tom Fellows': 'フェロウズ',
  'Taylor Richards': 'T.リチャーズ', 'Joe Lumley': 'ラムリー',
  // === スーパースター（汎用） ===
  'Lionel Messi': 'メッシ', 'Cristiano Ronaldo': 'C.ロナウド',
  'Kylian Mbappé': 'エムバペ', 'Kylian Mbappe': 'エムバペ',
  'Jude Bellingham': 'ベリンガム',
  'Vinícius Júnior': 'ヴィニシウス', 'Vinicius Junior': 'ヴィニシウス',
  'Rodrygo': 'ロドリゴ', 'Robert Lewandowski': 'レヴァンドフスキ',
  'Lamine Yamal': 'ヤマル', 'Pedri': 'ペドリ', 'Gavi': 'ガビ', 'Frenkie de Jong': 'デ・ヨング',
  'Harry Kane': 'ケイン', 'Mohamed Salah': 'サラー', 'Bukayo Saka': 'サカ',
  'Martin Ødegaard': 'ウーデゴール', 'Martin Odegaard': 'ウーデゴール',
  'Kai Havertz': 'ハフェルツ', 'Declan Rice': 'ライス', 'Bruno Fernandes': 'B.フェルナンデス',
  'Marcus Rashford': 'ラッシュフォード', 'Cole Palmer': 'パーマー', 'Florian Wirtz': 'ヴィルツ',
  'Kingsley Coman': 'コマン', 'Joshua Kimmich': 'キミッヒ', 'Manuel Neuer': 'ノイアー',
  'Thibaut Courtois': 'クルトワ',
  'Marc-André ter Stegen': 'テア・シュテーゲン', 'Marc-Andre ter Stegen': 'テア・シュテーゲン',
};
// 大文字/小文字・空白・アクセントを正規化（部分一致用）
function _normalizeNameForMatch(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')  // 結合発音記号除去
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
const _PLAYER_KEYS_NORM = Object.keys(PLAYER_NAMES).map(k => ({
  key: k, norm: _normalizeNameForMatch(k),
}));
function _player(raw) {
  if (!raw) return '';
  const t = String(raw).trim();
  if (PLAYER_NAMES[t]) return PLAYER_NAMES[t];
  // 部分一致フォールバック: PLAYER_NAMES の登録名が raw に含まれる、または raw が含まれる
  //   例: raw="LAMINE YAMAL NASRAOUI EBANA" → "Lamine Yamal" を見つけて "ヤマル"
  //   登録名が長いほうから優先（"Marc-André ter Stegen" を "Stegen" より先に）
  const tn = _normalizeNameForMatch(t);
  if (tn) {
    const matches = _PLAYER_KEYS_NORM
      .filter(p => p.norm && (tn.includes(p.norm) || p.norm.includes(tn)))
      .sort((a, b) => b.norm.length - a.norm.length);
    if (matches.length) return PLAYER_NAMES[matches[0].key];
  }
  // 最終フォールバック: スペース区切りの最後の単語
  const parts = t.split(/\s+/);
  return parts[parts.length - 1] || t;
}

// '2026-04-25' → '2026年4月25日'
function _fmtDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return d || '';
  return `${m[1]}年${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日`;
}

// 🆕 mod.imageAdjust から CSS（transform / background-position）を生成（2026-05-08）
//   Step4 UI のスライダーで設定された画像のズーム + 位置オフセットを slide テンプレに適用
//   imageAdjust = { zoom: 0.5〜2.0, offsetX: -50〜50 (%), offsetY: -50〜50 (%) }
//   - background-image を使うコンテナ用: background-size + background-position
//   - object-fit / transform を使うコンテナ用: transform: scale + translate
function imageAdjustCss(adj, opts = {}) {
  const a = adj || {};
  const zoom = Math.max(0.5, Math.min(2.0, parseFloat(a.zoom) || 1));
  const ox   = Math.max(-50, Math.min(50, parseFloat(a.offsetX) || 0));   // 横方向 (%)
  const oy   = Math.max(-50, Math.min(50, parseFloat(a.offsetY) || 0));   // 縦方向 (%)
  const isDefault = (zoom === 1 && ox === 0 && oy === 0);
  // background-image 用：cover を維持しつつ scale/位置調整
  const bgPos  = `${50 + ox}% ${50 + oy}%`;
  const bgSize = `${100 * zoom}%`;   // 100%未満で「引き」、100%超えで「寄り」
  // transform 用（cover が必要な領域内で scale + translate）
  const tx     = ox * zoom * 0.4;   // 過剰移動防止
  const ty     = oy * zoom * 0.4;
  const transform = `scale(${zoom.toFixed(3)}) translate(${tx.toFixed(2)}%, ${ty.toFixed(2)}%)`;
  return {
    isDefault,
    zoom, offsetX: ox, offsetY: oy,
    bgPosition: bgPos,
    bgSize,
    transform,
    // background-image スタイル（コンテナの中身に流し込む既存 background-size: cover を上書き）
    bgStyle: isDefault ? '' : `background-size: ${bgSize} auto; background-position: ${bgPos};`,
  };
}

// 2026-05-18: 全スライド共通の文字サイズ自動調整ヘルパー
//   1) 1 行で base font を維持、 横幅に入らない場合だけ縮小
//   2) 縮小率 70% 以上で 1 行表示 (base × 0.7 まで縮めて収まれば 1 行)
//   3) 70% 未満まで縮めないと 1 行に収まらない場合 → 2 行折り返し
//      2 行時のフォントサイズは base × 0.85 で固定 (読みやすさ優先)
//
// 使い方:
//   const { fontSize, lines } = fitFont(text, base, innerW, { maxLines: 2 });
//
// 戻り値:
//   { fontSize: number, lines: number (1 or 2) }
//
// 引数:
//   text:               測定対象の文字列
//   baseFontPx:         基準フォントサイズ（縮小はここから下のみ、 拡大はしない）
//   innerWidthPx:       コンテナの内部幅（padding/border を引いた実描画幅）
//   opts.maxLines:      最大行数 (default 2)。 1 にすると折り返しなし
//   opts.wrapThreshold: 縮小率の下限 (default 0.70)。 base × 0.7 を下回ると 2 行へ
//   opts.wrapFontRatio: 2 行時のフォント縮小率 (default 0.85)
//   opts.minFontPx:     最小フォントサイズ (default 18)
//   opts.charWidth:     文字幅係数 (default 0.62 = 日本語+数字+記号混在の Sans-Serif 経験値)
//   opts.allowedRatio:  横幅の許容比率 (default 1.00 = 横幅いっぱいを基準にする)
function fitFont(text, baseFontPx, innerWidthPx, opts = {}) {
  const norm = String(text ?? '')
    .replace(/\\n/g, '\n').replace(/\r\n/g, '\n')
    .replace(/^\n+|\n+$/g, '').replace(/\n{2,}/g, '\n');
  const len = norm.length;
  if (len === 0) return { fontSize: baseFontPx, lines: 1 };
  const maxLines      = opts.maxLines      ?? 2;
  const wrapThreshold = opts.wrapThreshold ?? 0.70;
  const wrapFontRatio = opts.wrapFontRatio ?? 0.85;
  const minFontPx     = opts.minFontPx     ?? 18;
  const charWidth     = opts.charWidth     ?? 0.62;
  const allowedRatio  = opts.allowedRatio  ?? 1.00;

  // 明示改行 (正規化後に残った \n) があれば強制 2 行
  const hasExplicitNl = /\n/.test(norm);
  const allowedW = innerWidthPx * allowedRatio;
  // 1 行で必要なフォントサイズ
  const oneLineFont = Math.floor(allowedW / (len * charWidth));
  const wrapBoundary = baseFontPx * wrapThreshold;

  // 2 行折り返しの条件:
  //   (A) 明示改行あり、 または (B) 1 行で base×0.7 未満まで縮まないと収まらない
  //   かつ maxLines >= 2 が必須
  if (maxLines >= 2 && (hasExplicitNl || oneLineFont < wrapBoundary)) {
    // 相棒指示: 2 行時は base × 0.85 のサイズで描画 (読みやすさ優先で固定値)
    const twoLineFont = Math.floor(baseFontPx * wrapFontRatio);
    return {
      fontSize: Math.max(minFontPx, twoLineFont),
      lines: 2,
    };
  }
  return {
    fontSize: Math.max(minFontPx, Math.min(baseFontPx, oneLineFont)),
    lines: 1,
  };
}

module.exports = {
  W, H, PALETTE, esc, escBr, hasNewline, imgDataUri, wrapHTML, splitSubtitle, buildSubtitleBar, subtitleArgFromMod, mapImagesToModule, mapImagesToModulePreview,
  LEAD_PAD_SEC, TAIL_PAD_SEC,
  I18N, TEAM_ABBR, PLAYER_NAMES,
  _t, _abbr, _player, _fmtDate,
  imageAdjustCss,
  fitFont,
};
