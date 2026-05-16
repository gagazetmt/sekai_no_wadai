// _test_step2_whisper_only.js
// 1本撮りパイプライン Step2 単独検証: Whisper ASR でタイムスタンプ抽出
//
// 目的:
//   - step1 で生成した combined.mp3 を Whisper API に投げる
//   - words[] (text, start, end) を取得
//   - 統計と最初/最後の word をログ表示
//   - 固有名詞（ハーツ / セルティック / 前田大然 / エディンバラ等）の検出率も確認
//
// 使い方:
//   node _test_step2_whisper_only.js                  # 既定: _test_step1_out/ の最新 combined_*.mp3
//   node _test_step2_whisper_only.js <path/to/x.mp3>  # 任意の mp3 を指定
//
// 出力:
//   _test_step2_out/words_<stamp>.json   - words[] 全件
//   _test_step2_out/summary_<stamp>.json - 統計
//
// 料金: $0.006 / min (Whisper-1)。1828字 = 約 5 分音声 → 約 ¥5

require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const openaiAsr = require('./scripts/v2_video/openai_asr');

const STEP1_OUT = path.join(__dirname, '_test_step1_out');
const OUT_DIR   = path.join(__dirname, '_test_step2_out');

// 固有名詞・キーフレーズ（Hearts narration 由来、ASR 精度確認用）
const KEY_PHRASES = [
  'ハーツ', 'セルティック', '前田大然', 'エディンバラ', 'グラスゴー',
  'スコットランド', 'プレミアシップ', '優勝', '最終節',
];

function pickLatestCombined() {
  if (!fs.existsSync(STEP1_OUT)) {
    throw new Error(`step1 output dir not found: ${STEP1_OUT}`);
  }
  const cands = fs.readdirSync(STEP1_OUT)
    .filter(n => /^combined_\d+\.mp3$/.test(n))
    .map(n => ({ name: n, mtime: fs.statSync(path.join(STEP1_OUT, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!cands.length) throw new Error(`no combined_*.mp3 in ${STEP1_OUT}`);
  return path.join(STEP1_OUT, cands[0].name);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mp3Path = process.argv[2]
    ? path.resolve(process.argv[2])
    : pickLatestCombined();
  if (!fs.existsSync(mp3Path)) throw new Error(`mp3 not found: ${mp3Path}`);
  const sizeKb = (fs.statSync(mp3Path).size / 1024).toFixed(1);
  console.log(`🎙️ Whisper ASR target: ${path.basename(mp3Path)} (${sizeKb} KB)`);

  // 1. ASR
  const t0 = Date.now();
  const words = await openaiAsr.transcribeWithTimestamps(mp3Path);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (!words.length) throw new Error('Whisper returned 0 words');

  // 2. 統計
  const totalText = words.map(w => w.text).join('');
  const totalChars = totalText.length;
  const firstWord = words[0];
  const lastWord  = words[words.length - 1];
  const totalDur  = lastWord.end - firstWord.start;
  const cps = totalChars / totalDur;

  // 3. 句間ギャップ統計 (境界 snap で使う情報)
  const gaps = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > 0) gaps.push({ idx: i, gap, after: words[i - 1].text, before: words[i].text });
  }
  gaps.sort((a, b) => b.gap - a.gap);
  const top5Gaps = gaps.slice(0, 5);

  console.log(`\n✅ Whisper 完了 ${elapsed}s`);
  console.log(`   words: ${words.length} 件 / chars: ${totalChars}`);
  console.log(`   span: ${firstWord.start.toFixed(2)}s 〜 ${lastWord.end.toFixed(2)}s (${totalDur.toFixed(1)}s)`);
  console.log(`   cps: ${cps.toFixed(2)}`);
  console.log(`\n   first word: ${JSON.stringify(firstWord)}`);
  console.log(`   last  word: ${JSON.stringify(lastWord)}`);
  console.log(`\n   top5 gaps (境界候補):`);
  top5Gaps.forEach((g, i) => {
    console.log(`     #${i + 1} ${g.gap.toFixed(3)}s @ words[${g.idx}]: "${g.after}" → "${g.before}"`);
  });

  // 4. 固有名詞検出
  console.log(`\n   key phrases 検出:`);
  for (const phrase of KEY_PHRASES) {
    const hit = totalText.includes(phrase);
    console.log(`     ${hit ? '✓' : '✗'} ${phrase}`);
  }

  // 5. 出力
  const stamp = Date.now();
  const wordsPath = path.join(OUT_DIR, `words_${stamp}.json`);
  fs.writeFileSync(wordsPath, JSON.stringify(words, null, 2), 'utf8');

  const summary = {
    stamp,
    sourceMp3: mp3Path,
    sourceSizeKb: +sizeKb,
    elapsedSec: +elapsed,
    wordsCount: words.length,
    totalChars,
    spanSec: +totalDur.toFixed(2),
    cps: +cps.toFixed(2),
    firstWord,
    lastWord,
    top5Gaps,
    keyPhraseHits: Object.fromEntries(KEY_PHRASES.map(p => [p, totalText.includes(p)])),
    wordsJsonPath: wordsPath,
  };
  const summaryPath = path.join(OUT_DIR, `summary_${stamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n📝 words: ${wordsPath}`);
  console.log(`📝 summary: ${summaryPath}`);
}

main().catch(e => {
  console.error('✗ 失敗:', e.message);
  console.error(e.stack);
  process.exit(1);
});
