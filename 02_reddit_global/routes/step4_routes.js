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

// 2チームエンティティ間のH2H（直接対決）コンテキスト文字列を返す。
//   - secondary が無い、または片方が team でないなら空文字
//   - SofaScore /team/{id}/events/last/0 を経由（チーム名 → ID 解決込み）
//   - 直近5試合とチーム1視点の通算成績(その範囲内)を返す
async function _h2hContextIfTeams(items, primary, secondary) {
  if (!primary || !secondary) return '';
  const itP = items.find(x => x.label === primary)   || {};
  const itS = items.find(x => x.label === secondary) || {};
  if (itP.role !== 'team' || itS.role !== 'team') return '';
  try {
    const { fetchRecentH2H } = require('../scripts/modules/fetchers/sofascore_match');
    const h2h = await fetchRecentH2H(primary, secondary, 5);
    if (!h2h || !h2h.length) return '';
    const lines = h2h.map(e => {
      const d  = e.date || '?';
      const sc = (e.homeScore != null && e.awayScore != null) ? `${e.homeScore}-${e.awayScore}` : '?';
      return `  ${d}: ${e.homeTeam} ${sc} ${e.awayTeam} (${e.tournament || ''})`;
    }).join('\n');
    let w = 0, d = 0, l = 0;
    h2h.forEach(e => {
      if (e.homeScore == null || e.awayScore == null) return;
      const isHome = e.homeTeam === primary;
      const my = isHome ? e.homeScore : e.awayScore;
      const op = isHome ? e.awayScore : e.homeScore;
      if (my > op) w++;
      else if (my < op) l++;
      else d++;
    });
    return `=== H2H (直接対決): ${primary} vs ${secondary} ===
${primary}視点: ${w}勝${d}分${l}敗（直近${h2h.length}試合）
${lines}
※これより古い試合のデータは未取得。通算戦績（全期間）の数字は推測しないこと。
`;
  } catch (e) {
    console.warn('[h2h-context]', e.message);
    return '';
  }
}

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
    const { getBindingMeta } = require('../scripts/v2_story/binding_meta');
    const postId    = req.query.postId;
    const moduleIdx = parseInt(req.query.moduleIdx, 10);
    if (!postId || Number.isNaN(moduleIdx)) {
      return res.status(400).json({ error: 'postId + moduleIdx required' });
    }
    const modulesData = safeJson(modulesPath(postId), { modules: [] });
    const mod = (modulesData.modules || [])[moduleIdx];
    if (!mod) return res.status(404).json({ error: 'module not found' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const meta = getBindingMeta(mod, si);
    if (!meta) {
      return res.json({ ok: false, error: 'binding が解決できませんでした（SIデータ未取得 or レシピ未対応）' });
    }

    // walker 出力の availableSlots を category 別にグループ化
    //   isCompare=false：value 1 列 / true：leftValue + rightValue
    const groups = {};
    meta.availableSlots.forEach(slot => {
      const cat = slot.category || 'その他';
      if (!groups[cat]) groups[cat] = [];
      const leftValue  = meta.isCompare ? slot.leftValue  : slot.value;
      const rightValue = meta.isCompare ? slot.rightValue : '-';
      groups[cat].push({
        key:      slot.key,
        label:    slot.label,
        priority: slot.priority || 0,
        leftValue, rightValue,
      });
    });

    Object.values(groups).forEach(arr => arr.sort((a, b) => (b.priority || 0) - (a.priority || 0)));
    const categories = Object.entries(groups)
      .map(([name, slots]) => ({ name, slots, maxPriority: Math.max(...slots.map(s => s.priority || 0)) }))
      .sort((a, b) => b.maxPriority - a.maxPriority)
      .map(({ name, slots }) => ({ name, slots }));

    const selected = (mod.dataSlots || []).map(s => s.slotKey).filter(Boolean);

    res.json({
      ok: true,
      subject:    meta.subject,
      aspect:     meta.aspect,
      primary:    meta.primary,
      secondary:  meta.secondary,
      isCompare:  meta.isCompare,
      defaultSelection: meta.defaultSelection,
      selected,
      categories,
      // Step B 追加: 利用可能レシピ + 現在採用中のレシピキー
      recipes:        meta.recipes || [],
      currentRecipeKey: mod.binding?.recipeKey || null,
    });
  } catch (e) {
    console.error('[v2/recipe-slots]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/apply-recipe : レシピを適用 → dataSlots 自動充填 ─
// Input:  { postId, moduleIdx, recipeKey }
// Output: { ok, dataSlots, customSlotKeys, recipeKey }
router.post('/v2/apply-recipe', express.json(), (req, res) => {
  try {
    const { getBindingMeta, buildDataSlotsFromMeta } = require('../scripts/v2_story/binding_meta');
    const { expandRecipe, hasRecipe } = require('../scripts/v2_story/recipes_curated');
    const { postId, moduleIdx, recipeKey } = req.body || {};
    if (!postId || moduleIdx == null || !recipeKey) {
      return res.status(400).json({ error: 'postId + moduleIdx + recipeKey required' });
    }
    if (!hasRecipe(recipeKey)) return res.status(400).json({ error: 'unknown recipeKey: ' + recipeKey });

    const mp = modulesPath(postId);
    const modulesData = safeJson(mp, { modules: [] });
    const mod = (modulesData.modules || [])[moduleIdx];
    if (!mod) return res.status(404).json({ error: 'module not found' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const meta = getBindingMeta(mod, si);
    if (!meta) return res.status(400).json({ error: 'binding解決失敗' });

    const keys = expandRecipe(recipeKey, meta.availableSlots);
    if (!keys?.length) return res.status(400).json({ error: 'recipe 展開結果が空（walker に該当キー無し）' });

    mod.dataSlots = buildDataSlotsFromMeta(meta, keys);
    mod.binding = {
      subject:        meta.subject,
      aspect:         meta.aspect,
      primary:        meta.primary,
      secondary:      meta.secondary,
      customSlotKeys: keys,
      recipeKey,
    };
    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));
    res.json({ ok: true, dataSlots: mod.dataSlots, customSlotKeys: keys, recipeKey });
  } catch (e) {
    console.error('[v2/apply-recipe]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/apply-slot-keys : binding ベースでスロット選択を更新 ─
// Input:  { postId, moduleIdx, customSlotKeys: ['k1', ...] }
// Output: { ok, dataSlots }  ← 永続化も実施
router.post('/v2/apply-slot-keys', express.json(), (req, res) => {
  try {
    const { getBindingMeta, buildDataSlotsFromMeta } = require('../scripts/v2_story/binding_meta');
    const { postId, moduleIdx, customSlotKeys } = req.body || {};
    if (!postId || moduleIdx == null || !Array.isArray(customSlotKeys)) {
      return res.status(400).json({ error: 'postId + moduleIdx + customSlotKeys[] required' });
    }
    const mp = modulesPath(postId);
    const modulesData = safeJson(mp, { modules: [] });
    const mod = (modulesData.modules || [])[moduleIdx];
    if (!mod) return res.status(404).json({ error: 'module not found' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] } } });
    const meta = getBindingMeta(mod, si);
    if (!meta) return res.status(400).json({ error: 'binding解決失敗（SIデータ未取得）' });

    const validKeys = new Set(meta.availableSlots.map(s => s.key));
    const keys = customSlotKeys.filter(k => validKeys.has(k));
    mod.dataSlots = buildDataSlotsFromMeta(meta, keys);
    mod.binding = {
      subject:        meta.subject,
      aspect:         meta.aspect,
      primary:        meta.primary,
      secondary:      meta.secondary,
      customSlotKeys: keys,
    };

    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));
    res.json({ ok: true, dataSlots: mod.dataSlots, customSlotKeys: keys });
  } catch (e) {
    console.error('[v2/apply-slot-keys]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/ai-fill-slide : スライド丸ごと AI 1発（type/title/dataSlots/narration）─
// Input:  { postId, moduleIdx, userPrompt, incremental? }
//   incremental=true: 既存内容を最大限保持し、ユーザー注文の差分のみ適用（微調整モード）
// Output: { ok, type, title, dataSlots, narration, used, reviewed, reviewIssues }
router.post('/v2/ai-fill-slide', express.json(), async (req, res) => {
  const { postId, moduleIdx, userPrompt, incremental } = req.body || {};
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
        topPlayers: sofa.topPlayers,
        last5: sofa.last5,
        recentForm: sofa.recentForm,
        teamStats: sofa.teamStats,
        marketValue: sofa.marketValue,
        contractUntil: sofa.contractUntil,
      }).slice(0, 2200) : 'sofa:取得失敗';

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
    const ctxH2H       = await _h2hContextIfTeams(items, primary, secondary);

    // 利用可能レシピ（このスライドの primary entity に対するもの）
    let recipesSection = '';
    try {
      const { getBindingMeta } = require('../scripts/v2_story/binding_meta');
      const probeMeta = getBindingMeta(mod, si);
      if (probeMeta?.recipes?.length) {
        const lines = probeMeta.recipes.map(r => `  - "${r.key}": ${r.label} — ${r.description}`).join('\n');
        recipesSection = `

【利用可能レシピ（推奨：これを選ぶと意図がブレない）】
${lines}

JSON 出力で **"recipeKey": "<上記レシピキー>"** を返せば dataSlots は自動充填されます。
レシピで意図がカバーできない場合のみ "dataSlots" を直接返してください（recipeKey と dataSlots の両方を返さない）。`;
      }
    } catch (_) {}

    // ── 案件全体の文脈（saved_projects.json から）──
    let projectCtx = '';
    try {
      const sp = safeJson(path.join(DATA_DIR, 'saved_projects.json'), []);
      const proj = (Array.isArray(sp) ? sp : []).find(p => p.id === postId);
      if (proj) {
        const bodyExcerpt = (proj.raw?.bodyJa || proj.raw?.body || proj.selftext || '').slice(0, 600);
        const topComments = (proj.raw?.comments || [])
          .slice(0, 5)
          .map(c => '- ' + (c.bodyJa || c.body || '').slice(0, 160))
          .filter(s => s.length > 4)
          .join('\n');
        projectCtx = `【案件全体の文脈】
タイトル: ${proj.title || proj.titleOrig || '(?)'}
原題: ${proj.titleOrig || '(?)'}
${bodyExcerpt ? '【案件本文（事実情報の主源）】\n' + bodyExcerpt + '\n' : ''}${topComments ? '【上位コメント（視聴者の感想・予測。事実ではない）】\n' + topComments + '\n' : ''}

━━━ 【ファクト管理ルール（厳守）】━━━
- narration / title の地の文に書く事実は **【案件本文】と sofa/wiki データの範囲内** で
- 【案件本文】が**未来形・予定形・推測形**で書いてる事象を、narration で**確定形・完了形に書き換え禁止**
  ❌例: 本文「復帰予定」 → narration「復帰戦のサラー」「復帰した瞬間」
  ✅例: 本文「復帰予定」 → narration「復帰決定の報を受けて」「今季中の復帰へ」
- 上位コメントは reaction 型で「ファンの声」として紹介する用途のみ。地の文の事実根拠にしない
- sofa/wiki の数値（過去成績・通算・経歴）は事実として OK
━━━━━━━━━━━━━━━━━━━━━━━━`;
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

    // ── 微調整モード時の現スライド snapshot を構築 ──
    const currentSnapshot = incremental ? `
【現スライド既存内容（保持の基準）】
type:      ${mod.type || '?'}
title:     ${mod.title || ''}
narration: ${(mod.narration || '').slice(0, 600)}
dataSlots: ${JSON.stringify(mod.dataSlots || []).slice(0, 1500)}
${Array.isArray(mod.catchphrases) && mod.catchphrases.length ? 'catchphrases: ' + JSON.stringify(mod.catchphrases) : ''}
` : '';

    const incrementalRule = incremental ? `

【★微調整モード（厳守）】
- 上記「既存内容」を**最大限保持**し、ユーザー注文の差分のみ適用
- ユーザーが「データを追加」と言ったら → dataSlots に新規項目を追加（既存項目は維持）
- ユーザーが「ナレーションに〇〇を追加」と言ったら → 既存 narration に該当部分を組み込む（全文書き直しNG）
- ユーザーが触れてない要素（type / title / 他のdataSlot等）は**そのまま維持**
- 全体を作り直さない。注文された差分だけ反映する
` : '';

    const prompt = `あなたはサッカーYouTubeの脚本AI。スライド1枚の本体を完全に組み立てる。
${incremental
  ? '既存内容を保持しながら、ユーザー注文の差分だけ適用して type / title / dataSlots / narration を返してください。'
  : 'type / title / dataSlots / narration を**一気通貫で**生成してください。'}

${projectCtx}
${currentSnapshot}
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
${ctxH2H}
${recipesSection}

【ユーザー注文】
${userPrompt}
${incrementalRule}
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
  ・該当データが見つからない場合は値に「データ未取得」と入れる（数字を捏造しない）
  ・特に「過去対戦成績（全期間）」「優勝回数」「歴代記録」のような長期データは、本プロンプト内のデータに無ければ推測しない
  ・H2H ブロックがある場合：その範囲（直近5試合等）の数字のみ使用OK。「全期間」と表記しない
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
  "recipeKey": "<上記レシピキー>",   // 推奨：レシピで意図カバーできるなら
  // または
  "dataSlots": [...],                // レシピで足りない時のみ
  "narration": "..."
}
※ recipeKey と dataSlots は **どちらか片方** だけ返す`;

    // Sonnet 既定（構成・データ選定・脚本品質を優先） → JSON崩れ時 v4flash 保険
    let raw, parsed = null, used = 'sonnet';
    try {
      raw = await callAI({
        forceProvider: 'anthropic',
        model: 'claude-sonnet-4-6', max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
      });
      const m1 = raw && raw.match(/\{[\s\S]*\}/);
      if (m1) parsed = JSON.parse(m1[0]);
    } catch (e) { console.warn('[ai-fill-slide] sonnet 例外:', e.message); }
    if (!parsed?.type || !Array.isArray(parsed?.dataSlots)) {
      console.warn('[ai-fill-slide] sonnet 失敗、v4flash にフォールバック');
      try {
        raw = await callAI({
          forceProvider: 'deepseek',
          model: 'deepseek-v4-flash', max_tokens: 3500,
          messages: [{ role: 'user', content: prompt }],
        });
        const m2 = raw && raw.match(/\{[\s\S]*\}/);
        if (m2) parsed = JSON.parse(m2[0]);
        used = 'v4flash';
      } catch (_) {}
    }
    if (!parsed?.type || !Array.isArray(parsed?.dataSlots)) {
      return res.status(500).json({ error: 'AI応答のパースに失敗' });
    }

    // ── Pass 2: DeepSeek 自己監修（事実整合性チェック）──
    //   元データと生成結果を突き合わせ、矛盾を検出して修正版を返させる。
    //   失敗時は Pass 1 の結果をそのまま使う（フェイルセーフ）。
    let reviewIssues = [];
    let reviewUsed   = false;
    try {
      const reviewPrompt = `あなたはサッカーYouTube脚本の事実整合性チェッカー。
別のAIが生成した narration / dataSlots を、元データと突き合わせて矛盾があれば指摘・修正してください。

【元データ】
${ctxPrimary}
${ctxSecondary}
${ctxH2H}

【生成結果（チェック対象）】
type: ${parsed.type}
title: ${parsed.title || ''}
dataSlots: ${JSON.stringify(parsed.dataSlots).slice(0, 2000)}
narration:
${parsed.narration || ''}

【チェック観点（厳密に）】
1. narration 内の固有数字（順位/ゴール数/試合数/年/勝敗）が元データに辿れるか
2. narration 内の **リーグ名・大会名** が元データの leagueName と一致するか
   ・元データの leagueName が "UEFA Champions League" なのに narration が「リーグ戦◯位」と書いてたら誤り
   ・"Bundesliga" / "Premier League" 等の国内リーグ名と「リーグ戦」が一致してれば正
   ・standing は leagueName が示す競技の順位であることを忘れずに
3. dataSlots の値と narration の説明が同じ事実を指しているか
4. 元データに**明示されていない**数字（CL優勝回数、通算試合数等）を narration や dataSlots が出してないか
   ・H2H ブロックがあれば「直近5試合」等の範囲付き表現になっているか（「全期間 X勝Y敗」と断言してないか）
5. 通算値の計算（複数クラブのcaps合計など）が元データから検算できるか
6. 固有名詞（チーム名・選手名）が元データの綴りと一致するか

【★時間軸の3層区別 — 致命的エラー防止（厳守）】
データには3つの異なる時間軸のスタッツが存在します。混同・誤帰属は致命的エラー：

(A) lastMatchStats = その1試合限定のスタッツ
    ・tournament フィールドにその試合の大会名が記載される
    ・narration で「今日の試合で N得点」「この試合で N アシスト」のみ使用OK
    ・「今期」「通算」と書くのは誤り

(B) seasonStats = 今シーズンの累積スタッツ（ほぼ国内リーグ限定）
    ・sofa.leagueName が示すリーグ（"LaLiga"/"Premier League"/"Bundesliga"等）の累積
    ・CL/EL/カップ戦の数字は含まれない
    ・narration で「今季N得点」と書くなら必ず leagueName を併記
      ✓「今季ラ・リーガで N 得点」「今季プレミアで N 得点」
      ✗「今季CLで N 得点」（誤り。CL得点は別カテゴリ。修正対象）

(C) 通算/career = 入手不可（選手の場合）
    ・「CL通算 X 試合 N ゴール」「キャリア通算 N ゴール」等は元データに無い
    ・**書いていたら narration から削除**
    ・例外: 監督の overallPerformance は通算データなのでそのまま使ってOK

【★大会名の混同検出】
- 「リーガ」「ラ・リーガ」「La Liga」は全て同一（スペイン1部）
- 「プレミア」「プレミアリーグ」「Premier League」「PL」は全て同一（イングランド1部）
- 異なるリーグ名の混在は誤り：
  ✗「アーセナルは現在リーガでPL首位」（リーガ＝La Liga なので矛盾。修正対象）
  ✓「アーセナルはプレミアリーグで首位」

【★固有名詞の翻字保持 — 致命的事故防止】
元データの英語/スペイン語/スウェーデン語等の綴りを勝手にカタカナ変換しない。
過去事故例（修正必須）：
  ✗ Julián Álvarez → 「ホアン・アルバレス」（Juan ではない。Julián はスペイン語の「フリアン」）
  ✓ Julián Álvarez → 「フリアン・アルバレス」または「ジュリアン・アルバレス」
  ✗ Viktor Gyökeres → 「ヒョイビャー」「ヒョーケレス」（独自変換は禁止）
  ✓ Viktor Gyökeres → 「ヴィクトル・ギョケレス」（標準的な日本語化）
- Wikipedia extract に日本語表記があればそれを優先
- 不明な場合は標準的な日本語表記に留める。当て字・推測カタカナ化は禁止

【修正方針】
- narration の修正は **最小限・ピンポイント**で。文体・前後スライドとの繋ぎは維持
- dataSlots の修正は数字や固有名の誤りのみ
- 元データに該当が無い数字は「データ未取得」と記すか narration から削除
- 「矛盾なし」なら issues は空配列、fixed には元の値をそのまま入れて返す

【出力】JSONのみ（マークダウン不要）:
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

      const reviewRaw = await callAI({
        forceProvider: 'anthropic',
        model: 'claude-sonnet-4-6', max_tokens: 4000,
        messages: [{ role: 'user', content: reviewPrompt }],
      });
      const rm = reviewRaw && reviewRaw.match(/\{[\s\S]*\}/);
      if (rm) {
        const reviewed = JSON.parse(rm[0]);
        if (Array.isArray(reviewed.issues) && reviewed.fixed?.type && Array.isArray(reviewed.fixed.dataSlots)) {
          reviewIssues = reviewed.issues;
          if (reviewIssues.length > 0) {
            console.log(`[ai-fill-slide] 自己監修で ${reviewIssues.length} 件の矛盾検出 → 修正適用`);
            reviewIssues.forEach(iss =>
              console.log(`  - [${iss.where}] "${iss.claim}" → ${iss.fix}`)
            );
            parsed = reviewed.fixed;
            reviewUsed = true;
          } else {
            console.log('[ai-fill-slide] 自己監修パス（矛盾なし）');
          }
        }
      }
    } catch (e) {
      console.warn('[ai-fill-slide] 自己監修例外（Pass1結果を使用）:', e.message);
    }

    // 反映（既存の siBindingLeft/Right や homeTeam/awayTeam 等の補助フィールドは温存）
    // matchcard は matchData ベースで dataSlots を使わないので、AI が返しても空に固定
    const ALLOWED_TYPES = ['insight','stats','profile','comparison','history','reaction','matchcard'];
    if (ALLOWED_TYPES.includes(parsed.type)) mod.type = parsed.type;
    if (typeof parsed.title === 'string')     mod.title = parsed.title;
    if (typeof parsed.narration === 'string') mod.narration = parsed.narration;
    mod.dataSlots = (mod.type === 'matchcard') ? [] : parsed.dataSlots;

    // ── walker 経由で dataSlots を実値で再構築（AI捏造値を上書き）──
    //   優先順位:
    //     ① AI が parsed.recipeKey を返した → walker キーに展開
    //     ② AI が dataSlots を返した → label を fuzzy 一致 → walker キー特定
    //   いずれも結果として walker の実値で書き換える。
    try {
      const { getBindingMeta, buildDataSlotsFromMeta } = require('../scripts/v2_story/binding_meta');
      const { expandRecipe, hasRecipe } = require('../scripts/v2_story/recipes_curated');
      const meta = getBindingMeta(mod, si);
      if (meta) {
        let keys = [];
        let recipeKeyAdopted = null;
        // ① recipeKey 優先
        if (parsed.recipeKey && hasRecipe(parsed.recipeKey)) {
          const expanded = expandRecipe(parsed.recipeKey, meta.availableSlots);
          if (expanded?.length) {
            keys = expanded;
            recipeKeyAdopted = parsed.recipeKey;
            console.log(`[ai-fill-slide] recipe採用: ${parsed.recipeKey} → ${expanded.length} keys`);
          }
        }
        // ② recipe 未採用 → AI dataSlots の label を fuzzy 一致
        if (!keys.length && Array.isArray(parsed.dataSlots)) {
          const aiLabels = parsed.dataSlots.map(s => String(s?.label || '').trim()).filter(Boolean);
          const labelToKey = new Map(meta.availableSlots.map(s => [s.label, s.key]));
          keys = aiLabels
            .map(l => labelToKey.get(l) || meta.availableSlots.find(s => s.label.includes(l) || l.includes(s.label))?.key)
            .filter(Boolean);
          keys = Array.from(new Set(keys));
          const targetMin = meta.isCompare ? 5 : 4;
          const targetMax = meta.isCompare ? 5 : 6;
          if (keys.length < targetMin) {
            const fillers = meta.defaultSelection.filter(k => !keys.includes(k));
            keys = [...keys, ...fillers].slice(0, targetMax);
          } else if (keys.length > targetMax) {
            keys = keys.slice(0, targetMax);
          }
        }
        if (keys.length) {
          mod.dataSlots = buildDataSlotsFromMeta(meta, keys);
          mod.binding = {
            subject:        meta.subject,
            aspect:         meta.aspect,
            primary:        meta.primary,
            secondary:      meta.secondary,
            customSlotKeys: keys,
            ...(recipeKeyAdopted ? { recipeKey: recipeKeyAdopted } : {}),
          };
          console.log(`[ai-fill-slide] 実値充填: ${meta.subject}.${meta.aspect} / keys=${keys.length}${recipeKeyAdopted ? ' (recipe='+recipeKeyAdopted+')' : ''}`);
        }
      }
    } catch (e) {
      console.warn('[ai-fill-slide] walker 実値充填スキップ:', e.message);
    }

    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));

    res.json({
      ok:        true,
      type:      mod.type,
      title:     mod.title,
      dataSlots: mod.dataSlots,
      narration: mod.narration,
      used,
      reviewed:    reviewUsed,
      reviewIssues,
    });
  } catch (e) {
    console.error('[v2/ai-fill-slide]', e);
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
      forceProvider: 'anthropic',
      model: 'claude-sonnet-4-6', max_tokens: 1000,
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
  // ログをファイル保存（render.js の console.log / console.warn を全部キャプチャ）
  //   診断目的：失敗時にどのスライドで何が起きたか追跡可能にする
  const logPath = path.join(JOB_DIR, jobId + '.log');
  const logFd   = fs.openSync(logPath, 'a');
  const proc = spawn('node', [renderScript, postId, jobId], {
    detached: true, stdio: ['ignore', logFd, logFd],
    cwd: path.join(__dirname, '..'),
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

    // chunk決定: tts_minimax の buildChunksForModule に集約
    //   - reaction は narration + comments[] を順次音声化
    //   - insight / history は narrationChunks 優先
    //   - その他は narration をそのまま1チャンク
    const { buildChunksForModule } = require('../scripts/v2_video/tts_minimax');
    const chunks = buildChunksForModule(mod);

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

// ─── スライドビルダ（require は1回だけ。リクエスト毎ロード回避）──
const _slideBuilders = (() => {
  const { buildOpeningHTML: opV1 } = require('../scripts/v2_video/slides/opening');
  const { buildOpeningHTML: opV2 } = require('../scripts/v2_video/slides/opening_v2');
  const { buildOpeningHTML: opV3 } = require('../scripts/v2_video/slides/opening_v3');
  const { buildEndingHTML:  edV1 } = require('../scripts/v2_video/slides/ending');
  const { buildEndingHTML:  edV2 } = require('../scripts/v2_video/slides/ending_v2');
  const { buildEndingHTML:  edV3 } = require('../scripts/v2_video/slides/ending_v3');
  return {
    OPB: { v1: opV1, v2: opV2, v3: opV3 },
    EDB: { v1: edV1, v2: edV2, v3: edV3 },
    universal:  require('../scripts/v2_video/slides/universal').buildUniversalHTML,
    insight:    require('../scripts/v2_video/slides/insight').buildInsightHTML,
    history:    require('../scripts/v2_video/slides/history').buildHistoryHTML,
    matchcard:  require('../scripts/v2_video/slides/matchcard').buildMatchcardHTML,
    profile:    require('../scripts/v2_video/slides/profile').buildProfileHTML,
    stats:      require('../scripts/v2_video/slides/stats').buildStatsHTML,
    comparison: require('../scripts/v2_video/slides/comparison').buildComparisonHTML,
    reaction:   require('../scripts/v2_video/slides/reaction').buildReactionHTML,
    toc:        require('../scripts/v2_video/slides/toc').buildTocHTML,
    mapImagesToModule: require('../scripts/v2_video/slides/_common').mapImagesToModule,
  };
})();

function _buildSlideForPreview(mod) {
  const { OPB, EDB, mapImagesToModule } = _slideBuilders;
  const m = mapImagesToModule(mod);
  const opVar = OPB[m.variant] ? m.variant : 'v1';
  const edVar = EDB[m.variant] ? m.variant : 'v1';
  switch (m.type) {
    case 'opening':     return OPB[opVar](m);
    case 'ending':      return EDB[edVar](m);
    case 'toc':         return _slideBuilders.toc(m);
    case 'insight':     return _slideBuilders.insight(m);
    case 'history':     return _slideBuilders.history(m);
    case 'matchcard':   return _slideBuilders.matchcard(m);
    case 'stats':       return _slideBuilders.stats(m);
    case 'profile':     return _slideBuilders.profile(m);
    case 'comparison':  return _slideBuilders.comparison(m);
    case 'reaction':    return _slideBuilders.reaction(m);
    default:            return _slideBuilders.universal(m);
  }
}

// ─── /v2/preview-slide : 1モジュールのスライドHTML（disk経由・後方互換） ──
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
    res.set('Content-Type', 'text/html; charset=utf-8').send(_buildSlideForPreview(mod));
  } catch (e) { res.status(500).send('<!doctype html><title>err</title><body>' + e.message + '</body>'); }
});

// ─── /v2/preview-slide-inline : POST body で module を直接受け取り（disk read 無し・最速） ──
router.post('/v2/preview-slide-inline', (req, res) => {
  const { module: mod } = req.body || {};
  if (!mod) return res.status(400).send('<!doctype html><title>err</title><body>module required</body>');
  try {
    res.set('Content-Type', 'text/html; charset=utf-8').send(_buildSlideForPreview(mod));
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

  /* ── このモジュールが参照するラベル一覧を返す。Step3.5 と同じキー文字列を返す。 ── */
  function _labelsForModule(m) {
    if (!m) return [];
    const out = [];
    const mk = m.mainKey || '';
    const colon = mk.indexOf(':');
    const type   = colon < 0 ? mk : mk.slice(0, colon);
    const entity = colon < 0 ? '' : mk.slice(colon + 1);

    // matchcard は SI の両チーム名を team:Home / team:Away として展開
    if (type === 'matchcard' || type === 'match') {
      const si = window.APP.s4.siData || {};
      const matches = si?.boxes?.match?.items || [];
      let home = null, away = null;
      for (const mm of matches) {
        const sofa = mm.sofa || mm;
        home = home || sofa.homeTeam?.name || sofa.home?.name || sofa.homeName;
        away = away || sofa.awayTeam?.name || sofa.away?.name || sofa.awayName;
        if (home && away) break;
      }
      if (!home || !away) {
        const teamItems = (si?.boxes?.entity?.items || []).filter(it => it.role === 'team');
        if (!home && teamItems[0]) home = teamItems[0].label;
        if (!away && teamItems[1]) away = teamItems[1].label;
      }
      if (home) out.push('team:' + home);
      if (away) out.push('team:' + away);
    } else if (type === 'opening' || type === 'ending' || !mk) {
      // ラベル無し
    } else {
      out.push(mk);
    }

    const sec = m.secondary || (m.binding && m.binding.secondary);
    if (sec) {
      out.push(sec.indexOf(':') >= 0 ? sec : ('entity:' + sec));
    }
    // 重複除去
    return Array.from(new Set(out));
  }

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
    // matchcard は matchData (試合データ) を表示するテンプレで dataSlots は使わない
    if (Array.isArray(m.dataSlots) && m.dataSlots.length && m.type !== 'matchcard') {
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

    /* Step 3.5 で選択した画像のギャラリー（全ラベルの選定済画像を1プールで共有表示） */
    //   - 全 selections をフラットに展開して、どのスライドからでも全画像を選べる
    let galleryHtml = '';
    const allSelections = window.APP.s4.imageSelections || {};
    const seen = new Set();
    const pool = []; // [{ path, fromLabel }]
    Object.keys(allSelections).forEach(function(lbl) {
      const arr = allSelections[lbl];
      if (!Array.isArray(arr)) return;
      arr.forEach(function(p) {
        if (!seen.has(p)) { seen.add(p); pool.push({ path: p, fromLabel: lbl }); }
      });
    });
    const cardImgs = Array.isArray(m.images) ? m.images : [];
    if (pool.length) {
      galleryHtml = ''
        + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🖼️ 共有画像プール ('
        + pool.length + '枚)<span style="color:#5a6a8a;font-weight:normal;margin-left:6px;font-size:10px;">全スライド共通</span>'
        + ' <span style="color:#10b981;font-weight:normal;margin-left:6px;">このカードで '
        + cardImgs.length + ' 枚選択中</span></div>'
        + '<div style="display:flex;gap:6px;flex-wrap:wrap;padding:6px;background:#0d1220;border-radius:6px;max-height:200px;overflow-y:auto;">'
        + pool.map(function(it) {
            const p = it.path;
            const isSel = cardImgs.indexOf(p) >= 0;
            return '<div class="s4-thumb-toggle" data-path="' + _esc(p) + '" title="' + _esc(it.fromLabel) + '" '
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
        + '🖼️ 画像がまだ選択されていません — Step 3.5 で取得・選択してください'
        + '</div>';
    }

    /* バインドデータ・プルダウン (stats/profile/comparison/history カード用) */
    let bindHtml = '';
    const showBind = ['stats', 'profile', 'comparison', 'history'].includes(m.type);

    /* レシピが解決可能なカードは recipe accordion UI を出す（comparison/stats/profile/history） */
    //   comparison は従来通り siBindingLeft/Right も有効
    //   stats/profile は binding.subject + binding.aspect が揃ってれば対象
    const hasBinding = (
      (m.type === 'comparison' && (m.binding?.subject || (m.siBindingLeft && m.siBindingRight)))
      || (['stats','profile'].includes(m.type) && m.binding?.subject && m.binding?.aspect)
    );
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
      + '<span style="font-size:10px;color:#5a6a8a;">main=' + _esc(m.mainKey||'?') + '</span>'
      + '</div>'
      + '<button class="btn btn-sm" onclick="s4RegenNarr()" style="background:#3b82f6;color:#fff;font-size:10px;padding:4px 10px;">↻ ナレーション再生成</button>'
      + '</div>'
      + ((m.type === 'opening' || m.type === 'ending')
        ? '<div style="display:flex;align-items:center;gap:10px;margin:0 0 10px 0;padding:8px 10px;background:#1a1d2e;border:1px solid #6366f1;border-radius:4px;flex-wrap:wrap;">'
          + '<span style="font-size:11px;color:#a5b4fc;font-weight:bold;">' + (m.type === 'opening' ? '🎬 OP' : '🎬 ED') + ' バリアント:</span>'
          + ['v1','v2','v3'].map(function(v) {
              return '<label style="display:flex;align-items:center;gap:3px;font-size:11px;cursor:pointer;color:#e0e0e0;">'
                + '<input type="radio" name="s4-variant-' + i + '" value="' + v + '"' + ((m.variant||'v1')===v?' checked':'') + ' onchange="s4ChangeVariant(' + i + ',&#39;' + v + '&#39;)"> '
                + v.toUpperCase() + '</label>';
            }).join('')
          + '<span style="flex:1"></span>'
          + '<span style="font-size:10px;color:#5a6a8a;">' + (m.type === 'opening' ? 'V1=現行 / V2=数字フラッシュ / V3=タイトル爆発' : 'V1=現行 / V2=要点サマリ / V3=次回予告') + '</span>'
          + '</div>'
        : '')
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
      +   '<div style="display:flex;gap:10px;margin-top:6px;align-items:center;flex-wrap:wrap;">'
      +     '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#a5b4fc;cursor:pointer;user-select:none;">'
      +       '<input type="checkbox" class="s4-fill-incremental" data-idx="' + i + '" style="margin:0;">'
      +       '微調整モード（既存内容を保持して差分のみ適用）'
      +     '</label>'
      +     '<span style="flex:1"></span>'
      +     '<button class="btn btn-sm s4-fill-go" data-idx="' + i + '" style="background:#6366f1;color:#fff;font-size:11px;padding:5px 14px;font-weight:bold;">🪄 生成</button>'
      +   '</div>'
      +   '<div style="font-size:9px;color:#5a6a8a;margin-top:4px;">Sonnet 既定 → 失敗時 DeepSeek フォールバック</div>'
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
    /* レシピセレクタ: change → apply-recipe（空値はカスタム継続で no-op）*/
    el.querySelectorAll('.s4-recipe-selector').forEach(function(sel) {
      sel.addEventListener('change', function() {
        const idx = parseInt(sel.getAttribute('data-idx'), 10);
        const recipeKey = sel.value;
        if (Number.isNaN(idx)) return;
        if (!recipeKey) return;  // カスタムへ戻す挙動は slot toggle 経由
        s4ApplyRecipe(idx, recipeKey);
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
    const recipes = data.recipes || [];
    const currentRecipeKey = data.currentRecipeKey || '';
    const currentRecipe    = recipes.find(r => r.key === currentRecipeKey);

    // ─ レシピバナー（recipes が1件以上ある時だけ）─
    let recipeBanner = '';
    if (recipes.length) {
      const opts = '<option value="">— カスタム（個別選定）—</option>'
        + recipes.map(r => '<option value="' + _esc(r.key) + '"'
            + (r.key === currentRecipeKey ? ' selected' : '') + '>'
            + _esc(r.label) + ' (' + (r.keys?.length || 0) + 'keys)</option>').join('');
      recipeBanner = '<div style="margin:14px 0 10px;padding:10px 12px;background:#1a1d2e;border:1px solid #6366f1;border-radius:6px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">'
        + '<span style="font-size:11px;color:#a5b4fc;font-weight:bold;">📂 レシピ:</span>'
        + '<select data-idx="' + idx + '" class="s4-recipe-selector inp" style="font-size:11px;padding:4px 8px;flex:1;min-width:200px;background:#0a0d18;color:#e0e0e0;">'
        + opts
        + '</select>'
        + (currentRecipe
            ? '<span style="font-size:9px;color:#5a6a8a;flex-basis:100%;">' + _esc(currentRecipe.description) + '</span>'
            : '<span style="font-size:9px;color:#5a6a8a;flex-basis:100%;">↑ 選ぶと dataSlots が一発で組み上がる。下のアコーディオンで個別追加も可</span>')
        + '</div>';
    }

    const head = '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:8px 0 6px;display:flex;align-items:center;gap:8px;">'
      + '🔍 全データ（' + total + ' slots）<span style="font-size:9px;color:#8a9aba;font-weight:normal;">'
      + _esc(data.subject) + '.' + _esc(data.aspect) + ' / '
      + _esc(data.primary || '?')
      + (data.isCompare ? ' vs ' + _esc(data.secondary || '?') : '')
      + '</span><span style="flex:1;"></span>'
      + '<span style="font-size:9px;color:#10b981;">' + sel.size + ' 採用中</span>'
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

  /* 🪄 スライド全部おまかせ AI: type/title/dataSlots/narration を一気通貫生成（or 微調整） */
  window.s4FillSlideAI = async function(idx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const ta = document.querySelector('.s4-fill-prompt[data-idx="' + idx + '"]');
    const userPrompt = (ta?.value || '').trim();
    if (!userPrompt) { _msg('注文内容を書いてね'); return; }
    const incCb = document.querySelector('.s4-fill-incremental[data-idx="' + idx + '"]');
    const incremental = !!(incCb && incCb.checked);
    const status = document.querySelector('.s4-fill-status[data-idx="' + idx + '"]');
    if (status) status.textContent = incremental ? '⏳ 微調整中...' : '⏳ 全体生成中...';
    const confirmMsg = incremental
      ? '微調整モード: 既存内容を保持しつつ、注文の差分のみ適用します。OK?'
      : '現在のスライドの type / title / dataSlots / narration を AI 生成で上書きします。OK?';
    if (!confirm(confirmMsg)) {
      if (status) status.textContent = '';
      return;
    }
    try {
      const r = await fetchJson('/api/v2/ai-fill-slide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, userPrompt, incremental }),
      });
      if (!r.ok) throw new Error(r.error || '生成失敗');
      const m = window.APP.s4.modules[idx];
      if (m) {
        if (r.type)      m.type      = r.type;
        if (r.title)     m.title     = r.title;
        if (r.narration) m.narration = r.narration;
        m.dataSlots = r.dataSlots || [];
      }
      let suffix = '';
      if (r.reviewed && Array.isArray(r.reviewIssues) && r.reviewIssues.length) {
        suffix = ' / 🔍 自己監修で ' + r.reviewIssues.length + ' 件修正';
      } else if (r.reviewIssues && r.reviewIssues.length === 0) {
        suffix = ' / 🔍 監修OK';
      }
      if (status) status.textContent = '✅ 生成完了 (' + (r.used || 'deepseek') + ')' + suffix;
      _renderEditor();
      _reloadPreview();
      // 監修で修正があった場合、何が直されたか軽く通知
      if (r.reviewed && r.reviewIssues?.length) {
        const summary = r.reviewIssues.slice(0, 3).map(function(it) {
          return '• [' + (it.where || '?') + '] ' + (it.claim || '').slice(0, 60) + ' → ' + (it.fix || '').slice(0, 60);
        }).join('\\n');
        _msg('🔍 自己監修で ' + r.reviewIssues.length + ' 件修正:\\n' + summary);
      }
    } catch (e) {
      if (status) status.textContent = '❌ ' + e.message;
      _msg('❌ 生成失敗: ' + e.message);
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
        if (m.binding) {
          m.binding.customSlotKeys = r.customSlotKeys;
          delete m.binding.recipeKey;     // 手動編集 = カスタム化
        }
      }
      // キャッシュの selected と currentRecipeKey を更新（カスタム化）
      cached.selected = r.customSlotKeys;
      cached.currentRecipeKey = null;
      _renderEditor();
      _reloadPreview();
    } catch (e) {
      _msg('❌ スロット更新失敗: ' + e.message);
    }
  };

  /* レシピ適用: ドロップダウンで選んだレシピを dataSlots に展開 */
  window.s4ApplyRecipe = async function(idx, recipeKey) {
    const post = window.APP.selected;
    if (!post?.id || !recipeKey) return;
    try {
      const r = await fetchJson('/api/v2/apply-recipe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, recipeKey }),
      });
      if (!r.ok) throw new Error(r.error || 'レシピ適用失敗');
      const m = window.APP.s4.modules[idx];
      if (m) {
        m.dataSlots = r.dataSlots;
        m.binding = m.binding || {};
        m.binding.customSlotKeys = r.customSlotKeys;
        m.binding.recipeKey      = r.recipeKey;
      }
      const cached = window.APP.s4.recipeSlotsByIdx[idx];
      if (cached) {
        cached.selected         = r.customSlotKeys;
        cached.currentRecipeKey = r.recipeKey;
      }
      _renderEditor();
      _reloadPreview();
      _msg('✅ レシピ適用: ' + recipeKey + ' (' + r.customSlotKeys.length + 'keys)');
    } catch (e) {
      _msg('❌ レシピ適用失敗: ' + e.message);
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
    _renderEditor();
    _saveAndReload();
  };

  /* ── プレビュー更新ヘルパ（インライン化により、保存と並行）──
     新版の _reloadPreview は disk read を経由せず、
     mod を直接 POST → HTML を返す。
     保存とプレビューを並行起動して体感速度を改善。 */
  async function _saveAndReload() {
    _collectInputs();
    // 保存とプレビューを並行（プレビューは disk 経由じゃないので待つ必要無し）
    _saveModulesQuiet();   // fire-and-forget（チェーンで直列化されるので race 無し）
    _reloadPreview();      // 即時プレビュー
  }

  /* ── 入力監視 → 短い debounce で即時プレビュー反映 ── */
  let _previewTimer = null;
  window.s4OnInput = function() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(_saveAndReload, 350);
  };

  /* ── OP/ED バリアント変更 ── */
  window.s4ChangeVariant = function(idx, v) {
    const m = window.APP.s4.modules[idx];
    if (!m) return;
    m.variant = v;
    _saveAndReload();
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
    _saveAndReload();
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
  /* ── SofaScore の英語キー → 日本語表示名 マップ ── */
  const _LABEL_JA = {
    // 共通スタッツ
    appearances: '出場', goals: 'ゴール', assists: 'アシスト', rating: '評価',
    minutesPlayed: '出場分', yellowCards: '警告', redCards: '退場',
    expectedGoals: 'xG', xG: 'xG',
    keyPasses: 'キーパス', bigChancesCreated: 'ビッグチャンス創出',
    bigChancesMissed: 'ビッグチャンス逃失', successfulDribbles: 'ドリブル成功',
    totalShots: 'シュート数', shotsOnTarget: '枠内シュート',
    accuratePassesPct: 'パス成功率', accuratePassesPercentage: 'パス成功率',
    tackles: 'タックル', interceptions: 'インターセプト',
    cleanSheets: '完封', cleanSheet: '完封',
    saves: 'セーブ', savedFromBox: 'ボックス内セーブ',
    savedShotsFromInsideTheBox: 'ボックス内セーブ',
    goalsPrevented: '失点防止', goalsConceded: '失点',
    clearances: 'クリア', duelsWon: 'デュエル勝',
    aerialDuelsWon: '空中戦勝', blockedShots: 'ブロック',
    // 試合スタッツ
    date: '日付', tournament: '大会', opponent: '相手', score: 'スコア',
    shots: 'シュート', passes: 'パス数',
    dribbles: 'ドリブル', dribblesWon: 'ドリブル成功',
    touches: 'タッチ数', wasFouled: '被ファウル', fouls: 'ファウル',
    // 基本情報
    name: '名前', position: 'ポジション', nationality: '国籍',
    team: '所属', teamName: '所属', club: '所属',
    age: '年齢', height: '身長', weight: '体重',
    preferredFoot: '利き足', shirtNumber: '背番号', jerseyNumber: '背番号',
    marketValue: '市場価値', contractUntil: '契約満了', contractUntilTimestamp: '契約満了',
    leagueName: 'リーグ', league: 'リーグ', seasonYear: 'シーズン',
    managerName: '監督', country: '国',
    standing: '順位', position_rank: '順位',
    recentAvgRating: '直近平均評価',
    // チーム集計
    matches: '試合数', wins: '勝', draws: '分', losses: '敗',
    points: '勝ち点', goalsFor: '得点', goalsAgainst: '失点',
    avgGoalsScored: '平均得点', avgGoalsConceded: '平均失点',
    avgPossession: '平均支配率', passAccuracy: 'パス精度',
    avgShots: '平均シュート', avgShotsOnTarget: '平均枠内シュート',
    avgCorners: '平均CK', avgFouls: '平均ファウル', avgYellows: '平均警告',
    avgxG: '平均xG', founded: '創立', venue: '本拠地',
    recentForm: '直近フォーム', played: '試合数',
  };
  function _jaLabel(key) {
    if (!key) return '';
    if (_LABEL_JA[key]) return _LABEL_JA[key];
    // camelCase → スペース区切り（フォールバック・読みやすさ向上）
    return String(key)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/^./, c => c.toUpperCase());
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
        out.push({ section, label: _jaLabel(k), key: k, value: String(v) });
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
    _saveAndReload();
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
    _saveAndReload();
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

  /* ── 保存（直列化）──
     入力連打で複数 POST が並走するとサーバ側で書き込み順が乱れ、
     最後に到着したリクエストが「古い modules」で上書きする可能性がある。
     Promise チェーンで必ず順次実行する。 */
  let _saveChain = Promise.resolve();
  function _saveModulesQuiet() {
    const post = window.APP.selected;
    if (!post?.id) return Promise.resolve();
    // チェーンに次の保存を追加（前の保存が完了するまで待つ）
    _saveChain = _saveChain.then(async () => {
      try {
        await fetchJson('/api/save-modules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ postId: post.id, modules: window.APP.s4.modules }),
        });
      } catch (_) {}
    });
    return _saveChain;
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

  /* ── プレビュー再読み込み（インライン高速版）──
     mod を直接 POST → HTML 受信 → Blob URL で iframe.src
     ・disk read 無し
     ・保存完了を待たない（楽観プレビュー）
     ・キャッシュバスター不要 */
  let _lastPreviewBlobUrl = null;
  let _reloadInFlight = false;
  let _reloadAgainNeeded = false;
  async function _reloadPreview() {
    if (_reloadInFlight) { _reloadAgainNeeded = true; return; }
    const i = window.APP.s4.activeTab;
    const mod = window.APP.s4.modules[i];
    const f = document.getElementById('s4PreviewFrame');
    if (!mod || !f) return;
    _reloadInFlight = true;
    try {
      const res = await fetch('/api/v2/preview-slide-inline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: mod }),
      });
      const html = await res.text();
      const blob = new Blob([html], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      f.onload = null; f.onerror = null;
      f.onload = function() { _resizePreview(); };
      f.src = url;
      if (_lastPreviewBlobUrl) URL.revokeObjectURL(_lastPreviewBlobUrl);
      _lastPreviewBlobUrl = url;
    } catch (_) {} finally {
      _reloadInFlight = false;
      if (_reloadAgainNeeded) { _reloadAgainNeeded = false; _reloadPreview(); }
    }
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
      const statusLabel = ({
        'queued':         '⏳ キュー待ち',
        'starting':       '🚀 起動中',
        'tts-generating': '🎙️ TTS生成中',
        'rendering':      '🎬 レンダリング中',
        'concatenating':  '🔗 結合中',
        'mixing-audio':   '🎵 BGMミックス中',
        'done':           '✅ 完成',
        'error':          '❌ エラー',
        'failed':         '❌ 失敗',
      })[j.status] || j.status || '?';
      let progress = '';
      if (j.status === 'tts-generating' && j.ttsTotal) {
        progress = ' (' + (j.ttsDone||0) + '/' + j.ttsTotal + ')';
      } else if (j.status === 'rendering' && j.totalSlides) {
        progress = ' (' + (j.doneSlides||0) + '/' + j.totalSlides + ')';
      }
      el.innerHTML = '<div><b>' + _esc(statusLabel) + '</b>' + _esc(progress) + '</div>'
        + (j.error    ? '<div style="color:#ef4444;">error: ' + _esc(j.error) + '</div>' : '')
        + (j.outputVideo ? '<div style="margin-top:4px;"><a href="/' + _esc(j.outputVideo) + '" target="_blank" style="color:#10b981;">▶ ' + _esc(j.outputVideo.split('/').pop()) + '</a></div>' : '');
      if (j.status === 'done' || j.status === 'failed' || j.status === 'error') {
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
