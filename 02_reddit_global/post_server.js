// 投稿サーバー（X自動投稿 + YouTube Shortsランチャー）
// 使い方: node post_server.js
// → http://localhost:3000/launcher （X投稿）
// → http://localhost:3000/youtube  （YouTube Shortsアップロード）

require("dotenv").config();
const express = require("express");
const { TwitterApi } = require("twitter-api-v2");
const Anthropic = require("@anthropic-ai/sdk");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const REPO_ROOT = path.join(__dirname, "..");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ENGAGEMENT_TARGETS = [
  { cat: "海外・科学", id: "NazologyInfo",    name: "ナゾロジー",       hint: "科学ニュース。Redditネタと相性抜群" },
  { cat: "海外・科学", id: "karapaia",         name: "カラパイア",       hint: "不思議・生物・海外ネタ。ファン層が重なる" },
  { cat: "海外・科学", id: "GekiyakuHyouji",   name: "劇訳表示。",       hint: "海外の反応系の大手。翻訳のニュアンスが参考に" },
  { cat: "海外・科学", id: "labaq",             name: "らばQ",            hint: "世界の面白ニュース。フックの作り方が秀逸" },
  { cat: "海外・科学", id: "GizmodoJapan",      name: "ギズモード",       hint: "ガジェット・海外テック。質の高いフォロワーが多い" },
  { cat: "国内速報",   id: "livedoornews",      name: "ライブドア",       hint: "圧倒的な拡散力。リプライ欄が世論の縮図" },
  { cat: "国内速報",   id: "itm_nlab",          name: "ねとらぼ",         hint: "ネットの話題に特化。バズるタイトル案の宝庫" },
  { cat: "国内速報",   id: "modelpress",        name: "モデルプレス",     hint: "エンタメ系。女性層のインプ発掘に有効" },
  { cat: "国内速報",   id: "yahoonews_it",      name: "Yahoo!ニュースIT", hint: "信頼性重視の層にリーチ可能" },
  { cat: "国内速報",   id: "Oricon",            name: "オリコン",         hint: "エンタメ・流行。動画ネタとの相性良" },
  { cat: "個人",       id: "takizawareso",      name: "滝沢ガレソ",       hint: "ネット最大の拡散力。有益な補足が伸びる" },
  { cat: "個人",       id: "m0monari",          name: "桃なり",           hint: "ライフハック系。保存されやすい投稿の参考" },
  { cat: "個人",       id: "bozu_108",          name: "坊主",             hint: "ユーザー参加型。大喜利リプライが伸びやすい" },
  { cat: "個人",       id: "tweetsoku_jp",      name: "ツイ速",           hint: "5ch的な速報性が高い" },
  { cat: "個人",       id: "Trend_Word_Bot",    name: "トレンドワード",   hint: "今何が検索されているか一目でわかる" },
  { cat: "海外公式",   id: "cnn_co_jp",         name: "CNN Japan",        hint: "海外の公式情報。Redditソースの裏取りに" },
  { cat: "海外公式",   id: "bbcnewsjapan",      name: "BBC Japan",        hint: "深掘りした世界情勢。インテリ層へリーチ" },
  { cat: "海外公式",   id: "BusinessInsider",   name: "BI Japan",         hint: "働き方や経済。20〜40代に刺さる" },
  { cat: "海外公式",   id: "ForbesJAPAN",       name: "フォーブス",       hint: "成功体験・海外トレンド" },
  { cat: "海外公式",   id: "AFPBBNews",         name: "AFPBB",            hint: "視覚的に強い世界ニュース画像が多い" },
  { cat: "雑学",       id: "frontrowjp",        name: "フロントロウ",     hint: "海外セレブ・トレンド。SNS映えの極致" },
  { cat: "雑学",       id: "CourrierJapon",     name: "クーリエ",         hint: "海外メディア翻訳。強力な競合かつ参考" },
  { cat: "雑学",       id: "wired_jp",          name: "WIRED",            hint: "未来・テクノロジー。思考の深いフォロワーが多い" },
  { cat: "雑学",       id: "NationalGeoJP",     name: "ナショジオ",       hint: "圧倒的なビジュアル力。画像の使い方の勉強に" },
  { cat: "雑学",       id: "eureka_moment_j",   name: "エウレカ",         hint: "知的好奇心を刺激する雑学系" },
  { cat: "大手メディア", id: "YahooNewsTopics", name: "Yahoo!ニュース",   hint: "ニュース全般。リプライの初速が重要" },
  { cat: "大手メディア", id: "News_ABEMA",      name: "ABEMA NEWS",       hint: "若年層が多い。コメントがつきやすい" },
  { cat: "大手メディア", id: "nhk_news",        name: "NHK NEWS",         hint: "圧倒的フォロワー数。信頼性向上用" },
  { cat: "大手メディア", id: "Sankei_news",     name: "産経新聞",         hint: "政治・社会への関心が強い層" },
  { cat: "大手メディア", id: "mainichi",        name: "毎日新聞",         hint: "広く一般層へのリーチ" },
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "posts")));
app.use("/images",      express.static(path.join(__dirname, "images")));
app.use("/shorts",      express.static(path.join(__dirname, "shorts")));
app.use("/thumbnails",  express.static(path.join(__dirname, "thumbnails")));
app.use("/videos",      express.static(path.join(__dirname, "videos")));

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

  // 承認済みJSONに保存（GitHub Actions用）
  const today = new Date().toISOString().slice(0, 10);
  const approvedPath = path.join(__dirname, "temp", `approved_${today}.json`);
  let approved = { date: today, posts: [] };
  if (fs.existsSync(approvedPath)) {
    approved = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
  }
  const idx = approved.posts.findIndex(p => p.postNum === postNum);
  const entry = { postNum, scheduleTime, text, sourceUrl, thumbPath: thumbPath || null };
  if (idx >= 0) {
    approved.posts[idx] = entry;
  } else {
    approved.posts.push(entry);
  }
  approved.posts.sort((a, b) => a.postNum - b.postNum);
  fs.writeFileSync(approvedPath, JSON.stringify(approved, null, 2), "utf8");
  console.log(`💾 approved_${today}.json に保存 (投稿${postNum})`);

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
    // 承認済みJSONからも削除
    const today = new Date().toISOString().slice(0, 10);
    const approvedPath = path.join(__dirname, "temp", `approved_${today}.json`);
    if (fs.existsSync(approvedPath)) {
      const approved = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
      approved.posts = approved.posts.filter(p => p.postNum !== postNum);
      fs.writeFileSync(approvedPath, JSON.stringify(approved, null, 2), "utf8");
    }
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

