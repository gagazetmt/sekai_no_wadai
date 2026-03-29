// youtube_server.js
// YouTube動画編集用ローカルランチャー（port 3001）
//
// 起動: node youtube_server.js  または  start_youtube.bat
// UI  : http://localhost:3001
//
// 機能:
//   - youtube_content_YYYY-MM-DD.json の読み込み・編集・保存
//   - コメント取得（Reddit / X / Local）→ Claude フィルタリング
//   - 内容確認後、GitHub API 経由でリポジトリに push
//   - GHA ワークフロー（youtube.yml）を workflow_dispatch で起動
//
// 必要な .env:
//   ANTHROPIC_API_KEY=...
//   GITHUB_TOKEN=...          （repo書き込み権限のあるPAT）
//   GITHUB_OWNER=your-name
//   GITHUB_REPO=your-repo
//   TWITTER_API_IO_KEY=...    （X取得用、オプション）

require("dotenv").config();
const express  = require("express");
const fs       = require("fs");
const path     = require("path");
const { execSync, spawn } = require("child_process");
const { fetchFromReddit, fetchFromX, fetchFromLocal, filterWithClaude } = require("./scripts/fetch_comments");

const app  = express();
const PORT = 3001;
const TEMP_DIR = path.join(__dirname, "temp");

app.use(express.json({ limit: "5mb" }));

// ─── API: コンテンツ読み込み ──────────────────────────────────────────────
app.get("/api/content/:date", (req, res) => {
  const file = path.join(TEMP_DIR, `youtube_content_${req.params.date}.json`);
  if (!fs.existsSync(file)) return res.json({ posts: [] });
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
});

// ─── API: コンテンツ保存（ローカル） ─────────────────────────────────────
app.post("/api/content/:date", (req, res) => {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const file = path.join(TEMP_DIR, `youtube_content_${req.params.date}.json`);
  fs.writeFileSync(file, JSON.stringify(req.body, null, 2), "utf8");
  res.json({ ok: true, path: file });
});

