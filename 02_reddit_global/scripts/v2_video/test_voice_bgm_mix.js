// scripts/v2_video/test_voice_bgm_mix.js
// 音声 × BGM ミックステスト（実コンテキストでの聞き比べ）
//   使い方: node -r dotenv/config scripts/v2_video/test_voice_bgm_mix.js [phase]
//     phase: 1 (default) = 6声 × eve of battle / 2 = 選定済み声 × 全BGM

const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');
const { generateMiniMaxTTS } = require('./tts_minimax');

const FFMPEG = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';
const BASE_DIR = path.join(__dirname, '..', '..');
const OUT_DIR  = path.join(BASE_DIR, 'data', 'v2_videos', 'voice_test');
const BGM_DIR  = path.join(BASE_DIR, 'bgm');

// 30秒前後のサッカー動画ナレ（複数文・盛り上がり込み）
const NARRATION = `今シーズン、ハキミは絶好調だ。モロッコ代表のキャプテンとして、PSGでは右サイドの絶対的存在になっている。27分にゴール、40分にもアシスト。1試合で2得点関与の活躍を見せた。これがアフリカの星、ハキミの実力。今後のチャンピオンズリーグでも目が離せない。`;

const VOICES = [
  { id: 'moss_audio_6e0620ed-3af8-11f1-beb2-9257c801a481', label: '①クローン' },
  { id: 'Japanese_DominantMan',          label: '②DominantMan' },
  { id: 'Japanese_LoyalKnight',          label: '④LoyalKnight' },
  { id: 'Japanese_SportyStudent',        label: '⑥SportyStudent' },
  { id: 'Japanese_GenerousIzakayaOwner', label: '⑦IzakayaOwner' },
  { id: 'Japanese_InnocentBoy',          label: '⑨InnocentBoy' },
];

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-200)}`)));
  });
}

async function mixVoiceBgm(narrPath, bgmPath, outPath) {
  // BGM 18% で重ねる（render.js と同じ設定）
  await runFfmpeg([
    '-y', '-i', narrPath, '-stream_loop', '-1', '-i', bgmPath,
    '-filter_complex',
    `[1:a]volume=0.18[bgm];[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0[a]`,
    '-map', '[a]', '-c:a', 'libmp3lame', '-q:a', '2', '-shortest', outPath,
  ]);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // BGM 一覧
  const bgmFiles = fs.readdirSync(BGM_DIR)
    .filter(f => f.endsWith('.mp3'))
    .map(f => ({ name: f, path: path.join(BGM_DIR, f) }));
  console.log(`BGM 候補: ${bgmFiles.length}曲`);
  bgmFiles.forEach(b => console.log(`  - ${b.name}`));

  const phase = process.argv[2] || '1';
  const results = [];

  if (phase === '1') {
    // Phase1: 6声 × eve of battle 固定
    const bgm = bgmFiles.find(b => /eve.*battle/i.test(b.name));
    if (!bgm) { console.error('eve of battle.mp3 が見つからない'); process.exit(1); }
    console.log(`\nPhase1: 6声 × ${bgm.name} 固定で比較\n`);

    for (const v of VOICES) {
      const narrFile = path.join(OUT_DIR, `mix_${v.label.replace(/[①-⑨]/g, '').replace(/[^a-zA-Z0-9]/g, '_')}_narr.mp3`);
      const outFile  = path.join(OUT_DIR, `mix_${v.label.replace(/[①-⑨]/g, '').replace(/[^a-zA-Z0-9]/g, '_')}_with_bgm.mp3`);
      const t0 = Date.now();
      try {
        await generateMiniMaxTTS({
          text: NARRATION, outputPath: narrFile,
          voiceId: v.id, model: 'speech-2.8-hd',
          emotion: 'happy', speed: 1.05,
        });
        await mixVoiceBgm(narrFile, bgm.path, outFile);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        results.push({ label: v.label, narrFile: path.basename(narrFile), mixFile: path.basename(outFile) });
        console.log(`✅ ${v.label.padEnd(20)} (${elapsed}秒)`);
      } catch (e) {
        console.warn(`❌ ${v.label}: ${e.message}`);
      }
    }
  } else if (phase === '2') {
    // Phase2: 選定済み声 × 全BGM  (引数で voiceId 指定)
    const voiceArg = process.argv[3];
    const v = VOICES.find(x => x.id === voiceArg) || VOICES[0];
    console.log(`\nPhase2: ${v.label} × 全BGM ${bgmFiles.length}曲で比較\n`);

    const narrFile = path.join(OUT_DIR, `phase2_narr.mp3`);
    await generateMiniMaxTTS({
      text: NARRATION, outputPath: narrFile,
      voiceId: v.id, model: 'speech-2.8-hd',
      emotion: 'happy', speed: 1.05,
    });
    console.log('ナレ生成完了');

    for (const bgm of bgmFiles) {
      const safeBgm = bgm.name.replace(/\.mp3$/, '').replace(/[^a-zA-Z0-9]/g, '_');
      const outFile = path.join(OUT_DIR, `phase2_${safeBgm}.mp3`);
      try {
        await mixVoiceBgm(narrFile, bgm.path, outFile);
        results.push({ label: bgm.name, mixFile: path.basename(outFile) });
        console.log(`✅ ${bgm.name}`);
      } catch (e) {
        console.warn(`❌ ${bgm.name}: ${e.message}`);
      }
    }
  }

  // HTML 生成
  const title = phase === '1' ? '音声 × BGM (eve of battle 固定)' : `Phase2: ${process.argv[3] || 'voice'} × 全BGM`;
  const html = `<!doctype html><meta charset=utf-8><title>${title}</title>
<style>body{font-family:sans-serif;background:#0f1117;color:#e0e0e0;padding:24px;max-width:900px;margin:auto}
h1{color:#ff4d4d}.row{background:#161b2e;padding:14px 18px;margin:10px 0;border-radius:8px;border:1px solid #2a3050}
.row b{display:block;color:#fcd34d;margin-bottom:8px;font-size:15px}
audio{width:100%;height:36px}.narr{margin-top:6px;font-size:11px;color:#8a9aba}</style>
<h1>🎙️ ${title}</h1>
<p style=color:#8a9aba>ナレ: <em>${NARRATION.slice(0, 60)}...</em></p>
${results.map(r => `<div class=row><b>${r.label}</b>
<audio controls preload=none src=${r.mixFile}></audio>
${r.narrFile ? `<div class=narr>声のみ: <audio controls preload=none src=${r.narrFile} style="height:24px"></audio></div>` : ''}
</div>`).join('')}
`;
  fs.writeFileSync(path.join(OUT_DIR, `mix_test_phase${phase}.html`), html);
  console.log(`\n📋 試聴URL: http://37.60.224.54:3004/v2_videos/voice_test/mix_test_phase${phase}.html`);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