// ── GitHub Push API ──────────────────────────────────────────────────────
app.post("/api/push-github", (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    execSync(
      `git -C "${REPO_ROOT}" add -A 02_reddit_global/temp/ && git -C "${REPO_ROOT}" commit -m "posts ${today}" && git -C "${REPO_ROOT}" push`,
      { stdio: "pipe" }
    );
    console.log(`✅ GitHub push 完了 (${today})`);
    res.json({ success: true });
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    // "nothing to commit" は正常
    if (msg.includes("nothing to commit")) {
      res.json({ success: true, message: "変更なし（既にpush済み）" });
    } else {
      console.error("❌ GitHub push 失敗:", msg);
      res.json({ success: false, message: msg });
    }
  }
});

// ── 承認済み投稿一覧 API ─────────────────────────────────────────────────
app.get("/api/approved-posts", (req, res) => {
  const TEMP_DIR = path.join(__dirname, "temp");
  let files = [];
  try {
    files = fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith("approved_") && f.endsWith(".json"))
      .sort().reverse();
  } catch {}
  const days = files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(TEMP_DIR, f), "utf8")); }
    catch { return null; }
  }).filter(Boolean);
  res.json({ success: true, days });
});

// ── 承認済み投稿削除 API ─────────────────────────────────────────────────
app.post("/api/delete-approved", (req, res) => {
  const { date, postNum } = req.body;
  const TEMP_DIR = path.join(__dirname, "temp");
  const filePath = path.join(TEMP_DIR, `approved_${date}.json`);
  if (!fs.existsSync(filePath)) return res.json({ success: false, message: "ファイルが見つかりません" });
  try {
    if (postNum == null) {
      fs.unlinkSync(filePath);
      console.log(`🗑️  approved_${date}.json を削除`);
    } else {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      data.posts = data.posts.filter(p => p.postNum !== postNum);
      if (data.posts.length === 0) {
        fs.unlinkSync(filePath);
        console.log(`🗑️  approved_${date}.json を削除（残り0件）`);
      } else {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
        console.log(`🗑️  approved_${date}.json から投稿${postNum}を削除`);
      }
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── Engagement: プロフィール + 最新ツイート取得 ──────────────────────────
app.post("/api/engagement/profile", async (req, res) => {
  const { username } = req.body;
  try {
    const userRes = await xClient.v2.userByUsername(username, {
      "user.fields": "public_metrics,description,profile_image_url",
    });
    if (!userRes.data) return res.json({ success: false, message: "ユーザーが見つかりません" });

    let tweets = [];
    try {
      const tweetsRes = await xClient.v2.userTimeline(userRes.data.id, {
        max_results: 5,
        "tweet.fields": "created_at,public_metrics",
      });
      tweets = tweetsRes.data?.data || [];
    } catch (te) {
      // ツイート取得失敗はプロフィールだけ返す（レートリミット等）
      console.warn(`⚠️ ツイート取得失敗 (@${username}): ${te.message}`);
    }

    res.json({ success: true, user: userRes.data, tweets });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── Engagement: Claudeリプライ提案 ─────────────────────────────────────
app.post("/api/engagement/suggest", async (req, res) => {
  const { tweetText, authorName } = req.body;
  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `Xの投稿に対してインプレッションが伸びやすいリプライを3パターン提案してください。

投稿者: @${authorName}
投稿内容: "${tweetText}"

条件:
- 各140文字以内
- 「海外反応まとめ」系アカウント（@sekai_no_wadai）として自然な口調
- アプローチ: 【共感 / 知的補足 / 驚き・問いかけ】の3パターンで
- 自己宣伝は絶対に入れない
- 純粋に価値あるコメントのみ

以下のJSON形式のみで返答（他のテキスト不要）:
{"replies":["パターン1テキスト","パターン2テキスト","パターン3テキスト"]}`
      }],
    });
    const raw = msg.content[0].text;
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
    res.json({ success: true, replies: json.replies });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── Engagement: リプライ送信 ────────────────────────────────────────────
app.post("/api/engagement/reply", async (req, res) => {
  const { text, tweetId } = req.body;
  try {
    const result = await xClient.v2.reply(text, tweetId);
    console.log(`💬 リプライ送信: "${text.slice(0, 30)}..." → tweetId:${tweetId}`);
    res.json({ success: true, id: result.data.id });
  } catch (e) {
    console.error("❌ リプライ送信失敗:", e.message);
    res.json({ success: false, message: e.message });
  }
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
    .nav .eng { background: #00897b; color: #fff; }
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
    <a href="/launcher" class="inactive">𝕏 X投稿</a>
    <a href="/youtube" class="active">▶ YouTube</a>
    <a href="/engagement" class="eng">🎯 交流</a>
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

// ── Engagement Command Center ─────────────────────────────────────────────
function buildEngagementHtml() {
  const catColors = {
    "海外・科学":   "#00897b",
    "国内速報":     "#e53935",
    "個人":         "#8e24aa",
    "海外公式":     "#1565c0",
    "雑学":         "#f4511e",
    "大手メディア": "#546e7a",
  };
  const targetsJson = JSON.stringify(ENGAGEMENT_TARGETS);
  const colorsJson  = JSON.stringify(catColors);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>Engagement Command Center</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0;}
    body{font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;background:#f0f2f5;height:100vh;display:flex;flex-direction:column;overflow:hidden;}
    .topbar{background:#fff;border-bottom:1px solid #e0e0e0;padding:10px 20px;display:flex;align-items:center;gap:16px;flex-shrink:0;}
    .topbar h1{font-size:1.1em;font-weight:900;color:#1da1f2;white-space:nowrap;}
    .topbar .sub{font-size:0.78em;color:#888;flex:1;}
    .nav{display:flex;gap:8px;}
    .nav a{padding:7px 16px;border-radius:20px;text-decoration:none;font-size:0.82em;font-weight:bold;}
    .nav .x{background:#000;color:#fff;}
    .nav .yt{background:#ff0000;color:#fff;}
    .nav .eng{background:#1da1f2;color:#fff;}
    .main{flex:1;display:flex;overflow:hidden;}
    /* 左カラム */
    .col-left{width:260px;background:#fff;border-right:1px solid #e0e0e0;display:flex;flex-direction:column;flex-shrink:0;overflow:hidden;}
    .col-left-head{padding:10px 14px 6px;font-size:0.88em;font-weight:bold;color:#555;background:#fafafa;border-bottom:1px solid #f0f0f0;flex-shrink:0;}
    .cat-filter{padding:8px 10px;display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #f0f0f0;flex-shrink:0;}
    .cat-btn{padding:3px 8px;border-radius:10px;border:1px solid #ddd;background:#fff;font-size:0.72em;cursor:pointer;color:#555;transition:all 0.15s;}
    .cat-btn.active{background:#1da1f2;color:#fff;border-color:#1da1f2;}
    .account-list{overflow-y:auto;flex:1;}
    .acc-card{padding:10px 12px;border-bottom:1px solid #f5f5f5;cursor:pointer;transition:background 0.12s;border-left:3px solid transparent;}
    .acc-card:hover{background:#f0f7ff;}
    .acc-card.selected{background:#e3f2fd;border-left-color:#1da1f2;}
    .acc-name{font-weight:bold;font-size:0.88em;color:#222;}
    .acc-id{font-size:0.76em;color:#1da1f2;}
    .acc-cat{display:inline-block;padding:1px 6px;border-radius:8px;font-size:0.68em;font-weight:bold;color:#fff;margin:3px 0 2px;}
    .acc-hint{font-size:0.73em;color:#888;line-height:1.4;}
    .btn-follow{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:10px;border:1px solid #1da1f2;color:#1da1f2;background:#fff;font-size:0.74em;cursor:pointer;text-decoration:none;transition:all 0.12s;}
    .btn-follow:hover{background:#1da1f2;color:#fff;}
    /* 中央カラム */
    .col-center{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
    .center-header{padding:14px 16px;background:#fff;border-bottom:1px solid #e0e0e0;flex-shrink:0;}
    .profile-box{display:flex;gap:12px;align-items:flex-start;}
    .profile-img{width:50px;height:50px;border-radius:50%;background:#dde;object-fit:cover;flex-shrink:0;}
    .pname{font-weight:900;font-size:0.95em;}
    .pid{color:#1da1f2;font-size:0.82em;}
    .pdesc{font-size:0.8em;color:#555;margin-top:3px;max-width:380px;line-height:1.4;}
    .profile-stats{display:flex;gap:14px;margin-top:6px;}
    .pstat{font-size:0.78em;color:#888;} .pstat span{font-weight:bold;color:#333;}
    .tweets-list{overflow-y:auto;flex:1;padding:10px 12px;}
    .tweet-card{background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:8px;cursor:pointer;border:2px solid transparent;transition:all 0.15s;box-shadow:0 1px 3px rgba(0,0,0,0.06);}
    .tweet-card:hover{border-color:#1da1f2;box-shadow:0 2px 8px rgba(29,161,242,0.15);}
    .tweet-card.selected{border-color:#1da1f2;background:#e8f4fd;}
    .tweet-text{font-size:0.86em;line-height:1.6;color:#222;white-space:pre-wrap;word-break:break-word;}
    .tweet-meta{display:flex;gap:14px;margin-top:8px;font-size:0.75em;color:#aaa;}
    .tweet-meta .like-c{color:#e0245e;} .tweet-meta .rt-c{color:#17bf63;}
    .tweet-actions{display:flex;gap:6px;margin-top:8px;}
    .btn-action{padding:3px 10px;border-radius:10px;border:1px solid #ddd;color:#555;background:#fff;font-size:0.74em;cursor:pointer;text-decoration:none;transition:all 0.12s;}
    .btn-action:hover{background:#f0f0f0;}
    .placeholder{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#ccc;font-size:0.95em;}
    /* 右カラム */
    .col-right{width:310px;background:#fff;border-left:1px solid #e0e0e0;display:flex;flex-direction:column;flex-shrink:0;overflow:hidden;}
    .col-right-head{padding:10px 14px;font-size:0.88em;font-weight:bold;color:#555;background:#fafafa;border-bottom:1px solid #f0f0f0;flex-shrink:0;}
    .reply-panel{flex:1;overflow-y:auto;padding:12px;}
    .reply-placeholder{color:#ccc;font-size:0.84em;text-align:center;padding:40px 10px;line-height:1.8;}
    .tweet-preview{background:#f0f7ff;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-size:0.78em;color:#555;border-left:3px solid #1da1f2;line-height:1.5;}
    .sug-box{margin-bottom:12px;}
    .sug-label{font-size:0.76em;font-weight:bold;color:#888;margin-bottom:4px;}
    .sug-ta{width:100%;padding:8px 10px;border:2px solid #e0e0e0;border-radius:8px;font-size:0.83em;line-height:1.5;resize:vertical;font-family:inherit;min-height:72px;transition:border-color 0.15s;}
    .sug-ta:focus{outline:none;border-color:#1da1f2;}
    .char-cnt{font-size:0.7em;color:#aaa;text-align:right;margin:2px 0 4px;}
    .char-cnt.over{color:#e53935;font-weight:bold;}
    .sug-btns{display:flex;gap:6px;}
    .btn-send{flex:1;background:#1da1f2;color:#fff;border:none;padding:6px 10px;border-radius:14px;font-size:0.8em;font-weight:bold;cursor:pointer;transition:background 0.15s;}
    .btn-send:hover{background:#0d8ecf;}
    .btn-send:disabled{background:#b0d9f0;cursor:not-allowed;}
    .btn-copy-s{padding:6px 10px;border-radius:14px;border:1px solid #1da1f2;color:#1da1f2;background:#fff;font-size:0.8em;cursor:pointer;}
    .loading{text-align:center;padding:20px;color:#1da1f2;font-size:0.85em;}
    .err-msg{background:#fff3f3;border:1px solid #ffaaaa;border-radius:8px;padding:8px 10px;font-size:0.8em;color:#c00;margin:6px 0;}
    /* 手動入力 */
    .manual-box{padding:16px;}
    .manual-hint{font-size:0.82em;color:#536471;background:#f0f7ff;border-radius:8px;padding:10px 12px;margin-bottom:14px;line-height:1.7;}
    .manual-hint a{color:#1da1f2;text-decoration:none;}
    .manual-hint a:hover{text-decoration:underline;}
    .manual-label{font-size:0.82em;font-weight:bold;color:#444;margin-bottom:4px;margin-top:12px;}
    .manual-input{width:100%;padding:8px 10px;border:2px solid #e0e0e0;border-radius:8px;font-size:0.84em;font-family:inherit;box-sizing:border-box;}
    .manual-input:focus{outline:none;border-color:#1da1f2;}
    .manual-ta{width:100%;padding:8px 10px;border:2px solid #e0e0e0;border-radius:8px;font-size:0.84em;line-height:1.5;resize:vertical;font-family:inherit;min-height:80px;box-sizing:border-box;}
    .manual-ta:focus{outline:none;border-color:#1da1f2;}
    .btn-generate{margin-top:12px;width:100%;background:#1da1f2;color:#fff;border:none;padding:10px;border-radius:10px;font-size:0.88em;font-weight:bold;cursor:pointer;transition:background 0.15s;}
    .btn-generate:hover{background:#0d8ecf;}
    .acc-profile-box{padding:16px;border-bottom:1px solid #f0f0f0;}
    .acc-profile-name{font-weight:900;font-size:1em;color:#222;}
    .acc-profile-id{color:#1da1f2;font-size:0.84em;margin:2px 0;}
    .acc-profile-hint{font-size:0.8em;color:#777;margin:4px 0 8px;line-height:1.5;}
    .btn-open-x{display:inline-block;padding:5px 14px;border-radius:14px;border:1.5px solid #1da1f2;color:#1da1f2;background:#fff;font-size:0.8em;font-weight:bold;text-decoration:none;transition:all 0.12s;}
    .btn-open-x:hover{background:#1da1f2;color:#fff;}
    .toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:9px 20px;border-radius:18px;font-size:0.86em;z-index:999;display:none;pointer-events:none;}
  </style>
</head>
<body>
<div class="topbar">
  <h1>🎯 Engagement Command Center</h1>
  <div class="sub">大手アカウントのツイートにリプライしてインプレを獲得</div>
  <nav class="nav">
    <a href="/launcher" class="x">𝕏 X投稿</a>
    <a href="/youtube" class="yt">▶ YouTube</a>
    <a href="/engagement" class="eng">🎯 交流</a>
  </nav>
</div>

<div class="main">
  <div class="col-left">
    <div class="col-left-head">🎯 ターゲット（30件）</div>
    <div class="cat-filter" id="catFilter"></div>
    <div class="account-list" id="accountList"></div>
  </div>

  <div class="col-center">
    <div class="center-header" id="centerHeader">
      <div style="color:#ccc;font-size:0.9em;">← 左のアカウントをクリックして最新ツイートを取得</div>
    </div>
    <div class="tweets-list" id="tweetsList"></div>
  </div>

  <div class="col-right">
    <div class="col-right-head">🤖 Claudeリプライ提案</div>
    <div class="reply-panel" id="replyPanel">
      <div class="reply-placeholder">中央のツイートをクリックすると<br>リプライ案を3パターン生成します</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const TARGETS = ${targetsJson};
const CAT_COLORS = ${colorsJson};
let currentCat = "すべて";
let selectedAccId = null;
let selectedTweetId = null;

const cats = ["すべて", ...new Set(TARGETS.map(t => t.cat))];
const catFilter = document.getElementById("catFilter");
cats.forEach(cat => {
  const btn = document.createElement("button");
  btn.className = "cat-btn" + (cat === "すべて" ? " active" : "");
  btn.textContent = cat === "すべて" ? "すべて" : cat;
  btn.onclick = () => {
    currentCat = cat;
    document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    renderList();
  };
  catFilter.appendChild(btn);
});

function renderList() {
  const filtered = currentCat === "すべて" ? TARGETS : TARGETS.filter(t => t.cat === currentCat);
  document.getElementById("accountList").innerHTML = filtered.map(t => {
    const color = CAT_COLORS[t.cat] || "#546e7a";
    const sel = selectedAccId === t.id ? " selected" : "";
    return '<div class="acc-card' + sel + '" data-id="' + t.id + '" onclick="selectAccount(this.dataset.id)">'
      + '<div class="acc-name">' + t.name + '</div>'
      + '<div class="acc-id">@' + t.id + '</div>'
      + '<span class="acc-cat" style="background:' + color + '">' + t.cat + '</span>'
      + '<div class="acc-hint">' + t.hint + '</div>'
      + '<a class="btn-follow" href="https://twitter.com/intent/follow?screen_name=' + t.id + '" target="_blank" onclick="event.stopPropagation()">＋ フォロー ↗</a>'
      + '</div>';
  }).join("");
}
renderList();

function selectAccount(id) {
  selectedAccId = id;
  selectedTweetId = null;
  renderList();

  const t = TARGETS.find(x => x.id === id);
  if (!t) return;
  const color = CAT_COLORS[t.cat] || "#546e7a";

  document.getElementById("centerHeader").innerHTML =
    '<div class="acc-profile-box">'
    + '<div class="acc-profile-name">' + t.name + '</div>'
    + '<div class="acc-profile-id">@' + id + '</div>'
    + '<span class="acc-cat" style="background:' + color + '">' + t.cat + '</span>'
    + '<div class="acc-profile-hint">' + t.hint + '</div>'
    + '<a class="btn-open-x" href="https://twitter.com/' + id + '" target="_blank">𝕏 タイムラインを開く ↗</a>'
    + '</div>';

  document.getElementById("tweetsList").innerHTML =
    '<div class="manual-box">'
    + '<div class="manual-hint">💡 <a href="https://twitter.com/' + id + '" target="_blank">@' + id + ' のタイムライン</a> を開き、リプライしたいツイートの<br>① URL と ② 本文をコピーして貼り付けてください</div>'
    + '<div class="manual-label">① ツイートURL <small style="color:#aaa;">（送信ボタンに必要）</small></div>'
    + '<input class="manual-input" id="tweetUrlInput" placeholder="https://twitter.com/.../status/12345..." />'
    + '<div class="manual-label">② ツイート本文 <small style="color:#aaa;">（Claudeがリプライを生成）</small></div>'
    + '<textarea class="manual-ta" id="tweetTextInput" placeholder="ここにツイートの本文を貼り付け..."></textarea>'
    + '<button class="btn-generate" onclick="generateReplies()">🤖 リプライ案を生成</button>'
    + '</div>';

  document.getElementById("replyPanel").innerHTML =
    '<div class="reply-placeholder">② 本文を貼り付けて<br>「リプライ案を生成」を押してください</div>';
}

async function generateReplies() {
  const tweetUrl  = (document.getElementById("tweetUrlInput")?.value || "").trim();
  const tweetText = (document.getElementById("tweetTextInput")?.value || "").trim();
  if (!tweetText) { showToast("❌ ツイート本文を入力してください"); return; }

  const urlMatch = tweetUrl.match(/status\\/(\d+)/);
  selectedTweetId = urlMatch ? urlMatch[1] : null;

  const prevEsc = tweetText.slice(0, 70).replace(/&/g,"&amp;").replace(/</g,"&lt;") + (tweetText.length > 70 ? "…" : "");
  document.getElementById("replyPanel").innerHTML =
    '<div class="tweet-preview">📌 ' + prevEsc + '</div>'
    + '<div class="loading">🤖 Claude がリプライ案を生成中…</div>';

  const res = await fetch("/api/engagement/suggest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tweetText, authorName: selectedAccId || "unknown" })
  });
  const data = await res.json();

  if (!data.success) {
    document.getElementById("replyPanel").innerHTML =
      '<div class="tweet-preview">📌 ' + prevEsc + '</div>'
      + '<div class="err-msg">❌ 生成失敗: ' + data.message + '</div>';
    return;
  }

  const labels = ["① 共感・補足", "② 驚き・問いかけ", "③ 別視点"];
  document.getElementById("replyPanel").innerHTML =
    '<div class="tweet-preview">📌 ' + prevEsc + '</div>'
    + data.replies.map((r, i) => {
      const rEsc = r.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
      const sendBtn = selectedTweetId
        ? '<button class="btn-send" id="send-' + i + '" data-idx="' + i + '" data-tweet="' + selectedTweetId + '" onclick="sendReply(+this.dataset.idx,this.dataset.tweet)">📤 送信</button>'
        : '<button class="btn-send" style="background:#b0d9f0;cursor:not-allowed;" disabled title="URLが必要">📤 URL未入力</button>';
      return '<div class="sug-box">'
        + '<div class="sug-label">' + (labels[i] || "パターン" + (i+1)) + '</div>'
        + '<textarea class="sug-ta" id="sug-' + i + '" oninput="updCnt(' + i + ')">' + rEsc + '</textarea>'
        + '<div class="char-cnt" id="cnt-' + i + '">' + r.length + ' / 140</div>'
        + '<div class="sug-btns">' + sendBtn
        + '<button class="btn-copy-s" onclick="copySug(' + i + ')">📋</button>'
        + '</div></div>';
    }).join("");
}

function updCnt(i) {
  const len = document.getElementById("sug-" + i).value.length;
  const el = document.getElementById("cnt-" + i);
  el.textContent = len + " / 140";
  el.className = "char-cnt" + (len > 140 ? " over" : "");
}

async function sendReply(i, tweetId) {
  const text = document.getElementById("sug-" + i).value.trim();
  if (!text) return;
  if (text.length > 140) { showToast("❌ 140文字を超えています"); return; }
  const btn = document.getElementById("send-" + i);
  btn.disabled = true; btn.textContent = "送信中…";
  const res = await fetch("/api/engagement/reply", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, tweetId })
  });
  const data = await res.json();
  if (data.success) {
    btn.textContent = "✅ 送信済み"; btn.style.background = "#27ae60";
    showToast("💬 リプライを送信しました！");
  } else {
    btn.disabled = false; btn.textContent = "📤 送信";
    showToast("❌ 送信失敗: " + data.message);
  }
}

function copySug(i) {
  navigator.clipboard.writeText(document.getElementById("sug-" + i).value)
    .then(() => showToast("📋 コピーしました！"));
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 2500);
}
</script>
</body>
</html>`;
}

app.get("/engagement", (req, res) => {
  res.send(buildEngagementHtml());
});

// ── 統合アプリ（タブ切り替え） ────────────────────────────────────────────
app.get("/app", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>投稿管理センター</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100vh; overflow: hidden; font-family: -apple-system, "Segoe UI", sans-serif; background: #f7f9f9; }
    .tab-bar {
      height: 46px; background: #fff; border-bottom: 2px solid #eff3f4;
      display: flex; align-items: stretch; padding: 0 16px; gap: 2px; flex-shrink: 0;
    }
    .tab-logo { display: flex; align-items: center; font-size: 1.15em; font-weight: 900; color: #0f1419; margin-right: 12px; user-select: none; }
    .tab {
      display: flex; align-items: center; gap: 6px; padding: 0 20px;
      font-size: 0.92em; font-weight: 700; color: #536471; cursor: pointer;
      border-bottom: 3px solid transparent; transition: all 0.15s; white-space: nowrap;
    }
    .tab:hover { color: #0f1419; background: #f7f9f9; }
    .tab.active { color: #1d9bf0; border-bottom-color: #1d9bf0; }
    .frames { height: calc(100vh - 46px); }
    .frame-wrap { display: none; height: 100%; }
    .frame-wrap.active { display: block; }
    iframe { width: 100%; height: 100%; border: none; display: block; }
    .loading-msg { display: flex; align-items: center; justify-content: center; height: 100%; color: #aaa; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="tab-bar">
    <div class="tab-logo">🌍</div>
    <div class="tab active" data-tab="x" onclick="switchTab('x')">𝕏 X投稿</div>
    <div class="tab" data-tab="eng" onclick="switchTab('eng')">🎯 交流</div>
    <div class="tab" data-tab="yt" onclick="switchTab('yt')">▶ YouTube</div>
  </div>
  <div class="frames">
    <div class="frame-wrap active" id="tab-x">
      <iframe src="/launcher" id="frame-x"></iframe>
    </div>
    <div class="frame-wrap" id="tab-eng">
      <div class="loading-msg" id="loading-eng">読み込み中...</div>
      <iframe id="frame-eng" style="display:none"></iframe>
    </div>
    <div class="frame-wrap" id="tab-yt">
      <div class="loading-msg" id="loading-yt">読み込み中...</div>
      <iframe id="frame-yt" style="display:none"></iframe>
    </div>
  </div>
  <script>
    const SRCS = { x: null, eng: "/engagement", yt: "/youtube" };
    function switchTab(name) {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".frame-wrap").forEach(f => f.classList.remove("active"));
      document.querySelector('.tab[data-tab="' + name + '"]').classList.add("active");
      document.getElementById("tab-" + name).classList.add("active");
      // 遅延ロード
      const frame = document.getElementById("frame-" + name);
      const loading = document.getElementById("loading-" + name);
      if (frame && !frame.src && SRCS[name]) {
        frame.src = SRCS[name];
        frame.style.display = "block";
        frame.onload = () => { if (loading) loading.style.display = "none"; };
      }
    }
  </script>
</body>
</html>`);
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
  console.log(`📋 X投稿ランチャー:  http://localhost:3000/launcher`);
  console.log(`▶  YouTubeランチャー: http://localhost:3000/youtube`);
  console.log(`🎯 交流センター:      http://localhost:3000/engagement\n`);
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
