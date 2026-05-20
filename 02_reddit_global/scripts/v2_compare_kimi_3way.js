// scripts/v2_compare_kimi_3way.js
// ═══════════════════════════════════════════════════════════════
// Sonnet 4.6 / DeepSeek V4-Flash / Moonshot Kimi K2.6 の 3-way 品質比較
//
// 既存の /v2/ai-fill-slide を 3 並列で叩いて、 同一スライドの脚本生成を 3 モデルで実行。
// 結果を data/compare_3way_kimi_<ts>.json に保存し、 narration / title / dataSlots を並列比較。
//
// 使い方:
//   node scripts/v2_compare_kimi_3way.js <postId> <moduleIdx> [userPrompt...]
//   例: node scripts/v2_compare_kimi_3way.js _r_soccer_comments_1tfj53m_... 2 "シャビのチェルシー就任の意味を深掘り"
//
// 前提:
//   - V2 ランチャー (port 3004) が起動済み (local_v2_launcher.js)
//   - .env に DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY 全部設定済み
//   - postId の si_data + modules.json が既に存在
//
// コスト:
//   - Sonnet 1 スライド: 約 ¥15-25
//   - V4-Flash 1 スライド: 約 ¥1-2
//   - Kimi K2.6 1 スライド: 約 ¥3-5
//   - 合計 ¥20-40 / 1 案件 1 スライド比較
// ═══════════════════════════════════════════════════════════════

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const BASE_URL  = process.env.LAUNCHER_URL || 'http://localhost:3004';
const DATA_DIR  = path.join(__dirname, '..', 'data');
const POLL_MS   = 3000;
const POLL_MAX  = 240;  // 12分上限

async function runOne(name, postId, moduleIdx, sprintVal, userPrompt) {
  const t0 = Date.now();
  try {
    const init = await axios.post(`${BASE_URL}/api/v2/ai-fill-slide`, {
      postId,
      moduleIdx,
      userPrompt,
      sprint: sprintVal,
      incremental: false,
      useWebResearch: false,
    });
    const jobId = init.data?.jobId;
    if (!jobId) throw new Error('jobId 取得失敗');

    for (let i = 0; i < POLL_MAX; i++) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const st = await axios.get(`${BASE_URL}/api/v2/ai-fill-slide-status?jobId=${encodeURIComponent(jobId)}`);
      const s = st.data;
      if (s.status === 'error') throw new Error(s.error || 'ジョブ失敗');
      if (s.status === 'done')  return { name, ok: true, ms: Date.now() - t0, result: s.result || {} };
    }
    throw new Error('ポーリングタイムアウト');
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: e.message };
  }
}

async function main() {
  const postId    = process.argv[2];
  const moduleIdx = parseInt(process.argv[3] || '0', 10);
  const userPrompt = process.argv.slice(4).join(' ') || '深く厚みのあるナレーションを生成。 具体的な数字とエピソードで視聴者を惹きつける';

  if (!postId) {
    console.error('Usage: node scripts/v2_compare_kimi_3way.js <postId> <moduleIdx> [userPrompt]');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════');
  console.log('  Sonnet 4.6 / V4-Flash / Kimi K2.6 3-way 比較');
  console.log('═══════════════════════════════════════════════════');
  console.log(`postId    : ${postId}`);
  console.log(`moduleIdx : ${moduleIdx}`);
  console.log(`userPrompt: ${userPrompt.slice(0, 80)}${userPrompt.length > 80 ? '...' : ''}`);
  console.log('');
  console.log('3 並列実行中... (各 30-120 秒、 最大 12分上限)');

  const tasks = [
    ['sonnet',  false],   // Claude Sonnet 4.6
    ['v4flash', true],    // DeepSeek V4-Flash (sprint=true)
    ['kimi',    'kimi'],  // Moonshot Kimi K2.6 (sprint='kimi')
  ];
  const results = await Promise.all(tasks.map(([n, v]) =>
    runOne(n, postId, moduleIdx, v, userPrompt)
  ));

  console.log('\n═══ 結果サマリ ═══');
  for (const r of results) {
    if (!r.ok) {
      console.log(`  [${r.name}] ❌ ${r.error} (${r.ms}ms)`);
      continue;
    }
    const narr = r.result.narration || '';
    console.log(`\n  [${r.name}] ✅ ${r.ms}ms / used=${r.result.used || '?'}`);
    console.log(`    title:     ${r.result.title || ''}`);
    console.log(`    type:      ${r.result.type || ''}`);
    console.log(`    dataSlots: ${(r.result.dataSlots || []).length} 件`);
    console.log(`    narration: ${narr.slice(0, 200)}${narr.length > 200 ? '...' : ''}`);
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const outFile = path.join(DATA_DIR, `compare_3way_kimi_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    postId, moduleIdx, userPrompt,
    timestamp: new Date().toISOString(),
    results,
  }, null, 2));
  console.log(`\n📄 結果保存: ${outFile}`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
