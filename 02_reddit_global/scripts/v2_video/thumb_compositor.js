// thumb_compositor.js
// ═══════════════════════════════════════════════════════════════
// SVGテキストメーカー + Puppeteer合成
//
// FONT_PATTERNS: 15種の定義済みスタイル（AIが番号で指定）
// buildSVG(layers): layers[] → SVG文字列
// composite({bgPath, layers, outputPath}): 背景+SVG → 完成PNG
//
// SVGを使う理由:
//   paint-order="stroke fill" が正しく機能する
//   → 縁取りが外側のみ / グラデが文字の中を正確に塗る = Canvaクオリティ
// ═══════════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
const fs        = require('fs');

// ─── グラデーション定義 ──────────────────────────────────────────
const GRADS = {
  gold:  [{ o:'0%', c:'#fffde7' }, { o:'28%', c:'#ffd700' }, { o:'65%', c:'#f5a500' }, { o:'100%', c:'#c07800' }],
  fire:  [{ o:'0%', c:'#fff8e1' }, { o:'22%', c:'#ffab00' }, { o:'58%', c:'#ff3d00' }, { o:'100%', c:'#8b0000' }],
  white: [{ o:'0%', c:'#ffffff' }, { o:'100%', c:'#d8d8d8' }],
  goldMetal: [{ o:'0%', c:'#d4a437' }, { o:'28%', c:'#fde68a' }, { o:'48%', c:'#fffbeb' }, { o:'65%', c:'#fbbf24' }, { o:'100%', c:'#92400e' }],
};

// ─── 15パターン定義 ─────────────────────────────────────────────
//  type: 'text' | 'badge'
//  grad: グラデキー（GRADSを参照）
//  color: ソリッドカラー（gradと排他）
//  sw: strokeWidth
//  glow: CSS filter
//  badge: バッジ矩形の設定 { bg, fg }
const FONT_PATTERNS = {
  // ── 大テキスト（メインタイトル）──────────────────────────────
  1: {
    name: '金インパクト特大', type: 'text',
    grad: 'gold', sw: 9,
    glow: 'drop-shadow(0 0 22px rgba(255,200,0,0.9)) drop-shadow(0 5px 10px rgba(0,0,0,0.98))',
  },
  2: {
    name: '金インパクト大', type: 'text',
    grad: 'gold', sw: 8,
    glow: 'drop-shadow(0 0 18px rgba(255,200,0,0.85)) drop-shadow(0 4px 8px rgba(0,0,0,0.96))',
  },
  3: {
    name: '炎インパクト特大', type: 'text',
    grad: 'fire', sw: 9,
    glow: 'drop-shadow(0 0 22px rgba(255,80,0,0.95)) drop-shadow(0 5px 10px rgba(0,0,0,0.98))',
  },
  4: {
    name: '炎インパクト大', type: 'text',
    grad: 'fire', sw: 8,
    glow: 'drop-shadow(0 0 18px rgba(255,80,0,0.9)) drop-shadow(0 4px 8px rgba(0,0,0,0.96))',
  },
  5: {
    name: '白インパクト特大', type: 'text',
    grad: 'white', sw: 9,
    glow: 'drop-shadow(0 0 16px rgba(0,0,0,0.98)) drop-shadow(0 5px 10px rgba(0,0,0,0.99))',
  },
  6: {
    name: '白インパクト大', type: 'text',
    grad: 'white', sw: 8,
    glow: 'drop-shadow(0 0 14px rgba(0,0,0,0.96)) drop-shadow(0 4px 8px rgba(0,0,0,0.98))',
  },
  // ── 中テキスト（サブタイトル）───────────────────────────────
  7: {
    name: '金メタリック中', type: 'text',
    grad: 'goldMetal', sw: 6,
    glow: 'drop-shadow(0 0 14px rgba(212,164,55,0.8)) drop-shadow(0 3px 6px rgba(0,0,0,0.95))',
  },
  8: {
    name: '炎サブタイトル', type: 'text',
    grad: 'fire', sw: 6,
    glow: 'drop-shadow(0 0 14px rgba(255,80,0,0.8)) drop-shadow(0 3px 6px rgba(0,0,0,0.95))',
  },
  9: {
    name: '白サブタイトル', type: 'text',
    grad: 'white', sw: 6,
    glow: 'drop-shadow(0 0 12px rgba(0,0,0,0.95)) drop-shadow(0 3px 6px rgba(0,0,0,0.98))',
  },
  // ── 小テキスト（コンテキスト行・見出し）─────────────────────
  10: {
    name: '白小見出し', type: 'text',
    color: '#ffffff', stroke: '#000000', sw: 4,
    glow: 'drop-shadow(0 2px 6px rgba(0,0,0,0.96))',
  },
  11: {
    name: '金小見出し', type: 'text',
    color: '#ffd700', stroke: '#000000', sw: 3,
    glow: 'drop-shadow(0 2px 6px rgba(0,0,0,0.9))',
  },
  12: {
    name: '黄コンテキスト', type: 'text',
    color: '#ffd700', stroke: '#7f0000', sw: 3,
    glow: 'drop-shadow(0 2px 5px rgba(0,0,0,0.85))',
  },
  // ── バッジ ───────────────────────────────────────────────────
  13: {
    name: '赤バッジ', type: 'badge',
    badge: { bg: '#cc0000', fg: '#ffffff' },
  },
  14: {
    name: 'オレンジバッジ', type: 'badge',
    badge: { bg: '#e65c00', fg: '#ffffff' },
  },
  15: {
    name: '濃紺バッジ', type: 'badge',
    badge: { bg: '#0a1628', fg: '#ffd700', border: '#ffd700' },
  },
};

