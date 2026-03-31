// generate_text_content.js
// ローカルPC定時実行: candidates JSON のテキストコンテンツを AI 生成し VPS に送信
//
// 使い方:
//   node scripts/generate_text_content.js [YYYY-MM-DD] [--top=N]
//   --top=N : 生成対象件数（デフォルト: Reddit上位5 + RSS上位3 = 8件）
//
// 出力:
//   data/content_YYYY-MM-DD.json  ← テキスト全体 + 画像取得メタ情報
//   → SCP で VPS の temp/ に送信
//   → VPS API を呼び出して画像取得を自動開始

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs           = require("fs");
const path         = require("path");
const { execSync } = require("child_process");
const { callAI }   = require("./ai_client");

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const DATA_DIR  = path.join(__dirname, "..", "data");
const VPS_HOST  = "root@37.60.224.54";
const VPS_DEST  = "/root/sekai_no_wadai/02_reddit_global/temp/";
const VPS_API   = "http://100.116.25.91:3003";    // Tailscale IP
const SSH_KEY   = path.join(process.env.USERPROFILE || "C:\\Users\\USER", ".ssh", "id_ed25519");
const CONCURRENCY = 3;

const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const dateArg   = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a))
               || new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const topArg    = parseInt((process.argv.find(a => a.startsWith("--top=")) || "--top=8").replace("--top=", ""));

const TEAM_MANAGERS_PATH = path.join(__dirname, "..", "logos", "team_managers.json");
const _teamManagers = (() => {
  try { return JSON.parse(fs.readFileSync(TEAM_MANAGERS_PATH, "utf8")).managers || {}; }
  catch { return {}; }
})();
function lookupManagers(names) {
  const seen = new Set(), result = [];
  for (const n of names) { const m = _teamManagers[n]; if (m && !seen.has(m)) { seen.add(m); result.push(m); } }
  return result;
}

const LEAGUE_KW = ["Premier League","La Liga","Bundesliga","Ligue 1","Serie A",
  "Champions League","Europa League","Conference League","World Cup","FA Cup","Copa del Rey"];
function detectType(title) {
  const lower = title.toLowerCase();
  if ((lower.includes("post match thread")||lower.includes("post-match thread")) && LEAGUE_KW.some(k=>title.includes(k))) return "post-match";
  if (/transfer|signs for|joins|loan deal|contract extension|here we go/i.test(lower)) return "transfer";
  if (/injur|ruled out|muscle|hamstring|knee|ligament/i.test(lower)) return "injury";
  if (/sacked|fired|resign|appointed|new manager|new head coach/i.test(lower)) return "manager";
  return "topic";
}

// ─── AI ヘルパー ──────────────────────────────────────────────────────────────
async function translateKeywordToEnglish(text) {
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80,
      messages: [{ role: "user", content: `Translate this Japanese soccer news headline to English keywords for Twitter image search. Return only key search terms (max 60 chars, no quotes):\n${text}` }] });
    return raw.trim().slice(0, 60);
  } catch { return text.slice(0, 60); }
}

async function extractImageKeywords(title) {
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 60,
      messages: [{ role: "user", content: `Extract up to 3 English proper nouns (team names, player names, manager names) from this soccer news headline for image search. Return a JSON array only, e.g. ["England","Tuchel","Foden"]. No explanation.\n${title}` }] });
    const m = raw.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter(w => w && w.length >= 2).slice(0, 3) : [];
  } catch { return []; }
}

async function extractPlayerNames(title) {
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 80,
      messages: [{ role: "user", content: `Extract soccer player names only (not teams/countries/managers) from this headline. Return English names as a JSON array, max 3. E.g. ["Junya Ito","Erling Haaland"]. If none, return [].\n${title}` }] });
    const m = raw.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter(w => w && w.length >= 2).slice(0, 3) : [];
  } catch { return []; }
}

