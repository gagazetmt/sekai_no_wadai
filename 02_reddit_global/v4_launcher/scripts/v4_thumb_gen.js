// v4_launcher/scripts/v4_thumb_gen.js
// uwasathefootball2スタイルのサムネイル生成
// 1280x720px PNG をPuppeteerで出力
'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const fs   = require('fs');

const TEMPLATE_PATH = path.join(__dirname, '..', 'thumb', 'v4_thumb.html');
const OUT_DIR = path.join(__dirname, '..', 'thumbs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} opts
 * @param {string}  opts.bgImage      - 背景画像パス（絶対パス or URL）
 * @param {string}  opts.line1        - タイトル1行目
 * @param {string}  opts.line2        - タイトル2行目（省略可）
 * @param {string}  opts.comment      - 右上ボックスのコメント（\n で改行）
 * @param {string}  opts.accentColor  - ボックスカラー（デフォルト: #FFD700）
 * @param {string}  opts.bgPosition   - 背景位置（デフォルト: center top）
 * @param {number}  opts.bgBrightness - 背景輝度 0〜1（デフォルト: 0.88）
 * @param {number}  opts.titleSize    - タイトルフォントサイズ px（デフォルト: 92）
 * @param {string}  opts.outputPath   - 出力先パス（省略時は thumbs/thumb_<timestamp>.png）
 * @returns {string} 出力ファイルパス
 */
async function generateV4Thumb(opts = {}) {
  const {
    bgImage      = '',
    line1        = '',
    line2        = '',
    comment      = '',
    accentColor  = '#FFD700',
    bgPosition   = 'center top',
    bgBrightness = 0.88,
    titleSize    = 92,
    outputPath   = path.join(OUT_DIR, `thumb_${Date.now()}.png`),
  } = opts;

  // 背景画像のURL変換（ローカルファイルは file:// に）
  let bgUrl = bgImage;
  if (bgImage && !bgImage.startsWith('http') && !bgImage.startsWith('file://')) {
    bgUrl = 'file:///' + bgImage.replace(/\\/g, '/');
  }

  // HTMLテンプレート読み込み → プレースホルダー置換
  let html = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  // CSS変数をstyle属性でbodyに渡す
  const cssVars = [
    `--bg-image: url('${bgUrl}')`,
    `--bg-position: ${bgPosition}`,
    `--bg-brightness: ${bgBrightness}`,
    `--accent-color: ${accentColor}`,
    `--title-size: ${titleSize}px`,
  ].join('; ');

  html = html
    .replace('<body>', `<body style="${cssVars}">`)
    .replace('{{LINE1}}',  esc(line1))
    .replace('{{LINE2}}',  esc(line2))
    .replace('{{COMMENT}}', esc(comment).replace(/\n/g, '<br>'))
    .replace('{{COMMENT_HIDDEN}}', comment ? '' : 'hidden');

  // Puppeteerでレンダリング
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    // フォント読み込み待機
    await page.evaluateHandle('document.fonts.ready');
    await page.screenshot({ path: outputPath, type: 'png' });
  } finally {
    await browser.close();
  }

  return outputPath;
}

module.exports = { generateV4Thumb };

// ── CLIテスト: node v4_thumb_gen.js ────────────────────────────
if (require.main === module) {
  (async () => {
    const testOut = await generateV4Thumb({
      bgImage:     process.argv[2] || '',
      line1:       'リバポがコナテと契約延長',
      line2:       'しなかった理由が判明',
      comment:     'そういうことかい\nこれマドリーもやばくね',
      accentColor: '#FFD700',
      titleSize:   92,
    });
    console.log('生成完了:', testOut);
  })().catch(console.error);
}
