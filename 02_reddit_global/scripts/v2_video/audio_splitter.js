// scripts/v2_video/audio_splitter.js
// 全 slide narration を 1 本取り → ASR words から文字数累積で境界決定 → 各 slide に切り出し
//
// 目的:
//   - Gemini TTS の生成揺らぎ（±35% の duration ブレ）を排除
//   - 全 slide で声色・速度・音量を完璧に統一
//   - クォータ消費を 9 → 1 に削減
//
// 旧方式（区切り音「一旦カット」検出）は 2026-05-15 廃止:
//   TTS が反復区切り文を頻繁に省略するため検出失敗 → fallback 連発でクォータ食い尽くし。
//
// 新方式:
//   1. 全 narration を素直に連結（区切り音なし）→ TTS 1 リクエスト
//   2. ASR で words[] (text + timestamps) 取得
//   3. 各 slide の原文文字数比率で ASR words を分配
//   4. 境界は word 間ギャップ最大位置に snap（自然な間で切る）
//   5. 各 slide 内では word timestamps を相対化（字幕同期維持）

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { generateGeminiTTS } = require('./tts_gemini');
const { transcribeWithTimestamps } = require('./gemini_asr');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const FFPROBE = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffprobe.exe' : 'ffprobe';

// 目標読み速度（字/秒）。env TTS_TARGET_CPS で上書き可能。 既定 10 = 600 字/分
const TARGET_CHARS_PER_SEC = parseFloat(process.env.TTS_TARGET_CPS || '10');
// 境界 snap マージン: candidate ± この秒数の範囲で最大ギャップを探して snap
const BOUNDARY_MARGIN_SEC = parseFloat(process.env.TTS_BOUNDARY_MARGIN || '1.5');
// 連結時の slide 間デリミタ（TTS に「次の話題」と認識させる軽い区切り、検出には使わない）
const JOIN_DELIM = '\n\n';

/**
 * 複数 slide の narration をまとめて生成し、 個別 mp3 に切り出す
 * @param {Array<{ slideIdx, text, outputPath }>} parts
 * @param {Object} opts - { voiceId, styleInstructions, model }
 * @returns {Promise<Array<{ slideIdx, audioPath, durationSec, words, text }>>}
 */
async function generateAndSplit(parts, opts = {}) {
  if (!parts.length) return [];

  // 1. 各 part の正規化文字数（読み長近似）
  const normalizedLens = parts.map(p => normalizeForCount(p.text || '').length);
  const totalNormChars = normalizedLens.reduce((a, b) => a + b, 0);
  if (totalNormChars === 0) return [];

  // 2. 全文結合（区切り音なし）
  const fullText = parts.map(p => String(p.text || '').trim()).filter(Boolean).join(JOIN_DELIM);

  const baseDir = path.dirname(parts[0].outputPath);
  fs.mkdirSync(baseDir, { recursive: true });

  // 3. raw TTS 生成 (atempo=1.0、 後段で動的調整)
  const stamp = Date.now();
  const rawMp3 = path.join(baseDir, `_combined_raw_${stamp}.mp3`);
  const oldSpeed = process.env.TTS_GEMINI_SPEED;
  process.env.TTS_GEMINI_SPEED = '1.0';
  try {
    await generateGeminiTTS({
      text: fullText,
      voiceId: opts.voiceId,
      model: opts.model,
      styleInstructions: opts.styleInstructions,
      outputPath: rawMp3,
      timeoutMs: 300000,  // 長文応答 5 分マージン
    });
  } finally {
    if (oldSpeed != null) process.env.TTS_GEMINI_SPEED = oldSpeed;
    else delete process.env.TTS_GEMINI_SPEED;
  }

  // 4. raw duration → 動的 atempo
  const rawDur = probeDurationSec(rawMp3);
  if (rawDur <= 0) throw new Error('raw audio duration zero');
  const idealDur = totalNormChars / TARGET_CHARS_PER_SEC;
  const atempo = Math.max(0.5, Math.min(2.0, rawDur / idealDur));
  console.log(`  🎵 combined: raw=${rawDur.toFixed(1)}s / chars=${totalNormChars} / target=${idealDur.toFixed(1)}s / atempo=${atempo.toFixed(3)}`);

  // 5. atempo + loudnorm 適用
  const finalMp3 = path.join(baseDir, `_combined_final_${stamp}.mp3`);
  await applyFilters(rawMp3, finalMp3, atempo);

  // 6. ASR（長文は分割マージ）
  const words = await transcribeChunked(finalMp3);
  if (!words.length) throw new Error('ASR returned no words');

  // 7. 境界決定：文字数比率配分 + 自然ギャップ snap
  const totalDur = probeDurationSec(finalMp3);
  const boundaries = computeBoundaries(words, normalizedLens, totalDur);
  console.log(`  🎯 境界(文字数比配分): ${boundaries.map(b => b.toFixed(1) + 's').join(' / ')}`);

  // 8. 各 slide 範囲を確定
  const ranges = parts.map((p, i) => {
    const start = i === 0 ? 0 : boundaries[i - 1];
    const end = i === parts.length - 1 ? totalDur : boundaries[i];
    return { slideIdx: p.slideIdx, start, end, outputPath: p.outputPath, text: p.text };
  });

  // 9. ffmpeg で切り出し + 各 slide 内 word timestamps を相対化
  const results = [];
  for (const r of ranges) {
    const durSec = r.end - r.start;
    if (durSec <= 0.2) {
      console.warn(`  ⚠️ slide#${r.slideIdx + 1} duration <= 0.2s, skip`);
      continue;
    }
    await ffmpegSlice(finalMp3, r.outputPath, r.start, durSec);
    const actualDur = probeDurationSec(r.outputPath);
    const slideWords = words
      .filter(w => w.start >= r.start && w.end <= r.end)
      .map(w => ({
        text: String(w.text || ''),
        start: Math.max(0, w.start - r.start),
        end: Math.max(0, w.end - r.start),
      }));
    results.push({
      slideIdx: r.slideIdx,
      audioPath: r.outputPath,
      durationSec: actualDur,
      words: slideWords,
      text: r.text,
    });
  }

  // 10. cleanup
  try { fs.unlinkSync(rawMp3); } catch (_) {}
  try { fs.unlinkSync(finalMp3); } catch (_) {}

  return results;
}

