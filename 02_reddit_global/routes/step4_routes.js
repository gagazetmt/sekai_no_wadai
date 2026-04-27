// routes/step4_routes.js  (V3 redesign)
// ═══════════════════════════════════════════════════════════
// STEP 4: シナリオ確認 + 微調整 + 動画生成（V3）
//   - V3 module shape を表示・編集
//   - 動画生成 / プレビュー / 単体ナレーション再生成
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

const { callAI } = require('../scripts/ai_client');

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, '..', 'data');
const SI_DIR    = path.join(DATA_DIR, 'si_data');
const VIDEO_DIR = path.join(DATA_DIR, 'v2_videos');
const JOB_DIR   = path.join(DATA_DIR, 'v2_jobs');

[VIDEO_DIR, JOB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}
function modulesPath(postId) { return path.join(DATA_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '_modules.json'); }
function siPath(postId)      { return path.join(SI_DIR,   (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '.json'); }

// ─── /v2/modules : 読み込み ─────────────────────────────
router.get('/v2/modules', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  res.json(safeJson(modulesPath(postId), { modules: [] }));
});

// ─── /v2/recipe-slots : binding 経由で comparison カードの全 availableSlots を実値評価 ─
// Input:  ?postId=...&moduleIdx=N
// Output: { ok, subject, aspect, primary, secondary,
//           selected: [...keys],
//           categories: [{ name, slots: [{key, label, leftValue, rightValue, priority}] }] }
router.get('/v2/recipe-slots', (req, res) => {
  try {
    const { getRecipe, findEntity, buildDataSlotsFromRecipe } = require('../scripts/v2_story/recipes');
    const postId    = req.query.postId;
    const moduleIdx = parseInt(req.query.moduleIdx, 10);
    if (!postId || Number.isNaN(moduleIdx)) {
      return res.status(400).json({ error: 'postId + moduleIdx required' });
    }
    const modulesData = safeJson(modulesPath(postId), { modules: [] });
    const mod = (modulesData.modules || [])[moduleIdx];
    if (!mod) return res.status(404).json({ error: 'module not found' });

    // binding が無ければ legacy → siBindingLeft/Right + type=comparison から推測
    let binding = mod.binding;
    if (!binding && mod.type === 'comparison' && mod.siBindingLeft && mod.siBindingRight) {
      const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
      const items = si.boxes?.entity?.items || [];
      const findRole = (label) => items.find(it => it.label === label)?.role || null;
      const r1 = findRole(mod.siBindingLeft);
      const r2 = findRole(mod.siBindingRight);
      let subject, aspect;
      if (r1 === 'player'  && r2 === 'player')  { subject = 'player';  aspect = 'compareCareerStats'; }
      else if (r1 === 'team'    && r2 === 'team')    { subject = 'team';    aspect = 'compareSeasonStats'; }
      else if (r1 === 'manager' && r2 === 'manager') { subject = 'manager'; aspect = 'compareCareer'; }
      if (subject) binding = { subject, aspect, primary: mod.siBindingLeft, secondary: mod.siBindingRight };
    }
    if (!binding?.subject || !binding?.aspect) {
      return res.json({ ok: false, error: 'comparison binding が解決できませんでした' });
    }

    const recipe = getRecipe(binding.subject, binding.aspect);
    if (!recipe?.availableSlots?.length) {
      return res.json({ ok: false, error: `recipe "${binding.subject}.${binding.aspect}" が無効` });
    }

    const si = safeJson(siPath(postId), { boxes: {} });
    const primaryData   = findEntity(si, binding.subject, binding.primary);
    const secondaryData = binding.secondary ? findEntity(si, binding.subject, binding.secondary) : null;

    // 全 availableSlots を評価して category 別にグループ化
    const groups = {};
    recipe.availableSlots.forEach(slot => {
      const cat = slot.category || 'その他';
      if (!groups[cat]) groups[cat] = [];
      const leftValue  = primaryData   ? String(slot.extract(primaryData,   {}) ?? '-') : '-';
      const rightValue = secondaryData ? String(slot.extract(secondaryData, {}) ?? '-') : '-';
      groups[cat].push({
        key:      slot.key,
        label:    slot.label,
        priority: slot.priority || 0,
        leftValue, rightValue,
      });
    });

    // category 内で priority降順
    Object.values(groups).forEach(arr => arr.sort((a, b) => (b.priority || 0) - (a.priority || 0)));
    // category 自体は最大 priority 降順
    const categories = Object.entries(groups)
      .map(([name, slots]) => ({ name, slots, maxPriority: Math.max(...slots.map(s => s.priority || 0)) }))
      .sort((a, b) => b.maxPriority - a.maxPriority)
      .map(({ name, slots }) => ({ name, slots }));

    // 現在 dataSlots に入ってる key を集計
    const selected = (mod.dataSlots || [])
      .map(s => s.slotKey)
      .filter(Boolean);

    res.json({
      ok: true,
      subject:   binding.subject,
      aspect:    binding.aspect,
      primary:   binding.primary,
      secondary: binding.secondary,
      defaultSelection: recipe.defaultSelection || [],
      selected,
      categories,
    });
  } catch (e) {
    console.error('[v2/recipe-slots]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/apply-slot-keys : binding ベースでスロット選択を更新 ─
// Input:  { postId, moduleIdx, customSlotKeys: ['k1', ...] }
// Output: { ok, dataSlots }  ← 永続化も実施
router.post('/v2/apply-slot-keys', express.json(), (req, res) => {
  try {
    const { getRecipe, findEntity, buildDataSlotsFromRecipe } = require('../scripts/v2_story/recipes');
    const { postId, moduleIdx, customSlotKeys } = req.body || {};
    if (!postId || moduleIdx == null || !Array.isArray(customSlotKeys)) {
      return res.status(400).json({ error: 'postId + moduleIdx + customSlotKeys[] required' });
    }
    const mp = modulesPath(postId);
    const modulesData = safeJson(mp, { modules: [] });
    const mod = (modulesData.modules || [])[moduleIdx];
    if (!mod) return res.status(404).json({ error: 'module not found' });
    if (!mod.binding) return res.status(400).json({ error: 'module に binding が無い' });

    const recipe = getRecipe(mod.binding.subject, mod.binding.aspect);
    if (!recipe) return res.status(400).json({ error: 'recipe 解決失敗' });

    const si = safeJson(siPath(postId), { boxes: {} });
    const primaryData   = findEntity(si, mod.binding.subject, mod.binding.primary);
    const secondaryData = mod.binding.secondary ? findEntity(si, mod.binding.subject, mod.binding.secondary) : null;

    const validKeys = new Set(recipe.availableSlots.map(s => s.key));
    const keys = customSlotKeys.filter(k => validKeys.has(k));
    mod.dataSlots = buildDataSlotsFromRecipe(recipe, primaryData, secondaryData, keys, {});
    mod.binding = { ...mod.binding, customSlotKeys: keys };

    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));
    res.json({ ok: true, dataSlots: mod.dataSlots, customSlotKeys: keys });
  } catch (e) {
    console.error('[v2/apply-slot-keys]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/ai-fill-slide : スライド丸ごと AI 1発（type/title/dataSlots/narration）─
// Input:  { postId, moduleIdx, userPrompt }
// Output: { ok, type, title, dataSlots, narration, used }
router.post('/v2/ai-fill-slide', express.json(), async (req, res) => {
  const { postId, moduleIdx, userPrompt } = req.body || {};
  if (!postId || moduleIdx == null || !userPrompt) {
    return res.status(400).json({ error: 'postId + moduleIdx + userPrompt required' });
  }
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
    const modulesData = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const idx = parseInt(moduleIdx, 10);
    const mod = modulesData.modules?.[idx];
    if (!mod) return res.status(404).json({ error: 'idx out of range' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const items = si.boxes?.entity?.items || [];

    const _parseMK = (k) => {
      if (!k) return { type: 'unknown', name: '' };
      const c = k.indexOf(':');
      return c < 0 ? { type: k, name: '' } : { type: k.slice(0, c), name: k.slice(c + 1) };
    };
    const { name: primary } = _parseMK(mod.mainKey || '');
    const secondary = mod.secondary || mod.binding?.secondary || null;

    const { extractCareerFromInfobox, extractHonoursSection } = require('../scripts/modules/fetchers/wikipedia');

    function _entityContext(label) {
      if (!label) return '';
      const it = items.find(x => x.label === label) || {};
      const wikiExtract = it.wiki?.extract || '';
      const wikitext    = it.wiki?.wikitext || '';
      const sofa        = it.sofa || {};

      let careerStr = '';
      if (wikitext) {
        try {
          const career = extractCareerFromInfobox(wikitext);
          if (career?.length) {
            careerStr = career.map(c => {
              const yrs = (c.years?.start || '?') + '-' + (c.years?.end || '現在');
              const stats = [
                c.caps  != null ? c.caps  + '試合'  : null,
                c.goals != null ? c.goals + 'ゴール' : null,
              ].filter(Boolean).join(' ');
              return `${yrs}: ${c.club || '?'}${stats ? ' ' + stats : ''}`;
            }).join('\n');
          }
        } catch (_) {}
      }

      let honoursStr = '';
      if (wikitext) {
        try {
          const honours = extractHonoursSection(wikitext);
          if (honours?.length) {
            honoursStr = honours.map(h =>
              `[${h.category}]\n${(h.items || []).slice(0, 12).join('\n')}`
            ).join('\n\n');
          }
        } catch (_) {}
      }

      const sofaStr = sofa.ok ? JSON.stringify({
        name: sofa.name || sofa.teamName,
        position: sofa.position, team: sofa.team,
        league: sofa.leagueName, country: sofa.country,
        currentTeam: sofa.currentTeam,
        seasonStats: sofa.seasonStats,
        lastMatchStats: sofa.lastMatchStats,
        recentAvgRating: sofa.recentAvgRating,
        positionStats: sofa.positionStats,
        standing: sofa.standing,
        career: sofa.career,
        overallPerformance: sofa.overallPerformance,
        currentTeamStats: sofa.currentTeamStats,
        honours: sofa.honours,
        trophySummary: sofa.trophySummary,
        marketValue: sofa.marketValue,
        contractUntil: sofa.contractUntil,
      }).slice(0, 1500) : 'sofa:取得失敗';

      return `=== 主体: ${label} (${it.role || '?'}) ===
[Wikipedia 要約]
${wikiExtract.slice(0, 1500)}
${careerStr ? `
[Wikipedia キャリアテーブル]
${careerStr}
` : ''}${honoursStr ? `
[Wikipedia 獲得タイトル]
${honoursStr}
` : ''}
[Wikipedia 生データ抜粋]
${wikitext.slice(0, 3000)}

[SofaScore]
${sofaStr}
`;
    }

    const ctxPrimary   = _entityContext(primary);
    const ctxSecondary = secondary ? _entityContext(secondary) : '';

    // ── 案件全体の文脈（saved_projects.json から）──
    let projectCtx = '';
    try {
      const sp = safeJson(path.join(DATA_DIR, 'saved_projects.json'), []);
      const proj = (Array.isArray(sp) ? sp : []).find(p => p.id === postId);
      if (proj) {
        const topComments = (proj.raw?.comments || [])
          .slice(0, 5)
          .map(c => '- ' + (c.bodyJa || c.body || '').slice(0, 160))
          .filter(s => s.length > 4)
          .join('\n');
        projectCtx = `【案件全体の文脈】
タイトル: ${proj.title || proj.titleOrig || '(?)'}
原題: ${proj.titleOrig || '(?)'}
${topComments ? '上位コメント抜粋:\n' + topComments : ''}`;
      }
    } catch (_) {}

    // ── 前後スライドの要約（連続性の橋渡し用）──
    const allMods = modulesData.modules || [];
    function _sumSlide(m, prefix) {
      if (!m) return '';
      const ds = (m.dataSlots || []).slice(0, 3).map(s =>
        s.leftValue != null
          ? `${s.label}: ${s.leftValue} vs ${s.rightValue}`
          : `${s.label}: ${s.value}`
      ).join(' / ');
      return `[${prefix} type=${m.type} title=${m.title || ''}]
  narration: ${(m.narration || '').slice(0, 200)}
  dataSlots: ${ds || '(なし)'}`;
    }
    const prevSlides = [
      _sumSlide(allMods[idx - 2], '#' + (idx - 1)),
      _sumSlide(allMods[idx - 1], '#' + idx),
    ].filter(Boolean).join('\n');
    const nextSlides = [
      _sumSlide(allMods[idx + 1], '#' + (idx + 2)),
      _sumSlide(allMods[idx + 2], '#' + (idx + 3)),
    ].filter(Boolean).join('\n');

    const prompt = `あなたはサッカーYouTubeの脚本AI。スライド1枚の本体を完全に組み立てる。
type / title / dataSlots / narration を**一気通貫で**生成してください。

${projectCtx}

【現スライド情報（# ${idx + 1} 枚目 / 全 ${allMods.length} 枚）】
type: ${mod.type || '?'}
title: ${mod.title || ''}
mainKey: ${mod.mainKey || '?'}
${secondary ? 'secondary: ' + secondary : ''}
脚本指示: ${mod.scriptDir || '(指示なし)'}

${prevSlides ? '【前のスライド（流れの上流）】\n' + prevSlides : ''}

${nextSlides ? '【後のスライド（流れの下流）】\n' + nextSlides : ''}

【利用可能データ】
${ctxPrimary}
${ctxSecondary}

【ユーザー注文】
${userPrompt}

【生成ルール（厳守）】
- type は注文の意図に合わせて選ぶ（許容: insight/stats/profile/comparison/history/reaction）
  ・2人/2チーム比較なら "comparison"
  ・時系列の来歴・年表なら "history"
  ・数字データ並べる → "stats"
  ・基本情報カード → "profile"
  ・コメント反応 → "reaction"
  ・観点抽出 → "insight"
- dataSlots shape は type に応じて：
  ・comparison: [{"label":"指標","leftValue":"primaryの値","rightValue":"secondaryの値"}]
  ・history:    [{"label":"年(YYYY)","value":"出来事"}]
  ・stats/profile: [{"label":"項目","value":"値"}]
  ・insight: dataSlots は空配列、代わりに catchphrases を別途返してOK（今回は dataSlots 中心で）
- 件数: 4〜10件
- データに**明示されていない**値・固有名・数字は **絶対** 出さない（推測補完NG）
- **通算値（通算ゴール・通算試合等）は キャリアテーブル の合計値を計算して出す**
  例: バルサ672 + PSG 32 + マイアミ N → 「合計XXX」と算出
  ※案件タイトルに「961ゴール」のような最新数字があれば、そちらを優先（更新が早い）
- narration:
  ・**dataSlots と整合する**（dataSlots の数字・名前を使って語る）
  ・250〜320文字（40秒目安）
  ・視聴者に語りかける口調、熱量と説得力
  ・**前後のスライドと自然につながる橋渡しの語り口**を必ず使う：
    ・冒頭は前スライドからの転換（例「ここで」「ところで」「では」「数字を比較してみましょう」）
    ・末尾は次スライドへ意識を誘導（例「まさに〜の領域に達しようとしている」「次に注目すべきは〜」）
    ・前スライドで既に語った数字を不自然に再放出しない
    ・案件全体のメインテーマ（タイトル参照）を絶対に外さない
- title: 10〜25文字、フックのある表現

【出力】JSONのみ（マークダウン不要）:
{
  "type": "...",
  "title": "...",
  "dataSlots": [...],
  "narration": "..."
}`;

    let raw, parsed = null, used = 'deepseek';
    try {
      raw = await callAI({
        forceProvider: 'deepseek',
        model: 'deepseek-chat', max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
      });
      const m1 = raw && raw.match(/\{[\s\S]*\}/);
      if (m1) parsed = JSON.parse(m1[0]);
    } catch (e) { console.warn('[ai-fill-slide] deepseek 例外:', e.message); }
    if (!parsed?.type || !Array.isArray(parsed?.dataSlots)) {
      try {
        raw = await callAI({
          forceProvider: 'anthropic',
          model: 'claude-sonnet-4-6', max_tokens: 3500,
          messages: [{ role: 'user', content: prompt }],
        });
        const m2 = raw && raw.match(/\{[\s\S]*\}/);
        if (m2) parsed = JSON.parse(m2[0]);
        used = 'sonnet';
      } catch (_) {}
    }
    if (!parsed?.type || !Array.isArray(parsed?.dataSlots)) {
      return res.status(500).json({ error: 'AI応答のパースに失敗' });
    }

    // 反映（既存の siBindingLeft/Right や homeTeam/awayTeam 等の補助フィールドは温存）
    const ALLOWED_TYPES = ['insight','stats','profile','comparison','history','reaction','matchcard'];
    if (ALLOWED_TYPES.includes(parsed.type)) mod.type = parsed.type;
    if (typeof parsed.title === 'string')     mod.title = parsed.title;
    if (typeof parsed.narration === 'string') mod.narration = parsed.narration;
    mod.dataSlots = parsed.dataSlots;

    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));

    res.json({
      ok:        true,
      type:      mod.type,
      title:     mod.title,
      dataSlots: mod.dataSlots,
      narration: mod.narration,
      used,
    });
  } catch (e) {
    console.error('[v2/ai-fill-slide]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/ask-slot-ai : リトルAI 自然言語で dataSlots を埋める ─
// Input:  { postId, moduleIdx, userPrompt, mode: 'replace'|'append' }
// Output: { ok, dataSlots: [...新スロット], applied: true|false, mode }
router.post('/v2/ask-slot-ai', express.json(), async (req, res) => {
  const { postId, moduleIdx, userPrompt, mode } = req.body || {};
  if (!postId || moduleIdx == null || !userPrompt) {
    return res.status(400).json({ error: 'postId + moduleIdx + userPrompt required' });
  }
  const applyMode = mode === 'replace' ? 'replace' : 'append';
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
    const modulesData = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const idx = parseInt(moduleIdx, 10);
    const mod = modulesData.modules?.[idx];
    if (!mod) return res.status(404).json({ error: 'idx out of range' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const items = si.boxes?.entity?.items || [];

    // mainKey から主体エンティティ抽出
    const _parseMK = (k) => {
      if (!k) return { type: 'unknown', name: '' };
      const c = k.indexOf(':');
      return c < 0 ? { type: k, name: '' } : { type: k.slice(0, c), name: k.slice(c + 1) };
    };
    const { name: primary } = _parseMK(mod.mainKey || '');
    const secondary = mod.type === 'comparison' ? (mod.secondary || mod.binding?.secondary) : null;

    // Wikipedia 構造化抽出（Honours / Career table）
    const { extractCareerFromInfobox, extractHonoursSection } = require('../scripts/modules/fetchers/wikipedia');

    function _entityContext(label) {
      if (!label) return '';
      const it = items.find(x => x.label === label) || {};
      const wikiExtract = it.wiki?.extract || '';
      const wikitext    = it.wiki?.wikitext || '';
      const sofa        = it.sofa || {};

      // キャリアテーブル抽出（infobox の career セクション）
      let careerStr = '';
      if (wikitext) {
        try {
          const career = extractCareerFromInfobox(wikitext);
          if (career?.length) {
            careerStr = career.map(c => {
              const yrs = (c.years?.start || '?') + '-' + (c.years?.end || '現在');
              const stats = [
                c.caps  != null ? c.caps  + '試合'  : null,
                c.goals != null ? c.goals + 'ゴール' : null,
              ].filter(Boolean).join(' ');
              return `${yrs}: ${c.club || '?'}${stats ? ' ' + stats : ''}`;
            }).join('\n');
          }
        } catch (_) {}
      }

      // 獲得タイトル抽出（Honours セクション）
      let honoursStr = '';
      if (wikitext) {
        try {
          const honours = extractHonoursSection(wikitext);
          if (honours?.length) {
            honoursStr = honours.map(h =>
              `[${h.category}]\n${(h.items || []).slice(0, 12).join('\n')}`
            ).join('\n\n');
          }
        } catch (_) {}
      }
      // sofa は JSON、長すぎ防止に最大 1500 char
      const sofaStr = sofa.ok ? JSON.stringify({
        name: sofa.name || sofa.teamName,
        position: sofa.position, team: sofa.team,
        league: sofa.leagueName, country: sofa.country,
        currentTeam: sofa.currentTeam,
        seasonStats: sofa.seasonStats,
        lastMatchStats: sofa.lastMatchStats,
        recentAvgRating: sofa.recentAvgRating,
        last5Matches: sofa.last5Matches,
        positionStats: sofa.positionStats,
        standing: sofa.standing,
        career: sofa.career,
        overallPerformance: sofa.overallPerformance,
        currentTeamStats: sofa.currentTeamStats,
        honours: sofa.honours,
        trophySummary: sofa.trophySummary,
        marketValue: sofa.marketValue,
        contractUntil: sofa.contractUntil,
      }).slice(0, 1500) : 'sofa:取得失敗';

      return `=== 主体: ${label} (${it.role || '?'}) ===
[Wikipedia 要約]
${wikiExtract.slice(0, 1500)}
${careerStr ? `
[Wikipedia キャリアテーブル（infoboxから構造化抽出）]
${careerStr}
` : ''}${honoursStr ? `
[Wikipedia 獲得タイトル（Honoursセクション）]
${honoursStr}
` : ''}
[Wikipedia 生データ抜粋（補足）]
${wikitext.slice(0, 3000)}

[SofaScore]
${sofaStr}
`;
    }

    const ctxPrimary   = _entityContext(primary);
    const ctxSecondary = secondary ? _entityContext(secondary) : '';

    // type 別の shape 指定
    const shapeMap = {
      history:    '[{"label":"年（YYYY 等）","value":"出来事の説明（数字含む）"}]',
      stats:      '[{"label":"指標名","value":"値（数字+単位）"}]',
      profile:    '[{"label":"項目名","value":"値"}]',
      comparison: '[{"label":"指標名","leftValue":"primaryの値","rightValue":"secondaryの値"}]',
    };
    const shape = shapeMap[mod.type] || shapeMap.stats;

    const existingSlotsStr = (Array.isArray(mod.dataSlots) && mod.dataSlots.length)
      ? '\n【既存スロット（参考）】\n' + JSON.stringify(mod.dataSlots).slice(0, 800)
      : '';

    const prompt = `あなたはサッカーデータ抽出AI。下記のデータから、ユーザーの注文に従ってスライドのデータスロットを生成してください。

【スライド情報】
type: ${mod.type}
title: ${mod.title || ''}
mainKey: ${mod.mainKey || '?'}
${secondary ? 'secondary: ' + secondary : ''}
${existingSlotsStr}

【利用可能データ】
${ctxPrimary}
${ctxSecondary}

【ユーザー注文】
${userPrompt}

【出力ルール（厳守）】
- shape: ${shape}
- データに明示されていない値・固有名は **絶対に出さない**（推測・記憶からの補完NG）
- 数字（試合数・ゴール数・年齢等）は元データに数値として現れているもののみ
- ユーザーの注文に従う（順序・粒度・件数）
- 件数: 通常 4〜10件、ユーザー注文に明示があればそれに従う
- 余計な解説や前置きを入れず、JSONのみ返す

【出力】JSONのみ（マークダウン不要）:
{"dataSlots": [...]}`;

    let raw, parsed = null, used = 'deepseek';
    try {
      raw = await callAI({
        forceProvider: 'deepseek',
        model: 'deepseek-chat', max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }],
      });
      const m1 = raw && raw.match(/\{[\s\S]*\}/);
      if (m1) parsed = JSON.parse(m1[0]);
    } catch (e) { console.warn('[ask-slot-ai] deepseek 例外:', e.message); }
    if (!Array.isArray(parsed?.dataSlots)) {
      try {
        raw = await callAI({
          forceProvider: 'anthropic',
          model: 'claude-haiku-4-5-20251001', max_tokens: 2500,
          messages: [{ role: 'user', content: prompt }],
        });
        const m2 = raw && raw.match(/\{[\s\S]*\}/);
        if (m2) parsed = JSON.parse(m2[0]);
        used = 'haiku';
      } catch (_) {}
    }
    if (!Array.isArray(parsed?.dataSlots)) {
      return res.status(500).json({ error: 'AI応答のパースに失敗' });
    }

    const newSlots = parsed.dataSlots;
    let finalSlots;
    if (applyMode === 'append' && Array.isArray(mod.dataSlots)) {
      finalSlots = [...mod.dataSlots, ...newSlots];
    } else {
      finalSlots = newSlots;
    }

    mod.dataSlots = finalSlots;
    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));

    res.json({
      ok:        true,
      dataSlots: finalSlots,
      added:     newSlots,
      mode:      applyMode,
      used,
    });
  } catch (e) {
    console.error('[v2/ask-slot-ai]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/regen-narration : 1カードのナレーション再生成 ─
router.post('/v2/regen-narration', async (req, res) => {
  const { postId, idx } = req.body;
  if (!postId || idx == null) return res.status(400).json({ error: 'postId + idx required' });
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
    const j = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const m = j.modules?.[parseInt(idx, 10)];
    if (!m) return res.status(404).json({ error: 'idx out of range' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const entityCtx = (si.boxes.entity?.items || []).slice(0, 6).map(e => `- ${e.label} [${e.role}]`).join('\n');
    const prompt = `あなたはサッカーYouTubeの脚本家。1枚のスライドのナレーションだけを再生成してください。

【カード情報】
type: ${m.type}
mainKey: ${m.mainKey || '?'}
sub: ${m.subSource || '-'}:${m.subValue || '-'}
title: ${m.title || ''}
脚本指示: ${m.scriptDir || ''}

【既存のデータ（参考、ここから外れない）】
${m.dataSlots?.length ? 'dataSlots: ' + JSON.stringify(m.dataSlots).slice(0, 600) : ''}
${m.catchphrases?.length ? 'catchphrases: ' + JSON.stringify(m.catchphrases) : ''}

【関連entity】
${entityCtx}

【ルール】
- 視聴者に語りかける口調、80〜200文字
- データに無い固有名は出さない
- JSONのみ: {"narration":"..."}`;

    const raw = await callAI({
      forceProvider: 'deepseek',
      model: 'deepseek-chat', max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const m1 = raw.match(/\{[\s\S]*\}/);
    if (!m1) return res.status(500).json({ error: 'JSON parse failed' });
    const parsed = JSON.parse(m1[0]);
    if (!parsed.narration) return res.status(500).json({ error: 'narration empty' });
    res.json({ ok: true, narration: parsed.narration });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/generate-video : 動画生成ジョブ起動 ────────────
router.post('/v2/generate-video', (req, res) => {
  const { postId, modules } = req.body;
  if (!postId) return res.status(400).json({ error: 'postId required' });

  // モジュールが渡された場合は先に保存
  if (Array.isArray(modules) && modules.length) {
    try { fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2)); }
    catch (e) { console.warn('[Step4] modules保存失敗:', e.message); }
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const jp    = path.join(JOB_DIR, jobId + '.json');
  fs.writeFileSync(jp, JSON.stringify({
    jobId, postId, status: 'queued', createdAt: new Date().toISOString(),
  }, null, 2));

  const renderScript = path.join(__dirname, '..', 'scripts', 'v2_video', 'render.js');
  const proc = spawn('node', [renderScript, postId, jobId], {
    detached: true, stdio: 'ignore', cwd: path.join(__dirname, '..'),
  });
  proc.unref();

  console.log(`[Step4] 動画生成 job 起動: ${jobId} (postId: ${postId})`);
  res.json({ ok: true, jobId });
});

// ─── /v2/video-status : ジョブ進捗 ──────────────────────
router.get('/v2/video-status', (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const jp = path.join(JOB_DIR, jobId + '.json');
  if (!fs.existsSync(jp)) return res.status(404).json({ error: 'job not found' });
  try { res.json(JSON.parse(fs.readFileSync(jp, 'utf8'))); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /v2/videos : 生成済み動画一覧 ───────────────────────
router.get('/v2/videos', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const prefix = (postId || '').replace(/[\/\?%*:|"<>\.]/g, '_').slice(-20);
  try {
    const all = fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.mp4'));
    const videos = all.map(f => {
      const full = path.join(VIDEO_DIR, f);
      const st   = fs.statSync(full);
      return { file: f, sizeBytes: st.size, createdAt: st.birthtime || st.ctime, url: '/v2_videos/' + f };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos });
  } catch (e) { res.json({ videos: [], error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
// MiniMax TTS (Phase 5)
// ═══════════════════════════════════════════════════════════

const AUDIO_DIR = path.join(DATA_DIR, 'v2_audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

function audioDirFor(postId) {
  const safe = (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_');
  const dir  = path.join(AUDIO_DIR, safe);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── /v2/tts-presets : voice + model 候補リスト + デフォルト ──
router.get('/v2/tts-presets', (req, res) => {
  try {
    const tts = require('../scripts/v2_video/tts_minimax');
    res.json({
      voices: tts.PRESET_VOICES,
      models: tts.PRESET_MODELS,
      defaultVoice: tts.DEFAULT_VOICE,
      defaultModel: tts.DEFAULT_MODEL,
      emotions: ['(なし)', ...tts.ALLOWED_EMOTIONS],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /v2/tts-preview : 試聴用 (保存しない、base64 mp3 を返す) ──
router.post('/v2/tts-preview', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const { generateMiniMaxTTS } = require('../scripts/v2_video/tts_minimax');
    const { text, voiceId, model, emotion, speed, vol, pitch } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

    const tmpFile = path.join(AUDIO_DIR, `_preview_${Date.now()}_${Math.random().toString(36).slice(2,6)}.mp3`);
    await generateMiniMaxTTS({
      text: String(text).slice(0, 800),  // 試聴は800字までに制限
      outputPath: tmpFile,
      voiceId, model, emotion, speed, vol, pitch,
    });
    const buf = fs.readFileSync(tmpFile);
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    res.json({ ok: true, mime: 'audio/mpeg', base64: buf.toString('base64') });
  } catch (e) {
    console.warn('[tts-preview]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── /v2/tts-module : 確定生成 (chunk ごとに保存し module.audio[] にメタ書込) ──
router.post('/v2/tts-module', express.json(), async (req, res) => {
  try {
    const { generateMiniMaxTTS, splitIntoChunks, probeDurationSec } = require('../scripts/v2_video/tts_minimax');
    const { postId, moduleIdx, voiceId, model, emotion, speed, vol, pitch } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'postId required' });
    const idx = parseInt(moduleIdx, 10);
    if (Number.isNaN(idx)) return res.status(400).json({ error: 'moduleIdx required' });

    const mp = modulesPath(postId);
    const data = safeJson(mp, null);
    if (!data?.modules?.[idx]) return res.status(404).json({ error: 'module not found' });
    const mod = data.modules[idx];

    // chunk決定: opening/ending は narration のみ。chunk連動 type (insight/reaction/history) は narrationChunks 優先
    const chunkAware = ['insight', 'reaction', 'history'].includes(mod.type);
    const chunks = chunkAware
      ? splitIntoChunks(mod.narration, mod.narrationChunks)
      : [String(mod.narration || '').trim()].filter(Boolean);

    if (!chunks.length) return res.status(400).json({ error: 'narration empty' });

    const dir = audioDirFor(postId);
    // 旧ファイルを掃除
    try {
      fs.readdirSync(dir).filter(f => f.startsWith(`m${String(idx).padStart(2,'0')}_`)).forEach(f => {
        try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
      });
    } catch (_) {}

    const audio = [];
    for (let c = 0; c < chunks.length; c++) {
      const fname = `m${String(idx).padStart(2,'0')}_c${String(c).padStart(2,'0')}.mp3`;
      const out   = path.join(dir, fname);
      await generateMiniMaxTTS({
        text: chunks[c],
        outputPath: out,
        voiceId, model, emotion, speed, vol, pitch,
      });
      const dur = probeDurationSec(out);
      audio.push({
        chunkIdx: c,
        text: chunks[c],
        file: path.relative(path.join(__dirname, '..'), out).replace(/\\/g, '/'),
        durationSec: dur,
      });
    }

    // module に書き戻し
    mod.tts = {
      voiceId: voiceId || undefined,
      model:   model   || undefined,
      emotion: emotion || undefined,
      speed:   speed   ?? undefined,
      vol:     vol     ?? undefined,
      pitch:   pitch   ?? undefined,
      generatedAt: new Date().toISOString(),
    };
    mod.audio = audio;
    fs.writeFileSync(mp, JSON.stringify(data, null, 2));

    res.json({ ok: true, audio, totalDurationSec: audio.reduce((a, b) => a + (b.durationSec || 0), 0) });
  } catch (e) {
    console.warn('[tts-module]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── /v2/tts-audio : 生成済 mp3 を直接返す (UI再生用) ──
router.get('/v2/tts-audio', (req, res) => {
  try {
    const { postId, moduleIdx, chunkIdx } = req.query;
    if (!postId) return res.status(400).send('postId required');
    const c = parseInt(chunkIdx || '0', 10);
    const m = parseInt(moduleIdx, 10);
    if (Number.isNaN(m)) return res.status(400).send('moduleIdx required');
    const dir = audioDirFor(postId);
    const fname = `m${String(m).padStart(2,'0')}_c${String(c).padStart(2,'0')}.mp3`;
    const fp    = path.join(dir, fname);
    if (!fs.existsSync(fp)) return res.status(404).send('not found');
    res.set('Content-Type', 'audio/mpeg').sendFile(fp);
  } catch (e) { res.status(500).send(e.message); }
});

// ─── /v2/preview-slide : 1モジュールのスライドHTML ──────
router.get('/v2/preview-slide', (req, res) => {
  const { postId, idx } = req.query;
  if (!postId) return res.status(400).send('<!doctype html><title>err</title><body>postId required</body>');
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).send('<!doctype html><title>err</title><body>modules not found</body>');
    const { modules = [] } = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const i = Math.max(0, Math.min(modules.length - 1, parseInt(idx || '0', 10)));
    const mod = modules[i];
    if (!mod) return res.status(404).send('<!doctype html><title>err</title><body>module out of range</body>');

    const { buildOpeningHTML }    = require('../scripts/v2_video/slides/opening');
    const { buildEndingHTML }     = require('../scripts/v2_video/slides/ending');
    const { buildUniversalHTML }  = require('../scripts/v2_video/slides/universal');
    const { buildInsightHTML }    = require('../scripts/v2_video/slides/insight');
    const { buildHistoryHTML }    = require('../scripts/v2_video/slides/history');
    const { buildMatchcardHTML }  = require('../scripts/v2_video/slides/matchcard');
    const { buildProfileHTML }    = require('../scripts/v2_video/slides/profile');
    const { buildStatsHTML }      = require('../scripts/v2_video/slides/stats');
    const { buildComparisonHTML } = require('../scripts/v2_video/slides/comparison');
    const { buildReactionHTML }   = require('../scripts/v2_video/slides/reaction');
    const { mapImagesToModule }   = require('../scripts/v2_video/slides/_common');

    // images[] を type 別の slot に展開してから build
    const m = mapImagesToModule(mod);

    let html;
    switch (m.type) {
      case 'opening':     html = buildOpeningHTML(m);     break;
      case 'ending':      html = buildEndingHTML(m);      break;
      case 'insight':     html = buildInsightHTML(m);     break;
      case 'history':     html = buildHistoryHTML(m);     break;
      case 'matchcard':   html = buildMatchcardHTML(m);   break;
      case 'stats':       html = buildStatsHTML(m);       break;
      case 'profile':     html = buildProfileHTML(m);     break;
      case 'comparison':  html = buildComparisonHTML(m);  break;
      case 'reaction':    html = buildReactionHTML(m);    break;
      default:            html = buildUniversalHTML(m);
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) { res.status(500).send('<!doctype html><title>err</title><body>' + e.message + '</body>'); }
});

// ─── UI ─────────────────────────────────────────────────
function getUI() {
  return `
<div id="step4" class="step-container" style="display:none">
<div style="padding:0 20px 20px;">

  <!-- TOP -->
  <div class="panel" style="margin-bottom:12px;">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span id="s4Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件未選択</span>
      <button class="btn btn-sm" id="s4BtnSave" style="background:#3b82f6;color:#fff;">💾 保存</button>
      <button class="btn btn-success" id="s4BtnGenVideo" style="font-size:13px;padding:8px 18px;">🎬 動画生成</button>
      <span id="s4Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- 2カラム: タブ&エディタ / プレビュー -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:flex-start;">

    <!-- 左：タブ + エディタ -->
    <div>
      <div id="s4Tabs" style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:8px;"></div>
      <div id="s4Editor" class="panel" style="min-height:300px;"></div>
    </div>

    <!-- 右：プレビュー + 動画一覧 -->
    <div>
      <div class="panel" style="padding:10px;">
        <div style="font-size:11px;color:#8a9aba;font-weight:bold;margin-bottom:6px;">🖼️ プレビュー（1920×1080 縮小表示）</div>
        <div id="s4PreviewWrap" style="position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border:1px solid #1a2540;border-radius:6px;background:#000;">
          <iframe id="s4PreviewFrame" scrolling="no" style="position:absolute;top:0;left:0;width:1920px;height:1080px;border:0;transform-origin:top left;"></iframe>
        </div>
      </div>
      <div class="panel" style="margin-top:12px;">
        <div style="font-size:11px;color:#8a9aba;font-weight:bold;margin-bottom:6px;">📦 生成済み動画</div>
        <div id="s4VideoList" style="font-size:11px;color:#5a6a8a;">なし</div>
      </div>
      <div class="panel" style="margin-top:12px;">
        <div style="font-size:11px;color:#8a9aba;font-weight:bold;margin-bottom:6px;">⏳ 動画生成 進捗</div>
        <div id="s4JobStatus" style="font-size:11px;color:#5a6a8a;">未起動</div>
      </div>
    </div>
  </div>
</div>
</div>

<script>
(function() {
  'use strict';
  window.APP = window.APP || {};
  window.APP.s4 = { modules: [], activeTab: 0, currentJobId: null, imageSelections: {}, siData: null, recipeSlotsByIdx: {}, openCategoriesByIdx: {}, ttsPresets: null };

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _msg(s) { const el = document.getElementById('s4Msg'); if (el) el.innerHTML = s; }

  /* ── 初期化 ── */
  window.step4Init = async function() {
    const post = window.APP.selected;
    document.getElementById('s4Title').textContent = post
      ? (post.titleJa || post.title || '(タイトル不明)').slice(0, 80)
      : '案件を選択してください';
    if (!post?.id) { _renderTabs(); _renderEditor(); return; }
    try {
      const j = await fetchJson('/api/v2/modules?postId=' + encodeURIComponent(post.id));
      window.APP.s4.modules = j.modules || [];
      window.APP.modules    = window.APP.s4.modules;
    } catch (_) { window.APP.s4.modules = []; }
    /* Step 3.5 で選択した画像も読み込む */
    try {
      const s = await fetchJson('/api/v35/get-selection?postId=' + encodeURIComponent(post.id));
      window.APP.s4.imageSelections = s.selections || {};
    } catch (_) { window.APP.s4.imageSelections = {}; }
    /* si_data も読み込む（バインドデータプルダウン用）*/
    try {
      const sd = await fetchJson('/api/v3/si?postId=' + encodeURIComponent(post.id));
      window.APP.s4.siData = sd || null;
    } catch (_) { window.APP.s4.siData = null; }
    /* TTS preset を一度だけ読み込む */
    if (!window.APP.s4.ttsPresets) {
      try { window.APP.s4.ttsPresets = await fetchJson('/api/v2/tts-presets'); }
      catch (_) { window.APP.s4.ttsPresets = { voices: [], models: [], emotions: ['(なし)'] }; }
    }
    _renderTabs();
    _renderEditor();
    _reloadPreview();
    _loadVideos();
  };

  /* ── タブ描画 ── */
  function _renderTabs() {
    const el = document.getElementById('s4Tabs');
    if (!el) return;
    const mods = window.APP.s4.modules || [];
    if (!mods.length) {
      el.innerHTML = '<div style="font-size:11px;color:#5a6a8a;padding:8px;">Step3で脚本を生成してください</div>';
      return;
    }
    el.innerHTML = mods.map(function(m, i) {
      const act = i === window.APP.s4.activeTab;
      return '<div class="s3-tab' + (act ? ' s3-tab-active' : '') + '"'
        + ' onclick="s4Switch(' + i + ')">'
        + '<span style="font-size:9px;opacity:.8">' + (i+1) + '/' + mods.length + '</span><br>'
        + '<span style="font-size:10px;">' + _esc((m.title || '').slice(0,10)) + '</span>'
        + '</div>';
    }).join('');
  }

  /* ── TTS パネル HTML 構築 ── */
  function _buildTtsPanelHtml(m, i) {
    const presets = window.APP.s4.ttsPresets || { voices: [], models: [], emotions: ['(なし)'] };
    const tts = m.tts || {};
    const curVoice   = tts.voiceId  || presets.defaultVoice || (presets.voices[0]?.id || '');
    const curModel   = tts.model    || presets.defaultModel || (presets.models[0]?.id || '');
    const curSpeed   = (tts.speed   != null) ? tts.speed   : 1.0;
    const curEmotion = tts.emotion  || '';

    const voiceOpts = presets.voices.map(function(v) {
      return '<option value="' + _esc(v.id) + '"' + (v.id === curVoice ? ' selected' : '') + '>' + _esc(v.label) + '</option>';
    }).join('');
    const modelOpts = presets.models.map(function(m2) {
      return '<option value="' + _esc(m2.id) + '"' + (m2.id === curModel ? ' selected' : '') + '>' + _esc(m2.label) + '</option>';
    }).join('');
    const emotionOpts = (presets.emotions || ['(なし)']).map(function(e) {
      const v = e === '(なし)' ? '' : e;
      return '<option value="' + _esc(v) + '"' + (v === curEmotion ? ' selected' : '') + '>' + _esc(e) + '</option>';
    }).join('');

    let audioListHtml = '';
    if (Array.isArray(m.audio) && m.audio.length) {
      const totalSec = m.audio.reduce(function(a, b) { return a + (b.durationSec || 0); }, 0);
      audioListHtml = '<div style="margin-top:8px;padding:6px 8px;background:#0a0d18;border-radius:4px;">'
        + '<div style="font-size:10px;color:#10b981;margin-bottom:4px;">✅ 生成済 ' + m.audio.length + ' chunk / 合計 ' + totalSec.toFixed(1) + '秒</div>'
        + m.audio.map(function(a, ai) {
            return '<div style="display:flex;gap:6px;align-items:center;font-size:10px;color:#94a3b8;margin-bottom:2px;">'
              + '<button class="btn btn-sm s4-tts-play-chunk" data-idx="' + i + '" data-cidx="' + ai + '" style="background:#1a2540;color:#7dc8ff;font-size:10px;padding:1px 8px;">▶</button>'
              + '<span style="color:#5a6a8a;">[' + (ai+1) + '/' + m.audio.length + '] ' + (a.durationSec||0).toFixed(1) + 's</span>'
              + '<span style="flex:1;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + _esc((a.text||'').slice(0,60)) + '</span>'
              + '</div>';
          }).join('')
        + '</div>';
    }

    return '<div style="margin-top:14px;padding:10px;background:#0d1220;border:1px solid #4c1d95;border-radius:6px;">'
      +   '<div style="font-size:12px;color:#a78bfa;font-weight:bold;margin-bottom:6px;display:flex;align-items:center;gap:6px;">'
      +     '🎙️ MiniMax TTS'
      +     '<span style="font-size:9px;color:#5a6a8a;font-weight:normal;">クローン声 + 試聴 + chunk一括生成</span>'
      +     '<span style="flex:1"></span>'
      +     '<span class="s4-tts-status" data-idx="' + i + '" style="font-size:10px;color:#5a6a8a;font-weight:normal;"></span>'
      +   '</div>'
      +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">'
      +     '<select class="inp" id="s4TtsVoice" style="font-size:10px;padding:3px 6px;">' + voiceOpts + '</select>'
      +     '<select class="inp" id="s4TtsModel" style="font-size:10px;padding:3px 6px;">' + modelOpts + '</select>'
      +   '</div>'
      +   '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:10px;color:#94a3b8;">'
      +     '<label>速度 <input class="inp" type="number" id="s4TtsSpeed" min="0.5" max="2" step="0.05" value="' + curSpeed + '" style="width:60px;font-size:10px;padding:2px 4px;"></label>'
      +     '<label>感情 <select class="inp" id="s4TtsEmotion" style="font-size:10px;padding:2px 4px;">' + emotionOpts + '</select></label>'
      +     '<span style="flex:1"></span>'
      +     '<button class="btn btn-sm" onclick="s4TtsPreview()" style="background:#1a2540;color:#a78bfa;font-size:10px;padding:4px 10px;">▶ 試聴</button>'
      +     '<button class="btn btn-sm" onclick="s4TtsGenerate()" style="background:#7c3aed;color:#fff;font-size:10px;padding:4px 10px;font-weight:bold;">💾 確定生成</button>'
      +   '</div>'
      +   audioListHtml
      + '</div>';
  }

  /* ── エディタ描画 ── */
  function _renderEditor() {
    const el = document.getElementById('s4Editor');
    const mods = window.APP.s4.modules || [];
    if (!mods.length) {
      el.innerHTML = '<div style="color:#5a6a8a;padding:30px;text-align:center;">「Step3」で脚本を生成してください</div>';
      return;
    }
    const i = window.APP.s4.activeTab;
    const m = mods[i];
    if (!m) return;

    let dataHtml = '';
    if (Array.isArray(m.dataSlots) && m.dataSlots.length) {
      const isCmp = m.type === 'comparison';
      dataHtml = '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">📊 dataSlots</div>'
        + m.dataSlots.map(function(s, idx) {
            const delBtn = '<button class="s4-slot-del" data-idx="' + idx + '" title="この行を削除" '
              + 'style="background:#3a1a1a;color:#ff6b6b;border:1px solid #5a2a2a;border-radius:3px;cursor:pointer;font-size:13px;padding:0 6px;line-height:24px;height:24px;align-self:center;">×</button>';
            if (isCmp) {
              return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 28px;gap:6px;margin-bottom:4px;">'
                + '<input class="inp s4-cmp-label" data-idx="' + idx + '" value="' + _esc(s.label||'') + '" placeholder="LABEL" style="font-size:11px;padding:4px 6px;">'
                + '<input class="inp s4-cmp-left" data-idx="' + idx + '" value="' + _esc(s.leftValue||'') + '" placeholder="左" style="font-size:11px;padding:4px 6px;color:#93c5fd;">'
                + '<input class="inp s4-cmp-right" data-idx="' + idx + '" value="' + _esc(s.rightValue||'') + '" placeholder="右" style="font-size:11px;padding:4px 6px;color:#fca5a5;">'
                + delBtn
                + '</div>';
            } else {
              return '<div style="display:grid;grid-template-columns:140px 1fr 28px;gap:6px;margin-bottom:4px;">'
                + '<input class="inp s4-slot-label" data-idx="' + idx + '" value="' + _esc(s.label||'') + '" placeholder="ラベル" style="font-size:11px;padding:4px 6px;">'
                + '<input class="inp s4-slot-value" data-idx="' + idx + '" value="' + _esc(s.value||'') + '" placeholder="値" style="font-size:11px;padding:4px 6px;">'
                + delBtn
                + '</div>';
            }
          }).join('');
    }

    let extraHtml = '';
    if (Array.isArray(m.catchphrases) && m.catchphrases.length) {
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🎯 catchphrases</div>'
        + m.catchphrases.map(function(p, idx) {
            return '<input class="inp s4-phrase" data-idx="' + idx + '" value="' + _esc(p) + '" placeholder="キャッチコピー" style="display:block;width:100%;font-size:11px;padding:4px 6px;margin-bottom:4px;">';
          }).join('');
    }
    if (Array.isArray(m.comments) && m.comments.length) {
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">💬 comments</div>'
        + m.comments.map(function(c, idx) {
            return '<div style="display:grid;grid-template-columns:1fr 60px;gap:6px;margin-bottom:4px;">'
              + '<input class="inp s4-cmt-text" data-idx="' + idx + '" value="' + _esc(c.text||'') + '" style="font-size:11px;padding:4px 6px;">'
              + '<input type="number" class="inp s4-cmt-score" data-idx="' + idx + '" value="' + (c.score||0) + '" style="font-size:11px;padding:4px 6px;">'
              + '</div>';
          }).join('');
    }

    const ALL_TYPES = ['opening','insight','stats','profile','reaction','comparison','history','matchcard','ending'];
    const typeOpts = ALL_TYPES.map(function(t) {
      return '<option value="' + t + '"' + (m.type === t ? ' selected' : '') + '>' + t + '</option>';
    }).join('');

    /* Step 3.5 で選択した画像のギャラリー（全カード共通プール・このカードで使うものを選択） */
    let galleryHtml = '';
    const allSelections = window.APP.s4.imageSelections || {};
    const seen = new Set();
    const pool = [];
    Object.values(allSelections).forEach(function(arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function(p) {
        if (!seen.has(p)) { seen.add(p); pool.push(p); }
      });
    });
    const cardImgs = Array.isArray(m.images) ? m.images : [];
    if (pool.length) {
      galleryHtml = ''
        + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🖼️ 共通画像プール ('
        + pool.length + '枚) <span style="color:#10b981;font-weight:normal;margin-left:6px;">このカードで '
        + cardImgs.length + ' 枚選択中</span></div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:6px;background:#0d1220;border-radius:6px;max-height:200px;overflow-y:auto;">'
        + pool.map(function(p) {
            const isSel = cardImgs.indexOf(p) >= 0;
            return '<div class="s4-thumb-toggle" data-path="' + _esc(p) + '" '
              + 'style="position:relative;width:96px;height:72px;border:3px solid '
              + (isSel ? '#ff4d4d' : '#2a3050')
              + ';border-radius:3px;overflow:hidden;background:#000;cursor:pointer;'
              + (isSel ? 'box-shadow:0 0 8px rgba(255,77,77,0.5);' : '')
              + '">'
              + '<img src="' + _esc(p) + '" style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;" loading="lazy">'
              + (isSel ? '<div style="position:absolute;top:0;right:0;background:#ff4d4d;color:#fff;padding:1px 4px;font-size:9px;font-weight:bold;">✓</div>' : '')
              + '</div>';
          }).join('')
        + '</div>';
    } else {
      galleryHtml = '<div style="font-size:10px;color:#5a6a8a;margin-top:14px;padding:8px;background:#0d1220;border-radius:6px;text-align:center;">'
        + '🖼️ Step 3.5 で画像がまだ選択されていません'
        + '</div>';
    }

    /* バインドデータ・プルダウン (stats/profile/comparison/history カード用) */
    let bindHtml = '';
    const showBind = ['stats', 'profile', 'comparison', 'history'].includes(m.type);

    /* comparison + binding 解決可能 → 新しい recipe accordion UI */
    const hasBinding = m.type === 'comparison'
      && (m.binding?.subject || (m.siBindingLeft && m.siBindingRight));
    if (hasBinding) {
      const cached = window.APP.s4.recipeSlotsByIdx[i];
      if (!cached) {
        bindHtml = '<div class="recipe-slots-placeholder" data-idx="' + i + '" '
          + 'style="font-size:11px;color:#5a6a8a;margin:14px 0 0;padding:10px;background:#0d1220;border-radius:6px;text-align:center;">'
          + '⏳ レシピメトリック読込中…</div>';
      } else if (!cached.ok) {
        bindHtml = '<div style="font-size:10px;color:#fca5a5;margin:14px 0 0;padding:10px;background:#0d1220;border-radius:6px;text-align:center;">'
          + '⚠️ ' + _esc(cached.error || 'recipe解決失敗') + '</div>';
      } else {
        bindHtml = _renderRecipeSlots(cached, i);
      }
    } else if (showBind && window.APP.s4.siData) {
      const { entity } = _parseMainKey(m.mainKey || '');
      const targets = [entity];
      if (m.type === 'comparison' && m.secondary) targets.push(m.secondary);

      const sections = [];
      targets.forEach(function(name, sideIdx) {
        if (!name) return;
        const fields = _extractBindFields(window.APP.s4.siData, name);
        if (!fields.length) return;
        const grouped = {};
        fields.forEach(function(f) {
          if (!grouped[f.section]) grouped[f.section] = [];
          grouped[f.section].push(f);
        });
        sections.push({ name, grouped, sideIdx });
      });

      const isCmp = m.type === 'comparison';

      if (sections.length) {
        bindHtml = '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">📋 利用可能なバインドデータ（クリックで dataSlots に追加）</div>'
          + '<div style="background:#0d1220;border-radius:6px;padding:8px;max-height:260px;overflow-y:auto;">'
          + sections.map(function(sec) {
              // comparison: sideIdx 0=左, 1=右
              const sideLabel = isCmp
                ? (sec.sideIdx === 0
                    ? ' <span style="color:#93c5fd;font-size:9px;font-weight:normal;">[左カラムに追加]</span>'
                    : ' <span style="color:#fca5a5;font-size:9px;font-weight:normal;">[右カラムに追加]</span>')
                : '';
              const sideAttr = isCmp ? ' data-side="' + (sec.sideIdx === 0 ? 'left' : 'right') + '"' : '';
              return '<div style="font-size:11px;color:#7dc8ff;font-weight:bold;margin-bottom:4px;border-bottom:1px solid #1a2540;padding-bottom:2px;">'
                + _esc(sec.name) + sideLabel
                + '</div>'
                + Object.entries(sec.grouped).map(function(arr) {
                    const section = arr[0], items = arr[1];
                    return '<div style="font-size:10px;color:#8a9aba;margin:6px 0 3px;">' + _esc(section) + '</div>'
                      + '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">'
                      + items.map(function(f) {
                          return '<button class="s4-bind-add" data-label="' + _esc(f.label) + '" data-value="' + _esc(String(f.value)) + '"' + sideAttr + ' '
                            + 'style="font-size:10px;padding:3px 8px;background:#1a2540;color:#e0e0e0;border:1px solid #2a3050;border-radius:3px;cursor:pointer;">'
                            + '+ ' + _esc(f.label) + ': <span style="color:#10b981">' + _esc(String(f.value)) + '</span>'
                            + '</button>';
                        }).join('')
                      + '</div>';
                  }).join('');
            }).join('')
          + '</div>';
      } else {
        bindHtml = '<div style="font-size:10px;color:#5a6a8a;margin-top:14px;padding:8px;background:#0d1220;border-radius:6px;text-align:center;">'
          + '📋 該当エントリのバインドデータが取得できませんでした（sofa.ok=false の可能性）'
          + '</div>';
      }
    }

    el.innerHTML = ''
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap;">'
      + '<div style="display:flex;align-items:center;gap:6px;">'
      + '<span style="font-size:11px;color:#94a3b8;">type:</span>'
      + '<select class="inp" id="s4TypeSel" onchange="s4OnTypeChange()" style="font-size:11px;padding:3px 6px;background:#0d1220;color:var(--c);font-weight:bold;">'
      + typeOpts
      + '</select>'
      + '<span style="font-size:10px;color:#5a6a8a;">main=' + _esc(m.mainKey||'?') + (m.subSource ? ' / sub=' + _esc(m.subSource+':'+m.subValue) : '') + '</span>'
      + '</div>'
      + '<button class="btn btn-sm" onclick="s4RegenNarr()" style="background:#3b82f6;color:#fff;font-size:10px;padding:4px 10px;">↻ ナレーション再生成</button>'
      + '</div>'
      + '<div style="font-size:11px;color:#8a9aba;margin-bottom:4px;">タイトル</div>'
      + '<input class="inp" id="s4Title' + i + '" value="' + _esc(m.title||'') + '" oninput="s4OnInput()" style="display:block;width:100%;font-size:13px;padding:6px 8px;margin-bottom:10px;">'
      + '<div style="font-size:11px;color:#8a9aba;margin-bottom:4px;">脚本指示（読み取り専用）</div>'
      + '<pre style="background:#0d1220;padding:6px 8px;border-radius:4px;font-size:10px;color:#94a3b8;margin-bottom:10px;max-height:60px;overflow-y:auto;">' + _esc(m.scriptDir||'(なし)') + '</pre>'
      + '<div style="font-size:11px;color:#8a9aba;margin-bottom:4px;">narration</div>'
      + '<textarea class="inp" id="s4Narr' + i + '" oninput="s4OnInput()" style="display:block;width:100%;font-size:12px;padding:6px 8px;min-height:120px;resize:vertical;">' + _esc(m.narration||'') + '</textarea>'
      /* 🎙️ MiniMax TTS パネル */
      + _buildTtsPanelHtml(m, i)
      /* 🪄 スライド全部おまかせ AI（type/title/dataSlots/narration を一気通貫） */
      + '<div style="margin-top:14px;padding:10px;background:#1a1d2e;border:1px solid #6366f1;border-radius:6px;">'
      +   '<div style="font-size:12px;color:#a5b4fc;font-weight:bold;margin-bottom:6px;display:flex;align-items:center;gap:6px;">'
      +     '🪄 スライド全部おまかせ AI'
      +     '<span style="font-size:9px;color:#8a9aba;font-weight:normal;">type / dataSlots / narration を一気通貫</span>'
      +     '<span style="flex:1"></span>'
      +     '<span class="s4-fill-status" data-idx="' + i + '" style="font-size:10px;color:#5a6a8a;font-weight:normal;"></span>'
      +   '</div>'
      +   '<textarea class="inp s4-fill-prompt" data-idx="' + i + '" placeholder="例: メッシとロナウドの比較。デビュー年・年齢・通算ゴール・バロンドール・主要タイトルを比較で。ナレーションは2人の違いを語って" '
      +     'style="display:block;width:100%;font-size:11px;padding:5px 8px;min-height:60px;resize:vertical;background:#0a0d18;color:#e0e0e0;border:1px solid #2a2f4a;"></textarea>'
      +   '<div style="display:flex;gap:6px;margin-top:6px;align-items:center;">'
      +     '<button class="btn btn-sm s4-fill-go" data-idx="' + i + '" style="background:#6366f1;color:#fff;font-size:11px;padding:5px 14px;font-weight:bold;">🪄 生成</button>'
      +     '<span style="flex:1"></span>'
      +     '<span style="font-size:9px;color:#5a6a8a;">DeepSeek 既定 → 失敗時 Sonnet</span>'
      +   '</div>'
      + '</div>'
      /* ✨ リトル AI: 自然言語で dataSlots を生成（既存 - dataSlots だけ触る用） */
      + '<div style="margin-top:14px;padding:8px;background:#0d1220;border:1px solid #2a3050;border-radius:6px;">'
      +   '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:6px;display:flex;align-items:center;gap:6px;">'
      +     '✨ AI でデータスロット生成'
      +     '<span style="flex:1"></span>'
      +     '<span class="s4-ai-status" data-idx="' + i + '" style="font-size:10px;color:#5a6a8a;font-weight:normal;"></span>'
      +   '</div>'
      +   '<textarea class="inp s4-ai-prompt" data-idx="' + i + '" placeholder="例: メッシのキャリア、ユース→プロのクラブ加入年と試合数・ゴール数を時系列で" '
      +     'style="display:block;width:100%;font-size:11px;padding:5px 8px;min-height:50px;resize:vertical;background:#0a0d18;color:#e0e0e0;border:1px solid #1a2540;"></textarea>'
      +   '<div style="display:flex;gap:6px;margin-top:6px;">'
      +     '<button class="btn btn-sm s4-ai-append" data-idx="' + i + '" style="background:#3b82f6;color:#fff;font-size:10px;padding:4px 10px;">➕ 追記</button>'
      +     '<button class="btn btn-sm s4-ai-replace" data-idx="' + i + '" style="background:#dc2626;color:#fff;font-size:10px;padding:4px 10px;">🔄 全置換</button>'
      +     '<span style="flex:1"></span>'
      +     '<span style="font-size:9px;color:#5a6a8a;align-self:center;">DeepSeek 既定 → 失敗時 Haiku</span>'
      +   '</div>'
      + '</div>'
      + galleryHtml
      + bindHtml
      + dataHtml
      + extraHtml;

    /* data属性経由のクリックハンドラ登録（インラインonclickの quote地獄回避）*/
    el.querySelectorAll('.s4-thumb-toggle').forEach(function(div) {
      div.addEventListener('click', function() {
        s4ToggleImage(div.getAttribute('data-path'));
      });
    });
    el.querySelectorAll('.s4-bind-add').forEach(function(btn) {
      btn.addEventListener('click', function() {
        s4AddBind(
          btn.getAttribute('data-label'),
          btn.getAttribute('data-value'),
          btn.getAttribute('data-side') || null
        );
      });
    });
    el.querySelectorAll('.s4-slot-del').forEach(function(btn) {
      btn.addEventListener('click', function() {
        s4DeleteSlot(parseInt(btn.getAttribute('data-idx'), 10));
      });
    });

    /* 🪄 スライド全部おまかせ AI ボタン */
    el.querySelectorAll('.s4-fill-go').forEach(function(btn) {
      btn.addEventListener('click', function() {
        s4FillSlideAI(parseInt(btn.getAttribute('data-idx'), 10));
      });
    });

    /* リトル AI: 追記/全置換 ボタン */
    el.querySelectorAll('.s4-ai-append').forEach(function(btn) {
      btn.addEventListener('click', function() {
        s4AskSlotAI(parseInt(btn.getAttribute('data-idx'), 10), 'append');
      });
    });
    el.querySelectorAll('.s4-ai-replace').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        if (!confirm('現在の dataSlots を全部上書きしますか？')) return;
        s4AskSlotAI(idx, 'replace');
      });
    });

    /* recipe accordion: 未ロードの placeholder があれば fetch */
    el.querySelectorAll('.recipe-slots-placeholder').forEach(function(div) {
      const idx = parseInt(div.getAttribute('data-idx'), 10);
      if (!Number.isNaN(idx)) _loadRecipeSlots(idx);
    });
    /* recipe accordion: category 開閉 */
    el.querySelectorAll('.s4-cat-header').forEach(function(hdr) {
      hdr.addEventListener('click', function() {
        const idx = parseInt(hdr.getAttribute('data-idx'), 10);
        const cat = hdr.getAttribute('data-cat');
        const map = window.APP.s4.openCategoriesByIdx[idx] || {};
        map[cat] = !map[cat];
        window.APP.s4.openCategoriesByIdx[idx] = map;
        _renderEditor();
      });
    });
    /* recipe accordion: ➕/✓ ボタン → apply-slot-keys */
    el.querySelectorAll('.s4-recipe-toggle').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        const key = btn.getAttribute('data-key');
        if (Number.isNaN(idx) || !key) return;
        s4ToggleRecipeSlot(idx, key);
      });
    });

    /* 🎙️ TTS: chunk 単発再生 */
    el.querySelectorAll('.s4-tts-play-chunk').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const idx  = parseInt(btn.getAttribute('data-idx'),  10);
        const cidx = parseInt(btn.getAttribute('data-cidx'), 10);
        s4TtsPlayChunk(idx, cidx);
      });
    });
    /* 🎙️ TTS: select/input 変更時に collect → 保存（永続化）*/
    ['s4TtsVoice','s4TtsModel','s4TtsSpeed','s4TtsEmotion'].forEach(function(id) {
      const e2 = document.getElementById(id);
      if (e2) e2.addEventListener('change', function() { _collectInputs(); _saveModulesQuiet(); });
    });
  }

  /* recipe accordion: HTML レンダラ */
  function _renderRecipeSlots(data, idx) {
    const open  = window.APP.s4.openCategoriesByIdx[idx] || {};
    const sel   = new Set(data.selected || []);
    const cats  = data.categories || [];
    const total = cats.reduce((n, c) => n + (c.slots?.length || 0), 0);

    const head = '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;display:flex;align-items:center;gap:8px;">'
      + '🔗 メトリック選択 <span style="font-size:9px;color:#8a9aba;font-weight:normal;">'
      + _esc(data.subject) + '.' + _esc(data.aspect) + ' / '
      + _esc(data.primary || '?') + ' vs ' + _esc(data.secondary || '?')
      + '</span><span style="flex:1;"></span>'
      + '<span style="font-size:9px;color:#10b981;">' + sel.size + ' / 5 選択中</span>'
      + '</div>';

    const body = cats.map(function(cat) {
      const isOpen   = !!open[cat.name];
      const selCount = (cat.slots || []).filter(s => sel.has(s.key)).length;
      const arrow    = isOpen ? '▼' : '▶';
      const header = '<div class="s4-cat-header" data-idx="' + idx + '" data-cat="' + _esc(cat.name) + '" '
        + 'style="cursor:pointer;display:flex;align-items:center;padding:6px 10px;background:#1a2540;border-radius:4px;margin-bottom:4px;font-size:11px;color:#e0e0e0;font-weight:bold;gap:6px;">'
        + '<span style="color:#8a9aba;">' + arrow + '</span>'
        + '<span>' + _esc(cat.name) + '</span>'
        + '<span style="color:#5a6a8a;font-weight:normal;font-size:10px;">(' + (cat.slots?.length || 0) + ')</span>'
        + '<span style="flex:1;"></span>'
        + (selCount ? '<span style="font-size:9px;color:#10b981;">✓' + selCount + '</span>' : '')
        + '</div>';
      if (!isOpen) return header;
      const items = (cat.slots || []).map(function(s) {
        const isSel = sel.has(s.key);
        const prio  = s.priority >= 9 ? '🔥' : (s.priority >= 7 ? '⭐' : '');
        return '<div class="s4-recipe-toggle" data-idx="' + idx + '" data-key="' + _esc(s.key) + '" '
          + 'style="display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;padding:5px 10px;cursor:pointer;border-radius:3px;'
          + 'background:' + (isSel ? '#0e3b1f' : '#0d1220') + ';margin-bottom:2px;align-items:center;font-size:11px;'
          + 'border:1px solid ' + (isSel ? '#10b981' : 'transparent') + ';">'
          + '<span style="color:' + (isSel ? '#10b981' : '#7dc8ff') + ';font-weight:bold;width:16px;text-align:center;">' + (isSel ? '✓' : '+') + '</span>'
          + '<span style="color:#e0e0e0;">' + _esc(s.label) + '</span>'
          + '<span style="font-size:10px;color:#94a3b8;">'
          + '<span style="color:#93c5fd;">' + _esc(s.leftValue) + '</span>'
          + ' <span style="color:#5a6a8a;">vs</span> '
          + '<span style="color:#fca5a5;">' + _esc(s.rightValue) + '</span>'
          + '</span>'
          + '<span style="font-size:9px;color:#5a6a8a;width:30px;text-align:right;">' + prio + ' ' + (s.priority || 0) + '</span>'
          + '</div>';
      }).join('');
      return header + '<div style="padding:4px 6px 8px;">' + items + '</div>';
    }).join('');

    return head + '<div style="background:#0d1220;border-radius:6px;padding:6px;max-height:340px;overflow-y:auto;">'
      + body + '</div>';
  }

  /* recipe slot を fetch + キャッシュ + 再描画 */
  async function _loadRecipeSlots(idx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    try {
      const data = await fetchJson('/api/v2/recipe-slots?postId='
        + encodeURIComponent(post.id) + '&moduleIdx=' + idx);
      window.APP.s4.recipeSlotsByIdx[idx] = data;
      // デフォルトで category を全閉じ（ユーザー操作で開く）
      if (!window.APP.s4.openCategoriesByIdx[idx]) {
        window.APP.s4.openCategoriesByIdx[idx] = {};
      }
      _renderEditor();
    } catch (e) {
      window.APP.s4.recipeSlotsByIdx[idx] = { ok: false, error: e.message };
      _renderEditor();
    }
  }

  /* 🪄 スライド全部おまかせ AI: type/title/dataSlots/narration を一気通貫生成 */
  window.s4FillSlideAI = async function(idx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const ta = document.querySelector('.s4-fill-prompt[data-idx="' + idx + '"]');
    const userPrompt = (ta?.value || '').trim();
    if (!userPrompt) { _msg('注文内容を書いてね'); return; }
    const status = document.querySelector('.s4-fill-status[data-idx="' + idx + '"]');
    if (status) status.textContent = '⏳ 全体生成中...';
    if (!confirm('現在のスライドの type / title / dataSlots / narration を AI 生成で上書きします。OK?')) {
      if (status) status.textContent = '';
      return;
    }
    try {
      const r = await fetchJson('/api/v2/ai-fill-slide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, userPrompt }),
      });
      if (!r.ok) throw new Error(r.error || '生成失敗');
      const m = window.APP.s4.modules[idx];
      if (m) {
        if (r.type)      m.type      = r.type;
        if (r.title)     m.title     = r.title;
        if (r.narration) m.narration = r.narration;
        m.dataSlots = r.dataSlots || [];
      }
      if (status) status.textContent = '✅ 生成完了 (' + (r.used || 'deepseek') + ')';
      _renderEditor();
      _reloadPreview();
    } catch (e) {
      if (status) status.textContent = '❌ ' + e.message;
      _msg('❌ 生成失敗: ' + e.message);
    }
  };

  /* リトル AI: 自然言語で dataSlots を生成（append / replace） */
  window.s4AskSlotAI = async function(idx, mode) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const ta = document.querySelector('.s4-ai-prompt[data-idx="' + idx + '"]');
    const userPrompt = (ta?.value || '').trim();
    if (!userPrompt) { _msg('AI に頼む内容を書いてね'); return; }
    const status = document.querySelector('.s4-ai-status[data-idx="' + idx + '"]');
    if (status) status.textContent = '⏳ 生成中...';
    try {
      const r = await fetchJson('/api/v2/ask-slot-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, userPrompt, mode }),
      });
      if (!r.ok) throw new Error(r.error || 'AI 失敗');
      const m = window.APP.s4.modules[idx];
      if (m) m.dataSlots = r.dataSlots;
      if (status) status.textContent = '✅ ' + (r.added?.length || 0) + '件生成 (' + (r.used || 'deepseek') + ')';
      _renderEditor();
      _reloadPreview();
    } catch (e) {
      if (status) status.textContent = '❌ ' + e.message;
      _msg('❌ AI 生成失敗: ' + e.message);
    }
  };

  /* スロットの選択をトグル → サーバーに送信して dataSlots 反映 */
  window.s4ToggleRecipeSlot = async function(idx, key) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const cached = window.APP.s4.recipeSlotsByIdx[idx];
    if (!cached?.ok) return;
    const sel = new Set(cached.selected || []);
    if (sel.has(key)) sel.delete(key);
    else {
      if (sel.size >= 5) {
        _msg('5メトリック選択済 — どれかを外してから追加してください');
        return;
      }
      sel.add(key);
    }
    const keys = Array.from(sel);
    try {
      const r = await fetchJson('/api/v2/apply-slot-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, customSlotKeys: keys }),
      });
      if (!r.ok) throw new Error(r.error || 'apply 失敗');
      // モジュールに反映
      const m = window.APP.s4.modules[idx];
      if (m) {
        m.dataSlots = r.dataSlots;
        if (m.binding) m.binding.customSlotKeys = r.customSlotKeys;
      }
      // キャッシュの selected を更新
      cached.selected = r.customSlotKeys;
      _renderEditor();
      _reloadPreview();
    } catch (e) {
      _msg('❌ スロット更新失敗: ' + e.message);
    }
  };

  function _collectInputs() {
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const t = document.getElementById('s4Title' + i);
    const n = document.getElementById('s4Narr' + i);
    if (t) m.title = t.value;
    if (n) m.narration = n.value;

    const isCmp = m.type === 'comparison';
    if (Array.isArray(m.dataSlots)) {
      if (isCmp) {
        const lbl = document.querySelectorAll('.s4-cmp-label');
        const lf  = document.querySelectorAll('.s4-cmp-left');
        const rt  = document.querySelectorAll('.s4-cmp-right');
        m.dataSlots = m.dataSlots.map((s, idx) => ({
          label: lbl[idx]?.value || s.label || '',
          leftValue:  lf[idx]?.value  || s.leftValue  || '',
          rightValue: rt[idx]?.value || s.rightValue || '',
        }));
      } else {
        const ll = document.querySelectorAll('.s4-slot-label');
        const vv = document.querySelectorAll('.s4-slot-value');
        m.dataSlots = m.dataSlots.map((s, idx) => ({
          label: ll[idx]?.value || s.label || '',
          value: vv[idx]?.value || s.value || '',
        }));
      }
    }
    if (Array.isArray(m.catchphrases)) {
      const ps = document.querySelectorAll('.s4-phrase');
      m.catchphrases = Array.from(ps).map(el => el.value);
    }
    if (Array.isArray(m.comments)) {
      const ts = document.querySelectorAll('.s4-cmt-text');
      const ss = document.querySelectorAll('.s4-cmt-score');
      m.comments = m.comments.map((c, idx) => ({
        text:  ts[idx]?.value || c.text || '',
        score: Number(ss[idx]?.value) || 0,
      }));
    }
    /* TTS settings (panel が画面に出てる場合のみ拾う) */
    const tv = document.getElementById('s4TtsVoice');
    const tm = document.getElementById('s4TtsModel');
    const tsp = document.getElementById('s4TtsSpeed');
    const te = document.getElementById('s4TtsEmotion');
    if (tv || tm || tsp || te) {
      m.tts = Object.assign({}, m.tts || {}, {
        voiceId: tv?.value || (m.tts?.voiceId || ''),
        model:   tm?.value || (m.tts?.model   || ''),
        speed:   tsp?.value ? Number(tsp.value) : (m.tts?.speed ?? 1.0),
        emotion: te?.value || '',
      });
    }
  }

  /* ── タブ切替 ── */
  window.s4Switch = function(i) {
    _collectInputs();
    window.APP.s4.activeTab = i;
    _renderTabs();
    _renderEditor();
    _reloadPreview();
  };

  /* ── type 手動変更（強制上書き）── */
  window.s4OnTypeChange = function() {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const sel = document.getElementById('s4TypeSel');
    if (!sel) return;
    const newType = sel.value;
    m.type = newType;
    // 型に対応するフィールドが空なら最低限スケルトン投入（編集UI表示用）
    if (newType === 'insight' && (!m.catchphrases || !m.catchphrases.length)) m.catchphrases = ['', '', ''];
    if (newType === 'reaction' && (!m.comments || !m.comments.length)) {
      m.comments = Array.from({length: 7}, () => ({ text: '', score: 0 }));
    }
    if (['stats','profile','history'].includes(newType) && (!m.dataSlots || !m.dataSlots.length)) {
      m.dataSlots = [{label:'',value:''},{label:'',value:''},{label:'',value:''},{label:'',value:''}];
    }
    if (newType === 'comparison' && (!m.dataSlots || !m.dataSlots.length || m.dataSlots[0]?.value !== undefined)) {
      m.dataSlots = [{label:'',leftValue:'',rightValue:''},{label:'',leftValue:'',rightValue:''},{label:'',leftValue:'',rightValue:''},{label:'',leftValue:'',rightValue:''}];
    }
    _saveModulesQuiet();
    _renderEditor();
    setTimeout(_reloadPreview, 200);
  };

  /* ── 入力監視 → debounceでプレビュー更新 ── */
  let _previewTimer = null;
  window.s4OnInput = function() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(function() {
      _collectInputs();
      _saveModulesQuiet();
      _reloadPreview();
    }, 1000);
  };

  /* ── 画像ギャラリー: トグル選択 ── */
  window.s4ToggleImage = function(path) {
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    if (!Array.isArray(m.images)) m.images = [];
    const idx = m.images.indexOf(path);
    if (idx >= 0) m.images.splice(idx, 1);
    else          m.images.push(path);
    _renderEditor();
    _saveModulesQuiet();
    _reloadPreview();
  };

  /* ── バインドデータ: si.boxes から該当エントリの利用可能フィールドを抽出 ── */
  function _findEntityItem(items, name) {
    if (!items?.length || !name) return null;
    const en = String(name).toLowerCase().trim();
    let hit = items.find(it => (it.label || '').toLowerCase() === en);
    if (hit) return hit;
    return items.find(it => {
      const lab = (it.label || '').toLowerCase();
      return lab.includes(en) || en.includes(lab);
    }) || null;
  }
  function _extractBindFields(siData, entityName) {
    const items = siData?.boxes?.entity?.items || [];
    const item = _findEntityItem(items, entityName);
    if (!item) return [];
    const out = [];
    const sofa = item.sofa || {};
    function _push(section, obj) {
      if (!obj || typeof obj !== 'object') return;
      Object.entries(obj).forEach(([k, v]) => {
        if (v == null || typeof v === 'object') return;
        out.push({ section, label: k, value: String(v) });
      });
    }
    if (sofa.ok) {
      _push('今季スタッツ',     sofa.seasonStats);
      _push('直近試合スタッツ',  sofa.lastMatchStats);
      _push('チーム成績',        sofa.currentTeamStats);
      _push('総合パフォーマンス', sofa.overallPerformance);
      // 直接フィールド
      if (sofa.team?.name)        out.push({ section: '基本情報', label: 'チーム',         value: sofa.team.name });
      if (sofa.position)          out.push({ section: '基本情報', label: 'ポジション',     value: sofa.position });
      if (sofa.leagueName)        out.push({ section: '基本情報', label: 'リーグ',         value: sofa.leagueName });
      if (sofa.country)           out.push({ section: '基本情報', label: '国',             value: sofa.country });
      if (sofa.standing)          out.push({ section: '基本情報', label: '順位',           value: String(sofa.standing) });
      if (sofa.recentAvgRating)   out.push({ section: '基本情報', label: '平均レーティング', value: String(sofa.recentAvgRating) });
      if (sofa.managerName)       out.push({ section: '基本情報', label: '監督',           value: sofa.managerName });
    }
    // wiki も少しだけ拾う（生年月日・代表など簡易メタを抜けたら）
    if (item.wiki?.ok && item.wiki.title) {
      out.push({ section: 'Wiki', label: 'Wikipedia見出し', value: item.wiki.title });
    }
    return out;
  }
  function _parseMainKey(mk) {
    if (!mk) return { type: 'unknown', entity: '' };
    const idx = mk.indexOf(':');
    if (idx < 0) return { type: mk, entity: '' };
    return { type: mk.slice(0, idx).trim(), entity: mk.slice(idx + 1).trim() };
  }

  /* ── バインドデータ: dataSlots に追加 ── */
  /*   side='left'/'right' (comparison用) で左右指定。null なら自動 */
  window.s4AddBind = function(label, value, side) {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    if (!Array.isArray(m.dataSlots)) m.dataSlots = [];
    if (m.type === 'comparison') {
      if (side === 'right') {
        // 同 label の既存行があれば右に補填、なければ右だけ入った新規行
        const exist = m.dataSlots.find(s => s.label === label && (!s.rightValue || s.rightValue === ''));
        if (exist) exist.rightValue = value;
        else m.dataSlots.push({ label, leftValue: '', rightValue: value });
      } else {
        // left or null: 同 label の既存行があれば左に補填、なければ左だけの新規行
        const exist = m.dataSlots.find(s => s.label === label && (!s.leftValue || s.leftValue === ''));
        if (exist) exist.leftValue = value;
        else m.dataSlots.push({ label, leftValue: value, rightValue: '' });
      }
    } else {
      m.dataSlots.push({ label, value });
    }
    _renderEditor();
    _saveModulesQuiet();
    _reloadPreview();
  };

  /* ── dataSlot 行を削除 ── */
  window.s4DeleteSlot = function(idx) {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m || !Array.isArray(m.dataSlots)) return;
    if (idx < 0 || idx >= m.dataSlots.length) return;
    m.dataSlots.splice(idx, 1);
    _renderEditor();
    _saveModulesQuiet();
    _reloadPreview();
  };

  /* ── ナレーション再生成 ── */
  window.s4RegenNarr = async function() {
    _collectInputs();
    const post = window.APP.selected;
    const i = window.APP.s4.activeTab;
    if (!post?.id) return;
    _msg('⏳ ナレーション再生成中...');
    try {
      await _saveModulesQuiet();  // 先に保存（endpointはディスクから読む）
      const j = await fetchJson('/api/v2/regen-narration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, idx: i }),
      });
      if (j.narration) {
        window.APP.s4.modules[i].narration = j.narration;
        _renderEditor();
        _reloadPreview();
        _msg('✅ 再生成完了');
      } else {
        _msg('❌ 失敗');
      }
    } catch (e) { _msg('❌ ' + e.message); }
  };

  /* ── 🎙️ TTS: 試聴 (現ナレ全文を1回投げて即再生・保存しない) ── */
  window.s4TtsPreview = async function() {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const status = document.querySelector('.s4-tts-status[data-idx="' + i + '"]');
    const text = (m.narration || '').trim();
    if (!text) { if (status) status.textContent = '❌ ナレーション空'; return; }
    if (status) status.textContent = '⏳ 試聴生成中...';
    try {
      const j = await fetchJson('/api/v2/tts-preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.slice(0, 800),
          voiceId: m.tts?.voiceId,
          model:   m.tts?.model,
          speed:   m.tts?.speed,
          emotion: m.tts?.emotion || undefined,
        }),
      });
      if (!j.ok) throw new Error(j.error || '失敗');
      const audio = new Audio('data:' + j.mime + ';base64,' + j.base64);
      audio.play();
      if (status) status.textContent = '▶ 再生中';
    } catch (e) { if (status) status.textContent = '❌ ' + e.message; }
  };

  /* ── 🎙️ TTS: 確定生成 (chunk全部 → サーバ保存 → module.audio[]更新) ── */
  window.s4TtsGenerate = async function() {
    _collectInputs();
    const post = window.APP.selected;
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!post?.id || !m) return;
    const status = document.querySelector('.s4-tts-status[data-idx="' + i + '"]');
    if (!confirm('chunk全部を MiniMax で生成して保存します。続行？')) return;
    if (status) status.textContent = '⏳ 生成中...（数十秒）';
    try {
      await _saveModulesQuiet();
      const j = await fetchJson('/api/v2/tts-module', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId: post.id, moduleIdx: i,
          voiceId: m.tts?.voiceId,
          model:   m.tts?.model,
          speed:   m.tts?.speed,
          emotion: m.tts?.emotion || undefined,
        }),
      });
      if (!j.ok) throw new Error(j.error || '失敗');
      m.audio = j.audio;
      _renderEditor();
      if (status) status.textContent = '✅ ' + j.audio.length + 'chunk / ' + (j.totalDurationSec||0).toFixed(1) + 's';
    } catch (e) { if (status) status.textContent = '❌ ' + e.message; }
  };

  /* ── 🎙️ TTS: chunk 単発再生 ── */
  window.s4TtsPlayChunk = function(idx, cidx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const url = '/api/v2/tts-audio?postId=' + encodeURIComponent(post.id) + '&moduleIdx=' + idx + '&chunkIdx=' + cidx + '&_=' + Date.now();
    new Audio(url).play();
  };

  /* ── 保存（手動 + 自動） ── */
  async function _saveModulesQuiet() {
    const post = window.APP.selected;
    if (!post?.id) return;
    try {
      await fetchJson('/api/save-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.s4.modules }),
      });
    } catch (_) {}
  }
  document.getElementById('s4BtnSave').addEventListener('click', async function() {
    _collectInputs();
    await _saveModulesQuiet();
    _msg('✅ 保存しました');
  });

  /* ── プレビュー縮小スケール再計算 ── */
  function _resizePreview() {
    const wrap  = document.getElementById('s4PreviewWrap');
    const frame = document.getElementById('s4PreviewFrame');
    if (!wrap || !frame) return;
    const w = wrap.clientWidth || 1;
    frame.style.transform = 'scale(' + (w / 1920) + ')';
  }
  if (!window.APP.s4._resizeBound) {
    window.addEventListener('resize', _resizePreview);
    window.APP.s4._resizeBound = true;
  }

  /* ── プレビュー再読み込み ── */
  function _reloadPreview() {
    const post = window.APP.selected;
    if (!post?.id) return;
    const i = window.APP.s4.activeTab;
    const url = '/api/v2/preview-slide?postId=' + encodeURIComponent(post.id) + '&idx=' + i + '&_=' + Date.now();
    const f = document.getElementById('s4PreviewFrame');
    f.onload = _resizePreview;
    f.src = url;
    _resizePreview();
  }

  /* ── 動画一覧読み込み ── */
  async function _loadVideos() {
    const post = window.APP.selected;
    if (!post?.id) return;
    try {
      const j = await fetchJson('/api/v2/videos?postId=' + encodeURIComponent(post.id));
      const el = document.getElementById('s4VideoList');
      if (!j.videos?.length) { el.innerHTML = '<div style="color:#5a6a8a;">なし</div>'; return; }
      el.innerHTML = j.videos.map(function(v) {
        return '<div style="margin-bottom:6px;">'
          + '<a href="' + v.url + '" target="_blank" style="color:#7dc8ff;">' + _esc(v.file) + '</a>'
          + ' <span style="color:#5a6a8a;font-size:10px;">(' + Math.round(v.sizeBytes/1024) + 'KB)</span>'
          + '</div>';
      }).join('');
    } catch (_) {}
  }

  /* ── 動画生成 ── */
  document.getElementById('s4BtnGenVideo').addEventListener('click', async function() {
    _collectInputs();
    const post = window.APP.selected;
    if (!post?.id) return;
    _msg('⏳ 動画生成 開始...');
    try {
      const j = await fetchJson('/api/v2/generate-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.s4.modules }),
      });
      window.APP.s4.currentJobId = j.jobId;
      _msg('✅ Job起動: ' + j.jobId);
      _pollJobStatus();
    } catch (e) { _msg('❌ ' + e.message); }
  });

  /* ── 進捗ポーリング ── */
  async function _pollJobStatus() {
    const id = window.APP.s4.currentJobId;
    if (!id) return;
    try {
      const j = await fetchJson('/api/v2/video-status?jobId=' + encodeURIComponent(id));
      const el = document.getElementById('s4JobStatus');
      el.innerHTML = '<div>status: <b>' + _esc(j.status||'?') + '</b></div>'
        + (j.progress ? '<div>progress: ' + _esc(JSON.stringify(j.progress)) + '</div>' : '')
        + (j.error    ? '<div style="color:#ef4444;">error: ' + _esc(j.error) + '</div>' : '')
        + (j.outputUrl? '<div><a href="' + j.outputUrl + '" target="_blank" style="color:#10b981;">▶ ' + _esc(j.outputFile||'video') + '</a></div>' : '');
      if (j.status === 'done' || j.status === 'failed') {
        _loadVideos();
        return;  // ポーリング終了
      }
    } catch (_) {}
    setTimeout(_pollJobStatus, 3000);
  }

})();
</script>`;
}

module.exports = { router, getUI };
