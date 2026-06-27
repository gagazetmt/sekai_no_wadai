// launcher/render.js
// 本番用レンダラー: mods + audio → スライド動画
// render_test.js のCDP JPEG方式を本番用に改修

const puppeteer = require('puppeteer');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const { buildInsightHTML }    = require('./slides/insight');
const { buildOpeningHTML }    = require('./slides/opening');
const { buildHistoryHTML }    = require('./slides/history');
const { buildStatsHTML }      = require('./slides/stats');
const { buildMatchcardHTML }  = require('./slides/matchcard');
const { buildComparisonHTML } = require('./slides/comparison');
const { buildEndingHTML }     = require('./slides/ending');
const { getPattern, buildPiecesPattern } = require('./slide_patterns');
const { injectCommentOverlay } = require('./slides/comments');
const { injectSubtitles }     = require('./slides/subtitles');

const BUILDERS = {
  opening:    buildOpeningHTML,
  insight:    buildInsightHTML,
  history:    buildHistoryHTML,
  stats:      buildStatsHTML,
  matchcard:  buildMatchcardHTML,
  comparison: buildComparisonHTML,
  ending:     buildEndingHTML,
};

const FPS = 24;
const W = 1280, H = 720;

async function renderSlide(browser, name, html, durationSec, outputPath) {
  const totalFrames = Math.ceil(FPS * durationSec);
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0' });

  await page.addStyleTag({ content: `
    html, body { width: ${W}px !important; height: ${H}px !important; }
    .slide { transform: scale(${W / 1920}); transform-origin: top left; }
  `});

  await page.evaluate(() => new Promise(r => setTimeout(r, 100)));

  const animCount = await page.evaluate(() => {
    const anims = document.getAnimations();
    anims.forEach(a => a.pause());
    return anims.length;
  });

  const cdp = await page.createCDPSession();

  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS),
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-preset', 'ultrafast',
    '-crf', '23',
    outputPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  let ffmpegErr = '';
  ffmpeg.stderr.on('data', d => ffmpegErr += d.toString());

  const t0 = Date.now();

  for (let frame = 0; frame < totalFrames; frame++) {
    const timeMs = (frame / FPS) * 1000;
    if (animCount > 0) {
      await page.evaluate((t) => {
        document.getAnimations().forEach(a => { a.currentTime = t; });
      }, timeMs);
    }
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 95, fromSurface: true,
    });
    ffmpeg.stdin.write(Buffer.from(data, 'base64'));
  }

  ffmpeg.stdin.end();
  await cdp.detach();
  await new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg exit ${code}: ${ffmpegErr}`));
      else resolve();
    });
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const size = (fs.statSync(outputPath).size / 1024).toFixed(0);
  console.log(`    [${name}] ${elapsed}s / ${size}KB / ${durationSec.toFixed(1)}s duration / ${animCount} anims`);

  await page.close();
}

// ── メインAPI ─────────────────────────────────────────

async function renderAll(patternKey, mods, durations, outputDir) {
  console.log('\n=== Render: Building slide videos ===\n');

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // pieces_N は動的パターン: mod.type から再構築（静的テーブルに頼らない）
  const pattern = patternKey.startsWith('pieces_')
    ? buildPiecesPattern(mods.slice(1, -1).map(m => m.type || 'insight'))
    : getPattern(patternKey);
  const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const videoFiles = [];
  const t0 = Date.now();

  for (let i = 0; i < pattern.slides.length; i++) {
    const slot = pattern.slides[i];
    const mod = mods[i];
    const dur = durations[i] || 10;
    const builder = BUILDERS[slot.type];

    if (!builder) {
      console.error(`    Unknown slide type: ${slot.type}`);
      videoFiles.push(null);
      continue;
    }

    // durationSec を mod に注入（アニメーション制御用）
    mod.durationSec = dur;

    let html = builder(mod);

    // 字幕バー注入
    if (mod.subtitleChunks?.length) {
      html = injectSubtitles(html, mod.subtitleChunks, dur);
    }

    // コメントオーバーレイ注入
    const isBookend = slot.type === 'opening' || slot.type === 'ending';
    if (!isBookend && mod.comments?.length && mod.narrationEndSec > 0) {
      html = injectCommentOverlay(html, mod.comments, mod.narrationEndSec);
    }
    const outPath = path.join(outputDir, `slide_${i}_${slot.type}.mp4`);

    try {
      await renderSlide(browser, `${i}_${slot.type}`, html, dur, outPath);
      videoFiles.push(outPath);
    } catch (err) {
      console.error(`    [${i}_${slot.type}] FAILED: ${err.message}`);
      videoFiles.push(null);
    }
  }

  await browser.close();

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  All rendered in ${totalElapsed}s`);

  return videoFiles;
}

module.exports = { renderAll, renderSlide };
