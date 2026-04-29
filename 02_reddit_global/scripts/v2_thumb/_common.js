// scripts/v2_thumb/_common.js
// サムネイル共通ユーティリティ（YouTube 1280×720 専用）
//   各テンプレートが import する共通定数と HTML ラッパー

const TW = 1280, TH = 720;

// チャンネルのブランドカラー（_common.js のスライドと統一）
const PALETTE = {
  bg:      '#0a0e1a',     // ベース背景（深いネイビー）
  surface: '#161b2e',     // パネル背景
  panel:   '#1a2240',     // 強調パネル
  border:  '#2a3050',
  text:    '#f1f5ff',     // 白寄り
  muted:   '#8a9aba',
  accent:  '#f59e0b',     // 黄金色（既存システム統一）
  red:     '#ef4444',     // 衝撃系
  green:   '#10b981',     // 朗報系
  blue:    '#3b82f6',
  purple:  '#8b5cf6',
};

const CHANNEL_NAME = '5分でサッカー分析';
const CHANNEL_ICON = '⚽';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 画像パス → data URI（imgDataUri と同じ思想）
//   ローカル開発時は file path、サムネプレビュー時は dataURI
const fs = require('fs');
const path = require('path');
function imgDataUri(filePath) {
  if (!filePath) return null;
  const cleaned = String(filePath).replace(/^\//, '');
  if (/^https?:\/\//.test(cleaned) || cleaned.startsWith('data:')) return cleaned;
  const baseDir = path.join(__dirname, '..', '..');
  const abs = path.isAbsolute(cleaned) ? cleaned : path.join(baseDir, cleaned);
  if (!fs.existsSync(abs)) return null;
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' })[ext] || 'image/png';
  const data = fs.readFileSync(abs).toString('base64');
  return `data:${mime};base64,${data}`;
}

// 1280×720 サムネイル用 HTML ラッパー
function wrapThumb({ thumbBody, extraStyles = '', title = 'Thumbnail' }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${esc(title)}</title>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body {
  width: ${TW}px;
  height: ${TH}px;
  overflow: hidden;
  background: ${PALETTE.bg};
  font-family: "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic", "メイリオ", sans-serif;
}
.thumb {
  width: ${TW}px;
  height: ${TH}px;
  position: relative;
  color: ${PALETTE.text};
  overflow: hidden;
}
${extraStyles}
</style>
</head>
<body>
<div class="thumb">${thumbBody}</div>
</body>
</html>`;
}

// チャンネルロゴ（左下固定の HTML 断片）— 全テンプレで共通
function channelLogoHtml(channelName = CHANNEL_NAME) {
  return `<div class="channel-logo">
    <span class="channel-icon">${CHANNEL_ICON}</span>
    <span>${esc(channelName)}</span>
  </div>`;
}

// チャンネルロゴの共通スタイル
const channelLogoStyle = `
.channel-logo {
  position: absolute;
  left: 24px; bottom: 24px;
  display: flex; align-items: center; gap: 10px;
  background: rgba(0, 0, 0, 0.7);
  border: 2px solid ${PALETTE.accent};
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 22px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 2px;
  z-index: 8;
  backdrop-filter: blur(4px);
}
.channel-logo .channel-icon {
  font-size: 24px;
  color: ${PALETTE.accent};
}
`;

module.exports = {
  TW, TH, PALETTE, CHANNEL_NAME, CHANNEL_ICON,
  esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyle,
};
