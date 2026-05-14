// scripts/v2_video/audio_splitter.js
// 全 slide narration を 1 本取り → ASR で境界検出 → 各 slide に切り出すパイプ
//
// 目的:
//   - Gemini TTS の生成揺らぎ（±35% の duration ブレ）を排除
//   - 全 slide で声色・速度・音量を完璧に統一
//   - クォータ消費を 9 → 1 に削減
//
// フロー:
//   1. 全 narration を結合（slide 間に「ぴゅっ。」挿入）
//   2. Gemini TTS で 1 リクエスト生成
//   3. raw duration から動的 atempo 算出（目標字/秒を達成）
//   4. atempo + loudnorm で final mp3
//   5. ASR で words+timestamps 取得
//   6. 「ぴゅ」を含む segments を検出 → 各 slide 境界決定
//   7. ffmpeg で各 slide 範囲切り出し（区切り部分はカット）

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { generateGeminiTTS } = require('./tts_gemini');
const { transcribeWithTimestamps } = require('./gemini_asr');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const FFPROBE = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffprobe.exe' : 'ffprobe';

// 区切り音声: 「ぴゅっ」を 3 連発で約 1.5 秒の明確な音にする
//   長文 ASR (5分超) では短い擬音が segment 化されず黙殺される事象を確認したため強化
const SEPARATOR_TEXT = 'ぴゅっぴゅっぴゅっ。';
const SEPARATOR_DETECT = 'ぴゅ';  // ASR transcribe での部分一致キー
const SAFETY_MARGIN_SEC = 0.05;   // 境界の安全マージン
// 目標読み速度（字/秒）。env TTS_TARGET_CPS で上書き可能。既定 10 = 600 字/分（動画ナレ標準）
const TARGET_CHARS_PER_SEC = parseFloat(process.env.TTS_TARGET_CPS || '10');

/**
 * 複数 slide の narration をまとめて生成し、 個別 mp3 に切り出す
 * @param {Array<{ slideIdx, text, outputPath }>} parts
 * @param {Object} opts - { voiceId, styleInstructions, model }
 * @returns {Promise<Array<{ slideIdx, audioPath, durationSec, words, text }>>}
 */
async function generateAndSplit(parts, opts = {}) {
  if (!parts.length) return [];

  // 1. 全文結合
  const fullText = parts.map(p => String(p.text || '').trim()).filter(Boolean)
    .join('\n' + SEPARATOR_TEXT + '\n');
  if (!fullText) return [];

  // 出力ディレクトリは parts[0].outputPath を基準に
  const baseDir = path.dirname(parts[0].outputPath);
  fs.mkdirSync(baseDir, { recursive: true });

  // 2. raw TTS 生成（atempo=1.0、 一旦元速度）
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
    });
  } finally {
    if (oldSpeed != null) process.env.TTS_GEMINI_SPEED = oldSpeed;
    else delete process.env.TTS_GEMINI_SPEED;
  }

  // 3. raw duration → 動的 atempo 算出
  const rawDur = probeDurationSec(rawMp3);
  if (rawDur <= 0) throw new Error('raw audio duration zero');
  const totalChars = fullText.replace(/\s/g, '').length;
  const idealDur = totalChars / TARGET_CHARS_PER_SEC;
  const rawAtempo = rawDur / idealDur;
  // atempo は 0.5 〜 2.0 の範囲にクランプ
  const atempo = Math.max(0.5, Math.min(2.0, rawAtempo));
  console.log(`  🎵 combined: raw=${rawDur.toFixed(1)}s / chars=${totalChars} / target=${idealDur.toFixed(1)}s / atempo=${atempo.toFixed(3)}`);

  // 4. atempo + loudnorm 適用して final mp3
  const finalMp3 = path.join(baseDir, `_combined_final_${stamp}.mp3`);
  await applyFilters(rawMp3, finalMp3, atempo);

  // 5. ASR
  const words = await transcribeWithTimestamps(finalMp3);
  if (!words.length) throw new Error('ASR returned no words');

  // 6. 区切り「ぴゅ」を検出
  const sepHits = words.filter(w => (w.text || '').includes(SEPARATOR_DETECT));
  const expectedHits = parts.length - 1;
  console.log(`  🎯 separator hits: ${sepHits.length} / expected ${expectedHits}`);
  if (sepHits.length < expectedHits) {
    throw new Error(`separator detection failed: hits=${sepHits.length}, expected=${expectedHits}. ASR text head: ${words.slice(0, 5).map(w => w.text).join('|')}`);
  }
  // 余分な hits があれば先頭から expectedHits 個だけ採用（誤検出防止）
  const useHits = sepHits.slice(0, expectedHits);

  // 7. 境界 timestamps から各 slide 範囲を確定
  const totalDur = probeDurationSec(finalMp3);
  const ranges = parts.map((p, i) => {
    const start = i === 0 ? 0 : Math.max(0, useHits[i - 1].end + SAFETY_MARGIN_SEC);
    const end = i === parts.length - 1
      ? totalDur
      : Math.min(totalDur, useHits[i].start - SAFETY_MARGIN_SEC);
    return { slideIdx: p.slideIdx, start, end, outputPath: p.outputPath, text: p.text };
  });

  // 8. ffmpeg で各 slide を切り出し + 各 slide 内 word timestamps を計算
  const results = [];
  for (const r of ranges) {
    const durSec = r.end - r.start;
    if (durSec <= 0.2) {
      console.warn(`  ⚠️ slide#${r.slideIdx + 1} duration <= 0.2s, skip`);
      continue;
    }
    await ffmpegSlice(finalMp3, r.outputPath, r.start, durSec);
    const actualDur = probeDurationSec(r.outputPath);
    // 各 slide 内の words を相対時間に変換
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

  // 9. cleanup（中間ファイル削除）
  try { fs.unlinkSync(rawMp3); } catch (_) {}
  try { fs.unlinkSync(finalMp3); } catch (_) {}

  return results;
}

// atempo + loudnorm を一括適用
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
  SEPARATOR_TEXT,
  SEPARATOR_DETECT,
};