// パターン一覧をAIプロンプト用のテキストに変換
function patternsForPrompt() {
  return Object.entries(FONT_PATTERNS).map(([id, p]) =>
    `${id}: ${p.name}`
  ).join('\n');
}

// ─── SVG ヘルパー ─────────────────────────────────────────────
function _esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _gradDef(id, stops) {
  const s = stops.map(g => `<stop offset="${g.o}" stop-color="${g.c}"/>`).join('');
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${s}</linearGradient>`;
}

// 改行対応テキスト（\nで tspan 分割）
function _textElement({ text, pattern, x, y, fontSize, lineSpacing }) {
  const p = FONT_PATTERNS[pattern];
  if (!p || p.type === 'badge') return '';

  const fs   = fontSize || 80;
  const ls   = Math.round(fs * (lineSpacing || 1.15));
  const lines = String(text || '').split('\n');
  const gId  = p.grad ? `grad${pattern}` : null;
  const fill = gId ? `url(#${gId})` : (p.color || '#ffffff');
  const stroke = p.stroke || '#000000';
  const sw     = p.sw || 6;
  const filter = p.glow ? `filter="${_esc(p.glow)}"` : '';

  const tspans = lines.length === 1
    ? _esc(lines[0])
    : lines.map((l, i) =>
        `<tspan x="${x}" dy="${i === 0 ? 0 : ls}">${_esc(l)}</tspan>`
      ).join('');

  return `<text x="${x}" y="${y}"
    font-family="'Noto Sans JP',sans-serif" font-weight="900" font-size="${fs}"
    fill="${fill}" stroke="${stroke}" stroke-width="${sw}"
    stroke-linejoin="round" paint-order="stroke fill"
    ${filter}>${tspans}</text>`;
}

function _badgeElement({ text, pattern, x, y, fontSize }) {
  const p = FONT_PATTERNS[pattern];
  if (!p || p.type !== 'badge') return '';

  const b  = p.badge;
  const fs = fontSize || 30;
  const bW = Math.max(80, _esc(text || '').length * Math.round(fs * 0.75) + 28);
  const bH = Math.round(fs * 1.7);
  const border = b.border
    ? `stroke="${b.border}" stroke-width="2"`
    : `stroke="${b.bg}" stroke-width="0"`;

  return `<rect x="${x}" y="${y}" width="${bW}" height="${bH}" rx="4"
    fill="${b.bg}" opacity="0.92" ${border}/>
  <text x="${x + 12}" y="${y + Math.round(bH * 0.72)}"
    font-family="'Noto Sans JP',sans-serif" font-weight="900" font-size="${fs}"
    fill="${b.fg}">${_esc(text)}</text>`;
}

// ─── SVGビルダー（メイン）────────────────────────────────────────
// layers: [{ text, pattern, x, y, fontSize?, lineSpacing? }, ...]
function buildSVG(layers) {
  const W = 1280, H = 720;
  const usedGrads = new Set();
  layers.forEach(l => {
    const p = FONT_PATTERNS[l.pattern];
    if (p && p.grad) usedGrads.add(l.pattern);
  });

  const defs = [...usedGrads].map(pid => {
    const p = FONT_PATTERNS[pid];
    return _gradDef(`grad${pid}`, GRADS[p.grad]);
  }).join('\n');

  const elements = layers.map(l => {
    const p = FONT_PATTERNS[l.pattern];
    if (!p) return '';
    return p.type === 'badge'
      ? _badgeElement(l)
      : _textElement(l);
  }).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"
  style="position:absolute;top:0;left:0;pointer-events:none;">
  <defs>${defs}</defs>
  ${elements}
</svg>`;
}

// ─── Puppeteer合成 ────────────────────────────────────────────
async function composite({ bgPath, layers, outputPath }) {
  const bgBase64  = fs.readFileSync(bgPath).toString('base64');
  const bgMime    = bgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const bgDataUrl = `data:${bgMime};base64,${bgBase64}`;
  const svgLayer  = buildSVG(layers);

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@900&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0}
html,body{width:1280px;height:720px;overflow:hidden;background:#000}
.wrap{position:relative;width:1280px;height:720px}
img.bg{position:absolute;inset:0;width:1280px;height:720px;object-fit:cover}
</style>
</head><body>
<div class="wrap">
  <img class="bg" src="${bgDataUrl}">
  ${svgLayer}
</div>
</body></html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 400));
    const el = await page.$('.wrap');
    await el.screenshot({ path: outputPath });
  } finally {
    await browser.close();
  }
}

module.exports = { composite, buildSVG, FONT_PATTERNS, patternsForPrompt };
