#!/usr/bin/env node
// Playwright 録画でスライドを動画化するテスト
// Usage: node _test_playwright_render.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// render.js からスライドHTML生成を借りる
const { mapImagesToModule } = require('./slides/_common');
const { buildOpeningHTML: buildOpeningV1 } = require('./slides/opening');
const { buildOpeningHTML: buildOpeningV2 } = require('./slides/opening_v2');
const { buildOpeningHTML: buildOpeningV3 } = require('./slides/opening_v3');
const OP_BUILDERS = { v1: buildOpeningV1, v2: buildOpeningV2, v3: buildOpeningV3 };

const W = 1920, H = 1080;
const LEAD_PAD_MS = 500;
const TAIL_PAD_MS = 500;

const MODULES_FILE = path.join(__dirname, '..', '..', 'data',
  '_r_soccer_comments_1tvjpbc_lucas_gatti_alexis_mac_allister_has_emerged_as__modules.json');

function slideDurationMs(mod) {
  const a = Array.isArray(mod.audio) ? mod.audio : [];
  if (a.length) {
    const sumSec = a.reduce((s, c) => s + (c.durationSec || 0), 0);
    if (sumSec > 0) return Math.round(sumSec * 1000) + LEAD_PAD_MS + TAIL_PAD_MS;
  }
  return mod?.type === 'opening' ? 5000 : 8000;
}

(async () => {
  const t0 = Date.now();

  const data = JSON.parse(fs.readFileSync(MODULES_FILE, 'utf8'));
  const mod = data.modules[0]; // opening
  const m = mapImagesToModule(mod);
  const opVar = (m.variant && OP_BUILDERS[m.variant]) ? m.variant : 'v1';
  const html = OP_BUILDERS[opVar](m);
  const durationMs = slideDurationMs(mod);
  const durSec = durationMs / 1000;

  console.log(`[test] opening: ${durSec}s / variant=${opVar}`);

  const outDir = path.join(__dirname, '..', '..', 'data', 'v2_videos');
  const outPath = path.join(outDir, `_pw_test_opening.webm`);

  // Playwright で録画
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: outDir, size: { width: W, height: H } },
  });
  const page = await context.newPage();

  const tSetContent = Date.now();
  await page.setContent(html, { waitUntil: 'load', timeout: 60000 });
  console.log(`[test] setContent: ${Date.now() - tSetContent}ms`);

  // アニメーションをリアルタイム再生させて待つ
  const tRecord = Date.now();
  await page.waitForTimeout(durationMs);
  console.log(`[test] 録画待機: ${Date.now() - tRecord}ms (target: ${durationMs}ms)`);

  // コンテキストを閉じると録画ファイルが確定する
  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  // webm → mp4 変換
  const mp4Path = outPath.replace('.webm', '.mp4');
  const { execSync } = require('child_process');
  execSync(`ffmpeg -y -i "${videoPath}" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -r 30 "${mp4Path}"`, { stdio: 'pipe' });

  // webm 削除
  try { fs.unlinkSync(videoPath); } catch (_) {}

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  const stat = fs.statSync(mp4Path);
  console.log(`[test] 完了: ${totalSec}s / ${(stat.size / 1024 / 1024).toFixed(1)}MB`);
  console.log(`[test] 出力: ${mp4Path}`);
})().catch(e => { console.error(e); process.exit(1); });
