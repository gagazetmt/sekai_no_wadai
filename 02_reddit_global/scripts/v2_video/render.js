// scripts/v2_video/render.js
// V2 動画生成オーケストレーター
//
// 使い方:
//   node scripts/v2_video/render.js <postId> [<jobId>]
//
// 動作:
//   1. data/{postId}_modules.json を読み込む
//   2. 各モジュールを HTML レンダリング → Puppeteer で MP4（10秒固定）にキャプチャ
//   3. ffmpeg concat で結合
//   4. BGM （bgm.mp3）をループで乗せる
//   5. data/v2_videos/ に保存
//   6. data/v2_jobs/{jobId}.json に進捗書き込み

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const { spawn, execSync } = require('child_process');
const puppeteer  = require('puppeteer');

const { buildOpeningHTML }    = require('./slides/opening');
const { buildEndingHTML }     = require('./slides/ending');
const { buildUniversalHTML }  = require('./slides/universal');
const { buildInsightHTML }    = require('./slides/insight');
const { buildHistoryHTML }    = require('./slides/history');
const { buildMatchcardHTML }  = require('./slides/matchcard');
const { buildProfileHTML }    = require('./slides/profile');
const { buildStatsHTML }      = require('./slides/stats');
const { buildComparisonHTML } = require('./slides/comparison');
const { buildReactionHTML }   = require('./slides/reaction');
const { imgDataUri }          = require('./slides/_common');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const W = 1920, H = 1080, FPS = 30;
const SLIDE_DURATION_MS = 8000; // Phase 4a: 各スライド固定8秒（音声長依存は Phase 4b で）

const BASE_DIR     = path.join(__dirname, '..', '..');
const DATA_DIR     = path.join(BASE_DIR, 'data');
const VIDEO_DIR    = path.join(DATA_DIR, 'v2_videos');
const JOB_DIR      = path.join(DATA_DIR, 'v2_jobs');
const BGM_PATH     = path.join(BASE_DIR, 'bgm.mp3');

[VIDEO_DIR, JOB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function modulesPath(postId) {
  return path.join(DATA_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '_modules.json');
}

function jobPath(jobId) {
  return path.join(JOB_DIR, jobId + '.json');
}

function updateJob(jobId, patch) {
  if (!jobId) return;
  const p = jobPath(jobId);
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {}
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(p, JSON.stringify(next, null, 2)); } catch (_) {}
}

// タイプ別に適切な slide HTML 生成関数を選ぶ
function buildSlideHTML(mod) {
  let html;
  switch (mod.type) {
    case 'opening':     html = buildOpeningHTML(mod);    break;
    case 'ending':      html = buildEndingHTML(mod);     break;
    case 'insight':     html = buildInsightHTML(mod);    break;
    case 'history':     html = buildHistoryHTML(mod);    break;
    case 'matchcard':   html = buildMatchcardHTML(mod);  break;
    case 'stats':       html = buildStatsHTML(mod);      break;
    case 'profile':     html = buildProfileHTML(mod);    break;
    case 'comparison':  html = buildComparisonHTML(mod); break;
    case 'reaction':    html = buildReactionHTML(mod);   break;
    default:            html = buildUniversalHTML(mod);
  }

  // mod.images[0] を背景画像として注入（matchcard はレイアウト複雑なので除外）
  if (mod.type !== 'matchcard' && Array.isArray(mod.images) && mod.images.length) {
    // /images/... は project root 相対パス。leading / を剥がして imgDataUri に渡す
    const relPath = mod.images[0].replace(/^\//, '');
    const dataUri = imgDataUri(relPath);
    if (dataUri) {
      const bgCss = `
.slide::before {
  content: ''; position: absolute; inset: 0; z-index: 0;
  background: url('${dataUri}') center/cover;
  opacity: 0.55;
  pointer-events: none;
}
.slide::after {
  content: ''; position: absolute; inset: 0; z-index: 1;
  background: linear-gradient(180deg, rgba(6,14,28,0.45) 0%, rgba(6,14,28,0.75) 100%);
  pointer-events: none;
}
`;
      html = html.replace('</style>', bgCss + '</style>');
    }
  }
  return html;
}

// 1スライドを Puppeteer + ffmpeg で MP4 化
async function renderSlide(page, html, durationMs, outPath) {
  const totalFrames = Math.round(durationMs / 1000 * FPS);

  await page.setContent(html, { waitUntil: 'load', timeout: 60000 });

  const ff = spawn(FFMPEG, [
    '-y',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-r', String(FPS), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-vf', `scale=${W}:${H}`,
    outPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  const done = new Promise((resolve, reject) => {
    ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)));
    ff.stderr.on('data', () => {}); // drain
  });

  // 各フレームでアニメ時刻を固定してキャプチャ（全アニメが同期する）
  for (let f = 0; f < totalFrames; f++) {
    const tMs = Math.round(f * 1000 / FPS);
    await page.evaluate(tMs => new Promise(resolve => {
      document.getAnimations().forEach(a => {
        a.pause();
        try { a.currentTime = tMs; } catch (_) {}
      });
      requestAnimationFrame(resolve);
    }), tMs);
    const buf = await page.screenshot({ type: 'jpeg', quality: 82 });
    const ok = ff.stdin.write(buf);
    if (!ok) await new Promise(r => ff.stdin.once('drain', r));
  }

  ff.stdin.end();
  await done;
}