// ─── API: コメント取得 ────────────────────────────────────────────────────
app.post("/api/fetch-comments", async (req, res) => {
  const { source, subreddit, query, topic, file, targetCount = 8 } = req.body;

  try {
    let raw = [];
    if (source === "reddit") {
      raw = await fetchFromReddit({ subreddit: subreddit || "soccer", query, count: 100 });
    } else if (source === "x") {
      raw = await fetchFromX({ query, count: 100 });
    } else if (source === "local") {
      if (!file) return res.status(400).json({ error: "file パスが必要です" });
      raw = fetchFromLocal({ file });
    } else {
      return res.status(400).json({ error: `未対応のソース: ${source}` });
    }

    const filtered = await filterWithClaude(raw, {
      topic:       topic || query || "",
      targetCount: parseInt(targetCount),
      maxChars:    30,
      minChars:    8,
    });

    res.json({ comments: filtered, rawCount: raw.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: GitHub push + GHA 起動 ─────────────────────────────────────────
app.post("/api/push-github", async (req, res) => {
  const { content, date } = req.body;
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;

  if (!token || !owner || !repo) {
    return res.status(500).json({
      error: ".env に GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO を設定してください",
    });
  }

  const filePath = `02_reddit_global/temp/youtube_content_${date}.json`;
  const ghHeaders = {
    "Authorization": `Bearer ${token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    // Step1: 既存ファイルの SHA を取得（更新時に必要）
    let sha = null;
    const getRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      { headers: ghHeaders }
    );
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    }

    // Step2: ファイルを push（新規 or 更新）
    const putBody = {
      message: `YouTube content: ${date}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      { method: "PUT", headers: ghHeaders, body: JSON.stringify(putBody) }
    );
    if (!putRes.ok) {
      const msg = await putRes.text();
      throw new Error(`GitHub push 失敗: ${putRes.status} ${msg}`);
    }

    // Step3: GHA ワークフローを workflow_dispatch で起動
    const workflowId = "youtube.yml";
    const dispatchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`,
      {
        method: "POST",
        headers: ghHeaders,
        body: JSON.stringify({ ref: "main", inputs: { date } }),
      }
    );

    if (!dispatchRes.ok && dispatchRes.status !== 204) {
      // ワークフローが存在しない場合は警告のみ（push は成功）
      console.warn(`GHA dispatch: ${dispatchRes.status} (youtube.yml が未作成の場合は正常)`);
    }

    res.json({ ok: true, pushed: filePath, dispatch: dispatchRes.status === 204 || dispatchRes.ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UI ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8">
<title>YouTube 動画編集ランチャー</title>
<style>
  :root{
    --bg:#0d0d0d;--panel:#1a1a1a;--border:#2e2e2e;
    --accent:#e00;--yellow:#ffd700;--text:#e8e8e8;--sub:#888;
    --blue:#4a9eff;--green:#3cb371;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:"Hiragino Kaku Gothic ProN",sans-serif;font-size:14px;}
  /* ── ヘッダー ── */
  header{background:var(--panel);border-bottom:1px solid var(--border);
    padding:12px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;}
  header h1{font-size:16px;font-weight:900;color:var(--yellow);white-space:nowrap;}
  .hdr-date{display:flex;align-items:center;gap:8px;}
  .hdr-date label{color:var(--sub);font-size:13px;}
  input[type=date]{background:#222;border:1px solid var(--border);color:var(--text);
    padding:5px 10px;border-radius:6px;font-size:13px;}
  .hdr-btns{display:flex;gap:8px;margin-left:auto;}
  button{cursor:pointer;border:none;border-radius:6px;
    padding:7px 16px;font-size:13px;font-weight:700;transition:opacity .15s;}
  button:hover{opacity:.8;}
  .btn-load {background:#333;color:var(--text);}
  .btn-save {background:#2a4a2a;color:var(--green);}
  .btn-push {background:var(--accent);color:#fff;}
  .btn-add  {background:#1a2a4a;color:var(--blue);}
  .btn-fetch{background:#2a2a1a;color:var(--yellow);font-size:12px;padding:5px 10px;}
  .btn-del  {background:#2e1515;color:#e66;font-size:12px;padding:4px 8px;}
  /* ── レイアウト ── */
  .main{display:grid;grid-template-columns:200px 1fr;height:calc(100vh - 53px);}
  /* ── サイドバー ── */
  .sidebar{background:var(--panel);border-right:1px solid var(--border);
    padding:12px;overflow-y:auto;}
  .sidebar h2{font-size:12px;color:var(--sub);margin-bottom:8px;letter-spacing:1px;}
  .post-item{padding:8px 10px;border-radius:6px;cursor:pointer;
    font-size:13px;border:1px solid transparent;margin-bottom:4px;
    overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
  .post-item:hover{background:#222;}
  .post-item.active{background:#1a1a2e;border-color:var(--blue);color:var(--blue);}
  .btn-add-post{width:100%;margin-top:8px;background:#1a1a1a;
    color:var(--sub);border:1px dashed var(--border);}
  /* ── エディタ ── */
  .editor{padding:20px 24px;overflow-y:auto;}
  .editor-empty{display:flex;align-items:center;justify-content:center;
    height:100%;color:var(--sub);font-size:16px;}
  /* フォーム要素 */
  .field{margin-bottom:16px;}
  .field label{display:block;font-size:12px;color:var(--sub);margin-bottom:5px;letter-spacing:.5px;}
  .field input,.field textarea,.field select{
    width:100%;background:#111;border:1px solid var(--border);
    color:var(--text);padding:8px 12px;border-radius:6px;
    font-size:13px;font-family:inherit;}
  .field textarea{resize:vertical;min-height:60px;}
  .field input:focus,.field textarea:focus{outline:none;border-color:var(--blue);}
  /* セクション */
  .section{background:var(--panel);border:1px solid var(--border);
    border-radius:10px;padding:16px;margin-bottom:16px;}
  .section-title{font-size:13px;font-weight:700;color:var(--yellow);
    margin-bottom:14px;display:flex;align-items:center;gap:8px;}
  .section-title span{color:var(--sub);font-size:11px;font-weight:400;}
  /* 画像プレビュー */
  .img-row{display:flex;gap:8px;align-items:flex-start;}
  .img-row input{flex:1;}
  .img-preview{width:160px;height:90px;border-radius:6px;object-fit:cover;
    border:1px solid var(--border);background:#111;flex-shrink:0;}
  .img-preview.empty{display:flex;align-items:center;justify-content:center;
    color:var(--sub);font-size:11px;}
  /* スライド */
  .slides-grid{display:grid;gap:14px;}
  .slide-card{background:#111;border:1px solid var(--border);
    border-radius:8px;padding:14px;}
  .slide-num{font-size:11px;color:var(--sub);margin-bottom:10px;font-weight:700;
    letter-spacing:1px;}
  /* コメント */
  .comments-header{display:flex;align-items:center;justify-content:space-between;
    margin-bottom:8px;}
  .comments-header label{font-size:12px;color:var(--sub);}
  .comment-row{display:flex;gap:6px;margin-bottom:6px;align-items:flex-start;}
  .comment-row .c-user{width:100px;flex-shrink:0;}
  .comment-row .c-text{flex:1;}
  .comment-row input{background:#1a1a1a;border:1px solid var(--border);
    color:var(--text);padding:5px 8px;border-radius:5px;font-size:12px;}
  .comment-row .c-text{font-size:12px;}
  .add-comment{font-size:12px;color:var(--blue);background:none;border:1px dashed #1a2a4a;
    width:100%;padding:5px;border-radius:5px;margin-top:4px;}
  /* コメント取得モーダル */
  .fetch-modal{background:#1a1a2e;border:1px solid var(--blue);
    border-radius:8px;padding:14px;margin-top:8px;display:none;}
  .fetch-modal.open{display:block;}
  .fetch-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;}
  .fetch-row .field{margin:0;flex:1;min-width:100px;}
  .fetch-status{font-size:12px;color:var(--sub);margin-top:8px;}
  /* ステータスバー */
  #status-bar{position:fixed;bottom:0;left:0;right:0;
    background:#111;border-top:1px solid var(--border);
    padding:6px 24px;font-size:12px;color:var(--sub);}
  #status-bar.ok{color:var(--green);}
  #status-bar.err{color:var(--accent);}
  /* アウトロ */
  .outro-row{display:flex;gap:8px;}
  .outro-row .field{margin:0;flex:1;}
</style>
</head>
<body>

<!-- ヘッダー -->
<header>
  <h1>🎬 YouTube 動画編集ランチャー</h1>
  <div class="hdr-date">
    <label>日付</label>
    <input type="date" id="date-input">
  </div>
  <div class="hdr-btns">
    <button class="btn-load" onclick="loadContent()">📂 読み込み</button>
    <button class="btn-save" onclick="saveLocal()">💾 ローカル保存</button>
    <button class="btn-push" onclick="pushToGitHub()">🚀 GitHub Push & GHA起動</button>
  </div>
</header>

<!-- メイン -->
<div class="main">
  <!-- サイドバー -->
  <div class="sidebar">
    <h2>投稿一覧</h2>
    <div id="post-list"></div>
    <button class="btn-add-post" onclick="addPost()">＋ 投稿を追加</button>
  </div>

  <!-- エディタ -->
  <div class="editor" id="editor">
    <div class="editor-empty">← 日付を選択して「読み込み」してください</div>
  </div>
</div>

<div id="status-bar">準備完了</div>

<script>
let contentData = { posts: [] };
let currentPostIdx = -1;

// ─── 日付の初期値 ─────────────────────────────────────────────────────────
document.getElementById("date-input").value = new Date().toISOString().slice(0, 10);

// ─── コンテンツ読み込み ───────────────────────────────────────────────────
async function loadContent() {
  const date = document.getElementById("date-input").value;
  if (!date) return setStatus("日付を選択してください", "err");

  const res = await fetch("/api/content/" + date);
  const data = await res.json();
  contentData = data.posts?.length ? data : { posts: [] };

  if (!contentData.posts.length) {
    setStatus("コンテンツが見つかりません。「投稿を追加」で作成してください", "err");
  } else {
    setStatus(contentData.posts.length + "件読み込み完了", "ok");
  }

  renderSidebar();
  if (contentData.posts.length > 0) selectPost(0);
  else document.getElementById("editor").innerHTML = '<div class="editor-empty">投稿を追加してください</div>';
}

// ─── ローカル保存 ─────────────────────────────────────────────────────────
async function saveLocal() {
  const date = document.getElementById("date-input").value;
  if (!date) return setStatus("日付を選択してください", "err");

  syncCurrentPost();
  const res = await fetch("/api/content/" + date, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...contentData, date }),
  });
  const j = await res.json();
  if (j.ok) setStatus("保存完了: " + j.path, "ok");
  else setStatus("保存失敗: " + j.error, "err");
}

// ─── GitHub Push + GHA ────────────────────────────────────────────────────
async function pushToGitHub() {
  const date = document.getElementById("date-input").value;
  if (!date) return setStatus("日付を選択してください", "err");
  if (!contentData.posts.length) return setStatus("コンテンツが空です", "err");

  syncCurrentPost();
  setStatus("GitHub に Push 中...");

  const res = await fetch("/api/push-github", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { ...contentData, date }, date }),
  });
  const j = await res.json();
  if (j.ok) {
    const dispMsg = j.dispatch ? " → GHA ワークフロー起動済み" : " → GHAはpush後に自動起動します";
    setStatus("✅ Push 完了: " + j.pushed + dispMsg, "ok");
  } else {
    setStatus("❌ Push 失敗: " + j.error, "err");
  }
}

// ─── サイドバー描画 ───────────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById("post-list");
  list.innerHTML = contentData.posts.map((p, i) =>
    '<div class="post-item' + (i === currentPostIdx ? " active" : "") + '" ' +
    'onclick="selectPost(' + i + ')">' +
    (p.catchLine1 || "（無題）") + "</div>"
  ).join("");
}

// ─── 投稿選択 ─────────────────────────────────────────────────────────────
function selectPost(idx) {
  if (currentPostIdx >= 0) syncCurrentPost();
  currentPostIdx = idx;
  renderSidebar();
  renderEditor(contentData.posts[idx], idx);
}

// ─── 投稿追加 ─────────────────────────────────────────────────────────────
function addPost() {
  contentData.posts.push({
    catchLine1: "",
    subtitle:   "",
    label:      "",
    imagePath:  "",
    slides: Array.from({ length: 4 }, () => ({
      narration:   "",
      subtitleBox: "",
      comments:    [],
    })),
    outro: { finalComment: { user: "匿名", text: "" } },
  });
  renderSidebar();
  selectPost(contentData.posts.length - 1);
}

// ─── エディタ描画 ─────────────────────────────────────────────────────────
function renderEditor(post, idx) {
  const slides = (post.slides || []).slice(0, 4);
  while (slides.length < 4) slides.push({ narration: "", subtitleBox: "", comments: [] });

  const slidesHtml = slides.map((s, si) => {
    const comments = (s.comments || []).slice(0, 4);
    const commentsHtml = comments.map((c, ci) => commentRow(si, ci, c)).join("");
    return \`
    <div class="slide-card">
      <div class="slide-num">SLIDE \${si + 1}</div>
      <div class="field">
        <label>ナレーション</label>
        <textarea id="narr-\${si}" rows="2">\${esc(s.narration)}</textarea>
      </div>
      <div class="field">
        <label>字幕テキスト</label>
        <textarea id="sub-\${si}" rows="2">\${esc(s.subtitleBox)}</textarea>
      </div>
      <div class="field">
        <div class="comments-header">
          <label>コメント（最大4件）</label>
          <button class="btn-fetch" onclick="toggleFetch(\${si})">💬 コメント取得</button>
        </div>
        <div id="comments-\${si}">\${commentsHtml}</div>
        <button class="add-comment" onclick="addComment(\${si})">＋ コメントを手動追加</button>
        <!-- コメント取得フォーム -->
        <div class="fetch-modal" id="fetch-modal-\${si}">
          <div class="fetch-row">
            <div class="field">
              <label>ソース</label>
              <select id="fetch-src-\${si}">
                <option value="reddit">Reddit</option>
                <option value="x">X (Twitter)</option>
                <option value="local">Local JSON</option>
              </select>
            </div>
            <div class="field" id="fetch-subreddit-wrap-\${si}">
              <label>Subreddit</label>
              <input type="text" id="fetch-sr-\${si}" value="soccer" placeholder="soccer">
            </div>
            <div class="field">
              <label>検索キーワード / トピック</label>
              <input type="text" id="fetch-q-\${si}" value="\${esc(post.catchLine1)}" placeholder="chelsea goal">
            </div>
            <div class="field" id="fetch-file-wrap-\${si}" style="display:none">
              <label>JSONファイルパス</label>
              <input type="text" id="fetch-file-\${si}" placeholder="./comments.json">
            </div>
            <div class="field">
              <label>取得件数</label>
              <input type="number" id="fetch-count-\${si}" value="4" min="1" max="8" style="width:60px">
            </div>
            <button class="btn-fetch" onclick="fetchComments(\${si})" style="align-self:flex-end">取得する</button>
          </div>
          <div class="fetch-status" id="fetch-status-\${si}"></div>
        </div>
      </div>
    </div>\`;
  }).join("");

  const outroComment = post.outro?.finalComment || { user: "匿名", text: "" };

  document.getElementById("editor").innerHTML = \`
  <div style="max-width:800px;margin:0 auto;">
    <!-- 基本情報 -->
    <div class="section">
      <div class="section-title">基本情報 <span>投稿 \${idx + 1}</span></div>
      <div class="field">
        <label>メインタイトル（下部大テロップ）</label>
        <input type="text" id="catchLine1" value="\${esc(post.catchLine1)}">
      </div>
      <div class="field">
        <label>サブタイトル（右上小テロップ）</label>
        <input type="text" id="subtitle" value="\${esc(post.subtitle)}">
      </div>
      <div class="field">
        <label>ラベル（空欄で自動判定）</label>
        <select id="label">
          <option value="">自動判定</option>
          <option value="【悲報】" \${post.label === "【悲報】" ? "selected" : ""}>【悲報】</option>
          <option value="【朗報】" \${post.label === "【朗報】" ? "selected" : ""}>【朗報】</option>
          <option value="【速報】" \${post.label === "【速報】" ? "selected" : ""}>【速報】</option>
          <option value="【衝撃】" \${post.label === "【衝撃】" ? "selected" : ""}>【衝撃】</option>
        </select>
      </div>
      <div class="field">
        <label>画像パス（ローカルパス or URL）</label>
        <div class="img-row">
          <input type="text" id="imagePath" value="\${esc(post.imagePath)}"
            oninput="previewImage(this.value)">
          <div id="img-preview" class="img-preview empty">No Image</div>
        </div>
      </div>
    </div>

    <!-- スライド -->
    <div class="section">
      <div class="section-title">スライド構成 <span>S1〜S4 + アウトロ</span></div>
      <div class="slides-grid">\${slidesHtml}</div>

      <!-- アウトロ -->
      <div class="slide-card" style="margin-top:14px;border-color:#ffd70044;">
        <div class="slide-num" style="color:var(--yellow)">OUTRO（4秒後にオチコメント出現）</div>
        <div class="outro-row">
          <div class="field">
            <label>ユーザー名</label>
            <input type="text" id="outro-user" value="\${esc(outroComment.user)}">
          </div>
          <div class="field" style="flex:3">
            <label>オチのひと言（白ボックス・赤文字で出現）</label>
            <input type="text" id="outro-text" value="\${esc(outroComment.text)}"
              placeholder="これはもうAIであってくれよwww">
          </div>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
      <button class="btn-del" onclick="deletePost(\${idx})">🗑 この投稿を削除</button>
    </div>
  </div>\`;

  // ソース変更でフィールド表示切替
  slides.forEach((_, si) => {
    const srcEl = document.getElementById("fetch-src-" + si);
    if (srcEl) srcEl.addEventListener("change", () => toggleFetchFields(si));
  });

  // 画像プレビュー初期化
  if (post.imagePath) previewImage(post.imagePath);
}

// ─── コメント行 HTML ──────────────────────────────────────────────────────
function commentRow(si, ci, c) {
  return \`<div class="comment-row" id="crow-\${si}-\${ci}">
    <input class="c-user" type="text" value="\${esc(c.user || "匿名")}"
      placeholder="ユーザー名" oninput="updateComment(\${si}, \${ci}, 'user', this.value)">
    <input class="c-text" type="text" value="\${esc(c.text || "")}"
      placeholder="コメント（30文字以内）" oninput="updateComment(\${si}, \${ci}, 'text', this.value)">
    <button class="btn-del" onclick="removeComment(\${si}, \${ci})">✕</button>
  </div>\`;
}

function addComment(si) {
  const post = contentData.posts[currentPostIdx];
  if (!post.slides[si].comments) post.slides[si].comments = [];
  if (post.slides[si].comments.length >= 4) return setStatus("コメントは最大4件です", "err");
  post.slides[si].comments.push({ user: "匿名", text: "" });
  const ci = post.slides[si].comments.length - 1;
  document.getElementById("comments-" + si).insertAdjacentHTML(
    "beforeend", commentRow(si, ci, { user: "匿名", text: "" })
  );
}

function removeComment(si, ci) {
  const post = contentData.posts[currentPostIdx];
  post.slides[si].comments.splice(ci, 1);
  // コメント欄を再描画
  const c = post.slides[si].comments;
  document.getElementById("comments-" + si).innerHTML = c.map((cm, i) => commentRow(si, i, cm)).join("");
}

function updateComment(si, ci, key, val) {
  const post = contentData.posts[currentPostIdx];
  if (post.slides[si].comments[ci]) post.slides[si].comments[ci][key] = val;
}

// ─── コメント取得フォーム ─────────────────────────────────────────────────
function toggleFetch(si) {
  const modal = document.getElementById("fetch-modal-" + si);
  modal.classList.toggle("open");
}

function toggleFetchFields(si) {
  const src = document.getElementById("fetch-src-" + si).value;
  document.getElementById("fetch-subreddit-wrap-" + si).style.display =
    src === "reddit" ? "" : "none";
  document.getElementById("fetch-file-wrap-" + si).style.display =
    src === "local" ? "" : "none";
}

async function fetchComments(si) {
  const src   = document.getElementById("fetch-src-" + si).value;
  const query = document.getElementById("fetch-q-" + si).value;
  const sr    = document.getElementById("fetch-sr-" + si)?.value;
  const file  = document.getElementById("fetch-file-" + si)?.value;
  const count = document.getElementById("fetch-count-" + si)?.value || 4;
  const statusEl = document.getElementById("fetch-status-" + si);

  statusEl.textContent = "取得中...";

  const res = await fetch("/api/fetch-comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source:      src,
      subreddit:   sr,
      query,
      file,
      topic:       document.getElementById("catchLine1")?.value,
      targetCount: parseInt(count),
    }),
  });
  const j = await res.json();

  if (j.error) {
    statusEl.textContent = "❌ " + j.error;
    return;
  }

  statusEl.textContent = "✅ " + j.rawCount + "件 → " + j.comments.length + "件に絞り込み完了";

  // コメントをスライドに追加（既存を置き換え）
  const post = contentData.posts[currentPostIdx];
  post.slides[si].comments = j.comments.slice(0, 4);
  document.getElementById("comments-" + si).innerHTML =
    post.slides[si].comments.map((c, ci) => commentRow(si, ci, c)).join("");
}

// ─── 画像プレビュー ───────────────────────────────────────────────────────
function previewImage(src) {
  const el = document.getElementById("img-preview");
  if (!el) return;
  if (!src) { el.innerHTML = "No Image"; el.className = "img-preview empty"; return; }
  el.className = "img-preview";
  el.innerHTML = '<img src="' + esc(src) + '" style="width:100%;height:100%;object-fit:cover;border-radius:6px;" onerror="this.parentElement.innerHTML=\'読込失敗\'">';
}

// ─── 現在のポストをデータに同期 ───────────────────────────────────────────
function syncCurrentPost() {
  if (currentPostIdx < 0) return;
  const post = contentData.posts[currentPostIdx];
  const g = id => document.getElementById(id)?.value ?? "";

  post.catchLine1 = g("catchLine1");
  post.subtitle   = g("subtitle");
  post.label      = g("label");
  post.imagePath  = g("imagePath");

  [0,1,2,3].forEach(si => {
    if (!post.slides[si]) post.slides[si] = { narration:"",subtitleBox:"",comments:[] };
    post.slides[si].narration   = g("narr-" + si);
    post.slides[si].subtitleBox = g("sub-"  + si);
    // comments は updateComment / addComment / removeComment でリアルタイム同期済み
  });

  post.outro = {
    finalComment: { user: g("outro-user"), text: g("outro-text") },
  };
}

// ─── 投稿削除 ─────────────────────────────────────────────────────────────
function deletePost(idx) {
  if (!confirm("この投稿を削除しますか？")) return;
  contentData.posts.splice(idx, 1);
  currentPostIdx = -1;
  renderSidebar();
  if (contentData.posts.length > 0) selectPost(0);
  else document.getElementById("editor").innerHTML = '<div class="editor-empty">投稿がありません</div>';
}

// ─── ユーティリティ ───────────────────────────────────────────────────────
function esc(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function setStatus(msg, cls = "") {
  const el = document.getElementById("status-bar");
  el.textContent = msg;
  el.className = cls;
}

// ページ離脱前に同期
window.addEventListener("beforeunload", syncCurrentPost);
</script>
</body></html>`);
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 YouTube 動画編集ランチャー起動`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n📝 使い方:`);
  console.log(`   1. ブラウザで日付を選択して「読み込み」`);
  console.log(`   2. 各スライドのナレーション・字幕・コメントを編集`);
  console.log(`   3. 「💾 ローカル保存」で一時保存`);
  console.log(`   4. 「🚀 GitHub Push & GHA起動」で動画生成を開始\n`);
  console.log(`⚠️  必要な .env 設定:`);
  console.log(`   ANTHROPIC_API_KEY / GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO`);
  if (!process.env.GITHUB_TOKEN) console.warn(`   ⚠️  GITHUB_TOKEN が未設定です`);
});
