// compare_deepseek_script.js
// deepseek-chat vs deepseek-reasoner の脚本生成品質・速度比較
//
// 使い方:
//   node scripts/compare_deepseek_script.js [candidates_YYYY-MM-DD.json内の投稿インデックス]
//   例: node scripts/compare_deepseek_script.js 1

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env"), quiet: true });
const fs     = require("fs");
const path   = require("path");
const OpenAI = require("openai");

const postIdx = parseInt(process.argv[2] ?? "1");

// ─── DeepSeekクライアント ─────────────────────────────────────────────────────
const deepseek = new OpenAI({
  apiKey:  process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

// ─── 候補データ読み込み ────────────────────────────────────────────────────────
const now       = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const dateStr   = new Date(now.getTime() + jstOffset).toISOString().slice(0, 10);
const dataDir   = path.join(__dirname, "..", "data");

// 最新のcandidatesファイルを探す
let candidatesFile = path.join(dataDir, `candidates_${dateStr}.json`);
if (!fs.existsSync(candidatesFile)) {
  // 過去7日分を探す
  for (let d = 1; d <= 7; d++) {
    const tryDate = new Date(now.getTime() + jstOffset - d * 86400000).toISOString().slice(0, 10);
    const tryFile = path.join(dataDir, `candidates_${tryDate}.json`);
    if (fs.existsSync(tryFile)) { candidatesFile = tryFile; break; }
  }
}

if (!fs.existsSync(candidatesFile)) {
  console.error("❌ candidatesファイルが見つかりません");
  process.exit(1);
}

const candidatesData = JSON.parse(fs.readFileSync(candidatesFile, "utf8"));
const posts = candidatesData.posts || [];
const post  = posts[postIdx];

if (!post) {
  console.error(`❌ インデックス${postIdx}の投稿が存在しません（全${posts.length}件）`);
  process.exit(1);
}

// ─── プロンプト構築（generate_text_content.js と同一ロジック） ─────────────────
const comments = (post.comments || []).map(c => `[👍${c.score||0}] ${c.body||""}`);
const TYPE_LABEL_MAP = { transfer:"移籍情報", injury:"負傷情報", manager:"監督情報", finance:"財政・制裁", topic:"注目トピック" };
const typeLabel = TYPE_LABEL_MAP[post.type] || "注目トピック";

const prompt = `あなたはサッカーニュース動画のコンテンツライターです。以下のデータをもとに、視聴者が冒頭10秒で離脱できない動画コンテンツを設計してください。
━━━━━━━━━━━━━━━━━━━━━━━━━
【スレッドタイトル】${post.title}
━━━━━━━━━━━━━━━━━━━━━━━━━
【コンテンツタイプ】${typeLabel}
【絶対ルール】存在しない人名・チーム名・数字は使わない。監督名・選手名・所属クラブはスレッドまたは提供データに明記されている場合のみ使用し、記載のない情報は推測・補完しないこと。
【トーン指定（10段階中6）】NHKニュースを10、5chスレを0とする。基本はニュース解説口調を維持すること。ただし「これは注目ですね」「驚きの展開です」程度の軽い感嘆は自然に入れてよい。ニュースキャスターが少しだけ砕けた感じ。
【制作ルール】- 「Reddit」→「海外サッカー掲示板」。- コメント意訳は「笑い・驚き・共感」のどれか。- コメントは必ず7件全て日本語で書くこと。- ナレーション・字幕・コメント全ての文章は日本語で書くこと。英語の選手名・チーム名・大会名はカタカナ表記。
【スレッド本文】${(post.selftext||"").slice(0,800)||"（本文なし）"}
【海外ファンの反応（Reddit）】${comments.slice(0,15).join("\n")}
以下のJSON形式のみで出力してください：{"catchLine1":"サムネイル兼タイトル文（30文字以内）","label":"【速報】か【衝撃】か【朗報】か【悲報】","badge":"サブバッジ（8文字以内）","sourceAuthor":"情報元","sourceText":"核心テキスト（日本語・2〜4行）","overviewNarration":"S2ナレーション（80〜120文字）","overviewTelop":"S2テロップ（25文字以内）","slide3":{"topicTag":"S3タグ（12文字以内・※で始まる）","highlightIdx":0,"narration":"S3ナレーション（60〜90文字）","subtitleBox":"S3字幕（20文字以内）","comments":[{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目（日本語60〜80文字）"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"}]},"slide4":{"topicTag":"S4タグ（12文字以内・※で始まる・S3と別角度）","highlightIdx":0,"narration":"S4ナレーション（60〜90文字）","subtitleBox":"S4字幕（20文字以内）","comments":[{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"},{"user":"英語圏名","text":"1行目\\n2行目"},{"user":"英語圏名","text":"日本語22〜28文字"}]},"outroNarration":"S5ナレーション（20〜40文字）","outroTelop":"S5テロップ（18〜28文字・登録呼びかけ厳禁）","youtubeTitle":"YouTubeタイトル（SEO重視・40〜55文字）","hashtagsText":"ハッシュタグ（8〜10個・#サッカー #海外の反応 含む）"}`;

// ─── モデル呼び出し ────────────────────────────────────────────────────────────
async function callModel(modelId, label) {
  const start = Date.now();
  process.stdout.write(`⏳ [${label}] 生成中...`);

  const messages = [{ role: "user", content: prompt }];

  // reasoner は推論トークン+出力トークンの合計が max_tokens に収まる必要があるため多めに確保
  const maxTokens = modelId === "deepseek-reasoner" ? 8000 : 2200;

  const res = await deepseek.chat.completions.create({
    model:      modelId,
    max_tokens: maxTokens,
    messages,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const raw     = res.choices[0].message.content || "";
  // reasonerはreasoning_contentも返す
  const reasoning = res.choices[0].message.reasoning_content || null;

  // JSON抽出
  let parsed = null;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { /* JSON解析失敗 */ }

  // トークン情報
  const usage = res.usage || {};

  console.log(` 完了 (${elapsed}秒)`);

  return { label, elapsed, raw, parsed, reasoning, usage };
}

// ─── 結果表示 ─────────────────────────────────────────────────────────────────
function printResult(r) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`📊 【${r.label}】  ⏱ ${r.elapsed}秒`);
  console.log(`   入力トークン: ${r.usage.prompt_tokens || "-"}  /  出力トークン: ${r.usage.completion_tokens || "-"}`);
  if (r.reasoning) {
    console.log(`   推論トークン: ${r.usage.completion_tokens_details?.reasoning_tokens || "-"}`);
  }
  console.log("─".repeat(60));

  if (!r.parsed) {
    console.log("❌ JSON解析失敗。生出力:");
    console.log(r.raw.slice(0, 500));
    return;
  }

  const p = r.parsed;
  console.log(`🎯 タイトル文 : ${p.catchLine1}`);
  console.log(`🏷  ラベル     : ${p.label}  バッジ: ${p.badge}`);
  console.log(`📝 核心テキスト:`);
  console.log(`   ${p.sourceText}`);
  console.log(`🎙 S2ナレーション:`);
  console.log(`   ${p.overviewNarration}`);
  console.log(`💬 S3コメント例:`);
  (p.slide3?.comments || []).slice(0, 3).forEach(c => console.log(`   [${c.user}] ${c.text.replace(/\n/g, " / ")}`));
  console.log(`🎙 S3ナレーション:`);
  console.log(`   ${p.slide3?.narration}`);
  console.log(`📺 YouTubeタイトル:`);
  console.log(`   ${p.youtubeTitle}`);
  console.log(`🏷  ハッシュタグ:`);
  console.log(`   ${p.hashtagsText}`);
}

// ─── メイン ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🔬 DeepSeek モデル比較`);
  console.log(`📰 投稿[${postIdx}]: ${post.title.slice(0, 70)}`);
  console.log(`   コメント数: ${comments.length}件`);
  console.log("─".repeat(60));
  console.log("2モデルを並列で呼び出します...\n");

  const [chatResult, reasonerResult] = await Promise.all([
    callModel("deepseek-chat",     "deepseek-chat（通常）"),
    callModel("deepseek-reasoner", "deepseek-reasoner（推論強化）"),
  ]);

  // 結果表示
  printResult(chatResult);
  printResult(reasonerResult);

  // 速度比較サマリー
  console.log(`\n${"═".repeat(60)}`);
  console.log("⚡ 速度比較サマリー");
  console.log(`   deepseek-chat     : ${chatResult.elapsed}秒`);
  console.log(`   deepseek-reasoner : ${reasonerResult.elapsed}秒`);
  const diff = (parseFloat(reasonerResult.elapsed) - parseFloat(chatResult.elapsed)).toFixed(1);
  console.log(`   差分              : ${diff > 0 ? "+" : ""}${diff}秒 (reasonerが${diff > 0 ? "遅い" : "速い"})`);

  // 結果をファイルにも保存
  const outFile = path.join(__dirname, "..", "data", `deepseek_compare_${dateStr}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    date: dateStr,
    postTitle: post.title,
    chat:     { elapsed: chatResult.elapsed,     result: chatResult.parsed,     usage: chatResult.usage },
    reasoner: { elapsed: reasonerResult.elapsed, result: reasonerResult.parsed, usage: reasonerResult.usage },
  }, null, 2));
  console.log(`\n💾 比較結果保存: ${outFile}`);
}

main().catch(e => { console.error(`❌ Fatal: ${e.message}`); process.exit(1); });
