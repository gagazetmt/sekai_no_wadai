// webhook_server.js
// GitHubからpush通知を受け取り、git pull → pm2 restart を自動実行
// 起動: pm2 start webhook_server.js --name webhook

require("dotenv").config();
const http   = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const PORT   = 9000;
const SECRET = process.env.WEBHOOK_SECRET || "changeme";
const REPO_DIR = "/root/sekai_no_wadai/02_reddit_global";

function verify(req, body) {
  const sig = req.headers["x-hub-signature-256"];
  if (!sig) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404); res.end("not found"); return;
  }

  let body = "";
  req.on("data", d => body += d);
  req.on("end", () => {
    if (!verify(req, body)) {
      console.log("❌ 署名検証失敗");
      res.writeHead(401); res.end("unauthorized"); return;
    }

    const event = req.headers["x-github-event"];
    if (event !== "push") {
      res.writeHead(200); res.end("ok"); return;
    }

    console.log("📦 Push検知 → git pull & pm2 restart 開始");
    res.writeHead(200); res.end("ok");

    const cmd = `cd ${REPO_DIR}/.. && git pull && cd ${REPO_DIR} && npm install --omit=dev && pm2 restart soccer-yt`;
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ エラー:", err.message);
        return;
      }
      console.log("✅ デプロイ完了");
      if (stdout) console.log(stdout);
      if (stderr) console.error(stderr);
    });
  });
}).listen(PORT, () => {
  console.log(`🔗 Webhookサーバー起動 port:${PORT}`);
});
