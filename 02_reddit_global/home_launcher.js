// home_launcher.js
// 自宅PC用 軽量ランチャー（案件抽出・選択・VPS送信）
// Usage: node home_launcher.js
// Port: 3005  スマホからのアクセス: http://100.115.192.114:3005

require("dotenv").config({ path: require("path").join(__dirname, ".env") });
const http    = require("http");
const { spawn } = require("child_process");
const path    = require("path");

const PORT    = 3005;
const VPS_URL = process.env.VPS_URL || "http://100.116.25.91:3003";

// Reddit コメント取得（自宅PCから直接）
async function fetchThreadComments(permalink) {
  if (!permalink) return { selftext: "", comments: [] };
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=50&depth=1`;
    const res = await fetch(url, { headers: { "User-Agent": "soccer-news-bot/1.0" } });
    if (!res.ok) return { selftext: "", comments: [] };
    const json = await res.json();
    const selftext = json[0]?.data?.children?.[0]?.data?.selftext || "";
    const comments = (json[1]?.data?.children || [])
      .filter(c => c.kind === "t1" && c.data.score > 4)
      .sort((a, b) => b.data.score - a.data.score)
      .slice(0, 15)
      .map(c => `[👍${c.data.score}] ${c.data.body?.slice(0, 200)}`);
    return { selftext, comments };
  } catch {
    return { selftext: "", comments: [] };
  }
}

const HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>⚽ ホームランチャー</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: sans-serif; background: #1a1a2e; color: #eee; padding: 12px; max-width: 600px; margin: 0 auto; }
h1 { font-size: 18px; margin-bottom: 12px; color: #e94560; }
.row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
input[type=date] { flex: 1; padding: 8px; border-radius: 6px; border: none; background: #16213e; color: #eee; font-size: 14px; }
button { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; font-weight: bold; }
.btn-fetch { background: #0f3460; color: #eee; white-space: nowrap; }
.btn-send { background: #e94560; color: #fff; width: 100%; padding: 14px; font-size: 16px; margin-top: 16px; border-radius: 8px; display: none; }
.btn-send:disabled { background: #555; cursor: default; }
.section-title { font-size: 12px; color: #aaa; margin: 14px 0 6px; padding-bottom: 4px; border-bottom: 1px solid #333; text-transform: uppercase; }
.item { display: flex; align-items: flex-start; gap: 10px; padding: 10px; background: #16213e; border-radius: 6px; margin-bottom: 6px; cursor: pointer; border: 2px solid transparent; }
.item.checked { border-color: #e94560; background: #1e1e40; }
.item input[type=checkbox] { margin-top: 2px; width: 18px; height: 18px; flex-shrink: 0; accent-color: #e94560; }
.item-title { font-size: 13px; line-height: 1.4; }
.item-meta { font-size: 11px; color: #888; margin-top: 4px; }
.loading { color: #aaa; font-size: 13px; text-align: center; padding: 24px; }
.status { font-size: 13px; text-align: center; padding: 10px; min-height: 36px; }
.selected-count { font-size: 12px; color: #aaa; text-align: right; padding: 4px 0; }
#logScreen { display: none; }
.log-title { font-size: 15px; font-weight: bold; margin-bottom: 10px; color: #e94560; }
.log-box { background: #0d0d1a; border-radius: 8px; padding: 12px; font-family: monospace; font-size: 11px; line-height: 1.6; color: #ccc; height: 55vh; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }
.log-status { text-align: center; padding: 12px; font-size: 14px; }
.spinner { display: inline-block; animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.btn-vps { background: #27ae60; color: #fff; width: 100%; padding: 14px; font-size: 16px; margin-top: 12px; border-radius: 8px; display: none; }
</style>
</head>
<body>
<h1>⚽ ホームランチャー</h1>
<div class="row">
  <input type="date" id="date" />
  <button class="btn-fetch" onclick="fetchCandidates()">📥 取得</button>
</div>
<div class="row" style="margin-bottom: 8px; display: none;" id="bulkBtns">
  <button style="background:#444; color:#eee; flex:1; padding:6px; font-size:12px; border-radius:4px;" onclick="selectAll(true)">✅ 全選択</button>
  <button style="background:#444; color:#eee; flex:1; padding:6px; font-size:12px; border-radius:4px;" onclick="selectAll(false)">❌ 全解除</button>
</div>
<div id="mainScreen">
  <div id="results"></div>
  <div class="selected-count" id="selectedCount"></div>
  <button class="btn-send" id="sendBtn" onclick="sendToVps()">🚀 VPSに送って生成開始</button>
  <div class="status" id="status"></div>
</div>

<div id="logScreen">
  <div class="log-title">⏳ VPSで生成中...</div>
  <div class="log-box" id="logBox"></div>
  <div class="log-status" id="logStatus"><span class="spinner">⚙️</span> 処理中...</div>
  <button class="btn-vps" id="vpsBtn" onclick="window.open('${VPS_URL}', '_blank')">🎬 動画生成ランチャーへ</button>
</div>

<script>
const today = new Date();
today.setHours(today.getHours() + 9);
document.getElementById('date').value = today.toISOString().slice(0, 10);

let candidatesData = null;

async function fetchCandidates() {
  const date = document.getElementById('date').value;
  document.getElementById('results').innerHTML = '<div class="loading">⏳ 取得中...</div>';
  document.getElementById('status').textContent = '';
  document.getElementById('sendBtn').style.display = 'none';
  document.getElementById('selectedCount').textContent = '';

  try {
    const res = await fetch('/api/fetch-candidates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date })
    });
    const data = await res.json();
    if (!data.ok) {
      document.getElementById('results').innerHTML = '<div class="loading">❌ ' + (data.error || '取得失敗') + '</div>';
      return;
    }
    candidatesData = data;
    renderResults(data);
  } catch (e) {
    document.getElementById('results').innerHTML = '<div class="loading">❌ ' + e.message + '</div>';
  }
}

function renderResults(data) {
  const sections = [
    { key: 'commonTopics',    label: '🔥 共通ネタ（Reddit+まとめ）' },
    { key: 'postMatchThreads', label: '⚽ ポストマッチ' },
    { key: 'redditTopics',    label: '💬 Reddit トピック' },
    { key: 'rssTopics',       label: '📰 国内まとめ' },
  ];
  let html = '';
  let total = 0;
  for (const s of sections) {
    const items = data[s.key] || [];
    if (!items.length) continue;
    total += items.length;
    html += '<div class="section-title">' + s.label + ' (' + items.length + '件)</div>';
    items.forEach((item, i) => {
      const id = s.key + '_' + i;
      const score    = item.score    ? '👍' + item.score    : '';
      const comments = item.numComments ? '💬' + item.numComments : '';
      html += '<div class="item" id="wrap_' + id + '" onclick="toggleCheck(\\'' + id + '\\')">'
            + '<input type="checkbox" id="' + id + '" data-key="' + s.key + '" data-index="' + i + '" onclick="event.stopPropagation(); onCheckChange()">'
            + '<div>'
            + '<div class="item-title">' + (item.titleJa || item.title) + '</div>'
            + '<div class="item-meta">' + score + ' ' + comments + '</div>'
            + '</div></div>';
    });
  }
  if (!total) html = '<div class="loading">案件が見つかりませんでした</div>';
  document.getElementById('results').innerHTML = html;
  onCheckChange();
}

function toggleCheck(id) {
  const cb = document.getElementById(id);
  cb.checked = !cb.checked;
  document.getElementById('wrap_' + id).classList.toggle('checked', cb.checked);
  onCheckChange();
}

let _pollTimer = null;

function showLogScreen() {
  document.getElementById('mainScreen').style.display = 'none';
  document.getElementById('logScreen').style.display  = 'block';
  pollJobStatus();
}

async function pollJobStatus() {
  try {
    const res  = await fetch('/api/vps-status');
    const data = await res.json();

    const logBox = document.getElementById('logBox');
    logBox.textContent = data.log || '(ログ待機中...)';
    logBox.scrollTop   = logBox.scrollHeight;

    if (data.done) {
      clearTimeout(_pollTimer);
      const ok = data.exitCode === 0;
      document.getElementById('logStatus').textContent = ok ? '✅ 生成完了！' : '❌ エラーで終了（exitCode: ' + data.exitCode + '）';
      document.getElementById('logTitle') && (document.getElementById('logTitle').textContent = ok ? '✅ 生成完了' : '❌ 生成エラー');
      document.querySelector('.log-title').textContent = ok ? '✅ 生成完了！' : '❌ 生成エラー';
      document.getElementById('vpsBtn').style.display = 'block';
      if (ok) setTimeout(() => window.open('${VPS_URL}', '_blank'), 1500);
    } else {
      _pollTimer = setTimeout(pollJobStatus, 2000);
    }
  } catch (e) {
    document.getElementById('logStatus').textContent = '⚠️ VPS接続エラー: ' + e.message;
    _pollTimer = setTimeout(pollJobStatus, 3000);
  }
}

function onCheckChange() {
  const checked = document.querySelectorAll('input[type=checkbox]:checked');
  const btn     = document.getElementById('sendBtn');
  const cnt     = document.getElementById('selectedCount');
  cnt.textContent = checked.length ? checked.length + '件選択中' : '';
  btn.style.display = checked.length ? 'block' : 'none';
}

async function sendToVps() {
  const checkboxes = document.querySelectorAll('input[type=checkbox]:checked');
  if (!checkboxes.length) return;

  const date    = document.getElementById('date').value;
  const threads = [];
  checkboxes.forEach(cb => {
    threads.push(candidatesData[cb.dataset.key][parseInt(cb.dataset.index)]);
  });

  const btn    = document.getElementById('sendBtn');
  const status = document.getElementById('status');
  btn.disabled = true;
  status.textContent = '⏳ Redditコメント取得中... (しばらくお待ちください)';

  try {
    const res = await fetch('/api/send-to-vps', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ date, threads })
    });
    const result = await res.json();
    if (result.ok) {
      showLogScreen();
    } else {
      status.textContent = '❌ ' + (result.error || '送信失敗');
      btn.disabled = false;
    }
  } catch (e) {
    status.textContent = '❌ ' + e.message;
    btn.disabled = false;
  }
}
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  // トップページ
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML);
    return;
  }

  // ヘルスチェック
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // VPSジョブステータス中継（ブラウザのCORSを回避するためサーバー経由）
  if (req.url === "/api/vps-status" && req.method === "GET") {
    try {
      const vpsRes = await fetch(`${VPS_URL}/api/video-status`);
      const data   = await vpsRes.json();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ running: false, done: false, log: "", error: e.message }));
    }
    return;
  }

  if (req.method === "POST") {
    let body = "";
    req.on("data", d => { body += d.toString(); });
    await new Promise(r => req.on("end", r));

    let data;
    try { data = JSON.parse(body); } catch {
      res.writeHead(400); res.end("Bad JSON"); return;
    }

    // 案件取得
    if (req.url === "/api/fetch-candidates") {
      const script = path.join(__dirname, "scripts", "fetch_candidates.js");
      const args   = data.date ? [script, data.date] : [script];
      let stdout = "", stderr = "";
      const proc = spawn(process.execPath, args, { cwd: __dirname });
      proc.stdout.on("data", d => { stdout += d.toString(); });
      proc.stderr.on("data", d => { stderr += d.toString(); });
      proc.on("close", code => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        if (code !== 0) { res.end(JSON.stringify({ ok: false, error: stderr.slice(0, 300) })); return; }
        try {
          const m = stdout.match(/(\{[\s\S]*\})/);
          if (!m) throw new Error("JSON not found");
          res.end(JSON.stringify({ ok: true, ...JSON.parse(m[1]) }));
        } catch (e) {
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }

    // コメント取得してVPSに送信
    if (req.url === "/api/send-to-vps") {
      const { date, threads } = data;

      // Reddit スレッドのコメントを事前取得
      const preloadedComments = {};
      for (const thread of threads) {
        if (thread.permalink) {
          console.log(`[コメント取得] ${thread.titleJa || thread.title}`);
          preloadedComments[thread.permalink] = await fetchThreadComments(thread.permalink);
        }
      }

      try {
        const vpsRes = await fetch(`${VPS_URL}/api/soccer-yt/import-selected`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ date, threads, preloadedComments }),
        });
        const result = await vpsRes.json();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
  }

  res.writeHead(404); res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n⚽ ホームランチャー起動中`);
  console.log(`   ローカル:     http://localhost:${PORT}`);
  console.log(`   スマホから:   http://100.115.192.114:${PORT}  (Tailscale)`);
  console.log(`   送信先VPS:    ${VPS_URL}`);
  console.log(`   待機中...\n`);
});
