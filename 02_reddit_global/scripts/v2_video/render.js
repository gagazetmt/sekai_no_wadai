// scripts/v2_video/render.js
// V2 動画生成オーケストレーター
//
// 使い方:
//   node scripts/v2_video/render.js <postId> [<jobId>]
//
// 動作:
//   1. data/{postId}_modules.json を読み込む
//   2. narration あり / audio 未生成のスライドは MiniMax TTS を自動実行
//   3. 各モジュールを HTML レンダリング → Puppeteer で MP4 にキャプチャ
//   4. ffmpeg concat で結合
//   5. BGM （bgm.mp3）をループで乗せる
//   6. data/v2_videos/ に保存
//   7. data/v2_jobs/{jobId}.json に進捗書き込み

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const { spawn, execSync } = require('child_process');
const puppeteer  = require('puppeteer');

const tts = require('./tts_minimax');
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
const { mapImagesToModule }   = require('./slides/_common');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const W = 1920, H = 1080, FPS = 30;
const DEFAULT_SLIDE_MS = 8000;   // 音声無しスライドのフォールバック
const TAIL_PAD_MS      = 400;    // 音声末尾の余韻
const MAX_SLIDE_MS     = 60000;  // 暴走防止

// 並列度（VPS は 6 コア / 11GB RAM）
//   TTS: MiniMax API 同時 4 並列。レート制限考慮の上限
//   RENDER: 共有 browser に N page 作って各 page をワーカーが担当
//     並列度4だと CDP コールが 4ページ分キュー詰まりして
//     Puppeteer protocolTimeout (30秒) で失敗が頻発。3 に下げて余裕を持たせる
const TTS_CONCURRENCY    = 4;
const RENDER_CONCURRENCY = 3;

// 配列を limit 並列で順次処理（worker pool）
//   onError: 失敗時に { idx, error } を渡される。job ファイルに記録するなどに利用
async function processInParallel(items, limit, worker, onError) {
  let nextIdx = 0;
  await Promise.all(Array.from({ length: limit }, async (_, workerIdx) => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= items.length) return;
      try {
        await worker(items[idx], idx, workerIdx);
      } catch (e) {
        console.warn(`  ⚠️ worker#${workerIdx} item#${idx} 失敗: ${e.message}`);
        if (typeof onError === 'function') {
          try { onError({ idx, error: e.message, stack: (e.stack || '').slice(0, 800) }); } catch (_) {}
        }
      }
    }
  }));
}

// 音声チャンク合計 + 余韻 → スライド長(ms)を決定。音声無しなら DEFAULT
//   opening は無音時 6秒（タイトル冒頭のテンポ重視）、それ以外は 8秒
function slideDurationMs(mod) {
  const a = Array.isArray(mod.audio) ? mod.audio : [];
  if (a.length) {
    const sumSec = a.reduce((s, c) => s + (c.durationSec || 0), 0);
    if (sumSec > 0) {
      const ms = Math.round(sumSec * 1000) + TAIL_PAD_MS;
      return Math.min(ms, MAX_SLIDE_MS);
    }
  }
  return mod?.type === 'opening' ? 6000 : DEFAULT_SLIDE_MS;
}

const BASE_DIR     = path.join(__dirname, '..', '..');
const DATA_DIR     = path.join(BASE_DIR, 'data');
const VIDEO_DIR    = path.join(DATA_DIR, 'v2_videos');
const JOB_DIR      = path.join(DATA_DIR, 'v2_jobs');
const AUDIO_DIR    = path.join(DATA_DIR, 'v2_audio');
const BGM_PATH     = path.join(BASE_DIR, 'bgm.mp3');

