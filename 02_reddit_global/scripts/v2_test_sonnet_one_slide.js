// scripts/v2_test_sonnet_one_slide.js
// 1スライドの ai-fill-slide ロジックを Sonnet と DeepSeek で並走比較
//
//  使い方:
//    node -r dotenv/config scripts/v2_test_sonnet_one_slide.js <postId> <moduleIdx> dotenv_config_path=.env
//
//  動作:
//   1. 指定 modules.json + si_data を読み込み
//   2. ai-fill-slide と同じ prompt を構築
//   3. DeepSeek-chat 生成 → DeepSeek 監修 (現状)
//   4. Sonnet 生成 → Sonnet 監修 (B案)
//   5. 両者を並べて表示

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs   = require('fs');
const path = require('path');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');

const deepseek  = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' });
const anthropic = new Anthropic();

const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');

const PRICING = {
  'deepseek-chat':       { in: 0.27, out: 1.10 },
  'claude-sonnet-4-6':   { in: 3.0,  out: 15.0 },
};

// ── 引数 ─────────────────────────────────────────
const argId = process.argv[2];
const argIdx = parseInt(process.argv[3] || '0', 10);
if (!argId) {
  console.error('Usage: node scripts/v2_test_sonnet_one_slide.js <postId or filename> <moduleIdx>');
  process.exit(1);
}

