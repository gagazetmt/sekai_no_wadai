// _test_step4_integrated_audio.js
// 1本撮りパイプライン Step4: audio_splitter 単独で INTEGRATED 相当の音声統合を実行
//
// 目的:
//   - Hearts 8 module の narration を本番 audio_splitter.generateAndSplit に通す
//   - 内部処理を一気通貫で確認:
//       a) Combined TTS (3.1 Flash, no-split or auto-split)
//       b) atempo + loudnorm
//       c) Whisper ASR で words[]
//       d) **末尾マッチ fuzzy** で境界決定 (今回新規実装)
//       e) 各 module の audioPath / startAbsSec / endAbsSec / words
//   - 境界の妥当性、 cps 揺らぎ、 ASR の精度をログ
//
// 使い方:
//   node --use-system-ca _test_step4_integrated_audio.js
//
// 出力:
//   _test_step4_out/combined_<stamp>.mp3   - 統合音声
//   _test_step4_out/m??_<type>.mp3         - 各 module の切出 (keepIndividual=true)
//   _test_step4_out/summary_<stamp>.json   - 境界 + 各 module の情報

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const audioSplitter = require('./scripts/v2_video/audio_splitter');

const OUT_DIR = path.join(__dirname, '_test_step4_out');
const MODULES_PATH = path.join(__dirname, '_test_hearts_modules.json');

const VOICE = process.env.GEMINI_TTS_VOICE || 'Zubenelgenubi';
const MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.1-flash-tts-preview';
const TARGET_CPS = parseFloat(process.env.TTS_TARGET_CPS || '6');

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(MODULES_PATH)) throw new Error(`modules.json not found: ${MODULES_PATH}`);

  const j = JSON.parse(fs.readFileSync(MODULES_PATH, 'utf8'));
  const stamp = Date.now();

  const parts = [];
  for (let i = 0; i < j.modules.length; i++) {
    const m = j.modules[i];
    const narration = (m.narration || '').trim();
    if (!narration) continue;
    parts.push({
      slideIdx: i,
      type: m.type,
      text: narration,
      outputPath: path.join(OUT_DIR, `m${String(i).padStart(2, '0')}_${m.type}.mp3`),
    });
  }

  const totalChars = parts.reduce((s, p) => s + p.text.length, 0);
  console.log(`📦 parts: ${parts.length} / 合計 ${totalChars} 字`);
  parts.forEach(p => console.log(`  m${p.slideIdx} (${p.type}): ${p.text.length}字`));
  console.log(`🔧 model=${MODEL} voice=${VOICE} target_cps=${TARGET_CPS}`);
  console.log(`⏱️ 想定: TTS ~2 分 + ASR ~16 秒\n`);

  const t0 = Date.now();
  const results = await audioSplitter.generateAndSplit(parts, {
    voiceId: VOICE,
    model: MODEL,
    keepIndividual: true,   // 個別 mp3 も切り出す (test 用、目視確認)
    keepCombined: true,     // combined.mp3 も保持
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n✅ generateAndSplit 完了 ${elapsed}s`);
  console.log(`   combined: ${results.combinedAudioPath || '(none)'}`);
  console.log(`   totalDur: ${(results.totalDurationSec || 0).toFixed(2)}s`);
  console.log(`   parts:    ${results.length}`);

  console.log(`\n📊 各 module の音声配分:`);
  let prevEnd = 0;
  for (const r of results) {
    const orig = parts.find(p => p.slideIdx === r.slideIdx);
    const cps = r.durationSec > 0 ? (orig.text.length / r.durationSec) : 0;
    console.log(`  m${r.slideIdx} (${orig.type.padEnd(10)}): ${r.startAbsSec?.toFixed(2)}s 〜 ${r.endAbsSec?.toFixed(2)}s (${r.durationSec.toFixed(2)}s, ${orig.text.length}字, ${cps.toFixed(1)} cps, words=${r.words?.length || 0})`);
    prevEnd = r.endAbsSec;
  }

  const summary = {
    stamp,
    modulesSource: MODULES_PATH,
    voice: VOICE,
    model: MODEL,
    targetCps: TARGET_CPS,
    elapsedSec: +elapsed,
    combinedAudioPath: results.combinedAudioPath,
    totalDurationSec: results.totalDurationSec,
    parts: results.map(r => {
      const orig = parts.find(p => p.slideIdx === r.slideIdx);
      return {
        slideIdx: r.slideIdx,
        type: orig.type,
        narrationLen: orig.text.length,
        startAbsSec: r.startAbsSec,
        endAbsSec: r.endAbsSec,
        durationSec: r.durationSec,
        cps: r.durationSec > 0 ? +(orig.text.length / r.durationSec).toFixed(2) : null,
        wordsCount: r.words?.length || 0,
        audioPath: r.audioPath,
      };
    }),
  };
  const summaryPath = path.join(OUT_DIR, `summary_${stamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n📝 summary: ${summaryPath}`);
}

main().catch(e => {
  console.error('✗ 失敗:', e.message);
  console.error(e.stack);
  process.exit(1);
});
