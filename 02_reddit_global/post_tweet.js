// GitHub Actions用 X自動投稿スクリプト
// 現在のJST時刻からスケジュールを照合して投稿する

require("dotenv").config();
const { TwitterApi } = require("twitter-api-v2");
const fs = require("fs");
const path = require("path");

const SCHEDULE_TIMES = [
  "06:00", "06:30", "07:00", "07:30", "08:00", "08:30",
  "09:00", "09:30", "10:00", "10:30", "11:00", "11:30",
  "12:00", "12:30", "13:00", "13:30", "14:00", "14:30",
  "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
  "18:00", "18:30", "19:00", "19:30", "20:00", "20:30",
  "21:00", "21:30", "22:00", "22:30", "23:00", "23:30",
];

// 時間の許容誤差（分）: GitHub Actionsのcronは数分遅れることがある
const TOLERANCE_MINUTES = 12;

async function main() {
  // 現在のJST時刻を取得
  const utcNow = new Date();
  const jstNow = new Date(utcNow.getTime() + 9 * 60 * 60 * 1000);
  const jstHour = jstNow.getUTCHours();
  const jstMinute = jstNow.getUTCMinutes();
  const jstMinutes = jstHour * 60 + jstMinute;
  const jstTimeStr = `${String(jstHour).padStart(2, "0")}:${String(jstMinute).padStart(2, "0")}`;

  // 今日のJST日付
  const jstYear = jstNow.getUTCFullYear();
  const jstMonth = String(jstNow.getUTCMonth() + 1).padStart(2, "0");
  const jstDay = String(jstNow.getUTCDate()).padStart(2, "0");
  const jstDateStr = `${jstYear}-${jstMonth}-${jstDay}`;

  console.log(`\n現在時刻 (JST): ${jstDateStr} ${jstTimeStr}`);

  // スケジュールに照合（±12分以内）
  let postIndex = -1;
  for (let i = 0; i < SCHEDULE_TIMES.length; i++) {
    const [h, m] = SCHEDULE_TIMES[i].split(":").map(Number);
    const schedMinutes = h * 60 + m;
    if (Math.abs(jstMinutes - schedMinutes) <= TOLERANCE_MINUTES) {
      postIndex = i;
      break;
    }
  }

  if (postIndex === -1) {
    console.log(`JST ${jstTimeStr} に該当するスケジュールがありません。スキップします。`);
    process.exit(0);
  }

  const scheduledTime = SCHEDULE_TIMES[postIndex];
  console.log(`→ 投稿${postIndex + 1} (予定: ${scheduledTime}) にマッチしました`);

  // 今日の承認済みJSONファイルを読む
  const TEMP_DIR = path.join(__dirname, "temp");
  const jsonPath = path.join(TEMP_DIR, `approved_${jstDateStr}.json`);

  if (!fs.existsSync(jsonPath)) {
    console.log(`⏭️ 承認済みJSONが見つかりません: ${jsonPath}`);
    console.log("今日の投稿はスキップします。");
    process.exit(0);
  }

  const { posts } = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

  // scheduleTime で照合
  const post = posts.find(p => p.scheduleTime === scheduledTime);

  if (!post) {
    console.log(`JST ${jstTimeStr} (${scheduledTime}) の承認済み投稿はありません。スキップします。`);
    process.exit(0);
  }

  console.log(`\n投稿文:\n${post.text}`);
  console.log(`元ネタURL: ${post.sourceUrl}`);

  // X APIクライアント初期化
  const xClient = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });

  // 動画ファイルの確認・アップロード（videoPathフィールド優先、なければ日付+番号で構築）
  let tweetParams = { text: post.text };
  const videoPath = post.videoPath && fs.existsSync(post.videoPath)
    ? post.videoPath
    : path.join(__dirname, "videos", `${jstDateStr}_${post.postNum}.mp4`);
  if (fs.existsSync(videoPath)) {
    console.log(`\n🎬 動画をアップロード中: ${videoPath}`);
    try {
      const mediaId = await xClient.v1.uploadMedia(videoPath, { mimeType: "video/mp4" });
      tweetParams.media = { media_ids: [mediaId] };
      console.log(`✅ 動画アップロード完了 (mediaId: ${mediaId})`);
    } catch (mediaErr) {
      console.log(`⚠️ 動画アップロード失敗（テキストのみで投稿）: ${mediaErr.message}`);
    }
  }

  // ツイート投稿
  const tweet = await xClient.v2.tweet(tweetParams);
  const tweetId = tweet.data.id;
  console.log(`\n✅ ツイート送信完了 (ID: ${tweetId})`);

  // リプ欄に元ネタURL
  if (post.sourceUrl) {
    await xClient.v2.reply(post.sourceUrl, tweetId);
    console.log(`💬 リプライ送信完了: ${post.sourceUrl}`);
  }

  console.log("\n🎉 完了！");
}

main().catch((e) => {
  console.error("❌ エラー:", e.message);
  if (e.data) console.error("詳細:", JSON.stringify(e.data, null, 2));
  if (e.code) console.error("コード:", e.code);
  process.exit(1);
});
