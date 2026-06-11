// v4_launcher/scripts/v4_thumb_render.js
// テンプレートA/B共通レンダラー
//   A=赤帯型(band) / B=全面写真型(photo)
'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const fs   = require('fs');

const THUMB_DIR = path.join(__dirname, '..', 'thumb');
const OUT_DIR   = path.join(__dirname, '..', 'thumbs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const TEMPLATES = {
  band:  path.join(THUMB_DIR, 'template_a_band.html'),
  photo: path.join(THUMB_DIR, 'template_b_photo.html'),
};

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 「契約延長」だけ黄色にする等のハイライト記法: 【】で囲んだ部分を <span class="hl"> に
function withHighlight(s) {
  return esc(s).replace(/【(.+?)】/g, '<span class="hl">$1</span>');
}

// 画像を data URI に変換（setContent ページは file:// を読めないため）
function toDataUri(p) {
  if (!p) return '';
  if (p.startsWith('http') || p.startsWith('data:')) return p;
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/**
 * @param {object} opts
 * @param {'band'|'photo'} opts.template - A=band(赤帯) B=photo(全面写真)
 * @param {string} opts.photo     - 選手写真パス
 * @param {string} opts.photoPos  - background-position (default: 'center 15%')
 * @param {string} opts.line1     - タイトル1行目（【】で囲むと黄色ハイライト ※bandのみ）
 * @param {string} opts.line2     - タイトル2行目
 * @param {string} opts.comment1  - コメントボックス1
 * @param {string} opts.comment2  - コメントボックス2（bandのみ）
 * @param {string} opts.out       - 出力パス
 */
async function renderThumb(opts = {}) {
  const tplPath = TEMPLATES[opts.template || 'band'];
  if (!tplPath) throw new Error('unknown template: ' + opts.template);

  let html = fs.readFileSync(tplPath, 'utf8')
    .replace('{{PHOTO}}',     toDataUri(opts.photo))
    .replace('{{PHOTO_POS}}', opts.photoPos || 'center 15%')
    .replace('{{LINE1}}',     withHighlight(opts.line1 || ''))
    .replace('{{LINE2}}',     withHighlight(opts.line2 || ''))
    .replace('{{COMMENT1}}',  esc(opts.comment1 || ''))
    .replace('{{COMMENT2}}',  esc(opts.comment2 || ''));

  const out = opts.out || path.join(OUT_DIR, `v4_${opts.template}_${Date.now()}.png`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    await page.evaluateHandle('document.fonts.ready');
    await page.screenshot({ path: out, type: 'png' });
  } finally {
    await browser.close();
  }
  return out;
}

module.exports = { renderThumb };

// ── CLI: node v4_thumb_render.js → 参照サムネ2枚を再現 ──
if (require.main === module) {
  (async () => {
    const konate = path.join(__dirname, '..', '..', 'images_stock', 'players_official', 'ibrahima-konate', 'ibrahima-konate_001.jpg');

    const a = await renderThumb({
      template: 'band',
      photo: konate,
      photoPos: 'center 12%',
      line1: 'リバポがコナテと【契約延長】',
      line2: 'しなかった理由が判明',
      comment1: 'そういうことかい',
      comment2: 'これマドリーもやばくね',
      out: path.join(OUT_DIR, 'ref_a_band.png'),
    });
    console.log('Template A:', a);

    const b = await renderThumb({
      template: 'photo',
      photo: konate,
      photoPos: 'center 8%',
      line1: 'コナテ「ごめんやっぱ',
      line2: 'マドリー行くわww',
      comment1: 'キモすぎるって',
      out: path.join(OUT_DIR, 'ref_b_photo.png'),
    });
    console.log('Template B:', b);
  })().catch(console.error);
}
