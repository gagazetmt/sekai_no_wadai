// scripts/v2_video/_generate_sample_audio.js
// サンプルスライド用の TTS をワンショット生成して保存。
// 出力: images_stock/_sample_audio/{type}_c{N}.mp3
//
// 使い方:
//   node scripts/v2_video/_generate_sample_audio.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs   = require('fs');
const path = require('path');
const tts  = require('./tts_minimax');
const { SAMPLES } = require('./_sample_modules');

const OUT_DIR = path.join(__dirname, '..', '..', 'images_stock', '_sample_audio');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  for (const [type, mod] of Object.entries(SAMPLES)) {
    const chunks = Array.isArray(mod.audio) ? mod.audio : [];
    if (!chunks.length) {
      console.log(`[${type}] チャンク無し → スキップ`);
      continue;
    }
    console.log(`\n[${type}] ${chunks.length}チャンク 生成開始...`);
    for (const c of chunks) {
      const fname = `${type}_c${String(c.chunkIdx).padStart(2, '0')}.mp3`;
      const out = path.join(OUT_DIR, fname);
      if (fs.existsSync(out)) {
        console.log(`  ⏩ ${fname} 既存 → スキップ`);
        continue;
      }
      try {
        await tts.generateMiniMaxTTS({
          text: c.text,
          outputPath: out,
          voiceId: tts.DEFAULT_VOICE,
          model:   tts.DEFAULT_MODEL,
        });
        const dur = tts.probeDurationSec(out);
        console.log(`  ✅ ${fname} (${dur.toFixed(2)}s) "${c.text.slice(0, 40)}..."`);
      } catch (e) {
        console.warn(`  ❌ ${fname} 失敗: ${e.message}`);
      }
    }
  }
  console.log(`\n完了: ${OUT_DIR}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
