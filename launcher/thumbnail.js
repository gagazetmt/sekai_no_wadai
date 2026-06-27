// launcher/thumbnail.js
// サムネイル生成: 1280x720 JPEG（5ch風 P1 スタイル）
//   ・下45%を2段テキストボックス（黄色地）
//   ・上段：黄色地＋青文字 / 下段：黄色地＋赤文字
//   ・左上サブボックス（白地・赤枠）にバッジ表示
//   ・背景画像対応（上部に写真）

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

// 全角=1.0幅、半角=0.55幅
function _charW(s) {
  return [...String(s || '')].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 1.0 : 0.55), 0);
}

// 行高・利用可能幅からフォントサイズ＋横圧縮率を算出
function _calcStyle(text, rowH, availW, minSx = 0.65) {
  const cw = _charW(text);
  const fsByH = Math.floor((rowH - 8) / 1.05);
  if (!cw) return { fs: fsByH, sx: 1.0 };
  const natW = cw * fsByH * 0.91;
  if (natW <= availW) return { fs: fsByH, sx: 1.0 };
  const sx = availW / natW;
  if (sx >= minSx) return { fs: fsByH, sx: parseFloat(sx.toFixed(3)) };
  return { fs: Math.floor(availW / (cw * 0.91 * minSx)), sx: minSx };
}

// タイトルを上段・下段に自然分割
function splitTitle(title) {
  if (!title) return ['', ''];
  const t = String(title).trim();
  if (t.length <= 12) return [t, ''];

  // 句読点・記号付近で分割
  const mid = Math.ceil(t.length * 0.45);
  const breaks = '　 、。！？!?・ー';
  for (let i = mid; i < Math.min(t.length, mid + 10); i++) {
    if (breaks.includes(t[i])) return [t.slice(0, i + 1).trim(), t.slice(i + 1).trim()];
  }
  for (let i = mid; i >= Math.max(0, mid - 8); i--) {
    if (breaks.includes(t[i])) return [t.slice(0, i + 1).trim(), t.slice(i + 1).trim()];
  }
  // 強制分割
  const half = Math.ceil(t.length / 2);
  return [t.slice(0, half), t.slice(half)];
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildThumbnailHTML({ title, badge = '速報', bgImageUrl = null }) {
  const BOX_H   = Math.round(720 * 0.45);           // 324px
  const UPPER_H = Math.round(BOX_H * 0.44);         // 143px
  const LOWER_H = BOX_H - UPPER_H;                  // 181px
  const SUB_OVL = 28;                                // サブボックスのはみ出し量
  const PAD     = 16;
  const AVAIL_W = 1280 - PAD * 2;

  const [upperText, lowerText] = splitTitle(title);
  const uCalc = _calcStyle(upperText, UPPER_H, AVAIL_W);
  const lCalc = _calcStyle(lowerText || upperText, UPPER_H, AVAIL_W);
  const subFsPx = 38;

  const bgStyle = bgImageUrl
    ? `background-image:url('${bgImageUrl}');background-size:cover;background-position:center;background-color:#111;`
    : `background:linear-gradient(135deg,#0a1428 0%,#1a2a4a 100%);`;

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{width:1280px;height:720px;overflow:hidden;
  font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","メイリオ",sans-serif;}
.wrap{width:1280px;height:720px;position:relative;overflow:hidden;}
.bg-img{position:absolute;inset:0;${bgStyle}}
.bg-dark{position:absolute;inset:0 0 ${BOX_H}px 0;
  background:linear-gradient(to bottom,rgba(0,0,0,0.25) 0%,rgba(0,0,0,0.55) 100%);}
.main-box{position:absolute;bottom:0;left:0;right:0;height:${BOX_H}px;display:flex;flex-direction:column;}
.upper-row{
  flex-shrink:0;height:${UPPER_H}px;
  background:#fff001;color:#2104fc;
  font-size:${uCalc.fs}px;font-weight:900;
  padding:0 ${PAD}px;display:flex;align-items:center;overflow:hidden;}
.lower-row{
  flex-shrink:0;height:${LOWER_H}px;
  background:#fff001;color:#fb0002;
  font-size:${lCalc.fs}px;font-weight:900;
  padding:0 ${PAD}px;display:flex;align-items:center;overflow:hidden;}
.tx{display:inline-block;white-space:nowrap;line-height:1.0;}
.row-sep{position:absolute;left:0;right:0;bottom:${LOWER_H}px;height:4px;background:#e0c000;z-index:2;}
.sub-box{
  position:absolute;
  bottom:${BOX_H - SUB_OVL}px;left:18px;
  background:#fdfcff;color:#c7342d;
  font-size:${subFsPx}px;font-weight:900;
  padding:4px 18px 5px 14px;
  border:3px solid #c7342d;
  white-space:nowrap;letter-spacing:1px;
  box-shadow:2px 3px 12px rgba(0,0,0,0.5);}
</style></head><body><div class="wrap">
<div class="bg-img"></div>
<div class="bg-dark"></div>
<div class="main-box">
  <div class="upper-row"><span class="tx" style="transform:scaleX(${uCalc.sx});transform-origin:left center;">${_esc(upperText)}</span></div>
  <div class="lower-row"><span class="tx" style="transform:scaleX(${lCalc.sx});transform-origin:left center;">${_esc(lowerText)}</span></div>
</div>
<div class="row-sep"></div>
<div class="sub-box">【${_esc(badge)}】</div>
</div></body></html>`;
}

async function generateThumbnail({ title, badge = '速報', bgImageUrl = null, outputPath }) {
  const html = buildThumbnailHTML({ title, badge, bgImageUrl });
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 92 });
    await page.close();
    const size = (fs.statSync(outputPath).size / 1024).toFixed(0);
    console.log(`  Thumbnail: ${outputPath} (${size}KB)`);
  } finally {
    await browser.close();
  }
  return outputPath;
}

module.exports = { generateThumbnail, buildThumbnailHTML };
