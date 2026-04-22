// scripts/generate_soccer_yt_video_v2.js
// v2シナリオ対応 動画生成スクリプト
//
// 【スライド型】
//   opening  : タイトルカード（S1ベース）
//   simple   : 背景画像 + 字幕のみ（story も自動変換）
//   reaction : コメント吹き出し積み上げ
//   stats    : match_center_wide.html（左右両パネル）
//   formation: match_center_wide.html（同上）
//   type1    : プロフィール型（左=画像 右=データ行）
//   type2    : トピック型（左=データ行 右=画像）
//   insight  : インサイト強調スライド
//   ending   : アウトロ（S1ベース + CTA）
//
// 使い方: node scripts/generate_soccer_yt_video_v2.js <date> <postId>
// 例:     node scripts/generate_soccer_yt_video_v2.js 2026-04-16 23

require('dotenv').config();
const puppeteer  = require('puppeteer');
const fs         = require('fs');
const path       = require('path');
const { execSync, spawn } = require('child_process');
const { buildSlide, CMT_PRE_DELAY, CMT_STEP } = require('./slide_builder');

// ─── 定数 ────────────────────────────────────────────────────────────────────
const FFMPEG  = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe'  : 'ffmpeg';
const FFPROBE = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffprobe.exe' : 'ffprobe';
const W = 1920, H = 1080, FPS = 15;
const NARR_DELAY_MS = 1500;  // スライド遷移後、読み上げ開始までの余白
const NARR_TRAIL_MS = 1500;  // 読み上げ終了後の余韻

const BASE_DIR   = path.join(__dirname, '..');
const TEMP_DIR   = path.join(BASE_DIR, 'temp');
const SLIDES_DIR = path.join(BASE_DIR, 'soccer_yt_slides');
const VIDEO_DIR  = path.join(BASE_DIR, 'soccer_yt_videos');
const BGM_PATH   = path.join(BASE_DIR, 'bgm.mp3');

const date   = process.argv[2] || new Date().toISOString().slice(0, 10);
const postId = process.argv[3] || '1';

// ─── パス解決 ─────────────────────────────────────────────────────────────────
const scenarioFile = path.join(TEMP_DIR, `v2_scenario_${date}_${postId}.json`);
const ts           = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const slideDir     = path.join(SLIDES_DIR, `${date}_v2_${postId}`);
const outputVideo  = path.join(VIDEO_DIR,  `${date}_v2_${postId}_${ts}.mp4`);

