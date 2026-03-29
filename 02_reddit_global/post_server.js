// 投稿サーバー（X自動投稿 + YouTube Shortsランチャー）
// 使い方: node post_server.js
// → http://localhost:3000/launcher （X投稿）
// → http://localhost:3000/youtube  （YouTube Shortsアップロード）

require("dotenv").config();
const express = require("express");
const { TwitterApi } = require("twitter-api-v2");
const Anthropic = require("@anthropic-ai/sdk");
const { execSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
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
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "posts")));
app.use("/images",      express.static(path.join(__dirname, "images")));
app.use("/shorts",        express.static(path.join(__dirname, "shorts")));
app.use("/shorts_slides", express.static(path.join(__dirname, "shorts_slides")));
app.use("/thumbnails",    express.static(path.join(__dirname, "thumbnails")));
app.use("/videos",        express.static(path.join(__dirname, "videos")));
app.use("/emotions",      express.static(path.join(__dirname, "assets", "emotions")));

const xClient = new TwitterApi({
  appKey:        process.env.X_API_KEY,
  appSecret:     process.env.X_API_SECRET,
  accessToken:   process.env.X_ACCESS_TOKEN,
  accessSecret:  process.env.X_ACCESS_TOKEN_SECRET,
});

// 予約済みタスク管理
const scheduledJobs = {};

// ネタ生成ジョブ管理
let generateJob = null;

