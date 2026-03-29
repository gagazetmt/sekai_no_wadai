// shorts_server.js
// YouTube Shorts 制作ランチャー（port 3002）
//
// 起動: node shorts_server.js  または  start_shorts.bat
// UI  : http://localhost:3002
//
// 【第一段階】編集 + ナレーション生成（OpenAI TTS）
// 【第二段階】ブラウザ内でスライド+音声の疑似再生プレビュー
// 【第三段階】GitHub Push → GHA で動画生成（フレームキャプチャはGHA側）
//
// 必要な .env:
//   ANTHROPIC_API_KEY=...
//   OPENAI_API_KEY=...
//   GITHUB_TOKEN=...   （repo書き込み権限のあるPAT）
//   GITHUB_OWNER=your-name
//   GITHUB_REPO=your-repo

require("dotenv").config();
const express  = require("express");
const fs       = require("fs");
const path     = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { spawn } = require("child_process");

const app  = express();
const PORT = 3002;
const TEMP_DIR   = path.join(__dirname, "temp");
const SLIDES_DIR = path.join(__dirname, "shorts_slides");
const SAFE = 288;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let generateJob = null;

app.use(express.json({ limit: "10mb" }));
app.use("/narrations", express.static(SLIDES_DIR));
app.use("/images",     express.static(path.join(__dirname, "images")));
app.use("/thumbnails", express.static(path.join(__dirname, "thumbnails")));

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function imageToBase64(imgPath) {
  if (!imgPath || !fs.existsSync(imgPath)) return { base64: null, mime: null };
  const ext  = path.extname(imgPath).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  return { base64: fs.readFileSync(imgPath).toString("base64"), mime };
}

function getLabelText(content) {
  if (content.label) return content.label;
  const text = `${content.catchLine1 || ""} ${content.catchLine2 || ""}`;
  if (/悲報|残念|死|崩壊|失敗|転落|廃止|敗北/.test(text)) return "【悲報】";
  if (/朗報|成功|最高|喜び|復活|解決|勝利|快挙/.test(text)) return "【朗報】";
  if (/速報|今すぐ|緊急|Breaking/.test(text))               return "【速報】";
  return "【衝撃】";
}

// ─── スライドHTML生成（generate_shorts.js と同等） ─────────────────────────────
function buildSlideHtml(type, data = {}) {
  const {
    catchLine1 = "", catchLine2 = "", subtitle = "",
    badgeText = "ニュース", imagePath = "", labelText = "【衝撃】",
  } = data;

  const { base64, mime } = imageToBase64(imagePath);

  const bgBlur = base64
    ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;filter:blur(28px) brightness(0.38);`
    : `background:linear-gradient(160deg,#0f0c29 0%,#302b63 60%,#24243e 100%);`;

  // ── タイトルカード ──────────────────────────────────────────────────────────
  if (type === "title_card") {
    const thumbH      = 608;
    const thumbTop    = Math.round((1920 - thumbH) / 2) + 50;
    const thumbBottom = thumbTop + thumbH;
    const thumbStyle  = base64
      ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;`
      : `background:#1a1a2e;`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1080px;height:1920px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#000;}
    .bg{width:1080px;height:1920px;position:relative;}
    .blurred-bg{position:absolute;inset:-40px;${bgBlur}}
    .dark-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.55);}
    .upper{position:absolute;top:${SAFE}px;left:0;right:0;height:${thumbTop - SAFE}px;
      display:flex;flex-direction:column;align-items:center;justify-content:flex-start;padding:30px 56px 0;gap:16px;}
    .badge{background:#e00;color:#fff;font-size:44px;font-weight:900;padding:8px 28px;border-radius:8px;letter-spacing:3px;}
    .impact-label{color:#ff2020;font-size:64px;font-weight:900;letter-spacing:4px;
      text-shadow:2px 2px 6px rgba(0,0,0,0.9);}
    .line1{color:#FFD700;font-size:96px;font-weight:900;text-align:center;line-height:1.2;
      text-shadow:4px 4px 10px rgba(0,0,0,0.95);overflow-wrap:break-word;}
    .thumb{position:absolute;top:${thumbTop}px;left:0;right:0;height:${thumbH}px;${thumbStyle}
      border-top:4px solid rgba(255,255,255,0.3);border-bottom:4px solid rgba(255,255,255,0.3);}
    .lower{position:absolute;top:${thumbBottom}px;left:0;right:0;bottom:${SAFE}px;
      display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 56px;}
    .line2{color:#fff;font-size:72px;font-weight:900;text-align:center;line-height:1.3;
      text-shadow:3px 3px 8px rgba(0,0,0,0.95);overflow-wrap:break-word;}
    .account{position:absolute;bottom:${Math.max(SAFE-60,20)}px;left:0;right:0;text-align:center;
      color:rgba(255,255,255,0.5);font-size:30px;}
    @keyframes zoomPan{from{transform:scale(1) translate(0,0);}to{transform:scale(1.15) translate(-3%,2%);}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(40px);}to{opacity:1;transform:translateY(0);}}
    .thumb{animation:zoomPan 8s ease-in-out infinite alternate;}
    .line1{animation:fadeUp 0.8s ease both;}
    .line2{animation:fadeUp 0.8s ease 0.3s both;}
    .badge,.impact-label{animation:fadeUp 0.6s ease both;}
    </style></head><body><div class="bg">
      <div class="blurred-bg"></div><div class="dark-overlay"></div>
      <div class="upper">
        <div class="badge">【衝撃】世界の話題</div>
        <div class="impact-label">${labelText.replace(/</g,"&lt;")}</div>
        <div class="line1">${catchLine1.replace(/</g,"&lt;")}</div>
      </div>
      <div class="thumb"></div>
      <div class="lower">
        <div class="line2">${catchLine2.replace(/</g,"&lt;")}</div>
      </div>
      <div class="account">@sekai_no_wadai</div>
    </div></body></html>`;
  }

  // ── コンテンツスライド ──────────────────────────────────────────────────────
  if (type === "content") {
    const imgH      = 760;
    const imgBottom = SAFE + imgH;
    const upperStyle = base64
      ? `background-image:url('data:${mime};base64,${base64}');background-size:cover;background-position:center;`
      : `background:#1a1a2e;`;

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1080px;height:1920px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#000;}
    .bg{width:1080px;height:1920px;position:relative;}
    .blurred-bg{position:absolute;inset:-40px;${bgBlur}}
    .dark-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.55);}
    .upper-image{position:absolute;top:${SAFE}px;left:0;right:0;height:${imgH}px;overflow:hidden;${upperStyle}}
    .badge{position:absolute;top:${imgBottom+12}px;left:40px;background:#e00;color:#fff;
      font-size:34px;font-weight:900;padding:5px 18px;border-radius:6px;letter-spacing:3px;z-index:2;}
    .footer{position:absolute;bottom:${Math.max(SAFE-60,20)}px;left:0;right:0;text-align:center;
      color:rgba(255,255,255,0.4);font-size:28px;}
    .subtitle-overlay{position:absolute;bottom:${SAFE+60}px;left:40px;right:40px;
      color:#FFD700;font-size:72px;font-weight:900;text-align:center;line-height:1.4;
      text-shadow:3px 3px 10px rgba(0,0,0,0.98),0 0 30px rgba(0,0,0,0.8);
      overflow-wrap:break-word;z-index:10;
      opacity:0;transform:translateY(24px);
      transition:opacity 0.25s ease,transform 0.25s ease;}
    .subtitle-overlay.in{opacity:1;transform:translateY(0);}
    .subtitle-overlay.out{opacity:0;transform:translateY(-20px);transition:opacity 0.2s ease,transform 0.2s ease;}
    @keyframes zoomPan{from{transform:scale(1);}to{transform:scale(1.12) translate(-2%,1%);}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(30px);}to{opacity:1;transform:translateY(0);}}
    .upper-image{animation:zoomPan 7s ease-in-out infinite alternate;}
    .badge{animation:fadeUp 0.5s ease both;}
    </style></head><body><div class="bg">
      <div class="blurred-bg"></div><div class="dark-overlay"></div>
      <div class="upper-image"></div>
      <div class="badge">${badgeText.replace(/</g,"&lt;")}</div>
      <div class="subtitle-overlay" id="sub-overlay"></div>
      <div class="footer">@sekai_no_wadai</div>
    </div>
    <script>
      window.addEventListener('message', function(e) {
        if (!e.data || e.data.type !== 'subtitle') return;
        var el = document.getElementById('sub-overlay');
        if (e.data.text) {
          el.classList.remove('out');
          el.innerHTML = e.data.text.replace(/</g,'&lt;').replace(/\n/g,'<br>');
          void el.offsetWidth;
          el.classList.add('in');
        } else {
          el.classList.remove('in');
          el.classList.add('out');
        }
      });
    </script>
    </body></html>`;
  }

  // ── CTAスライド ────────────────────────────────────────────────────────────
  if (type === "cta") {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{width:1080px;height:1920px;overflow:hidden;font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;
      background:linear-gradient(160deg,#0f0c29 0%,#302b63 60%,#24243e 100%);}
    .bg{width:1080px;height:1920px;display:flex;flex-direction:column;align-items:center;justify-content:center;
      padding:${SAFE}px 80px;gap:56px;}
    .question{color:#FFD700;font-size:82px;font-weight:900;text-align:center;line-height:1.4;
      text-shadow:3px 3px 8px rgba(0,0,0,0.8);overflow-wrap:break-word;}
    .divider{width:200px;height:4px;background:rgba(255,255,255,0.3);border-radius:2px;}
    .cta-text{color:#fff;font-size:56px;font-weight:700;text-align:center;line-height:1.5;}
    .account{color:#1da1f2;font-size:64px;font-weight:900;}
    .follow{color:rgba(255,255,255,0.7);font-size:46px;text-align:center;}
    @keyframes fadeUp{from{opacity:0;transform:translateY(30px);}to{opacity:1;transform:translateY(0);}}
    .question{animation:fadeUp 0.8s ease both;}
    .cta-text{animation:fadeUp 0.8s ease 0.3s both;}
    .account{animation:fadeUp 0.8s ease 0.5s both;}
    .follow{animation:fadeUp 0.8s ease 0.7s both;}
    </style></head><body><div class="bg">
      <div class="question">${subtitle.replace(/</g,"&lt;").replace(/\n/g,"<br>")}</div>
      <div class="divider"></div>
      <div class="cta-text">もっと世界の話題なら</div>
      <div class="account">@sekai_no_wadai</div>
      <div class="follow">をフォロー！</div>
    </div></body></html>`;
  }

  return "<html><body style='background:#111'></body></html>";
}

