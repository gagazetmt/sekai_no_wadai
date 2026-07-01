// VPS 1件フル計測スクリプト  node launcher/_bench.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');

const { research, fetchMatch, fetchPlayer } = require('./research');
const { generateModsAuto }   = require('./script_gen');
const { generateNarration }  = require('./narration');
const { whisperAll }         = require('./whisper');
const { renderAll }          = require('./render');
const { buildFinalVideo }    = require('./concat');
const { buildPiecesPattern } = require('./slide_patterns');

const TOPIC = 'エムバペ W杯2026 最多得点記録';

const results = [];
let dsTokens = { prompt: 0, completion: 0 };
let mmChars   = 0;

const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  const res = await origFetch(url, opts);
  if (typeof url === 'string' && url.includes('deepseek.com')) {
    res.clone().json().then(d => {
      const u = d && d.usage;
      if (u) { dsTokens.prompt += u.prompt_tokens||0; dsTokens.completion += u.completion_tokens||0; }
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
    const { fetchImagesForLabels } = require('./fetchers/images');
    if (!facts.labels || !facts.labels.length) return { count: 0, note: 'labels なし' };
    const imgs = await fetchImagesForLabels(facts.labels);
    if (imgs) facts.xImages = imgs;
    return { count: Object.keys(imgs||{}).length };
  });

  let scriptResult = await step(5, '脚本生成(4スライド自動)', async () => generateModsAuto(TOPIC, facts));
  if (!scriptResult) return printSummary(facts);

  const { patternKey, pattern, mods } = scriptResult;

  const ts = new Date().toISOString().slice(0,10);
  const outputDir = path.join(__dirname, 'output', ts + '_bench');
  fs.mkdirSync(outputDir, { recursive: true });

  let narRes = await step(6, 'TTS(narration)', async () => {
    const r = await generateNarration(patternKey, mods, outputDir);
    mmChars += mods.reduce((s,m) => s+(m.narration ? m.narration.length : 0), 0);
    return r;
  });
  if (!narRes) narRes = { audioFiles: mods.map(()=>null), durations: mods.map(()=>5), commentDurations:[] };
  const { audioFiles, durations, commentDurations } = narRes;

  await step(7, 'Whisper(字幕)', async () => {
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

  await step(8, 'レンダリング(render+concat)', async () => {
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

  printSummary(facts, mods);
}

function printSummary(facts, mods) {
  console.log('\n\n========== 計測結果 ==========\n');
  const labels = {
    1:'①案件取得', '2+3':'②③ラベル+コメント+データ',
    4:'④画像取得', 5:'⑤脚本生成(4スライド自動)',
    6:'⑥TTS', 7:'⑦Whisper', 8:'⑧レンダリング'
  };
  let totalMs = 0;
  for (const r of results) {
    const s = r.ok ? '合 OK' : '否 NG';
    console.log((labels[r.num]||('['+r.num+']')) + ': ' + s + '  ' + (r.ms/1000).toFixed(1) + 's');
    if (!r.ok) console.log('    ERROR: ' + r.error);
    totalMs += r.ms;
  }
  console.log('\n合計: ' + (totalMs/1000).toFixed(1) + 's');

  const dsIn   = dsTokens.prompt     / 1e6 * 0.27;
  const dsOut  = dsTokens.completion / 1e6 * 1.10;
  const dsCost = dsIn + dsOut;
  const mmCost = mmChars / 1e6 * 60;
  const narData = (results.find(r=>r.num===6)||{}).data;
  const audioSec = narData && narData.durations ? narData.durations.reduce((s,d)=>s+d,0) : 0;
  const wCost  = (audioSec/60) * 0.006;

  console.log('\n--- AI コスト ---');
  console.log('DeepSeek: in=' + dsTokens.prompt.toLocaleString() + ' / out=' + dsTokens.completion.toLocaleString() + ' tokens');
  console.log('  -> $' + dsCost.toFixed(4) + '  (Y' + (dsCost*150).toFixed(1) + ')');
  console.log('MiniMax TTS: ~' + mmChars + 'char -> $' + mmCost.toFixed(4) + '  (Y' + (mmCost*150).toFixed(1) + ')');
  console.log('Whisper: ~' + audioSec.toFixed(0) + 's -> $' + wCost.toFixed(4) + '  (Y' + (wCost*150).toFixed(2) + ')');
  console.log('Total: $' + (dsCost+mmCost+wCost).toFixed(4) + '  (Y' + ((dsCost+mmCost+wCost)*150).toFixed(1) + ')');

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
  const r8 = results.find(r=>r.num===8);
  if (r8 && r8.data) {
    console.log('Duration: ' + (r8.data.totalDur||'?') + 's');
    console.log('Output dir: ' + (r8.data.outputDir||'?'));
    console.log('Video: ' + (r8.data.finalVideo||'?'));
  }
}

main().catch(e => { console.error('FATAL:', e.stack); printSummary(); process.exit(1); });
