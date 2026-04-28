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
const REDDIT_SELECT_N   = parseInt(process.env.REDDIT_SELECT_N || '10', 10);   // env で上書き可
const FIVECH_SELECT_N   = parseInt(process.env.FIVECH_SELECT_N || '10', 10);   // env で上書き可
const REDDIT_MIN_SCORE  = parseInt(process.env.REDDIT_MIN_SCORE || '10', 10);  // 盛り上がり判定しきい値
const COMMENT_LIMIT     = 15;   // 1案件あたりのコメント取得数
const REDDIT_SOURCES    = ['hot', 'rising', 'new']; // 複数ソートから混ぜて取得

const VPS_HOST = "root@37.60.224.54";
const VPS_DEST = "/root/sekai_no_wadai/02_reddit_global/data/"; // V2ランチャーが読む場所に直接送る
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

// Reddit 取得（住宅プロキシ対応）
//  WEBSHARE_PROXY_URL が設定されていれば Webshare rotating residential 経由、
//  そうでなければ直叩き（ローカル住宅IP想定）
const axios = require('axios');
let _HttpsProxyAgent = null;
try { _HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch (_) {}

const PROXY_TPL_REDDIT = process.env.WEBSHARE_PROXY_URL || null;
function _pickRedditProxyAgent() {
  if (!PROXY_TPL_REDDIT || !_HttpsProxyAgent) return null;
  const n = Math.floor(Math.random() * 4000) + 1;
  const url = PROXY_TPL_REDDIT.includes('{N}')
    ? PROXY_TPL_REDDIT.replace('{N}', n)
    : PROXY_TPL_REDDIT;
  return new _HttpsProxyAgent(url);
}

async function redditGet(url) {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Accept':          'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const agent = _pickRedditProxyAgent();
  try {
    const res = await axios.get(url, {
      headers,
      timeout:    12000,
      httpsAgent: agent || undefined,
    });
    return res.data;
  } catch (e) {
    console.warn(`[Reddit] ${url.slice(0, 80)} → ${e.response?.status || e.code || e.message}`);
    return null;
  }
}

// ─── 翻訳・意訳エンジン (#1-6 強化版：サニタイズ＋小バッチ＋個別フォールバック) ──

// JSON サニタイズ＆パース（制御文字除去・最初の[...]または{...}を抽出）
function tryParseLenient(raw, wantArray = false) {
  if (!raw) return null;
  // 制御文字除去（\b \f \v + 00-08, 0B, 0C, 0E-1F）
  const CTRL_RE = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F]', 'g');
  const cleaned = raw
    .replace(CTRL_RE, ' ')
    // Claude が時々出す smart quotes を ASCII に
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");

  const pattern = wantArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const m = cleaned.match(pattern);
  if (!m) return null;

  try { return JSON.parse(m[0]); }
  catch (_) {
    // 二次フォールバック: 末尾が途切れている可能性 → 最後の完結要素まで切る
    try {
      const arr = m[0];
      // 最後の `}` までで閉じる試み
      const lastClose = wantArray ? arr.lastIndexOf(']') : arr.lastIndexOf('}');
      if (lastClose > 0) return JSON.parse(arr.slice(0, lastClose + 1));
    } catch (_) {}
    return null;
  }
}

// 1件を単独翻訳（バッチが失敗したときのフォールバック）
async function translateSingle(item) {
  const commentsText = item.comments.slice(0, 5).map(c => `- ${c.body}`).join('\n');
  const prompt = `以下のサッカー関連投稿を日本語に意訳してください。視聴者をクリックしたくさせる煽り・熱量を込めた表現で。

Title: ${item.title}
Comments:
${commentsText}

【重要】JSONのみ返すこと。文字列内の改行は \\n、引用符は \\" でエスケープ。制御文字・Smart Quotes 禁止。

{"titleJa": "日本語タイトル", "commentsJa": ["訳1", "訳2", "訳3", "訳4", "訳5"]}`;

  try {
    const raw = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    });
    return tryParseLenient(raw, false);
  } catch (_) { return null; }
}