// ─── API: 利用可能な日付一覧 ──────────────────────────────────────────────────
app.get("/api/dates", (req, res) => {
  if (!fs.existsSync(TEMP_DIR)) return res.json({ dates: [] });
  const files = fs.readdirSync(TEMP_DIR);
  const dates = [...new Set(
    files
      .map(f => f.match(/^generated_(\d{4}-\d{2}-\d{2})\.json$/)?.[1])
      .filter(Boolean)
  )].sort().reverse();  // 新しい順
  res.json({ dates });
});

// ─── API: コンテンツ読み込み ───────────────────────────────────────────────────
app.get("/api/shorts/:date", (req, res) => {
  const { date } = req.params;
  const contentFile = path.join(TEMP_DIR, `shorts_content_${date}.json`);
  const genFile     = path.join(TEMP_DIR, `generated_${date}.json`);

  let posts = [];
  if (fs.existsSync(contentFile)) {
    posts = JSON.parse(fs.readFileSync(contentFile, "utf8")).posts || [];
  }

  // generated_ から imagePath を補完
  let imagePaths = [];
  if (fs.existsSync(genFile)) {
    imagePaths = (JSON.parse(fs.readFileSync(genFile, "utf8")).posts || [])
      .map(p => p.savedImagePath || null);
  }

  posts = posts.map((p, i) => ({ ...p, _imagePath: imagePaths[i] || null }));
  res.json({ posts, date, hasContent: posts.length > 0 });
});

// ─── API: コンテンツ保存 ──────────────────────────────────────────────────────
app.post("/api/shorts/:date", (req, res) => {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  const { date } = req.params;
  const file = path.join(TEMP_DIR, `shorts_content_${date}.json`);
  // _imagePath は保存対象外（generated_ から参照するため）
  const body = { ...req.body, posts: (req.body.posts || []).map(({ _imagePath, ...rest }) => rest) };
  fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
  res.json({ ok: true, path: file });
});

