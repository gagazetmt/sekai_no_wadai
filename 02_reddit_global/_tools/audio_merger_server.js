// audio_merger_server.js
// 複数の音声ファイルを結合するためのツール
// ポート: 3008

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

const app  = express();
const PORT = 3008;

// ── CORS許可 ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// プロジェクトのパス設定
const BASE_DIR   = path.join(__dirname, '..');
const TEMP_DIR   = path.join(BASE_DIR, 'temp');
const FFMPEG     = process.platform === 'win32' ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

app.use(express.json());
app.use('/temp', express.static(TEMP_DIR));

// ── API: 音声ファイル一覧取得 ────────────────────────────────────────────────
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(TEMP_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.wav'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(TEMP_DIR, f)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime); // 新しい順
    res.json(files);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: 結合実行 ────────────────────────────────────────────────────────────
app.post('/api/merge', (req, res) => {
  const { files, outputName = 'merged_audio.mp3' } = req.body;
  if (!files || files.length === 0) return res.status(400).json({ error: 'ファイルを選択してください' });

  const listPath = path.join(TEMP_DIR, 'concat_list.txt');
  const outputPath = path.join(TEMP_DIR, outputName);

  try {
    // FFmpeg concat 用のリストファイル作成
    const content = files.map(f => `file '${path.join(TEMP_DIR, f).replace(/'/g, "'\\''")}'`).join('\n');
    fs.writeFileSync(listPath, content);

    console.log(`[audio-merger] 結合開始: ${files.length}件 -> ${outputName}`);
    
    // 結合実行（再エンコードなしの copy モードで爆速結合）
    // ※形式が違う場合は再エンコードが必要だけど、まずはシンプルに copy で実装
    execSync(`"${FFMPEG}" -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`);

    res.json({ ok: true, url: `/temp/${outputName}`, name: outputName });
  } catch (e) {
    console.error('[audio-merger] エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── UI: メイン画面 ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🎙 音声ガッチャンコ</title>
<style>
  body { font-family: sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; max-width: 600px; margin: 0 auto; }
  h1 { font-size: 20px; text-align: center; color: #38bdf8; }
  .card { background: #1e293b; border-radius: 12px; padding: 16px; margin-bottom: 20px; border: 1px solid #334155; }
  .file-item { display: flex; align-items: center; gap: 10px; padding: 8px; background: #0f172a; border-radius: 8px; margin-bottom: 6px; cursor: move; }
  .file-item.selected { border: 1px solid #38bdf8; }
  .checkbox { width: 20px; height: 20px; }
  .file-name { flex: 1; font-size: 14px; overflow: hidden; text-overflow: ellipsis; }
  .controls { display: flex; gap: 10px; margin-top: 10px; }
  .btn { flex: 1; padding: 12px; border-radius: 8px; border: none; font-weight: bold; cursor: pointer; transition: 0.2s; }
  .btn-primary { background: #0284c7; color: white; }
  .btn-primary:hover { background: #0369a1; }
  .btn-primary:disabled { background: #334155; color: #94a3b8; }
  .result-area { display: none; margin-top: 20px; text-align: center; }
  audio { width: 100%; margin-top: 10px; }
</style>
</head>
<body>
  <h1>🎙 音声ガッチャンコ</h1>
  <div class="card">
    <div style="font-size: 12px; color: #94a3b8; margin-bottom: 10px;">
      結合したい順番にチェックを入れてね（新しい順に並んでるよ）
    </div>
    <div id="fileList">読み込み中...</div>
    <div class="controls">
      <button class="btn btn-primary" id="mergeBtn" onclick="merge()" disabled>✨ 結合実行</button>
      <button class="btn" style="background:#334155; color:white;" onclick="loadFiles()">🔄 更新</button>
    </div>
  </div>

  <div id="resultArea" class="card result-area">
    <div style="font-weight:bold; color:#10b981; margin-bottom:10px;">✅ 結合完了！</div>
    <div id="resultName" style="font-size:14px; margin-bottom:10px;"></div>
    <audio id="audioPlayer" controls></audio>
    <a id="downloadLink" href="#" download style="display:block; margin-top:10px; color:#38bdf8; text-decoration:none;">📥 ダウンロード</a>
  </div>

<script>
  let allFiles = [];
  let selectedFiles = [];

  async function loadFiles() {
    const res = await fetch('/api/files');
    allFiles = await res.json();
    render();
  }

  function render() {
    const list = document.getElementById('fileList');
    list.innerHTML = allFiles.map((f, i) => `
      <div class="file-item ${selectedFiles.includes(f.name) ? 'selected' : ''}">
        <input type="checkbox" class="checkbox" 
               ${selectedFiles.includes(f.name) ? 'checked' : ''} 
               onchange="toggleFile('${f.name}')">
        <div class="file-name">${f.name}</div>
        <div style="font-size:10px; color:#64748b">${new Date(f.mtime).toLocaleTimeString()}</div>
      </div>
    `).join('');
    document.getElementById('mergeBtn').disabled = selectedFiles.length < 2;
  }

  function toggleFile(name) {
    if (selectedFiles.includes(name)) {
      selectedFiles = selectedFiles.filter(n => n !== name);
    } else {
      selectedFiles.push(name);
    }
    render();
  }

  async function merge() {
    const btn = document.getElementById('mergeBtn');
    btn.disabled = true;
    btn.innerText = '⏳ 結合中...';

    const outputName = 'combined_' + Date.now() + '.mp3';
    try {
      const res = await fetch('/api/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: selectedFiles, outputName })
      });
      const data = await res.json();
      if (data.ok) {
        document.getElementById('resultArea').style.display = 'block';
        document.getElementById('resultName').innerText = data.name;
        document.getElementById('audioPlayer').src = data.url;
        document.getElementById('downloadLink').href = data.url;
        document.getElementById('downloadLink').download = data.name;
        document.getElementById('audioPlayer').play();
      } else {
        alert('エラー: ' + data.error);
      }
    } catch (e) {
      alert('通信エラー: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerText = '✨ 結合実行';
    }
  }

  loadFiles();
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`\n🎙 音声ガッチャンコツール起動中！`);
  console.log(`   URL: http://localhost:${PORT}`);
  console.log(`   スマホ(Tailscale): http://100.115.192.114:${PORT}`);
  console.log(`   対象フォルダ: ${TEMP_DIR}\n`);
});
