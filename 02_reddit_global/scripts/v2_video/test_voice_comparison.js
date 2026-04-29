// scripts/v2_video/test_voice_comparison.js
// MiniMax Japanese 音声 A/B 比較ツール（speech-2.8-hd 固定）
//   使い方: node -r dotenv/config scripts/v2_video/test_voice_comparison.js
//   出力: data/v2_videos/voice_test/ 配下
//   試聴: http://VPS:3004/v2_videos/voice_test/index.html

const path = require('path');
const fs   = require('fs');
const { generateMiniMaxTTS } = require('./tts_minimax');

// ── テストテキスト（数字・固有名詞・煽り文を網羅）──
const TEST_TEXT = `今シーズン、ハキミは絶好調。モロッコ代表のキャプテンとして、PSGの右サイドで圧倒的な存在感を放っている。27分にゴール、40分にもアシスト。これがアフリカのスーパースターの実力だ。`;

// ── 候補ボイス（Japanese 系統 + クローン）──
//   ③⑤⑧ は除外（2026-04-29 ユーザー判断）
//   番号は会話参照用に固定（飛び番でも維持）
const VOICES = [
  { id: 'moss_audio_6e0620ed-3af8-11f1-beb2-9257c801a481', label: '①【現行】クローン (master-voice)' },
  { id: 'Japanese_DominantMan',           label: '② DominantMan (覇王・命令的)' },
  { id: 'Japanese_LoyalKnight',           label: '④ LoyalKnight (忠誠の騎士)' },
  { id: 'Japanese_SportyStudent',         label: '⑥ SportyStudent (スポーツ学生)' },
  { id: 'Japanese_GenerousIzakayaOwner',  label: '⑦ IzakayaOwner (ベテラン店主)' },
  { id: 'Japanese_InnocentBoy',           label: '⑨ InnocentBoy (若い少年)' },
];

const EMOTIONS = [
  { key: null,        label: 'neutral' },
  { key: 'happy',     label: 'happy' },
  { key: 'surprised', label: 'surprised' },
];

const MODEL = 'speech-2.8-hd';
const SPEED = 1.05;

async function main() {
  const outDir = path.join(__dirname, '..', '..', 'data', 'v2_videos', 'voice_test');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // 既存ファイルクリア（前回 turbo/HD 比較分を削除して新試聴を見やすく）
  fs.readdirSync(outDir).forEach(f => {
    if (f.endsWith('.mp3') || f === 'index.html') {
      try { fs.unlinkSync(path.join(outDir, f)); } catch (_) {}
    }
  });

  const results = [];
  for (const v of VOICES) {
    for (const e of EMOTIONS) {
      const safeId = v.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
      const filename = `${safeId}__${e.label}.mp3`;
      const outPath  = path.join(outDir, filename);
      const startedAt = Date.now();
      try {
        await generateMiniMaxTTS({
          text: TEST_TEXT,
          outputPath: outPath,
          voiceId: v.id,
          emotion: e.key || undefined,
          speed: SPEED,
          model: MODEL,
        });
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        results.push({ voice: v.label, emotion: e.label, file: filename });
        console.log(`✅ ${v.label.padEnd(38)} / ${e.label.padEnd(10)} (${elapsed}秒)`);
      } catch (err) {
        console.warn(`❌ ${v.label} / ${e.label}: ${err.message}`);
      }
    }
  }

  // ── 試聴ページ生成（ボイスごとに happy 強調表示）──
  const html = `<!doctype html>
<html lang="ja"><meta charset="utf-8">
<title>🎙️ MiniMax Japanese ボイス比較 (2.8 HD)</title>
<style>
:root { --bg:#0f1117; --panel:#161b2e; --c:#ff4d4d; --text:#e0e0e0; --muted:#8a9aba; --border:#2a3050; --gold:#fcd34d; }
* { box-sizing: border-box; }
body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 20px; max-width: 1100px; margin: 0 auto; }
h1 { color: var(--c); margin-bottom: 4px; font-size: 22px; }
.sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
.test-text { background: var(--panel); padding: 14px 18px; border-radius: 8px; border-left: 4px solid var(--c); margin-bottom: 24px; line-height: 1.6; font-size: 14px; }
.voice-group { margin-bottom: 22px; }
.voice-group h2 { color: #7dc8ff; margin-bottom: 8px; font-size: 16px; padding: 8px 12px; background: var(--panel); border-radius: 6px 6px 0 0; border-left: 4px solid #7dc8ff; }
.row { background: var(--panel); padding: 8px 14px; margin-bottom: 3px; border-radius: 4px;
       display: grid; grid-template-columns: 130px 1fr; gap: 12px; align-items: center; border: 1px solid var(--border); }
.row.happy { border-color: var(--gold); background: #1d1a1a; }
.row.happy .label b { color: var(--gold); }
.row:hover { border-color: var(--c); }
.label { font-size: 11px; color: var(--muted); }
.label b { color: var(--text); display: block; font-size: 13px; }
audio { width: 100%; height: 32px; }
@media (max-width: 768px) {
  body { padding: 12px; }
  .row { grid-template-columns: 1fr; gap: 4px; }
}
</style>
<h1>🎙️ MiniMax Japanese ボイス比較</h1>
<div class="sub">モデル: <b style="color:var(--gold)">speech-2.8-hd</b> 固定 / 速度 ${SPEED} / クローンの 2.8HD/happy が現状ベスト → 他候補と比較</div>
<div class="test-text">${TEST_TEXT}</div>

${VOICES.map(v => `
<div class="voice-group">
  <h2>🎤 ${v.label}</h2>
  ${EMOTIONS.map(e => {
    const safeId = v.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
    const file = `${safeId}__${e.label}.mp3`;
    return `<div class="row${e.label === 'happy' ? ' happy' : ''}">
      <div class="label"><b>${e.label}</b></div>
      <audio controls preload="none" src="${file}"></audio>
    </div>`;
  }).join('')}
</div>`).join('')}

<p style="text-align:center; color:var(--muted); font-size:11px; margin-top:24px;">
生成 ${results.length} / ${VOICES.length * EMOTIONS.length} 件 (黄色枠 = happy)
</p>
</html>`;
  fs.writeFileSync(path.join(outDir, 'index.html'), html);

  console.log(`\n📋 試聴URL: http://37.60.224.54:3004/v2_videos/voice_test/index.html`);
  console.log(`   生成: ${results.length}件`);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