const safeId = argId.replace(/[\/\?%*:|"<>]/g, '_').replace(/\.json$/, '').replace(/^_modules$/, '');
const modPath = path.join(DATA_DIR, safeId + '_modules.json');
const siPath  = path.join(SI_DIR, safeId + '.json');
if (!fs.existsSync(modPath)) { console.error('modules not found:', modPath); process.exit(1); }
if (!fs.existsSync(siPath))  { console.error('si not found:', siPath); process.exit(1); }

const modulesData = JSON.parse(fs.readFileSync(modPath, 'utf8'));
const si = JSON.parse(fs.readFileSync(siPath, 'utf8'));
const mod = (modulesData.modules || [])[argIdx];
if (!mod) { console.error('moduleIdx out of range:', argIdx); process.exit(1); }

console.log(`📰 案件: ${path.basename(siPath)}`);
console.log(`🎯 対象スライド #${argIdx + 1}: type=${mod.type} / title="${mod.title}"`);
console.log(`   mainKey: ${mod.mainKey}`);
console.log(`   現状 narration: ${(mod.narration || '').slice(0, 200)}`);
console.log('━'.repeat(70));

// ── 役割推定 ───────────────────────────────────────
function _parseMK(k) {
  if (!k) return { type: 'unknown', name: '' };
  const c = k.indexOf(':');
  return c < 0 ? { type: k, name: '' } : { type: k.slice(0, c), name: k.slice(c + 1) };
}
const { name: primary } = _parseMK(mod.mainKey || '');
const secondary = mod.secondary || mod.binding?.secondary || null;
const items = si.boxes?.entity?.items || [];

// ── entity context（簡略版・ai-fill-slide 相当）──────
function _entityContext(label) {
  if (!label) return '';
  const it = items.find(x => x.label === label) || {};
  const wikiExtract = it.wiki?.extract || '';
  const sofa = it.sofa || {};
  let topScorers = '';
  if (sofa.topPlayers?.goals) {
    topScorers = sofa.topPlayers.goals.slice(0, 5).map(p => `${p.name}(${p.value || '?'}G)`).join(', ');
  }
  let standing = sofa.standing
    ? `順位${sofa.standing.position}位 勝点${sofa.standing.points} W${sofa.standing.wins}-D${sofa.standing.draws}-L${sofa.standing.losses}`
    : '';
  let last5 = '';
  if (Array.isArray(sofa.last5)) {
    last5 = sofa.last5.slice(0, 5)
      .map(m => `${m.date || '?'} vs ${m.opponent || '?'} ${m.score || '?'} ${m.result || '?'}`)
      .join(' / ');
  }
  return `=== 主体: ${label} (${it.role || '?'}) ===
[Wikipedia 要約]
${wikiExtract.slice(0, 800)}

[SofaScore]
チーム: ${sofa.teamName || sofa.name || '-'}
監督: ${sofa.managerName || '-'}
リーグ順位: ${standing}
得点ランキング上位: ${topScorers}
直近5試合 (実結果): ${last5}
`;
}
const ctxPrimary   = _entityContext(primary);
const ctxSecondary = secondary ? _entityContext(secondary) : '';

const prompt = `あなたはサッカーYouTubeの脚本AI。スライド1枚の本体を完全に組み立てる。
type / title / dataSlots / narration を**一気通貫で**生成してください。

【現スライド情報（# ${argIdx + 1} 枚目）】
type: ${mod.type || '?'}
title: ${mod.title || ''}
mainKey: ${mod.mainKey || '?'}
${secondary ? 'secondary: ' + secondary : ''}
脚本指示: ${mod.scriptDir || '(指示なし)'}

【利用可能データ】
${ctxPrimary}
${ctxSecondary}

【ユーザー注文】
（このスライドを再生成して。元データだけで書く）

【生成ルール（厳守）】
- type: ${mod.type}
- dataSlots は必要なら 6〜8 件
- narration: 250〜320文字、視聴者に語りかける口調
- データに**明示されていない**値・固有名・数字は **絶対** 出さない
- あなたの学習データ（2024年〜）は古い。現在の所属・監督・主力はデータからのみ参照
- 例えば「ネイマール・メッシ・ムバッペ」のような名前は、SofaScoreの得点ランキングに無ければ絶対に書かない

【出力】JSONのみ:
{
  "type": "...",
  "title": "...",
  "dataSlots": [...],
  "narration": "..."
}`;

const reviewPrompt = (parsed) => `あなたはサッカーYouTube脚本の事実整合性チェッカー。
別のAIが生成した narration / dataSlots を、元データと突き合わせて矛盾があれば指摘・修正してください。

【元データ】
${ctxPrimary}
${ctxSecondary}

【生成結果（チェック対象）】
type: ${parsed.type}
title: ${parsed.title || ''}
dataSlots: ${JSON.stringify(parsed.dataSlots).slice(0, 2000)}
narration: ${parsed.narration || ''}

【チェック観点】
1. narration 内の固有名（選手名・監督名）が元データの「得点ランキング上位」「監督」に存在するか
2. 元データに**存在しない選手名**（過去在籍など）を narration が言及してないか
3. 数字（順位・勝点・ゴール数）が元データから検算できるか

【出力】JSONのみ:
{
  "issues": [
    { "where": "narration|dataSlots", "claim": "問題箇所の引用", "data_says": "元データの該当値（無ければ「無」）", "fix": "修正方針" }
  ],
  "fixed": {
    "type": "${parsed.type}",
    "title": "...",
    "dataSlots": [...],
    "narration": "..."
  }
}`;

// ── モデル呼出 ────────────────────────────────────
async function callDeepseek(text, label) {
  const start = Date.now();
  process.stdout.write(`⏳ [${label}] ...`);
  try {
    const res = await deepseek.chat.completions.create({
      model: 'deepseek-chat', max_tokens: 4000,
      messages: [{ role: 'user', content: text }],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const raw = res.choices[0].message.content || '';
    let parsed = null;
    try { const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (_) {}
    console.log(` 完了 (${elapsed}秒)`);
    return { model: 'deepseek-chat', elapsed, raw, parsed, usage: res.usage };
  } catch (e) {
    console.log(` ❌ ${e.message}`);
    return { model: 'deepseek-chat', error: e.message };
  }
}
async function callSonnet(text, label) {
  const start = Date.now();
  process.stdout.write(`⏳ [${label}] ...`);
  try {
    const res = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4000,
      messages: [{ role: 'user', content: text }],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const raw = res.content[0]?.text || '';
    let parsed = null;
    try { const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (_) {}
    console.log(` 完了 (${elapsed}秒)`);
    return {
      model: 'claude-sonnet-4-6', elapsed, raw, parsed,
      usage: { prompt_tokens: res.usage?.input_tokens || 0, completion_tokens: res.usage?.output_tokens || 0 },
    };
  } catch (e) {
    console.log(` ❌ ${e.message}`);
    return { model: 'claude-sonnet-4-6', error: e.message };
  }
}

function _cost(r) {
  const p = PRICING[r.model] || { in: 0, out: 0 };
  const u = r.usage || {};
  return ((u.prompt_tokens || 0) / 1e6 * p.in + (u.completion_tokens || 0) / 1e6 * p.out);
}

function _printRoute(label, gen, rev) {
  console.log('\n' + '═'.repeat(70));
  console.log(`📊 【${label}】`);
  console.log('━'.repeat(70));
  if (gen.error) { console.log('❌ 生成失敗:', gen.error); return; }
  if (!gen.parsed) { console.log('❌ JSONパース失敗\n', gen.raw.slice(0, 400)); return; }
  console.log(`◆ 生成 (${gen.elapsed}秒, $${_cost(gen).toFixed(5)})`);
  console.log('  type:', gen.parsed.type);
  console.log('  title:', gen.parsed.title);
  console.log('  narration:');
  (gen.parsed.narration || '').match(/.{1,60}/g)?.forEach(l => console.log('    ' + l));
  if (Array.isArray(gen.parsed.dataSlots)) {
    console.log('  dataSlots:');
    gen.parsed.dataSlots.slice(0, 8).forEach(s => console.log('    - ' + (s.label || '?') + ': ' + (s.value || s.leftValue + ' vs ' + s.rightValue || '?')));
  }

  if (!rev) return;
  console.log('━'.repeat(70));
  if (rev.error) { console.log('❌ 監修失敗:', rev.error); return; }
  if (!rev.parsed) { console.log('❌ 監修JSONパース失敗\n', (rev.raw||'').slice(0, 400)); return; }
  const issues = rev.parsed.issues || [];
  console.log(`◇ 監修 (${rev.elapsed}秒, $${_cost(rev).toFixed(5)}) — issue ${issues.length} 件`);
  issues.slice(0, 6).forEach((iss, i) => {
    console.log(`  ${i+1}. [${iss.where}] "${(iss.claim || '').slice(0,80)}"`);
    console.log(`     data: ${(iss.data_says || '').slice(0, 100)}`);
    console.log(`     fix:  ${(iss.fix || '').slice(0, 100)}`);
  });
  if (rev.parsed.fixed?.narration) {
    console.log('◆ 監修後 narration:');
    rev.parsed.fixed.narration.match(/.{1,60}/g)?.forEach(l => console.log('    ' + l));
  }
}

// ── メイン ────────────────────────────────────────
(async () => {
  console.log('🔬 DeepSeek (現状A+案) 並走テスト');
  const ds_gen = await callDeepseek(prompt, 'DS生成');
  const ds_rev = ds_gen.parsed ? await callDeepseek(reviewPrompt(ds_gen.parsed), 'DS監修') : null;

  console.log('\n🔬 Sonnet (B案) 並走テスト');
  const sn_gen = await callSonnet(prompt, 'Sonnet生成');
  const sn_rev = sn_gen.parsed ? await callSonnet(reviewPrompt(sn_gen.parsed), 'Sonnet監修') : null;

  _printRoute('A+ : chat 生成 + chat 監修', ds_gen, ds_rev);
  _printRoute('B  : sonnet 生成 + sonnet 監修', sn_gen, sn_rev);

  // コストサマリー
  console.log('\n' + '═'.repeat(70));
  console.log('💰 1スライド あたりコスト');
  const dsTotal = _cost(ds_gen) + (ds_rev ? _cost(ds_rev) : 0);
  const snTotal = _cost(sn_gen) + (sn_rev ? _cost(sn_rev) : 0);
  console.log(`  A+ : $${dsTotal.toFixed(5)} (約${(dsTotal*150).toFixed(2)}円)`);
  console.log(`  B  : $${snTotal.toFixed(5)} (約${(snTotal*150).toFixed(2)}円)`);
  console.log(`  差分: ${((snTotal - dsTotal) * 150).toFixed(2)}円/スライド`);
})();
