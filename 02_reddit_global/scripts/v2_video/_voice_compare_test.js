// scripts/v2_video/_voice_compare_test.js
// 1案件を3声 (②DominantMan / ⑦GenerousIzakayaOwner / ⑨InnocentBoy) で再生成
//
// 使い方:
//   node scripts/v2_video/_voice_compare_test.js <postId>
//
// 動作:
//   1. 元 modules.json をコピーして 3つの postId（_v2 / _v7 / _v9）を作成
//   2. 各モジュールの mod.tts.voiceId に該当 voice をセット、mod.audio を消す
//   3. 順次 render.js を実行（直列、API レート制限考慮）
//   4. 出力 mp4 のパスを表示

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VOICES = [
  { tag: 'v2_dominant',   voiceId: 'Japanese_DominantMan',         label: '② 覇王' },
  { tag: 'v7_izakaya',    voiceId: 'Japanese_GenerousIzakayaOwner', label: '⑦ 店主' },
  { tag: 'v9_innocent',   voiceId: 'Japanese_InnocentBoy',          label: '⑨ 少年' },
];

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function safeId(s) { return (s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_'); }
function modulesPath(postId) { return path.join(DATA_DIR, safeId(postId) + '_modules.json'); }

async function runRender(postId) {
  return new Promise((resolve, reject) => {
    const jobId = 'voice_test_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const proc = spawn('node', [path.join(__dirname, 'render.js'), postId, jobId], {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve(jobId);
      else reject(new Error('render exit ' + code));
    });
  });
}

(async () => {
  const srcPostId = process.argv[2];
  if (!srcPostId) {
    console.error('Usage: node _voice_compare_test.js <postId>');
    process.exit(1);
  }
  const srcPath = modulesPath(srcPostId);
  if (!fs.existsSync(srcPath)) {
    console.error('source modules not found:', srcPath);
    process.exit(1);
  }

  const srcData = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  console.log(`📂 元案件: ${srcPostId} (${srcData.modules?.length || 0} スライド)`);

  const results = [];
  for (const v of VOICES) {
    const newPostId = srcPostId + '__voice_' + v.tag;
    const newPath   = modulesPath(newPostId);
    console.log(`\n🔊 ${v.label} (${v.voiceId}) → postId: ${newPostId}`);

    // モジュールコピー + voiceId セット + audio クリア
    const modsCopy = JSON.parse(JSON.stringify(srcData));
    modsCopy.postId = newPostId;
    for (const m of (modsCopy.modules || [])) {
      m.tts = Object.assign({}, m.tts || {}, { voiceId: v.voiceId });
      // audio をクリアして再生成させる
      m.audio = null;
    }
    fs.writeFileSync(newPath, JSON.stringify(modsCopy, null, 2));
    console.log(`  modules.json 作成: ${newPath}`);

    try {
      const jobId = await runRender(newPostId);
      console.log(`  ✅ render 完了 (jobId=${jobId})`);
      // 出力動画は data/v2_videos/ に postId の最後20文字 + ts で生成される
      const videoDir = path.join(DATA_DIR, 'v2_videos');
      const prefix = newPostId.replace(/[\/\?%*:|"<>\.]/g, '_').slice(-20);
      const candidates = fs.readdirSync(videoDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.mp4'))
        .sort()
        .reverse();
      const latest = candidates[0];
      const url = latest ? `http://37.60.224.54:3004/v2_videos/${latest}` : '(not found)';
      results.push({ ...v, postId: newPostId, url, file: latest });
    } catch (e) {
      console.warn(`  ❌ ${v.label} 失敗: ${e.message}`);
      results.push({ ...v, postId: newPostId, url: '(failed)', error: e.message });
    }
  }

  console.log('\n=== 比較動画リスト ===');
  for (const r of results) {
    console.log(`${r.label} ${r.voiceId}`);
    console.log(`  ${r.url}`);
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
