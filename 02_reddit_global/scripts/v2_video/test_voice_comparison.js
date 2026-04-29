// scripts/v2_video/test_voice_comparison.js
// MiniMax 音声 A/B 比較ツール
//   使い方: node -r dotenv/config scripts/v2_video/test_voice_comparison.js
//   出力: data/v2_videos/voice_test/{voice}_{emotion}.mp3
//          + index.html (試聴ページ)
//   試聴: http://VPS:3004/v2_videos/voice_test/index.html

const path = require('path');
const fs   = require('fs');
const { generateMiniMaxTTS } = require('./tts_minimax');

// ── テストテキスト（数字・固有名詞・煽り文を網羅）──
const TEST_TEXT = `今シーズン、ハキミは絶好調。モロッコ代表のキャプテンとして、PSGの右サイドで圧倒的な存在感を放っている。27分にゴール、40分にもアシスト。これがアフリカのスーパースターの実力だ。`;

// ── 候補ボイス ──
const VOICES = [
  { id: 'moss_audio_6e0620ed-3af8-11f1-beb2-9257c801a481', label: 'クローン (現行マスター)' },
  { id: 'presenter_male',   label: '男性プレゼンター' },
  { id: 'audiobook_male_1', label: '男性オーディオブック' },
  { id: 'male-qn-jingying', label: '男性・精英(エリート)' },
  { id: 'male-qn-badao',    label: '男性・霸道(覇王)' },
];

// ── テスト感情 ──
const EMOTIONS = [
  { key: null,        label: 'neutral' },
  { key: 'happy',     label: 'happy' },
  { key: 'surprised', label: 'surprised' },
];

const SPEED = 1.05;  // 1.0=通常 / 1.05=やや早口

// ── テストモデル（HD で日本語自然さを比較）──
const MODELS = [
  { id: 'speech-02-turbo', label: 'turbo (旧)' },
  { id: 'speech-02-hd',    label: 'HD' },
  { id: 'speech-2.8-hd',   label: '2.8 HD (最新)' },
];

async function main() {
  const outDir = path.join(__dirname, '..', '..', 'data', 'v2_videos', 'voice_test');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const v of VOICES) {
    for (const m of MODELS) {
      for (const e of EMOTIONS) {
        const safeId = v.id.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
        const safeModel = m.id.replace(/[^a-z0-9-]/gi, '_');
        const filename = `${safeId}__${safeModel}__${e.label}.mp3`;
        const outPath  = path.join(outDir, filename);
        const startedAt = Date.now();
        try {
          await generateMiniMaxTTS({
            text: TEST_TEXT,
            outputPath: outPath,
            voiceId: v.id,
            emotion: e.key || undefined,
            speed: SPEED,
            model: m.id,
          });
          const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
          results.push({ voice: v.label, model: m.label, modelId: m.id, emotion: e.label, file: filename });
          console.log(`✅ ${v.label.padEnd(22)} / ${m.label.padEnd(14)} / ${e.label.padEnd(10)} (${elapsed}秒)`);
        } catch (err) {
          console.warn(`❌ ${v.label} / ${m.label} / ${e.label}: ${err.message}`);
        }
      }
    }
  }

  // ── 試聴ページ生成（ボイス × モデル × 感情）──
  const html = `<!doctype html>
<html lang="ja"><meta charset="utf-8">
<title>🎙️ MiniMax ボイス比較</title>
<style>
:root { --bg:#0f1117; --panel:#161b2e; --c:#ff4d4d; --text:#e0e0e0; --muted:#8a9aba; --border:#2a3050; }
* { box-sizing: border-box; }
body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; max-width: 1200px; margin: 0 auto; }
h1 { color: var(--c); margin-bottom: 8px; font-size: 22px; }
.test-text { background: var(--panel); padding: 14px 18px; border-radius: 8px; border-left: 4px solid var(--c); margin-bottom: 20px; line-height: 1.6; font-size: 14px; }
.voice-group { margin-bottom: 28px; }
.voice-group h2 { color: #7dc8ff; margin-bottom: 10px; font-size: 16px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.model-group { margin: 8px 0 4px; padding-left: 8px; }
.model-group h3 { color: #fcd34d; font-size: 13px; margin-bottom: 4px; }
.row { background: var(--panel); padding: 8px 12px; margin-bottom: 4px; border-radius: 6px;
       display: grid; grid-template-columns: 130px 1fr; gap: 10px; align-items: center; border: 1px solid var(--border); }
.row:hover { border-color: var(--c); }
.label { font-size: 11px; color: var(--muted); }
.label b { color: var(--text); display: block; font-size: 12px; }
audio { width: 100%; height: 32px; }
@media (max-width: 768px) {
  body { padding: 12px; }
  .row { grid-template-columns: 1fr; gap: 4px; }
}
</style>
<h1>🎙️ MiniMax ボイス × モデル比較</h1>
<div class="test-text">${TEST_TEXT}</div>

${VOICES.map(v => `
<div class="voice-group">
  <h2>🎤 ${v.label}</h2>
  ${MODELS.map(m => {
    const safeModel = m.id.replace(/[^a-z0-9-]/gi, '_');
    return `
    <div class="model-group">
      <h3>${m.label} <span style="color:#5a6a8a;font-size:10px;">(${m.id})</span></h3>
      ${EMOTIONS.map(e => {
        const safeId = v.id.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
        const file = `${safeId}__${safeModel}__${e.label}.mp3`;
        return `<div class="row">
          <div class="label"><b>${e.label}</b></div>
          <audio controls preload="none" src="${file}"></audio>
        </div>`;
      }).join('')}
    </div>`;
  }).join('')}
</div>`).join('')}

<p style="text-align:center; color:var(--muted); font-size:11px; margin-top:24px;">
生成 ${results.length} 件 / 速度 ${SPEED}
</p>
</html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  console.log(`\n📋 試聴URL: http://37.60.224.54:3004/v2_videos/voice_test/index.html`);
  console.log(`   生成数: ${results.length}件 / 失敗: ${VOICES.length * EMOTIONS.length - results.length}件`);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