async function main() {
  const postId = process.argv[2];
  const jobId  = process.argv[3] || `job_${Date.now()}`;

  if (!postId) {
    console.error('Usage: node scripts/v2_video/render.js <postId> [<jobId>]');
    process.exit(1);
  }

  updateJob(jobId, {
    status:     'starting',
    postId,
    startedAt:  new Date().toISOString(),
    totalSlides: 0,
    doneSlides:  0,
    outputVideo: null,
    error:       null,
  });

  // モジュール読み込み
  const mp = modulesPath(postId);
  if (!fs.existsSync(mp)) {
    updateJob(jobId, { status: 'error', error: `modules not found: ${mp}` });
    console.error('modules not found:', mp);
    process.exit(1);
  }
  const { modules = [] } = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (!modules.length) {
    updateJob(jobId, { status: 'error', error: 'modules empty' });
    process.exit(1);
  }

  const ts        = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const workDir   = path.join(VIDEO_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20)}_${ts}`);
  const outVideo  = path.join(VIDEO_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20)}_${ts}.mp4`);
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  updateJob(jobId, { status: 'rendering', totalSlides: modules.length });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${W},${H}`],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });

  const slideMp4s = [];

  try {
    for (let i = 0; i < modules.length; i++) {
      const mod  = modules[i];
      const html = buildSlideHTML(mod);
      const out  = path.join(workDir, `slide_${String(i).padStart(2, '0')}.mp4`);
      console.log(`[${i+1}/${modules.length}] ${mod.type} "${(mod.title||'').slice(0,30)}" → レンダリング中...`);
      await renderSlide(page, html, SLIDE_DURATION_MS, out);
      slideMp4s.push(out);
      updateJob(jobId, { doneSlides: i + 1 });
    }
  } finally {
    await browser.close();
  }

  // concat
  updateJob(jobId, { status: 'concatenating' });
  console.log('🔗 concat中...');
  const concatList = path.join(workDir, 'concat.txt');
  fs.writeFileSync(concatList, slideMp4s.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const videoOnly = path.join(workDir, 'video_only.mp4');
  execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${concatList}" -c copy "${videoOnly}"`, { stdio: 'pipe' });

  // BGM を乗せる
  updateJob(jobId, { status: 'mixing-audio' });
  console.log('🎵 BGM乗せ中...');
  const totalSec = modules.length * SLIDE_DURATION_MS / 1000;
  if (fs.existsSync(BGM_PATH)) {
    const cmd = `"${FFMPEG}" -y -i "${videoOnly}" -stream_loop -1 -i "${BGM_PATH}" ` +
                `-filter_complex "[1:a]volume=0.2[bgm];[bgm]atrim=0:${totalSec}[a]" ` +
                `-map 0:v -map "[a]" -c:v copy -c:a aac -shortest "${outVideo}"`;
    execSync(cmd, { stdio: 'pipe' });
  } else {
    fs.copyFileSync(videoOnly, outVideo);
  }

  updateJob(jobId, {
    status:     'done',
    outputVideo: path.relative(BASE_DIR, outVideo).replace(/\\/g, '/'),
    completedAt: new Date().toISOString(),
  });
  console.log(`✅ 完成: ${outVideo}`);
}

main().catch(e => {
  const jobId = process.argv[3];
  console.error('❌ error:', e.message);
  if (jobId) updateJob(jobId, { status: 'error', error: e.message });
  process.exit(1);
});