// ─── API: スライドHTMLプレビュー ───────────────────────────────────────────────
app.get("/api/preview", (req, res) => {
  const { type = "title_card", catchLine1 = "", catchLine2 = "",
          subtitle = "", badgeText = "ニュース", imagePath = "", label = "" } = req.query;
  const labelText = label || getLabelText({ catchLine1, catchLine2 });
  const html = buildSlideHtml(type, { catchLine1, catchLine2, subtitle, badgeText, imagePath, labelText });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

// ─── API: TTS生成（5本/1投稿） ─────────────────────────────────────────────────
app.post("/api/tts", async (req, res) => {
  const { date, postIdx, post } = req.body;
  if (!date || postIdx === undefined || !post) {
    return res.status(400).json({ error: "date / postIdx / post が必要です" });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY が未設定です" });
  }

  const postNum  = postIdx + 1;
  const slideDir = path.join(SLIDES_DIR, `${date}_${postNum}`);
  if (!fs.existsSync(slideDir)) fs.mkdirSync(slideDir, { recursive: true });

  const texts = [
    `${post.catchLine1}。${post.catchLine2}`,
    post.slide1?.narration || "",
    post.slide2?.narration || "",
    post.slide3?.narration || "",
    post.slide4?.narration || "",
  ];

  const results = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i].trim();
    const outPath = path.join(slideDir, `narr_${i}.mp3`);
    if (!text) { results.push({ index: i, ok: false, error: "テキストなし" }); continue; }

    try {
      const r = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ model: "tts-1", voice: "nova", input: text, response_format: "mp3" }),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      fs.writeFileSync(outPath, Buffer.from(await r.arrayBuffer()));
      results.push({
        index: i, ok: true,
        url: `/narrations/${date}_${postNum}/narr_${i}.mp3`,
      });
    } catch (e) {
      results.push({ index: i, ok: false, error: e.message });
    }
  }

  res.json({ ok: true, results, postNum });
});

// ─── API: Claude でコンテンツ自動生成 ─────────────────────────────────────────
app.post("/api/generate-content", async (req, res) => {
  const { date } = req.body;
  const genFile = path.join(TEMP_DIR, `generated_${date}.json`);
  if (!fs.existsSync(genFile)) {
    return res.status(404).json({ error: `generated_${date}.json が見つかりません。先に generate_post.js を実行してください。` });
  }

  const { posts: genPosts } = JSON.parse(fs.readFileSync(genFile, "utf8"));
  const posts = [];

  for (let i = 0; i < genPosts.length; i++) {
    const p = genPosts[i];
    const prompt = `以下のX投稿ネタをYouTube Shortsの5スライド動画コンテンツに変換してください。

## 元データ
- タイトル(英語): ${p.title}
- X投稿文: ${p.postText}
- subreddit: r/${p.subreddit}

## 出力形式（JSONのみ返答）
{
  "catchLine1": "キャッチコピー1行目（8〜12文字、インパクト重視）",
  "catchLine2": "キャッチコピー2行目（8〜12文字、補足・結末）",
  "slide1": {
    "narration": "導入ナレーション（1〜2文、40文字以内）",
    "subtitle": "narrationと完全に同じテキストをそのままコピー",
    "emotion": "SURPRISE"
  },
  "slide2": {
    "narration": "背景・理由ナレーション（1〜2文、40文字以内）",
    "subtitle": "narrationと完全に同じテキストをそのままコピー",
    "emotion": "THINK"
  },
  "slide3": {
    "narration": "衝撃事実ナレーション（1〜2文、40文字以内）",
    "subtitle": "narrationと完全に同じテキストをそのままコピー",
    "emotion": "HAPPY または SAD または ANGRY"
  },
  "slide4": {
    "narration": "視聴者への問いかけ（1文、30文字以内）",
    "subtitle": "narrationと完全に同じテキストをそのままコピー"
  }
}

条件: 全文日本語 / subtitle は必ず narration と完全に同じ文字列にすること / JSONのみ出力`;

    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      });
      const json = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
      posts.push(json);
    } catch (e) {
      const fallback = p.postText.replace(/【.*?】/g, "").trim();
      posts.push({
        catchLine1: fallback.slice(0, 12), catchLine2: "海外で話題",
        slide1: { narration: fallback.slice(0, 60), subtitle: "注目の話題", emotion: "SURPRISE" },
        slide2: { narration: "詳細はこちら。", subtitle: "詳しく見ると…", emotion: "THINK" },
        slide3: { narration: "世界が注目しています。", subtitle: "世界も驚いた！", emotion: "HAPPY" },
        slide4: { narration: "あなたはどう思いますか？", subtitle: "あなたは\nどう思う？" },
      });
    }
  }

  const content = { date, posts };
  const contentFile = path.join(TEMP_DIR, `shorts_content_${date}.json`);
  fs.writeFileSync(contentFile, JSON.stringify(content, null, 2), "utf8");

  // imagePaths を補完して返す
  const imagePaths = genPosts.map(p => p.savedImagePath || null);
  const postsWithImg = posts.map((p, i) => ({ ...p, _imagePath: imagePaths[i] || null }));
  res.json({ ok: true, posts: postsWithImg, date });
});