/**
 * 原文文字数 + ASR words[] から各 slide の境界 timestamp を決定
 *   累積文字数比率を ASR の累積文字数に当てはめ、対応 word の end を candidate に
 *   candidate ± BOUNDARY_MARGIN_SEC の範囲で最大ギャップ中央に snap（自然な切れ目）
 * @param {Array<{text, start, end}>} words ASR words（時刻順）
 * @param {Array<number>} normLens 各 slide の正規化文字数
 * @param {number} totalDur 全体 duration
 * @returns {Array<number>} 境界 timestamps（長さ = slides 数 - 1）
 */
function computeBoundaries(words, normLens, totalDur) {
  const n = normLens.length;
  if (n <= 1) return [];

  const wordNormLens = words.map(w => normalizeForCount(w.text || '').length);
  const totalAsrChars = wordNormLens.reduce((a, b) => a + b, 0);
  const totalNorm = normLens.reduce((a, b) => a + b, 0);

  // ASR テキスト無い → 時間比配分 fallback
  if (totalAsrChars === 0) {
    const boundaries = [];
    let cum = 0;
    for (let i = 0; i < n - 1; i++) {
      cum += normLens[i];
      boundaries.push(totalDur * cum / totalNorm);
    }
    return boundaries;
  }

  const boundaries = [];
  let wordIdx = 0;
  let accAsr = 0;
  let cumNorm = 0;

  for (let i = 0; i < n - 1; i++) {
    cumNorm += normLens[i];
    const targetAsrChars = totalAsrChars * (cumNorm / totalNorm);

    while (wordIdx < words.length && accAsr + wordNormLens[wordIdx] < targetAsrChars) {
      accAsr += wordNormLens[wordIdx];
      wordIdx++;
    }
    const candidateTime = (words[wordIdx] && words[wordIdx].end) || totalDur;

    const snappedTime = snapToNearestGap(words, candidateTime, BOUNDARY_MARGIN_SEC);
    boundaries.push(snappedTime);

    // wordIdx を snap 後の位置に合わせる（次 slide で同じ word を二重消化しない）
    while (wordIdx < words.length && words[wordIdx].end <= snappedTime) {
      accAsr += wordNormLens[wordIdx];
      wordIdx++;
    }
  }
  return boundaries;
}

/**
 * target ± margin の範囲で word 間ギャップが最大の位置に snap
 * 該当ギャップが無ければ target をそのまま返す
 */
