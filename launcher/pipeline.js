// launcher/pipeline.js
// 全工程オーケストレーター（フェーズ分割対応）
//
// CLI:
//   node pipeline.js                       → scout から全自動
//   node pipeline.js --topic "三笘がMVP"   → 指定トピックから開始
//
// Dashboard:
//   phaseScout / phaseResearch / phasePlan / phaseRender を個別呼び出し

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');

const { scoutWithAI }        = require('./scout');
const { research }           = require('./research');
const { extractViewpoints }  = require('./viewpoints');
const { generateScript, generateMods } = require('./script_gen');
const { generateNarration }  = require('./narration');
const { renderAll }          = require('./render');
const { buildFinalVideo }    = require('./concat');
const { getPattern, listPatterns, buildPiecesPattern } = require('./slide_patterns');
const { resolveAllImages }   = require('./fetchers/images');
const { whisperAll }         = require('./whisper');
const { generateThumbnail }  = require('./thumbnail');

const STEPS = [
  { id: 'scout',    label: '案件取得',              num: 1 },
  { id: 'research', label: '記事・データ・画像取得', num: 2 },
  { id: 'plan',     label: '企画ピース生成',         num: 3 },
  { id: 'render',   label: '脚本生成→レンダリング',  num: 4 },
  { id: 'meta',     label: 'サムネ＋投稿メタ',       num: 5 },
];

const RENDER_SUB_STEPS = [
  { id: 'script',    label: '脚本生成' },
  { id: 'images',    label: '画像取得' },
  { id: 'narration', label: 'ナレーション' },
  { id: 'whisper',   label: '字幕生成' },
  { id: 'render',    label: 'レンダリング' },
  { id: 'concat',    label: '動画結合' },
];

// ── 出力ディレクトリ ──────────────────────────────────

