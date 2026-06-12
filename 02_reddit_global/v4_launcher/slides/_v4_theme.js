// v4_launcher/slides/_v4_theme.js
// V4スライド共通: 「2chまとめ」ビジュアルテーマ
//   クリーム背景 + 栗色ヘッダー + 名無しレスヘッダー + 赤レス文化
'use strict';

// ── 2ch カラーパレット ─────────────────────────────────────────
const C2CH = {
  bg:      '#FFFFEE',  // 板のクリーム色
  bgPaper: '#FCFCE8',  // カード面
  maroon:  '#800000',  // スレタイ・ヘッダー
  name:    '#008800',  // 名無しさん（緑）
  text:    '#1a1a1a',  // 本文
  red:     '#E60000',  // 赤レス・【悲報】
  blue:    '#0000EE',  // アンカー
  meta:    '#999999',  // 日付・ID
  line:    '#D8D8C0',  // 罫線
};

// ── テキストから決定論的な疑似ID生成（8文字英数）──────────────
function fakeId(text) {
  let h = 5381;
  const s = String(text || 'id');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 8; i++) { out += chars[h % chars.length]; h = (h * 33 + 7) >>> 0; }
  return out;
}

// ── スレ立て日時風文字列（レンダリング時の日付）────────────────
function threadDateStr(offsetMin = 0) {
  const d = new Date(Date.now() + offsetMin * 60000);
  const yo = '日月火水木金土'[d.getDay()];
  const p2 = n => String(n).padStart(2, '0');
  const cs = p2(Math.floor((d.getMilliseconds() / 10)));
  return `${d.getFullYear()}/${p2(d.getMonth()+1)}/${p2(d.getDate())}(${yo}) ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${cs}`;
}

// ── 【悲報】等のブラケットを赤く着色した HTML を返す ───────────
//   esc済みテキストを渡すこと
function colorBrackets(escapedText) {
  return String(escapedText || '')
    .replace(/(【[^】]{1,12}】)/g, `<span style="color:${C2CH.red};">$1</span>`);
}

// ── レスヘッダー HTML（番号 + 名無し + 日時 + ID）──────────────
function resHeaderHTML(num, idSeed, { fontPx = 26, offsetMin = 0 } = {}) {
  return `
  <div class="res-head" style="font-size:${fontPx}px;">
    <span class="res-num">${num}</span><span class="res-sep"> : </span><span class="res-name">風吹けば名無し</span><span class="res-meta"> ${threadDateStr(offsetMin)} ID:${fakeId(idSeed)}</span>
  </div>`;
}

// ── 共通CSS（板の質感・ヘッダー・レス構造）─────────────────────
const THEME_CSS = `
.board-bg {
  position: absolute; inset: 0;
  background:
    repeating-linear-gradient(0deg, transparent 0 3px, rgba(128,0,0,0.012) 3px 4px),
    radial-gradient(circle at 80% 10%, rgba(128,0,0,0.04), transparent 50%),
    ${C2CH.bg};
}
.board-bar {
  position: absolute; top: 0; left: 0; right: 0;
  height: 86px;
  background: linear-gradient(180deg, #8e1010 0%, ${C2CH.maroon} 100%);
  display: flex; align-items: center;
  padding: 0 44px; gap: 24px;
  box-shadow: 0 3px 14px rgba(0,0,0,0.35);
  z-index: 10;
}
.board-name {
  color: #ffe9c9; font-size: 30px; font-weight: 900; letter-spacing: 2px;
  flex-shrink: 0;
}
.board-thread {
  color: #fff; font-size: 30px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: .95;
}
.res-head { color: ${C2CH.meta}; font-weight: 700; }
.res-num  { color: ${C2CH.maroon}; font-weight: 900; }
.res-name { color: ${C2CH.name}; font-weight: 900; }
.res-meta { color: ${C2CH.meta}; font-weight: 400; }
.photo-frame {
  background: #fff;
  padding: 16px 16px 20px;
  border: 1px solid #d0d0c0;
  box-shadow: 0 10px 36px rgba(0,0,0,0.30), 0 2px 8px rgba(0,0,0,0.18);
  border-radius: 4px;
}
.photo-frame img { display: block; border-radius: 2px; }
`;

// ── 板ヘッダー HTML ─────────────────────────────────────────────
function boardBarHTML(threadTitleEsc = '') {
  return `
<div class="board-bar">
  <span class="board-name">なんJ⚽蹴球速報</span>
  ${threadTitleEsc ? `<span class="board-thread">${colorBrackets(threadTitleEsc)}</span>` : ''}
</div>`;
}

module.exports = { C2CH, fakeId, threadDateStr, colorBrackets, resHeaderHTML, boardBarHTML, THEME_CSS };