// ─── API: GitHub Push + GHA起動 ───────────────────────────────────────────────
app.post("/api/push-github", async (req, res) => {
  const { content, date } = req.body;
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo  = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    return res.status(500).json({ error: ".env に GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO を設定してください" });
  }

  const filePath  = `02_reddit_global/temp/shorts_content_${date}.json`;
  const ghHeaders = {
    "Authorization": `Bearer ${token}`,
    "Content-Type":  "application/json",
    "Accept":        "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    let sha = null;
    const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, { headers: ghHeaders });
    if (getRes.ok) sha = (await getRes.json()).sha;

    const putBody = {
      message: `Shorts content: ${date}`,
      content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
    };
    if (sha) putBody.sha = sha;

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      { method: "PUT", headers: ghHeaders, body: JSON.stringify(putBody) }
    );
    if (!putRes.ok) throw new Error(`GitHub push 失敗: ${putRes.status} ${await putRes.text()}`);

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/shorts.yml/dispatches`,
      { method: "POST", headers: ghHeaders, body: JSON.stringify({ ref: "main", inputs: { date } }) }
    );

    res.json({ ok: true, pushed: filePath, dispatch: dispatchRes.status === 204 || dispatchRes.ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── ネタ生成実行 API ─────────────────────────────────────────────────────────
app.post("/api/run-generate", (req, res) => {
  if (generateJob?.running) return res.json({ ok: false, message: "すでに実行中です" });
  generateJob = { running: true, log: [], done: false, exitCode: null };
  const proc = spawn(process.execPath, [path.join(__dirname, "scripts", "generate_post.js")], {
    cwd: __dirname, env: process.env
  });
  proc.stdout.on("data", d => generateJob.log.push(d.toString()));
  proc.stderr.on("data", d => generateJob.log.push(d.toString()));
  proc.on("close", code => {
    generateJob.running = false;
    generateJob.done = true;
    generateJob.exitCode = code;
  });
  res.json({ ok: true });
});

app.get("/api/generate-status", (req, res) => {
  if (!generateJob) return res.json({ running: false, done: false, log: "" });
  res.json({
    running: generateJob.running,
    done: generateJob.done,
    exitCode: generateJob.exitCode,
    log: generateJob.log.join("")
  });
});

// ─── UI ──────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="UTF-8">
<title>Shorts 制作ランチャー</title>
<style>
  :root{
    --bg:#0d0d0d;--panel:#1a1a1a;--border:#2e2e2e;
    --accent:#e00;--yellow:#ffd700;--text:#e8e8e8;--sub:#888;
    --blue:#4a9eff;--green:#3cb371;--purple:#9b59b6;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--text);font-family:"Hiragino Kaku Gothic ProN",sans-serif;font-size:14px;height:100vh;overflow:hidden;}
  /* ── ヘッダー ── */
  header{background:var(--panel);border-bottom:1px solid var(--border);
    padding:10px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;height:50px;}
  header h1{font-size:15px;font-weight:900;color:var(--yellow);white-space:nowrap;}
  #date-select{background:#222;border:1px solid var(--border);color:var(--text);
    padding:4px 8px;border-radius:6px;font-size:13px;min-width:160px;}
  .date-badge{font-size:11px;padding:2px 7px;border-radius:4px;margin-left:4px;}
  .date-badge.has-content{background:#1a3a1a;color:var(--green);}
  .date-badge.no-content{background:#2a2a1a;color:var(--yellow);}
  .hdr-btns{display:flex;gap:6px;margin-left:auto;}
  button{cursor:pointer;border:none;border-radius:6px;padding:6px 14px;
    font-size:12px;font-weight:700;transition:opacity .15s;}
  button:hover{opacity:.8;}
  button:disabled{opacity:.4;cursor:default;}
  .btn-load  {background:#333;color:var(--text);}
  .btn-gen   {background:#1a2a4a;color:var(--blue);}
  .btn-save  {background:#2a4a2a;color:var(--green);}
  .btn-push  {background:var(--accent);color:#fff;}
  .btn-tts   {background:#2a1a4a;color:var(--purple);}
  .btn-play  {background:#1a3a1a;color:var(--green);font-size:14px;}
  .btn-del   {background:#2e1515;color:#e66;font-size:11px;padding:3px 7px;}
  /* ── レイアウト ── */
  .layout{display:grid;grid-template-columns:180px 560px 1fr;height:calc(100vh - 50px);}
  /* ── サイドバー ── */
  .sidebar{background:var(--panel);border-right:1px solid var(--border);
    padding:10px;overflow-y:auto;}
  .sidebar h2{font-size:11px;color:var(--sub);margin-bottom:8px;letter-spacing:1px;}
  .post-item{padding:7px 9px;border-radius:6px;cursor:pointer;font-size:12px;
    border:1px solid transparent;margin-bottom:3px;overflow:hidden;
    white-space:nowrap;text-overflow:ellipsis;line-height:1.4;}
  .post-item:hover{background:#222;}
  .post-item.active{background:#1a1a2e;border-color:var(--blue);color:var(--blue);}
  .post-item .tts-badge{font-size:10px;color:var(--purple);margin-left:4px;}
  /* ── エディタ ── */
  .editor{padding:16px 20px;overflow-y:auto;}
  .editor-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100%;color:var(--sub);gap:12px;}
  .editor-empty button{font-size:14px;padding:10px 24px;}
  .field{margin-bottom:12px;}
  .field label{display:block;font-size:11px;color:var(--sub);margin-bottom:4px;letter-spacing:.5px;}
  .field input,.field textarea,.field select{
    width:100%;background:#111;border:1px solid var(--border);
    color:var(--text);padding:7px 10px;border-radius:6px;font-size:13px;font-family:inherit;}
  .field textarea{resize:vertical;min-height:52px;}
  .field input:focus,.field textarea:focus{outline:none;border-color:var(--blue);}
  .section{background:var(--panel);border:1px solid var(--border);
    border-radius:8px;padding:14px;margin-bottom:12px;}
  .section-title{font-size:12px;font-weight:700;color:var(--yellow);
    margin-bottom:12px;display:flex;align-items:center;gap:8px;}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
  .emotion-row{display:flex;gap:10px;align-items:flex-start;}
  .emotion-row .field:first-child{flex:2;}
  .emotion-row .field:last-child{flex:1;}
  .slide-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
  .slide-label{font-size:11px;font-weight:700;color:var(--sub);letter-spacing:1px;}
  .tts-status{font-size:11px;padding:2px 8px;border-radius:4px;background:#111;}
  .tts-status.ok{color:var(--green);}
  .tts-status.wait{color:var(--sub);}
  /* ── プレビューパネル ── */
  .preview-panel{background:#111;border-left:1px solid var(--border);
    display:flex;flex-direction:column;overflow:hidden;}
  .preview-tabs{display:flex;border-bottom:1px solid var(--border);flex-shrink:0;}
  .preview-tab{flex:1;padding:7px 0;text-align:center;font-size:11px;font-weight:700;
    cursor:pointer;color:var(--sub);border-right:1px solid var(--border);transition:all .15s;}
  .preview-tab:last-child{border-right:none;}
  .preview-tab:hover{background:#1a1a1a;color:var(--text);}
  .preview-tab.active{background:#1a1a2e;color:var(--blue);}
  .preview-frame-wrap{flex:1;overflow:hidden;position:relative;background:#000;}
  .preview-frame-wrap iframe{
    width:1080px;height:1920px;
    transform:scale(0.48);transform-origin:top left;
    border:none;pointer-events:none;}
  .preview-footer{padding:10px;display:flex;flex-direction:column;gap:8px;
    border-top:1px solid var(--border);flex-shrink:0;}
  .preview-footer-row{display:flex;gap:6px;}
  /* ── プレビュープレイヤーモーダル ── */
  #player-modal{
    display:none;position:fixed;inset:0;background:rgba(0,0,0,0.92);
    z-index:1000;flex-direction:column;align-items:center;justify-content:center;gap:16px;}
  #player-modal.open{display:flex;}
  .player-wrap{position:relative;}
  .player-wrap iframe{
    width:1080px;height:1920px;
    transform:scale(0.36);transform-origin:top left;
    border:2px solid var(--border);border-radius:8px;pointer-events:none;}
  .player-wrap-inner{width:389px;height:691px;overflow:hidden;border-radius:8px;}
  .player-controls{display:flex;align-items:center;gap:16px;}
  .player-dots{display:flex;gap:8px;}
  .player-dot{width:10px;height:10px;border-radius:50%;background:var(--border);transition:background .2s;}
  .player-dot.active{background:var(--yellow);}
  .player-dot.done{background:var(--green);}
  .player-info{color:var(--sub);font-size:13px;min-width:120px;text-align:center;}
  .btn-close-player{position:absolute;top:16px;right:16px;background:#333;color:var(--text);font-size:16px;padding:8px 14px;}
  /* ── ステータスバー ── */
  #status-bar{position:fixed;bottom:0;left:0;right:0;background:#111;
    border-top:1px solid var(--border);padding:5px 20px;font-size:12px;color:var(--sub);z-index:100;}
  #status-bar.ok{color:var(--green);}
  #status-bar.err{color:var(--accent);}
  #status-bar.loading{color:var(--blue);}
</style>
</head>
<body>

<!-- ヘッダー -->
<header>
  <h1>🎬 Shorts 制作ランチャー</h1>
  <select id="date-select" onchange="onDateChange()"><option value="">-- 日付を選択 --</option></select>
  <span id="date-badge"></span>
  <div class="hdr-btns">
    <button id="run-gen-btn" class="btn-load" onclick="runGenerate()" style="background:#1a3a2a;color:#3cb371;">🔄 ネタ生成</button>
    <button class="btn-load" onclick="loadContent()">📂 読み込み</button>
    <button class="btn-gen"  onclick="generateContent()">🤖 Claude生成</button>
    <button class="btn-save" onclick="saveLocal()">💾 保存</button>
    <button class="btn-push" onclick="pushToGitHub()">🚀 動画生成リクエスト</button>
  </div>
</header>

<!-- メイン -->
<div class="layout">
  <!-- サイドバー -->
  <div class="sidebar">
    <h2>投稿一覧</h2>
    <div id="post-list"></div>
  </div>

  <!-- プレビューパネル -->
  <div class="preview-panel">
    <div class="preview-tabs" id="preview-tabs">
      <div class="preview-tab active" onclick="switchTab(0)">タイトル</div>
      <div class="preview-tab" onclick="switchTab(1)">S1</div>
      <div class="preview-tab" onclick="switchTab(2)">S2</div>
      <div class="preview-tab" onclick="switchTab(3)">S3</div>
      <div class="preview-tab" onclick="switchTab(4)">CTA</div>
    </div>
    <div class="preview-frame-wrap">
      <iframe id="preview-iframe" src="about:blank"></iframe>
    </div>
    <div class="preview-footer">
      <div class="preview-footer-row">
        <button class="btn-tts" style="flex:1" onclick="generateTTS()">🎙️ ナレーション生成</button>
      </div>
      <div class="preview-footer-row">
        <button class="btn-play" style="flex:1" onclick="openPlayer()" id="btn-play" disabled>▶ プレビュー再生</button>
      </div>
    </div>
  </div>

  <!-- エディタ -->
  <div class="editor" id="editor">
    <div class="editor-empty">
      <div style="color:var(--sub)">← 日付を選択して「読み込み」または「Claude生成」</div>
    </div>
  </div>

</div>

<!-- プレビュープレイヤーモーダル -->
<div id="player-modal">
  <button class="btn-close-player" onclick="closePlayer()">✕ 閉じる</button>
  <div class="player-wrap">
    <div class="player-wrap-inner">
      <iframe id="player-iframe" src="about:blank"></iframe>
    </div>
  </div>
  <div class="player-controls">
    <div class="player-dots" id="player-dots"></div>
    <div class="player-info" id="player-info">準備中...</div>
    <button onclick="togglePlayerPause()" id="btn-pause" style="background:#333;color:#fff;padding:8px 16px;border-radius:6px;font-size:13px;">⏸ 一時停止</button>
  </div>
</div>

<audio id="narr-audio"></audio>
<div id="status-bar">準備完了</div>

<script>
// ─── 状態管理 ──────────────────────────────────────────────────────────────
let contentData    = { posts: [], date: "" };
let currentIdx     = -1;
let currentTabIdx  = 0;
let ttsReady       = {};  // { "postIdx_slideIdx": true }
let playerPaused   = false;
let playerStopFlag = false;

// ─── 初期化 ────────────────────────────────────────────────────────────────
(async function init() {
  try {
    const res = await fetch("/api/dates");
    const { dates } = await res.json();
    const sel = document.getElementById("date-select");
    // JST今日の日付
    const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const today = jstNow.toISOString().slice(0, 10);

    // shorts_content が存在する日付を並行取得（1つ失敗しても止まらない）
    const contentDates = new Set();
    await Promise.all(dates.map(async d => {
      try {
        const r = await fetch("/api/shorts/" + d);
        const j = await r.json();
        if (j.hasContent) contentDates.add(d);
      } catch (_) {}
    }));

    dates.forEach(d => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d + (contentDates.has(d) ? " ✅" : " （未生成）");
      if (d === today) opt.selected = true;
      sel.appendChild(opt);
    });

    if (dates.length > 0) {
      if (!sel.value || sel.value === "") sel.value = dates[0];
      onDateChange();
      await loadContent();
    }
  } catch (e) {
    console.error("init失敗:", e);
    document.querySelector(".sidebar").innerHTML = '<div style="color:#e66;padding:12px;font-size:12px;">⚠️ 初期化エラー: ' + e.message + '</div>';
  }
})();

// ─── 読み込み ──────────────────────────────────────────────────────────────
async function loadContent() {
  const date = getDate();
  if (!date) return setStatus("日付を選択してください", "err");
  setStatus("読み込み中...", "loading");
  const res  = await fetch("/api/shorts/" + date);
  const data = await res.json();
  contentData = { posts: data.posts || [], date };
  renderSidebar();
  if (contentData.posts.length > 0) selectPost(0);
  else document.getElementById("editor").innerHTML = '<div class="editor-empty"><div>コンテンツがありません。「Claude生成」を試してください。</div></div>';
  checkTTSFiles();
  setStatus(contentData.posts.length + "件読み込み完了", "ok");
}

// ─── ネタ生成（generate_post.js 実行） ────────────────────────────────────────
let genPollTimer = null;
async function runGenerate() {
  const btn = document.getElementById('run-gen-btn');
  btn.textContent = '⏳ 実行中...';
  btn.disabled = true;
  setStatus("ネタ生成中... しばらくお待ちください", "loading");
  try {
    const res = await fetch('/api/run-generate', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) {
      setStatus('⚠️ ' + data.message, 'err');
      btn.textContent = '🔄 ネタ生成';
      btn.disabled = false;
      return;
    }
    genPollTimer = setInterval(async () => {
      const s = await fetch('/api/generate-status').then(r => r.json());
      if (s.done) {
        clearInterval(genPollTimer);
        if (s.exitCode === 0) {
          setStatus('✅ ネタ生成完了！「📂 読み込み」で確認してください', 'ok');
        } else {
          setStatus('⚠️ 生成終了（エラーあり）コンソールを確認してください', 'err');
        }
        btn.textContent = '🔄 ネタ生成';
        btn.disabled = false;
      }
    }, 1500);
  } catch(e) {
    setStatus('❌ エラー: ' + e.message, 'err');
    btn.textContent = '🔄 ネタ生成';
    btn.disabled = false;
  }
}

// ─── Claude 自動生成 ───────────────────────────────────────────────────────
async function generateContent() {
  const date = getDate();
  if (!date) return setStatus("日付を選択してください", "err");
  if (!confirm("Claude Haiku でショートコンテンツを自動生成します。generated_" + date + ".json が必要です。続けますか？")) return;
  setStatus("Claude でコンテンツ生成中...", "loading");
  document.querySelector(".btn-gen").disabled = true;
  try {
    const res  = await fetch("/api/generate-content", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    contentData = { posts: data.posts || [], date };
    renderSidebar();
    if (contentData.posts.length > 0) selectPost(0);
    setStatus("✅ " + contentData.posts.length + "件 生成完了", "ok");
  } catch (e) {
    setStatus("❌ " + e.message, "err");
  } finally {
    document.querySelector(".btn-gen").disabled = false;
  }
}

// ─── ローカル保存 ──────────────────────────────────────────────────────────
async function saveLocal() {
  const date = getDate();
  if (!date) return setStatus("日付を選択してください", "err");
  syncCurrentPost();
  const res = await fetch("/api/shorts/" + date, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...contentData, date }),
  });
  const j = await res.json();
  if (j.ok) setStatus("✅ 保存完了", "ok");
  else      setStatus("❌ 保存失敗: " + j.error, "err");
}

// ─── GitHub Push & GHA起動 ────────────────────────────────────────────────
async function pushToGitHub() {
  const date = getDate();
  if (!date || !contentData.posts.length) return setStatus("コンテンツが空です", "err");
  if (!confirm("GitHub に Push し、GHA で動画生成を開始します。\\n\\nフレームキャプチャ処理はGHA上で実行されます（10〜30分）。")) return;
  syncCurrentPost();
  setStatus("GitHub に Push 中...", "loading");
  const res = await fetch("/api/push-github", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: { ...contentData, date }, date }),
  });
  const j = await res.json();
  if (j.ok) {
    setStatus("✅ Push 完了 → GHA " + (j.dispatch ? "起動済み" : "は push 後に自動起動"), "ok");
  } else {
    setStatus("❌ " + j.error, "err");
  }
}

// ─── サイドバー ────────────────────────────────────────────────────────────
function renderSidebar() {
  document.getElementById("post-list").innerHTML = contentData.posts.map((p, i) => {
    const hasTts = [0,1,2,3,4].every(s => ttsReady[i + "_" + s]);
    return '<div class="post-item' + (i === currentIdx ? " active" : "") + '" onclick="selectPost(' + i + ')">'
      + esc(p.catchLine1 || "（無題）")
      + (hasTts ? '<span class="tts-badge">🎙️</span>' : '')
      + '</div>';
  }).join("");
}

// ─── 投稿選択 ──────────────────────────────────────────────────────────────
function selectPost(idx) {
  if (currentIdx >= 0) syncCurrentPost();
  currentIdx = idx;
  currentTabIdx = 0;
  renderSidebar();
  renderEditor(contentData.posts[idx], idx);
  updatePreview();
}

// ─── エディタ描画 ──────────────────────────────────────────────────────────
function renderEditor(post, idx) {
  if (!post) return;
  const slides = ["slide1","slide2","slide3"].map((k,i) => ({
    key: k, num: i+1,
    label: ["S1：導入","S2：背景","S3：衝撃"][i],
    badge: ["ニュース","豆知識","衝撃の事実"][i],
    ...((post[k]) || { narration:"", subtitle:"", emotion:"SURPRISE" }),
  }));
  const s4 = post.slide4 || { narration:"", subtitle:"" };

  document.getElementById("editor").innerHTML = \`
  <div style="max-width:640px;margin:0 auto;padding-bottom:40px;">

    <!-- タイトルカード -->
    <div class="section">
      <div class="section-title">🎯 タイトルカード <span style="font-size:10px;font-weight:400;color:var(--sub)">投稿\${idx+1}</span></div>
      <div class="row2">
        <div class="field">
          <label>キャッチコピー1行目</label>
          <input type="text" id="catchLine1" value="\${esc(post.catchLine1)}" oninput="onFieldChange()">
        </div>
        <div class="field">
          <label>キャッチコピー2行目</label>
          <input type="text" id="catchLine2" value="\${esc(post.catchLine2)}" oninput="onFieldChange()">
        </div>
      </div>
      <div class="field">
        <label>ラベル（空欄で自動判定）</label>
        <select id="label" onchange="onFieldChange()">
          <option value="">自動判定</option>
          <option value="【悲報】" \${post.label==="【悲報】"?"selected":""}>【悲報】</option>
          <option value="【朗報】" \${post.label==="【朗報】"?"selected":""}>【朗報】</option>
          <option value="【速報】" \${post.label==="【速報】"?"selected":""}>【速報】</option>
          <option value="【衝撃】" \${post.label==="【衝撃】"?"selected":""}>【衝撃】</option>
        </select>
      </div>
      <div class="field" style="display:none">
        <input type="text" id="imagePath" value="\${esc(post._imagePath||"")}">
      </div>
    </div>

    <!-- スライド1〜3 -->
    \${slides.map(s => \`
    <div class="section">
      <div class="slide-header">
        <span class="slide-label">\${s.label}</span>
        <span class="tts-status \${ttsReady[idx+"_"+(s.num)]?"ok":"wait"}" id="tts-status-\${s.num}">
          \${ttsReady[idx+"_"+s.num]?"✅ 生成済み":"⏳ 未生成"}
        </span>
      </div>
      <div class="field">
        <label>ナレーション</label>
        <textarea id="narr-\${s.num}" rows="2">\${esc(s.narration)}</textarea>
      </div>
      <div class="emotion-row">
        <div class="field">
          <label>字幕テキスト（改行は↵）</label>
          <input type="text" id="sub-\${s.num}" value="\${esc(s.subtitle)}" oninput="if(currentTabIdx===\${s.num})updatePreview()">
        </div>
        <div class="field">
          <label>感情</label>
          <select id="emo-\${s.num}">
            \${["SURPRISE","HAPPY","SAD","ANGRY","THINK"].map(e=>\`<option \${s.emotion===e?"selected":""}>\${e}</option>\`).join("")}
          </select>
        </div>
      </div>
    </div>\`).join("")}

    <!-- CTA -->
    <div class="section">
      <div class="slide-header">
        <span class="slide-label">S4：CTA（問いかけ）</span>
        <span class="tts-status \${ttsReady[idx+"_4"]?"ok":"wait"}" id="tts-status-4">
          \${ttsReady[idx+"_4"]?"✅ 生成済み":"⏳ 未生成"}
        </span>
      </div>
      <div class="field">
        <label>ナレーション（問いかけ）</label>
        <textarea id="narr-4" rows="2">\${esc(s4.narration)}</textarea>
      </div>
      <div class="field">
        <label>字幕テキスト</label>
        <input type="text" id="sub-4" value="\${esc(s4.subtitle)}" oninput="if(currentTabIdx===4)updatePreview()">
      </div>
    </div>
  </div>\`;
}

// ─── フィールド変更時にプレビュー更新 ─────────────────────────────────────
let previewDebounce = null;
function onFieldChange() {
  clearTimeout(previewDebounce);
  previewDebounce = setTimeout(updatePreview, 400);
}

// ─── プレビュー更新 ────────────────────────────────────────────────────────
function updatePreview() {
  if (currentIdx < 0) return;
  syncCurrentPost();
  const post = contentData.posts[currentIdx];
  const imagePath = post._imagePath || "";
  const label     = val("label");
  const catchLine1 = val("catchLine1");
  const catchLine2 = val("catchLine2");

  const tabs = [
    { type:"title_card", params:{ catchLine1, catchLine2, imagePath, label } },
    { type:"content",    params:{ subtitle: val("sub-1"), badgeText:"ニュース",   imagePath } },
    { type:"content",    params:{ subtitle: val("sub-2"), badgeText:"豆知識",     imagePath } },
    { type:"content",    params:{ subtitle: val("sub-3"), badgeText:"衝撃の事実", imagePath } },
    { type:"cta",        params:{ subtitle: val("sub-4") } },
  ];

  const t = tabs[currentTabIdx];
  const params = new URLSearchParams({ type: t.type, ...t.params });
  document.getElementById("preview-iframe").src = "/api/preview?" + params;

  // タブのactive切替
  document.querySelectorAll(".preview-tab").forEach((el, i) => {
    el.classList.toggle("active", i === currentTabIdx);
  });
}

function switchTab(idx) {
  currentTabIdx = idx;
  updatePreview();
}

// ─── TTS 生成 ──────────────────────────────────────────────────────────────
async function generateTTS() {
  if (currentIdx < 0) return setStatus("投稿を選択してください", "err");
  const date = getDate();
  syncCurrentPost();
  const post = contentData.posts[currentIdx];
  setStatus("🎙️ ナレーション生成中（5本）...", "loading");
  document.querySelector(".btn-tts").disabled = true;

  try {
    const res = await fetch("/api/tts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date, postIdx: currentIdx, post }),
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error);

    let successCount = 0;
    j.results.forEach(r => {
      const key = currentIdx + "_" + r.index;
      ttsReady[key] = r.ok;
      if (r.ok) successCount++;
      const el = document.getElementById("tts-status-" + r.index);
      if (el) { el.textContent = r.ok ? "✅ 生成済み" : "❌ 失敗"; el.className = "tts-status " + (r.ok ? "ok" : ""); }
    });

    renderSidebar();
    const allOk = [0,1,2,3,4].every(i => ttsReady[currentIdx + "_" + i]);
    document.getElementById("btn-play").disabled = !allOk;
    setStatus("✅ ナレーション " + successCount + "/5 本生成完了", "ok");
  } catch (e) {
    setStatus("❌ " + e.message, "err");
  } finally {
    document.querySelector(".btn-tts").disabled = false;
  }
}

// ─── TTS ファイル存在確認 ─────────────────────────────────────────────────
async function checkTTSFiles() {
  const date = getDate();
  for (let i = 0; i < contentData.posts.length; i++) {
    const postNum = i + 1;
    let count = 0;
    for (let s = 0; s < 5; s++) {
      try {
        const r = await fetch("/narrations/" + date + "_" + postNum + "/narr_" + s + ".mp3", { method: "HEAD" });
        if (r.ok) { ttsReady[i + "_" + s] = true; count++; }
      } catch {}
    }
    if (count === 5) {
      document.getElementById("btn-play").disabled = false;
    }
  }
  renderSidebar();
}

// ─── プレビュープレイヤー ──────────────────────────────────────────────────
const SLIDE_DEFS = [
  { type: "title_card", label: "タイトル" },
  { type: "content",    label: "S1" },
  { type: "content",    label: "S2" },
  { type: "content",    label: "S3" },
  { type: "cta",        label: "CTA" },
];

function buildSlideUrl(slideIdx) {
  if (currentIdx < 0) return "about:blank";
  const post     = contentData.posts[currentIdx];
  const imagePath = post._imagePath || "";
  const def = SLIDE_DEFS[slideIdx];
  const subtitles = ["", val("sub-1"), val("sub-2"), val("sub-3"), val("sub-4")];
  const badges    = ["", "ニュース", "豆知識", "衝撃の事実", ""];
  const params = new URLSearchParams({
    type: def.type,
    catchLine1:  val("catchLine1"),
    catchLine2:  val("catchLine2"),
    label:       val("label"),
    subtitle:    subtitles[slideIdx] || "",
    badgeText:   badges[slideIdx]    || "",
    imagePath,
  });
  return "/api/preview?" + params;
}

function openPlayer() {
  if (currentIdx < 0) return;
  const allOk = [0,1,2,3,4].every(i => ttsReady[currentIdx + "_" + i]);
  if (!allOk) return setStatus("先にナレーションを生成してください", "err");
  playerStopFlag = false;
  playerPaused   = false;
  document.getElementById("player-modal").classList.add("open");
  renderPlayerDots(-1);
  startPlayer();
}

function closePlayer() {
  playerStopFlag = true;
  const audio = document.getElementById("narr-audio");
  audio.pause();
  audio.src = "";
  document.getElementById("player-modal").classList.remove("open");
}

function renderPlayerDots(current) {
  document.getElementById("player-dots").innerHTML = SLIDE_DEFS.map((s,i) =>
    '<div class="player-dot ' + (i < current ? "done" : i === current ? "active" : "") + '" title="' + s.label + '"></div>'
  ).join("");
}

// ナレーションテキストを前半/後半チャンクに分割（日本語句読点基準）
function splitSubtitleChunks(text) {
  if (!text || text.length < 8) return text ? [text] : [];
  const puncts = ['。', '！', '？', '…'];
  const mid = Math.floor(text.length / 2);
  let best = -1, bestDist = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (puncts.includes(text[i])) {
      const dist = Math.abs(i + 1 - mid);
      if (dist < bestDist) { bestDist = dist; best = i + 1; }
    }
  }
  if (best < 2 || best >= text.length - 2) return [text];
  return [text.slice(0, best).trim(), text.slice(best).trim()].filter(c => c);
}

// contentスライドのiframeに字幕を送信
function sendSubtitle(iframe, text) {
  try { iframe.contentWindow.postMessage({ type: 'subtitle', text: text || '' }, '*'); } catch(_) {}
}

async function startPlayer() {
  const date    = getDate();
  const postNum = currentIdx + 1;
  const audio   = document.getElementById("narr-audio");
  const post    = contentData.posts[currentIdx];

  // ナレーションテキスト配列（スライド順: 0=タイトル, 1-3=content, 4=CTA）
  const narrTexts = [
    "",
    post.slide1?.narration || "",
    post.slide2?.narration || "",
    post.slide3?.narration || "",
    post.slide4?.narration || "",
  ];

  for (let i = 0; i < SLIDE_DEFS.length; i++) {
    if (playerStopFlag) break;

    // スライド表示
    const playerIframe = document.getElementById("player-iframe");
    playerIframe.src = buildSlideUrl(i);
    renderPlayerDots(i);
    document.getElementById("player-info").textContent = SLIDE_DEFS[i].label + "（" + (i+1) + " / " + SLIDE_DEFS.length + "）";

    // iframeロード待機
    await new Promise(r => { playerIframe.onload = r; setTimeout(r, 800); });

    // 音声再生
    const audioUrl = "/narrations/" + date + "_" + postNum + "/narr_" + i + ".mp3?t=" + Date.now();
    audio.src = audioUrl;
    audio.playbackRate = 1.0;

    // contentスライドの字幕チャンク設定
    const chunks = SLIDE_DEFS[i].type === 'content' ? splitSubtitleChunks(narrTexts[i]) : [];
    let lastChunk = -1;
    audio.ontimeupdate = null;
    if (chunks.length > 0) {
      audio.ontimeupdate = () => {
        if (!audio.duration) return;
        const ratio = audio.currentTime / audio.duration;
        // 各チャンクは等分（0→前半, 0.5→後半, 0.9→消去）
        let chunkIdx = Math.min(Math.floor(ratio / (1 / chunks.length)), chunks.length - 1);
        if (ratio >= 0.9) chunkIdx = chunks.length; // 終盤は消去
        if (chunkIdx === lastChunk) return;
        lastChunk = chunkIdx;
        if (chunkIdx < chunks.length) sendSubtitle(playerIframe, chunks[chunkIdx]);
        else sendSubtitle(playerIframe, '');
      };
    }

    try { await audio.play(); } catch {}

    // 音声終了まで待機（一時停止対応）
    await new Promise(resolve => {
      audio.onended = resolve;
      audio.onerror = resolve;
    });

    audio.ontimeupdate = null;
    sendSubtitle(playerIframe, '');

    if (playerStopFlag) break;
    // スライド間の短いポーズ
    await sleep(300);
  }

  if (!playerStopFlag) {
    document.getElementById("player-info").textContent = "✅ 再生完了";
    renderPlayerDots(SLIDE_DEFS.length);
  }
}

function togglePlayerPause() {
  const audio = document.getElementById("narr-audio");
  const btn   = document.getElementById("btn-pause");
  if (audio.paused) {
    audio.play();
    btn.textContent = "⏸ 一時停止";
    playerPaused = false;
  } else {
    audio.pause();
    btn.textContent = "▶ 再開";
    playerPaused = true;
  }
}

// ─── データ同期 ────────────────────────────────────────────────────────────
function syncCurrentPost() {
  if (currentIdx < 0) return;
  const post = contentData.posts[currentIdx];
  post.catchLine1 = val("catchLine1");
  post.catchLine2 = val("catchLine2");
  post.label      = val("label");
  [1,2,3].forEach(i => {
    if (!post["slide"+i]) post["slide"+i] = {};
    post["slide"+i].narration = val("narr-"+i);
    post["slide"+i].subtitle  = val("sub-"+i);
    post["slide"+i].emotion   = val("emo-"+i);
  });
  if (!post.slide4) post.slide4 = {};
  post.slide4.narration = val("narr-4");
  post.slide4.subtitle  = val("sub-4");
}

// ─── ユーティリティ ────────────────────────────────────────────────────────
function val(id) { return document.getElementById(id)?.value || ""; }
function getDate() { return document.getElementById("date-select").value; }
function onDateChange() {
  const date = getDate();
  const badge = document.getElementById("date-badge");
  if (!date) { badge.textContent = ""; return; }
  const sel = document.getElementById("date-select");
  const opt = sel.options[sel.selectedIndex];
  if (opt && opt.textContent.includes("✅")) {
    badge.textContent = "コンテンツあり";
    badge.className = "date-badge has-content";
  } else {
    badge.textContent = "未生成";
    badge.className = "date-badge no-content";
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function setStatus(msg, cls="") {
  const el = document.getElementById("status-bar");
  el.textContent = msg; el.className = cls;
}

window.addEventListener("beforeunload", syncCurrentPost);
</script>
</body></html>`);
});

// ─── サーバー起動 ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬 Shorts 制作ランチャー起動`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`\n📝 使い方:`);
  console.log(`   1. 日付を選択 → 「読み込み」または「Claude生成」`);
  console.log(`   2. キャッチコピー・ナレーション・字幕を編集`);
  console.log(`   3. 「ナレーション生成」で音声を作成`);
  console.log(`   4. 「▶ プレビュー再生」で仕上がりを確認`);
  console.log(`   5. 「動画生成リクエスト」で GHA に動画生成を依頼\n`);
  if (!process.env.OPENAI_API_KEY) console.warn(`   ⚠️  OPENAI_API_KEY が未設定です`);
  if (!process.env.GITHUB_TOKEN)   console.warn(`   ⚠️  GITHUB_TOKEN が未設定です`);
});