// バッチ翻訳（3件ずつ）
async function translateBatch(batch) {
  const prompt = `以下のサッカー関連投稿を日本語に意訳してください。視聴者をクリックしたくさせる煽り・熱量で。

【入力】
${batch.map((it, i) => `[${i}] Title: ${it.title}\nComments:\n${it.comments.slice(0, 5).map(c => '- ' + c.body).join('\n')}`).join('\n\n')}

【重要ルール】JSONの配列のみ返す。文字列内の改行は \\n、引用符は \\" でエスケープ。制御文字・Smart Quotes 禁止。出力JSONは1行でも構わない。

[
  {"titleJa": "タイトル1", "commentsJa": ["コメ1a", "コメ1b", ...]},
  {"titleJa": "タイトル2", "commentsJa": [...]},
  ...
]`;

  try {
    const raw = await callAI({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages:   [{ role: 'user', content: prompt }],
    });
    return tryParseLenient(raw, true);
  } catch (_) { return null; }
}

async function translateCaptions(items) {
  const targets = items.filter(it => !it.titleJa);
  if (!targets.length) return items;

  console.log(`🤖 AI翻訳開始... (${targets.length}件)`);

  const BATCH = 3;
  const results = new Map(); // id → { titleJa, commentsJa }

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const parsed = await translateBatch(batch);

    if (Array.isArray(parsed) && parsed.length >= batch.length) {
      batch.forEach((it, j) => { if (parsed[j]) results.set(it.id, parsed[j]); });
      console.log(`  ✅ バッチ ${Math.floor(i/BATCH)+1}: ${batch.length}件`);
    } else {
      console.log(`  ⚠️ バッチ ${Math.floor(i/BATCH)+1} 失敗 → 個別翻訳へ`);
      for (const it of batch) {
        const single = await translateSingle(it);
        if (single) results.set(it.id, single);
        else console.log(`    ❌ 個別も失敗: ${it.title.slice(0, 40)}`);
        await new Promise(r => setTimeout(r, 300));
      }
    }
    await new Promise(r => setTimeout(r, 400));
  }

  const successCount = results.size;
  console.log(`🎯 翻訳完了: ${successCount}/${targets.length}件`);

  return items.map(it => {
    const res = results.get(it.id);
    if (!res) return it;
    return {
      ...it,
      titleJa: res.titleJa || it.title,
      comments: it.comments.map((c, ci) => ({ ...c, bodyJa: res.commentsJa?.[ci] || c.body })),
    };
  });
}

