// launcher/thumbnail.js
// サムネイル生成: 1280x720 JPEG

const puppeteer = require('puppeteer');
const path      = require('path');
const fs        = require('fs');

function buildThumbnailHTML({ title, badge = '速報', bgImageUrl = null }) {
  const bgStyle = bgImageUrl
    ? `background: linear-gradient(to right, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 60%), url('${bgImageUrl}') center/cover no-repeat;`
    : `background: radial-gradient(ellipse 70% 80% at 30% 50%, rgba(239,68,68,0.22) 0%, transparent 60%),
         linear-gradient(135deg, #1f2a4a 0%, #0a0e1a 60%, #060a14 100%);`;

  const lines = splitTitle(title);

  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1280px; height: 720px; overflow: hidden;
  font-family: "Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic","メイリオ",sans-serif; }

.thumb {
  width: 1280px; height: 720px; position: relative;
  ${bgStyle}
}
.overlay {
  position: absolute; inset: 0;
  background: linear-gradient(135deg, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0.15) 100%);
}
.content {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  justify-content: flex-end;
  padding: 50px 60px 54px;
  z-index: 5;
}
.badge {
  display: inline-block; align-self: flex-start;
  background: #ef4444; color: #fff;
  padding: 10px 26px; font-size: 24px; font-weight: 900;
  letter-spacing: 4px; border-radius: 4px;
  box-shadow: 0 4px 20px rgba(239,68,68,0.6);
  margin-bottom: 20px;
}
.accent-bar {
  width: 90px; height: 7px; background: #ef4444;
  box-shadow: 0 0 20px rgba(239,68,68,0.5);
  margin-bottom: 22px;
}
.title {
  font-size: 72px; font-weight: 900; color: #fff;
  line-height: 1.2; letter-spacing: 2px;
  text-shadow: 0 0 14px rgba(0,0,0,0.8), 0 4px 24px rgba(0,0,0,0.9);
  -webkit-text-stroke: 1px rgba(255,255,255,0.15);
}
.title span { display: block; }
.channel {
  position: absolute; right: 48px; bottom: 36px;
  display: flex; align-items: center; gap: 10px;
  background: rgba(0,0,0,0.72); border: 2px solid #ef4444;
  padding: 9px 20px; border-radius: 6px;
  font-size: 20px; font-weight: 900; color: #f1f5ff;
  letter-spacing: 2px; backdrop-filter: blur(4px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.5);
}
.channel-icon { color: #ef4444; font-size: 22px; }
</style></head>
<body>
<div class="thumb">
  <div class="overlay"></div>
  <div class="content">
    <div class="badge">${badge}</div>
    <div class="accent-bar"></div>
    <div class="title">${lines.map(l => `<span>${l}</span>`).join('')}</div>
  </div>
  <div class="channel">
    <span class="channel-icon">⚽</span>
    <span>5分でサッカー分析</span>
  </div>
</div>
</body></html>`;
}

// タイトルを2行に分割（20文字以内/行）
function splitTitle(title) {
  if (!title) return [''];
  if (title.length <= 20) return [title];
  // 句読点・スペースで区切る
  const mid = Math.ceil(title.length / 2);
  for (let i = mid; i < title.length; i++) {
    if ('　 、。！？・'.includes(title[i])) return [title.slice(0, i + 1), title.slice(i + 1)];
  }
  for (let i = mid; i >= 0; i--) {
    if ('　 、。！？・'.includes(title[i])) return [title.slice(0, i + 1), title.slice(i + 1)];
  }
  return [title.slice(0, mid), title.slice(mid)];
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