async function extractMatchData(thread, comments) {
  const prompt = `以下はRedditのサッカー試合スレッドです。構造化データとして抽出してください。
【スレッドタイトル】${thread.title}
【スレッド本文】${(thread.selftext||"").slice(0,1000)||"（本文なし）"}
【上位コメント（英語）】${comments.slice(0,10).join("\n")}
以下のJSON形式のみで出力してください。明記されていない情報は必ずnullにしてください。
{"homeTeam":"","awayTeam":"","homeScore":0,"awayScore":0,"league":"","leagueJa":"","matchday":null,"isKnockout":false,"aggregateScore":null,"teamThatAdvances":null,"goals":[{"player":"","team":"","minute":0,"type":"通常"}],"redCards":[{"player":"","team":"","minute":0}],"matchMood":"EXCITING"}`;
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 800, messages: [{ role: "user", content: prompt }] });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON not found");
    return JSON.parse(m[0]);
  } catch { return null; }
}

async function translateComments(comments) {
  const items = (comments||[]).filter(c=>c&&c.trim());
  if (!items.length) return comments||[];
  const prompt = `以下のサッカー関連コメントを自然な日本語に翻訳してください。先頭の「[👍123]」などのプレフィックスはそのまま残してください。JSON配列のみ返してください。
${items.map((t,i)=>`${i}: ${t}`).join("\n")}
出力形式: ["日本語訳0", "日本語訳1", ...]`;
  try {
    const raw = await callAI({ model: "claude-haiku-4-5-20251001", max_tokens: 2000, messages: [{ role: "user", content: prompt }] });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return comments;
    const translated = JSON.parse(m[0]);
    return items.map((_,i) => translated[i] || items[i]);
  } catch { return comments; }
}

