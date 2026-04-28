// scripts/v2_test_sonnet_full_project.js
// 1案件の全モジュールを Sonnet で「脚本生成 + 監修」する非破壊テスト
//
//  使い方:
//    node -r dotenv/config scripts/v2_test_sonnet_full_project.js <postIdSafe> dotenv_config_path=.env
//
//  動作:
//   - data/{postIdSafe}_modules.json + data/si_data/{postIdSafe}.json を読込
//   - step3 と同じ prompt で **全モジュール一括** で Sonnet に生成依頼
//   - 続いて Pass2 review prompt も Sonnet に依頼
//   - 各 module の before/after narration + トークン記録を表示
//   - 元 modules.json は触らない（出力は data/_test_sonnet_<postId>.json）

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });

const fs   = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic();
const SONNET = 'claude-sonnet-4-6';
const PRICING = { in: 3.0, out: 15.0 }; // USD per 1M tokens

const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');

// ── 引数 ───────────────────────────────────────
const argId = process.argv[2];
if (!argId) { console.error('Usage: node v2_test_sonnet_full_project.js <postIdSafe>'); process.exit(1); }
const safeId = argId.replace(/[\/\?%*:|"<>]/g, '_').replace(/\.json$/, '').replace(/^_modules$/, '');
const modPath = path.join(DATA_DIR, safeId + '_modules.json');
const siPath  = path.join(SI_DIR, safeId + '.json');
if (!fs.existsSync(modPath)) { console.error('modules not found:', modPath); process.exit(1); }
if (!fs.existsSync(siPath))  { console.error('si not found:', siPath); process.exit(1); }

const modulesData = JSON.parse(fs.readFileSync(modPath, 'utf8'));
const si = JSON.parse(fs.readFileSync(siPath, 'utf8'));
const mods = modulesData.modules || [];
console.log(`📰 案件: ${path.basename(siPath)}`);
console.log(`📦 module 数: ${mods.length}`);
console.log('━'.repeat(70));

// ── step3 と同じ entity/match/search block 構築 ─────────────
const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function _entityBlock(it) {
  const role = it.role;
  const wikiSum = it.wiki?.ok
    ? `wiki:{title:"${it.wiki.title || ''}",extract:"${(it.wiki.extract || '').slice(0, 250)}"}` : 'wiki:×';
  let sofaSum = 'sofa:×';
  if (it.sofa?.ok) {
    let payload;
    if (role === 'tournament') {
      payload = {
        name: it.sofa.name, country: it.sofa.country, seasonYear: it.sofa.seasonYear,
        standings:      Array.isArray(it.sofa.standings)      ? it.sofa.standings.slice(0, 10)     : [],
        relegationRace: it.sofa.relegationRace,
        topScorers:     Array.isArray(it.sofa.topScorers)     ? it.sofa.topScorers.slice(0, 3)     : [],
        topAssists:     Array.isArray(it.sofa.topAssists)     ? it.sofa.topAssists.slice(0, 3)     : [],
      };
    } else if (role === 'team') {
      const topScorers = Array.isArray(it.sofa.topPlayers?.goals)
        ? it.sofa.topPlayers.goals.slice(0, 3) : [];
      payload = {
        teamName: it.sofa.teamName, league: it.sofa.leagueName, country: it.sofa.country,
        standing: it.sofa.standing, manager: it.sofa.managerName,
        seasonStats: it.sofa.seasonStats, teamStats: it.sofa.teamStats,
        recentForm: it.sofa.recentForm,
        last5: Array.isArray(it.sofa.last5) ? it.sofa.last5.slice(0, 5) : [],
        topScorers,
        trophySummary: it.sofa.trophySummary,
      };
    } else {
      payload = {
        name: it.sofa.name, position: it.sofa.position, team: it.sofa.team,
        league: it.sofa.leagueName, country: it.sofa.country,
        standing: it.sofa.standing, manager: it.sofa.managerName,
        seasonStats: it.sofa.seasonStats, lastMatchStats: it.sofa.lastMatchStats,
        currentTeam: it.sofa.currentTeam,
        overallPerformance: it.sofa.overallPerformance,
      };
    }
    const cap = role === 'tournament' ? 1500 : role === 'team' ? 1200 : 700;
    sofaSum = `sofa:${JSON.stringify(payload).slice(0, cap)}`;
  }
  return `- "${it.label}" [${role}]\n  ${wikiSum}\n  ${sofaSum}`;
}
function _matchBlock(it) {
  if (!it.data?.ok) return `- "${it.label}" : 取得失敗`;
  const redCards = (it.data.cards || []).filter(c => c.color === 'レッド' || c.color === '2枚目イエロー→退場');
  return `- "${it.label}" : ${JSON.stringify({
    scoreline: it.data.scoreline, date: it.data.matchDate,
    tournament: it.data.tournament, venue: it.data.venue,
    goals: (it.data.goals || []).slice(0, 8),
    redCards,
    topPlayers: (it.data.topPlayers || []).slice(0, 3),
    h2hSummary: it.data.h2hSummary,
  }).slice(0, 900)}`;
}
function _searchBlock(it) {
  if (!it.data?.organic) return `- "${it.label}" : 結果なし`;
  const top = it.data.organic.slice(0, 3).map(r => `${r.title}: ${r.snippet?.slice(0,120)||''}`).join(' / ');
  return `- "${it.label}" : ${top.slice(0, 500)}`;
}
const entityBlock = (si.boxes.entity?.items || []).map(_entityBlock).join('\n') || '(なし)';
const matchBlock  = (si.boxes.match?.items  || []).map(_matchBlock).join('\n')  || '(なし)';
const searchBlock = (si.boxes.search?.items || []).map(_searchBlock).join('\n') || '(なし)';

// outline 構築
const outlineLines = mods.map((m, i) => {
  let tags = `main="${m.mainKey || ''}"` + (m.subSource ? ` sub="${m.subSource}:${m.subValue}"` : '');
  if (m.secondary) tags += ` secondary="${m.secondary}"`;
  return `idx=${i+1}: type=${m.type} ${tags}\n   scriptDir: ${m.scriptDir || '(指示なし)'}`;
}).join('\n');

const titleJa = '(案件タイトル不明)';

const generatePrompt = `あなたはサッカーYouTubeのプロ脚本家です。
以下の outline と取得済み素材から、各カードの本体（narration、データ、キャッチコピー等）を生成してください。

【今日の日付】${todayJst}（JST）
【案件】${titleJa}
━━━ 取得済みデータ ━━━
[entity 一覧]
${entityBlock}

[match 一覧]
${matchBlock}

[search 一覧]
${searchBlock}
━━━━━━━━━━━━━━━━

【outline (${mods.length}枚)】
${outlineLines}

【生成ルール】
各カードに対して必要なフィールドを全部 JSON で返す：

- 全カード共通：
  - "idx": **outline の番号（1始まり）と完全一致**
  - "title": 短い見出し（10〜25文字）
  - "narration": 視聴者に語りかける口調の本文 — 250〜320文字目安

【ハルシネーション禁止 — 厳守】
- 値・固有名は必ず上記取得済みデータに明記されているもののみ
- データに無いものは出力しない
- 過去に在籍してた有名選手（移籍・引退済）を絶対に書かない
  ・例: PSG なら「メッシ・ムバッペ・ネイマール」は出さない（全員退団済）
  ・例: マンU なら「ロナウド」は出さない（退団済）
- SofaScore データの「得点ランキング上位」「監督」「直近5試合」に**現在いる/起きた**選手・事実のみ言及
- 試合結果の混同厳禁: チーム entity の sofa.last5 が直近の実結果。それ以外の試合の結果は書かない

JSON のみ返す。**idx は outline の番号 1〜${mods.length} と完全一致**で全カード網羅：
{"modules":[
  {"idx":1,"title":"...","narration":"..."},
  ... (合計 ${mods.length}枚)
]}`;

const reviewPromptBuild = (parsedModules) => `あなたはサッカーYouTube脚本の事実整合性チェッカー。
別のAIが生成した全 ${mods.length} カードの narration を、元データと突き合わせて矛盾があれば指摘・修正してください。

【今日の日付】${todayJst}（JST）
[entity 一覧]
${entityBlock}

[match 一覧]
${matchBlock}

[search 一覧]
${searchBlock}

【生成結果（チェック対象 / 全 ${mods.length} カード）】
${JSON.stringify(parsedModules, null, 2).slice(0, 8000)}

【チェック観点】
1. narration 内の固有名（選手名・監督名）が元データに辿れるか
2. 過去に在籍してた選手（メッシ・ムバッペ・ネイマール・ロナウド等の移籍済選手）を誤って言及してないか
3. 数字（順位・勝点・ゴール数）が元データから検算できるか
4. 試合結果の混同（女子試合 vs 男子試合・予定試合の結果捏造）が無いか

【出力】JSONのみ:
{
  "issues": [
    { "idx": 1, "where": "narration", "claim": "問題箇所の引用", "data_says": "元データの該当値（無ければ「無」）", "fix": "修正方針" }
  ],
  "fixed": [
    { "idx": 1, "narration": "..." },
    ... (全 ${mods.length} カード)
  ]
}`;

// ── Sonnet 呼出 ──
async function callSonnet(text, label) {
  const start = Date.now();
  process.stdout.write(`⏳ [${label}] ...`);
  try {
    const res = await anthropic.messages.create({
      model: SONNET, max_tokens: 8000,
      messages: [{ role: 'user', content: text }],
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const raw = res.content[0]?.text || '';
    let parsed = null;
    try { const m = raw.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (_) {}
    console.log(` 完了 (${elapsed}秒, in:${res.usage?.input_tokens || '?'} out:${res.usage?.output_tokens || '?'})`);
    return {
      elapsed, raw, parsed,
      tokenIn:  res.usage?.input_tokens  || 0,
      tokenOut: res.usage?.output_tokens || 0,
    };
  } catch (e) {
    console.log(` ❌ ${e.message}`);
    return { error: e.message };
  }
}

function _cost(tokenIn, tokenOut) {
  return tokenIn / 1e6 * PRICING.in + tokenOut / 1e6 * PRICING.out;
}

// ── メイン ──
(async () => {
  console.log('🎬 Pass1: Sonnet 全カード一括生成');
  const gen = await callSonnet(generatePrompt, 'Sonnet 生成');
  if (!gen.parsed?.modules) { console.error('生成失敗 → terminate\n', gen.raw?.slice(0, 600) || gen.error); process.exit(1); }

  console.log('\n🔍 Pass2: Sonnet 監修');
  const rev = await callSonnet(reviewPromptBuild(gen.parsed.modules), 'Sonnet 監修');
  if (!rev.parsed) { console.warn('⚠️ 監修JSONパース失敗\n', rev.raw?.slice(0, 400) || rev.error); }

  // ── 結果集約 ──
  const aiByIdx = {};
  (gen.parsed.modules || []).forEach((ai, k) => {
    const idx = Number.isFinite(ai?.idx) ? Number(ai.idx) : (k + 1);
    aiByIdx[idx] = ai;
  });
  const fixedByIdx = {};
  if (rev.parsed?.fixed && Array.isArray(rev.parsed.fixed)) {
    rev.parsed.fixed.forEach(f => {
      const idx = Number.isFinite(f?.idx) ? Number(f.idx) : null;
      if (idx) fixedByIdx[idx] = f;
    });
  }
  const issues = (rev.parsed?.issues || []);

  // 各 module 表示
  console.log('\n' + '═'.repeat(70));
  console.log('📋 各カード Before/After');
  mods.forEach((m, i) => {
    const idx = i + 1;
    const original = m.narration || '';
    const generated = aiByIdx[idx]?.narration || '';
    const fixed = fixedByIdx[idx]?.narration || generated;
    const changed = (original !== generated) || (generated !== fixed);

    console.log('\n━━ #' + idx + ' ' + (m.type || '?') + ' / ' + (m.title || '?') + ' ━━');
    console.log('【元】       ' + (original.slice(0, 160) || '(空)'));
    console.log('【Sonnet生成】' + (generated.slice(0, 160) || '(空)'));
    if (generated !== fixed) {
      console.log('【監修後】   ' + (fixed.slice(0, 160) || '(空)'));
    }
    const myIssues = issues.filter(it => it.idx === idx);
    if (myIssues.length) {
      console.log('  ⚠️ 監修 issue ' + myIssues.length + '件:');
      myIssues.slice(0, 3).forEach((it, j) => {
        console.log(`    ${j+1}. [${it.where}] "${(it.claim || '').slice(0, 80)}"`);
        console.log(`       fix: ${(it.fix || '').slice(0, 100)}`);
      });
    }
  });

  // ── トークン集計 ──
  const totalInGen  = gen.tokenIn  || 0;
  const totalOutGen = gen.tokenOut || 0;
  const totalInRev  = rev.tokenIn  || 0;
  const totalOutRev = rev.tokenOut || 0;
  const costGen = _cost(totalInGen, totalOutGen);
  const costRev = _cost(totalInRev, totalOutRev);
  const totalCost = costGen + costRev;

  console.log('\n' + '═'.repeat(70));
  console.log('📊 トークン記録（Sonnet）');
  console.log('━'.repeat(70));
  console.log(`◆ Pass1 生成（全${mods.length}カード一括）`);
  console.log(`   入力:  ${totalInGen.toLocaleString()} tokens`);
  console.log(`   出力:  ${totalOutGen.toLocaleString()} tokens`);
  console.log(`   時間:  ${gen.elapsed}秒`);
  console.log(`   コスト: $${costGen.toFixed(5)} (約 ${(costGen*150).toFixed(2)}円)`);
  console.log(`◇ Pass2 監修`);
  console.log(`   入力:  ${totalInRev.toLocaleString()} tokens`);
  console.log(`   出力:  ${totalOutRev.toLocaleString()} tokens`);
  console.log(`   時間:  ${rev.elapsed}秒`);
  console.log(`   コスト: $${costRev.toFixed(5)} (約 ${(costRev*150).toFixed(2)}円)`);
  console.log('━'.repeat(70));
  console.log(`✅ 案件全体合計: $${totalCost.toFixed(5)} (約 ${(totalCost*150).toFixed(2)}円)`);
  console.log(`   月100動画想定: 約 ${(totalCost*150*100).toFixed(0)}円/月`);
  console.log(`   1スライド換算: 約 ${(totalCost*150/mods.length).toFixed(2)}円`);
  console.log(`   issue 検出数: ${issues.length}件`);

  // ── 結果保存 ──
  const outFile = path.join(DATA_DIR, `_test_sonnet_${safeId}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    runAt: new Date().toISOString(),
    postId: modulesData.postId,
    moduleCount: mods.length,
    tokens: {
      generation: { input: totalInGen, output: totalOutGen, costUsd: costGen },
      review:     { input: totalInRev, output: totalOutRev, costUsd: costRev },
      totalUsd:   totalCost,
      totalJpy:   totalCost * 150,
    },
    generatedModules: gen.parsed.modules,
    reviewIssues: issues,
    reviewFixed: rev.parsed?.fixed || null,
  }, null, 2));
  console.log(`\n💾 保存: ${path.relative(path.join(__dirname, '..'), outFile)}`);
})();
