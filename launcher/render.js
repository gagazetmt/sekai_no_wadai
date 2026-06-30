// launcher/render.js
// 本番用レンダラー: mods + audio → スライド動画
// Linux VPS: Xvfb + ffmpeg x11grab（CDP スクリーンショット不要、実時間キャプチャ）
// Windows:   従来の CDP JPEG → ffmpeg stdin 方式

const puppeteer  = require('puppeteer');
const { spawn, execSync } = require('child_process');
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
const IS_LINUX = process.platform === 'linux';
const XVFB_DISPLAY = ':99';

// ── Xvfb 起動（Linux のみ） ───────────────────────────

function ensureXvfb() {
  // X11 ソケットで起動確認（xdpyinfo 不要）
  const dispNum = XVFB_DISPLAY.replace(':', '');
  const xSocket = `/tmp/.X11-unix/X${dispNum}`;
  if (fs.existsSync(xSocket)) {
    console.log('  [xvfb] already running on', XVFB_DISPLAY);
    return;
  }
  console.log('  [xvfb] starting on', XVFB_DISPLAY);
  const proc = spawn('Xvfb', [
    XVFB_DISPLAY, '-screen', '0', `${W}x${H}x24`, '-ac',
  ], { detached: true, stdio: 'ignore' });
  proc.unref();

  // ソケットが現れるまで最大2秒待つ
  let ready = false;
  for (let i = 0; i < 20; i++) {
    execSync('sleep 0.1', { stdio: 'ignore' });
    if (fs.existsSync(xSocket)) { ready = true; break; }
  }
  if (!ready) throw new Error('[xvfb] failed to start');
  console.log('  [xvfb] ready');
}

// ── Linux: Xvfb + x11grab 方式 ────────────────────────

async function renderSlideXvfb(page, name, html, durationSec, outputPath) {
  // kiosk モードで file:// は弾かれるため setContent で直接注入
  // 外部リソースが解決しなくてもタイムアウトしないよう 'load' を使用
  await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });

  await page.addStyleTag({ content: `
    html, body { width: ${W}px !important; height: ${H}px !important; overflow: hidden; }
    .slide { transform: scale(${W / 1920}); transform-origin: top left; }
  `});

  // アニメーション一時停止 & t=0 リセット
  const animCount = await page.evaluate(() => {
    const anims = document.getAnimations();
    anims.forEach(a => { a.pause(); a.currentTime = 0; });
    return anims.length;
  });

  // 2フレーム待って描画確定
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  // ffmpeg x11grab 開始（kiosk により Chrome UI なし → 0,0 から正確に 1280x720）
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'x11grab',
    '-video_size', `${W}x${H}`,
    '-framerate', String(FPS),
    '-i', `${XVFB_DISPLAY}+0,0`,
    '-t', String(durationSec),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-preset', 'ultrafast',
    '-crf', '23',
    outputPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let ffmpegErr = '';
  ffmpeg.stderr.on('data', d => { ffmpegErr += d.toString(); });

  // ffmpeg が x11grab を掴むまで少し待つ
  await new Promise(r => setTimeout(r, 200));

  // アニメーション再生（ffmpegキャプチャ開始後に解放）
  if (animCount > 0) {
    await page.evaluate(() => {
      document.getAnimations().forEach(a => { a.currentTime = 0; a.play(); });
    });
  }

  const t0 = Date.now();

  await new Promise((resolve, reject) => {
    ffmpeg.on('close', code => {
      if (code !== 0) reject(new Error(`ffmpeg(x11grab) exit ${code}: ${ffmpegErr.slice(-400)}`));
      else resolve();
    });
  });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const size = fs.existsSync(outputPath) ? (fs.statSync(outputPath).size / 1024).toFixed(0) : '?';
  console.log(`    [${name}] ${elapsed}s realtime / ${size}KB / ${durationSec.toFixed(1)}s dur / ${animCount} anims`);

}

// ── Windows: CDP JPEG → ffmpeg stdin 方式（従来） ─────

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
  console.log(`\n=== Render: Building slide videos [${IS_LINUX ? 'Xvfb/x11grab' : 'CDP/Win'}] ===\n`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const pattern = patternKey.startsWith('pieces_')
    ? buildPiecesPattern(mods.slice(1, -1).map(m => m.type || 'insight'))
    : getPattern(patternKey);

  if (IS_LINUX) ensureXvfb();

  const browserArgs = IS_LINUX
    ? [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        `--window-size=${W},${H}`, '--window-position=0,0',
        '--kiosk',              // タブ・アドレスバーを完全除去・フルスクリーン
        '--test-type',          // 「unsupported flag」警告バーを非表示
        '--no-first-run',
        '--noerrdialogs',
        '--disable-infobars',
        '--disable-notifications',
        '--disable-session-crashed-bubble',
        '--disable-restore-session-state',
        '--disable-features=TranslateUI',
        '--disable-sync',
      ]
    : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

  const browser = await puppeteer.launch({
    headless: !IS_LINUX,             // Linux は headless:false で Xvfb に表示
    protocolTimeout: 120_000,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : {}),
    ...(IS_LINUX ? { env: { ...process.env, DISPLAY: XVFB_DISPLAY } } : {}),
    // --enable-automation を除去 → 「自動テストで制御されています」バー非表示
    ...(IS_LINUX ? { ignoreDefaultArgs: ['--enable-automation'] } : {}),
    args: browserArgs,
  });

  // Linux は --app=about:blank で開いた最初のページを使い回す
  // browser.newPage() すると余分な2枚目タブが生えるので使わない
  const sharedPage = IS_LINUX ? (await browser.pages())[0] : null;
  if (sharedPage) {
    await sharedPage.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  }

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

    mod.durationSec = dur;

    let html = builder(mod);

    const isBookend = slot.type === 'opening' || slot.type === 'ending';

    if (!isBookend && mod.narration && (mod.subtitleWords?.length || mod.subtitleSegments?.length)) {
      html = injectSubtitles(html, mod.narration, mod.subtitleWords, dur, {
        leadPad: 0,
        narrationDurSec: mod.narrationDurOnly,
      });
    }
    if (!isBookend && mod.comments?.length) {
      html = injectCommentOverlay(html, mod.comments, mod.narrationEndSec, mod.commentTiming, dur);
    }

    const outPath = path.join(outputDir, `slide_${i}_${slot.type}.mp4`);

    try {
      if (IS_LINUX) {
        await renderSlideXvfb(sharedPage, `${i}_${slot.type}`, html, dur, outPath);
      } else {
        await renderSlide(browser, `${i}_${slot.type}`, html, dur, outPath);
      }
      videoFiles.push(outPath);
    } catch (err) {
      console.error(`    [${i}_${slot.type}] FAILED: ${err.message}`);
      videoFiles.push(null);
    }
  }

  if (sharedPage) await sharedPage.close();
  await browser.close();

  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n  All rendered in ${totalElapsed}s`);

  return videoFiles;
}

module.exports = { renderAll, renderSlide };