function makeOutputDir(topic) {
  const ts = new Date().toISOString().slice(0, 10);
  const slug = topic.slice(0, 30).replace(/[^\w　-鿿]/g, '_').replace(/_+/g, '_');
  const dir = path.join(__dirname, 'output', `${ts}_${slug}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── イベント発行ヘルパー ─────────────────────────────

function _emit(emitter, type, data) {
  if (!emitter) return;
  try { emitter.emit('pipeline', { type, ts: Date.now(), ...data }); }
  catch (_) {}
}

// ══════════════════════════════════════════════════════
//  フェーズ関数（Dashboard から個別呼び出し可能）
// ══════════════════════════════════════════════════════

async function phaseScout(options = {}) {
  console.log('── Phase 1: Scout ──');
  if (options.topic) {
    console.log(`  Topic (manual): ${options.topic}`);
    return [{ title: options.topic, source: 'manual' }];
  }
  const topics = await scoutWithAI();
  console.log(`  ${topics.length} topics found`);
  return topics;
}

async function phaseResearch(topic, options = {}) {
  console.log('── Phase 2: Research ──');
  const facts = await research(topic, {
    homeTeam: options.homeTeam || null,
    awayTeam: options.awayTeam || null,
    playerName: options.playerName || null,
    searchQuery: options.searchQuery || null,
  });
  const summary = {
    articles: facts.articles?.length || 0,
    comments: facts.comments?.all?.length || 0,
    hasPlayerData: !!facts.playerData,
    hasMatchData: !!facts.matchData,
  };
  console.log(`  Articles: ${summary.articles} / Comments: ${summary.comments}`);
  return { facts, summary };
}

async function phasePlan(facts) {
  console.log('── Phase 3: Plan ──');
  const viewpoints = await extractViewpoints(facts);
  return viewpoints;
}

async function phaseRender(topic, patternKey, facts, emitter, prebuiltMods = null) {
  console.log('── Phase 4: Render ──');
  const outputDir = makeOutputDir(topic);

  // Sub 1: Script (mods)
  let mods;
  if (prebuiltMods) {
    mods = prebuiltMods;
    console.log(`  [4-1] Using prebuilt mods (${mods.length} slides)`);
    _emit(emitter, 'sub_step', { step: 'script', status: 'done', detail: `${mods.length}スライド（編集済み）` });
  } else {
    _emit(emitter, 'sub_step', { step: 'script', status: 'running' });
    console.log('  [4-1] Script generation...');
    mods = await generateMods(patternKey, topic, facts);
    console.log(`  [4-1] → ${mods.length} mods (${patternKey})`);
    _emit(emitter, 'sub_step', { step: 'script', status: 'done', detail: `${mods.length}スライド` });
  }
  fs.writeFileSync(
    path.join(outputDir, 'script.json'),
    JSON.stringify({ topic, patternKey, mods }, null, 2)
  );

  // Sub 2: Images
  _emit(emitter, 'sub_step', { step: 'images', status: 'running' });
  console.log('  [4-2] Image resolution...');
  await resolveAllImages(mods, facts);
  const imgCount = mods.filter(m => m.bgImage || m.leftImage || m.rightImage).length;
  console.log(`  [4-2] → ${imgCount}/${mods.length} resolved`);
  _emit(emitter, 'sub_step', { step: 'images', status: 'done', detail: `${imgCount}/${mods.length}枚` });

  // Sub 3: Narration
  _emit(emitter, 'sub_step', { step: 'narration', status: 'running' });
  console.log('  [4-3] Narration...');
  let narrationResult;
  try {
    narrationResult = await generateNarration(patternKey, mods, outputDir);
  } catch (err) {
    console.warn(`  Narration failed: ${err.message}`);
    narrationResult = {
      narrations: mods.map(() => ''),
      audioFiles: mods.map(() => null),
      durations: mods.map(() => 10),
    };
  }
  const { audioFiles, durations } = narrationResult;
  _emit(emitter, 'sub_step', { step: 'narration', status: 'done', detail: `${durations.length}本` });

  // Sub 4: Whisper
  _emit(emitter, 'sub_step', { step: 'whisper', status: 'running' });
  console.log('  [4-4] Whisper...');
  const leadPad    = parseFloat(process.env.LEAD_PAD_SEC)    || 0.5;
  const tailPad    = parseFloat(process.env.TAIL_PAD_SEC)    || 0.3;
  const commentPad = parseFloat(process.env.COMMENT_PAD_SEC) || 3.0;

  let whisperResults;
  try {
    whisperResults = await whisperAll(audioFiles, leadPad);
  } catch (err) {
    console.warn(`  Whisper failed: ${err.message}`);
    whisperResults = audioFiles.map(() => ({ chunks: [], narrationEndSec: leadPad, words: [] }));
  }
  mods.forEach((mod, i) => {
    const wr = whisperResults[i] || {};
    mod.subtitleChunks = wr.chunks || [];
    mod.narrationEndSec = wr.narrationEndSec || (leadPad + durations[i]);
  });
  const totalChunks = whisperResults.reduce((a, r) => a + (r.chunks?.length || 0), 0);
  _emit(emitter, 'sub_step', { step: 'whisper', status: 'done', detail: `${totalChunks}チャンク` });

  // Sub 5: Render
  _emit(emitter, 'sub_step', { step: 'render', status: 'running' });
  console.log('  [4-5] Render...');
  // pieces_N は動的パターン: mod.type から再構築
  const pattern = patternKey.startsWith('pieces_')
    ? buildPiecesPattern(mods.slice(1, -1).map(m => m.type || 'insight'))
    : getPattern(patternKey);
  const renderDurations = durations.map((d, i) => {
    const slotType = (pattern.slides[i] || {}).type || mods[i].type || 'insight';
    const isBookend = slotType === 'opening' || slotType === 'ending';
    return d + leadPad + tailPad + (isBookend ? 0 : commentPad);
  });
  const videoFiles = await renderAll(patternKey, mods, renderDurations, outputDir);
  _emit(emitter, 'sub_step', { step: 'render', status: 'done', detail: `${videoFiles.length}スライド` });

  // Sub 6: Concat
  _emit(emitter, 'sub_step', { step: 'concat', status: 'running' });
  console.log('  [4-6] Concat...');
  const finalVideo = buildFinalVideo(videoFiles, audioFiles, outputDir, 'final.mp4');
  const totalDuration = renderDurations.reduce((s, d) => s + d, 0).toFixed(1);
  _emit(emitter, 'sub_step', { step: 'concat', status: 'done', detail: `${totalDuration}s` });

  // Sub 7: Thumbnail
  let thumbnailPath = null;
  try {
    const openingMod = mods[0] || {};
    const contentMod = mods[1] || {};
    const badge = openingMod.badge || '速報';
    const bgImageUrl = contentMod.bgImage || openingMod.bgImage || null;
    thumbnailPath = await generateThumbnail({
      title: topic,
      badge,
      bgImageUrl,
      outputPath: path.join(outputDir, 'thumbnail.jpg'),
    });
    _emit(emitter, 'sub_step', { step: 'thumbnail', status: 'done', detail: 'thumbnail.jpg' });
  } catch (err) {
    console.warn(`  Thumbnail failed: ${err.message}`);
  }

  return {
    topic, patternKey, mods, outputDir, finalVideo,
    totalDuration: parseFloat(totalDuration),
    videoFiles, audioFiles, thumbnailPath,
  };
}

async function phaseMeta(renderResult) {
  console.log('── Phase 5: Meta ──');
  const key = process.env.DEEPSEEK_API_KEY;
  const { topic, mods } = renderResult;

  // narration テキストを集めてコンテキスト生成
  const narrationTexts = (mods || [])
    .filter(m => m.narration && m.type !== 'opening' && m.type !== 'ending')
    .map(m => m.narration)
    .join('\n');

  const defaultMeta = {
    title: topic,
    description: `${topic}\n\n#サッカー #速報 #W杯2026`,
    tags: ['サッカー', 'W杯2026', '速報', 'FIFA', topic.slice(0, 20)],
  };

  if (!key) {
    console.log('  [meta] DeepSeek key なし → デフォルトメタ');
    return defaultMeta;
  }

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: 'deepseek-chat', temperature: 0.5, max_tokens: 600,
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: `あなたはYouTubeのSEO専門家です。サッカー動画の投稿メタデータをJSONで返してください。
【出力フォーマット】
{
  "title": "YouTube動画タイトル（50文字前後・数字や「！」を使って目を引く）",
  "description": "概要欄テキスト（200〜400文字。1行目はタイトルの補足、改行後に内容箇条書き、最後にハッシュタグ5個）",
  "tags": ["タグ1","タグ2",...] （15個以内）
}
JSONのみ返す。`
        }, {
          role: 'user',
          content: `トピック: ${topic}\n\n内容:\n${narrationTexts.slice(0, 600)}`,
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
    const d = await res.json();
    const meta = JSON.parse(d.choices[0].message.content);
    console.log(`  [meta] title: ${meta.title}`);
    return {
      title: meta.title || defaultMeta.title,
      description: meta.description || defaultMeta.description,
      tags: Array.isArray(meta.tags) ? meta.tags : defaultMeta.tags,
    };
  } catch (e) {
    console.warn(`  [meta] failed: ${e.message}`);
    return defaultMeta;
  }
}

