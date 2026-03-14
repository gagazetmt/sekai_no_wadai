// 投稿サーバー（X自動投稿 + YouTube Shortsランチャー）
// 使い方: node post_server.js
// → http://localhost:3000/launcher （X投稿）
// → http://localhost:3000/youtube  （YouTube Shortsアップロード）

require("dotenv").config();
const express = require("express");
const { TwitterApi } = require("twitter-api-v2");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "posts")));
app.use("/images",     express.static(path.join(__dirname, "images")));
app.use("/shorts",     express.static(path.join(__dirname, "shorts")));

const xClient = new TwitterApi({
  appKey:        process.env.X_API_KEY,
  appSecret:     process.env.X_API_SECRET,
  accessToken:   process.env.X_ACCESS_TOKEN,
  accessSecret:  process.env.X_ACCESS_TOKEN_SECRET,
});

// 予約済みタスク管理
const scheduledJobs = {};

// ── 予約投稿API ─────────────────────────────────────────────────────────
app.post("/api/schedule", async (req, res) => {
  const { postNum, text, scheduleTime, sourceUrl, thumbPath } = req.body;

  // 予約時刻を計算
  const now = new Date();
  const [hours, minutes] = scheduleTime.split(":").map(Number);
  const scheduledDate = new Date();
  scheduledDate.setHours(hours, minutes, 0, 0);

  // 既に過ぎている時刻なら翌日にセット
  if (scheduledDate <= now) {
    scheduledDate.setDate(scheduledDate.getDate() + 1);
  }

  const msUntil = scheduledDate - now;
  const scheduledStr = scheduledDate.toLocaleString("ja-JP");

  console.log(`📅 投稿${postNum} を ${scheduledStr} に予約しました（${Math.round(msUntil/1000/60)}分後）`);

  // 既存の予約があればキャンセル
  if (scheduledJobs[postNum]) {
    clearTimeout(scheduledJobs[postNum]);
  }

  // タイムアウトで予約
  scheduledJobs[postNum] = setTimeout(async () => {
    try {
      let tweetParams = { text };

      // サムネイル画像があればアップロード
      if (thumbPath && fs.existsSync(thumbPath)) {
        try {
          const mediaId = await xClient.v1.uploadMedia(thumbPath);
          tweetParams.media = { media_ids: [mediaId] };
          console.log(`🖼️  投稿${postNum} 画像アップロード完了`);
        } catch (mediaErr) {
          console.log(`⚠️  投稿${postNum} 画像アップロード失敗（テキストのみで投稿）: ${mediaErr.message}`);
        }
      }

      // ツイート投稿
      const tweet = await xClient.v2.tweet(tweetParams);
      const tweetId = tweet.data.id;
      console.log(`✅ 投稿${postNum} 送信完了 (ID: ${tweetId})`);

      // リプ欄に元ネタURL
      if (sourceUrl) {
        await xClient.v2.reply(sourceUrl, tweetId);
        console.log(`💬 投稿${postNum} リプ送信完了`);
      }

      delete scheduledJobs[postNum];
    } catch (e) {
      console.error(`❌ 投稿${postNum} エラー:`, e.message);
    }
  }, msUntil);

  res.json({ success: true, scheduledAt: scheduledStr, msUntil });
});

// ── 予約キャンセルAPI ───────────────────────────────────────────────────
app.post("/api/cancel", (req, res) => {
  const { postNum } = req.body;
  if (scheduledJobs[postNum]) {
    clearTimeout(scheduledJobs[postNum]);
    delete scheduledJobs[postNum];
    console.log(`🚫 投稿${postNum} 予約キャンセル`);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: "予約が見つかりません" });
  }
});

// ── 予約状況確認API ─────────────────────────────────────────────────────
app.get("/api/status", (req, res) => {
  res.json({ scheduled: Object.keys(scheduledJobs).map(Number) });
});

// ── シャットダウンAPI ────────────────────────────────────────────────────
app.post("/api/shutdown", (req, res) => {
  res.json({ success: true });
  console.log("\n🛑 ランチャーから終了シグナルを受信。サーバーを停止します...");
  setTimeout(() => process.exit(0), 500);
});

