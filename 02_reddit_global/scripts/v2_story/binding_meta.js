// scripts/v2_story/binding_meta.js
// レシピマッチカードのメタ解決（step3 / step4 共有）
//
// 役割:
//   モジュール (mod) と SI データから、subject/aspect を推論し、
//   対応する Recipe + 実データ entity を引いて返す。
//   結果のメタ情報を使えば「型はAI、値はコード充填」が可能。
//
// 使い方:
//   const { getBindingMeta } = require('./binding_meta');
//   const meta = getBindingMeta(mod, siData);
//   if (meta) {
//     // meta.recipe.availableSlots を AI に customSlotKeys 選定させる
//     // → buildDataSlotsFromRecipe(meta.recipe, meta.primaryData, meta.secondaryData, keys)
//   }

const { getRecipe } = require('./recipes');

// 1エンティティのデータを SI box (entity/match) から引く
function _findEntityData(siData, subject, label) {
  if (!siData || !label) return null;
  if (subject === 'match') {
    const it = (siData.boxes?.match?.items || []).find(x => x.label === label);
    return it?.data?.ok ? it.data : null;
  }
  const it = (siData.boxes?.entity?.items || []).find(x => x.label === label);
  if (!it) return null;
  return it.sofa?.ok ? it.sofa : null;
}

// SI items から label の role を解決（player/team/manager 自動判別用）
function _findRole(siData, label) {
  if (!label) return null;
  return (siData?.boxes?.entity?.items || []).find(it => it.label === label)?.role || null;
}

// mod から subject/aspect/primary/secondary を推論
function inferBindingForMod(mod, siData) {
  if (!mod) return null;

  // 既に binding があれば優先
  if (mod.binding?.subject && mod.binding?.aspect) {
    return {
      subject:   mod.binding.subject,
      aspect:    mod.binding.aspect,
      primary:   mod.binding.primary
                 || (mod.mainKey?.startsWith('entity:')    ? mod.mainKey.slice(7)
                 :   mod.mainKey?.startsWith('matchcard:') ? mod.mainKey.slice(10)
                 :   mod.mainKey?.startsWith('match:')     ? mod.mainKey.slice(6)
                 :   null),
      secondary: mod.binding.secondary || mod.secondary || null,
    };
  }

  // comparison: entity:X + secondary=Y → role に基づき自動推論
  if (mod.type === 'comparison' && mod.mainKey?.startsWith('entity:') && mod.secondary) {
    const primary = mod.mainKey.slice(7), secondary = mod.secondary;
    const r1 = _findRole(siData, primary), r2 = _findRole(siData, secondary);
    let subject = null, aspect = null;
    if (r1 === 'player'  && r2 === 'player')  { subject = 'player';  aspect = 'compareCareerStats'; }
    else if (r1 === 'team'    && r2 === 'team')    { subject = 'team';    aspect = 'compareSeasonStats'; }
    else if (r1 === 'manager' && r2 === 'manager') { subject = 'manager'; aspect = 'compareCareer'; }
    if (subject) return { subject, aspect, primary, secondary };
  }

  // 単体 entity 系：role と type から推論
  if (mod.mainKey?.startsWith('entity:')) {
    const primary = mod.mainKey.slice(7);
    const role = _findRole(siData, primary);
    if (!role) return null;
    let aspect = null;
    if (mod.type === 'profile') aspect = 'profile';
    else if (mod.type === 'stats') {
      aspect = role === 'team' ? 'seasonStats' : role === 'player' ? 'careerStats' : 'recentForm';
    }
    if (aspect) return { subject: role, aspect, primary, secondary: null };
  }

  // match 系：matchcard / match.preview
  if (mod.mainKey?.startsWith('match:') || mod.mainKey?.startsWith('matchcard:')) {
    const prefix = mod.mainKey.startsWith('matchcard:') ? 'matchcard:' : 'match:';
    const primary = mod.mainKey.slice(prefix.length);
    const aspect = mod.type === 'matchcard' ? 'preview' : 'matchStats';
    return { subject: 'match', aspect, primary, secondary: null };
  }

  return null;
}

// レシピメタを取得（A判定で availableSlots を持つレシピ全部に対応）
//   - comparison（requiresSecondary）も非 comparison も同じ口で扱う
//   - secondary は requiresSecondary レシピのみ必要
//   - 戻り値の isCompare で 比較/単体 を分岐
function getBindingMeta(mod, siData) {
  const inferred = inferBindingForMod(mod, siData);
  if (!inferred) return null;
  const { subject, aspect, primary, secondary } = inferred;

  const recipe = getRecipe(subject, aspect);
  if (!recipe?.availableSlots?.length) return null;

  const primaryData = _findEntityData(siData, subject, primary);
  if (!primaryData) return null;
  let secondaryData = null;
  if (recipe.requiresSecondary) {
    if (!secondary) return null;
    secondaryData = _findEntityData(siData, subject, secondary);
    if (!secondaryData) return null;
  }

  return {
    subject, aspect, recipe,
    primary, secondary, primaryData, secondaryData,
    isCompare: !!recipe.requiresSecondary,
    availableSlots: recipe.availableSlots.map(s => ({
      key:      s.key,
      label:    s.label,
      category: s.category || '-',
      priority: s.priority || 0,
    })),
    defaultSelection: recipe.defaultSelection || [],
  };
}

module.exports = {
  getBindingMeta,
  inferBindingForMod,
};
