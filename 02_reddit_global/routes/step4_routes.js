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

// ─── /v2/walker-bind : 主/副 entity を手動指定して walker をバインド（AI不使用）────
// 「対比連結が AI 任せだと不安定」問題の根本対処（2026-05-10）
// mod の mainKey/secondary を手動上書き → walker → buildDataSlotsFromMeta で
// dataSlots を確定構築 → 永続化。compare カードと single カード両対応。
//
// Input: { postId, moduleIdx, primary: '<entity label>',
//          secondary?: '<entity label>'     ← compare カードのみ必須
//          customSlotKeys?: ['k1','k2',...] ← 省略時は defaultSelection
//          recipeKey?: '<recipe>' ← 指定時は展開キーで上書き
// }
// Output: { ok, mod, primary, secondary, customSlotKeys, availableSlots, recipes }
router.post('/v2/walker-bind', express.json(), (req, res) => {
  try {
    const { getBindingMeta, buildDataSlotsFromMeta } = require('../scripts/v2_story/binding_meta');
    const { expandRecipe, hasRecipe } = require('../scripts/v2_story/recipes_curated');
    const { postId, moduleIdx, primary, secondary, customSlotKeys, recipeKey } = req.body || {};
    if (!postId || moduleIdx == null || !primary) {
      return res.status(400).json({ error: 'postId + moduleIdx + primary required' });
    }
    const mp = modulesPath(postId);
    const modulesData = safeJson(mp, { modules: [] });
    const mod = (modulesData.modules || [])[moduleIdx];
    if (!mod) return res.status(404).json({ error: 'module not found' });

    const si = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] } } });
    const isCompareCard = (mod.type === 'comparison');
    if (isCompareCard && !secondary) {
      return res.status(400).json({ error: 'comparison カードでは secondary 必須' });
    }

    // mod の mainKey / secondary を手動上書き（AI推論をバイパス）
    // match 系（matchcard / match）は触らない。それ以外は entity:<primary> に正規化。
    const isMatchCard = mod.mainKey?.startsWith('match:') || mod.mainKey?.startsWith('matchcard:');
    if (!isMatchCard) {
      mod.mainKey   = 'entity:' + primary;
      mod.secondary = isCompareCard ? secondary : null;
      // siBindingLeft/Right は comparison.js 表示用
      if (isCompareCard) {
        mod.siBindingLeft  = primary;
        mod.siBindingRight = secondary;
      } else {
        delete mod.siBindingLeft;
        delete mod.siBindingRight;
      }
    }

    const meta = getBindingMeta(mod, si);
    if (!meta) {
      return res.status(400).json({
        error: `walker バインド失敗：${primary}${secondary ? ' / ' + secondary : ''} の SI データが取れていません`
      });
    }

    // 採用キーの決定：recipeKey > customSlotKeys > defaultSelection
    let keys = [];
    let usedRecipeKey = null;
    if (recipeKey && hasRecipe(recipeKey)) {
      keys = expandRecipe(recipeKey, meta.availableSlots) || [];
      usedRecipeKey = recipeKey;
    } else if (Array.isArray(customSlotKeys) && customSlotKeys.length) {
      const validKeys = new Set(meta.availableSlots.map(s => s.key));
      keys = customSlotKeys.filter(k => validKeys.has(k));
    }
    if (!keys.length) keys = (meta.defaultSelection || []).slice(0, meta.isCompare ? 5 : 7);

    mod.dataSlots = buildDataSlotsFromMeta(meta, keys);
    mod.binding = {
      subject:        meta.subject,
      aspect:         meta.aspect,
      primary:        meta.primary,
      secondary:      meta.secondary,
      customSlotKeys: keys,
      ...(usedRecipeKey ? { recipeKey: usedRecipeKey } : {}),
    };
    // history 対戦史型での H2H 固定フラグはユーザ手動上書き時はクリア（次の generate-scenario で再構築させる）
    delete mod._h2hFixed;

    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));
    console.log(`[walker-bind] mod#${moduleIdx} ${primary}${secondary ? ' vs ' + secondary : ''} → ${keys.length} slot 確定`);
    res.json({
      ok: true,
      mod,
      primary:      meta.primary,
      secondary:    meta.secondary,
      isCompare:    meta.isCompare,
      customSlotKeys: keys,
      availableSlots: meta.availableSlots,
      recipes:      meta.recipes,
    });
  } catch (e) {
    console.error('[v2/walker-bind]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/matchcard-lineup : matchcard モジュールの lineup と現状表示名を返す ─
// Input:  ?postId=X&moduleIdx=N
// Output: { ok, home: [{ name, displayName }], away: [...], overrides }
router.get('/v2/matchcard-lineup', (req, res) => {
  try {
    const { postId, moduleIdx } = req.query || {};
    if (!postId || moduleIdx == null) return res.status(400).json({ error: 'postId + moduleIdx required' });

    const modulesData = safeJson(modulesPath(postId), { modules: [] });
    const mod = (modulesData.modules || [])[parseInt(moduleIdx, 10)];
    if (!mod) return res.status(404).json({ error: 'module not found' });
    if (mod.type !== 'matchcard') return res.status(400).json({ error: 'not a matchcard' });

    // mainKey "match:HomeTeam vs AwayTeam" から match data を取得
    const mainKey = String(mod.mainKey || '');
    const matchLabel = mainKey.startsWith('match:')     ? mainKey.slice(6)
                     : mainKey.startsWith('matchcard:') ? mainKey.slice(10)
                     : null;
    if (!matchLabel) return res.status(400).json({ error: 'mainKey not match: format' });

    const si = safeJson(siPath(postId), { boxes: { match: { items: [] } } });
    const matchItem = (si.boxes?.match?.items || []).find(x => x.label === matchLabel);
    if (!matchItem || !matchItem.data) return res.json({ ok: true, home: [], away: [], overrides: mod.lineupOverrides || {} });

    const lu = matchItem.data.lineup || {};
    const { toKatakana } = require('../scripts/v2_video/_player_names_jp');
    const { _player } = require('../scripts/v2_video/slides/_common');
    const overrides = mod.lineupOverrides || {};

    function _displayName(p) {
      if (!p?.name) return '';
      if (overrides[p.name]) return overrides[p.name];
      const last = (typeof _player === 'function' ? _player(p.name) : null) || p.name;
      return toKatakana(last);
    }

    const home = (lu.home || []).map(p => ({ name: p.name || '', displayName: _displayName(p), pos: p.pos || '' }));
    const away = (lu.away || []).map(p => ({ name: p.name || '', displayName: _displayName(p), pos: p.pos || '' }));
    res.json({ ok: true, home, away, overrides });
  } catch (e) {
    console.error('[v2/matchcard-lineup]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/matchcard-lineup-overrides : 編集を保存 ─
// Input:  { postId, moduleIdx, overrides: { "Bukayo Saka": "サカ", ... } }
router.post('/v2/matchcard-lineup-overrides', express.json(), (req, res) => {
  try {
    const { postId, moduleIdx, overrides } = req.body || {};
    if (!postId || moduleIdx == null) return res.status(400).json({ error: 'postId + moduleIdx required' });

    const mp = modulesPath(postId);
    const modulesData = safeJson(mp, { modules: [] });
    const mod = (modulesData.modules || [])[parseInt(moduleIdx, 10)];
    if (!mod) return res.status(404).json({ error: 'module not found' });
    if (mod.type !== 'matchcard') return res.status(400).json({ error: 'not a matchcard' });

    // 空文字 / null は削除扱い
    const cleaned = {};
    for (const [k, v] of Object.entries(overrides || {})) {
      const t = String(v || '').trim();
      if (t) cleaned[k] = t;
    }
    mod.lineupOverrides = cleaned;
    fs.writeFileSync(mp, JSON.stringify(modulesData, null, 2));
    res.json({ ok: true, overrides: cleaned });
  } catch (e) {
    console.error('[v2/matchcard-lineup-overrides]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /v2/ai-fill-slide : スライド丸ごと AI 1発（type/title/dataSlots/narration）─
// Input:  { postId, moduleIdx, userPrompt, incremental?, useWebResearch?, researchPrompt? }
//   incremental=true: 既存内容を最大限保持し、ユーザー注文の差分のみ適用（微調整モード）
//   useWebResearch=true: ウェブリサーチ → 検索結果をプロンプト文脈に注入してから生成
//   researchPrompt: リサーチの観点（省略時は userPrompt を流用）
// Output: { ok, jobId } 即返却 → クライアントが /v2/ai-fill-slide-status?jobId= をポーリング
async function _runAiFillSlide({ postId, moduleIdx, userPrompt, incremental, useWebResearch, researchPrompt, sprint }) {
  // ⚡SPRINT モード: AI 呼び出しを全て DeepSeek に強制（生成 + 監修）
  const _sprint = !!sprint;
  const _aiProv = _sprint ? 'deepseek' : 'anthropic';
  const _aiModel = _sprint ? 'deepseek-v4-flash' : 'claude-sonnet-4-6';
    const mp = modulesPath(postId);
    // 2026-05-17: _runAiFillSlide は async ジョブ関数で res を持たない → throw に変更
    if (!fs.existsSync(mp)) throw new Error('modules not found');
    const modulesData = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const idx = parseInt(moduleIdx, 10);
    const mod = modulesData.modules?.[idx];
    if (!mod) throw new Error('idx out of range');

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

      // 🆕 監督の場合 Transfermarkt + Wikipedia 戦績テーブルもブロック化（2026-05-08）
      //   TM /stationen/plus/1 が主ソース：W/D/L + 推定GF/GA + Days + Players 全部入り
      //   Wikipedia は補助（Win% 検証用 / TM が取れない場合のフォールバック）
      let tmStr = '', wstatsStr = '';
      if (it.role === 'manager' && it.tm?.ok) {
        const c = (it.tm.coachClubs || []).map(c => {
          const period = `${c.fromDate || c.fromSeason || '?'} 〜 ${c.toExpected ? '現在' : (c.toDate || c.toSeason || '?')}`;
          const m   = c.matches != null ? `${c.matches}試合` : '-';
          const wdl = c.w != null ? ` ${c.w}勝${c.d}分${c.l}敗` : '';
          const gfga = (c.gf != null && c.ga != null) ? ` 得${c.gf}失${c.ga}(平均${c.avgGoalsFor}:${c.avgGoalsAgainst})` : '';
          const days = c.daysInCharge ? ` ${c.daysInCharge}日` : '';
          const players = c.playersUsed ? ` 起用${c.playersUsed}人` : '';
          const ppm = c.ppm != null ? ` PPM${c.ppm}` : '';
          return `${period}: ${c.club} (${c.role || '監督'}) ${m}${wdl}${gfga}${days}${players}${ppm}`;
        }).join('\n');
        const cs = (it.tm.currentSeasonByCompetition || []).map(s =>
          `  ${s.competition}: ${s.matches}試合 ${s.w}勝${s.d}分${s.l}敗 PPM ${s.ppm}`
        ).join('\n');
        const tot = it.tm.currentSeasonTotal
          ? `  Total: ${it.tm.currentSeasonTotal.matches}試合 ${it.tm.currentSeasonTotal.w}勝${it.tm.currentSeasonTotal.d}分${it.tm.currentSeasonTotal.l}敗 PPM ${it.tm.currentSeasonTotal.ppm}`
          : '';
        const tro = (it.tm.trophies || []).slice(0, 12).map(t => {
          const ss = (t.seasons || []).map(s => `${s.season} (${s.club})`).join(', ');
          return `${t.title} x${t.count}: ${ss}`;
        }).join('\n');
        tmStr = `
[Transfermarkt 監督経歴 (クラブ別通算 + 推定GF/GA + 在任日数)]
${c || '(なし)'}
${cs ? '\n[今季大会別 W/D/L]\n' + cs + (tot ? '\n' + tot : '') : ''}
${tro ? '\n[獲得タイトル]\n' + tro : ''}`;
      }
      if (it.role === 'manager' && it.wikiMgrStats?.ok) {
        const rows = (it.wikiMgrStats.rows || []).map(r =>
          `  ${r.team}: ${r.from} 〜 ${r.to} | ${r.p}試合 ${r.w}勝${r.d}分${r.l}敗 (Win% ${r.winPct})`
        ).join('\n');
        const tot = it.wikiMgrStats.total
          ? `\n  通算: ${it.wikiMgrStats.total.p}試合 ${it.wikiMgrStats.total.w}勝${it.wikiMgrStats.total.d}分${it.wikiMgrStats.total.l}敗 (Win% ${it.wikiMgrStats.total.winPct})`
          : '';
        wstatsStr = `
[Wikipedia 監督戦績 (補助 / Win% 検証)]
${rows}${tot}`;
      }

      // 🆕 チームのみ: 残り試合 + 今季消化済（2026-05-10 追加）
      //   「残り3試合の対戦相手 + その対戦相手との前半成績」のような構成に必須
      let scheduleStr = '';
      if (it.role === 'team' && it.sofa?.ok) {
        const upcoming = (it.sofa.upcomingFixtures || []).slice(0, 6);
        const finished = it.sofa.currentSeasonMatches || [];
        if (upcoming.length || finished.length) {
          const upRows = upcoming.map(u => {
            const haOrA = u.isHome ? '(H)' : '(A)';
            const dt    = u.date || '?';
            // 同シーズン内で同じ相手との対戦結果（前半戦）を検索
            const prev = finished.find(m => m.opponent === u.opponent);
            const prevStr = prev
              ? ` ← 前半戦 ${prev.score}${prev.isHome ? '(H)' : '(A)'} (${prev.result})`
              : ' ← 前半戦データなし';
            return `  ${dt} vs ${u.opponent}${haOrA}${prevStr}`;
          }).join('\n');
          const recentRows = finished.slice(-10).reverse().map(m =>
            `  ${m.date} vs ${m.opponent}${m.isHome ? '(H)' : '(A)'} ${m.score} (${m.result})`
          ).join('\n');
          scheduleStr = `
[今季 ${it.sofa.leagueName || ''} 残り試合 (${upcoming.length}) + 前半戦の対戦結果照合]
${upRows || '  (なし)'}

[今季 ${it.sofa.leagueName || ''} 直近の消化済 (新しい順 / 最大10件)]
${recentRows || '  (なし)'}`;
        }
      }

      // 🆕 チームのみ: Wikipedia 歴代シーズン順位（2026-05-10 追加）
      //   直近 N シーズンの順位推移は history / comparison スライドの根拠データ
      let wikiSeasonsStr = '';
      if (it.role === 'team' && it.wikiSeasons?.ok) {
        const rows = (it.wikiSeasons.seasons || []).map(s => {
          const pos = s.position != null ? `${s.position}位` : '?位';
          const lg = s.league || '?';
          const pts = s.points != null ? `勝点${s.points}` : '';
          const wdl = (s.wins != null && s.draws != null && s.losses != null)
            ? `${s.wins}勝${s.draws}分${s.losses}敗` : '';
          const gf = (s.goalsFor != null && s.goalsAgainst != null)
            ? `(得${s.goalsFor}失${s.goalsAgainst})` : '';
          const played = s.played != null ? `${s.played}試合` : '';
          return `  ${s.season} ${lg}: ${pos} / ${[played, wdl, pts, gf].filter(Boolean).join(' ')}`;
        }).join('\n');
        wikiSeasonsStr = `
[Wikipedia 歴代シーズン順位 (直近${it.wikiSeasons.count}シーズン・新しい順)]
${rows}`;
      }

      // 🆕 選手限定: Transfermarkt 試合単位データ（直近3シーズン × 大会別 + 直近シーズン監督別 + 直近 N 試合生データ）
      let tmGamesStr = '';
      if (it.role === 'player' && it.tmGames?.ok) {
        const career = it.tmGames.career;
        const recent = (it.tmGames.recentByCompetition || []).slice(0, 10).map(r =>
          `  ${r.season}/${r.competition}: ${r.appearances}試合 ${r.goals}G ${r.assists}A (${r.minutes}分) | チーム ${r.teamRecord?.w}W${r.teamRecord?.d}D${r.teamRecord?.l}L`
        ).join('\n');
        const byCoach = (it.tmGames.byCoachLatest || []).slice(0, 3).map(c =>
          `  coach ${c.coachId}: ${c.appearances}試合 ${c.goals}G ${c.assists}A | チーム ${c.teamRecord?.w}W${c.teamRecord?.d}D${c.teamRecord?.l}L`
        ).join('\n');
        // 🆕 直近 25 試合の生データ（日付・大会・対戦相手・スコア・G/A・出場分）
        //    history / insight / stats スライドで個別試合を引用できる
        const games = (it.tmGames.recentGames || []).slice(0, 25).map(g => {
          const ga = (g.G || 0) + 'G' + (g.A || 0) + 'A';
          const vs = g.venue === 'home' ? 'vs' : '@';
          return `  ${g.date} ${g.season}/${g.competition}${g.gameDay ? ' day'+g.gameDay : ''} | ${vs} ${g.opponent || 'club#'+g.opponentClubId} ${g.score} | ${ga} ${g.minutes||0}分${g.isCaptain ? ' [C]' : ''}`;
        }).join('\n');
        // 🆕 代表通算（isNationalGame でフィルタ済 / 初選出日・大会別ブレイクダウン付き）
        const natl = it.tmGames.national;
        // 🆕 Wikipedia infobox の A代表正解値（FIFA公式準拠 / U-XX/Olympic を除外したシニア代表）
        const wikiNatlAll = it.wikiNational || [];
        const wikiNatlSenior = wikiNatlAll.find(n => n.team && !/U\s?\d+|Olympic|Youth/i.test(n.team)) || wikiNatlAll.slice(-1)[0] || null;
        // 🆕 怪我履歴（進行中 + 直近5件）
        const injAll = Array.isArray(it.tmGames.injuries) ? it.tmGames.injuries : [];
        const injOngoing = injAll.filter(i => i.isOngoing);
        const injRecent5 = [...injAll].sort((a, b) => (b.fromDate || '').localeCompare(a.fromDate || '')).slice(0, 5);
        const _fmtInj = i => `${i.injury || '?'} ${i.fromDate || '?'}〜${i.untilDate || '?'} (${i.days || '?'}日 / ${i.missedGames || '?'}試合欠場)`;
        const injBlock = injAll.length ? `

[怪我履歴 (Transfermarkt DB)]
${injOngoing.length ? '★進行中: ' + injOngoing.map(_fmtInj).join(' / ') : '進行中: なし'}
直近5件:
${injRecent5.map(i => '  - ' + _fmtInj(i)).join('\n')}
通算: ${injAll.length}件` : '';
        const wikiNatlBlock = wikiNatlSenior ? `

[A代表 (Wikipedia / FIFA公式準拠 ★優先使用)]
${wikiNatlSenior.team}: ${wikiNatlSenior.caps ?? '?'}試合 ${wikiNatlSenior.goals ?? '?'}G | デビュー ${wikiNatlSenior.years?.start || '?'}年〜` : '';
        const natlBlock = (natl && natl.caps > 0) ? `

[Transfermarkt 全国際試合 (参考・ユース代表含む)]
通算: ${natl.caps}試合 ${natl.goals}G ${natl.assists}A (${natl.minutes}分) | 初試合 ${natl.firstCapDate} | 最終 ${natl.lastCapDate}
大会別: ${(natl.byCompetition || []).slice(0, 6).map(c => `${c.competition} ${c.caps}試合(${c.goals}G${c.assists}A)`).join(' / ') || '(なし)'}` : '';

        tmGamesStr = `
[Transfermarkt 試合単位の選手成績]
通算 (全試合): ${career?.appearances}試合 ${career?.goals}G ${career?.assists}A (${career?.minutes}分)
${wikiNatlBlock}${natlBlock}${injBlock}

[直近3シーズン × 大会別]
${recent || '(なし)'}

[直近シーズン 監督別 (top3 / coachId は Transfermarkt の監督ID)]
${byCoach || '(なし)'}

[直近 25 試合 (日付降順 / 個別試合のスコア+対戦相手+G/A)]
${games || '(なし)'}`;
      }

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
${tmStr}${wstatsStr}${scheduleStr || ''}${wikiSeasonsStr || ''}${tmGamesStr}
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

    // 🆕 ウェブリサーチ（2026-05-07）
    //   useWebResearch=true なら、AIに 1〜3個の検索クエリを生成させ、Serper で並列検索 →
    //   結果を文脈ブロックとしてプロンプトに注入する。Chelsea迷走の真相 のような外部情報が
    //   必須な案件で、足りないデータを補う目的。
    let webResearchBlock = '';
    if (useWebResearch) {
      const researchSeed = (researchPrompt && researchPrompt.trim()) || userPrompt;
      try {
        const queryGenPrompt = `次のサッカー動画スライド向け指示について、ウェブ検索で深堀するための英語クエリを最大3つ提案してください。
事実関係・歴史的経緯・経済的背景・人物の動機など、内部データ（Wikipedia/SofaScore）に無い情報を埋めるクエリ。
JSONのみで {"queries":["q1","q2","q3"]} 形式（マークダウン不要）。

【動画タイトル】${(safeJson(path.join(DATA_DIR,'saved_projects.json'),[]).find(p=>p.id===postId)?.title) || '(不明)'}
【スライド主題】${primary || '(なし)'} ${secondary ? '/ '+secondary : ''}
【ユーザー指示】${researchSeed}`;
        const qRaw = await callAI({
          forceProvider: 'deepseek',
          model: 'deepseek-v4-flash',
          max_tokens: 400,
          messages: [{ role: 'user', content: queryGenPrompt }],
        });
        const qm = qRaw && qRaw.match(/\{[\s\S]*\}/);
        const queries = qm ? (JSON.parse(qm[0]).queries || []).slice(0, 3) : [];
        if (queries.length) {
          const { fetchSerper } = require('../scripts/modules/fetchers/serper_module');
          const results = await Promise.all(queries.map(q =>
            fetchSerper(q, 'webresearch', 'en').catch(e => ({ ok: false, error: e.message }))
          ));
          const blocks = results.map((r, i) => {
            if (!r.ok || !r.organic?.length) return null;
            const top = r.organic.slice(0, 5).map(o =>
              `- [${(o.title||'').slice(0,80)}] ${(o.snippet||'').slice(0,250)}`
            ).join('\n');
            return `【検索クエリ${i+1}: "${queries[i]}"】\n${top}`;
          }).filter(Boolean).join('\n\n');
          if (blocks) {
            webResearchBlock = `\n━━━ 🌐 ウェブリサーチ結果 ━━━\n${blocks}\n━━━━━━━━━━━━━━━━\n`;
            console.log(`[ai-fill-slide] webリサーチ ${queries.length}クエリ → ${results.filter(r=>r.ok).length}成功`);
          } else {
            console.warn('[ai-fill-slide] webリサーチ: 全クエリで結果なし');
          }
        } else {
          console.warn('[ai-fill-slide] webリサーチ: クエリ生成失敗');
        }
      } catch (e) {
        console.warn('[ai-fill-slide] webリサーチ例外（スキップして続行）:', e.message);
      }
    }

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
${webResearchBlock}${recipesSection}

【ユーザー注文】
${userPrompt}
${incrementalRule}
【生成ルール（厳守）】
- type は注文の意図に合わせて選ぶ（許容: insight/stats/profile/comparison/history/ranking/timeline/reaction）
  ・2人/2チーム比較なら "comparison"
  ・時系列の来歴・年表なら "history"
  ・順位/ランキングなら "ranking" （得点王・順位表・MVP候補など複数主体を順序付けて表示）
  ・推移を折れ線で見せたい → "timeline" （市場価値推移・順位推移・得点数推移）
  ・数字データ並べる → "stats"
  ・基本情報カード → "profile"
  ・コメント反応 → "reaction"
  ・観点抽出 → "insight"
- dataSlots shape は type に応じて：
  ・comparison: [{"label":"指標","leftValue":"primaryの値","rightValue":"secondaryの値"}]
    ⚠️ **監督の comparison では、必ず両者の現所属クラブでの成績を使用すること**。
       例: Pep Guardiola (Manchester City) vs Mikel Arteta (Arsenal) の場合、
       各 entity の Transfermarkt coachClubs から該当クラブのエントリ
       （Pep → Manchester City エントリ / Arteta → Arsenal エントリ）を抽出。
       「監督通算」のような全期間データは使わない（Pep のバルサ・バイエルン期は混入禁止）。
       通算成績は「監督歴 N 年」のような career length 系の文脈でのみ使用OK。
       Wikipedia 監督戦績テーブルにもクラブ別行があれば併用可。
  ・history:    [{"label":"年(YYYY)","value":"出来事"}]
  ・stats/profile: [{"label":"項目","value":"値"}]
  ・insight: dataSlots は空配列、代わりに catchphrases を別途返してOK（今回は dataSlots 中心で）
  ・ranking: dataSlots は空配列、代わりに **items** を返す
       items: [{"rank":1,"name":"選手/チーム名","value":"27 ゴール","subtext":"所属クラブなど"}]
       1〜5件、rank 昇順、value は数字+単位を含むコンパクト表現
  ・timeline: dataSlots は空配列、代わりに **series** を返す
       series: [{"name":"系列名","points":[{"x":"21/22","y":80},{"x":"22/23","y":120}...]}]
       1〜4系列、各系列の points は同じ x ラベル群を使う（揃ってる方が見やすい）
       y は数値。順位推移の場合は別途 "invertY": true を mod 直下に付ける
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

    // 既定: Sonnet（脚本品質優先） → JSON崩れ時 v4flash 保険
    // ⚡SPRINT モード: 最初から DeepSeek 直行（fallback なし）
    let raw, parsed = null, used = _sprint ? 'v4flash-sprint' : 'sonnet';
    // ⑧ 2026-05-18: SPRINT 効果検証用に AI 選択をログ明示（af_*.json.result.used とセット）
    console.log(`[ai-fill-slide] AI=${used} (provider=${_aiProv}, model=${_aiModel}) で生成開始 / SPRINT=${_sprint ? 'ON' : 'OFF'}`);
    // type 別に必要な payload キー: dataSlots / items / series のいずれか
    const _hasPayload = (p) => {
      if (!p?.type) return false;
      if (p.type === 'ranking')  return Array.isArray(p.items)  && p.items.length > 0;
      if (p.type === 'timeline') return Array.isArray(p.series) && p.series.length > 0;
      return Array.isArray(p.dataSlots);
    };
    try {
      raw = await callAI({
        forceProvider: _aiProv,
        model: _aiModel, max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
      });
      const m1 = raw && raw.match(/\{[\s\S]*\}/);
      if (m1) parsed = JSON.parse(m1[0]);
    } catch (e) { console.warn(`[ai-fill-slide] ${_aiProv} 例外:`, e.message); }
    if (!_hasPayload(parsed) && !_sprint) {
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
    if (!_hasPayload(parsed)) {
      throw new Error('AI応答のパースに失敗: ' + (raw || '').slice(0, 200));
    }
    console.log(`[ai-fill-slide] Pass1 完了: AI=${used} / type=${parsed.type}`);

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
        forceProvider: _aiProv,
        model: _aiModel, max_tokens: 4000,
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
    const ALLOWED_TYPES = ['insight','stats','profile','comparison','history','reaction','matchcard','ranking','timeline'];
    if (ALLOWED_TYPES.includes(parsed.type)) mod.type = parsed.type;
    if (typeof parsed.title === 'string')     mod.title = parsed.title;
    if (typeof parsed.narration === 'string') mod.narration = parsed.narration;
    if (mod.type === 'matchcard') {
      mod.dataSlots = [];
    } else if (mod.type === 'ranking') {
      mod.items = Array.isArray(parsed.items) ? parsed.items : [];
      mod.dataSlots = [];  // ranking は items を使うので空
    } else if (mod.type === 'timeline') {
      mod.series = Array.isArray(parsed.series) ? parsed.series : [];
      if (parsed.invertY != null) mod.invertY = !!parsed.invertY;
      if (parsed.xLabel)  mod.xLabel  = String(parsed.xLabel);
      if (parsed.yLabel)  mod.yLabel  = String(parsed.yLabel);
      mod.dataSlots = [];  // timeline は series を使うので空
    } else {
      mod.dataSlots = parsed.dataSlots;
    }

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

    return {
      ok:        true,
      type:      mod.type,
      title:     mod.title,
      dataSlots: mod.dataSlots,
      narration: mod.narration,
      used,
      reviewed:    reviewUsed,
      reviewIssues,
    };
}

// 🆕 /v2/ai-fill-slide: ジョブ作成 → jobId 即返却
//   body: { postId, moduleIdx, userPrompt, incremental?, useWebResearch?, researchPrompt? }
router.post('/v2/ai-fill-slide', express.json(), (req, res) => {
  const { postId, moduleIdx, userPrompt } = req.body || {};
  if (!postId || moduleIdx == null || !userPrompt) {
    return res.status(400).json({ error: 'postId + moduleIdx + userPrompt required' });
  }
  const { createJob, readJob, updateJob } = require('./_job_helper');
  const jobId = createJob('af', { postId, moduleIdx, kind: 'ai-fill-slide' });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      const stepMsg = req.body.useWebResearch ? 'web-research+ai-generation' : 'ai-generation';
      updateJob(jobId, { status: 'running', step: stepMsg });
      const result = await _runAiFillSlide(req.body);
      updateJob(jobId, { status: 'done', result });
    } catch (e) {
      console.error(`[v2/ai-fill-slide:${jobId}]`, e);
      updateJob(jobId, { status: 'error', error: e.message });
    }
  });
});

// 🆕 /v2/ai-fill-slide-status: ジョブ状態取得
router.get('/v2/ai-fill-slide-status', (req, res) => {
  const { readJob } = require('./_job_helper');
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
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

// ─── /v2/tts-presets : provider 別 voice + model 候補リスト + デフォルト ──
//   ?provider=gemini|minimax で切替（省略時は環境変数の DEFAULT_PROVIDER）
router.get('/v2/tts-presets', (req, res) => {
  try {
    const tts = require('../scripts/v2_video/tts_engine');
    const provider = req.query.provider || tts.DEFAULT_PROVIDER;
    const d = tts.getDefaults(provider);
    res.json({
      provider: d.provider,
      providers: tts.PRESET_PROVIDERS,
      voices: d.presetVoices,
      models: d.presetModels,
      defaultVoice: d.voice,
      defaultModel: d.model,
      emotions: d.emotions || ['(なし)'],
      styleInstructions: d.styleInstructions || '',
      supports: d.supports,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /v2/tts-preview : 試聴用 (保存しない、base64 mp3 を返す) ──
//   body に provider を含めれば gemini/minimax を切替可能
router.post('/v2/tts-preview', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    const tts = require('../scripts/v2_video/tts_engine');
    const { provider, text, voiceId, model, styleInstructions, emotion, speed, vol, pitch } = req.body || {};
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });

    const tmpFile = path.join(AUDIO_DIR, `_preview_${Date.now()}_${Math.random().toString(36).slice(2,6)}.mp3`);
    await tts.generate({
      provider,
      text: String(text).slice(0, 800),  // 試聴は800字までに制限
      outputPath: tmpFile,
      voiceId, model, styleInstructions, emotion, speed, vol, pitch,
    });
    const buf = fs.readFileSync(tmpFile);
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    res.json({ ok: true, mime: 'audio/mpeg', base64: buf.toString('base64') });
  } catch (e) {
    console.warn('[tts-preview]', e.message);
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

// ─── /v2/sample-slide?type=X : サンプルデータでスライド単体プレビュー ─
//   _sample_modules.js のサンプル定義から指定 type の HTML を返す
router.get('/v2/sample-slide', (req, res) => {
  try {
    const { getSample, listTypes } = require('../scripts/v2_video/_sample_modules');
    const type = String(req.query.type || 'opening');
    const mod = getSample(type);
    if (!mod) return res.status(404).send('<!doctype html><title>err</title><body>unknown type: ' + type + '<br>available: ' + listTypes().join(', ') + '</body>');
    res.set('Content-Type', 'text/html; charset=utf-8').send(_buildSlideForPreview(mod));
  } catch (e) { res.status(500).send('<!doctype html><title>err</title><body>' + e.message + '</body>'); }
});

// ─── /v2/sample-gallery : サンプル一覧 + iframe プレビュー ──
router.get('/v2/sample-gallery', (req, res) => {
  const { listTypes, SAMPLES } = require('../scripts/v2_video/_sample_modules');
  const types = listTypes();
  // 各 type のチャンクメタを script に埋め込む（音声タイミング再現用）
  const chunkMap = {};
  for (const [t, m] of Object.entries(SAMPLES)) {
    chunkMap[t] = (m.audio || []).map(c => ({
      idx: c.chunkIdx,
      durationSec: c.durationSec,
      text: c.text,
    }));
  }
  const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>スライドサンプル ギャラリー</title>
<style>
  body { margin:0; background:#0f1117; color:#e0e0e0; font-family:sans-serif; }
  header { padding:14px 20px; background:#1a1a26; border-bottom:3px solid #ff3b3b; display:flex; align-items:center; gap:14px; flex-wrap:wrap; position:sticky; top:0; z-index:10; }
  h1 { color:#ff3b3b; font-size:18px; margin:0; }
  .types { display:flex; gap:6px; flex-wrap:wrap; }
  .type-btn { padding:6px 12px; background:#2a2a35; color:#fff; border:1px solid #3d3d4d; border-radius:6px; cursor:pointer; font-size:12px; }
  .type-btn.active { background:#ff3b3b; border-color:#ff3b3b; color:#fff; font-weight:bold; }
  .type-btn:hover:not(.active) { background:#3a3a45; }
  main { padding:20px; }
  .info { font-size:12px; color:#94a3b8; margin-bottom:10px; text-align:center; }
  /* 1920x1080 を等比縮小して表示。outer の width で自動 fit */
  .frame-outer { background:#000; border:2px solid #2a2a35; border-radius:8px; overflow:hidden; max-width:1280px; margin:0 auto; position:relative; }
  .frame-inner { width:1920px; height:1080px; transform-origin: top left; position:relative; }
  iframe { display:block; width:1920px; height:1080px; border:0; background:#000; }
  .controls { display:flex; gap:8px; align-items:center; margin-left:auto; }
  .ctrl-btn { padding:6px 14px; background:#3b82f6; color:#fff; border:0; border-radius:6px; cursor:pointer; font-size:12px; }
  .ctrl-btn:hover { background:#2563eb; }
  .scale-ctrl { display:flex; align-items:center; gap:6px; font-size:11px; color:#94a3b8; }
  .audio-ctrl { display:flex; align-items:center; gap:8px; font-size:11px; color:#94a3b8; }
  .audio-ctrl input[type=range] { width:100px; }
  .now-playing { font-size:10px; color:#10b981; margin-left:8px; }
</style></head><body>
<header>
  <h1>🎬 スライドサンプル</h1>
  <div class="types" id="typeBtns"></div>
  <div class="controls">
    <div class="audio-ctrl">
      <label><input type="checkbox" id="bgmOn" checked> BGM</label>
      <span>音量</span><input type="range" id="vol" min="0" max="100" value="80">
      <span id="nowPlaying" class="now-playing"></span>
    </div>
    <div class="scale-ctrl">表示倍率: <span id="scaleVal">--</span></div>
    <button class="ctrl-btn" id="reloadBtn">🔄 再読込（音声同期）</button>
  </div>
</header>
<main>
  <div class="info" id="info">1920x1080 → ブラウザ幅に合わせて等比縮小。<strong>動画レンダ時もこのHTMLそのもの</strong>を Puppeteer で1920x1080 で撮影するから、見た目=完成動画の見た目。</div>
  <div class="frame-outer" id="frameOuter">
    <div class="frame-inner" id="frameInner">
      <iframe id="frame" src="about:blank"></iframe>
    </div>
  </div>
</main>
<audio id="bgm" src="/bgm.mp3" loop></audio>
<audio id="ttsAudio"></audio>
<script>
const TYPES = ${JSON.stringify(types)};
const CHUNK_MAP = ${JSON.stringify(chunkMap)};
const LEAD_PAD_SEC = 1.5;

let currentType = TYPES[0];
const frame = document.getElementById('frame');
const frameInner = document.getElementById('frameInner');
const frameOuter = document.getElementById('frameOuter');
const info = document.getElementById('info');
const typeBtns = document.getElementById('typeBtns');
const scaleVal = document.getElementById('scaleVal');
const bgm = document.getElementById('bgm');
const ttsAudio = document.getElementById('ttsAudio');
const bgmOn = document.getElementById('bgmOn');
const volSlider = document.getElementById('vol');
const nowPlaying = document.getElementById('nowPlaying');

bgm.volume = 0.18;  // BGM は控えめ
function applyVol() {
  const v = volSlider.value / 100;
  ttsAudio.volume = v;
  bgm.volume = bgmOn.checked ? Math.min(0.22, v * 0.25) : 0;
}
volSlider.oninput = applyVol;
bgmOn.onchange = applyVol;

let ttsTimers = [];
function clearTtsTimers() {
  ttsTimers.forEach(t => clearTimeout(t));
  ttsTimers = [];
  ttsAudio.pause();
  ttsAudio.src = '';
}

function fitFrame() {
  const w = frameOuter.clientWidth;
  const scale = w / 1920;
  frameInner.style.transform = 'scale(' + scale + ')';
  frameOuter.style.height = (1080 * scale) + 'px';
  scaleVal.textContent = (scale * 100).toFixed(0) + '%';
}

function playSamplePlaylist(type) {
  clearTtsTimers();
  const chunks = CHUNK_MAP[type] || [];
  if (!chunks.length) {
    nowPlaying.textContent = '(音声なし)';
    return;
  }
  // BGM 再生開始
  if (bgmOn.checked) {
    bgm.currentTime = 0;
    bgm.play().catch(() => {});
  } else {
    bgm.pause();
  }
  // 各チャンク順次再生（LEAD_PAD_SEC + 累積 durationSec オフセット）
  let cum = LEAD_PAD_SEC;
  chunks.forEach((c, i) => {
    const offsetMs = Math.round(cum * 1000);
    const t = setTimeout(() => {
      ttsAudio.src = '/images_stock/_sample_audio/' + type + '_c' + String(c.idx).padStart(2, '0') + '.mp3';
      ttsAudio.play().catch(err => {
        nowPlaying.textContent = '⚠️ chunk' + i + ' 音声なし（生成中の可能性）';
      });
      nowPlaying.textContent = '🔊 ch' + (i+1) + '/' + chunks.length + ': ' + c.text.slice(0, 28) + '...';
    }, offsetMs);
    ttsTimers.push(t);
    cum += c.durationSec;
  });
  // 終了処理
  const endMs = Math.round((cum + 0.5) * 1000);
  const endT = setTimeout(() => {
    nowPlaying.textContent = '✓ 再生終了';
  }, endMs);
  ttsTimers.push(endT);
}

function load(type) {
  currentType = type;
  document.querySelectorAll('.type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });
  // iframe リロードで CSS アニメーション最初から
  frame.src = '/api/v2/sample-slide?type=' + encodeURIComponent(type) + '&_t=' + Date.now();
  info.innerHTML = '表示中: <strong>' + type + '</strong> | 1920x1080 を ' + scaleVal.textContent + ' に縮小表示中（動画レンダ時の見た目と同じ）';
  // 音声 + BGM 再生
  applyVol();
  playSamplePlaylist(type);
}

TYPES.forEach(t => {
  const b = document.createElement('button');
  b.className = 'type-btn';
  b.textContent = t;
  b.dataset.type = t;
  b.onclick = () => load(t);
  typeBtns.appendChild(b);
});

document.getElementById('reloadBtn').onclick = () => load(currentType);

window.addEventListener('resize', fitFrame);
window.addEventListener('beforeunload', clearTtsTimers);
fitFrame();
// 初期表示は音声無し（ユーザーがクリックするまで autoplay block 回避）
currentType = TYPES[0];
document.querySelectorAll('.type-btn').forEach(b => {
  b.classList.toggle('active', b.dataset.type === currentType);
});
frame.src = '/api/v2/sample-slide?type=' + encodeURIComponent(currentType);
info.innerHTML = 'タイプボタンをクリックすると音声+BGM 同期再生します';
</script>
</body></html>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
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
      <!-- 2026-05-16: SPRINT トグルは step2 に移動（相棒指示） -->
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

  // ⚡SPRINT モード初期化: step2 に移動済み (2026-05-16)
  //   localStorage の v2_sprint_mode は引き続き参照する（fetch 時の sprint: localStorage.getItem... で利用）
  try { window.appSprint = localStorage.getItem('v2_sprint_mode') === '1'; } catch (_) {}

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
    /* TTS preset: provider 別キャッシュ。最初は環境変数で決まったデフォルト provider を取得 */
    if (!window.APP.s4.ttsPresetsByProvider) window.APP.s4.ttsPresetsByProvider = {};
    if (!window.APP.s4.ttsPresets) {
      try {
        const p = await fetchJson('/api/v2/tts-presets');
        window.APP.s4.ttsPresets = p;
        if (p.provider) window.APP.s4.ttsPresetsByProvider[p.provider] = p;
      } catch (_) {
        window.APP.s4.ttsPresets = { provider: 'gemini', voices: [], models: [], emotions: ['(なし)'], providers: [], supports: {} };
      }
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
        + ' onclick="s4Switch(' + i + ')" style="position:relative;padding-right:14px;">'
        + '<span style="font-size:9px;opacity:.8">' + (i+1) + '/' + mods.length + '</span><br>'
        + '<span style="font-size:10px;">' + _esc((m.title || '').slice(0,10)) + '</span>'
        + '<button onclick="event.stopPropagation();s4DeleteSlide(' + i + ')" '
        + 'title="このスライドを削除（modules.json から永久削除）" '
        + 'style="position:absolute;top:1px;right:2px;background:transparent;'
        + 'border:0;color:#ff4d4d;cursor:pointer;font-size:12px;line-height:1;'
        + 'padding:1px 4px;opacity:.55;font-weight:bold;" '
        + 'onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.55">✕</button>'
        + '</div>';
    }).join('');
  }

  /* ── スライド丸ごと削除 ───────────────────────── */
  window.s4DeleteSlide = async function(idx) {
    const mods = window.APP.s4.modules || [];
    if (!mods.length) return;
    const m = mods[idx];
    if (!m) return;
    const title = m.title || m.type || ('スライド ' + (idx + 1));
    if (!confirm('スライド「' + title + '」(#' + (idx+1) + ') を削除する？\\n\\n' +
                 '・modules.json から永久削除される\\n' +
                 '・取り消し不可\\n' +
                 '・必要なら Step3 で再生成すれば復活可能')) return;
    mods.splice(idx, 1);
    // activeTab 調整: 削除位置以降にいたなら 1 つ前にずらす、配列末尾を超えたら末尾に
    if (window.APP.s4.activeTab > idx) window.APP.s4.activeTab--;
    if (window.APP.s4.activeTab >= mods.length) window.APP.s4.activeTab = Math.max(0, mods.length - 1);
    await _saveModulesQuiet();
    _renderTabs();
    _renderEditor();
    _msg('🗑 削除完了 (残り ' + mods.length + ' 枚)');
  };

  /* ── TTS パネル HTML 構築 ── */
  function _buildTtsPanelHtml(m, i) {
    const presets  = window.APP.s4.ttsPresets || { provider: 'gemini', voices: [], models: [], emotions: ['(なし)'], providers: [], supports: {} };
    const tts      = m.tts || {};
    const curProvider = tts.provider || presets.provider || 'gemini';
    const isGemini = curProvider === 'gemini';
    const supports = presets.supports || {};
    const curVoice   = tts.voiceId  || presets.defaultVoice || (presets.voices[0]?.id || '');
    const curModel   = tts.model    || presets.defaultModel || (presets.models[0]?.id || '');
    const curSpeed   = (tts.speed   != null) ? tts.speed   : 1.0;
    const curEmotion = tts.emotion  || '';
    const curStyle   = tts.styleInstructions != null ? tts.styleInstructions : (presets.styleInstructions || '');

    const providers = presets.providers || [{ id: 'gemini', label: 'Gemini' }, { id: 'minimax', label: 'MiniMax' }];
    const providerOpts = providers.map(function(p) {
      return '<option value="' + _esc(p.id) + '"' + (p.id === curProvider ? ' selected' : '') + '>' + _esc(p.label) + '</option>';
    }).join('');
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

    // Gemini なら Style Instructions、MiniMax なら速度+感情 を表示（supports に基づく）
    const styleBlockHtml = supports.styleInstructions
      ? '<div style="margin-bottom:6px;">'
        + '<div style="font-size:10px;color:#94a3b8;margin-bottom:2px;display:flex;align-items:center;gap:6px;">'
        +   '<span>🎭 Style Instructions <span style="color:#5a6a8a;">(声のトーン・感情を自然言語指示。角括弧タグ [excited] [short pause] も使える)</span></span>'
        +   '<span style="flex:1"></span>'
        +   '<button class="btn btn-sm" onclick="s4TtsResetStyle()" title="採用済デフォルトに戻す" style="background:#1a2540;color:#94a3b8;font-size:9px;padding:1px 6px;">↺ デフォルト</button>'
        + '</div>'
        + '<textarea class="inp" id="s4TtsStyleInstructions" rows="3" style="font-size:10px;padding:4px 6px;width:100%;resize:vertical;">' + _esc(curStyle) + '</textarea>'
        + '</div>'
      : '';
    const minimaxBlockHtml = supports.emotion
      ? '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:10px;color:#94a3b8;">'
        +   '<label>速度 <input class="inp" type="number" id="s4TtsSpeed" min="0.5" max="2" step="0.05" value="' + curSpeed + '" style="width:60px;font-size:10px;padding:2px 4px;"></label>'
        +   '<label>感情 <select class="inp" id="s4TtsEmotion" style="font-size:10px;padding:2px 4px;">' + emotionOpts + '</select></label>'
        + '</div>'
      : '';

    return '<div style="margin-top:14px;padding:10px;background:#0d1220;border:1px solid #4c1d95;border-radius:6px;">'
      +   '<div style="font-size:12px;color:#a78bfa;font-weight:bold;margin-bottom:6px;display:flex;align-items:center;gap:6px;">'
      +     '🎙️ TTS'
      +     '<select class="inp" id="s4TtsProvider" onchange="s4TtsProviderChange(this.value)" style="font-size:10px;padding:2px 6px;background:#1a2540;color:#a78bfa;font-weight:bold;">' + providerOpts + '</select>'
      +     '<span style="flex:1"></span>'
      +     '<span class="s4-tts-status" data-idx="' + i + '" style="font-size:10px;color:#5a6a8a;font-weight:normal;"></span>'
      +   '</div>'
      +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">'
      +     '<select class="inp" id="s4TtsVoice" style="font-size:10px;padding:3px 6px;">' + voiceOpts + '</select>'
      +     '<select class="inp" id="s4TtsModel" style="font-size:10px;padding:3px 6px;">' + modelOpts + '</select>'
      +   '</div>'
      +   styleBlockHtml
      +   minimaxBlockHtml
      +   '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;font-size:10px;color:#94a3b8;">'
      +     '<span style="flex:1"></span>'
      +     '<button class="btn btn-sm" onclick="s4TtsPreview()" style="background:#1a2540;color:#a78bfa;font-size:10px;padding:4px 10px;">▶ 試聴</button>'
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

    // ── 各 type のスロット数上限（slide 側 cap と揃える）──
    const SLOT_MAX = { stats: 8, profile: 7, history: 8, comparison: 7, insight: 6 }[m.type] || 8;

    let dataHtml = '';
    // matchcard は matchData (試合データ) を表示するテンプレで dataSlots は使わない
    if (Array.isArray(m.dataSlots) && m.dataSlots.length && m.type !== 'matchcard') {
      const isCmp = m.type === 'comparison';
      // 2026-05-17: onclick 属性を直書き（addEventListener bind 失敗時の保険）
      const _addBtn = (m.dataSlots.length < SLOT_MAX)
        ? '<button class="s4-slot-add" onclick="s4AddSlot()" style="background:#1a3a1a;color:#6bff8b;border:1px solid #2a5a2a;border-radius:4px;cursor:pointer;font-size:12px;padding:5px 12px;margin-top:6px;">＋ 追加 (' + m.dataSlots.length + '/' + SLOT_MAX + ')</button>'
        : '<div style="font-size:10px;color:#666;margin-top:6px;">上限 (' + SLOT_MAX + '/' + SLOT_MAX + ')</div>';
      // 2026-05-17: 並び替えボタン (↑↓) を追加（相棒指示）
      const _mkOrderBtns = (idx, total) => {
        const upDis = idx === 0 ? ' disabled style="opacity:0.3;cursor:not-allowed;' : ' style="cursor:pointer;';
        const dnDis = idx === total - 1 ? ' disabled style="opacity:0.3;cursor:not-allowed;' : ' style="cursor:pointer;';
        return '<button class="s4-slot-up" data-idx="' + idx + '" title="上へ"' + upDis + 'background:#1a2a3a;color:#7dc8ff;border:1px solid #2a4a6a;border-radius:3px;font-size:11px;padding:0 4px;line-height:24px;height:24px;align-self:center;">↑</button>'
             + '<button class="s4-slot-down" data-idx="' + idx + '" title="下へ"' + dnDis + 'background:#1a2a3a;color:#7dc8ff;border:1px solid #2a4a6a;border-radius:3px;font-size:11px;padding:0 4px;line-height:24px;height:24px;align-self:center;">↓</button>';
      };
      const _total = m.dataSlots.length;
      dataHtml = '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">📊 dataSlots</div>'
        + m.dataSlots.map(function(s, idx) {
            const orderBtns = _mkOrderBtns(idx, _total);
            const delBtn = '<button class="s4-slot-del" data-idx="' + idx + '" title="この行を削除" '
              + 'style="background:#3a1a1a;color:#ff6b6b;border:1px solid #5a2a2a;border-radius:3px;cursor:pointer;font-size:13px;padding:0 6px;line-height:24px;height:24px;align-self:center;">×</button>';
            if (isCmp) {
              return '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 24px 24px 28px;gap:4px;margin-bottom:4px;">'
                + '<input class="inp s4-cmp-label" data-idx="' + idx + '" value="' + _esc(s.label||'') + '" placeholder="LABEL" style="font-size:11px;padding:4px 6px;">'
                + '<input class="inp s4-cmp-left" data-idx="' + idx + '" value="' + _esc(s.leftValue||'') + '" placeholder="左" style="font-size:11px;padding:4px 6px;color:#93c5fd;">'
                + '<input class="inp s4-cmp-right" data-idx="' + idx + '" value="' + _esc(s.rightValue||'') + '" placeholder="右" style="font-size:11px;padding:4px 6px;color:#fca5a5;">'
                + orderBtns
                + delBtn
                + '</div>';
            } else {
              return '<div style="display:grid;grid-template-columns:140px 1fr 24px 24px 28px;gap:4px;margin-bottom:4px;">'
                + '<input class="inp s4-slot-label" data-idx="' + idx + '" value="' + _esc(s.label||'') + '" placeholder="ラベル" style="font-size:11px;padding:4px 6px;">'
                + '<input class="inp s4-slot-value" data-idx="' + idx + '" value="' + _esc(s.value||'') + '" placeholder="値" style="font-size:11px;padding:4px 6px;">'
                + orderBtns
                + delBtn
                + '</div>';
            }
          }).join('') + _addBtn;
    }

    let extraHtml = '';
    if (Array.isArray(m.catchphrases) && m.catchphrases.length) {
      // 2026-05-17: onclick 属性直書き保険
      const _addPh = (m.catchphrases.length < SLOT_MAX)
        ? '<button class="s4-phrase-add" onclick="s4AddPhrase()" style="background:#1a3a1a;color:#6bff8b;border:1px solid #2a5a2a;border-radius:4px;cursor:pointer;font-size:12px;padding:5px 12px;margin-top:6px;">＋ 追加 (' + m.catchphrases.length + '/' + SLOT_MAX + ')</button>'
        : '<div style="font-size:10px;color:#666;margin-top:6px;">上限 (' + SLOT_MAX + '/' + SLOT_MAX + ')</div>';
      // 2026-05-17: catchphrases にも ↑↓ ボタン追加
      const _totalPh = m.catchphrases.length;
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🎯 catchphrases</div>'
        + m.catchphrases.map(function(p, idx) {
            const txt = (typeof p === 'string') ? p : (p && p.text) || '';
            const upDis = idx === 0 ? ' disabled style="opacity:0.3;cursor:not-allowed;' : ' style="cursor:pointer;';
            const dnDis = idx === _totalPh - 1 ? ' disabled style="opacity:0.3;cursor:not-allowed;' : ' style="cursor:pointer;';
            return '<div style="display:grid;grid-template-columns:1fr 24px 24px;gap:4px;margin-bottom:4px;">'
              + '<input class="inp s4-phrase" data-idx="' + idx + '" value="' + _esc(txt) + '" placeholder="キャッチコピー" style="font-size:11px;padding:4px 6px;">'
              + '<button class="s4-phrase-up" data-idx="' + idx + '" title="上へ"' + upDis + 'background:#1a2a3a;color:#7dc8ff;border:1px solid #2a4a6a;border-radius:3px;font-size:11px;padding:0 4px;line-height:24px;height:24px;">↑</button>'
              + '<button class="s4-phrase-down" data-idx="' + idx + '" title="下へ"' + dnDis + 'background:#1a2a3a;color:#7dc8ff;border:1px solid #2a4a6a;border-radius:3px;font-size:11px;padding:0 4px;line-height:24px;height:24px;">↓</button>'
              + '</div>';
          }).join('') + _addPh;
    }
    if (Array.isArray(m.comments) && m.comments.length) {
      // 2026-05-17: comments にも ↑↓ ボタン追加
      const _totalCmt = m.comments.length;
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">💬 comments</div>'
        + m.comments.map(function(c, idx) {
            const upDis = idx === 0 ? ' disabled style="opacity:0.3;cursor:not-allowed;' : ' style="cursor:pointer;';
            const dnDis = idx === _totalCmt - 1 ? ' disabled style="opacity:0.3;cursor:not-allowed;' : ' style="cursor:pointer;';
            return '<div style="display:grid;grid-template-columns:1fr 60px 24px 24px;gap:4px;margin-bottom:4px;">'
              + '<input class="inp s4-cmt-text" data-idx="' + idx + '" value="' + _esc(c.text||'') + '" style="font-size:11px;padding:4px 6px;">'
              + '<input type="number" class="inp s4-cmt-score" data-idx="' + idx + '" value="' + (c.score||0) + '" style="font-size:11px;padding:4px 6px;">'
              + '<button class="s4-cmt-up" data-idx="' + idx + '" title="上へ"' + upDis + 'background:#1a2a3a;color:#7dc8ff;border:1px solid #2a4a6a;border-radius:3px;font-size:11px;padding:0 4px;line-height:24px;height:24px;">↑</button>'
              + '<button class="s4-cmt-down" data-idx="' + idx + '" title="下へ"' + dnDis + 'background:#1a2a3a;color:#7dc8ff;border:1px solid #2a4a6a;border-radius:3px;font-size:11px;padding:0 4px;line-height:24px;height:24px;">↓</button>'
              + '</div>';
          }).join('');
    }
    // ── matchcard: lineup 編集（HOME / AWAY をアコーディオンで折りたたみ）──
    //   遅延ロード placeholder のみ出力。クリック展開時に /v2/matchcard-lineup を fetch
    if (m.type === 'matchcard') {
      extraHtml += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">⚽ ラインナップ手動編集 (カタカナ上書き)</div>'
        + '<details class="s4-mc-team" data-side="home" data-idx="' + i + '">'
        + '  <summary style="cursor:pointer;padding:8px 12px;background:#1a3a5a;color:#93c5fd;border-radius:5px;font-size:12px;font-weight:bold;margin-bottom:4px;">🔵 HOME (クリックで展開)</summary>'
        + '  <div class="s4-mc-body" data-side="home" style="padding:6px 0;font-size:11px;color:#888;">読み込み中...</div>'
        + '</details>'
        + '<details class="s4-mc-team" data-side="away" data-idx="' + i + '" style="margin-top:6px;">'
        + '  <summary style="cursor:pointer;padding:8px 12px;background:#5a1a3a;color:#fca5a5;border-radius:5px;font-size:12px;font-weight:bold;margin-bottom:4px;">🔴 AWAY (クリックで展開)</summary>'
        + '  <div class="s4-mc-body" data-side="away" style="padding:6px 0;font-size:11px;color:#888;">読み込み中...</div>'
        + '</details>';
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

    /* 🔍 画像調整スライダー — comparison は左右別 (imageAdjustLeft / Right)、他は単一 (imageAdjust) */
    let imgAdjustHtml = '';
    if (m.type === 'comparison') {
      const _adjL = m.imageAdjustLeft  || m.imageAdjust || {};
      const _adjR = m.imageAdjustRight || m.imageAdjust || {};
      const _zL = (_adjL.zoom    != null) ? Number(_adjL.zoom)    : 1;
      const _xL = (_adjL.offsetX != null) ? Number(_adjL.offsetX) : 0;
      const _yL = (_adjL.offsetY != null) ? Number(_adjL.offsetY) : 0;
      const _zR = (_adjR.zoom    != null) ? Number(_adjR.zoom)    : 1;
      const _xR = (_adjR.offsetX != null) ? Number(_adjR.offsetX) : 0;
      const _yR = (_adjR.offsetY != null) ? Number(_adjR.offsetY) : 0;
      const _row = function(side, label, accent, z, x, y) {
        return ''
          + '<div style="font-size:10px;color:' + accent + ';font-weight:bold;margin:8px 0 4px;">' + label + '</div>'
          + '<div style="display:grid;grid-template-columns:60px 1fr 56px;gap:8px;padding:10px 12px;background:#0d1220;border-radius:6px;align-items:center;">'
          +   '<span style="font-size:10px;color:#94a3b8;">ズーム</span>'
          +   '<input type="range" class="s4-img-zoom-' + side + '" min="0.5" max="2.0" step="0.05" value="' + z.toFixed(2) + '" style="width:100%;">'
          +   '<span class="s4-img-zoom-val-' + side + '" style="font-size:11px;text-align:right;color:#fcd34d;font-weight:bold;">' + z.toFixed(2) + 'x</span>'
          +   '<span style="font-size:10px;color:#94a3b8;">X位置</span>'
          +   '<input type="range" class="s4-img-ox-' + side + '" min="-50" max="50" step="1" value="' + x + '" style="width:100%;">'
          +   '<span class="s4-img-ox-val-' + side + '" style="font-size:11px;text-align:right;color:#fcd34d;font-weight:bold;">' + x + '%</span>'
          +   '<span style="font-size:10px;color:#94a3b8;">Y位置</span>'
          +   '<input type="range" class="s4-img-oy-' + side + '" min="-50" max="50" step="1" value="' + y + '" style="width:100%;">'
          +   '<span class="s4-img-oy-val-' + side + '" style="font-size:11px;text-align:right;color:#fcd34d;font-weight:bold;">' + y + '%</span>'
          + '</div>'
          + '<button class="s4-img-reset-' + side + '" style="background:#1a2540;color:#94a3b8;border:1px solid #2a3050;border-radius:4px;cursor:pointer;font-size:10px;padding:4px 12px;margin-top:6px;">' + label + ' をリセット</button>';
      };
      imgAdjustHtml = ''
        + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🔍 画像調整 <span style="font-size:10px;color:#5a6a8a;font-weight:normal;">左右別個・各画像独立</span></div>'
        + _row('left',  '◀ 左画像', '#60a5fa', _zL, _xL, _yL)
        + _row('right', '▶ 右画像', '#fb7185', _zR, _xR, _yR);
    } else {
      const _imgAdj = m.imageAdjust || {};
      const _zoom = (_imgAdj.zoom != null) ? Number(_imgAdj.zoom) : 1;
      const _ox   = (_imgAdj.offsetX != null) ? Number(_imgAdj.offsetX) : 0;
      const _oy   = (_imgAdj.offsetY != null) ? Number(_imgAdj.offsetY) : 0;
      imgAdjustHtml = ''
        + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin:14px 0 6px;">🔍 画像調整 <span style="font-size:10px;color:#5a6a8a;font-weight:normal;">ズーム + 位置</span></div>'
        + '<div style="display:grid;grid-template-columns:60px 1fr 56px;gap:8px;padding:10px 12px;background:#0d1220;border-radius:6px;align-items:center;">'
        +   '<span style="font-size:10px;color:#94a3b8;">ズーム</span>'
        +   '<input type="range" class="s4-img-zoom" min="0.5" max="2.0" step="0.05" value="' + _zoom.toFixed(2) + '" style="width:100%;">'
        +   '<span class="s4-img-zoom-val" style="font-size:11px;text-align:right;color:#fcd34d;font-weight:bold;">' + _zoom.toFixed(2) + 'x</span>'
        +   '<span style="font-size:10px;color:#94a3b8;">X位置</span>'
        +   '<input type="range" class="s4-img-ox" min="-50" max="50" step="1" value="' + _ox + '" style="width:100%;">'
        +   '<span class="s4-img-ox-val" style="font-size:11px;text-align:right;color:#fcd34d;font-weight:bold;">' + _ox + '%</span>'
        +   '<span style="font-size:10px;color:#94a3b8;">Y位置</span>'
        +   '<input type="range" class="s4-img-oy" min="-50" max="50" step="1" value="' + _oy + '" style="width:100%;">'
        +   '<span class="s4-img-oy-val" style="font-size:11px;text-align:right;color:#fcd34d;font-weight:bold;">' + _oy + '%</span>'
        + '</div>'
        + '<button class="s4-img-reset" style="background:#1a2540;color:#94a3b8;border:1px solid #2a3050;border-radius:4px;cursor:pointer;font-size:10px;padding:4px 12px;margin-top:6px;">画像調整をリセット</button>';
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
      +     'oninput="s4OnInput()" '
      +     'style="display:block;width:100%;font-size:11px;padding:5px 8px;min-height:60px;resize:vertical;background:#0a0d18;color:#e0e0e0;border:1px solid #2a2f4a;">' + _esc(m.fillPrompt || '') + '</textarea>'
      +   '<div style="display:flex;gap:10px;margin-top:6px;align-items:center;flex-wrap:wrap;">'
      +     '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#a5b4fc;cursor:pointer;user-select:none;">'
      +       '<input type="checkbox" class="s4-fill-incremental" data-idx="' + i + '" style="margin:0;" oninput="s4OnInput()"' + (m.fillIncremental ? ' checked' : '') + '>'
      +       '微調整モード（既存内容を保持して差分のみ適用）'
      +     '</label>'
      +     '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#34d399;cursor:pointer;user-select:none;">'
      +       '<input type="checkbox" class="s4-fill-webresearch" data-idx="' + i + '" style="margin:0;" onchange="s4OnInput();s4ToggleResearchPrompt(' + i + ', this.checked)"' + (m.fillWebresearch ? ' checked' : '') + '>'
      +       '🌐 ウェブリサーチを使う'
      +     '</label>'
      +     '<span style="flex:1"></span>'
      +     '<button class="btn btn-sm s4-fill-go" data-idx="' + i + '" style="background:#6366f1;color:#fff;font-size:11px;padding:5px 14px;font-weight:bold;">🪄 生成</button>'
      +   '</div>'
      +   '<textarea class="inp s4-fill-research-prompt" data-idx="' + i + '" placeholder="リサーチの観点（例: BlueCo の経済モデル / Boehly の介入履歴 / 失敗トランスファー詳細）。空ならユーザー注文を流用。" '
      +     'oninput="s4OnInput()" '
      +     'style="display:' + (m.fillWebresearch ? 'block' : 'none') + ';width:100%;font-size:11px;padding:5px 8px;min-height:50px;resize:vertical;background:#0a0d18;color:#34d399;border:1px solid #34d39955;margin-top:6px;">' + _esc(m.fillResearchPrompt || '') + '</textarea>'
      +   '<div style="font-size:9px;color:#5a6a8a;margin-top:4px;">Sonnet 既定 → 失敗時 DeepSeek フォールバック / 🌐 ON で Serper最大3クエリ検索→文脈注入</div>'
      + '</div>'
      + galleryHtml
      + imgAdjustHtml
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
    el.querySelectorAll('.s4-slot-add').forEach(function(btn) {
      btn.addEventListener('click', function() { s4AddSlot(); });
    });
    el.querySelectorAll('.s4-phrase-add').forEach(function(btn) {
      btn.addEventListener('click', function() { s4AddPhrase(); });
    });
    // 2026-05-17: 並び替え (↑↓) ハンドラ
    function _s4Swap(arr, idx, dir) {
      if (!Array.isArray(arr)) return;
      const j = idx + dir;
      if (idx < 0 || j < 0 || idx >= arr.length || j >= arr.length) return;
      const tmp = arr[idx]; arr[idx] = arr[j]; arr[j] = tmp;
    }
    function _bindSwap(selector, getArr, dir) {
      el.querySelectorAll(selector).forEach(function(btn) {
        btn.addEventListener('click', function() {
          if (btn.disabled) return;
          const idx = parseInt(btn.getAttribute('data-idx'), 10);
          const arr = getArr();
          _s4Swap(arr, idx, dir);
          _renderEditor();
        });
      });
    }
    _bindSwap('.s4-slot-up',   () => m.dataSlots,   -1);
    _bindSwap('.s4-slot-down', () => m.dataSlots,   +1);
    _bindSwap('.s4-phrase-up',   () => m.catchphrases, -1);
    _bindSwap('.s4-phrase-down', () => m.catchphrases, +1);
    _bindSwap('.s4-cmt-up',   () => m.comments, -1);
    _bindSwap('.s4-cmt-down', () => m.comments, +1);
    /* 🔍 画像調整スライダー bind（単一画像スライド）*/
    const _zoomEl = el.querySelector('.s4-img-zoom');
    if (_zoomEl) _zoomEl.addEventListener('input', function(e) { s4OnImageAdjust('zoom', e.target.value); });
    const _oxEl = el.querySelector('.s4-img-ox');
    if (_oxEl) _oxEl.addEventListener('input', function(e) { s4OnImageAdjust('offsetX', e.target.value); });
    const _oyEl = el.querySelector('.s4-img-oy');
    if (_oyEl) _oyEl.addEventListener('input', function(e) { s4OnImageAdjust('offsetY', e.target.value); });
    const _resetEl = el.querySelector('.s4-img-reset');
    if (_resetEl) _resetEl.addEventListener('click', function() { s4ResetImageAdjust(); });
    /* 🔍 画像調整スライダー bind（comparison 左右別）*/
    ['left', 'right'].forEach(function(side) {
      const z = el.querySelector('.s4-img-zoom-' + side);
      if (z) z.addEventListener('input', function(e) { s4OnImageAdjust('zoom', e.target.value, side); });
      const x = el.querySelector('.s4-img-ox-' + side);
      if (x) x.addEventListener('input', function(e) { s4OnImageAdjust('offsetX', e.target.value, side); });
      const y = el.querySelector('.s4-img-oy-' + side);
      if (y) y.addEventListener('input', function(e) { s4OnImageAdjust('offsetY', e.target.value, side); });
      const r = el.querySelector('.s4-img-reset-' + side);
      if (r) r.addEventListener('click', function() { s4ResetImageAdjust(side); });
    });
    /* matchcard lineup アコーディオン: open 時に lineup fetch して編集 UI を描画 */
    el.querySelectorAll('details.s4-mc-team').forEach(function(det) {
      det.addEventListener('toggle', function() {
        if (det.open) s4LoadMatchcardLineup(det);
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
    /* 🔧 walker バインド: 主 dropdown 変更時に副の自分自身を除外して再生成 */
    el.querySelectorAll('.s4-walker-primary').forEach(function(pSel) {
      pSel.addEventListener('change', function() {
        const idx = parseInt(pSel.getAttribute('data-idx'), 10);
        const sSel = el.querySelector('.s4-walker-secondary[data-idx="' + idx + '"]');
        if (!sSel) return;
        const newP = pSel.value;
        // 自分自身が選ばれてたら一旦クリア、選択肢から自分自身を disable
        Array.from(sSel.options).forEach(function(o) {
          o.disabled = (o.value && o.value === newP);
          if (o.disabled && o.selected) sSel.value = '';
        });
      });
    });
    /* 🔧 walker バインド: 適用ボタン → /v2/walker-bind */
    el.querySelectorAll('.s4-walker-apply').forEach(function(btn) {
      btn.addEventListener('click', function() {
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        if (Number.isNaN(idx)) return;
        s4ApplyWalkerBind(idx);
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

    /* 🔧 walker バインド UI（主/副を手動指定し AI 介さず確定連結 / 2026-05-10）
       「対比連結が AI 任せだと不安定」問題の根本対処。
       subject 同 role の entity だけ dropdown に出す。
       comparison カードは 副 必須、profile/stats 等は 副 任意（空= single モード）。 */
    let walkerBindBanner = '';
    const _bindableSubjects = ['player', 'team', 'manager'];
    if (_bindableSubjects.indexOf(data.subject) >= 0) {
      const _mod = window.APP.s4.modules ? window.APP.s4.modules[idx] : null;
      const _isCmpCard = !!_mod && _mod.type === 'comparison';
      const _allEnt = ((window.APP.s4.siData && window.APP.s4.siData.boxes && window.APP.s4.siData.boxes.entity && window.APP.s4.siData.boxes.entity.items) || [])
        .filter(function(e) { return e && e.label && e.role === data.subject; });
      const _optsP = _allEnt.map(function(e) {
        return '<option value="' + _esc(e.label) + '"' + (e.label === data.primary ? ' selected' : '') + '>' + _esc(e.label) + '</option>';
      }).join('');
      const _optsS = (_isCmpCard ? '' : '<option value="">— なし（単体モード）—</option>')
        + _allEnt.filter(function(e) { return e.label !== data.primary; }).map(function(e) {
            return '<option value="' + _esc(e.label) + '"' + (e.label === data.secondary ? ' selected' : '') + '>' + _esc(e.label) + '</option>';
          }).join('');
      const _showSec = _isCmpCard || data.isCompare;
      walkerBindBanner = '<details class="s4-walker-bind" data-idx="' + idx + '"'
        + ' style="margin:14px 0 10px;border:1px dashed #f59e0b;border-radius:6px;background:#1a1810;">'
        + '<summary style="cursor:pointer;padding:8px 12px;font-size:11px;color:#fbbf24;font-weight:bold;">'
        + '🔧 walker バインド（主/副を手動指定 / AI 不使用 / 確実な連結）'
        + '</summary>'
        + '<div style="padding:8px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">'
        + '<span style="font-size:10px;color:#fbbf24;">主:</span>'
        + '<select class="s4-walker-primary inp" data-idx="' + idx + '" style="font-size:11px;padding:4px 8px;background:#0a0d18;color:#e0e0e0;min-width:160px;">'
        +   _optsP + '</select>'
        + (_showSec
            ? '<span style="font-size:10px;color:#fbbf24;">副:</span>'
              + '<select class="s4-walker-secondary inp" data-idx="' + idx + '" style="font-size:11px;padding:4px 8px;background:#0a0d18;color:#e0e0e0;min-width:160px;">'
              +   _optsS + '</select>'
            : '')
        + '<button class="s4-walker-apply" data-idx="' + idx + '"'
        + ' style="font-size:11px;padding:5px 14px;background:#f59e0b;color:#000;border:0;border-radius:4px;cursor:pointer;font-weight:bold;">適用</button>'
        + '<span class="s4-walker-msg" data-idx="' + idx + '" style="font-size:10px;color:#8a9aba;flex-basis:100%;">AI に頼らず手動連結。subject=' + _esc(data.subject) + ' 同 role の entity のみ表示。'
        + (_isCmpCard ? ' / comparison カードは 副 必須' : ' / 単体カードは 副 を空にすると single モード') + '</span>'
        + '</div></details>';
    }

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

    return walkerBindBanner + head + '<div style="background:#0d1220;border-radius:6px;padding:6px;max-height:340px;overflow-y:auto;">'
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

  /* 🪄 スライド全部おまかせ AI: type/title/dataSlots/narration を一気通貫生成（or 微調整 / Web リサーチ付き） */
  window.s4FillSlideAI = async function(idx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const ta = document.querySelector('.s4-fill-prompt[data-idx="' + idx + '"]');
    const userPrompt = (ta?.value || '').trim();
    if (!userPrompt) { _msg('注文内容を書いてね'); return; }
    const incCb = document.querySelector('.s4-fill-incremental[data-idx="' + idx + '"]');
    const incremental = !!(incCb && incCb.checked);
    // 🆕 Web リサーチ用 UI（2026-05-07）
    const webCb = document.querySelector('.s4-fill-webresearch[data-idx="' + idx + '"]');
    const useWebResearch = !!(webCb && webCb.checked);
    const researchTa = document.querySelector('.s4-fill-research-prompt[data-idx="' + idx + '"]');
    const researchPrompt = (researchTa?.value || '').trim();
    const status = document.querySelector('.s4-fill-status[data-idx="' + idx + '"]');
    const initialMsg = useWebResearch
      ? '⏳ ウェブリサーチ + ' + (incremental ? '微調整' : '全体生成') + '中...'
      : (incremental ? '⏳ 微調整中...' : '⏳ 全体生成中...');
    if (status) status.textContent = initialMsg;
    const confirmMsg = useWebResearch
      ? 'ウェブリサーチ付きで生成します（Serper × 最大3クエリ）。OK?'
      : (incremental
          ? '微調整モード: 既存内容を保持しつつ、注文の差分のみ適用します。OK?'
          : '現在のスライドの type / title / dataSlots / narration を AI 生成で上書きします。OK?');
    if (!confirm(confirmMsg)) {
      if (status) status.textContent = '';
      return;
    }
    try {
      // 🆕 ジョブ起動 → ポーリング（タブ閉じてもバックエンドで継続）
      const initRes = await fetchJson('/api/v2/ai-fill-slide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, userPrompt, incremental, useWebResearch, researchPrompt, sprint: localStorage.getItem('v2_sprint_mode') === '1' }),
      });
      const jobId = initRes && initRes.jobId;
      if (!jobId) throw new Error('jobId 受信失敗');
      // localStorage に保存（タブ閉じ・リロード後も再開可能）
      try { localStorage.setItem('s4_aifill_' + post.id + '_' + idx, jobId); } catch (_) {}
      // ポーリング
      let r = null;
      for (let i = 0; i < 200; i++) {
        await new Promise(rr => setTimeout(rr, 3000));
        try {
          const j = await fetchJson('/api/v2/ai-fill-slide-status?jobId=' + encodeURIComponent(jobId));
          if (j.status === 'error') {
            try { localStorage.removeItem('s4_aifill_' + post.id + '_' + idx); } catch(_) {}
            throw new Error(j.error || 'ジョブ失敗');
          }
          if (j.status === 'done') {
            try { localStorage.removeItem('s4_aifill_' + post.id + '_' + idx); } catch(_) {}
            r = j.result || {};
            break;
          }
          if (status) status.textContent = (incremental ? '⏳ 微調整中' : '⏳ 全体生成中') + '... (' + (i+1)*3 + 's)';
        } catch (e) {
          if (String(e.message).includes('404')) throw new Error('ジョブ消失');
          // 一時的なネットワーク失敗は継続
        }
      }
      if (!r || !r.ok) throw new Error(r?.error || 'ポーリングタイムアウト');
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
      // 上限は type 別: comparison=7 / stats/history=8 / profile=7 / insight=6
      // 2026-05-17: SLOT_MAX (line 1872/3031) と整合性取って comparison 5→7 に統一
      const m = window.APP.s4.modules[idx];
      const limit = ({ comparison: 7, stats: 8, profile: 7, history: 8, insight: 6 })[m?.type] || 8;
      if (sel.size >= limit) {
        _msg(limit + 'メトリック選択済 — どれかを外してから追加してください');
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

  /* 🔧 walker バインド: 主/副 を強制上書きして walker から dataSlots 再構築（AI不使用）*/
  window.s4ApplyWalkerBind = async function(idx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const root = document.getElementById('s4Editor') || document;
    const pEl = root.querySelector('.s4-walker-primary[data-idx="' + idx + '"]');
    const sEl = root.querySelector('.s4-walker-secondary[data-idx="' + idx + '"]');
    const msgEl = root.querySelector('.s4-walker-msg[data-idx="' + idx + '"]');
    const primary   = pEl ? pEl.value : '';
    const secondary = sEl ? sEl.value : '';
    if (!primary) {
      if (msgEl) msgEl.textContent = '❌ 主 entity を選択してね';
      return;
    }
    if (msgEl) msgEl.textContent = '⏳ walker バインド適用中...';
    try {
      const r = await fetchJson('/api/v2/walker-bind', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId: post.id, moduleIdx: idx, primary,
          secondary: secondary || null,
        }),
      });
      if (!r.ok) throw new Error(r.error || 'walker バインド失敗');
      // mod 反映
      const m = window.APP.s4.modules[idx];
      if (m && r.mod) {
        m.dataSlots      = r.mod.dataSlots;
        m.mainKey        = r.mod.mainKey;
        m.secondary      = r.mod.secondary;
        m.siBindingLeft  = r.mod.siBindingLeft;
        m.siBindingRight = r.mod.siBindingRight;
        m.binding        = r.mod.binding;
      }
      // recipe slot キャッシュ無効化 → 再 fetch
      delete window.APP.s4.recipeSlotsByIdx[idx];
      await _loadRecipeSlots(idx);
      _reloadPreview();
      if (msgEl) msgEl.textContent = '✅ walker 適用: ' + primary + (secondary ? ' vs ' + secondary : '') + ' / ' + (r.customSlotKeys || []).length + ' slot';
      _msg('🔧 walker バインド適用 #' + (idx + 1) + ': ' + primary + (secondary ? ' vs ' + secondary : ''));
    } catch (e) {
      if (msgEl) msgEl.textContent = '❌ ' + e.message;
      _msg('❌ walker バインド失敗: ' + e.message);
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
    /* 🪄 おまかせ AI パネルの編集内容（タブ切替で消えないよう state へ書き戻す / 2026-05-17 #5 修正）*/
    const fp = document.querySelector('.s4-fill-prompt[data-idx="' + i + '"]');
    const fi = document.querySelector('.s4-fill-incremental[data-idx="' + i + '"]');
    const fw = document.querySelector('.s4-fill-webresearch[data-idx="' + i + '"]');
    const fr = document.querySelector('.s4-fill-research-prompt[data-idx="' + i + '"]');
    if (fp) m.fillPrompt = fp.value;
    if (fi) m.fillIncremental = !!fi.checked;
    if (fw) m.fillWebresearch = !!fw.checked;
    if (fr) m.fillResearchPrompt = fr.value;

    /* TTS settings (panel が画面に出てる場合のみ拾う) */
    const tp  = document.getElementById('s4TtsProvider');
    const tv  = document.getElementById('s4TtsVoice');
    const tm  = document.getElementById('s4TtsModel');
    const tsi = document.getElementById('s4TtsStyleInstructions');
    const tsp = document.getElementById('s4TtsSpeed');
    const te  = document.getElementById('s4TtsEmotion');
    if (tp || tv || tm || tsi || tsp || te) {
      m.tts = Object.assign({}, m.tts || {}, {
        provider: tp?.value || (m.tts?.provider || ''),
        voiceId:  tv?.value || (m.tts?.voiceId || ''),
        model:    tm?.value || (m.tts?.model   || ''),
        styleInstructions: tsi ? tsi.value : (m.tts?.styleInstructions || ''),
        speed:    tsp?.value ? Number(tsp.value) : (m.tts?.speed ?? 1.0),
        emotion:  te?.value || '',
      });
    }
  }

  /* ── 🌐 ウェブリサーチチェックボックス onChange（escape 衝突回避のため別関数化）── */
  window.s4ToggleResearchPrompt = function(idx, checked) {
    const ta = document.querySelector('.s4-fill-research-prompt[data-idx="' + idx + '"]');
    if (ta) ta.style.display = checked ? 'block' : 'none';
  };

  /* ── 🔍 画像調整スライダー（zoom / X / Y）── */
  //   debounced で _saveAndReload して即時プレビュー反映
  let _imgAdjTimer = null;
  window.s4OnImageAdjust = function(field, val, side) {
    // side: undefined (単一 imageAdjust) | 'left' (imageAdjustLeft) | 'right' (imageAdjustRight)
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const key = side === 'left' ? 'imageAdjustLeft' : side === 'right' ? 'imageAdjustRight' : 'imageAdjust';
    // 左右別調整の初回操作時は単一 imageAdjust を起点にして引き継ぐ（既に Phase A で設定済の値を捨てない）
    const base = m[key] || (side ? m.imageAdjust : null) || {};
    const adj = Object.assign({ zoom: 1, offsetX: 0, offsetY: 0 }, base);
    if (field === 'zoom')    adj.zoom    = parseFloat(val);
    if (field === 'offsetX') adj.offsetX = parseInt(val, 10);
    if (field === 'offsetY') adj.offsetY = parseInt(val, 10);
    m[key] = adj;
    // ラベル即時更新（操作中の数字表示）
    const card = document.getElementById('s4Editor');
    if (card) {
      const suffix = side ? '-' + side : '';
      const z = card.querySelector('.s4-img-zoom-val' + suffix);
      const x = card.querySelector('.s4-img-ox-val' + suffix);
      const y = card.querySelector('.s4-img-oy-val' + suffix);
      if (z) z.textContent = (adj.zoom || 1).toFixed(2) + 'x';
      if (x) x.textContent = (adj.offsetX || 0) + '%';
      if (y) y.textContent = (adj.offsetY || 0) + '%';
    }
    clearTimeout(_imgAdjTimer);
    _imgAdjTimer = setTimeout(_saveAndReload, 300);  // スライダー操作中の連発を debounce
  };

  window.s4ResetImageAdjust = function(side) {
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const key = side === 'left' ? 'imageAdjustLeft' : side === 'right' ? 'imageAdjustRight' : 'imageAdjust';
    m[key] = { zoom: 1, offsetX: 0, offsetY: 0 };
    _renderEditor();
    _saveAndReload();
  };

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

  /* ── dataSlot 行を追加（上限 type 別） ── */
  window.s4AddSlot = function() {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const SLOT_MAX = ({ stats: 8, profile: 7, history: 8, comparison: 7, insight: 6 })[m.type] || 8;
    if (!Array.isArray(m.dataSlots)) m.dataSlots = [];
    if (m.dataSlots.length >= SLOT_MAX) return;
    if (m.type === 'comparison') m.dataSlots.push({ label: '', leftValue: '', rightValue: '' });
    else                          m.dataSlots.push({ label: '', value: '' });
    _renderEditor();
    _saveAndReload();
  };

  /* ── matchcard lineup を fetch して編集 UI を描画 ── */
  //   det = <details> 要素。data-side ('home'|'away') / data-idx (moduleIdx) を持つ
  window.s4LoadMatchcardLineup = async function(det) {
    const side = det.getAttribute('data-side');
    const idx  = parseInt(det.getAttribute('data-idx'), 10);
    const body = det.querySelector('.s4-mc-body');
    if (!body) return;
    if (body.dataset.loaded === '1') return;  // 一度ロードしたら再利用
    const post = window.APP.selected;
    if (!post?.id) { body.textContent = '案件未選択'; return; }

    body.textContent = '⏳ 読み込み中...';
    try {
      const r = await fetchJson('/api/v2/matchcard-lineup?postId=' + encodeURIComponent(post.id) + '&moduleIdx=' + idx);
      if (!r.ok) { body.textContent = 'エラー: ' + (r.error || 'unknown'); return; }
      const list = side === 'home' ? r.home : r.away;
      if (!list.length) { body.textContent = '(lineup データ未取得 — Step2 で fetch-all を実行)'; return; }
      // 各行: 元名 (灰色 readonly) + 表示名 input
      const rows = list.map(function(p, i) {
        return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:3px;align-items:center;">'
          +  '<input class="inp" value="' + _esc(p.name) + '" readonly style="font-size:11px;padding:3px 6px;color:#666;background:#1a1a26;">'
          +  '<input class="inp s4-mc-edit" data-idx="' + idx + '" data-orig="' + _esc(p.name) + '" value="' + _esc(p.displayName) + '" placeholder="編集して保存" style="font-size:11px;padding:3px 6px;color:#fff;">'
          +  '</div>';
      }).join('');
      body.innerHTML = rows;
      body.dataset.loaded = '1';
      // 入力変更で 800ms debounce で保存
      let t;
      body.querySelectorAll('.s4-mc-edit').forEach(function(input) {
        input.addEventListener('input', function() {
          clearTimeout(t);
          t = setTimeout(function() { s4SaveMatchcardOverrides(idx); }, 800);
        });
      });
    } catch (e) {
      body.textContent = 'エラー: ' + e.message;
    }
  };

  /* ── matchcard lineup overrides を全 details から集めて保存 ── */
  window.s4SaveMatchcardOverrides = async function(idx) {
    const post = window.APP.selected;
    if (!post?.id) return;
    const overrides = {};
    // 該当 moduleIdx の全 .s4-mc-edit を集める
    document.querySelectorAll('.s4-mc-edit[data-idx="' + idx + '"]').forEach(function(input) {
      const orig = input.getAttribute('data-orig');
      const val  = String(input.value || '').trim();
      if (orig && val) overrides[orig] = val;
    });
    try {
      await fetchJson('/api/v2/matchcard-lineup-overrides', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, overrides }),
      });
      // 既存メモリ上にも保存（再 render 時に維持）
      if (window.APP.s4.modules[idx]) window.APP.s4.modules[idx].lineupOverrides = overrides;
    } catch (e) {
      console.warn('lineup overrides 保存失敗:', e.message);
    }
  };

  /* ── catchphrase 行を追加（insight 用） ── */
  window.s4AddPhrase = function() {
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    const SLOT_MAX = ({ insight: 6 })[m.type] || 6;
    if (!Array.isArray(m.catchphrases)) m.catchphrases = [];
    if (m.catchphrases.length >= SLOT_MAX) return;
    // 新スキーマ {text, chunkText} に揃える（旧形式 string も AI 出力経由で混在しうる）
    const usesObj = m.catchphrases.length === 0 || typeof m.catchphrases[0] === 'object';
    m.catchphrases.push(usesObj ? { text: '', chunkText: '' } : '');
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

  /* ── 🎙️ TTS: provider 切替 (voice/model リストを再取得 → UI 再描画) ── */
  window.s4TtsProviderChange = async function(provider) {
    if (!provider) return;
    _collectInputs();
    const i = window.APP.s4.activeTab;
    const m = window.APP.s4.modules[i];
    if (!m) return;
    // 既存 voice/model/styleInstructions は捨てる（provider 違いで互換無し）
    m.tts = Object.assign({}, m.tts || {}, { provider, voiceId: '', model: '', styleInstructions: '' });
    const cache = window.APP.s4.ttsPresetsByProvider || (window.APP.s4.ttsPresetsByProvider = {});
    try {
      if (!cache[provider]) {
        cache[provider] = await fetchJson('/api/v2/tts-presets?provider=' + encodeURIComponent(provider));
      }
      window.APP.s4.ttsPresets = cache[provider];
    } catch (e) {
      const status = document.querySelector('.s4-tts-status[data-idx="' + i + '"]');
      if (status) status.textContent = '❌ provider 切替失敗: ' + e.message;
      return;
    }
    _renderEditor();
  };

  /* ── 🎙️ TTS: Style Instructions をデフォルトに戻す ── */
  window.s4TtsResetStyle = function() {
    const presets = window.APP.s4.ttsPresets || {};
    const ta = document.getElementById('s4TtsStyleInstructions');
    if (ta) ta.value = presets.styleInstructions || '';
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
          provider: m.tts?.provider,
          text: text.slice(0, 800),
          voiceId: m.tts?.voiceId,
          model:   m.tts?.model,
          styleInstructions: m.tts?.styleInstructions || undefined,
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
