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

module.exports = { W, H, PALETTE, esc, imgDataUri, wrapHTML };