function snapToNearestGap(words, target, margin) {
  let bestPos = target;
  let bestGap = -1;
  for (let i = 1; i < words.length; i++) {
    const gapStart = words[i - 1].end;
    const gapEnd = words[i].start;
    if (gapEnd <= gapStart) continue;
    const gapCenter = (gapStart + gapEnd) / 2;
    if (Math.abs(gapCenter - target) <= margin) {
      const gapSize = gapEnd - gapStart;
      if (gapSize > bestGap) {
        bestGap = gapSize;
        bestPos = gapCenter;
      }
    }
  }
  return bestPos;
}

/**
 * 文字数カウント用の正規化（原文と ASR を同じスケールで比較するため）
 *   - 空白・改行・タブ除去
 *   - 句読点・記号類除去（ASR が出力しない要素を原文から除く）
 *   - 絵文字除去
 *   ※数字・英字略語の読み展開ズレは BOUNDARY_MARGIN_SEC で吸収する前提
 */
function normalizeForCount(s) {
  if (!s) return '';
  let t = String(s).replace(/[\s　]/g, '');
  t = t.replace(/[、。「」『』（）()！!？?・…―\-—:：;；,\.]/g, '');
  t = t.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, '');
  return t;
}

// atempo + loudnorm 一括適用
function applyFilters(srcMp3, outMp3, atempo) {
  return new Promise((resolve, reject) => {
    const af = atempo === 1.0
      ? 'loudnorm=I=-16:TP=-1.5:LRA=11'
      : `loudnorm=I=-16:TP=-1.5:LRA=11,atempo=${atempo.toFixed(3)}`;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', srcMp3, '-af', af, '-codec:a', 'libmp3lame', '-b:a', '128k', outMp3];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(outMp3);
      else reject(new Error(`ffmpeg apply exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// 時間範囲切り出し
function ffmpegSlice(srcMp3, outMp3, startSec, durSec) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', srcMp3,
      '-ss', startSec.toFixed(3),
      '-t', durSec.toFixed(3),
      '-codec:a', 'libmp3lame', '-b:a', '128k',
      outMp3,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code === 0) resolve(outMp3);
      else reject(new Error(`ffmpeg slice exit ${code}: ${stderr.slice(-300)}`));
    });
  });
}

// 長文 audio を分割 → 並列 ASR → offset 加算でマージ
async function transcribeChunked(mp3Path, chunkSec = 75) {
  const totalDur = probeDurationSec(mp3Path);
  if (totalDur <= chunkSec * 1.2) {
    return await transcribeWithTimestamps(mp3Path);
  }
  const nChunks = Math.ceil(totalDur / chunkSec);
  console.log(`  🔪 ASR 分割: ${totalDur.toFixed(1)}s → ${nChunks} chunks (${chunkSec}s each, 並列実行)`);
  const baseDir = path.dirname(mp3Path);
  const stamp = Date.now();
  const tmpFiles = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * chunkSec;
    const dur = Math.min(chunkSec, totalDur - start);
    const tmpPath = path.join(baseDir, `_asr_chunk_${i}_${stamp}.mp3`);
    await ffmpegSlice(mp3Path, tmpPath, start, dur);
    tmpFiles.push({ path: tmpPath, offset: start });
  }
  const PAR = 2;
  const results = new Array(tmpFiles.length).fill([]);
  let nextIdx = 0;
  await Promise.all(Array.from({ length: PAR }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tmpFiles.length) return;
      const f = tmpFiles[idx];
      try {
        const w = await transcribeWithTimestamps(f.path);
        results[idx] = w.map(ww => ({
          text: ww.text,
          start: (Number(ww.start) || 0) + f.offset,
          end: (Number(ww.end) || 0) + f.offset,
        }));
      } catch (e) {
        console.warn(`  ⚠️ ASR chunk#${idx + 1}/${tmpFiles.length} 失敗 (offset=${f.offset}s): ${e.message.slice(0, 100)}`);
      }
    }
  }));
  for (const f of tmpFiles) {
    try { fs.unlinkSync(f.path); } catch (_) {}
  }
  const merged = results.flat().filter(w => w && typeof w.start === 'number').sort((a, b) => a.start - b.start);
  console.log(`  🔪 ASR 分割完了: ${merged.length} words 取得`);
  return merged;
}

function probeDurationSec(filePath) {
  try {
    const out = execSync(`${FFPROBE} -v error -show_entries format=duration -of csv=p=0 "${filePath}"`).toString().trim();
    return parseFloat(out) || 0;
  } catch (_) {
    return 0;
  }
}

module.exports = {
  generateAndSplit,
  // 内部関数は test 用に export
  _computeBoundaries: computeBoundaries,
  _normalizeForCount: normalizeForCount,
};
