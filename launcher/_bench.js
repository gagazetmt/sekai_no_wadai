// 1件フル計測スクリプト  node launcher/_bench.js
// ダッシュボードと同じ工程（research→画像→企画書→脚本→画像解決→TTS→字幕→レンダ）を通す
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');

const { research, fetchMatch, fetchPlayer } = require('./research');
const { generateModsAuto, generateBrief } = require('./script_gen');
const { generateNarration }  = require('./narration');
const { whisperAll }         = require('./whisper');
const { renderAll }          = require('./render');
const { buildFinalVideo }    = require('./concat');
const { buildPiecesPattern } = require('./slide_patterns');
const { resolveAllImages }   = require('./fetchers/images');

const TOPIC = process.argv[2] || 'エムバペ W杯2026 最多得点記録';

const results = [];
let dsTokens = { prompt: 0, completion: 0 };
let oaTokens = { prompt: 0, completion: 0 };  // gpt-4o-mini（コメント判定等）
let anTokens = { input: 0, output: 0 };       // Haiku（監修）
let xApiCalls = 0;                            // TwitterAPI.io リクエスト数
let mmChars   = 0;

const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  const res = await origFetch(url, opts);
  const u = typeof url === 'string' ? url : (url && url.url) || '';
  if (u.includes('twitterapi.io')) xApiCalls++;
  if (u.includes('deepseek.com')) {
    res.clone().json().then(d => {
      const us = d && d.usage;
      if (us) { dsTokens.prompt += us.prompt_tokens||0; dsTokens.completion += us.completion_tokens||0; }
    }).catch(()=>{});
  }
  if (u.includes('api.openai.com/v1/chat')) {
    res.clone().json().then(d => {
      const us = d && d.usage;
      if (us) { oaTokens.prompt += us.prompt_tokens||0; oaTokens.completion += us.completion_tokens||0; }
    }).catch(()=>{});
  }
  if (u.includes('api.anthropic.com')) {
    res.clone().json().then(d => {
      const us = d && d.usage;
      if (us) { anTokens.input += us.input_tokens||0; anTokens.output += us.output_tokens||0; }
    }).catch(()=>{});
  }
  return res;
};

async function step(num, name, fn) {
  const t0 = Date.now();
  process.stdout.write('[' + num + '] ' + name + '... ');
  try {
    const ret = await fn();
    const ms  = Date.now() - t0;
    console.log('OK ' + (ms/1000).toFixed(1) + 's');
    results.push({ num, name, ok: true, ms, data: ret });
    return ret;
  } catch(e) {
    const ms = Date.now() - t0;
    console.log('NG ' + (ms/1000).toFixed(1) + 's -- ' + e.message);
    results.push({ num, name, ok: false, ms, error: e.message });
    return null;
  }
}