// ─── 案件収集メイン ────────────────────────────────────────────────────────────
async function main() {
  const { date, iso } = jstNow();
  console.log(`\n🚀 案件収集開始: ${iso}`);

  // 既存案件のIDセットを先に読込（既出除外用）
  const formattedDateForDedup = date.replace(/-/g, "_");
  const fileNameForDedup = path.join(DATA_DIR, `stories_${formattedDateForDedup}.json`);
  let existingIds = new Set();
  if (fs.existsSync(fileNameForDedup)) {
    try {
      const _ex = JSON.parse(fs.readFileSync(fileNameForDedup, "utf8"));
      existingIds = new Set((_ex.posts || []).map(p => p.id));
    } catch (_) {}
  }

  // 1. Redditから取得 (#1-4, #1-5) - hot/rising/new から混合取得して鮮度確保
  console.log("📡 Redditから案件を探索中... (hot+rising+new)");

  // 試合中の得点速報スレを除外（"Lazio [2]-1 Udinese - Pedro 80'" 等）
  //   - [N]-N または N-[N] パターン（角括弧が片側スコアを囲む = ライブ得点速報）
  //   - "Match Thread:" / "Pre-Match" / "Half Time:" / "Full Time:" 等の試合進行スレ
  //   - 末尾「N'」「N+M'」（試合中の経過分表記）= 角括弧なしでもライブ進行
  //   後段で post-match analysis を取り逃さないよう、ライブ進行系のみ厳選除外
  const REDDIT_NG_TITLE = /\[\d+\]\s*[-–]\s*\d+|\d+\s*[-–]\s*\[\d+\]|^Match\s+Thread:|^Pre[\s-]?Match\s+Thread:|^Half[\s-]?Time:|^Full[\s-]?Time:|\d+\+?\d*\s*['′ʼ]\s*$/i;

  const seen = new Map(); // permalink → post
  for (const sort of REDDIT_SOURCES) {
    const json = await redditGet(`https://www.reddit.com/r/soccer/${sort}.json?limit=50`);
    (json?.data?.children || [])
      .map(c => c.data)
      .filter(p => !p.stickied && p.score >= REDDIT_MIN_SCORE)  // ← ハードル: score閾値
      .filter(p => !REDDIT_NG_TITLE.test(p.title))               // ← 試合中速報スレ除外
      .forEach(p => {
        if (!seen.has(p.permalink)) {
          seen.set(p.permalink, {
            id: p.permalink, source: "reddit", title: p.title,
            url: "https://www.reddit.com" + p.permalink,
            score: p.score, numComments: p.num_comments,
            created_utc: p.created_utc, permalink: p.permalink,
            sortSource: sort, comments: [],
          });
        }
      });
  }
  // 既出除外 → スコア降順 → 上位N件（ハードル: score>=REDDIT_MIN_SCORE は前段で適用済）
  const fresh = Array.from(seen.values()).filter(p => !existingIds.has(p.permalink));
  const redditPosts = fresh
    .sort((a, b) => b.score - a.score)
    .slice(0, REDDIT_SELECT_N);
  console.log(`  📊 探索${seen.size}件 / 既出${seen.size - fresh.length}除外 / 残${fresh.length}件 → 上位${redditPosts.length}件選定 (score>=${REDDIT_MIN_SCORE})`);

  // 各Reddit案件のコメントを取得（AutoModerator/ボット系コメントは除外）
  //   除外対象: 自動投稿（ミラーリンク・統計スレ告知・bot自己紹介）
  //   "I am a bot" / "私は自動ボットです" / "MIRROR" / "重複投稿は削除されます" 等
  const REDDIT_BOT_BODY = /(I am a bot|私は自動ボットです|自動ボット|AutoModerator|Mirrors?:|ミラー[／\s]|別角度はこちら|重複投稿は削除されます|このスレは統計スレ|このコメントに返信でどうぞ|Stats Thread:|Beep boop)/i;
  // ボット投稿者名（authorベースでも弾く）
  const REDDIT_BOT_AUTHOR = /^(AutoModerator|MirrorBot|.*[Bb]ot)$/;

  for (const p of redditPosts) {
    const cJson = await redditGet(`https://www.reddit.com${p.permalink}.json?limit=${COMMENT_LIMIT * 2}&sort=top&depth=1`);
    const raw = cJson?.[1]?.data?.children || [];
    p.comments = raw
      .filter(c => c.kind === "t1" && c.data.body && c.data.body !== "[deleted]")
      .filter(c => !REDDIT_BOT_BODY.test(c.data.body))
      .filter(c => !REDDIT_BOT_AUTHOR.test(c.data.author || ''))
      .slice(0, COMMENT_LIMIT)
      .map(c => ({ body: c.data.body.slice(0, 500), score: c.data.score }));
  }

  // 2. 5chから取得 (#1-5)
  //    Reddit と同じく、dedup を slice の前に行う（5ch top スレは継続スレが多くて
  //    ほぼ固定なので、未取得分を上から優先選定しないと毎回同じ10件が弾かれる）
  console.log("📡 5chから案件を取得中...");
  const fivechRaw = await fetch5chCandidates(iso);
  const fivechFresh = fivechRaw.filter(p => !existingIds.has(p.id));
  const fivechPosts = fivechFresh.slice(0, FIVECH_SELECT_N);
  console.log(`  📊 5ch探索${fivechRaw.length}件 / 既出${fivechRaw.length - fivechFresh.length}除外 / 残${fivechFresh.length}件 → 上位${fivechPosts.length}件選定`);

  // 3. マージと翻訳 (#1-6)
  const combined = [...redditPosts, ...fivechPosts];
  if (!combined.length) { console.log("📭 新着案件なし。終了します。"); return; }

  const translated = await translateCaptions(combined);
  const finalItems = translated.map(it => ({ ...it, added_at: iso }));

  // 4. ファイル保存とマージ (#1-2)
  const fileName = fileNameForDedup;  // 冒頭で定義済み

  let existing = { posts: [] };
  if (fs.existsSync(fileName)) {
    existing = JSON.parse(fs.readFileSync(fileName, "utf8"));
  }

  // 既出ID再構築（保存直前に最新化、Reddit取得中に他プロセスが書き換えた可能性に保険）
  existingIds = new Set(existing.posts.map(p => p.id));
  const trulyNew = finalItems.filter(it => !existingIds.has(it.id));
  
  const allPosts = [...trulyNew, ...existing.posts].sort((a, b) => new Date(b.added_at) - new Date(a.added_at));
  fs.writeFileSync(fileName, JSON.stringify({ date, posts: allPosts }, null, 2));

  // 5. VPS送信（Windows からのみ。VPS 上では不要）
  if (process.platform === "win32") {
    const cmd = `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no "${fileName}" "${VPS_HOST}:${VPS_DEST}"`;
    try { execSync(cmd, { stdio: "inherit" }); } catch {}
  }

  console.log(`✅ 完了! 新規:${trulyNew.length}件 / 合計:${allPosts.length}件 -> ${path.basename(fileName)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
