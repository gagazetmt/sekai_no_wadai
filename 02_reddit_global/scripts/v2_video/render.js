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

const tts = require('./tts_engine');  // provider 抽象化レイヤ。既定 Gemini、保険で MiniMax
const { buildOpeningHTML: buildOpeningV1 } = require('./slides/opening');
const { buildOpeningHTML: buildOpeningV2 } = require('./slides/opening_v2');
const { buildOpeningHTML: buildOpeningV3 } = require('./slides/opening_v3');
const { buildEndingHTML:  buildEndingV1  } = require('./slides/ending');
const { buildEndingHTML:  buildEndingV2  } = require('./slides/ending_v2');
const { buildEndingHTML:  buildEndingV3  } = require('./slides/ending_v3');
const OP_BUILDERS = { v1: buildOpeningV1, v2: buildOpeningV2, v3: buildOpeningV3 };
const ED_BUILDERS = { v1: buildEndingV1,  v2: buildEndingV2,  v3: buildEndingV3  };
const { buildUniversalHTML }  = require('./slides/universal');
const { buildInsightHTML }    = require('./slides/insight');
const { buildHistoryHTML }    = require('./slides/history');
const { buildMatchcardHTML }  = require('./slides/matchcard');
const { buildProfileHTML }    = require('./slides/profile');
const { buildStatsHTML }      = require('./slides/stats');
const { buildComparisonHTML } = require('./slides/comparison');
const { buildReactionHTML }   = require('./slides/reaction');
const { buildTocHTML }        = require('./slides/toc');
const { buildRankingHTML }    = require('./slides/ranking');
const { buildTimelineHTML }   = require('./slides/timeline');
const { mapImagesToModule, LEAD_PAD_SEC, TAIL_PAD_SEC }   = require('./slides/_common');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const W = 1920, H = 1080, FPS = 30;
const DEFAULT_SLIDE_MS = 8000;   // 音声無しスライドのフォールバック
// 音声前後の無音インターバル（_common.js と共有・全スライド共通）
const LEAD_PAD_MS = Math.round(LEAD_PAD_SEC * 1000);
const TAIL_PAD_MS = Math.round(TAIL_PAD_SEC * 1000);
const MAX_SLIDE_MS     = 90000;  // 暴走防止（2026-05-07: 60→90s に拡張、reaction 7コメント全件読み切る尺確保）

// 並列度（VPS は 6 コア / 11GB RAM）
//   TTS: env TTS_CONCURRENCY で上書き可能（既定 4）
//     MiniMax: 4 並列 OK / Gemini 2.5 Pro TTS: RPM 10 制限あり → 1-2 推奨
//   RENDER: 共有 browser に N page 作って各 page をワーカーが担当
//     並列度4だと CDP コールが 4ページ分キュー詰まりして
//     Puppeteer protocolTimeout (30秒) で失敗が頻発。3 に下げて余裕を持たせる
const TTS_CONCURRENCY    = Math.max(1, parseInt(process.env.TTS_CONCURRENCY || '4', 10));
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