// ══════════════════════════════════════════════════════
//  CLI 全自動実行（従来互換）
// ══════════════════════════════════════════════════════

async function runPipeline(options = {}) {
  const startTime = Date.now();
  const em = options.emitter || null;

  console.log('╔══════════════════════════════════════╗');
  console.log('║    ⚽ Soccer Video Pipeline V5       ║');
  console.log('╚══════════════════════════════════════╝\n');

  // Phase 1: Scout
  _emit(em, 'step', { step: 'scout', status: 'running' });
  const topics = await phaseScout(options);
  if (!topics.length) { console.error('No topics found.'); return null; }
  const topic = topics[0].title || topics[0].text;
  _emit(em, 'step', { step: 'scout', status: 'done', detail: topic });

  // Phase 2: Research
  _emit(em, 'step', { step: 'research', status: 'running' });
  const { facts, summary } = await phaseResearch(topic, options);
  _emit(em, 'step', { step: 'research', status: 'done', detail: `記事${summary.articles}件` });

  // Phase 3: Plan
  _emit(em, 'step', { step: 'plan', status: 'running' });
  const viewpoints = await phasePlan(facts);
  if (!viewpoints.length) { console.error('No viewpoints.'); return null; }
  const vp = viewpoints[0];
  const videoTopic = vp.title || topic;
  const patternKey = vp.suggestedPattern || 'match_result';
  _emit(em, 'step', { step: 'plan', status: 'done', detail: vp.angle });

  // Phase 4: Render
  _emit(em, 'step', { step: 'render', status: 'running' });
  const result = await phaseRender(videoTopic, patternKey, facts, em);
  _emit(em, 'step', { step: 'render', status: 'done', detail: `${result.totalDuration}s` });

  // Phase 5: Meta
  _emit(em, 'step', { step: 'meta', status: 'running' });
  const meta = await phaseMeta(result);
  _emit(em, 'step', { step: 'meta', status: 'done', detail: 'placeholder' });

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Pipeline Complete: ${totalTime}s / ${result.finalVideo}`);

  const fullResult = { ...result, viewpoints, meta, totalTime: parseFloat(totalTime) };
  _emit(em, 'done', fullResult);
  return fullResult;
}

// ── CLI ───────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--topic':  options.topic = args[++i]; break;
      case '--home':   options.homeTeam = args[++i]; break;
      case '--away':   options.awayTeam = args[++i]; break;
      case '--player': options.playerName = args[++i]; break;
    }
  }
  runPipeline(options)
    .then(r => { if (r) console.log('\nDone!'); else process.exit(1); })
    .catch(err => { console.error('\nFatal:', err); process.exit(1); });
}

module.exports = {
  runPipeline, STEPS, RENDER_SUB_STEPS,
  phaseScout, phaseResearch, phasePlan, phaseRender, phaseMeta,
  makeOutputDir, listPatterns,
};
