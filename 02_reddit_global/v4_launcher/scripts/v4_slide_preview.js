// v4スライドプレビュー（開発確認用）
'use strict';
const puppeteer = require('puppeteer');
const path = require('path');
const fs   = require('fs');
const { buildV4PictureHTML }  = require('../slides/v4_picture');
const { buildV4ReactionHTML } = require('../slides/v4_reaction');
const { buildReactionHTML }   = require('../../scripts/v2_video/slides/reaction');

const OUT = path.join(__dirname, '..', 'thumbs');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const konatePath = path.join(__dirname, '..', '..', 'images_stock', 'players_official', 'ibrahima-konate', 'ibrahima-konate_001.jpg');

async function snap(html, name) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
  await page.evaluateHandle('document.fonts.ready');
  // アニメーションを即時完了させてスクショ時に全要素を表示
  await page.addStyleTag({ content: `
    *, *::before, *::after {
      animation-delay: 0s !important;
      animation-duration: 0.001s !important;
      transition-duration: 0s !important;
    }
  ` });
  await new Promise(r => setTimeout(r, 150));
  const out = path.join(OUT, name);
  await page.screenshot({ path: out });
  await browser.close();
  return out;
}

(async () => {
  // ピクチャー: 縦モード（左タイトル大 + 右画像）
  const picA = buildV4PictureHTML({
    images: [konatePath],
    title: 'リバポがコナテと\n契約延長しなかった\n理由が判明',
    orientation: 'vertical',
  });
  console.log('picture_band:', await snap(picA, 'slide_picture_band.png'));

  // ピクチャー: 横モード（フル画像）
  const picB = buildV4PictureHTML({
    images: [konatePath],
    orientation: 'horizontal',
  });
  console.log('picture_photo:', await snap(picB, 'slide_picture_photo.png'));

  // リアクションスライド
  const react = buildV4ReactionHTML({
    title: 'ネット民の反応',
    comments: [
      { text: 'マドリーが欲しいなら普通行くやろwwww', score: 3200 },
      { text: '交渉決裂してて笑う', score: 1800 },
      { text: 'コナテいい選手なのに惜しいな', score: 950 },
      { text: 'リバポのCB誰なるんやろ', score: 720 },
      { text: 'まあ選手の人生だしな', score: 430 },
    ],
  });
  console.log('reaction:', await snap(react, 'slide_reaction.png'));
})().catch(console.error);