// ── YouTube Shortsランチャー ──────────────────────────────────────────────
function buildYouTubeLauncherHtml(today, shorts) {
  const cards = shorts.map(({ num, videoPath, thumbPath, title, description, tags, exists }) => {
    const thumbImg = exists.thumb
      ? `<img src="/${thumbPath}" alt="サムネ">`
      : `<div class="no-thumb">サムネなし</div>`;
    const videoNote = exists.video
      ? `<span class="file-ok">✅ ${videoPath}</span>`
      : `<span class="file-ng">❌ 動画ファイルが見つかりません: ${videoPath}</span>`;

    const escTitle = title.replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const escDesc  = description.replace(/`/g, "\\`").replace(/\$/g, "\\$");
    const escTags  = tags.replace(/`/g, "\\`").replace(/\$/g, "\\$");

    return `
    <div class="card" id="yt-card-${num}">
      <div class="card-header">
        <span class="post-num">Short ${num}</span>
        <span class="file-path">${videoNote}</span>
        <span class="yt-status-badge" id="yt-status-${num}">未アップロード</span>
      </div>
      <div class="card-body">
        <div class="thumb-box">${thumbImg}</div>
        <div class="content">

          <div class="field-label">📌 タイトル <small>（コピーしてYouTubeに貼り付け）</small></div>
          <div class="field-row">
            <textarea class="field-input" id="title-${num}" rows="2">${title}</textarea>
            <button class="btn-copy" onclick="copyField('title-${num}', this)">📋 コピー</button>
          </div>

          <div class="field-label">📝 説明文</div>
          <div class="field-row">
            <textarea class="field-input desc" id="desc-${num}" rows="6">${description}</textarea>
            <button class="btn-copy" onclick="copyField('desc-${num}', this)">📋 コピー</button>
          </div>

          <div class="field-label">🏷️ タグ</div>
          <div class="field-row">
            <textarea class="field-input" id="tags-${num}" rows="2">${tags}</textarea>
            <button class="btn-copy" onclick="copyField('tags-${num}', this)">📋 コピー</button>
          </div>

          <div class="btn-row">
            <a href="https://studio.youtube.com/channel/upload" target="_blank" class="btn-yt">▶ YouTube Studio でアップロード</a>
            <button class="btn-done" onclick="markDone(${num})">✅ アップロード済みにする</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>YouTube Shorts アップロードランチャー ${today}</title>
  <style>
    body { font-family: sans-serif; background: #f8f0f0; margin: 0; padding: 20px; }
    h1 { color: #ff0000; font-size: 1.3em; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 0.9em; margin-bottom: 24px; }
    .nav { display: flex; gap: 12px; margin-bottom: 20px; }
    .nav a { padding: 8px 20px; border-radius: 20px; text-decoration: none; font-weight: bold; font-size: 0.9em; }
    .nav .active { background: #ff0000; color: #fff; }
    .nav .inactive { background: #1da1f2; color: #fff; }
    .steps { background: #fff3f3; border: 1px solid #ff9999; border-radius: 8px; padding: 14px 18px; margin-bottom: 24px; font-size: 0.9em; line-height: 1.9; }
    .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
    .card.done { border: 2px solid #27ae60; opacity: 0.7; }
    .card-header { background: #ff0000; color: #fff; padding: 10px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .post-num { font-weight: bold; font-size: 1.1em; }
    .file-path { font-size: 0.82em; flex: 1; }
    .file-ok { color: #aaffaa; }
    .file-ng { color: #ffcccc; }
    .yt-status-badge { background: rgba(0,0,0,0.25); color: #fff; font-size: 0.8em; font-weight: bold; padding: 3px 10px; border-radius: 12px; }
    .yt-status-badge.done { background: #27ae60; }
    .card-body { display: flex; gap: 16px; padding: 16px; }
    .thumb-box { flex: 0 0 180px; }
    .thumb-box img { width: 180px; height: 320px; object-fit: cover; border-radius: 8px; border: 1px solid #eee; }
    .no-thumb { width: 180px; height: 320px; background: #1a1a2e; color: #fff; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 0.85em; }
    .content { flex: 1; display: flex; flex-direction: column; gap: 10px; }
    .field-label { font-size: 0.85em; font-weight: bold; color: #444; }
    .field-row { display: flex; gap: 8px; align-items: flex-start; }
    .field-input { flex: 1; padding: 8px 10px; border: 2px solid #e0e0e0; border-radius: 6px; font-size: 0.88em; line-height: 1.6; font-family: sans-serif; resize: vertical; box-sizing: border-box; }
    .field-input:focus { outline: none; border-color: #ff0000; }
    .field-input.desc { font-size: 0.82em; }
    .btn-copy { background: #ff0000; color: #fff; border: none; padding: 8px 14px; border-radius: 8px; font-weight: bold; font-size: 0.85em; cursor: pointer; white-space: nowrap; }
    .btn-copy.copied { background: #27ae60; }
    .btn-row { display: flex; gap: 10px; margin-top: 6px; flex-wrap: wrap; }
    .btn-yt { background: #ff0000; color: #fff; padding: 10px 20px; border-radius: 24px; text-decoration: none; font-weight: bold; font-size: 0.95em; }
    .btn-yt:hover { background: #cc0000; }
    .btn-done { background: #27ae60; color: #fff; border: none; padding: 10px 20px; border-radius: 24px; font-weight: bold; font-size: 0.95em; cursor: pointer; }
    .btn-done:hover { background: #1e8449; }
  </style>
  <script>
    function copyField(id, btn) {
      const val = document.getElementById(id).value;
      navigator.clipboard.writeText(val).then(() => {
        btn.textContent = "✅ コピー済み";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "📋 コピー"; btn.classList.remove("copied"); }, 2000);
      });
    }
    function markDone(num) {
      const card = document.getElementById('yt-card-' + num);
      const badge = document.getElementById('yt-status-' + num);
      card.classList.add('done');
      badge.textContent = 'アップロード済み ✓';
      badge.classList.add('done');
    }
  </script>
</head>
<body>
  <h1>YouTube Shorts アップロードランチャー</h1>
  <div class="subtitle">${today} ／ 全${shorts.length}件</div>
  <div class="nav">
    <a href="/launcher" class="inactive">𝕏 X投稿ランチャー</a>
    <a href="/youtube" class="active">▶ YouTube Shortsランチャー</a>
  </div>
  <div class="steps">
    <strong>🎬 YouTube Shortsアップロード手順</strong><br>
    ① 「▶ YouTube Studio でアップロード」ボタンをクリック<br>
    ② ファイル選択 → <code>shorts/</code> フォルダから <code>${today}_N.mp4</code> を選択<br>
    ③ タイトル・説明文・タグを各「📋 コピー」ボタンでコピーして貼り付け<br>
    ④ サムネイルは <code>shorts/${today}_N_thumb.png</code> をアップロード<br>
    ⑤ 公開設定 → 「公開」または予約投稿 → 完了後「✅ アップロード済みにする」を押す
  </div>
  ${cards}
</body>
</html>`;
}

app.get("/youtube", (req, res) => {
  const TEMP_DIR   = path.join(__dirname, "temp");
  const SHORTS_DIR = path.join(__dirname, "shorts");

  // 日付を決定（クエリ or 最新ファイル自動検出）
  let today = req.query.date;
  if (!today) {
    const files = fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith("shorts_content_") && f.endsWith(".json"))
      .sort().reverse();
    if (files.length === 0) {
      return res.send("<h2>shorts_content_*.json が見つかりません。generate_shorts.js を先に実行してください。</h2>");
    }
    today = files[0].replace("shorts_content_", "").replace(".json", "");
  }

  const contentPath = path.join(TEMP_DIR, `shorts_content_${today}.json`);
  if (!fs.existsSync(contentPath)) {
    return res.send(`<h2>ファイルが見つかりません: ${contentPath}</h2>`);
  }

  const { posts: contentPosts } = JSON.parse(fs.readFileSync(contentPath, "utf8"));

  const shorts = contentPosts.map((content, idx) => {
    const num       = idx + 1;
    const videoPath = `shorts/${today}_${num}.mp4`;
    const thumbPath = `shorts/${today}_${num}_thumb.png`;

    const title = `【衝撃】${content.catchLine1} ${content.catchLine2} #shorts`;

    const description = [
      `【衝撃】${content.catchLine1} ${content.catchLine2}`,
      "",
      content.slide1.narration,
      content.slide2.narration,
      content.slide3.narration,
      "",
      "━━━━━━━━━━━━━━━━━━━━━━",
      "チャンネル登録お願いします👇",
      "https://www.youtube.com/@sekai_no_wadai",
      "",
      "#世界の話題 #海外反応 #shorts #バズニュース #海外ニュース #驚き #viral",
    ].join("\n");

    const tags = "世界の話題,海外反応,海外ニュース,shorts,バズニュース,ニュース,驚き,viral,衝撃,海外の反応";

    return {
      num, videoPath, thumbPath, title, description, tags,
      exists: {
        video: fs.existsSync(path.join(__dirname, videoPath)),
        thumb: fs.existsSync(path.join(__dirname, thumbPath)),
      },
    };
  });

  res.send(buildYouTubeLauncherHtml(today, shorts));
});

// ── ランチャーHTMLを最新ファイルにリダイレクト ──────────────────────────
app.get("/launcher", (req, res) => {
  const postsDir = path.join(__dirname, "posts");
  const htmlFiles = fs.readdirSync(postsDir)
    .filter(f => f.endsWith(".html"))
    .sort()
    .reverse();
  if (htmlFiles.length === 0) {
    return res.send("HTMLファイルが見つかりません。generate_post.js を先に実行してください。");
  }
  res.redirect(`/${htmlFiles[0]}`);
});

const PORT = 3000;
const server = app.listen(PORT, () => {
  console.log(`\n🚀 投稿サーバー起動！`);
  console.log(`📋 ランチャーを開く: http://localhost:3000/launcher\n`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ ポート${PORT}は既に使用中です。`);
    console.error(`   別のサーバーが起動しているか確認してください。`);
    console.error(`   解決: タスクマネージャーでnodeプロセスを終了してから再起動\n`);
  } else {
    console.error(`\n❌ サーバーエラー: ${err.message}\n`);
  }
  process.exit(1);
});
