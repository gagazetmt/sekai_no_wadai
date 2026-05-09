// routes/data_explorer_routes.js
// ═══════════════════════════════════════════════════════════
// データエクスプローラ：si_data 内の任意 entity に walker を実行し、
// 全 slot を「大分類(role) → 中分類(category) → 小分類(slot)」で
// 確認できる API。comparison ペアと recipe 展開も再現する。
// 単独 HTML (/v2_data_explorer/index.html) から呼ばれる。
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router   = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');

const { walkEntity, buildPairsForCompare } = require('../scripts/v2_story/si_walker');
const { applicableRecipes, expandRecipe, RECIPES } = require('../scripts/v2_story/recipes_curated');

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}
function siPath(postId) {
  return path.join(SI_DIR, (postId || 'unknown').replace(/[/\?%*:|"<>.]/g, '_') + '.json');
}

// step3 の binding_meta._findEntityData と同じ merge 規則
function _findEntityData(siData, role, label) {
  if (!siData || !label) return null;
  if (role === 'match') {
    const it = (siData.boxes?.match?.items || []).find(x => x.label === label);
    return it?.data?.ok ? it.data : null;
  }
  const it = (siData.boxes?.entity?.items || []).find(x => x.label === label);
  if (!it) return null;
  const sofaOk = !!it.sofa?.ok;
  const wikiOk = !!it.wiki?.ok;
  const fmOk   = !!it.fotmob?.ok;
  if (!sofaOk && !wikiOk && !fmOk) return null;
  return {
    ...(sofaOk ? it.sofa : {}),
    _wiki:   wikiOk ? it.wiki   : null,
    _fotmob: fmOk   ? it.fotmob : null,
  };
}

// ─── /api/v3/data-explorer/projects : 案件一覧 ──────────────
router.get('/v3/data-explorer/projects', (req, res) => {
  const saved = safeJson(path.join(DATA_DIR, 'saved_projects.json'), []);
  const items = (Array.isArray(saved) ? saved : []).map(p => ({
    id:    p.id,
    title: p.title || p.titleJa || '(no title)',
  })).filter(p => p.id);
  // si_data ファイルが実在するものだけ（fetch 未済の案件は除外）
  const existing = items.filter(p => fs.existsSync(siPath(p.id)));
  res.json({ ok: true, projects: existing });
});

// ─── /api/v3/data-explorer/entities?postId= : 案件内 entity ─
router.get('/v3/data-explorer/entities', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const si = safeJson(siPath(postId), null);
  if (!si) return res.status(404).json({ error: 'si_data not found' });

  const entities = (si.boxes?.entity?.items || [])
    .filter(x => x?.label)
    .map(x => ({
      label: x.label,
      role:  x.role,
      sofaOk:   !!x.sofa?.ok,
      wikiOk:   !!x.wiki?.ok,
      fotmobOk: !!x.fotmob?.ok,
      tmOk:     !!x.tm?.ok,
    }));
  const matches = (si.boxes?.match?.items || [])
    .filter(x => x?.label)
    .map(x => ({
      label: x.label,
      role:  'match',
      ok:    !!x.data?.ok,
    }));
  res.json({ ok: true, entities, matches });
});

// ─── /api/v3/data-explorer/walker : walker 実行 ────────────
//   query: postId, label (primary), pairLabel? (secondary for compare)
//   returns: { ok, role, isCompare, primary, secondary, slots: [...] }
//     slots: { key, label, category, priority, source, value | leftValue+rightValue }
router.get('/v3/data-explorer/walker', (req, res) => {
  const postId    = req.query.postId;
  const label     = req.query.label;
  const pairLabel = req.query.pairLabel || null;
  if (!postId || !label) return res.status(400).json({ error: 'postId + label required' });

  const si = safeJson(siPath(postId), null);
  if (!si) return res.status(404).json({ error: 'si_data not found' });

  // role 判定
  let role = (si.boxes?.entity?.items || []).find(x => x.label === label)?.role || null;
  if (!role) {
    const m = (si.boxes?.match?.items || []).find(x => x.label === label);
    if (m) role = 'match';
  }
  if (!role) return res.status(404).json({ error: `entity '${label}' not found in si_data` });

  const primaryData = _findEntityData(si, role, label);
  if (!primaryData) return res.status(404).json({ error: `entity '${label}' has no usable data` });

  let isCompare = false;
  let secondaryData = null;
  let secondaryRole = null;
  if (pairLabel) {
    secondaryRole = (si.boxes?.entity?.items || []).find(x => x.label === pairLabel)?.role || null;
    if (!secondaryRole && (si.boxes?.match?.items || []).find(x => x.label === pairLabel)) {
      secondaryRole = 'match';
    }
    if (secondaryRole && secondaryRole === role) {
      secondaryData = _findEntityData(si, role, pairLabel);
      if (secondaryData) isCompare = true;
    }
  }

  let slots;
  if (isCompare) {
    slots = buildPairsForCompare(primaryData, secondaryData, role);
  } else {
    slots = walkEntity(primaryData, role).map(s => ({
      key: s.key, label: s.label, category: s.category,
      priority: s.priority, source: s.source, value: s.value,
    }));
  }

  // recipe 候補（walker 出力ベース）
  const recipes = applicableRecipes(
    isCompare ? slots.map(s => ({ key: s.key })) : slots,
    role, isCompare
  ).map(r => ({
    key: r.key, label: r.label, description: r.description,
    keys: r.keys, expanded: expandRecipe(r.key, slots),
  }));

  res.json({
    ok: true,
    role, isCompare,
    primary:   label,
    secondary: isCompare ? pairLabel : null,
    slotCount: slots.length,
    slots,
    recipes,
  });
});

// ─── /api/v3/data-explorer/all-recipes : RECIPES 全部（参考表示用） ─
router.get('/v3/data-explorer/all-recipes', (req, res) => {
  const list = Object.entries(RECIPES).map(([key, r]) => ({
    key, label: r.label, description: r.description,
    keys: r.keys, appliesTo: r.appliesTo, requires: r.requires || null,
  }));
  res.json({ ok: true, recipes: list });
});

module.exports = { router };
