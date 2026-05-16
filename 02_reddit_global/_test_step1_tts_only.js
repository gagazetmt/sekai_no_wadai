// _test_step1_tts_only.js
// 1本撮りパイプライン Step1 単独検証: TTS 一本撮りのみ（ASR / slice なし）
//
// 目的:
//   - 長文 narration を _splitLongTextForTTS で 1500字 limit 分割
//   - 各 part を generateGeminiTTS で生成
//   - ffmpeg concat で combined.mp3 にまとめる
//   - finishReason / 各 part の生成時間 / 最終 duration をログ
//
// 使い方:
//   node _test_step1_tts_only.js                          # 既定: _test_hearts_narration.txt (Hearts 案件本物)
//   node _test_step1_tts_only.js <path/to/narration.txt>  # 任意の narration ファイル指定
//
// 出力:
//   _test_step1_out/combined_<stamp>.mp3
//   _test_step1_out/sub_<i>_<stamp>.mp3 (各 part)
//   _test_step1_out/summary_<stamp>.json
//
// このスクリプトは ASR を一切叩かない。step2 (ASR) は別スクリプトで検証する。

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { generateGeminiTTS } = require('./scripts/v2_video/tts_gemini');
const splitter = require('./scripts/v2_video/audio_splitter');

const OUT_DIR = path.join(__dirname, '_test_step1_out');
// 2026-05-16: 分割せず 1 リクエストでぶち抜く（3.1 Flash の上限検証用）
//   2.5 Pro は ~1700字で finishReason: OTHER 事故あり → 3.1 Flash で 1800字突破できるか試す
const TTS_CHUNK_CHAR_LIMIT = parseInt(process.env.TTS_CHUNK_CHAR_LIMIT || '99999', 10);
const TTS_TIMEOUT_MS = parseInt(process.env.TTS_COMBINED_TIMEOUT_MS || '600000', 10);
const VOICE  = process.env.GEMINI_TTS_VOICE || 'Zubenelgenubi';
const MODEL  = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
// 2026-05-16: テンポ指示は prompt から外す。 raw 速度を安定させ atempo で後付け加速する方針
//   旧: '重低音のしゃがれ声で、超早くテンポ良く読んで。感情をこめて。'  ← 「超早くテンポ良く」が seed ブレを誘発
//   env TTS_STYLE_INSTRUCTIONS で上書き可能（明示空文字なら instructions なし、未設定ならこの既定値）
const STYLE_INSTRUCTIONS = process.env.TTS_STYLE_INSTRUCTIONS != null
  ? process.env.TTS_STYLE_INSTRUCTIONS
  : '重低音のしゃがれ声で、感情をこめて読んで。';

// 既定の narration ファイル: 2026-05-16 INTEGRATED モード失敗時の Hearts 案件
//   post: r/soccer 1tccohj "Hearts need to not lose at Glasgow against Celtic"
//   modules 9 / 合計 ~1800字 / 1500字 limit で 2 parts に割れる前提
//   VPS の modules.json から narration 部分のみ抽出 (2026-05-16)
const DEFAULT_NARRATION_FILE = path.join(__dirname, '_test_hearts_narration.txt');