// 音声チャンク合計 + 前後インターバル → スライド長(ms)を決定。音声無しなら DEFAULT
//   opening は無音時 6秒（タイトル冒頭のテンポ重視）、それ以外は 8秒
function slideDurationMs(mod) {
  const a = Array.isArray(mod.audio) ? mod.audio : [];
  if (a.length) {
    const sumSec = a.reduce((s, c) => s + (c.durationSec || 0), 0);
    if (sumSec > 0) {
      const ms = Math.round(sumSec * 1000) + LEAD_PAD_MS + TAIL_PAD_MS;
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
const BGM_DIR      = path.join(BASE_DIR, 'bgm');
const BGM_FALLBACK = path.join(BASE_DIR, 'bgm.mp3');  // 旧形式互換

// BGM をランダム選曲（bgm/*.mp3 を全部リストして1つランダム選択）
//   フォルダが空 or 無ければ旧 bgm.mp3 にフォールバック
function pickBgm() {
  try {
    if (fs.existsSync(BGM_DIR)) {
      const files = fs.readdirSync(BGM_DIR)
        .filter(f => /\.(mp3|m4a|wav|aac)$/i.test(f))
        .map(f => path.join(BGM_DIR, f));
      if (files.length) {
        const pick = files[Math.floor(Math.random() * files.length)];
        console.log(`🎵 BGM選択: ${path.basename(pick)} (候補${files.length}曲から)`);
        return pick;
      }
    }
  } catch (_) {}
  return fs.existsSync(BGM_FALLBACK) ? BGM_FALLBACK : null;
}

[VIDEO_DIR, JOB_DIR, AUDIO_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function audioDirFor(postId) {
  const safe = (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
  const dir  = path.join(AUDIO_DIR, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 1スライド分の TTS 生成タスク (chunk配列) を作る。実生成は呼び出し側で並列化
function buildSlideTtsTasks(mod, idx, postId) {
  if (Array.isArray(mod.audio) && mod.audio.length) return []; // 既に生成済
  const narr = String(mod.narration || '').trim();
  // narration 空でも opening (title 読み上げ) / reaction (comments) / toc (items) は対象
  const titleAvailable = mod.type === 'opening' && String(mod.title || '').trim();
  const tocItemsAvailable = mod.type === 'toc' && Array.isArray(mod.tocItems) && mod.tocItems.length;
  if (!narr && mod.type !== 'reaction' && !titleAvailable && !tocItemsAvailable) return [];
  const chunks = tts.buildChunksForModule(mod);
  if (!chunks.length) return [];

  const dir = audioDirFor(postId);
  // 旧ファイル掃除（同 idx の m{idx}_*.mp3）
  try {
    fs.readdirSync(dir)
      .filter(f => f.startsWith(`m${String(idx).padStart(2, '0')}_`))
      .forEach(f => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} });
  } catch (_) {}

  // ttsCfg は読み取り専用扱いで、reaction の場合 speed を +10% override（コメント読み上げ高速化）
  //   2026-05-08: 相棒指示で reaction 全体に適用（前置きナレも含む）
  const ttsCfg = { ...(mod.tts || {}) };
  if (mod.type === 'reaction' && ttsCfg.speed == null) {
    // 通常 default 1.03 → reaction では 1.13 で 10% 早め
    ttsCfg.speed = 1.13;
  }
  // provider: module 単位 → 環境変数 → 'gemini' の順で解決
  const provider = ttsCfg.provider || tts.DEFAULT_PROVIDER;
  const defaults = tts.getDefaults(provider);

  // 🆕 reaction の comment chunk (c >= 1) はランダム voice（複数キャラ感）
  //   modules.json の m.reactionVoices に保存して再生成しても同じ voice を維持
  //   chunk[0] (前置きナレ) はメイン voice、chunk[1+] (各コメント) がランダム
  let reactionVoices = null;
  let reactionStyleInstructions = null;
  if (mod.type === 'reaction' && provider === 'gemini') {
    const commentChunkCount = Math.max(0, chunks.length - 1);
    if (Array.isArray(mod.reactionVoices) && mod.reactionVoices.length >= commentChunkCount) {
      reactionVoices = mod.reactionVoices.slice(0, commentChunkCount);
    } else {
      const ttsGemini = require('./tts_gemini');
      reactionVoices = [];
      for (let i = 0; i < commentChunkCount; i++) {
        reactionVoices.push(ttsGemini.pickReactionVoice());
      }
      mod.reactionVoices = reactionVoices;  // modules.json に保存される
    }
    // reaction comment 用 style: 感情控えめ + テンポやや早め (引用文読み)
    const ttsGemini = require('./tts_gemini');
    reactionStyleInstructions = ttsGemini.getReactionStyleInstructions();
  }

  return chunks.map((text, c) => {
    const fname = `m${String(idx).padStart(2, '0')}_c${String(c).padStart(2, '0')}.mp3`;
    const out   = path.join(dir, fname);
    let voiceId = ttsCfg.voiceId || defaults.voice;
    let styleInstructions = ttsCfg.styleInstructions || undefined;
    // reaction の comment chunk (c >= 1) は事前抽選 voice + 専用 style
    if (reactionVoices && c >= 1) {
      voiceId = reactionVoices[c - 1] || voiceId;
      styleInstructions = reactionStyleInstructions;
    }
    return {
      slideIdx: idx, chunkIdx: c, text, outputPath: out,
      provider,
      voiceId,
      model:   ttsCfg.model   || defaults.model,
      styleInstructions,                                          // Gemini 専用
      emotion: ttsCfg.emotion || undefined,                       // MiniMax 専用
      speed:   ttsCfg.speed   ?? undefined,
      vol:     ttsCfg.vol     ?? undefined,
      pitch:   ttsCfg.pitch   ?? undefined,
      ttsCfg,
    };
  });
}

// 1チャンク分の TTS 生成 → ファイル書き出し → メタ返却
async function runSingleTtsTask(t) {
  await tts.generate({
    provider: t.provider,
    text: t.text, outputPath: t.outputPath,
    voiceId: t.voiceId, model: t.model,
    styleInstructions: t.styleInstructions,
    emotion: t.emotion, speed: t.speed, vol: t.vol, pitch: t.pitch,
    apiKey: t.apiKey,  // 影分身: 事前割当キー（未指定なら従来通り）
  });
  const dur = tts.probeDurationSec(t.outputPath);
  return {
    slideIdx: t.slideIdx, chunkIdx: t.chunkIdx, text: t.text,
    file: path.relative(BASE_DIR, t.outputPath).replace(/\\/g, '/'),
    durationSec: dur,
  };
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
  const opVar = (m.variant && OP_BUILDERS[m.variant]) ? m.variant : 'v1';
  const edVar = (m.variant && ED_BUILDERS[m.variant]) ? m.variant : 'v1';
  switch (m.type) {
    case 'opening':     return OP_BUILDERS[opVar](m);
    case 'ending':      return ED_BUILDERS[edVar](m);
    case 'toc':         return buildTocHTML(m);
    case 'insight':     return buildInsightHTML(m);
    case 'history':     return buildHistoryHTML(m);
    case 'matchcard':   return buildMatchcardHTML(m);
    case 'stats':       return buildStatsHTML(m);
    // profile は stats と同じテンプレ（左=人物・チーム画像 / 右=データカード grid）
    //   旧 buildProfileHTML（試合プレビュー型）は実装が matchcard と重複しており未使用
    case 'profile':     return buildStatsHTML(m);
    case 'comparison':  return buildComparisonHTML(m);
    case 'reaction':    return buildReactionHTML(m);
    case 'ranking':     return buildRankingHTML(m);
    case 'timeline':    return buildTimelineHTML(m);
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
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
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
//   - 音声がある場合は先頭に LEAD_PAD_SEC の silence を挟み、末尾は apad で全体長まで pad
//     （字幕 / chunk 連動アニメ側も同じ LEAD/TAIL を使うので同期する）
//   - async 化済（並列ワーカーから安全に呼べる）
async function buildSlideAudio(mod, durationMs, outPath) {
  const a = Array.isArray(mod.audio) ? mod.audio : [];
  const durSec = (durationMs / 1000).toFixed(3);
  const leadDurSec = LEAD_PAD_SEC.toFixed(3);

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

  // 先頭 silence + chunk(s) を順次 concat → 末尾は apad で全体長まで pad
  // silence を [0] 入力、その後 chunk 群を [1..N]
  const inputArgs = ['-f', 'lavfi', '-t', leadDurSec, '-i', 'anullsrc=r=44100:cl=stereo'];
  absFiles.forEach(f => { inputArgs.push('-i', f); });
  const concatN = absFiles.length + 1;  // silence + chunks
  const filterIn = ['[0:a]', ...absFiles.map((_, i) => `[${i + 1}:a]`)].join('');
  const filterStr = `${filterIn}concat=n=${concatN}:v=0:a=1[c];[c]apad=whole_dur=${durSec}[out]`;
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

  // ── TOC 自動挿入 ──
  //   opening 直後（無ければ先頭）に toc を 1枚挿入。
  //   tocItems は opening/toc/ending を除く全スライドの title から自動抽出。
  //   章2件未満ならスキップ。既に toc を含む案件はそのまま尊重。
  if (!modules.some(m => m && m.type === 'toc')) {
    const chapters = modules
      .filter(m => m && !['opening', 'toc', 'ending'].includes(m.type))
      .map(m => String(m.title || '').trim())
      .filter(Boolean);
    if (chapters.length >= 2) {
      const insertIdx = (modules[0] && modules[0].type === 'opening') ? 1 : 0;
      const tocChapters = chapters.slice(0, 8);
      const intro = '今日のラインナップはこちらです';
      // narrationChunks: [intro, ...items] → audio.length = items.length + 1
      // toc.js は audio.length === items.length + 1 ならイントロ扱いで chunkStarts[i+1] を items[i] の登場時刻に使う
      modules.splice(insertIdx, 0, {
        type: 'toc',
        title: '今日のラインナップ',
        tocItems: tocChapters,
        narration: intro + '。' + tocChapters.join('。') + '。',
        narrationChunks: [intro, ...tocChapters],
      });
      console.log(`📑 TOC 自動挿入: ${tocChapters.length} 章 (slot ${insertIdx}, イントロ+項目読み上げ ON)`);
    }
  }

  const ts        = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const workDir   = path.join(VIDEO_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20)}_${ts}`);
  const outVideo  = path.join(VIDEO_DIR, `${postId.replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20)}_${ts}.mp4`);
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  // ── 🆕 profile スライドに国旗+クラブロゴを自動注入（auto_image_inject）──
  //   stats.js (= profile も同じ) が mod.flagImage / mod.clubLogo を読んで左カラム右上にオーバーレイ表示
  try {
    const { injectAutoImages } = require('./utils/auto_image_inject');
    // step2_routes.siPath() と同じ形式: replace のみ（slice 無し）
    const siPath = path.join(DATA_DIR, 'si_data', (postId || 'unknown').replace(/[/\?%*:|"<>.]/g, '_') + '.json');
    let si = null;
    try { si = JSON.parse(fs.readFileSync(siPath, 'utf8')); } catch (_) {}
    if (si) {
      let injected = 0;
      modules.forEach(m => {
        const before = m.flagImage || m.clubLogo;
        injectAutoImages(m, si);
        if (!before && (m.flagImage || m.clubLogo)) injected++;
      });
      if (injected) console.log(`🚩 auto_image_inject: ${injected} スライドに国旗/ロゴ注入`);
    }
  } catch (e) {
    console.warn('  ⚠️ auto_image_inject 失敗（非致命）:', e.message);
  }

  // ── 🆕 ja.wikipedia 公式カタカナ化キャッシュを温める（matchcard 等の選手名対応）──
  //   matchcard / profile / stats などで英字選手名が混じってる場合、ja.wiki 検索で公式表記取得
  //   キャッシュは data/player_kana_cache.json に永続化されるので、次回ビルドは即返し
  try {
    const { prefetchKanaBatch, isAllAscii } = require('./utils/wiki_ja_kana');
    const namesToKana = new Set();
    modules.forEach(m => {
      // matchcard の lineup
      const md = m?.matchData || {};
      ['home', 'away'].forEach(side => {
        (md.lineup?.[side] || []).forEach(p => {
          if (p?.name && isAllAscii(p.name)) namesToKana.add(p.name);
        });
        (md.subs?.[side] || []).forEach(p => {
          if (p?.name && isAllAscii(p.name)) namesToKana.add(p.name);
        });
      });
      // 得点者・退場者・トップパフォーマー
      (md.goals || []).forEach(g => { if (g?.player && isAllAscii(g.player)) namesToKana.add(g.player); });
      (md.cards || []).forEach(c => { if (c?.player && isAllAscii(c.player)) namesToKana.add(c.player); });
      (md.topPlayers || []).forEach(p => { if (p?.name && isAllAscii(p.name)) namesToKana.add(p.name); });
      // mod.title / mainKey の中の英字名
      const txt = (m?.title || '') + ' ' + (m?.mainKey || '');
      const m2 = txt.match(/[A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+){1,3}/g);
      if (m2) m2.forEach(n => namesToKana.add(n));
    });
    if (namesToKana.size) {
      console.log(`🔤 ja.wiki カタカナ化 prefetch: ${namesToKana.size} 名`);
      await prefetchKanaBatch([...namesToKana]);
    }
  } catch (e) {
    console.warn('  ⚠️ wiki_ja_kana prefetch 失敗（非致命）:', e.message);
  }

  // ── TTS 自動生成フェーズ（並列）──
  //   narration ありか reaction の comments あり / audio 未生成のスライドのみ
  //   TTS_CONCURRENCY 並列で MiniMax 呼出（chunk 単位の global プール）
  updateJob(jobId, { status: 'tts-generating', totalSlides: modules.length });

  // (slide, chunk) ペアの全タスクを集める
  const allTasks = [];
  const slidesNeedingTts = new Set();
  modules.forEach((m, i) => {
    const tasks = buildSlideTtsTasks(m, i, postId);
    if (tasks.length) {
      slidesNeedingTts.add(i);
      allTasks.push(...tasks);
    }
  });

  if (allTasks.length) {
    // 影分身術: 各 chunk に Gemini API キーを事前ブロック分配（複数キー設定時のみ）
    //   chunks=50, keys=3 → key#0: chunk 1-17, key#1: chunk 18-34, key#2: chunk 35-50
    //   各並列ワーカーが固定キーで叩く → RPM/RPD を完全独立活用
    //   失敗 chunk は 2 パス目で（apiKey 未指定なら）グローバル hot swap が走る
    try {
      const geminiKeys = tts.getEngine('gemini')?.getApiKeys?.() || [];
      if (geminiKeys.length > 1) {
        const chunksPerKey = Math.ceil(allTasks.length / geminiKeys.length);
        allTasks.forEach((t, i) => {
          const keyIdx = Math.min(Math.floor(i / chunksPerKey), geminiKeys.length - 1);
          t.apiKey = geminiKeys[keyIdx];
          t._keyIdxForLog = keyIdx;
        });
        console.log(`🥷 影分身術: ${geminiKeys.length} キーに ${allTasks.length} chunk をブロック分配（各 ${chunksPerKey} chunk）`);
      }
    } catch (e) {
      console.warn('  ⚠️ キー事前割当 skip:', e.message);
    }

    console.log(`🎙️ TTS自動生成: ${allTasks.length}チャンク / ${slidesNeedingTts.size}スライド (並列度${TTS_CONCURRENCY})`);
    const ttsT0 = Date.now();
    let ttsDone = 0;
    // chunk 単位の global プール → スライド境界跨いで並列
    const results = new Array(allTasks.length);
    const taskToIdx = new Map(allTasks.map((t, i) => [t, i]));

    // 2 パス戦略（2026-05-13）: 1パス目失敗 chunk を 30秒待機後に再試行
    //   - Gemini TTS の RPM/RPD 制限で失敗した chunk が回復後に成功する見込み
    //   - 失敗→即諦め (リトライ無し) で 1 chunk = 1 req に絞り、雪崩式クォータ消費を防ぐ
    //   - tts_gemini.js の hot swap と併用：429 受けたら次のキー → 後続 chunk が新キーで叩く
    const MAX_PASSES = parseInt(process.env.TTS_MAX_PASSES || '3', 10);
    const PASS_WAIT_MS = parseInt(process.env.TTS_PASS_WAIT_MS || '30000', 10);
    let pendingTasks = allTasks.slice();

    for (let pass = 0; pass < MAX_PASSES; pass++) {
      if (!pendingTasks.length) break;
      if (pass > 0) {
        console.log(`  ⏳ pass#${pass + 1}/${MAX_PASSES}: 残 ${pendingTasks.length} chunks → ${PASS_WAIT_MS/1000}s 待機後 再試行`);
        await new Promise(r => setTimeout(r, PASS_WAIT_MS));
      }
      const failedThisPass = [];
      await processInParallel(pendingTasks, TTS_CONCURRENCY, async (task) => {
        const resultIdx = taskToIdx.get(task);
        try {
          results[resultIdx] = await runSingleTtsTask(task);
          ttsDone++;
          updateJob(jobId, { ttsDone, ttsTotal: allTasks.length });
        } catch (e) {
          if (pass + 1 >= MAX_PASSES) {
            console.warn(`  ⚠️ slide#${task.slideIdx+1}/c${task.chunkIdx+1} TTS最終失敗 (pass${pass+1}/${MAX_PASSES}): ${e.message.slice(0, 120)}`);
            results[resultIdx] = null;
            ttsDone++;
            updateJob(jobId, { ttsDone, ttsTotal: allTasks.length });
          } else {
            failedThisPass.push(task);
          }
        }
      });
      if (!failedThisPass.length) break;
      pendingTasks = failedThisPass;
    }
    // スライド毎に audio[] を chunkIdx 順で集約
    const bySlide = new Map();
    for (const r of results) {
      if (!r) continue;
      if (!bySlide.has(r.slideIdx)) bySlide.set(r.slideIdx, []);
      bySlide.get(r.slideIdx).push(r);
    }
    for (const [slideIdx, audioList] of bySlide.entries()) {
      audioList.sort((a, b) => a.chunkIdx - b.chunkIdx);
      const m = modules[slideIdx];
      if (m) {
        m.audio = audioList;
        const ttsCfg = m.tts || {};
        m.tts = Object.assign({ generatedAt: new Date().toISOString() }, ttsCfg, { autoGenerated: true });
        console.log(`  ✅ slide#${slideIdx+1} TTS生成 (${audioList.length} chunk)`);
      }
    }
    fs.writeFileSync(mp, JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
    console.log(`🎙️ TTS完了: ${((Date.now() - ttsT0) / 1000).toFixed(1)}秒`);
  } else {
    console.log('🎙️ TTS生成済 or ナレーション無し → スキップ');
  }

  // ── 🆕 ASR フェーズ（2026-05-14）──
  //   生成された音声ファイルを Gemini multimodal に投げて word-level timestamps を取得
  //   audio[i].words[] に格納 → 字幕・catchphrase の完全同期に使用
  //   失敗しても致命ではない（words 無し時は従来の文字数比配分にフォールバック）
  if (process.env.ASR_ENABLED !== '0') {
    try {
      const asr = require('./gemini_asr');
      const asrTasks = [];
      modules.forEach((m, mi) => {
        (m.audio || []).forEach((a, ai) => {
          if (a.words?.length) return; // 既に取得済はスキップ
          if (!a.file) return;
          asrTasks.push({ m, mi, a, ai });
        });
      });
      if (asrTasks.length) {
        console.log(`🎤 ASR フェーズ: ${asrTasks.length} chunk の word timestamps 取得 (並列度3)`);
        updateJob(jobId, { status: 'asr-processing' });
        const asrT0 = Date.now();
        let asrDone = 0, asrFail = 0;
        await processInParallel(asrTasks, 3, async (task) => {
          try {
            const audioPath = path.join(BASE_DIR, task.a.file);
            const words = await asr.transcribeWithTimestamps(audioPath);
            task.a.words = words;
            asrDone++;
          } catch (e) {
            asrFail++;
            console.warn(`  ⚠️ ASR slide#${task.mi+1}/c${task.ai+1} 失敗: ${e.message.slice(0, 120)}`);
          }
        });
        fs.writeFileSync(mp, JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
        console.log(`🎤 ASR完了: ${((Date.now() - asrT0) / 1000).toFixed(1)}秒 (成功${asrDone}/失敗${asrFail})`);
      }
    } catch (e) {
      console.warn(`  ⚠️ ASR フェーズ全体エラー (非致命): ${e.message}`);
    }
  }

  updateJob(jobId, { status: 'rendering' });

  // ── Render フェーズ（並列）──
  //   worker 毎に独立した browser インスタンス。
  //   1 browser 共有方式は Chrome 内部スケジューラの偏りで、特定 worker のみ
  //   CPU 優遇を受け、他 worker が CDP timeout で死亡する事象が頻発した。
  //   独立 browser なら CDP キュー競合がそもそも発生しない。
  //   メモリ: 1 browser ~500MB × N で VPS 11GB なら余裕
  console.log(`🎬 Render: ${modules.length} スライド (並列度${RENDER_CONCURRENCY} / 独立browser)`);
  const renderT0 = Date.now();
  const workerCtxs = await Promise.all(Array.from({ length: RENDER_CONCURRENCY }, async () => {
    const browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 240_000,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',  // /dev/shm 不足対策（VPS Docker 想定）
        `--window-size=${W},${H}`,
      ],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H });
    return { browser, page };
  }));
  const pages = workerCtxs.map(c => c.page);

  // 各スライドの video-only / audio-only を別々に保持（xfade/acrossfade で繋ぐため）
  //   2026-05-07: 0.6s → 1.5s に拡張。TOC→本編遷移が急すぎる相棒指摘を受けて。
  //   xfade=fadeblack の duration が 1.5s = 「フェードアウト→黒→フェードイン」で
  //   視覚的に明確な「間」が生まれる。TAIL_PAD/LEAD_PAD が1.5sずつあるため、
  //   この overlap region は両スライドの silence pad に収まり、コンテンツは欠けない。
  const TRANSITION_SEC = 1.5;
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
    // 全 worker browser を閉じる
    await Promise.all(workerCtxs.map(c => c.browser.close().catch(() => {})));
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
      vParts.push(`${prevV}[${i}:v]xfade=transition=fadeblack:duration=${T}:offset=${offset}${out}`);
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
                `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -maxrate 12M -bufsize 24M -r ${FPS} ` +
                `-c:a aac -b:a 128k -movflags +faststart "${concatMp4}"`;
    execSync(cmd, { stdio: 'pipe' });
  }

  // BGM を 18% で重ねる（ナレーションを邪魔しない）
  //   opening + toc 区間は zinga.mp3 固定で連続再生、TOC 終端で他3曲ランダムに切替
  updateJob(jobId, { status: 'mixing-audio' });
  console.log('🎵 BGM ミックス中...');
  const totalSec = (totalMs / 1000).toFixed(3);

  const ZINGA_PATH = path.join(BGM_DIR, 'zinga.mp3');
  const REST_CANDIDATES = [
    'eve of battle.mp3',
    'strategy meeting.mp3',
    'Walking in downtown.mp3',
    'dribbler.mp3',
    'tikitaka.mp3',
    'No. 6.mp3',
  ]
    .map(f => path.join(BGM_DIR, f))
    .filter(p => fs.existsSync(p));

  // op+toc の合計尺を算出（クロスフェード分を差し引く）
  //   compact index で最後の op/toc の累積終了時刻を取る
  const opIdx  = modules.findIndex(m => m && m.type === 'opening');
  const tocIdx = modules.findIndex(m => m && m.type === 'toc');
  const lastHeaderOrigIdx    = Math.max(opIdx, tocIdx);
  const lastHeaderCompactIdx = lastHeaderOrigIdx >= 0 ? successIdxs.indexOf(lastHeaderOrigIdx) : -1;
  let switchSec = 0;
  if (lastHeaderCompactIdx >= 0) {
    const sumMs = compactDursMs.slice(0, lastHeaderCompactIdx + 1).reduce((a, b) => a + b, 0);
    switchSec = sumMs / 1000 - TRANSITION_SEC * lastHeaderCompactIdx;
  }

  const canDualBgm = fs.existsSync(ZINGA_PATH) && REST_CANDIDATES.length > 0
    && switchSec > 0 && switchSec < (totalMs / 1000);

  if (canDualBgm) {
    const restPath = REST_CANDIDATES[Math.floor(Math.random() * REST_CANDIDATES.length)];
    const switchSecStr = switchSec.toFixed(3);
    const restSecStr   = (totalMs / 1000 - switchSec).toFixed(3);
    console.log(`🎵 BGM 2セクション: zinga (0〜${switchSecStr}s, op+toc) → ${path.basename(restPath)} (〜${totalSec}s)`);
    const cmd = `"${FFMPEG}" -y -i "${concatMp4}" -stream_loop -1 -i "${ZINGA_PATH}" -stream_loop -1 -i "${restPath}" ` +
                `-filter_complex "[1:a]atrim=0:${switchSecStr},asetpts=PTS-STARTPTS,volume=0.18[bgm_a];` +
                `[2:a]atrim=0:${restSecStr},asetpts=PTS-STARTPTS,volume=0.18[bgm_b];` +
                `[bgm_a][bgm_b]concat=n=2:v=0:a=1[bgm];` +
                `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
                `-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "${outVideo}"`;
    execSync(cmd, { stdio: 'pipe' });
  } else {
    // フォールバック: 旧来の単一ランダム BGM
    const bgmPath = pickBgm();
    if (bgmPath) {
      console.log(`🎵 BGM 単一: ${path.basename(bgmPath)} (op/toc 検出失敗 or 候補不足)`);
      const cmd = `"${FFMPEG}" -y -i "${concatMp4}" -stream_loop -1 -i "${bgmPath}" ` +
                  `-filter_complex "[1:a]volume=0.18,atrim=0:${totalSec}[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
                  `-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k -shortest "${outVideo}"`;
      execSync(cmd, { stdio: 'pipe' });
    } else {
      console.warn('⚠️ BGM ファイルが無いのでミックススキップ');
      fs.copyFileSync(concatMp4, outVideo);
    }
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
