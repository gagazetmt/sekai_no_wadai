// v3_launcher/v3_fact_checker.js
// DeepSeekが生成した企画書・ナレーション草稿を Gemini 2.5 Flash で独立ファクトチェック。
// 修正はしない。疑わしい主張を publishGates / factCheckFlags に落とすだけ。

const path = require('path');
const { callAI } = require(path.join(__dirname, '..', 'scripts', 'ai_client'));

const MAX_CLAIMS = 12;

function extractClaims(aiPlan) {
  const claims = [];
  const labels = ['A', 'B', 'C'];
  (aiPlan?.themeProposal?.candidates || []).forEach((c, i) => {
    if (c.hookQuestion) claims.push({ source: `案${labels[i] || i}_hook`, text: c.hookQuestion });
    if (c.answer)       claims.push({ source: `案${labels[i] || i}_answer`, text: c.answer });
  });
  (aiPlan?.briefing?.chapters || []).forEach((ch, i) => {
    if (ch.claim) claims.push({ source: `chapter_${i + 1}`, text: ch.claim });
  });
  if (aiPlan?.briefing?.coreMessage) {
    claims.push({ source: 'coreMessage', text: aiPlan.briefing.coreMessage });
  }
  return claims.slice(0, MAX_CLAIMS);
}

function parseFlags(raw) {
  const s = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch (_) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return { flags: [] };
}

/**
 * AI企画書 (generateAIPlan の結果) をファクトチェック。
 * フラグが出た主張を publishGates に追加して返す。
 */
async function factCheckAIPlan(aiPlan) {
  if (!aiPlan || aiPlan.fallback) return aiPlan;
  const claims = extractClaims(aiPlan);
  if (!claims.length) return aiPlan;

  const claimList = claims.map((c, i) => `${i + 1}. [${c.source}] ${c.text}`).join('\n');
  const userPrompt = `以下のサッカー動画企画書の主張リストを確認し、歴史的事実（優勝記録・達成記録・選手経歴・年号等）に誤りまたは要確認事項があるものだけJSONで返してください。問題なければ flags:[]

【確認ポイント】
- タイトル獲得（例: ○○は同シーズンにプレミアとCLを制覇、史上初の○○）
- 選手の移籍・クラブ在籍事実
- 年号と大会名の対応

【主張リスト】
${claimList}

{"flags":[{"index":1,"source":"...","issue":"何が問題か一文で","severity":"high|medium"}]}`;

  let flagResult;
  try {
    const raw = await callAI({
      system: 'あなたはサッカー事実確認専門AIです。JSONのみ返してください。',
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 800,
      forceProvider: 'gemini',
      label: '⑤factcheck_plan',
    });
    flagResult = parseFlags(raw);
  } catch (e) {
    console.warn('[v3_fact_checker] plan check failed, skipping:', e.message);
    return aiPlan;
  }

  const flags = (flagResult?.flags || []).filter((f) => f.severity === 'high' || f.severity === 'medium');
  if (!flags.length) return aiPlan;

  console.log(`[v3_fact_checker] ${flags.length}件フラグ → publishGates に追加`);
  return {
    ...aiPlan,
    publishGates: [
      ...(aiPlan.publishGates || []),
      ...flags.map((f) => `[要確認 ${f.source}] ${f.issue}`),
    ],
    factCheckFlags: flags,
  };
}

/**
 * ナレーション草稿スライド配列をファクトチェック。
 * フラグを付けて返す（スライド本文は修正しない）。
 */
async function factCheckScript(slides) {
  if (!Array.isArray(slides) || !slides.length) return { slides, flags: [] };

  const narrations = slides.slice(0, 10)
    .map((s, i) => `${i + 1}. ${String(s.narration || '').slice(0, 180)}`)
    .join('\n');

  const userPrompt = `以下のサッカー動画ナレーション草稿を確認し、歴史的事実（優勝記録・達成記録・年号等）に誤りまたは要確認事項がある箇所だけJSONで返してください。問題なければ flags:[]

${narrations}

{"flags":[{"slideNo":1,"quote":"問題箇所の引用（30字以内）","issue":"何が問題か一文で","severity":"high|medium"}]}`;

  let flagResult;
  try {
    const raw = await callAI({
      system: 'あなたはサッカー事実確認専門AIです。JSONのみ返してください。',
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 600,
      forceProvider: 'gemini',
      label: '⑤factcheck_script',
    });
    flagResult = parseFlags(raw);
  } catch (e) {
    console.warn('[v3_fact_checker] script check failed, skipping:', e.message);
    return { slides, flags: [] };
  }

  const flags = (flagResult?.flags || []).filter((f) => f.severity === 'high' || f.severity === 'medium');
  if (flags.length) {
    console.log(`[v3_fact_checker] script: ${flags.length}件フラグ`);
  }
  return { slides, flags };
}

module.exports = { factCheckAIPlan, factCheckScript };