function loadNarration(arg) {
  const p = path.resolve(arg || DEFAULT_NARRATION_FILE);
  if (!fs.existsSync(p)) throw new Error(`narration file not found: ${p}`);
  return fs.readFileSync(p, 'utf8').trim();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const narration = loadNarration(process.argv[2]);
  const stamp = Date.now();

  console.log(`📝 narration: ${narration.length} 字`);
  console.log(`🔧 model=${MODEL} voice=${VOICE} chunk_limit=${TTS_CHUNK_CHAR_LIMIT}`);
  console.log(`🎭 style: "${STYLE_INSTRUCTIONS}"`);

  // 1. 分割
  const subTexts = narration.length > TTS_CHUNK_CHAR_LIMIT
    ? splitter._splitLongTextForTTS(narration, TTS_CHUNK_CHAR_LIMIT)
    : [narration];

  if (subTexts.length === 1) {
    console.log(`✂️ 分割なし（${narration.length} 字 ≤ ${TTS_CHUNK_CHAR_LIMIT}）`);
  } else {
    console.log(`✂️ ${subTexts.length} parts: ${subTexts.map(s => s.length + '字').join(' / ')}`);
    subTexts.forEach((s, i) => {
      console.log(`  part${i}: "${s.slice(0, 40).replace(/\n/g, '\\n')}…"`);
    });
  }

  // 2. 各 part を TTS
  const subMp3s = [];
  const partLogs = [];
  for (let i = 0; i < subTexts.length; i++) {
    const subPath = path.join(OUT_DIR, `sub_${i}_${stamp}.mp3`);
    const t0 = Date.now();
    try {
      // TTS_GEMINI_SPEED=1.0 で速度フィルタ無効 (atempo は test 範囲外)
      const oldSpeed = process.env.TTS_GEMINI_SPEED;
      process.env.TTS_GEMINI_SPEED = '1.0';
      try {
        await generateGeminiTTS({
          text: subTexts[i],
          voiceId: VOICE,
          model: MODEL,
          styleInstructions: STYLE_INSTRUCTIONS,
          outputPath: subPath,
          timeoutMs: TTS_TIMEOUT_MS,
        });
      } finally {
        if (oldSpeed != null) process.env.TTS_GEMINI_SPEED = oldSpeed;
        else delete process.env.TTS_GEMINI_SPEED;
      }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const dur = splitter._probeDurationSec(subPath);
      const sizeKb = (fs.statSync(subPath).size / 1024).toFixed(1);
      console.log(`  ✓ part${i}: ${elapsed}s 生成 / ${dur.toFixed(1)}s 音声 / ${sizeKb}KB`);
      subMp3s.push(subPath);
      partLogs.push({ idx: i, chars: subTexts[i].length, elapsedSec: +elapsed, durationSec: dur, sizeKb: +sizeKb, status: 'ok' });
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`  ✗ part${i}: ${elapsed}s で失敗`);
      console.error(`    ${e.message}`);
      partLogs.push({ idx: i, chars: subTexts[i].length, elapsedSec: +elapsed, status: 'failed', error: e.message });
      // 1 part でも失敗したら以降スキップ（quota or finishReason 切り分けのため）
      const summary = {
        stamp,
        narrationChars: narration.length,
        chunkLimit: TTS_CHUNK_CHAR_LIMIT,
        subParts: subTexts.map((s, j) => ({ idx: j, chars: s.length, preview: s.slice(0, 60) })),
        partLogs,
        status: 'failed_at_part_' + i,
      };
      const summaryPath = path.join(OUT_DIR, `summary_${stamp}.json`);
      fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
      console.error(`📝 summary: ${summaryPath}`);
      process.exit(1);
    }
  }

  // 3. concat (parts >= 2 のときのみ)
  let combinedPath;
  if (subMp3s.length === 1) {
    combinedPath = path.join(OUT_DIR, `combined_${stamp}.mp3`);
    fs.copyFileSync(subMp3s[0], combinedPath);
    console.log(`📎 concat skip (1 part)`);
  } else {
    combinedPath = path.join(OUT_DIR, `combined_${stamp}.mp3`);
    const t0 = Date.now();
    await splitter._ffmpegConcatMp3s(subMp3s, combinedPath);
    console.log(`📎 concat ${subMp3s.length} parts in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const totalDur = splitter._probeDurationSec(combinedPath);
  const totalKb  = (fs.statSync(combinedPath).size / 1024).toFixed(1);
  console.log(`\n✅ 完成: ${combinedPath}`);
  console.log(`   ${totalDur.toFixed(1)}s / ${totalKb}KB / ${narration.length}字 → ${(narration.length / totalDur).toFixed(1)} cps`);

  const summary = {
    stamp,
    narrationChars: narration.length,
    chunkLimit: TTS_CHUNK_CHAR_LIMIT,
    voice: VOICE,
    model: MODEL,
    subParts: subTexts.map((s, j) => ({ idx: j, chars: s.length, preview: s.slice(0, 60) })),
    partLogs,
    combinedPath,
    totalDurationSec: totalDur,
    totalSizeKb: +totalKb,
    cps: +(narration.length / totalDur).toFixed(2),
    status: 'ok',
  };
  const summaryPath = path.join(OUT_DIR, `summary_${stamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`📝 summary: ${summaryPath}`);
}

main().catch(e => {
  console.error('✗ 想定外エラー:', e.message);
  console.error(e.stack);
  process.exit(1);
});
