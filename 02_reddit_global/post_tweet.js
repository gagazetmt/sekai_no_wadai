// GitHub Actions用 X自動投稿スクリプト
// 現在のJST時刻からスケジュールを照合して投稿する

require("dotenv").config();
const { TwitterApi } = require("twitter-api-v2");
const fs = require("fs");
const path = require("path");

const SCHEDULE_TIMES = [
  "06:00", "06:30", "07:00", "07:30", "08:00",
  "20:00", "20:30", "21:00", "21:30", "22:00",
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

  // 今日のJSONファイルを読む
  const TEMP_DIR = path.join(__dirname, "temp");
  const jsonPath = path.join(TEMP_DIR, `generated_${jstDateStr}.json`);

  if (!fs.existsSync(jsonPath)) {
    console.error(`❌ JSONファイルが見つかりません: ${jsonPath}`);
    console.error("generate_post.js を先に実行してJSONをpushしてください。");
    process.exit(1);
  }

  const { posts } = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const post = posts[postIndex];

  if (!post) {
    console.error(`❌ 投稿${postIndex + 1}のデータが見つかりません`);
    process.exit(1);
  }

  console.log(`\n投稿文:\n${post.postText}`);
  console.log(`元ネタURL: ${post.sourceUrl}`);

  // X APIクライアント初期化
  const xClient = new TwitterApi({
    appKey: process.env.X_API_KEY,
    appSecret: process.env.X_API_SECRET,
    accessToken: process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  });

  // ツイート投稿
  const tweet = await xClient.v2.tweet({ text: post.postText });
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
  process.exit(1);
});
