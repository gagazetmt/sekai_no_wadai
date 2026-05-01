// scripts/v2_story/binding_meta.js
// レシピマッチカードのメタ解決（step3 / step4 共有）
//
// 役割:
//   モジュール (mod) と SI データから、subject/aspect を推論し、
//   walker で availableSlots を全列挙する。
//   結果のメタ情報を使えば「型はAI、値はコード充填」が成立。
//
// 旧版（〜2026-04-30）はレシピの availableSlots を上限としていたが、
// 「使える情報が勝手に狭まる」問題のためレシピ撤廃 → 全 leaf 列挙に切替。
//
// 使い方:
//   const { getBindingMeta } = require('./binding_meta');
//   const meta = getBindingMeta(mod, siData);
//   // meta.availableSlots を AI に customSlotKeys 選定させる
//   // → buildDataSlotsFromMeta(meta, keys)

'use strict';

const { walkEntity, buildPairsForCompare } = require('./si_walker');
const { applicableRecipes, expandRecipe, hasRecipe } = require('./recipes_curated');

// 1エンティティのデータを SI box (entity/match) から引く
//   subject = player/team/manager/tournament → boxes.entity.items の sofa + wiki を merge
//   subject = match                          → boxes.match.items から data を返す
//
// merge ルール:
//   - sofa.ok があれば sofa を主、wiki を `_wiki` プロパティで添える
//   - sofa.ok 無いが wiki.ok ある場合は wiki だけ使う（_wiki も同じものを指す）
//   - 両方無ければ null
function _findEntityData(siData, subject, label) {
  if (!siData || !label) return null;
  if (subject === 'match') {
    const it = (siData.boxes?.match?.items || []).find(x => x.label === label);
    return it?.data?.ok ? it.data : null;
  }
  const it = (siData.boxes?.entity?.items || []).find(x => x.label === label);
  if (!it) return null;
  const sofaOk = !!it.sofa?.ok;
  const wikiOk = !!it.wiki?.ok;
  if (!sofaOk && !wikiOk) return null;
  return {
    ...(sofaOk ? it.sofa : {}),
    _wiki: wikiOk ? it.wiki : null,
  };
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
    if      (r1 === 'player'  && r2 === 'player')  { subject = 'player';  aspect = 'compareCareerStats'; }
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
      if      (role === 'team')       aspect = 'seasonStats';
      else if (role === 'player')     aspect = 'careerStats';
      else if (role === 'tournament') aspect = 'standings';
      else if (role === 'manager')    aspect = 'overall';
      else                            aspect = 'profile';
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

// availableSlots からデフォルト初期選択（priority 上位 N 件）を作る
function _pickDefaultSelection(availableSlots, n = 5) {
  return availableSlots
    .slice()
    .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    .slice(0, n)
    .map(s => s.key);
}

// メタ取得：walker 経由で全 leaf を列挙
//   - subject=match の場合は role='match' で walker
//   - comparison は buildPairsForCompare で {leftValue, rightValue} に
function getBindingMeta(mod, siData) {
  const inferred = inferBindingForMod(mod, siData);
  if (!inferred) return null;
  const { subject, aspect, primary, secondary } = inferred;

  const primaryData = _findEntityData(siData, subject, primary);
  if (!primaryData) return null;

  // 比較判定：mod.type === 'comparison' AND secondary が解決できる
  const isCompare = mod.type === 'comparison' && !!secondary;
  let secondaryData = null;
  if (isCompare) {
    secondaryData = _findEntityData(siData, subject, secondary);
    if (!secondaryData) return null;
  }

  // walker dispatch role
  const role = subject === 'match' ? 'match' : subject;

  let availableSlots;
  if (isCompare) {
    availableSlots = buildPairsForCompare(primaryData, secondaryData, role);
  } else {
    availableSlots = walkEntity(primaryData, role).map(s => ({
      key:      s.key,
      label:    s.label,
      category: s.category,
      priority: s.priority,
      source:   s.source,
      value:    s.value,
    }));
  }

  if (!availableSlots.length) return null;

  // 利用可能レシピ（walker キーセットを基に）
  const recipes = applicableRecipes(
    isCompare ? availableSlots.map(s => ({ key: s.key })) : availableSlots,
    role,
    isCompare
  );

  return {
    subject, aspect,
    primary, secondary, primaryData, secondaryData,
    isCompare,
    availableSlots,
    defaultSelection: _pickDefaultSelection(availableSlots, isCompare ? 5 : 5),
    recipes,         // 使えるレシピリスト [{key, label, description, keys}]
  };
}

// メタ + customSlotKeys → mod.dataSlots を構築
//   isCompare: [{slotKey, label, leftValue, rightValue}]
//   non-compare: [{slotKey, label, value}]
function buildDataSlotsFromMeta(meta, customSlotKeys) {
  if (!meta || !Array.isArray(customSlotKeys)) return [];
  const map = new Map(meta.availableSlots.map(s => [s.key, s]));
  return customSlotKeys.map(k => {
    const s = map.get(k);
    if (!s) return null;
    if (meta.isCompare) {
      return { slotKey: k, label: s.label, leftValue: s.leftValue, rightValue: s.rightValue };
    }
    return { slotKey: k, label: s.label, value: s.value };
  }).filter(Boolean);
}

// recipeKey が指定されていれば walker 出力に展開、無ければ既存 customSlotKeys
//   AI 出力の mod を受け取り「最終的な customSlotKeys 配列」を返す
function resolveCustomSlotKeys(meta, mod) {
  // 優先1: AI が customSlotKeys を直接指定
  if (Array.isArray(mod?.customSlotKeys) && mod.customSlotKeys.length) {
    return { keys: mod.customSlotKeys, source: 'custom' };
  }
  // 優先2: AI が recipeKey を指定 → 展開
  if (mod?.recipeKey && hasRecipe(mod.recipeKey)) {
    const expanded = expandRecipe(mod.recipeKey, meta.availableSlots);
    if (expanded?.length) return { keys: expanded, source: 'recipe:' + mod.recipeKey };
  }
  // フォールバック: defaultSelection
  return { keys: meta.defaultSelection || [], source: 'default' };
}

module.exports = {
  getBindingMeta,
  inferBindingForMod,
  buildDataSlotsFromMeta,
  resolveCustomSlotKeys,
};