[VIDEO_DIR, JOB_DIR, AUDIO_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function audioDirFor(postId) {
  const safe = (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
  const dir  = path.join(AUDIO_DIR, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// narration があるのに audio が空のスライドに対し MiniMax TTS を自動実行。
//   - 既に audio がある or narration が空なら何もしない
//   - mod.tts が無ければデフォルト値で生成
//   - 生成後 mod.audio を埋め、modules.json を呼び出し側で保存する
async function ensureSlideAudio(mod, idx, postId) {
  if (Array.isArray(mod.audio) && mod.audio.length) return false; // 既に生成済
  const narr = String(mod.narration || '').trim();
  // reaction はコメントだけでも音声化対象（narration が空でも進む）
  if (!narr && mod.type !== 'reaction') return false;

  const chunks = tts.buildChunksForModule(mod);
  if (!chunks.length) return false;

  const dir = audioDirFor(postId);
  // 旧ファイル掃除（同 idx の m{idx}_*.mp3）
  try {
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`m${String(idx).padStart(2, '0')}_`))
      .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} });
  } catch (_) {}

  const ttsCfg = mod.tts || {};
  const audio = [];
  for (let c = 0; c < chunks.length; c++) {
    const fname = `m${String(idx).padStart(2, '0')}_c${String(c).padStart(2, '0')}.mp3`;
    const out   = path.join(dir, fname);
    await tts.generateMiniMaxTTS({
      text: chunks[c],
      outputPath: out,
      voiceId: ttsCfg.voiceId || tts.DEFAULT_VOICE,
      model:   ttsCfg.model   || tts.DEFAULT_MODEL,
      emotion: ttsCfg.emotion || undefined,
      speed:   ttsCfg.speed   ?? undefined,
      vol:     ttsCfg.vol     ?? undefined,
      pitch:   ttsCfg.pitch   ?? undefined,
    });
    const dur = tts.probeDurationSec(out);
    audio.push({
      chunkIdx: c,
      text: chunks[c],
      file: path.relative(BASE_DIR, out).replace(/\\/g, '/'),
      durationSec: dur,
    });
  }
  mod.audio = audio;
  mod.tts = Object.assign({ generatedAt: new Date().toISOString() }, ttsCfg, { autoGenerated: true });
  return true;
}

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
//   mod.images[] を type 別に bgImage / leftImage / rightImage / homeImage / awayImage に展開してから渡す
function buildSlideHTML(mod) {
  const m = mapImagesToModule(mod);
  switch (m.type) {
    case 'opening':     return buildOpeningHTML(m);
    case 'ending':      return buildEndingHTML(m);
    case 'insight':     return buildInsightHTML(m);
    case 'history':     return buildHistoryHTML(m);
    case 'matchcard':   return buildMatchcardHTML(m);
    case 'stats':       return buildStatsHTML(m);
    // profile は stats と同じテンプレ（左=人物・チーム画像 / 右=データカード grid）
    //   旧 buildProfileHTML（試合プレビュー型）は実装が matchcard と重複しており未使用
    case 'profile':     return buildStatsHTML(m);
    case 'comparison':  return buildComparisonHTML(m);
    case 'reaction':    return buildReactionHTML(m);
    default:            return buildUniversalHTML(m);
  }
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

// ffmpeg を非同期で実行（execSync ではなく spawn 利用、並列ワーカーがブロックされない）
function _runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

// 1モジュールのナレーションを 1ファイルにまとめる。指定 durationMs に pad。
//   - mod.audio が無ければ「無音」を生成して返す
//   - chunk が複数あれば concat → apad で全体長に揃える
//   - async 化済（並列ワーカーから安全に呼べる）
async function buildSlideAudio(mod, durationMs, outPath) {
  const a = Array.isArray(mod.audio) ? mod.audio : [];
  const durSec = (durationMs / 1000).toFixed(3);

  if (!a.length) {
    return _runFfmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', durSec, '-c:a', 'aac', '-b:a', '128k', outPath]);
  }

  const absFiles = a.map(c => path.resolve(BASE_DIR, c.file));
  const missing = absFiles.filter(f => !fs.existsSync(f));
  if (missing.length === absFiles.length) {
    console.warn('  ⚠️ chunk audio 全て不在 → 無音');
    return _runFfmpeg(['-y', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`,
      '-t', durSec, '-c:a', 'aac', '-b:a', '128k', outPath]);
  }

  if (absFiles.length === 1) {
    return _runFfmpeg(['-y', '-i', absFiles[0], '-af', `apad=whole_dur=${durSec}`,
      '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', outPath]);
  }

  // 複数 chunk → concat filter で結合
  const inputArgs = [];
  absFiles.forEach(f => { inputArgs.push('-i', f); });
  const filterIn  = absFiles.map((_, i) => `[${i}:a]`).join('');
  const filterStr = `${filterIn}concat=n=${absFiles.length}:v=0:a=1[c];[c]apad=whole_dur=${durSec}[out]`;
  return _runFfmpeg(['-y', ...inputArgs, '-filter_complex', filterStr, '-map', '[out]',
    '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k', outPath]);
}

// video-only mp4 + audio mp4 → mux mp4
function muxAV(videoPath, audioPath, outPath) {
  execSync(
    `"${FFMPEG}" -y -i "${videoPath}" -i "${audioPath}" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 128k -shortest "${outPath}"`,
    { stdio: 'pipe' }
  );
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

  // ── TTS 自動生成フェーズ（並列）──
  //   narration ありか reaction の comments あり / audio 未生成のスライドのみ
  //   TTS_CONCURRENCY 並列で MiniMax 呼出
  updateJob(jobId, { status: 'tts-generating', totalSlides: modules.length });
  const targets = modules
    .map((m, i) => ({ i, m }))
    .filter(({ m }) => {
      if (Array.isArray(m.audio) && m.audio.length) return false;
      const hasNarr = !!String(m.narration || '').trim();
      const reactionHasComments = m.type === 'reaction'
        && Array.isArray(m.comments) && m.comments.some(c => String(c?.text || '').trim());
      return hasNarr || reactionHasComments;
    });
  if (targets.length) {
    console.log(`🎙️ TTS自動生成: ${targets.length}/${modules.length} スライド (並列度${TTS_CONCURRENCY})`);
    const ttsT0 = Date.now();
    let ttsDone = 0;
    await processInParallel(targets, TTS_CONCURRENCY, async ({ i, m }) => {
      try {
        const generated = await ensureSlideAudio(m, i, postId);
        if (generated) {
          console.log(`  ✅ slide#${i+1} TTS生成 (${m.audio.length} chunk)`);
        }
      } catch (e) {
        console.warn(`  ⚠️ slide#${i+1} TTS失敗: ${e.message} → 無音で継続`);
      }
      ttsDone++;
      updateJob(jobId, { ttsDone, ttsTotal: targets.length });
    });
    // 並列 race condition 回避でフェーズ末尾に1回だけ保存
    fs.writeFileSync(mp, JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
    console.log(`🎙️ TTS完了: ${((Date.now() - ttsT0) / 1000).toFixed(1)}秒`);
  } else {
    console.log('🎙️ TTS生成済 or ナレーション無し → スキップ');
  }

  updateJob(jobId, { status: 'rendering' });

  // ── Render フェーズ（並列）──
  //   1 browser を共有、N page を作って worker pool で各スライドを並列レンダ
  console.log(`🎬 Render: ${modules.length} スライド (並列度${RENDER_CONCURRENCY})`);
  const renderT0 = Date.now();
  const browser = await puppeteer.launch({
    headless: 'new',
    // 共有 browser に複数 page を作る並列レンダ方式では、CDP コールが
    // 他ページ分の処理待ちになり 30秒(デフォ) を超えて timeout する。
    // 240秒に伸ばして長尺スライド × 並列処理に耐えるよう調整
    protocolTimeout: 240_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', `--window-size=${W},${H}`],
  });
  const pages = await Promise.all(Array.from({ length: RENDER_CONCURRENCY }, async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: W, height: H });
    return p;
  }));

  // 各スライドの video-only / audio-only を別々に保持（xfade/acrossfade で繋ぐため）
  const TRANSITION_SEC = 0.4;  // クロスフェード時間（両側合わせ 0.4 秒）
  const slideVideos = new Array(modules.length);
  const slideAudios = new Array(modules.length);
  const slideDursMs = new Array(modules.length);

  let renderDone = 0;
  const renderFails = [];
  try {
    await processInParallel(
      modules.map((m, i) => ({ i, m })),
      RENDER_CONCURRENCY,
      async ({ i, m: mod }, _idxInList, workerIdx) => {
        const t0 = Date.now();
        const page = pages[workerIdx];
        const html = buildSlideHTML(mod);
        const durMs = slideDurationMs(mod);
        slideDursMs[i] = durMs;
        const videoOnly = path.join(workDir, `slide_${String(i).padStart(2, '0')}_v.mp4`);
        const audioOnly = path.join(workDir, `slide_${String(i).padStart(2, '0')}_a.m4a`);
        const audioCount = Array.isArray(mod.audio) ? mod.audio.length : 0;
        console.log(`[w${workerIdx}/${i+1}] ${mod.type} "${(mod.title||'').slice(0,28)}" / ${(durMs/1000).toFixed(1)}s / chunks=${audioCount} → レンダ開始`);
        await renderSlide(page, html, durMs, videoOnly);
        await buildSlideAudio(mod, durMs, audioOnly);
        slideVideos[i] = videoOnly;
        slideAudios[i] = audioOnly;
        renderDone++;
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`[w${workerIdx}/${i+1}] ✓ 完了 ${elapsed}秒`);
        updateJob(jobId, { doneSlides: renderDone, totalSlides: modules.length });
      },
      ({ idx, error }) => {
        renderFails.push({ idx: idx + 1, type: modules[idx]?.type || '?', error });
        updateJob(jobId, { renderFails });
      }
    );
    console.log(`🎬 Render完了: ${((Date.now() - renderT0) / 1000).toFixed(1)}秒 / 成功 ${renderDone}/${modules.length}`);
    if (renderFails.length) {
      console.warn(`  ⚠️ レンダ失敗 ${renderFails.length}件:`);
      renderFails.forEach(f => console.warn(`     - スライド#${f.idx} (${f.type}): ${f.error}`));
    }
  } finally {
    await browser.close();
  }

  // concat + xfade（クロスフェード）で繋ぐ
  updateJob(jobId, { status: 'concatenating' });
  console.log(`🔗 xfade concat中... (transition=${TRANSITION_SEC}s)`);
  const concatMp4 = path.join(workDir, 'concat.mp4');

  // ── レンダ失敗(undefined) 排除：成功したスライドだけで繋ぐ ──
  //   いずれかのスライドがレンダ失敗してても部分出力は完成させる方針
  const successIdxs = [];
  modules.forEach((_, i) => {
    if (slideVideos[i] && slideAudios[i] && fs.existsSync(slideVideos[i]) && fs.existsSync(slideAudios[i])) {
      successIdxs.push(i);
    } else {
      console.warn(`  ⚠️ スライド#${i+1} (${modules[i]?.type || '?'}) はレンダ失敗 → concat から除外`);
    }
  });
  if (!successIdxs.length) throw new Error('全スライドのレンダに失敗');
  const compactVideos = successIdxs.map(i => slideVideos[i]);
  const compactAudios = successIdxs.map(i => slideAudios[i]);
  const compactDursMs = successIdxs.map(i => slideDursMs[i]);
  if (successIdxs.length < modules.length) {
    console.warn(`  ⚠️ 部分出力モード: ${successIdxs.length}/${modules.length} スライドで動画生成`);
    updateJob(jobId, { partial: true, successCount: successIdxs.length });
  }

  // クロスフェードで全体時間が縮む: totalMs - TRANSITION * (N-1)
  const N = compactVideos.length;
  const transitionMs = Math.round(TRANSITION_SEC * 1000);
  const totalMs = compactDursMs.reduce((a, b) => a + b, 0) - transitionMs * Math.max(0, N - 1);

  if (N === 1) {
    // 1スライドなら xfade 不要、単純 mux
    muxAV(compactVideos[0], compactAudios[0], concatMp4);
  } else {
    // -i v0 v1 ... vN-1 a0 a1 ... aN-1 の順で全入力
    const inputs = [
      ...compactVideos.map(p => `-i "${p}"`),
      ...compactAudios.map(p => `-i "${p}"`),
    ].join(' ');

    // フィルタ式を組み立てる:
    //   [0:v][1:v]xfade=fade:d=T:offset=d0-T[v01]
    //   [v01][2:v]xfade=fade:d=T:offset=d0+d1-2T[v02]
    //   ...
    //   [N:a][N+1:a]acrossfade=d=T[a01]
    //   [a01][N+2:a]acrossfade=d=T[a02]
    const T = TRANSITION_SEC;
    const vParts = [];
    let cumDur = 0;
    let prevV = '[0:v]';
    for (let i = 1; i < N; i++) {
      cumDur += compactDursMs[i - 1] / 1000;
      const offset = (cumDur - T * i).toFixed(3);
      const out = (i === N - 1) ? '[vout]' : `[v${i}]`;
      vParts.push(`${prevV}[${i}:v]xfade=transition=fade:duration=${T}:offset=${offset}${out}`);
      prevV = out;
    }
    const aParts = [];
    let prevA = `[${N}:a]`;
    for (let i = 1; i < N; i++) {
      const out = (i === N - 1) ? '[aout]' : `[a${i}]`;
      aParts.push(`${prevA}[${N + i}:a]acrossfade=d=${T}${out}`);
      prevA = out;
    }
    const filter = [...vParts, ...aParts].join(';');

    // フィルタ式を一時ファイルに書き出し（コマンド長制限回避）
    const filterScript = path.join(workDir, 'xfade_filter.txt');
    fs.writeFileSync(filterScript, filter);

    const cmd = `"${FFMPEG}" -y ${inputs} -filter_complex_script "${filterScript}" ` +
                `-map "[vout]" -map "[aout]" ` +
                `-c:v libx264 -preset veryfast -pix_fmt yuv420p -r ${FPS} ` +
                `-c:a aac -b:a 128k -movflags +faststart "${concatMp4}"`;
    execSync(cmd, { stdio: 'pipe' });
  }

  // BGM を 18% で重ねる（ナレーションを邪魔しない）
  updateJob(jobId, { status: 'mixing-audio' });
  console.log('🎵 BGM ミックス中...');
  const totalSec = (totalMs / 1000).toFixed(3);
  if (fs.existsSync(BGM_PATH)) {
    const cmd = `"${FFMPEG}" -y -i "${concatMp4}" -stream_loop -1 -i "${BGM_PATH}" ` +
                `-filter_complex "[1:a]volume=0.18,atrim=0:${totalSec}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
                `-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "${outVideo}"`;
    execSync(cmd, { stdio: 'pipe' });
  } else {
    fs.copyFileSync(concatMp4, outVideo);
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