// 試合コンテンツ生成プロンプト（generate_content.js と同一）
async function generateMatchContent(matchData, comments, thread, xComments=[]) {
  const goalsText = matchData.goals?.length > 0
    ? matchData.goals.map(g=>`${g.minute}分 ${g.player}（${g.team}）${g.type!=="通常"?`【${g.type}】`:""}`).join("、")
    : "得点なし";
  const knockoutNote = matchData.isKnockout && matchData.aggregateScore
    ? `\n2試合制ノックアウト: 総合スコア ${matchData.aggregateScore}（${matchData.teamThatAdvances??""}が勝ち抜け）` : "";
  const d = new Date(dateArg+"T00:00:00Z");
  const jstDateStr = `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;
  const prompt = `あなたは「リネカ」——20代前半、欧州サッカーに人生を捧げたクリエイティブ・ディレクターです。Reddit・Xの海外リアクションをリアルタイムで追い、「現地の温度感」を日本語に落とし込むプロ。以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。
━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル（最重要・この事件を動画化する）】${thread.title}
━━━━━━━━━━━━━━━━━━━━━━━━━
【コンテンツタイプ】post-match（試合後）
【絶対ルール】スレッドタイトルと試合データに存在しない人名・チーム名は絶対に使わない。架空の数字・記録は使わない。
【リネカの制作哲学】- ナレーションは「元気なニュースキャスター」口調。- ナレーション中に「Reddit」は絶対に使わず「海外サッカー掲示板」と表現。- 大会名・日付・スコア・主要得点者と分数を必ず盛り込む。- コメント意訳は「笑い・驚き・共感」のどれかを持たせる。
【試合データ】日付:${jstDateStr} 対戦:${matchData.homeTeam}vs${matchData.awayTeam} スコア:${matchData.homeScore}-${matchData.awayScore} 大会:${matchData.leagueJa||matchData.league}${knockoutNote} 得点:${goalsText} 退場:${matchData.redCards?.length>0?matchData.redCards.map(r=>`${r.minute}分 ${r.player}`).join("、"):"なし"} ムード:${matchData.matchMood||"EXCITING"}
【海外ファンの反応（Reddit）】${comments.slice(0,15).join("\n")}${xComments.length>0?`\n【X海外ファンの反応】\n${xComments.slice(0,15).join("\n")}`:""}
以下のJSON形式のみで出力してください：{"catchLine1":"サムネイル兼タイトル文（30文字以内）","label":"【速報】か【衝撃】か【朗報】か【悲報】","badge":"サブバッジ（8文字以内）","sourceAuthor":"情報元","sourceText":"核心テキスト（日本語・2〜4行）","overviewNarration":"S2ナレーション（80〜120文字・大会名・日付・スコア・得点者分数を必ず含む）","overviewTelop":"S2テロップ（25文字以内）","slide3":{"topicTag":"S3タグ（12文字以内・※で始まる）","highlightIdx":0,"narration":"S3ナレーション（60〜90文字）","subtitleBox":"S3字幕（20文字以内）","comments":[{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目（60〜80文字）"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"}]},"slide4":{"topicTag":"S4タグ（12文字以内・※で始まる・S3と別角度）","highlightIdx":0,"narration":"S4ナレーション（60〜90文字）","subtitleBox":"S4字幕（20文字以内）","comments":[{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"}]},"outroNarration":"S5ナレーション（20〜40文字）","outroTelop":"S5テロップ（18〜28文字・登録呼びかけ厳禁）","youtubeTitle":"YouTubeタイトル（SEO重視・40〜55文字）","hashtagsText":"ハッシュタグ（8〜10個・#サッカー #海外の反応 含む）"}`;
  const raw = await callAI({ model: "claude-sonnet-4-6", max_tokens: 2200, messages: [{ role: "user", content: prompt }] });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON not found");
  return JSON.parse(m[0]);
}

const TYPE_LABEL_MAP = { transfer:"移籍情報", injury:"負傷情報", manager:"監督情報", finance:"財政・制裁", topic:"注目トピック" };
async function generateTopicContent(topicData, comments, thread, xComments=[]) {
  const typeLabel = TYPE_LABEL_MAP[thread.type] || "注目トピック";
  const prompt = `あなたは「リネカ」——20代前半、欧州サッカーに人生を捧げたクリエイティブ・ディレクターです。以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。
━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル】${thread.title}
━━━━━━━━━━━━━━━━━━━━━━━━━
【コンテンツタイプ】${typeLabel}
【絶対ルール】存在しない人名・チーム名・数字は使わない。
【リネカの制作哲学】- ナレーションは「元気なニュースキャスター」口調。- 「Reddit」→「海外サッカー掲示板」。- コメント意訳は「笑い・驚き・共感」のどれか。
【スレッド本文】${(topicData.selftext||"").slice(0,800)||"（本文なし）"}
【海外ファンの反応（Reddit）】${comments.slice(0,15).join("\n")}${xComments.length>0?`\n【X海外ファンの反応】\n${xComments.slice(0,15).join("\n")}`:""}
以下のJSON形式のみで出力してください：{"catchLine1":"サムネイル兼タイトル文（30文字以内）","label":"【速報】か【衝撃】か【朗報】か【悲報】","badge":"サブバッジ（8文字以内）","sourceAuthor":"情報元","sourceText":"核心テキスト（日本語・2〜4行）","overviewNarration":"S2ナレーション（80〜120文字）","overviewTelop":"S2テロップ（25文字以内・誰が・何をしたか）","slide3":{"topicTag":"S3タグ（12文字以内・※で始まる）","highlightIdx":0,"narration":"S3ナレーション（60〜90文字）","subtitleBox":"S3字幕（20文字以内）","comments":[{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目（60〜80文字）"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"}]},"slide4":{"topicTag":"S4タグ（12文字以内・※で始まる・S3と別角度）","highlightIdx":0,"narration":"S4ナレーション（60〜90文字）","subtitleBox":"S4字幕（20文字以内）","comments":[{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"22〜28文字"}]},"outroNarration":"S5ナレーション（20〜40文字）","outroTelop":"S5テロップ（18〜28文字・登録呼びかけ厳禁）","youtubeTitle":"YouTubeタイトル（SEO重視・40〜55文字）","hashtagsText":"ハッシュタグ（8〜10個・#サッカー #海外の反応 含む）"}`;
  const raw = await callAI({ model: "claude-sonnet-4-6", max_tokens: 2200, messages: [{ role: "user", content: prompt }] });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON not found");
  return JSON.parse(m[0]);
}

// ─── SCP & VPS API 呼び出し ───────────────────────────────────────────────────
function scpToVps(localFile) {
  const cmd = `scp -i "${SSH_KEY}" -o StrictHostKeyChecking=no -o ConnectTimeout=15 "${localFile}" "${VPS_HOST}:${VPS_DEST}"`;
  execSync(cmd, { stdio: "inherit", timeout: 30000 });
  console.log(`📤 VPS送信完了: ${path.basename(localFile)}`);
}

async function triggerVpsImageFetch(date) {
  try {
    const res = await fetch(`${VPS_API}/api/soccer-yt/start-image-fetch`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ date }),
      signal:  AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (json.ok) console.log(`🖼  VPS画像取得ジョブ開始: ${date}`);
    else         console.warn(`⚠️  VPS画像取得トリガー失敗: ${json.error || "不明"}`);
  } catch (e) {
    console.warn(`⚠️  VPS API呼び出し失敗（Tailscale未接続？）: ${e.message}`);
    console.warn(`   手動起動: curl -X POST ${VPS_API}/api/soccer-yt/start-image-fetch -H 'Content-Type: application/json' -d '{"date":"${date}"}'`);
  }
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  const candidatesFile = path.join(DATA_DIR, `candidates_${dateArg}.json`);
  if (!fs.existsSync(candidatesFile)) {
    console.error(`❌ candidates_${dateArg}.json が見つかりません。先に fetch_daily_candidates.js を実行してください。`);
    process.exit(1);
  }

  const candidatesData = JSON.parse(fs.readFileSync(candidatesFile, "utf8"));
  const allPosts = (candidatesData.posts || []).map(p => ({ ...p, type: p.type || detectType(p.title||"") }));

  // 既存の content JSON があればスキップ対象を把握
  const contentFile = path.join(DATA_DIR, `content_${dateArg}.json`);
  const existingContent = fs.existsSync(contentFile) ? JSON.parse(fs.readFileSync(contentFile, "utf8")) : { posts: [] };
  const existingTitles = new Set(existingContent.posts.map(p => p._meta?.title).filter(Boolean));

  // 生成対象: Reddit上位N件 + RSS上位M件（スコア順）
  const REDDIT_LIMIT = Math.max(1, topArg - 3);
  const RSS_LIMIT    = Math.min(3, topArg);

  const redditCandidates = allPosts
    .filter(p => p.source === "reddit" && !existingTitles.has(p.title))
    .sort((a, b) => b.score - a.score)
    .slice(0, REDDIT_LIMIT);

  const rssCandidates = allPosts
    .filter(p => p.source === "rss" && !existingTitles.has(p.title))
    .sort((a, b) => b.created_utc - a.created_utc)
    .slice(0, RSS_LIMIT);

  const targets = [...redditCandidates, ...rssCandidates];

  const jst = new Date(Date.now() + jstOffset);
  console.log(`\n📝 テキストコンテンツ生成 (${dateArg}) — ${jst.toISOString().replace("Z","+09:00").slice(11,16)} JST`);
  console.log(`対象: ${targets.length}件 (Reddit${redditCandidates.length} + RSS${rssCandidates.length}) / スキップ済み: ${existingTitles.size}件`);
  console.log("─".repeat(50));

  const newPosts = [];

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (post, j) => {
      const num = i + j + 1;
      const isMatch = post.type === "post-match";
      console.log(`▶ [${num}/${targets.length}] [${post.type}] ${post.title.slice(0, 60)}`);

      // 事前取得済みコメントを文字列配列に変換
      const rawComments = (post.comments || []).map(c => `[👍${c.score||0}] ${c.body||""}`);
      const selftext = post.selftext || "";

      let matchData = null;
      let ytContent  = null;
      let xSearchQuery = "";
      let wikiWords  = [];

      if (isMatch) {
        // 試合データ抽出
        process.stdout.write(`  [${num}] 試合データ抽出... `);
        matchData = await extractMatchData({ title: post.title, selftext }, rawComments);
        if (!matchData) { console.log("⚠️ 失敗"); return null; }
        console.log(`✅ ${matchData.homeTeam} ${matchData.homeScore}-${matchData.awayScore} ${matchData.awayTeam}`);

        xSearchQuery = `${matchData.homeTeam} ${matchData.awayTeam}`.trim();
        const managers = lookupManagers([matchData.homeTeam, matchData.awayTeam]);
        wikiWords = [matchData.homeTeam, matchData.awayTeam, ...managers];

        process.stdout.write(`  [${num}] コンテンツ生成... `);
        ytContent = await generateMatchContent(matchData, rawComments, post);
        console.log("✅");
      } else {
        // キーワード抽出
        const rawQuery = post.title.replace(/^\[.*?\]\s*/g,"").slice(0, 80);
        const needsTranslation = /[\u3040-\u30ff\u4e00-\u9fff]/.test(rawQuery);
        const [engQuery, imgKeywords, playerNames] = await Promise.all([
          needsTranslation ? translateKeywordToEnglish(rawQuery) : Promise.resolve(rawQuery),
          extractImageKeywords(post.title),
          extractPlayerNames(post.title),
        ]);
        xSearchQuery = engQuery;
        const managers = lookupManagers(imgKeywords);
        wikiWords = [
          ...managers.filter(m => !imgKeywords.some(k => m.toLowerCase().includes(k.toLowerCase()))),
          ...playerNames,
        ].filter(Boolean);

        process.stdout.write(`  [${num}] コンテンツ生成... `);
        ytContent = await generateTopicContent({ selftext }, rawComments, post);
        console.log("✅");
      }

      // コメント翻訳
      const redditJa = await translateComments(rawComments);

      return {
        num,
        type:              post.type,
        catchLine1:        ytContent.catchLine1,
        label:             ytContent.label,
        badge:             ytContent.badge,
        sourceAuthor:      ytContent.sourceAuthor,
        sourceText:        ytContent.sourceText,
        overviewNarration: ytContent.overviewNarration,
        overviewTelop:     ytContent.overviewTelop,
        slide3:            ytContent.slide3,
        slide4:            ytContent.slide4,
        outroNarration:    ytContent.outroNarration,
        outroTelop:        ytContent.outroTelop,
        youtubeTitle:      ytContent.youtubeTitle,
        hashtagsText:      ytContent.hashtagsText,
        matchResult:       matchData ? {
          homeTeam:    matchData.homeTeam,
          awayTeam:    matchData.awayTeam,
          homeScore:   matchData.homeScore ?? 0,
          awayScore:   matchData.awayScore ?? 0,
          competition: matchData.leagueJa || matchData.league || "",
          matchday:    matchData.matchday || "",
          date:        dateArg,
          scorers:     (matchData.goals||[]).map(g=>({
            team: g.team===matchData.homeTeam?"home":"away", player: g.player, minute: g.minute||0
          })),
        } : null,
        // 画像取得ゼロ（VPS が埋める）
        imagePaths:      [],
        mainImagePath:   null,
        slide2ImagePath: null,
        slide3ImagePath: null,
        slide4ImagePath: null,
        slide5ImagePath: null,
        // VPS 画像取得指示
        _imgMeta: {
          title:       post.title,
          type:        post.type,
          source:      post.source,
          permalink:   post.permalink || null,
          url:         post.url || null,
          xSearchQuery,
          wikiWords,
          matchData:   matchData || null,
          imgFetched:  false,
        },
        _rawComments:   { reddit: rawComments, x: [] },
        _rawCommentsJa: { reddit: redditJa,    x: [] },
        _meta: {
          threadTitle: post.title,
          redditUrl:   post.url || (post.permalink ? `https://www.reddit.com${post.permalink}` : ""),
          threadType:  post.type,
        },
      };
    }));

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) newPosts.push(r.value);
      if (r.status === "rejected") console.warn(`⚠️ エラー: ${r.reason?.message}`);
    }
  }

  newPosts.sort((a, b) => a.num - b.num);

  // 既存コンテンツとマージ（同一タイトルは新規で上書き）
  const newTitles  = new Set(newPosts.map(p => p._meta?.threadTitle));
  const deduped    = existingContent.posts.filter(p => !newTitles.has(p._meta?.threadTitle));
  const merged     = [...newPosts, ...deduped];

  const outputData = {
    date:         dateArg,
    generated_at: new Date(Date.now() + jstOffset).toISOString().replace("Z","+09:00"),
    posts:        merged,
  };

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(contentFile, JSON.stringify(outputData, null, 2));
  console.log(`\n💾 保存: content_${dateArg}.json (${merged.length}件 / 今回生成${newPosts.length}件)`);

  // VPS に SCP 送信
  try {
    scpToVps(contentFile);
  } catch (e) {
    console.error(`❌ SCP失敗: ${e.message}`);
    return;
  }

  // VPS 画像取得ジョブを起動
  await triggerVpsImageFetch(dateArg);
  console.log("✅ Done.\n");
}

main().catch(e => { console.error(`❌ Fatal: ${e.message}`); process.exit(1); });
