// scripts/v2_video/slides/_common.js
// 全スライドテンプレート共通のベース CSS・カラーパレット・ユーティリティ

const fs   = require('fs');
const path = require('path');

const W = 1920, H = 1080;

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

// 画像を base64 で埋め込み（Puppeteer の file:// アクセス回避）
function imgDataUri(imgPath) {
  if (!imgPath) return null;
  try {
    // 絶対パスじゃなければプロジェクトルート基準で解決
    const abs = path.isAbsolute(imgPath)
      ? imgPath
      : path.join(__dirname, '..', '..', '..', imgPath.replace(/^\//, ''));
    if (!fs.existsSync(abs)) return null;
    const ext  = path.extname(abs).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
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
${extraStyles}
</style>
</head>
<body>
<div class="slide">${slideBody}</div>
</body>
</html>`;
}

// 字幕テキストを 2 行に自然分割（日本語向け）
//   - 句読点・スペース・「だ」「ます」「です」「！」「？」等の区切りを優先
//   - 区切りなければ中央付近で強制分割
//   - 30〜36字を超えたらフォントサイズも自動で1段階下げる
function splitSubtitle(text, maxLineLen = 36) {
  const t = String(text || '').trim();
  if (!t) return { lines: [], fontSize: null };
  if (t.length <= maxLineLen) return { lines: [t], fontSize: null };

  // 自然な区切り候補（位置, 強さ）を抽出
  const candidates = [];
  const breaks = ['。', '！', '？', '!', '?', '、', ',', ' ', '。', '・'];
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

  const line1 = t.slice(0, splitAt).trim();
  const line2 = t.slice(splitAt).trim();
  const longest = Math.max(line1.length, line2.length);

  // 1行が長すぎたらフォント縮小
  let fontSize = null;
  if (longest > 30) fontSize = 32;
  if (longest > 38) fontSize = 28;
  if (longest > 46) fontSize = 24;

  return { lines: [line1, line2], fontSize };
}

// 字幕バー HTML を生成（共通）
//   options.height（px）: 字幕バー高さ。デフォルト 110
//   options.maxLineLen   : 1行最大文字数。デフォルト 36
function buildSubtitleBar(text, options = {}) {
  const t = String(text || '').trim();
  if (!t) return '';
  const height = options.height || 110;
  const maxLineLen = options.maxLineLen || 36;
  const { lines, fontSize } = splitSubtitle(t, maxLineLen);
  const fontStyle = fontSize ? `font-size: ${fontSize}px;` : '';
  const linesHtml = lines.map(l => `<div>${esc(l)}</div>`).join('');

  return `<div class="v2-sub-bar" style="position:absolute;bottom:0;left:0;right:0;height:${height}px;`
    + `background:rgba(0,0,0,0.92);border-top:3px solid rgba(245,158,11,0.5);`
    + `display:flex;align-items:center;justify-content:center;z-index:20">`
    + `<div style="color:#fff;font-size:38px;font-weight:800;text-align:center;`
    + `padding:0 70px;line-height:1.35;${fontStyle}">${linesHtml}</div></div>`;
}

module.exports = { W, H, PALETTE, esc, imgDataUri, wrapHTML, splitSubtitle, buildSubtitleBar };