async function main() {
  console.log('\n===== VPS パイプライン計測 =====');
  console.log('TOPIC: ' + TOPIC);
  console.log('日時: ' + new Date().toLocaleString('ja-JP') + '\n');

  await step(1, '案件取得(Scout=手動)', async () => [{ title: TOPIC, source: 'manual' }]);

  let facts = await step('2+3', 'ラベル+コメント+データ取得', async () => {
    const f = await research(TOPIC, {});
    const ext = f.extracted || {};
    const home = ext.homeTeam, away = ext.awayTeam, player = ext.playerName;
    await Promise.all([
      (home && away) ? fetchMatch(home, away).then(md => { if(md && md.ok) f.matchData=md; }).catch(()=>{}) : Promise.resolve(),
      player ? fetchPlayer(player).then(pd => { if(pd && pd.ok) f.playerData=pd; }).catch(()=>{}) : Promise.resolve(),
    ]);
    return f;
  });
  if (!facts) return printSummary();

  await step(4, '画像取得(X images)', async () => {
    const { fetchImagesForLabels } = require('./fetchers/x_images');
    const labels = (facts.extracted && facts.extracted.labels) || [];
    if (!labels.length) return { count: 0, note: 'labels なし' };
    const imgs = await fetchImagesForLabels(labels);
    if (imgs) facts.xImages = imgs;
    const entities = [...new Set((imgs||[]).map(x=>x.entity).filter(Boolean))];
    return { count: (imgs||[]).length, entities: entities.join(', ') };
  });

  const brief = await step(5, '企画書生成(brief)', async () => generateBrief(TOPIC, facts));

  let scriptResult = await step(6, '脚本生成(4スライド自動+brief遵守)', async () => generateModsAuto(TOPIC, facts, brief || null));
  if (!scriptResult) return printSummary(facts);

  const { patternKey, pattern, mods } = scriptResult;

  await step(7, '画像解決(プリセット+X API)', async () => {
    const galleryUrls = new Set((facts.xImages||[]).map(x=>x.url));
    await resolveAllImages(mods, facts);
    let preset = 0, api = 0;
    for (const m of mods) {
      for (const k of ['bgImage','leftImage','rightImage']) {
        if (!m[k]) continue;
        if (galleryUrls.has(m[k])) preset++; else api++;
      }
    }
    return { preset, api };
  });

  const ts = new Date().toISOString().slice(0,10);
  const outputDir = path.join(__dirname, 'output', ts + '_bench');
  fs.mkdirSync(outputDir, { recursive: true });

  let narRes = await step(8, 'TTS(narration)', async () => {
    const r = await generateNarration(patternKey, mods, outputDir);
    mmChars += mods.reduce((s,m) => s+(m.narration ? m.narration.length : 0), 0);
    // コメント読み上げ分も概算に含める（packComments で画面内に収まる分のみTTSされる）
    try {
      const { packComments } = require('./slides/comments');
      mods.forEach(m => {
        if (m.type==='opening'||m.type==='ending'||!Array.isArray(m.comments)) return;
        mmChars += packComments(m.comments).reduce((s,c)=>s+(c.text||'').length, 0);
      });
    } catch(_) {}
    return r;
  });
  if (!narRes) narRes = { audioFiles: mods.map(()=>null), durations: mods.map(()=>5), commentDurations:[] };
  const { audioFiles, durations, commentDurations } = narRes;

  await step(9, 'Whisper(字幕)', async () => {
    const res = await whisperAll(audioFiles, 0.0);
    mods.forEach((mod,i) => {
      const wr = res[i] || {};
      mod.subtitleChunks   = wr.chunks  || [];
      mod.subtitleWords    = wr.words   || [];
      mod.subtitleSegments = wr.segments|| [];
      mod.narrationDurOnly = durations[i];
      mod.narrationEndSec  = durations[i];
    });
    return { chunks: res.reduce((s,r)=>s+(r.chunks ? r.chunks.length : 0),0) };
  });

  await step(10, 'レンダリング(render+concat)', async () => {
    const leadPad=0.0, tailPad=0.5;
    const renderDurations = durations.map((d,i) => {
      const st = (pattern.slides[i]||{}).type || mods[i].type || 'insight';
      const isBook = st==='opening'||st==='ending';
      const dur = d + leadPad + tailPad + (isBook ? 0 : (commentDurations ? (commentDurations[i]||0) : 0));
      return st==='opening' ? Math.max(6.0, dur+0.5) : dur;
    });
    const videoFiles = await renderAll(patternKey, mods, renderDurations, outputDir);
    const finalVideo = buildFinalVideo(videoFiles, audioFiles, outputDir, 'final.mp4');
    const totalDur = renderDurations.reduce((s,d)=>s+d,0).toFixed(1);
    return { slides: videoFiles.length, totalDur, finalVideo, outputDir };
  });

  printSummary(facts, mods, brief);
}

