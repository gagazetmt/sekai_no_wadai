// routes/v25_autopilot_routes.js
// V2.5 autopilot: V2 data/structure/script/editing as the mothership,
// with V3 plan proposals and V3 image fetching attached as helpers.
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const { createJob, readJob, updateJob } = require('./_job_helper');
const { _runSuggestLabels, _runFetchAll, _runRefineLabelsFromArticles } = require('./step2_routes');
const { _runProposeModules } = require('./step3_routes');
const { generateAIPlan } = require('../v3_launcher/v3_planner');
const { fetchAndAssignSlideImages } = require('../v3_launcher/v3_image_fetcher');
const { getBindingMeta, buildDataSlotsFromMeta, resolveCustomSlotKeys } = require('../scripts/v2_story/binding_meta');
const costTracker = require('../scripts/cost_tracker');

const router = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR = path.join(DATA_DIR, 'si_data');
const PLAN_DIR = path.join(DATA_DIR, 'v25_plans');
if (!fs.existsSync(PLAN_DIR)) fs.mkdirSync(PLAN_DIR, { recursive: true });

const PLAYER_IMAGE_TYPES = new Set(['stats', 'profile', 'comparison']);

// コスト計測: グローバル _log のインデックスを起点に、その後追加された
//   AIコール分だけを集計する（ジョブ単位のコスト。 並行ジョブと混ざらない）。
function costMarker() { return costTracker.getSummary().entries.length; }
function costDeltaSince(startLen) {
  const all = costTracker.getSummary().entries;
  const slice = all.slice(startLen);
  const byProvider = {};
  let totalUsd = 0;
  slice.forEach(e => {
    totalUsd += e.costUsd;
    if (!byProvider[e.provider]) byProvider[e.provider] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    byProvider[e.provider].calls++;
    byProvider[e.provider].inputTokens += e.inputTokens;
    byProvider[e.provider].outputTokens += e.outputTokens;
    byProvider[e.provider].costUsd = Number((byProvider[e.provider].costUsd + e.costUsd).toFixed(6));
  });
  return {
    calls: slice.length,
    totalUsd: Number(totalUsd.toFixed(6)),
    totalJpy: Number((totalUsd * 150).toFixed(2)),
    byProvider,
    entries: slice.map(e => ({ label: e.label, provider: e.provider, inputTokens: e.inputTokens, outputTokens: e.outputTokens, costJpy: e.costJpy })),
  };
}
function safeFileId(id) { return String(id || 'unknown').replace(/[/\\?%*:|"<>.]/g, '_'); }
function safeJson(file, fallback) {
  try { if (!fs.existsSync(file)) return fallback; return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}
function siPath(postId) { return path.join(SI_DIR, safeFileId(postId) + '.json'); }
function modulesPath(postId) { return path.join(DATA_DIR, safeFileId(postId) + '_modules.json'); }
function planPath(postId) { return path.join(PLAN_DIR, safeFileId(postId) + '.json'); }
function readProject(postId) {
  const saved = safeJson(path.join(DATA_DIR, 'saved_projects.json'), []);
  return (Array.isArray(saved) ? saved : []).find(p => p.id === postId) || null;
}
function normalizeProjectPost(project) {
  const raw = project?.raw || {};
  const comments = (raw.comments || []).map(c => ({ body: c.bodyJa || c.body || c.text || '' })).filter(c => c.body);
  const body = raw.selftext || raw.bodyJa || raw.body || raw.customNote || '';
  return { id: project.id, title: project.titleOrig || raw.titleOrig || raw.title || project.title || '', titleJa: project.title || raw.titleJa || '', titleOrig: project.titleOrig || raw.titleOrig || raw.title || '', selftext: body, raw: { ...raw, selftext: body, comments } };
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function isSentenceFragment(label) {
  const s = String(label || '').trim();
  if (!s || s.length > 55) return true;
  if (/\b(everything|turned into|days|reminded|some idiot|asked|basically|goodbye)\b/i.test(s)) return true;
  const words = s.split(/\s+/).filter(Boolean);
  const lowerWords = words.filter(w => /^[a-z]/.test(w)).length;
  return words.length >= 4 && lowerWords >= 3 && !/[A-Z][a-z]+\s+[A-Z][a-z]+/.test(s);
}
function isContextualNoise(label, projectText) {
  const l = String(label || '');
  const t = String(projectText || '');
  if (/Fernando Alonso|フェルナンド\s*アロンソ/i.test(l) && !/F1|Formula|motor|racing|フェルナンド/i.test(t)) return true;
  if (/Marcos Alonso|マルコス\s*アロンソ/i.test(l) && !/Marcos|マルコス/i.test(t)) return true;
  return false;
}
function filterLabelItems(suggested, project) {
  const projectText = [project.title, project.titleOrig, project.raw?.bodyJa, project.raw?.body, project.raw?.customNote].filter(Boolean).join('\n');
  const out = [];
  const seen = new Set();
  const push = (box, label, role) => {
    const clean = String(label || '').trim();
    if (!clean || isSentenceFragment(clean) || isContextualNoise(clean, projectText)) return;
    const key = box + ':' + norm(clean);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(role ? { box, label: clean, role } : { box, label: clean });
  };
  (suggested.entities || []).forEach(e => push('entity', e.name, e.role));
  (suggested.matches || []).forEach(m => push('match', m));
  (suggested.searches || []).forEach(s => push('search', s));
  return out.slice(0, 14);
}
function roleItems(si, role = null) {
  const arr = si?.boxes?.entity?.items || [];
  return arr.filter(it => it?.label && (!role || it.role === role));
}
function findEntityLabel(text, si, preferredRole = null) {
  const n = norm(text);
  const preferred = preferredRole ? roleItems(si, preferredRole) : [];
  const rest = roleItems(si).filter(x => !preferredRole || x.role !== preferredRole);
  const items = preferred.concat(rest);
  return items.find(it => n.includes(norm(it.label)))?.label || items[0]?.label || null;
}
function findComparisonPair(text, si) {
  const n = norm(text);
  const items = roleItems(si).filter(it => ['player', 'manager', 'team'].includes(it.role));
  const hits = items.filter(it => n.includes(norm(it.label)));
  const pool = hits.length >= 2 ? hits : items;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) if (pool[i].role === pool[j].role) return [pool[i].label, pool[j].label];
  return null;
}
function firstMatchLabel(si) { return (si?.boxes?.match?.items || []).find(it => it?.label)?.label || null; }
function normalizeType(type, index, total) {
  if (index === 0) return 'opening';
  if (index === total - 1) return 'ending';
  const t = String(type || '').toLowerCase();
  if (t === 'simple') return 'insight';
  if (['history', 'comparison', 'stats', 'profile', 'insight', 'reaction', 'matchcard', 'ranking', 'timeline', 'picture'].includes(t)) return t;
  return 'insight';
}
function candidateOutline(aiPlan) {
  const proposal = aiPlan?.themeProposal || {};
  const selected = Number.isInteger(proposal.selected) ? proposal.selected : 0;
  const candidate = (proposal.candidates || [])[selected] || (proposal.candidates || [])[0] || {};
  const outline = Array.isArray(candidate.slideOutline) && candidate.slideOutline.length ? candidate.slideOutline : (Array.isArray(aiPlan?.briefing?.slideOutline) ? aiPlan.briefing.slideOutline : []);
  return { selected, candidate, outline };
}
function buildModulesFromV3Plan(aiPlan, si) {
  const { selected, candidate, outline } = candidateOutline(aiPlan);
  const base = outline.length ? outline : [
    { no: 1, slideType: 'opening', headline: candidate.hookQuestion || 'Opening', point: candidate.angle || '' },
    { no: 2, slideType: 'insight', headline: candidate.answer || '論点整理', point: candidate.angle || '' },
    { no: 3, slideType: 'ending', headline: 'まとめ', point: aiPlan?.briefing?.coreMessage || '' },
  ];
  const modules = base.map((slide, idx) => {
    const type = normalizeType(slide.slideType || slide.type, idx, base.length);
    const text = [slide.headline, slide.point, ...(slide.dataNeeds || [])].filter(Boolean).join(' ');
    let mainKey = type === 'opening' ? 'opening' : (type === 'ending' ? 'ending' : '');
    let secondary = null;
    if (!mainKey) {
      if (type === 'matchcard') {
        const m = firstMatchLabel(si);
        mainKey = m ? 'matchcard:' + m : 'entity:' + (findEntityLabel(text, si) || '');
      } else if (type === 'comparison') {
        const pair = findComparisonPair(text, si);
        if (pair) { mainKey = 'entity:' + pair[0]; secondary = pair[1]; }
        else mainKey = 'entity:' + (findEntityLabel(text, si) || '');
      } else if (type === 'stats' || type === 'profile') {
        mainKey = 'entity:' + (findEntityLabel(text, si) || '');
      } else {
        const label = findEntityLabel(text, si) || firstMatchLabel(si);
        mainKey = label ? 'entity:' + label : 'opening';
      }
    }
    return { type, mainKey, secondary, title: String(slide.headline || candidate.hookQuestion || ('Slide ' + (idx + 1))).slice(0, 90), scriptDir: String(slide.point || slide.headline || '').slice(0, 220), v25Meta: { source: 'v3_plan', selectedCandidate: selected, originalSlide: slide } };
  });
  if (modules[0]?.type !== 'opening') modules.unshift({ type: 'opening', mainKey: 'opening', title: candidate.hookQuestion || 'Opening', scriptDir: candidate.angle || '', v25Meta: { source: 'v3_plan_forced_opening' } });
  if (modules[modules.length - 1]?.type !== 'ending') modules.push({ type: 'ending', mainKey: 'ending', title: 'まとめ', scriptDir: aiPlan?.briefing?.coreMessage || '', v25Meta: { source: 'v3_plan_forced_ending' } });
  return modules;
}
// 🆕 V2.5 Fix#4: 選択した企画書(候補) を seed に V2 _runProposeModules を呼び、
//   SI データに接地した V2 互換モジュールを得る。V2 の構成知性を使うのが要点。
//   _runProposeModules が失敗したら buildModulesFromV3Plan にフォールバック。
async function buildModulesViaV2(postId, aiPlan, selectedIndex, si, opts = {}) {
  const proposal = aiPlan?.themeProposal || {};
  const candidates = Array.isArray(proposal.candidates) ? proposal.candidates : [];
  const idx = Number.isInteger(selectedIndex)
    ? selectedIndex
    : (Number.isInteger(proposal.selected) ? proposal.selected : 0);
  const candidate = candidates[idx] || candidates[0] || {};
  const seedPlan = {
    hookQuestion: candidate.hookQuestion || '',
    angle: candidate.angle || '',
    answer: candidate.answer || '',
    storyPattern: candidate.storyPattern || '',
    slideOutline: Array.isArray(candidate.slideOutline) ? candidate.slideOutline : [],
    structureNote: candidate.structureNote || '',
  };
  const count = Math.max(4, Math.min(10, Number(candidate.recommendedSlideCount) || Number(opts.count) || 7));
  try {
    const result = await _runProposeModules(postId, count, { sprint: opts.sprint, seedPlan });
    if (result?.modules?.length) {
      return { modules: result.modules, via: 'v2_propose_modules', used: result.used, selectedIndex: idx, candidate };
    }
    console.warn('[v25] _runProposeModules returned empty → fallback to buildModulesFromV3Plan');
  } catch (e) {
    console.warn('[v25] _runProposeModules failed → fallback:', e.message);
  }
  const fallbackPlan = { ...aiPlan, themeProposal: { ...proposal, selected: idx } };
  return { modules: buildModulesFromV3Plan(fallbackPlan, si), via: 'v3_plan_fallback', selectedIndex: idx, candidate };
}
function applyBindingGuards(modules, si) {
  const demotions = [];
  const guarded = modules.map((mod, idx) => {
    const next = { ...mod };
    if (next.type === 'comparison') {
      const meta = getBindingMeta(next, si);
      if (!meta || !meta.isCompare) {
        demotions.push({ index: idx + 1, from: 'comparison', to: 'insight', reason: 'comparison requires two fetched entities of the same role' });
        next.type = 'insight'; next.secondary = null; next.binding = null; next.customSlotKeys = []; next.dataSlots = [];
        return next;
      }
    }
    if (['stats', 'profile', 'comparison', 'matchcard'].includes(next.type)) {
      const meta = getBindingMeta(next, si);
      if (!meta) {
        demotions.push({ index: idx + 1, from: next.type, to: 'insight', reason: 'no fetched data binding' });
        next.type = 'insight'; next.binding = null; next.customSlotKeys = []; next.dataSlots = [];
        return next;
      }
      const sel = resolveCustomSlotKeys(meta, next);
      next.binding = { subject: meta.subject, aspect: meta.aspect, primary: meta.primary, secondary: meta.secondary || null };
      next.customSlotKeys = sel.keys;
      next.dataSlots = buildDataSlotsFromMeta(meta, sel.keys);
    }
    return next;
  });
  return { modules: guarded, demotions };
}
function buildResearchCorpus(project, si, articles = []) {
  const learningCorpus = [];
  const raw = project.raw || {};
  const body = raw.bodyJa || raw.body || raw.selftext || raw.customNote || '';
  if (body) learningCorpus.push({ title: project.title || project.titleOrig || 'case', host: 'saved_project', text: body, score: 100 });
  (raw.comments || []).slice(0, 8).forEach((c, i) => { const text = c.bodyJa || c.body || ''; if (text) learningCorpus.push({ title: 'reddit_comment_' + (i + 1), host: 'reddit', text, score: 60 - i }); });
  // ②-2 で収集した約15記事を熟読コーパスとして全件投入（Fix#2: 企画提案が記事を熟読する）
  (Array.isArray(articles) ? articles : []).forEach((a, i) => {
    const text = [a.title, a.snippet].filter(Boolean).join('\n');
    if (text) learningCorpus.push({ title: a.title || ('article_' + (i + 1)), host: a.host || 'search', url: a.link || '', text, score: 85 - i });
  });
  // 旧経路: si.boxes.search が残っている場合も拾う（V2.5 では通常空）
  (si?.boxes?.search?.items || []).forEach((it) => {
    const org = it.data?.organic || [];
    org.slice(0, 4).forEach((r, i) => {
      const text = [r.title, r.snippet].filter(Boolean).join('\n');
      if (text) learningCorpus.push({ title: r.title || it.label, host: (() => { try { return new URL(r.link).hostname; } catch (_) { return 'search'; } })(), url: r.link || '', text, score: 80 - i });
    });
  });
  (si?.curatedArticles?.articles || []).forEach((a, i) => {
    const text = [a.title, a.summary, a.text].filter(Boolean).join('\n');
    if (text) learningCorpus.push({ title: a.title || ('curated_' + (i + 1)), host: a.host || 'curated', url: a.url || '', text, score: 90 - i });
  });
  return { learningCorpus };
}
function fetchedDataFromSi(si) {
  const out = [];
  for (const it of roleItems(si)) {
    const fakeType = it.role === 'manager' ? 'profile' : 'stats';
    const meta = getBindingMeta({ type: fakeType, mainKey: 'entity:' + it.label }, si);
    const slots = meta ? meta.availableSlots.slice(0, 14).map(s => ({ label: s.label, value: s.value })) : [];
    out.push({ ok: !!meta, name: it.label, label: it.label, type: it.role, slots, source: 'v2_si' });
  }
  return out;
}
function imageInstructionForModule(mod, si) {
  const primary = mod.mainKey?.startsWith('entity:') ? mod.mainKey.slice(7) : '';
  const primaryItem = roleItems(si).find(it => it.label === primary);
  const team = primaryItem?.sofa?.team || primaryItem?.sofa?.teamName || primaryItem?.tm?.team || '';
  const common = [primary, team, mod.title].filter(Boolean).slice(0, 4);
  if (mod.type === 'comparison' && mod.secondary) {
    const secondaryItem = roleItems(si).find(it => it.label === mod.secondary);
    const team2 = secondaryItem?.sofa?.team || secondaryItem?.sofa?.teamName || '';
    return { placement: 'left+right', left: { searchKeywords: [primary, team].filter(Boolean) }, right: { searchKeywords: [mod.secondary, team2].filter(Boolean) }, description: mod.title || mod.scriptDir || '' };
  }
  return { placement: PLAYER_IMAGE_TYPES.has(mod.type) ? 'left' : 'background', searchKeywords: common, description: mod.scriptDir || mod.title || '' };
}
async function attachV3Images(modules, si, onProgress) {
  const slides = modules.map((m, i) => ({ no: i + 1, slideType: m.type, headline: m.title || m.scriptDir || '', imageInstruction: imageInstructionForModule(m, si) }));
  onProgress?.({ step: 'v3-images', message: 'V3 image fetcher running' });
  const withImages = await fetchAndAssignSlideImages(slides);
  return modules.map((m, i) => ({ ...m, images: withImages[i]?.images || m.images || [], imageCandidates: withImages[i]?.imageCandidates || m.imageCandidates || [], imageInstruction: slides[i].imageInstruction }));
}
async function runV25Job(jobId, { postId, count = 7, sprint = false, attachImages = true }) {
  const onProgress = (patch) => updateJob(jobId, patch);
  const costStart = costMarker();
  const project = readProject(postId);
  if (!project) throw new Error('saved project not found: ' + postId);
  onProgress({ status: 'running', step: '2-1-labels', message: '②-1 V2 検索クエリ/暫定ラベル提案' });
  const post = normalizeProjectPost(project);
  const suggested = await _runSuggestLabels(post, onProgress, { sprint });

  // ②-2 記事収集 ＋ ②-3 記事熟読 → 精度版ラベル再提案（検索クエリ≠取得ラベル）
  onProgress({ step: '2-3-refine', message: '②-2/②-3 記事熟読→精度版ラベル再提案' });
  const refineResult = await _runRefineLabelsFromArticles(post, suggested, { sprint });
  const refined = refineResult.refined || suggested;
  const articles = refineResult.articles || [];

  // fetch 対象は entity / match のみ（検索クエリは収集専用でデータ取得ラベルにしない）
  const items = filterLabelItems(refined, project).filter(it => it.box !== 'search');
  if (!items.length) throw new Error('②-3 refined labels returned no usable entity/match labels');
  onProgress({ step: '2-4-fetch', total: items.length, progress: 0, message: '②-4 V2 データ取得' });
  const fetched = await _runFetchAll({ postId, items }, (p) => onProgress({ ...p, step: '2-4-fetch' }));
  const si = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } });
  onProgress({ step: '3-v3-proposal', message: '③ V3 企画提案 A/B/C（②全情報を熟読）' });
  const researchCorpus = buildResearchCorpus(project, si, articles);
  const fetchedData = fetchedDataFromSi(si);
  const memo = [project.titleOrig || project.title || '', 'V2.5 policy: Step1/2 are V2, proposal A/B/C is V3, script generation/editing/video generation remain V2.'].filter(Boolean).join('\n');
  const aiPlan = await generateAIPlan(project.title || project.titleOrig || post.title || 'soccer topic', memo, researchCorpus, { results: [] }, fetchedData);
  const candidates = (aiPlan?.themeProposal?.candidates) || [];

  // 3案方式: ③で停止。 脚本構成(④)はパネルで企画書を選択後 /v25/structure で行う。
  const cost = costDeltaSince(costStart);
  console.log(`[v25] proposal完了: ${candidates.length}案 / cost ¥${cost.totalJpy} ($${cost.totalUsd}) / ${cost.calls}コール`);
  const planRecord = { postId, source: 'v25_autopilot', savedAt: new Date().toISOString(), stage: 'proposal', policy: { step1: 'V2', step2: 'V2', proposal: 'V3', structure: 'V2-compatible from V3 proposal', script: 'V2', editing: 'V2', images: 'V3 named official-X image fetcher', video: 'V2', knownIssue: 'subtitle bar / narration timing drift' }, suggested, refined, articles, articleCount: articles.length, refineUsedAI: refineResult.usedAI, usedItems: items, fetched, aiPlan, proposalCost: cost };
  fs.writeFileSync(planPath(postId), JSON.stringify(planRecord, null, 2));
  return {
    ok: true, postId, stage: 'proposal', labels: items.length, fetched: fetched?.count || items.length,
    articleCount: articles.length, proposals: candidates.length,
    candidates: candidates.map((c, i) => ({ index: i, hookQuestion: c.hookQuestion || '', angle: c.angle || '', videoLengthType: c.videoLengthType || '', recommendedSlideCount: c.recommendedSlideCount || (c.slideOutline ? c.slideOutline.length : 0) })),
    cost, planPath: planPath(postId),
  };
}
router.post('/v25/autopilot/start', express.json(), (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const jobId = createJob('v25', { postId, kind: 'v25-autopilot', step: 'init' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try { updateJob(jobId, { status: 'running', step: 'init' }); updateJob(jobId, { status: 'done', step: 'done', result: await runV25Job(jobId, req.body || {}) }); }
    catch (e) { console.error('[v25/autopilot]', e); updateJob(jobId, { status: 'error', error: e.message }); }
  });
});
router.get('/v25/autopilot/status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});
router.get('/v25/plan', (req, res) => {
  const { postId } = req.query;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  res.json(safeJson(planPath(postId), { postId, ok: false, error: 'plan not found' }));
});

// 🆕 V2.5 Fix#3: 企画書 A/B/C 選択＋微修正パネルから脚本構成を(再)生成する。
//   保存済み plan の aiPlan を使い、選択 index と微修正(editedCandidate)を反映して
//   V2 _runProposeModules で構成 → modules.json を上書き。
router.post('/v25/structure', express.json(), (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const jobId = createJob('v25s', { postId, kind: 'v25-structure', step: 'init' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      const { selectedIndex, editedCandidate, sprint, attachImages = true, count } = req.body || {};
      const costStart = costMarker();
      updateJob(jobId, { status: 'running', step: 'structure', message: '④ V2 脚本構成 (選択企画書 seed)' });
      const plan = safeJson(planPath(postId), null);
      if (!plan?.aiPlan) throw new Error('saved plan not found for ' + postId + ' (先に企画提案を実行)');
      const aiPlan = plan.aiPlan;
      const idx = Number.isInteger(selectedIndex) ? selectedIndex : (aiPlan.themeProposal?.selected || 0);
      // 微修正パネルの編集を選択候補に反映
      if (editedCandidate && typeof editedCandidate === 'object') {
        const cands = aiPlan.themeProposal?.candidates || [];
        if (cands[idx]) cands[idx] = { ...cands[idx], ...editedCandidate };
      }
      const si = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] }, search: { items: [] } } });
      const built = await buildModulesViaV2(postId, aiPlan, idx, si, { sprint, count });
      const guarded = applyBindingGuards(built.modules, si);
      let modules = guarded.modules;
      let imageError = '';
      if (attachImages) {
        try { modules = await attachV3Images(modules, si, (p) => updateJob(jobId, p)); }
        catch (e) { imageError = e.message; console.warn('[v25/structure] image attach failed:', e.message); }
      }
      const cost = costDeltaSince(costStart);
      console.log(`[v25/structure] 案${built.selectedIndex} 構成完了: ${modules.length}枚 / cost ¥${cost.totalJpy} ($${cost.totalUsd})`);
      fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules, savedAt: new Date().toISOString(), source: 'v25_structure', selectedProposal: built.selectedIndex }, null, 2));
      plan.selectedProposal = built.selectedIndex; plan.structureVia = built.via; plan.editedCandidate = editedCandidate || null; plan.structureSavedAt = new Date().toISOString(); plan.structureCost = cost;
      fs.writeFileSync(planPath(postId), JSON.stringify(plan, null, 2));
      updateJob(jobId, { status: 'done', step: 'done', result: { ok: true, postId, selectedProposal: built.selectedIndex, structureVia: built.via, modules, moduleCount: modules.length, demotions: guarded.demotions, imageAssignedCount: modules.filter(m => Array.isArray(m.images) && m.images.length).length, imageError, cost } });
    } catch (e) {
      console.error('[v25/structure]', e);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});
router.get('/v25/structure/status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});
module.exports = { router, runV25Job };