[slideDir, VIDEO_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function getAudioDuration(p) {
  if (!p || !fs.existsSync(p)) return 4000;
  try {
    const r = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`,
      { stdio: 'pipe' }
    ).toString().trim();
    return Math.round(parseFloat(r) * 1000);
  } catch { return 4000; }
}

// ─── フレームキャプチャ → MP4 ─────────────────────────────────────────────────
async function renderVideo(page, slideHtml, durationMs, outputPath) {
  const duration    = durationMs / 1000;
  const totalFrames = Math.round(duration * FPS);
  const animSecs    = Math.max(duration, 6);
  const injectStyle = `<style id="v2-inject">.bg-img{animation-duration:${animSecs}s !important;}</style>`;
  const html = slideHtml.replace('</head>', `${injectStyle}</head>`);

  await page.setContent(html, { waitUntil: 'load', timeout: 60000 });

  const ffmpegProc = spawn(FFMPEG, [
    '-y', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', String(FPS), '-i', 'pipe:0',
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-vf', `scale=${W}:${H}`, outputPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const ffmpegDone = new Promise((resolve, reject) => {
    ffmpegProc.on('close', code => code === 0 ? resolve() : reject(new Error(`FFmpeg exit ${code}`)));
    ffmpegProc.stderr.on('data', () => {});
  });

  for (let f = 0; f < totalFrames; f++) {
    const tMs = Math.round((f / FPS) * 1000);
    await page.evaluate(tMs => new Promise(resolve => {
      document.getAnimations().forEach(a => {
        a.pause();
        try { a.currentTime = tMs; } catch (_) {}
      });
      requestAnimationFrame(resolve);
    }), tMs);
    const buf = await page.screenshot({ type: 'jpeg', quality: 80 });
    const ok = ffmpegProc.stdin.write(buf);
    if (!ok) await new Promise(r => ffmpegProc.stdin.once('drain', r));
  }

  ffmpegProc.stdin.end();
  await ffmpegDone;
}

// ─── 音声トラック合成 ─────────────────────────────────────────────────────────
function generateAudioTrack(durationsMs, narrPaths, phaseOffsetsMs, outputPath) {
  const totalSec = durationsMs.reduce((a, b) => a + b, 0) / 1000;
  let cumSec = 0;
  const slideStarts = durationsMs.map(d => { const s = cumSec; cumSec += d / 1000; return s; });

  const hasBgm = fs.existsSync(BGM_PATH);
  let inputs = hasBgm
    ? ` -stream_loop -1 -i "${BGM_PATH}"`
    : ` -f lavfi -t ${totalSec} -i "anullsrc=r=44100:cl=stereo"`;
  const filters = [];
  let idx = 0;
  filters.push(hasBgm
    ? `[${idx}:a]volume=0.08,atrim=0:${totalSec},asetpts=PTS-STARTPTS[base]`
    : `[${idx}:a]atrim=0:${totalSec}[base]`);
  idx++;

  let mixInputs = '[base]';
  const narrLabels = [];
  narrPaths.forEach((p, i) => {
    if (!p || !fs.existsSync(p)) return;
    const startSec = slideStarts[i] + (phaseOffsetsMs[i] || 0) / 1000;
    inputs += ` -i "${p}"`;
    filters.push(`[${idx}:a]volume=1.0,adelay=${Math.round(startSec * 1000)}|${Math.round(startSec * 1000)},apad[n${i}]`);
    narrLabels.push(`[n${i}]`);
    idx++;
  });

  if (narrLabels.length) {
    filters.push(`${mixInputs}${narrLabels.join('')}amix=inputs=${1 + narrLabels.length}:duration=first:normalize=0[out]`);
  } else {
    filters.push(`${mixInputs}acopy[out]`);
  }

  const cmd = `"${FFMPEG}" -y ${inputs} -filter_complex "${filters.join('; ')}" -map "[out]" -t ${totalSec} -c:a aac -b:a 192k "${outputPath}"`;
  execSync(cmd, { stdio: 'pipe' });
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(scenarioFile)) {
    console.error(`❌ シナリオファイルが見つかりません: ${scenarioFile}`);
    process.exit(1);
  }

  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const post     = scenario._meta ? { ...scenario._meta, ...scenario } : scenario;
  const modules  = scenario.modules || [];

  console.log(`🎬 動画生成開始: ${scenario.youtubeTitle || postId}`);
  console.log(`   モジュール数: ${modules.length}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${W},${H}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  const slidePaths   = [];
  const narrPaths    = [];
  const durationsMs  = [];
  const phaseOffsets = [];

  // news_overview を menu スライドに昇格し、目次アイテムを注入
  const menuMod = modules.find((m, idx) => idx > 0 && m.id === 'news_overview');
  if (menuMod) {
    menuMod.slideType = 'menu';
    menuMod.menuItems = modules
      .filter(m => !['opening','ending','news_overview'].includes(m.id))
      .map((m, idx) => `${idx + 1}. ${m.label || m.id}`);
  }

  for (let i = 0; i < modules.length; i++) {
    const mod      = modules[i];
    const narrPath = path.join(slideDir, `narr_${i}.mp3`);
    const slideMp4 = path.join(slideDir, `slide_${i}.mp4`);

    const narrDurMs  = getAudioDuration(narrPath);
    const narrDurSec = narrDurMs / 1000;
    const startDelay = NARR_DELAY_MS / 1000;

    let totalDurMs;
    if (mod.slideType === 'reaction') {
      const numCmts = (mod.keyPoints || []).length;
      totalDurMs = NARR_DELAY_MS
                 + narrDurMs
                 + Math.round(CMT_PRE_DELAY * 1000)
                 + Math.round(numCmts * CMT_STEP * 1000)
                 + 1200;
    } else {
      totalDurMs = NARR_DELAY_MS + narrDurMs + NARR_TRAIL_MS;
    }

    console.log(`  [${i}] ${mod.slideType || 'simple'} "${mod.label}" | 音声:${narrDurSec.toFixed(1)}s → スライド:${(totalDurMs/1000).toFixed(1)}s`);

    const html = buildSlide(mod, post, narrDurSec, startDelay);
    await renderVideo(page, html, totalDurMs, slideMp4);

    slidePaths.push(slideMp4);
    narrPaths.push(fs.existsSync(narrPath) ? narrPath : null);
    durationsMs.push(totalDurMs);
    phaseOffsets.push(NARR_DELAY_MS);
  }

  await browser.close();

  // ── スライド動画を結合 ─────────────────────────────────────────────────────
  console.log('🔗 スライド結合中...');
  const concatList = path.join(slideDir, 'concat.txt');
  fs.writeFileSync(concatList, slidePaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const videoOnly = path.join(slideDir, 'video_only.mp4');
  execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatList}" -c copy "${videoOnly}"`, { stdio: 'pipe' });

  // ── 音声トラック生成 ─────────────────────────────────────────────────────
  console.log('🎵 音声合成中...');
  const audioPath = path.join(slideDir, 'audio.aac');
  generateAudioTrack(durationsMs, narrPaths, phaseOffsets, audioPath);

  // ── 映像 + 音声 最終合成 ─────────────────────────────────────────────────
  console.log('🎞  最終合成中...');
  execSync(
    `"${FFMPEG}" -y -i "${videoOnly}" -i "${audioPath}" -c:v copy -c:a copy -shortest "${outputVideo}"`,
    { stdio: 'pipe' }
  );

  console.log(`✅ 完成: ${outputVideo}`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