function printSummary(facts, mods, brief) {
  console.log('\n\n========== 計測結果 ==========\n');
  const labels = {
    1:'①案件取得', '2+3':'②③ラベル+コメント+データ',
    4:'④画像取得', 5:'⑤企画書生成', 6:'⑥脚本生成(brief遵守)',
    7:'⑦画像解決(プリセット+API)', 8:'⑧TTS', 9:'⑨Whisper', 10:'⑩レンダリング'
  };
  let totalMs = 0;
  for (const r of results) {
    const s = r.ok ? '合 OK' : '否 NG';
    console.log((labels[r.num]||('['+r.num+']')) + ': ' + s + '  ' + (r.ms/1000).toFixed(1) + 's');
    if (!r.ok) console.log('    ERROR: ' + r.error);
    totalMs += r.ms;
  }
  console.log('\n合計: ' + (totalMs/1000).toFixed(1) + 's');

  const dsCost = dsTokens.prompt/1e6*0.27 + dsTokens.completion/1e6*1.10;
  const oaCost = oaTokens.prompt/1e6*0.15 + oaTokens.completion/1e6*0.60;   // gpt-4o-mini
  const anCost = anTokens.input/1e6*1.00  + anTokens.output/1e6*5.00;       // haiku 4.5
  const xCost  = xApiCalls * 0.00015 * 20;  // TwitterAPI.io 概算（$0.15/1k tweets × ~20件/req）
  const mmCost = mmChars / 1e6 * 60;
  const narData = (results.find(r=>r.num===8)||{}).data;
  const audioSec = narData && narData.durations ? narData.durations.reduce((s,d)=>s+d,0) : 0;
  const wCost  = (audioSec/60) * 0.006;
  const total  = dsCost+oaCost+anCost+xCost+mmCost+wCost;

  console.log('\n--- AI コスト ---');
  console.log('DeepSeek: in=' + dsTokens.prompt.toLocaleString() + ' / out=' + dsTokens.completion.toLocaleString() + ' tokens -> $' + dsCost.toFixed(4));
  console.log('OpenAI(4o-mini): in=' + oaTokens.prompt.toLocaleString() + ' / out=' + oaTokens.completion.toLocaleString() + ' -> $' + oaCost.toFixed(4));
  console.log('Anthropic(Haiku監修): in=' + anTokens.input.toLocaleString() + ' / out=' + anTokens.output.toLocaleString() + ' -> $' + anCost.toFixed(4));
  console.log('TwitterAPI.io: ' + xApiCalls + ' req -> ~$' + xCost.toFixed(4));
  console.log('MiniMax TTS: ~' + mmChars + 'char -> $' + mmCost.toFixed(4));
  console.log('Whisper: ~' + audioSec.toFixed(0) + 's -> $' + wCost.toFixed(4));
  console.log('Total: $' + total.toFixed(4) + '  (¥' + (total*150).toFixed(1) + ')');

  if (facts && facts.comments) {
    const c = facts.comments;
    console.log('\n--- Comments ---');
    console.log('Reddit:' + (c.reddit ? c.reddit.length : 0) + ' Yahoo:' + (c.yahoo ? c.yahoo.length : 0) + ' X:' + (c.x ? c.x.length : 0) + ' Total:' + (c.all ? c.all.length : 0));
    (c.all||[]).slice(0,5).forEach((cm,i)=>
      console.log('  [' + (i+1) + '][' + cm.source + '] ' + (cm.text||'').slice(0,80))
    );
  }
  if (mods && mods.length) {
    console.log('\nSlides: ' + mods.map(m=>m.type||'?').join(' -> '));
  }
  if (brief && mods && mods.length) {
    console.log('\n--- 企画書遵守チェック ---');
    console.log('OPタイトル一致: ' + (mods[0].title === brief.op_title ? 'OK' : 'NG ("' + mods[0].title + '" ≠ "' + brief.op_title + '")'));
    console.log('タイプ一致: A=' + (mods[1] && mods[1].type) + '/' + brief.slide_a_type + ' B=' + (mods[2] && mods[2].type) + '/' + brief.slide_b_type);
    console.log('企画書: A「' + (brief.slide_a_desc||'') + '」 B「' + (brief.slide_b_desc||'') + '」 ED「' + (brief.ed_comment||'') + '」');
  }
  const r7 = results.find(r=>r.num===7);
  if (r7 && r7.data) console.log('画像: プリセット' + r7.data.preset + '枠 / API検索' + r7.data.api + '枠');
  const r10 = results.find(r=>r.num===10);
  if (r10 && r10.data) {
    console.log('Duration: ' + (r10.data.totalDur||'?') + 's');
    console.log('Output dir: ' + (r10.data.outputDir||'?'));
    console.log('Video: ' + (r10.data.finalVideo||'?'));
  }
}

main().catch(e => { console.error('FATAL:', e.stack); printSummary(); process.exit(1); });
