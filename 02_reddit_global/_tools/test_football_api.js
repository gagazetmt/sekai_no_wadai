// api-football.com 動作確認スクリプト
// 使い方: node test_football_api.js

require("dotenv").config();
const https = require("https");

const API_KEY = process.env.API_FOOTBALL_KEY;

function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "v3.football.api-sports.io",
      path,
      headers: {
        "x-apisports-key": API_KEY,
      },
    };

    https.get(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  console.log("=== API-Football 動作確認 ===\n");

  // ① アカウント情報・残コール数確認
  console.log("① アカウント情報確認中...");
  const status = await apiRequest("/status");
  if (status.errors && Object.keys(status.errors).length > 0) {
    console.log("❌ エラー:", status.errors);
    return;
  }
  const acct = status.response?.account;
  const sub  = status.response?.subscription;
  const req  = status.response?.requests;
  console.log(`✅ アカウント: ${acct?.firstname} ${acct?.lastname}`);
  console.log(`   プラン: ${sub?.plan}`);
  console.log(`   本日のコール数: ${req?.current} / ${req?.limit_day}`);

  console.log("\n② 本日のプレミアリーグ試合確認中...");
  // JSTで今日の日付を取得（UTC+9）
  const now = new Date();
  const jstOffset = 9 * 60 * 60 * 1000;
  const today = new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
  // プレミアリーグ = league ID 39, シーズン2025
  const fixtures = await apiRequest(`/fixtures?league=39&season=2025&date=${today}`);

  if (!fixtures.response || fixtures.response.length === 0) {
    console.log(`   本日(${today})のプレミアリーグ試合はなし`);
  } else {
    console.log(`   ${fixtures.response.length}試合あり！`);
    for (const f of fixtures.response) {
      const home = f.teams.home.name;
      const away = f.teams.away.name;
      const homeScore = f.goals.home ?? "-";
      const awayScore = f.goals.away ?? "-";
      const status = f.fixture.status.short;
      console.log(`   ${home} ${homeScore} - ${awayScore} ${away}  [${status}]`);
    }
  }

  console.log("\n③ 先週のプレミアリーグ試合結果（3/15確認）...");
  // 無料プランはlast/fromパラメータ不可 → 特定日付で確認
  const testDate = "2026-03-15";
  const recent = await apiRequest(`/fixtures?league=39&season=2025&date=${testDate}`);
  if (recent.response?.length > 0) {
    for (const f of recent.response) {
      const home = f.teams.home.name;
      const away = f.teams.away.name;
      const homeScore = f.goals.home ?? "-";
      const awayScore = f.goals.away ?? "-";
      console.log(`   ${testDate} | ${home} ${homeScore} - ${awayScore} ${away}`);
    }
  } else {
    console.log(`   ${testDate}の試合データなし`);
    console.log("   rawレスポンス:", JSON.stringify(recent).slice(0, 300));
  }

  console.log("\n=== 確認完了 ===");
}

main().catch(console.error);
