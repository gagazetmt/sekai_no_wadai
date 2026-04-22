// fetch_daily_candidates.js
// 【 side-biz 改修版 】 定時実行スクリプト: 案件収集 (stories_YYYY_MM_DD.json)
// Reddit + 5ch から熱いネタを厳選・翻訳してマージする

require("dotenv").config({ path: require('path').join(__dirname, "..", ".env"), quiet: true });

const fs            = require("fs");
const path          = require("path");
const { execSync }  = require("child_process");
const { callAI }    = require("./ai_client");
const { fetch5chCandidates } = require("./modules/fetchers/5ch_fetcher");

// ─── 定数 (指示書 #1-4, #1-5 に基づき調整) ───────────────────────────────────────────
const DATA_DIR          = path.join(__dirname, "..", "data");
const HISTORY_FILE      = path.join(DATA_DIR, "seen_history.json");
const REDDIT_SELECT_N   = 10;   // Redditから10件
const FIVECH_SELECT_N   = 10;   // 5chから10件
const REDDIT_MIN_SCORE  = 20;   // 盛り上がり判定しきい値
const COMMENT_LIMIT     = 15;   // 1案件あたりのコメント取得数

const VPS_HOST = "root@37.60.224.54";
const VPS_DEST = "/root/sekai_no_wadai/02_reddit_global/temp/";
const SSH_KEY  = path.join(process.env.USERPROFILE || "C:\\Users\\USER", ".ssh", "id_ed25519");

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function jstNow() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const date = jst.toISOString().slice(0, 10);
  const hour = jst.getUTCHours();
  const iso  = jst.toISOString().replace("Z", "+09:00");
  return { date, hour, iso };
}

async function redditGet(url) {
  const headers = { "User-Agent": "soccer-news-bot/1.0" };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (res.ok) return res.json();
  } catch {}
  return null;
}

// ─── 翻訳・意訳エンジン (#1-6 強化) ───────────────────────────────────────────
async function translateCaptions(items) {
  const targets = items.filter(it => !it.titleJa);
  if (!targets.length) return items;

  const prompt = `あなたはサッカーメディアの敏腕編集者です。以下の海外ニュース案件とコメントを、日本の視聴者の心を掴むキャッチーな内容に翻訳してください。

【翻訳ルール】
1. 案件タイトル: 直訳ではなく、思わずクリックしたくなる「煽り」や「期待感」を込めた意訳を優先。
2. 選手・チーム名: 必ず一般的なカタカナ表記にする。
3. コメント: ネット掲示板特有の「熱量」や「ユーモア」を再現した面白い日本語にする。

【入力データ】
${targets.map((it, i) => `--- [ITEM ${i}] ---\nTitle: ${it.title}\nComments:\n${it.comments.map(c => `- ${c.body}`).join('\n')}`).join('\n\n')}

【出力形式】
JSONの配列形式で、タイトルとコメントのペアだけを返してください。
[
  { "titleJa": "タイトル", "commentsJa": ["コメ1", "コメ2"...] },
  ...
]`;

  try {
    console.log(`🤖 AI翻訳開始... (${targets.length}件)`);
    const raw = await callAI({ model: "claude-haiku", max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return items;
    const translated = JSON.parse(m[0]);

    const map = new Map(targets.map((it, i) => [it.id, translated[i]]));
    return items.map(it => {
      const res = map.get(it.id);
      if (res) {
        return {
          ...it,
          titleJa: res.titleJa || it.title,
          comments: it.comments.map((c, ci) => ({ ...c, bodyJa: res.commentsJa?.[ci] || c.body }))
        };
      }
      return it;
    });
  } catch (e) {
    console.error("❌ 翻訳エラー:", e.message);
    return items;
  }
}

// ─── 案件収集メイン ────────────────────────────────────────────────────────────
async function main() {
  const { date, iso } = jstNow();
  console.log(`\n🚀 案件収集開始: ${iso}`);

  // 1. Redditから取得 (#1-4, #1-5)
  console.log("📡 Redditから案件を探索中...");
  const redditJson = await redditGet("https://www.reddit.com/r/soccer/hot.json?limit=100");
  const redditPosts = (redditJson?.data?.children || [])
    .map(c => c.data)
    .filter(p => !p.stickied && p.score >= REDDIT_MIN_SCORE)
    .slice(0, REDDIT_SELECT_N)
    .map(p => ({
      id: p.permalink, source: "reddit", title: p.title, url: "https://www.reddit.com" + p.permalink,
      score: p.score, numComments: p.num_comments, created_utc: p.created_utc, permalink: p.permalink, comments: []
    }));

  // 各Reddit案件のコメントを取得
  for (const p of redditPosts) {
    const cJson = await redditGet(`https://www.reddit.com${p.permalink}.json?limit=${COMMENT_LIMIT}&sort=top&depth=1`);
    p.comments = (cJson?.[1]?.data?.children || [])
      .filter(c => c.kind === "t1" && c.data.body && c.data.body !== "[deleted]")
      .slice(0, COMMENT_LIMIT)
      .map(c => ({ body: c.data.body.slice(0, 500), score: c.data.score }));
  }

  // 2. 5chから取得 (#1-5)
  console.log("📡 5chから案件を取得中...");
  const fivechPosts = (await fetch5chCandidates(iso)).slice(0, FIVECH_SELECT_N);

  // 3. マージと翻訳 (#1-6)
  const combined = [...redditPosts, ...fivechPosts];
  if (!combined.length) { console.log("📭 新着案件なし。終了します。"); return; }

  const translated = await translateCaptions(combined);
  const finalItems = translated.map(it => ({ ...it, added_at: iso }));

  // 4. ファイル保存とマージ (#1-2)
  const formattedDate = date.replace(/-/g, "_");
  const fileName = path.join(DATA_DIR, `stories_${formattedDate}.json`);
  
  let existing = { posts: [] };
  if (fs.existsSync(fileName)) {
    existing = JSON.parse(fs.readFileSync(fileName, "utf8"));
  }

  const existingIds = new Set(existing.posts.map(p => p.id));
  const trulyNew = finalItems.filter(it => !existingIds.has(it.id));
  
  const allPosts = [...trulyNew, ...existing.posts].sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
  fs.writeFileSync(fileName, JSON.stringify({ date, posts: allPosts }, null, 2));

  // 5. VPS送信
  const cmd = `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${fileName}" "${VPS_HOST}:${VPS_DEST}"`;
  try { execSync(cmd, { stdio: "inherit" }); } catch {}

  console.log(`✅ 完了! 新規:${trulyNew.length}件 / 合計:${allPosts.length}件 -> ${path.basename(fileName)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