// ── 投稿実行（スレッド対応） ──────────────────────────────────────────────
async function executePost({ postNum, tweets, sourceUrl, thumbPath }) {
  let lastTweetId = null;
  try {
    for (const [index, tweetText] of tweets.entries()) {
      let tweetParams = { text: tweetText };

      // 1ツイート目にのみメディアを添付
      if (index === 0 && thumbPath && fs.existsSync(thumbPath)) {
        try {
          const mediaId = await xClient.v1.uploadMedia(thumbPath);
          tweetParams.media = { media_ids: [mediaId] };
          console.log(`🖼️  投稿${postNum} 画像アップロード完了`);
        } catch (mediaErr) {
          console.log(`⚠️  投稿${postNum} 画像アップロード失敗（テキストのみで投稿）: ${mediaErr.message}`);
        }
      }

      let tweet;
      if (lastTweetId) {
        tweet = await xClient.v2.reply(tweetText, lastTweetId);
      } else {
        tweet = await xClient.v2.tweet(tweetParams);
      }
      lastTweetId = tweet.data.id;
      console.log(`✅ 投稿${postNum} ツイート${index + 1}/${tweets.length} 完了 (ID: ${lastTweetId})`);

      // レート制限対策（最後のツイート以外は1秒待機）
      if (index < tweets.length - 1) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // 最終リプライにソースURL
    if (sourceUrl && lastTweetId) {
      await xClient.v2.reply(sourceUrl, lastTweetId);
      console.log(`💬 投稿${postNum} ソースURL リプ完了`);
    }
    delete scheduledJobs[postNum];
  } catch (e) {
    console.error(`❌ 投稿${postNum} エラー:`, e.message);
    // エラーが発生しても既に投稿済みのツイートは維持される
  }
}

// ── 予約をセット（再利用可能） ────────────────────────────────────────────
function scheduleJob({ postNum, tweets, sourceUrl, thumbPath, scheduleDate, scheduleTime }) {
  const now = new Date();
  const [hours, minutes] = scheduleTime.split(":").map(Number);
  let scheduledDate;
  if (scheduleDate) {
    // 明示的に日付が指定されている場合はその日付のJST時刻をUTCに変換
    scheduledDate = new Date(`${scheduleDate}T${scheduleTime}:00+09:00`);
  } else {
    scheduledDate = new Date();
    scheduledDate.setHours(hours, minutes, 0, 0);
    if (scheduledDate <= now) scheduledDate.setDate(scheduledDate.getDate() + 1);
  }
  const msUntil = scheduledDate - now;
  if (scheduledJobs[postNum]) clearTimeout(scheduledJobs[postNum]);
  scheduledJobs[postNum] = setTimeout(() => executePost({ postNum, tweets, sourceUrl, thumbPath }), msUntil);
  return { scheduledAt: scheduledDate.toLocaleString("ja-JP"), msUntil };
}

// ── 予約投稿API ─────────────────────────────────────────────────────────
app.post("/api/schedule", async (req, res) => {
  const { postNum, tweets, scheduleTime, scheduleDate, sourceUrl, thumbPath, videoPath, replyImages, galleryImageUrls } = req.body;

  // 承認済みJSONに保存（scheduleDate指定があればその日付、なければJST今日）
  const targetDate = scheduleDate || new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const approvedPath = path.join(__dirname, "temp", `approved_${targetDate}.json`);
  let approved = { date: targetDate, posts: [] };
  if (fs.existsSync(approvedPath)) {
    approved = JSON.parse(fs.readFileSync(approvedPath, "utf8"));
  }
  const idx = approved.posts.findIndex(p => p.postNum === postNum);
  const entry = { postNum, scheduleTime, tweets, sourceUrl, thumbPath: thumbPath || null, videoPath: videoPath || null, replyImages: replyImages || null, galleryImageUrls: galleryImageUrls?.length ? galleryImageUrls : null };
  if (idx >= 0) {
    approved.posts[idx] = entry;
  } else {
    approved.posts.push(entry);
  }
  approved.posts.sort((a, b) => a.postNum - b.postNum);
  fs.writeFileSync(approvedPath, JSON.stringify(approved, null, 2), "utf8");
  console.log(`💾 approved_${targetDate}.json に保存 (投稿${postNum})`);

  const { scheduledAt, msUntil } = scheduleJob({ postNum, tweets, sourceUrl, thumbPath, scheduleDate: targetDate, scheduleTime });
  console.log(`📅 投稿${postNum} を ${scheduledAt} に予約しました（${Math.round(msUntil/1000/60)}分後）`);
  res.json({ success: true, scheduledAt, msUntil });
});

// ── リプライ画像アップロード API ──────────────────────────────────────────
app.post("/api/upload-reply-image", (req, res) => {
  const { postNum, tweetIdx, base64, filename } = req.body;
  if (!base64 || !filename) return res.json({ success: false, message: "パラメータ不足" });
  try {
    const ext = path.extname(filename).toLowerCase() || ".jpg";
    const safeName = `reply_${postNum}_${tweetIdx}_${Date.now()}${ext}`;
    const savePath = path.join(__dirname, "images", safeName);
    fs.writeFileSync(savePath, Buffer.from(base64, "base64"));
    res.json({ success: true, path: savePath });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── 予約キャンセルAPI ───────────────────────────────────────────────────
app.post("/api/cancel", (req, res) => {
  const { postNum } = req.body;
  if (scheduledJobs[postNum]) {
    clearTimeout(scheduledJobs[postNum]);
    delete scheduledJobs[postNum];
    // 承認済みJSONからも削除
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
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
// ── ネタ生成実行 API ──────────────────────────────────────────────────────
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

app.post("/api/push-github", (req, res) => {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // ① mainブランチへの投稿データpush
  try {
    // reply_* はファイルがない場合もあるため別途add（エラー無視）
    execSync(`git -C "${REPO_ROOT}" add -A 02_reddit_global/temp/ 02_reddit_global/thumbnails/`, { stdio: "pipe" });
    try { execSync(`git -C "${REPO_ROOT}" add 02_reddit_global/images/reply_*`, { stdio: "pipe" }); } catch (_) {}
    execSync(`git -C "${REPO_ROOT}" commit -m "posts ${today}" && git -C "${REPO_ROOT}" push`, { stdio: "pipe" });
    console.log(`✅ GitHub push 完了 (${today})`);
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    if (!msg.includes("nothing to commit")) {
      console.error("❌ GitHub push 失敗:", msg);
      return res.json({ success: false, message: msg });
    }
    console.log("変更なし（既にpush済み）");
  }

  // ② videosブランチへの動画push
  const srcVideosDir = path.join(__dirname, "videos");
  // 今日の承認済みJSONで参照されている動画ファイルも対象に含める（日付をまたぐ参照の混入防止）
  const approvedForToday = path.join(__dirname, "temp", `approved_${today}.json`);
  const referencedVideoFiles = new Set();
  if (fs.existsSync(approvedForToday)) {
    const approved = JSON.parse(fs.readFileSync(approvedForToday, "utf8"));
    for (const post of approved.posts) {
      if (post.videoPath) {
        referencedVideoFiles.add(post.videoPath.replace(/\\/g, "/").split("/").pop());
      }
    }
  }
  const videoFiles = fs.existsSync(srcVideosDir)
    ? fs.readdirSync(srcVideosDir).filter(f =>
        (f.startsWith(today) || referencedVideoFiles.has(f)) && f.endsWith(".mp4")
      )
    : [];

  if (videoFiles.length === 0) {
    console.log("🎬 今日の動画ファイルなし（動画pushスキップ）");
    return res.json({ success: true });
  }

  const worktreePath = path.join(os.tmpdir(), `vp_${Date.now()}`);
  try {
    // videosブランチの存在確認
    let branchExists = false;
    try {
      const lsResult = execSync(`git -C "${REPO_ROOT}" ls-remote --heads origin videos`, { stdio: "pipe" }).toString();
      branchExists = lsResult.includes("refs/heads/videos");
    } catch {}

    if (branchExists) {
      execSync(`git -C "${REPO_ROOT}" fetch origin videos`, { stdio: "pipe" });
      execSync(`git -C "${REPO_ROOT}" worktree add "${worktreePath}" videos`, { stdio: "pipe" });
    } else {
      execSync(`git -C "${REPO_ROOT}" worktree add --orphan -b videos "${worktreePath}"`, { stdio: "pipe" });
    }

    // 動画ファイルをコピー
    const destDir = path.join(worktreePath, "02_reddit_global", "videos");
    fs.mkdirSync(destDir, { recursive: true });
    videoFiles.forEach(f => {
      fs.copyFileSync(path.join(srcVideosDir, f), path.join(destDir, f));
    });

    // コミット＆プッシュ
    execSync(`git -C "${worktreePath}" add -A`, { stdio: "pipe" });
    try {
      execSync(`git -C "${worktreePath}" -c user.email="launcher@local" -c user.name="Launcher" commit -m "videos ${today}"`, { stdio: "pipe" });
    } catch (commitErr) {
      const commitMsg = commitErr.stderr ? commitErr.stderr.toString() : commitErr.message;
      if (commitMsg.includes("nothing to commit")) {
        console.log("🎬 動画は既にpush済み（変更なし）");
        return res.json({ success: true });
      }
      throw commitErr;
    }
    execSync(`git -C "${worktreePath}" push origin videos`, { stdio: "pipe" });
    console.log(`🎬 動画 ${videoFiles.length}件 を videos ブランチにpush完了`);

    res.json({ success: true, videosCount: videoFiles.length });
  } catch (e) {
    console.error("❌ 動画push失敗:", e.message);
    res.json({ success: true, videoWarning: e.message }); // メインpushは成功
  } finally {
    try {
      execSync(`git -C "${REPO_ROOT}" worktree remove "${worktreePath}" --force`, { stdio: "pipe" });
    } catch {}
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

// ── Engagement: TwitterAPI.io でツイート取得（v3） ────────────────────────
// GET https://api.twitterapi.io/twitter/tweet/advanced_search
//   query=from:{username}&queryType=Latest
// コスト: $0.15/1,000ツイート（10件取得 ≈ $0.0015 ≈ 0.2円）
app.post("/api/engagement/tweets", async (req, res) => {
  const { username, count = 10 } = req.body;
  const API_KEY = process.env.TWITTER_API_IO_KEY;

  if (!API_KEY) {
    return res.json({ success: false, fallback: true, message: "TWITTER_API_IO_KEY 未設定" });
  }

  try {
    const url = `https://api.twitterapi.io/twitter/tweet/advanced_search?` +
      `query=${encodeURIComponent(`from:${username} -is:reply`)}&queryType=Latest`;

    const r = await fetch(url, {
      headers: { "X-API-Key": API_KEY },
    });
    if (!r.ok) throw new Error(`TwitterAPI.io: ${r.status} ${await r.text()}`);

    const data = await r.json();
    const tweets = (data.tweets || []).slice(0, count).map(t => ({
      id:        t.id,
      text:      t.text,
      url:       t.url || `https://twitter.com/${username}/status/${t.id}`,
      createdAt: t.createdAt,
      likes:     t.likeCount    || 0,
      retweets:  t.retweetCount || 0,
      replies:   t.replyCount   || 0,
      views:     t.viewCount    || 0,
    }));

    console.log(`📡 @${username} のツイート ${tweets.length}件取得`);
    res.json({ success: true, tweets });
  } catch (e) {
    console.error(`❌ TwitterAPI.io 取得失敗: ${e.message}`);
    res.json({ success: false, message: e.message });
  }
});

// ── Engagement: プロフィール取得（旧：公式API / 互換性のため残す） ─────────
app.post("/api/engagement/profile", async (req, res) => {
  res.json({ success: false, message: "公式X APIのFree tierは廃止済みです。TwitterAPI.ioをご利用ください。" });
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

// ── Engagement: いいね ──────────────────────────────────────────────────
let _myUserId = null;
async function getMyUserId() {
  if (!_myUserId) {
    const me = await xClient.v2.me();
    _myUserId = me.data.id;
  }
  return _myUserId;
}

app.post("/api/engagement/like", async (req, res) => {
  const { tweetId } = req.body;
  try {
    const uid = await getMyUserId();
    await xClient.v2.like(uid, tweetId);
    console.log(`♥ いいね送信: tweetId:${tweetId}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ いいね失敗:", e.message);
    res.json({ success: false, message: e.message });
  }
});

// ── Engagement: フォロー中一覧 ──────────────────────────────────────────
app.get("/api/engagement/following", async (req, res) => {
  try {
    const uid = await getMyUserId();
    const result = await xClient.v2.following(uid, { max_results: 1000, "user.fields": ["username"] });
    const usernames = (result.data || []).map(u => u.username.toLowerCase());
    console.log(`👥 フォロー中: ${usernames.length}件取得`);
    res.json({ success: true, usernames });
  } catch (e) {
    console.error("❌ フォロー中取得失敗:", e.message);
    res.json({ success: false, message: e.message });
  }
});

// ── Engagement: リツイート ──────────────────────────────────────────────
app.post("/api/engagement/retweet", async (req, res) => {
  const { tweetId } = req.body;
  try {
    const uid = await getMyUserId();
    await xClient.v2.retweet(uid, tweetId);
    console.log(`🔁 RT送信: tweetId:${tweetId}`);
    res.json({ success: true });
  } catch (e) {
    console.error("❌ RT失敗:", e.message);
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
  // generated_*.json を優先（最新の投稿日付）、なければ shorts_content_*.json から取得
  let today = req.query.date;
  if (!today) {
    const genFiles = fs.existsSync(TEMP_DIR)
      ? fs.readdirSync(TEMP_DIR).filter(f => f.startsWith("generated_") && f.endsWith(".json")).sort().reverse()
      : [];
    const cFiles = fs.existsSync(TEMP_DIR)
      ? fs.readdirSync(TEMP_DIR).filter(f => f.startsWith("shorts_content_") && f.endsWith(".json")).sort().reverse()
      : [];
    const latestGen     = genFiles.length ? genFiles[0].replace("generated_", "").replace(".json", "") : "";
    const latestContent = cFiles.length  ? cFiles[0].replace("shorts_content_", "").replace(".json", "") : "";
    today = latestGen >= latestContent ? latestGen : latestContent;
    if (!today) {
      return res.send("<h2>コンテンツファイルが見つかりません。先にX投稿ランチャーでPushしてください。</h2>");
    }
  }

  const contentPath = path.join(TEMP_DIR, `shorts_content_${today}.json`);
  if (!fs.existsSync(contentPath)) {
    // shorts_content がない場合は Shorts ランチャーに誘導
    return res.redirect(`/shorts-launcher?date=${today}`);
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

// ── Shorts コンテンツ自動生成（Claude Haiku） ─────────────────────────────
async function generateShortsContentServer(genPosts, date) {
  const EMOTIONS = ["SURPRISE", "HAPPY", "THINK", "SHOCK", "SAD", "EXCITED"];
  const posts = [];
  for (const gp of genPosts) {
    const prompt = `以下の海外Redditネタを元に、YouTubeショート動画用のコンテンツを日本語で作成してください。

元ネタ:
タイトル: ${gp.title}
投稿文: ${gp.postText}

以下のJSON形式のみで返答してください（他のテキスト不要）:
{
  "catchLine1": "視聴者が思わず止まる1行目キャッチ（10〜16文字）",
  "catchLine2": "驚きを深める2行目キャッチ（10〜16文字）",
  "slide1": {
    "narration": "導入ナレーション（60〜80文字）。視聴者を引き込む衝撃の事実から始める",
    "subtitle": "スライド字幕1（改行可、1行12文字以内×2行）",
    "emotion": "SURPRISE"
  },
  "slide2": {
    "narration": "詳細説明ナレーション（60〜80文字）。なぜそうなるのか理由や背景を説明",
    "subtitle": "スライド字幕2（改行可、1行12文字以内×2行）",
    "emotion": "THINK"
  },
  "slide3": {
    "narration": "海外反応ナレーション（60〜80文字）。世界での反応や驚きを伝える",
    "subtitle": "スライド字幕3（改行可、1行12文字以内×2行）",
    "emotion": "SHOCK"
  },
  "slide4": {
    "narration": "締めナレーション（40〜60文字）。視聴者への問いかけまたは行動促進",
    "subtitle": "スライド字幕4（改行可、1行12文字以内×2行）"
  }
}

emotionは ${EMOTIONS.join(" / ")} のいずれかを使用。slide4はemission不要。`;

    try {
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }],
      });
      const raw = msg.content[0].text;
      const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
      posts.push(parsed);
      console.log(`✅ Shorts コンテンツ生成: ${parsed.catchLine1}`);
    } catch (e) {
      console.error(`❌ Shorts コンテンツ生成失敗:`, e.message);
      posts.push({
        catchLine1: gp.title.slice(0, 16),
        catchLine2: "詳細はこちら",
        slide1: { narration: gp.postText.slice(0, 80), subtitle: "詳細情報", emotion: "SURPRISE" },
        slide2: { narration: "海外でも話題になっています。", subtitle: "海外の反応", emotion: "THINK" },
        slide3: { narration: "世界中で注目を集めています。", subtitle: "世界が注目", emotion: "SHOCK" },
        slide4: { narration: "あなたはどう思いますか？", subtitle: "あなたは\nどう思う？" },
      });
    }
  }
  const content = { date, posts };
  const filePath = path.join(__dirname, "temp", `shorts_content_${date}.json`);
  fs.writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
  console.log(`💾 shorts_content_${date}.json を保存`);
  return content;
}

// ── Shorts コンテンツ取得API ─────────────────────────────────────────────
app.get("/api/shorts-content", async (req, res) => {
  let date = req.query.date;
  const TEMP_DIR = path.join(__dirname, "temp");
  if (!date) {
    const files = fs.existsSync(TEMP_DIR)
      ? fs.readdirSync(TEMP_DIR).filter(f => f.startsWith("generated_") && f.endsWith(".json")).sort().reverse()
      : [];
    if (!files.length) return res.json({ success: false, message: "generated_*.json が見つかりません。先にX投稿ランチャーでPushしてください。" });
    date = files[0].replace("generated_", "").replace(".json", "");
  }

  const contentPath = path.join(TEMP_DIR, `shorts_content_${date}.json`);
  const genPath = path.join(TEMP_DIR, `generated_${date}.json`);

  // generated JSON から画像WebPathを取得するヘルパー
  function getImageWebPaths(count) {
    if (!fs.existsSync(genPath)) return new Array(count).fill(null);
    try {
      const { posts: gp } = JSON.parse(fs.readFileSync(genPath, "utf8"));
      return gp.map(p => p.savedImagePath ? "/images/" + path.basename(p.savedImagePath) : null);
    } catch { return new Array(count).fill(null); }
  }

  if (fs.existsSync(contentPath)) {
    const content = JSON.parse(fs.readFileSync(contentPath, "utf8"));
    const slidesDir = path.join(__dirname, "shorts_slides");
    const slidesExists = (content.posts || []).map((_, i) =>
      fs.existsSync(path.join(slidesDir, `${date}_${i + 1}`))
    );
    const imageWebPaths = getImageWebPaths(content.posts.length);
    return res.json({ success: true, date, content, generated: false, slidesExists, imageWebPaths });
  }

  if (!fs.existsSync(genPath)) {
    return res.json({ success: false, message: `generated_${date}.json が見つかりません。先にX投稿ランチャーでPushしてください。` });
  }

  try {
    const { posts: genPosts } = JSON.parse(fs.readFileSync(genPath, "utf8"));
    console.log(`🤖 shorts_content_${date}.json を自動生成中 (${genPosts.length}件)...`);
    const content = await generateShortsContentServer(genPosts, date);
    const slidesDir = path.join(__dirname, "shorts_slides");
    const slidesExists = (content.posts || []).map((_, i) =>
      fs.existsSync(path.join(slidesDir, `${date}_${i + 1}`))
    );
    const imageWebPaths = getImageWebPaths(content.posts.length);
    res.json({ success: true, date, content, generated: true, slidesExists, imageWebPaths });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── Shorts コンテンツ保存API ─────────────────────────────────────────────
app.post("/api/shorts-content", (req, res) => {
  const { date, posts } = req.body;
  if (!date || !posts) return res.json({ success: false, message: "date, posts が必要です" });
  const filePath = path.join(__dirname, "temp", `shorts_content_${date}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify({ date, posts }, null, 2), "utf8");
    console.log(`💾 shorts_content_${date}.json を保存 (${posts.length}件)`);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

// ── Shorts GitHub Push API ───────────────────────────────────────────────
app.post("/api/push-shorts", (req, res) => {
  const { date } = req.body;
  if (!date) return res.json({ success: false, message: "date が必要です" });
  const filePath = `02_reddit_global/temp/shorts_content_${date}.json`;
  try {
    execSync(
      `git -C "${REPO_ROOT}" add "${filePath}" && git -C "${REPO_ROOT}" commit -m "shorts ${date}" && git -C "${REPO_ROOT}" push`,
      { stdio: "pipe" }
    );
    console.log(`✅ shorts_content_${date}.json を GitHub にpush完了`);
    res.json({ success: true });
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    if (msg.includes("nothing to commit")) {
      console.log("変更なし（既にpush済み）");
      return res.json({ success: true });
    }
    console.error("❌ push失敗:", msg);
    res.json({ success: false, message: msg });
  }
});

// ── Shorts ランチャーHTML ─────────────────────────────────────────────────
function buildShortsLauncherHtml() {
  const EMOTION_OPTIONS = ["SURPRISE", "HAPPY", "THINK", "SHOCK", "SAD", "EXCITED"];

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Shorts制作ランチャー</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; font-family: -apple-system, "Segoe UI", sans-serif; background: #0d0d1a; color: #e0e0e0; }
    .topbar { background: #1a1a2e; border-bottom: 1px solid #333; padding: 10px 20px; display: flex; align-items: center; gap: 16px; height: 48px; flex-shrink: 0; }
    .topbar h1 { font-size: 1.1em; font-weight: 900; color: #ff6b6b; white-space: nowrap; }
    .nav { display: flex; gap: 8px; margin-left: auto; }
    .nav a { padding: 6px 14px; border-radius: 16px; text-decoration: none; font-size: 0.82em; font-weight: bold; color: #999; border: 1px solid #333; }
    .nav a:hover { color: #fff; border-color: #666; }
    .nav a.active { background: #ff4444; color: #fff; border-color: #ff4444; }
    .toolbar { background: #16213e; padding: 10px 20px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #333; height: 52px; flex-shrink: 0; }
    .date-badge { background: #0f3460; color: #4fc3f7; padding: 5px 14px; border-radius: 12px; font-size: 0.9em; font-weight: bold; }
    .status-msg { font-size: 0.85em; color: #aaa; flex: 1; }
    .btn-push { background: linear-gradient(135deg, #ff4444, #ff6b6b); color: #fff; border: none; padding: 8px 20px; border-radius: 20px; font-size: 0.9em; font-weight: bold; cursor: pointer; }
    .btn-push:disabled { opacity: 0.5; cursor: not-allowed; }

    /* フルスクリーンスクロールコンテナ */
    .content { height: calc(100vh - 100px); overflow-y: scroll; scroll-snap-type: y mandatory; }
    .loading { text-align: center; padding: 60px 20px; color: #4fc3f7; font-size: 1.1em; }
    .loading .spinner { width: 40px; height: 40px; border: 3px solid #333; border-top-color: #4fc3f7; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-box { background: #2a1a1a; border: 1px solid #ff4444; border-radius: 8px; padding: 20px; color: #ff8888; text-align: center; }

    /* 1件=画面全体 */
    .post-card { height: calc(100vh - 100px); scroll-snap-align: start; display: flex; flex-direction: column; background: #16213e; border-bottom: 3px solid #0d0d1a; overflow: hidden; }
    .post-header { background: linear-gradient(135deg, #1a1a2e, #0f3460); padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-shrink: 0; height: 52px; }
    .post-num { background: #ff4444; color: #fff; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 0.9em; flex-shrink: 0; }
    .catch-row { display: flex; gap: 8px; flex: 1; }
    .catch-input { flex: 1; background: #0d1b3e; border: 1px solid #3a4a6e; border-radius: 8px; padding: 6px 10px; color: #fff; font-size: 0.9em; font-weight: bold; }
    .catch-input:focus { outline: none; border-color: #4fc3f7; }
    .catch-label { font-size: 0.72em; color: #4fc3f7; align-self: center; white-space: nowrap; }

    /* スライドグリッド（横並び・スクロール可） */
    .slides-grid { display: flex; gap: 8px; padding: 8px 10px; flex: 1; min-height: 0; overflow-x: auto; }
    .slide-card { flex: 1; min-width: 0; background: #0d1b3e; border: 1px solid #2a3a5e; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; }

    /* スライドトップ（アニメプレビュー＋感情img横並び） */
    .slide-top { display: flex; gap: 5px; padding: 6px; flex-shrink: 0; align-items: flex-start; flex: 1; min-height: 0; overflow: hidden; }

    /* CSSアニメプレビュー（実際の動画レイアウト再現: 上段黒/中段画像/下段黒） */
    .slide-anim-wrap { position: relative; flex-shrink: 0; aspect-ratio: 9/16; height: calc(100vh - 410px); border-radius: 8px; overflow: hidden; cursor: pointer; background: #0a0a0a; display: flex; flex-direction: column; }
    /* 上段：バッジ＋キャッチライン */
    .anim-top { flex: 0 0 30%; background: #0a0a0a; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 6px 8px; gap: 4px; }
    .anim-badge { background: #dd0000; color: #fff; font-size: 0.62em; font-weight: 900; padding: 2px 8px; border-radius: 3px; letter-spacing: 0.03em; flex-shrink: 0; }
    .anim-line1 { font-size: 0.78em; font-weight: 900; color: #ffe066; text-align: center; opacity: 0; line-height: 1.3; width: 100%; }
    .anim-line2 { font-size: 1.0em; font-weight: 900; color: #fff; text-align: center; opacity: 0; line-height: 1.3; width: 100%; }
    /* 中段：画像ズームパン */
    .anim-img-strip { flex: 0 0 36%; overflow: hidden; position: relative; }
    .anim-bg { width: 100%; height: 100%; object-fit: cover; display: block; transform-origin: center; transform: scale(1.15) translateX(-4%); }
    .anim-bg.rtl { transform: scale(1.15) translateX(4%); }
    .anim-bg.static { transform: scale(1.0); }
    /* 下段：字幕＋感情img＋ウォーターマーク */
    .anim-bottom { flex: 1; background: #0a0a0a; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 8px 10px 20px; gap: 6px; position: relative; }
    .anim-subtitle { font-size: 0.9em; font-weight: 900; color: #fff; text-align: center; opacity: 0; white-space: pre-line; line-height: 1.4; width: 100%; }
    .anim-handle { font-size: 0.6em; color: #555; letter-spacing: 0.06em; flex-shrink: 0; }
    /* 感情img: 上段中央 (si≥1) */
    .anim-emotion-top { width: 62px; height: 62px; object-fit: contain; opacity: 0; flex-shrink: 0; }
    /* 感情img: 下段 (si=0用・フォールバック) */
    .anim-emotion-overlay { width: 48px; height: 48px; object-fit: contain; opacity: 0; flex-shrink: 0; }
    /* ナレーション字幕（時間切り替え） */
    .anim-narr-display { font-size: 0.85em; font-weight: 900; color: #fff; text-align: center; line-height: 1.5; width: 100%; min-height: 1.5em; transition: opacity 0.2s; }
    .anim-watermark { position: absolute; bottom: 5px; font-size: 0.52em; color: #555; letter-spacing: 0.06em; }
    /* スライド番号バッジ */
    .slide-num-badge { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.75); color: #4fc3f7; font-size: 0.62em; font-weight: bold; padding: 2px 7px; border-radius: 8px; z-index: 6; pointer-events: none; }
    /* 再生ボタン */
    .anim-play-btn { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 40px; height: 40px; background: rgba(0,0,0,0.55); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1em; color: #fff; z-index: 5; cursor: pointer; user-select: none; border: none; transition: background 0.2s; }
    .anim-play-btn:hover { background: rgba(255,255,255,0.3); }
    /* playing状態のアニメーション */
    .slide-anim-wrap.playing .anim-bg       { animation: animZoomLTR var(--dur,5s) linear forwards; }
    .slide-anim-wrap.playing .anim-bg.rtl   { animation: animZoomRTL var(--dur,5s) linear forwards; }
    .slide-anim-wrap.playing .anim-bg.static{ animation: none; transform: scale(1.0); }
    .slide-anim-wrap.playing .anim-line1    { animation: animFadeUp 0.5s 0.1s ease-out forwards; }
    .slide-anim-wrap.playing .anim-line2    { animation: animFadeUp 0.5s 0.25s ease-out forwards; }
    /* si≥1: 上段感情img → フェードイン+ウォブル継続 */
    .slide-anim-wrap.playing .anim-emotion-top  { animation: animFadeIn 0.3s 0.2s ease forwards, animWobble 0.8s 1s linear infinite; }
    /* si=0: 下段感情img → タイトルコール時間だけ表示して消える */
    .slide-anim-wrap.playing .anim-emotion-overlay { animation: animEmotionFlash 3s 0.2s ease forwards; }
    .slide-anim-wrap.playing .anim-play-btn { opacity: 0.25; }
    @keyframes animZoomLTR { from{transform:scale(1.15) translateX(-4%);} to{transform:scale(1.15) translateX(4%);} }
    @keyframes animZoomRTL { from{transform:scale(1.15) translateX(4%);} to{transform:scale(1.15) translateX(-4%);} }
    @keyframes animFadeUp        { from{opacity:0;transform:translateY(10px);} to{opacity:1;transform:translateY(0);} }
    @keyframes animFadeIn        { from{opacity:0;} to{opacity:1;} }
    @keyframes animWobble        { 0%{transform:translate(0,0) rotate(0deg);} 25%{transform:translate(3px,-2px) rotate(2deg);} 50%{transform:translate(-3px,2px) rotate(-2deg);} 75%{transform:translate(2px,3px) rotate(1deg);} 100%{transform:translate(0,0) rotate(0deg);} }
    @keyframes animEmotionFlash  { 0%{opacity:0;} 12%{opacity:1;} 65%{opacity:1;} 100%{opacity:0;} }

    /* 全再生ボタン */
    .btn-play-all { background: #1a4a20; color: #4caf50; border: 1px solid #4caf50; padding: 4px 12px; border-radius: 14px; font-size: 0.78em; cursor: pointer; }
    .btn-play-all:hover { background: #2a6a30; }
    .btn-play-all.playing { background: #4a1a1a; color: #ff6b6b; border-color: #ff6b6b; }

    /* 感情画像サイドパネル */
    .emotion-side { display: flex; flex-direction: column; align-items: center; gap: 5px; flex-shrink: 0; width: 58px; }
    .emotion-side-label { font-size: 0.58em; color: #666; text-align: center; }
    .emotion-img { width: 54px; height: 54px; object-fit: contain; border-radius: 6px; border: 1px solid #2a3a5e; background: #0a0a1a; }
    .emotion-narr { width: 54px; height: 24px; margin-top: 2px; }

    /* スライドフィールド */
    .slide-fields { padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; border-top: 1px solid #2a3a5e; flex-shrink: 0; max-height: 280px; overflow-y: auto; }
    .field-label { font-size: 0.68em; color: #888; font-weight: bold; }
    .field-ta { width: 100%; background: #0a0a1a; border: 1px solid #2a3a5e; border-radius: 6px; padding: 5px 7px; color: #e0e0e0; font-size: 0.75em; line-height: 1.4; resize: vertical; font-family: inherit; }
    .field-ta:focus { outline: none; border-color: #4fc3f7; }
    .field-select { width: 100%; background: #0a0a1a; border: 1px solid #2a3a5e; border-radius: 6px; padding: 4px 7px; color: #e0e0e0; font-size: 0.75em; }
    .field-select:focus { outline: none; border-color: #4fc3f7; }
    .narr-audio { width: 100%; height: 26px; margin-top: 2px; }

    .actions-bar { padding: 8px 14px; background: #0f0f1a; border-top: 1px solid #2a3a5e; display: flex; gap: 10px; align-items: center; flex-shrink: 0; height: 46px; }
    .btn-save-local { background: #333; color: #ccc; border: 1px solid #555; padding: 5px 14px; border-radius: 14px; font-size: 0.8em; cursor: pointer; }
    .btn-save-local:hover { background: #444; }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #333; color: #fff; padding: 10px 24px; border-radius: 20px; font-size: 0.88em; z-index: 999; display: none; }
    .toast.ok { background: #27ae60; }
    .toast.err { background: #e74c3c; }
    .scroll-hint { position: fixed; bottom: 70px; right: 20px; background: rgba(79,195,247,0.12); border: 1px solid #4fc3f7; color: #4fc3f7; padding: 5px 12px; border-radius: 14px; font-size: 0.75em; pointer-events: none; z-index: 100; transition: opacity 0.5s; }

    /* ── スマホ対応 (〜767px) ── */
    @media (max-width: 767px) {
      /* スクロールロック解除 */
      html, body { overflow: auto; height: auto; }

      .topbar { height: auto; min-height: 44px; flex-wrap: wrap; padding: 8px 12px; gap: 6px; }
      .topbar h1 { font-size: 0.95em; }
      .nav { flex-wrap: nowrap; gap: 5px; }
      .nav a { padding: 4px 9px; font-size: 0.75em; }

      .toolbar { height: auto; flex-wrap: wrap; padding: 8px 12px; gap: 6px; }
      .date-badge { font-size: 0.8em; padding: 4px 10px; }
      .status-msg { width: 100%; font-size: 0.78em; order: 3; }
      .btn-push { font-size: 0.82em; padding: 7px 14px; }

      /* スクロールスナップ解除・各カードを通常フローに */
      .content { height: auto; overflow-y: visible; scroll-snap-type: none; }
      .post-card { height: auto; scroll-snap-align: none; overflow: visible; margin-bottom: 16px; }
      .post-header { height: auto; min-height: 44px; flex-wrap: wrap; gap: 6px; padding: 8px 12px; }

      /* スライドグリッド: 横スクロール維持・幅調整 */
      .slides-grid { padding: 6px 8px; gap: 6px; }
      .slide-card { min-width: 200px; flex: 0 0 200px; }

      /* アニメプレビュー: 固定高さをスマホ向けに調整 */
      .slide-anim-wrap { height: 240px; }

      /* フィールドエリア */
      .slide-fields { max-height: 200px; }
      .field-ta { font-size: 0.72em; }

      .actions-bar { height: auto; flex-wrap: wrap; gap: 8px; padding: 8px 12px; }
      .scroll-hint { display: none; }
    }
  </style>
</head>
<body>
<div class="topbar">
  <h1>🎬 Shorts制作ランチャー</h1>
  <nav class="nav">
    <a href="/launcher">𝕏 X投稿</a>
    <a href="/shorts-launcher" class="active">🎬 Shorts</a>
    <a href="/engagement">🎯 交流</a>
  </nav>
</div>
<div class="toolbar">
  <span class="date-badge" id="dateBadge">読み込み中...</span>
  <span class="status-msg" id="statusMsg">コンテンツを読み込んでいます...</span>
  <button class="btn-push" id="btnPush" onclick="pushToGitHub()" disabled>🚀 GitHubにPush → 動画生成開始</button>
</div>
<div class="content" id="mainContent">
  <div class="loading"><div class="spinner"></div>コンテンツを準備しています...<br><small style="color:#666;margin-top:8px;display:block">初回はClaudeがコンテンツを自動生成します（30秒〜1分）</small></div>
</div>
<div class="toast" id="toast"></div>
<div class="scroll-hint" id="scrollHint">↑↓ スクロールで切り替え</div>

<script>
const EMOTION_OPTIONS = ${JSON.stringify(EMOTION_OPTIONS)};
// 感情タグ → emotions/ フォルダの画像ファイル名マッピング（小文字）
const EMOTION_IMG_MAP = { SURPRISE:"surprise", HAPPY:"happy", THINK:"think", SHOCK:"surprise", SAD:"sad", EXCITED:"happy", ANGRY:"angry" };
// スライドインデックス → narr ファイル番号（s03_emotionがnarr_3のためsi=3はnarr_4）
const NARR_IDX = [0, 1, 2, 4];
let currentDate = null;
let currentPosts = null;
let currentSlidesExists = [];
let currentImageWebPaths = [];

async function loadContent() {
  const res = await fetch("/api/shorts-content");
  const data = await res.json();
  if (!data.success) {
    document.getElementById("mainContent").innerHTML = '<div class="error-box">❌ ' + data.message + '</div>';
    document.getElementById("statusMsg").textContent = "エラー";
    return;
  }
  currentDate = data.date;
  currentPosts = data.content.posts;
  currentSlidesExists = data.slidesExists || [];
  currentImageWebPaths = data.imageWebPaths || [];
  document.getElementById("dateBadge").textContent = data.date;
  document.getElementById("statusMsg").textContent =
    data.generated ? "✨ Claude が自動生成しました。内容を確認・編集してPushしてください" :
    "✅ 保存済みコンテンツを読み込みました。編集後にPushしてください";
  document.getElementById("btnPush").disabled = false;
  renderPosts();
  setTimeout(() => { const h = document.getElementById("scrollHint"); if (h) h.style.opacity = "0"; }, 4000);
}

function renderPosts() {
  document.getElementById("mainContent").innerHTML = currentPosts.map((post, idx) => renderPostCard(post, idx)).join("");
}

function renderPostCard(post, idx) {
  const num = idx + 1;
  const slideKeys  = ["slide1","slide2","slide3","slide4"];
  const slideNames = ["①導入","②詳細","③反応","④締め"];
  const slideCodes = ["s00_title","s01_content1","s02_content2","s04_cta"];
  const hasEmotion = [true, true, true, false];

  const slideCards = slideKeys.map((sk, si) => {
    const slide    = post[sk] || {};
    const emotion  = slide.emotion || "";
    const baseDir  = "/shorts_slides/" + currentDate + "_" + num + "/";
    const narrPath = baseDir + "narr_" + NARR_IDX[si] + ".wav";
    const emotNarrPath = baseDir + "narr_3.wav";
    const emotImgFile  = EMOTION_IMG_MAP[emotion] || "think";
    const emotImgPath  = "/emotions/" + emotImgFile + ".png";
    // 元投稿画像を背景に使用（レンダリング済みPNGは焼き込みテキスト・暗部があるため不使用）
    const imgSrc = currentImageWebPaths[idx] || "";
    const animBgClass = si === 3 ? "static" : (si % 2 === 0 ? "" : "rtl");
    const animDur  = si === 3 ? "3" : "5";

    const emotionSelect = hasEmotion[si]
      ? '<div class="field-label">感情</div><select class="field-select" id="post' + idx + '_' + sk + '_emotion" onchange="syncPreview(' + idx + ',' + si + ')">'
          + EMOTION_OPTIONS.map(e => '<option value="' + e + '"' + (e === emotion ? " selected" : "") + '>' + e + '</option>').join("")
          + '</select>'
      : "";

    const c1 = (post.catchLine1 || "").replace(/&/g,"&amp;").replace(/</g,"&lt;");
    const c2 = (post.catchLine2 || "").replace(/&/g,"&amp;").replace(/</g,"&lt;");
    const narrAttr = (slide.narration || "").replace(/&/g,"&amp;").replace(/"/g,"&quot;");

    const animWrap =
      '<div class="slide-anim-wrap" id="animWrap_' + idx + '_' + si + '" style="--dur:' + animDur + 's;" data-narr="' + narrAttr + '">'
        // 上段: si=0→赤バッジ+キャッチライン / si≥1→ハンドル+感情img中央
        + '<div class="anim-top">'
          + (si === 0
            ? '<div class="anim-badge">【衝撃】世界の話題</div>'
              + '<div class="anim-line1" id="animLine1_' + idx + '">' + c1 + '</div>'
              + '<div class="anim-line2" id="animLine2_' + idx + '">' + c2 + '</div>'
            : '<div class="anim-handle">@sekai_no_wadai</div>'
              + (hasEmotion[si]
                ? '<img class="anim-emotion-top" id="animEmotion_' + idx + '_' + si + '" src="' + emotImgPath + '" onerror="this.style.opacity=0">'
                : ''))
        + '</div>'
        // 中段：画像ズームパン
        + '<div class="anim-img-strip">'
          + (imgSrc
            ? '<img class="anim-bg' + (animBgClass ? ' ' + animBgClass : '') + '" src="' + imgSrc + '" onerror="this.style.opacity=0.2">'
            : '<div style="width:100%;height:100%;background:#1a1a2e;"></div>')
        + '</div>'
        // 下段：ナレーション字幕（時間切り替え）＋si=0の感情img＋ウォーターマーク
        + '<div class="anim-bottom">'
          + '<div class="anim-narr-display" id="animNarr_' + idx + '_' + si + '"></div>'
          + (si === 0 && hasEmotion[0]
            ? '<img class="anim-emotion-overlay" id="animEmotion_' + idx + '_0" src="' + emotImgPath + '" onerror="this.style.opacity=0">'
            : '')
          + '<div class="anim-watermark">@sekai_no_wadai</div>'
        + '</div>'
        + '<span class="slide-num-badge">' + slideNames[si] + '</span>'
        + '<audio id="animAudio_' + idx + '_' + si + '" src="' + narrPath + '" preload="none" onerror="this.remove()"></audio>'
        + '<button class="anim-play-btn" onclick="toggleSlide(' + idx + ',' + si + ')">▶</button>'
      + '</div>';

    return '<div class="slide-card">'
      + '<div class="slide-top">' + animWrap + '</div>'
      + '<div class="slide-fields">'
        + '<div class="field-label">字幕/ナレーション</div>'
        + '<textarea class="field-ta" id="post' + idx + '_' + sk + '_narration" rows="5" oninput="onNarrInput(' + idx + ',' + si + ')">' + (slide.narration || slide.subtitle || "") + '</textarea>'
        + '<audio class="narr-audio" controls src="' + narrPath + '" onerror="this.remove()"></audio>'
        + (si === 2 ? '<div class="field-label">感情音声(narr3)</div><audio class="narr-audio" controls src="' + emotNarrPath + '" onerror="this.remove()"></audio>' : '')
        + emotionSelect
      + '</div>'
      + '</div>';
  }).join("");

  return '<div class="post-card" id="postcard_' + idx + '">'
    + '<div class="post-header">'
      + '<div class="post-num">' + num + '</div>'
      + '<div class="catch-row">'
        + '<span class="catch-label">キャッチ①</span>'
        + '<input class="catch-input" id="post' + idx + '_catchLine1" value="' + (post.catchLine1 || "").replace(/"/g,"&quot;") + '">'
        + '<span class="catch-label">キャッチ②</span>'
        + '<input class="catch-input" id="post' + idx + '_catchLine2" value="' + (post.catchLine2 || "").replace(/"/g,"&quot;") + '">'
      + '</div>'
      + '<button class="btn-play-all" id="btnPlayAll_' + idx + '" onclick="playAllSlides(' + idx + ')">▶ 全再生</button>'
    + '</div>'
    + '<div class="slides-grid">' + slideCards + '</div>'
    + '<div class="actions-bar">'
      + '<button class="btn-save-local" onclick="savePost(' + idx + ')">💾 この投稿を保存</button>'
      + '<span style="font-size:0.7em;color:#888;">🎧 通しナレーション</span>'
      + '<audio controls src="/shorts_slides/' + currentDate + '_' + num + '/audio.wav" style="height:26px;flex:1;" onerror="this.parentNode.removeChild(this.previousSibling);this.remove()"></audio>'
    + '</div>'
    + '</div>';
}

function onNarrInput(postIdx, si) {
  const sk = "slide" + (si + 1);
  const val = document.getElementById("post" + postIdx + "_" + sk + "_narration")?.value || "";
  const wrap = document.getElementById("animWrap_" + postIdx + "_" + si);
  if (wrap) wrap.dataset.narr = val;
}

function syncPreview(idx, si) {
  const sk       = "slide" + (si + 1);
  const subtitle = document.getElementById("post" + idx + "_" + sk + "_subtitle")?.value || "";
  const emotion  = document.getElementById("post" + idx + "_" + sk + "_emotion")?.value || "";

  // 字幕テキスト更新（si=0はキャッチライン表示のため対象外）
  if (si !== 0) {
    const el = document.getElementById("animSubtitle_" + idx + "_" + si);
    if (el) el.textContent = subtitle;
  }

  // 感情img更新（上段 or 下段どちらかに存在）
  const emotEl = document.getElementById("animEmotion_" + idx + "_" + si);
  if (emotEl && emotion) {
    emotEl.src = "/emotions/" + (EMOTION_IMG_MAP[emotion] || "think") + ".png";
    emotEl.title = emotion;
    emotEl.style.opacity = "";
  }
}

// ナレーションを自然な区切りでチャンク分割（句読点優先）
function splitNarration(text) {
  const raw = (text || "").trim();
  if (!raw) return [];
  // 文末（。！？…）で分割
  const sentences = raw.split(/(?<=[。！？…])/);
  const result = [];
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    if (t.length <= 24) {
      result.push(t);
    } else {
      // 長い場合は読点（、）で分割を試みる
      const ci = t.indexOf("、");
      if (ci > 2 && ci < t.length - 2) {
        result.push(t.slice(0, ci + 1).trim());
        result.push(t.slice(ci + 1).trim());
      } else {
        // 読点なければ中間で分割
        const mid = Math.ceil(t.length / 2);
        result.push(t.slice(0, mid));
        result.push(t.slice(mid));
      }
    }
  }
  return result.filter(p => p.length > 0);
}

const narrTimers = {};

function stopSlideAnim(wrap) {
  wrap.classList.remove("playing");
  const b = wrap.querySelector(".anim-play-btn"); if (b) b.textContent = "▶";
  const a = wrap.querySelector("audio[id^='animAudio']"); if (a) { a.onended = null; a.pause(); a.currentTime = 0; }
  const nd = wrap.querySelector(".anim-narr-display"); if (nd) nd.textContent = "";
  // キャッチラインの opacity をリセット（si=0 フェーズ移行後の状態を戻す）
  const l1 = wrap.querySelector(".anim-line1"); if (l1) { l1.style.transition = ""; l1.style.opacity = ""; }
  const l2 = wrap.querySelector(".anim-line2"); if (l2) { l2.style.transition = ""; l2.style.opacity = ""; }
  const parts = wrap.id.replace("animWrap_", "").split("_");
  const k = parts[0] + "_" + parts[1];
  if (narrTimers[k]) { clearInterval(narrTimers[k]); delete narrTimers[k]; }
  // si=0 フェーズタイマーもクリア
  if (narrTimers[k + "_ph"])  { clearTimeout(narrTimers[k + "_ph"]);  delete narrTimers[k + "_ph"];  }
  if (narrTimers[k + "_ph2"]) { clearTimeout(narrTimers[k + "_ph2"]); delete narrTimers[k + "_ph2"]; }
}

function startNarrCycle(wrap, postIdx, si) {
  const narrEl = document.getElementById("animNarr_" + postIdx + "_" + si);
  const narrText = wrap.dataset.narr || "";
  if (!narrEl || !narrText) return;
  const chunks = splitNarration(narrText);
  if (chunks.length === 0) return;
  let ci = 0;
  narrEl.textContent = chunks[0];
  narrEl.style.opacity = "1";
  const durMs = (parseFloat(getComputedStyle(wrap).getPropertyValue("--dur")) || 5) * 1000;
  const stepMs = Math.max(900, durMs / chunks.length);
  const key = postIdx + "_" + si;
  narrTimers[key] = setInterval(() => {
    ci = (ci + 1) % chunks.length;
    narrEl.style.opacity = "0";
    setTimeout(() => { narrEl.textContent = chunks[ci]; narrEl.style.opacity = "1"; }, 180);
  }, stepMs);
}

function toggleSlide(postIdx, si) {
  const wrap  = document.getElementById("animWrap_" + postIdx + "_" + si);
  const btn   = wrap.querySelector(".anim-play-btn");
  const audio = document.getElementById("animAudio_" + postIdx + "_" + si);

  if (wrap.classList.contains("playing")) {
    stopSlideAnim(wrap);
  } else {
    // 同じ投稿の他スライドを停止
    document.querySelectorAll("#postcard_" + postIdx + " .slide-anim-wrap.playing").forEach(w => stopSlideAnim(w));
    void wrap.offsetWidth; // アニメーション再起動のためreflow
    wrap.classList.add("playing");
    if (audio) { audio.currentTime = 0; audio.play().catch(() => {}); }
    btn.textContent = "⏹";
    if (si === 0) {
      // Phase1: キャッチライン＋感情img表示（CSS animationが動く）
      // Phase2: 3秒後にキャッチラインをフェードアウトしてナレーション字幕へ移行
      const key = postIdx + "_0";
      narrTimers[key + "_ph"] = setTimeout(() => {
        if (!wrap.classList.contains("playing")) return;
        const l1 = wrap.querySelector(".anim-line1");
        const l2 = wrap.querySelector(".anim-line2");
        [l1, l2].forEach(el => { if (el) { el.style.transition = "opacity 0.4s"; el.style.opacity = "0"; } });
        narrTimers[key + "_ph2"] = setTimeout(() => {
          if (!wrap.classList.contains("playing")) return;
          startNarrCycle(wrap, postIdx, 0);
        }, 450);
      }, 2800);
    } else {
      startNarrCycle(wrap, postIdx, si);
    }
  }
}

function playAllSlides(postIdx) {
  const btn = document.getElementById("btnPlayAll_" + postIdx);
  if (btn.classList.contains("playing")) {
    btn.classList.remove("playing");
    btn.textContent = "▶ 全再生";
    document.querySelectorAll("#postcard_" + postIdx + " .slide-anim-wrap.playing").forEach(w => stopSlideAnim(w));
    return;
  }
  btn.classList.add("playing");
  btn.textContent = "⏹ 停止";
  let si = 0;
  (function playNext() {
    if (si >= 4 || !btn.classList.contains("playing")) {
      btn.classList.remove("playing");
      btn.textContent = "▶ 全再生";
      return;
    }
    document.querySelectorAll("#postcard_" + postIdx + " .slide-anim-wrap.playing").forEach(w => stopSlideAnim(w));
    const wrap  = document.getElementById("animWrap_" + postIdx + "_" + si);
    const audio = document.getElementById("animAudio_" + postIdx + "_" + si);
    const durS  = parseFloat(getComputedStyle(wrap).getPropertyValue("--dur")) || 5;
    void wrap.offsetWidth;
    wrap.classList.add("playing");
    const pb = wrap.querySelector(".anim-play-btn"); if (pb) pb.textContent = "⏹";
    if (si === 0) {
      const key = postIdx + "_0";
      narrTimers[key + "_ph"] = setTimeout(() => {
        if (!wrap.classList.contains("playing")) return;
        const l1 = wrap.querySelector(".anim-line1");
        const l2 = wrap.querySelector(".anim-line2");
        [l1, l2].forEach(el => { if (el) { el.style.transition = "opacity 0.4s"; el.style.opacity = "0"; } });
        narrTimers[key + "_ph2"] = setTimeout(() => {
          if (!wrap.classList.contains("playing")) return;
          startNarrCycle(wrap, postIdx, 0);
        }, 450);
      }, 2800);
    } else {
      startNarrCycle(wrap, postIdx, si);
    }
    function next() {
      stopSlideAnim(wrap);
      si++;
      playNext();
    }
    if (audio) {
      audio.currentTime = 0;
      audio.onended = next;
      audio.play().catch(() => setTimeout(next, durS * 1000));
    } else {
      setTimeout(next, durS * 1000);
    }
  })();
}

function collectAll() {
  return currentPosts.map((_, idx) => {
    const slides = {};
    ["slide1","slide2","slide3","slide4"].forEach((sk, si) => {
      const narration = document.getElementById("post" + idx + "_" + sk + "_narration")?.value || "";
      slides[sk] = {
        narration,
        subtitle: narration,
      };
      const emotionEl = document.getElementById("post" + idx + "_" + sk + "_emotion");
      if (emotionEl) slides[sk].emotion = emotionEl.value;
    });
    return {
      catchLine1: document.getElementById("post" + idx + "_catchLine1")?.value || "",
      catchLine2: document.getElementById("post" + idx + "_catchLine2")?.value || "",
      ...slides,
    };
  });
}

async function savePost(idx) {
  currentPosts = collectAll();
  const res  = await fetch("/api/shorts-content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: currentDate, posts: currentPosts }) });
  const data = await res.json();
  showToast(data.success ? "💾 保存しました" : "❌ " + data.message, data.success);
}

async function pushToGitHub() {
  const btn = document.getElementById("btnPush");
  btn.disabled = true; btn.textContent = "⏳ 保存 & Push中...";
  currentPosts = collectAll();
  const saveRes = await fetch("/api/shorts-content", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: currentDate, posts: currentPosts }) });
  if (!(await saveRes.json()).success) { btn.disabled = false; btn.textContent = "🚀 GitHubにPush → 動画生成開始"; showToast("❌ 保存に失敗しました", false); return; }
  const pushRes  = await fetch("/api/push-shorts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: currentDate }) });
  const pushData = await pushRes.json();
  if (pushData.success) {
    document.getElementById("statusMsg").innerHTML = '✅ Push完了！<a href="https://github.com/gagazetmt/sekai_no_wadai/actions" target="_blank" style="color:#4fc3f7">GitHub Actions で動画生成 →</a>';
    btn.textContent = "✅ Push完了";
    showToast("🚀 GitHubにPushしました！", true);
  } else {
    btn.disabled = false; btn.textContent = "🚀 GitHubにPush → 動画生成開始";
    showToast("❌ " + pushData.message, false);
  }
}

function showToast(msg, ok) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.className = "toast " + (ok ? "ok" : "err");
  t.style.display = "block";
  setTimeout(() => { t.style.display = "none"; }, 3000);
}

loadContent();
</script>
</body>
</html>`;
}

app.get("/shorts-launcher", (req, res) => {
  res.send(buildShortsLauncherHtml());
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
    .btn-following{display:inline-block;margin-top:6px;padding:3px 10px;border-radius:10px;font-size:0.74em;font-weight:bold;background:#e8f5e9;color:#2e7d32;border:1px solid #a5d6a7;cursor:default;}
    /* 中央カラム */
    .col-center{flex:0 0 840px;display:flex;flex-direction:column;overflow:hidden;min-width:0;}
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
    .btn-like{padding:3px 10px;border-radius:10px;border:1px solid #f4b8c8;color:#e0245e;background:#fff;font-size:0.74em;cursor:pointer;transition:all 0.12s;}
    .btn-like:hover{background:#fce8ed;}
    .btn-like.done{background:#e0245e;color:#fff;border-color:#e0245e;cursor:default;}
    .btn-rt{padding:3px 10px;border-radius:10px;border:1px solid #b2dfc2;color:#17bf63;background:#fff;font-size:0.74em;cursor:pointer;transition:all 0.12s;}
    .btn-rt:hover{background:#e6f9ed;}
    .btn-rt.done{background:#17bf63;color:#fff;border-color:#17bf63;cursor:default;}
    .placeholder{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:#ccc;font-size:0.95em;}
    /* 右カラム */
    .col-right{flex:0 0 640px;background:#fff;border-left:1px solid #e0e0e0;display:flex;flex-direction:column;overflow:hidden;}
    .col-right-head{padding:10px 14px;font-size:0.88em;font-weight:bold;color:#555;background:#fafafa;border-bottom:1px solid #f0f0f0;flex-shrink:0;}
    .reply-panel{flex:1;overflow-y:auto;padding:12px;}
    .reply-placeholder{color:#ccc;font-size:0.84em;text-align:center;padding:40px 10px;line-height:1.8;}
    .tweet-preview{background:#f0f7ff;border-radius:8px;padding:8px 10px;margin-bottom:12px;font-size:0.78em;color:#555;border-left:3px solid #1da1f2;line-height:1.5;}
    .sug-box{margin-bottom:12px;}
    .sug-label{font-size:0.76em;font-weight:bold;color:#888;margin-bottom:4px;}
    .sug-ta{width:100%;padding:8px 10px;border:2px solid #e0e0e0;border-radius:8px;font-size:0.83em;line-height:1.5;resize:vertical;font-family:inherit;min-height:130px;transition:border-color 0.15s;}
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
    .manual-ta{width:100%;padding:8px 10px;border:2px solid #e0e0e0;border-radius:8px;font-size:0.84em;line-height:1.5;resize:vertical;font-family:inherit;min-height:144px;box-sizing:border-box;}
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
let followingSet = new Set();

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
      + (followingSet.has(t.id.toLowerCase())
          ? '<span class="btn-following" onclick="event.stopPropagation()">✓ フォロー中</span>'
          : '<a class="btn-follow" href="https://twitter.com/intent/follow?screen_name=' + t.id + '" target="_blank" onclick="event.stopPropagation()">＋ フォロー ↗</a>')
      + '</div>';
  }).join("");
}
renderList();

fetch("/api/engagement/following")
  .then(r => r.json())
  .then(data => {
    if (data.success && data.usernames.length) {
      followingSet = new Set(data.usernames);
      renderList();
    }
  })
  .catch(() => {});

async function selectAccount(id) {
  selectedAccId = id;
  selectedTweetId = null;
  renderList();

  const t = TARGETS.find(x => x.id === id);
  if (!t) return;
  const color = CAT_COLORS[t.cat] || "#546e7a";

  // ── ヘッダー描画 ──
  document.getElementById("centerHeader").innerHTML =
    '<div class="acc-profile-box">'
    + '<div class="acc-profile-name">' + t.name + '</div>'
    + '<div class="acc-profile-id">@' + id + '</div>'
    + '<span class="acc-cat" style="background:' + color + '">' + t.cat + '</span>'
    + '<div class="acc-profile-hint">' + t.hint + '</div>'
    + '<a class="btn-open-x" href="https://twitter.com/' + id + '" target="_blank">𝕏 タイムラインを開く ↗</a>'
    + '</div>';

  document.getElementById("replyPanel").innerHTML =
    '<div class="reply-placeholder">ツイートをクリックすると<br>リプライ案を生成します</div>';

  // ── ツイート自動取得（TwitterAPI.io） ──
  document.getElementById("tweetsList").innerHTML =
    '<div class="loading">📡 @' + id + ' のツイートを取得中…</div>';

  const res = await fetch("/api/engagement/tweets", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: id, count: 10 }),
  });
  const data = await res.json();

  // ── TWITTER_API_IO_KEY 未設定 → 手動入力フォームにフォールバック ──
  if (!data.success && data.fallback) {
    document.getElementById("tweetsList").innerHTML =
      '<div class="manual-box">'
      + '<div class="manual-hint" style="background:#fff8e1;border-color:#f9a825;">⚠️ <strong>TWITTER_API_IO_KEY</strong> が未設定のため手動入力モードです。<br>'
      + '.env に設定すると自動取得できます。<br><br>'
      + '💡 <a href="https://twitter.com/' + id + '" target="_blank">@' + id + ' のタイムライン</a> を開き、リプライしたいツイートの URL と本文を貼り付けてください</div>'
      + '<div class="manual-label">① ツイートURL</div>'
      + '<input class="manual-input" id="tweetUrlInput" placeholder="https://twitter.com/.../status/12345..." />'
      + '<div class="manual-label">② ツイート本文</div>'
      + '<textarea class="manual-ta" id="tweetTextInput" placeholder="ここにツイートの本文を貼り付け..."></textarea>'
      + '<button class="btn-generate" onclick="generateReplies()">🤖 リプライ案を生成</button>'
      + '</div>';
    return;
  }

  // ── 取得失敗 ──
  if (!data.success) {
    document.getElementById("tweetsList").innerHTML =
      '<div style="padding:20px;color:#e53935;font-size:0.85em;">❌ 取得失敗: ' + data.message + '<br><br>'
      + '<a href="https://twitter.com/' + id + '" target="_blank" style="color:#1da1f2">𝕏 手動で確認する ↗</a></div>';
    return;
  }

  // ── ツイートカード描画 ──
  if (!data.tweets.length) {
    document.getElementById("tweetsList").innerHTML =
      '<div style="padding:20px;color:#aaa;font-size:0.85em;">ツイートが見つかりませんでした</div>';
    return;
  }

  document.getElementById("tweetsList").innerHTML = data.tweets.map((tw, i) => {
    const textEsc = tw.text.replace(/&/g,"&amp;").replace(/</g,"&lt;");
    const date    = tw.createdAt ? new Date(tw.createdAt).toLocaleString("ja-JP", { month:"numeric", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "";
    return '<div class="tweet-card" id="twcard-' + i + '" onclick="selectTweet(' + JSON.stringify(tw).replace(/"/g,"&quot;") + ', this)">'
      + '<div class="tweet-text">' + textEsc + '</div>'
      + '<div class="tweet-meta">'
      + '<span class="like-c">♥ ' + tw.likes.toLocaleString() + '</span>'
      + '<span class="rt-c">🔁 ' + tw.retweets.toLocaleString() + '</span>'
      + '<span>💬 ' + tw.replies.toLocaleString() + '</span>'
      + (tw.views ? '<span>👁 ' + tw.views.toLocaleString() + '</span>' : '')
      + (date ? '<span>' + date + '</span>' : '')
      + '</div>'
      + '<div class="tweet-actions">'
      + '<button class="btn-like" data-id="' + tw.id + '" data-idx="' + i + '" onclick="likeTweet(this,event)">♥ いいね</button>'
      + '<button class="btn-rt" data-id="' + tw.id + '" data-idx="' + i + '" onclick="retweetTweet(this,event)">🔁 RT</button>'
      + '<a class="btn-action" href="' + tw.url + '" target="_blank">𝕏 開く ↗</a>'
      + '</div>'
      + '</div>';
  }).join("");
}

function selectTweet(tw, el) {
  // カード選択状態を更新
  document.querySelectorAll(".tweet-card").forEach(c => c.classList.remove("selected"));
  el.classList.add("selected");
  selectedTweetId = tw.id;

  // リプライ生成パネルにプレビューを表示して即生成
  const prevEsc = tw.text.slice(0, 80).replace(/&/g,"&amp;").replace(/</g,"&lt;") + (tw.text.length > 80 ? "…" : "");
  document.getElementById("replyPanel").innerHTML =
    '<div class="tweet-preview">📌 ' + prevEsc + '</div>'
    + '<div class="loading">🤖 Claude がリプライ案を生成中…</div>';

  fetch("/api/engagement/suggest", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tweetText: tw.text, authorName: selectedAccId || "unknown" }),
  }).then(r => r.json()).then(data => {
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
        const tweetId = tw.id;
        return '<div class="sug-box">'
          + '<div class="sug-label">' + (labels[i] || "パターン" + (i+1)) + '</div>'
          + '<textarea class="sug-ta" id="sug-' + i + '" oninput="updCnt(' + i + ')">' + rEsc + '</textarea>'
          + '<div class="char-cnt" id="cnt-' + i + '">' + r.length + ' / 140</div>'
          + '<div class="sug-btns">'
          + '<button class="btn-send" id="send-' + i + '" data-idx="' + i + '" data-tweet="' + tweetId + '" onclick="sendReply(+this.dataset.idx,this.dataset.tweet)">📤 送信</button>'
          + '<button class="btn-copy-s" onclick="copySug(' + i + ')">📋</button>'
          + '</div></div>';
      }).join("");
  });
}

// 手動フォールバック用（TWITTER_API_IO_KEY 未設定時）
async function generateReplies() {
  const tweetUrl  = (document.getElementById("tweetUrlInput")?.value || "").trim();
  const tweetText = (document.getElementById("tweetTextInput")?.value || "").trim();
  if (!tweetText) { showToast("❌ ツイート本文を入力してください"); return; }

  const urlMatch = tweetUrl.match(/status\\/(\\d+)/);
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

async function likeTweet(btn, e) {
  e.stopPropagation();
  if (btn.classList.contains("done")) return;
  const tweetId = btn.dataset.id;
  btn.textContent = "…"; btn.disabled = true;
  const res = await fetch("/api/engagement/like", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tweetId })
  });
  const data = await res.json();
  if (data.success) {
    btn.textContent = "♥ 済"; btn.classList.add("done");
    showToast("♥ いいねしました！");
  } else {
    btn.textContent = "♥ いいね"; btn.disabled = false;
    showToast("❌ いいね失敗: " + data.message);
  }
}

async function retweetTweet(btn, e) {
  e.stopPropagation();
  if (btn.classList.contains("done")) return;
  const tweetId = btn.dataset.id;
  btn.textContent = "…"; btn.disabled = true;
  const res = await fetch("/api/engagement/retweet", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tweetId })
  });
  const data = await res.json();
  if (data.success) {
    btn.textContent = "🔁 済"; btn.classList.add("done");
    showToast("🔁 リツイートしました！");
  } else {
    btn.textContent = "🔁 RT"; btn.disabled = false;
    showToast("❌ RT失敗: " + data.message);
  }
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
  </div>
  <div class="frames">
    <div class="frame-wrap active" id="tab-x">
      <iframe src="/launcher" id="frame-x"></iframe>
    </div>
    <div class="frame-wrap" id="tab-eng">
      <div class="loading-msg" id="loading-eng">読み込み中...</div>
      <iframe id="frame-eng" style="display:none"></iframe>
    </div>
  </div>
  <script>
    const SRCS = { x: null, eng: "/engagement" };
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

// ── 起動時に未投稿の予約を復元 ───────────────────────────────────────────
function restoreScheduledPosts() {
  const TEMP_DIR = path.join(__dirname, "temp");
  if (!fs.existsSync(TEMP_DIR)) return;

  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const approvedPath = path.join(TEMP_DIR, `approved_${today}.json`);
  if (!fs.existsSync(approvedPath)) return;

  let approved;
  try { approved = JSON.parse(fs.readFileSync(approvedPath, "utf8")); }
  catch { return; }

  const now = new Date();
  let restored = 0;
  for (const post of approved.posts) {
    const [h, m] = post.scheduleTime.split(":").map(Number);
    const scheduledDate = new Date();
    scheduledDate.setHours(h, m, 0, 0);
    // 今日の予約時刻がまだ未来なら復元（翌日扱いにしない）
    if (scheduledDate > now) {
      scheduleJob({
        postNum:      post.postNum,
        text:         post.text,
        sourceUrl:    post.sourceUrl,
        thumbPath:    post.thumbPath,
        scheduleTime: post.scheduleTime,
      });
      console.log(`♻️  復元: 投稿${post.postNum} → ${post.scheduleTime} (${Math.round((scheduledDate - now)/1000/60)}分後)`);
      restored++;
    }
  }
  if (restored > 0) console.log(`♻️  予約復元完了: ${restored}件\n`);
}

const PORT = 3000;
const server = app.listen(PORT, () => {
  console.log(`\n🚀 投稿サーバー起動！`);
  console.log(`📋 X投稿ランチャー:  http://localhost:3000/launcher`);
  console.log(`▶  YouTubeランチャー: http://localhost:3000/youtube`);
  console.log(`🎯 交流センター:      http://localhost:3000/engagement\n`);
  restoreScheduledPosts();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`\n⚠️  ポート${PORT}が使用中です。1秒後に再試行...\n`);
    setTimeout(() => server.listen(PORT), 1000);
  } else {
    console.error(`\n❌ サーバーエラー: ${err.message}\n`);
    process.exit(1);
  }
});
