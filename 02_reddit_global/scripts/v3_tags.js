// scripts/v3_tags.js
// ═══════════════════════════════════════════════════════════
// V3: メインタグ + type 解決ヘルパー
// ═══════════════════════════════════════════════════════════
//
// 旧 V3 では「メイン × 従(sub)」の二段構造で type を決定していたが、
// AI 主導（propose-modules / generate-scenario）に移行後は AI が type を
// 直接書くため sub レイヤーは不要になり、2026-05-02 完全撤去。
//
// 構造:
//   - mainKey は  'opening' | 'toc' | 'overview' | 'reaction' | 'ending'
//                 'entity:<label>' | 'match:<label>' | 'matchcard:<label>'
//   - resolveType(mainKey, siData, aiType?) で type を決定:
//       fixed タグ → 固定 type
//       matchcard:* → 'matchcard'
//       それ以外    → aiType 採用、なければ 'insight'

'use strict';

const ROLE_SUFFIX = { player: '選手', manager: '監督', team: 'チーム', tournament: '大会' };

// 固定メインタグ（type 直接決定）
const FIXED_MAIN_TAGS = [
  { key: 'opening',  label: 'オープニング', type: 'opening'  },
  { key: 'toc',      label: '目次',         type: 'toc'      },
  { key: 'overview', label: '概要説明',     type: 'insight'  },
  { key: 'reaction', label: 'リアクション', type: 'reaction' },
  { key: 'ending',   label: 'エンディング', type: 'ending'   },
];

// メインキー文字列を解析
function parseMainKey(mainKey, siData) {
  const fixed = FIXED_MAIN_TAGS.find(t => t.key === mainKey);
  if (fixed) return { kind: 'fixed', def: fixed };
  if (typeof mainKey === 'string' && mainKey.startsWith('entity:')) {
    const label = mainKey.slice(7);
    const e = (siData?.boxes?.entity?.items || []).find(x => x.label === label);
    return { kind: 'entity', label, role: e?.role || 'player', item: e };
  }
  if (typeof mainKey === 'string' && mainKey.startsWith('matchcard:')) {
    const label = mainKey.slice(10);
    const m = (siData?.boxes?.match?.items || []).find(x => x.label === label);
    return { kind: 'matchcard', label, item: m };
  }
  if (typeof mainKey === 'string' && mainKey.startsWith('match:')) {
    const label = mainKey.slice(6);
    const m = (siData?.boxes?.match?.items || []).find(x => x.label === label);
    return { kind: 'match', label, item: m };
  }
  return { kind: 'unknown' };
}

// メイン+AI由来type から type を決定
//   優先順位: ① fixed/matchcard 確定型 → ② AI 直接指定の type → ③ 'insight'
const VALID_TYPES = new Set(['opening','ending','toc','insight','stats','profile','comparison','history','reaction','matchcard','matchcenter']);
function resolveType(mainKey, siData, aiType) {
  const p = parseMainKey(mainKey, siData);
  if (p.kind === 'fixed')     return p.def.type;
  if (p.kind === 'matchcard') return 'matchcard';
  if (aiType && VALID_TYPES.has(aiType)) return aiType;
  return 'insight';
}

// メインタグ一覧（プルダウン用）
function listMainTags(siData) {
  const list = FIXED_MAIN_TAGS.map(t => ({ key: t.key, label: t.label, kind: 'fixed' }));
  (siData?.boxes?.entity?.items || []).forEach(e => {
    const role = e.role || 'player';
    list.push({
      key:   'entity:' + e.label,
      label: e.label + ' [' + (ROLE_SUFFIX[role] || role) + ']',
      kind:  'entity',
      role,
    });
  });
  (siData?.boxes?.match?.items || []).forEach(m => {
    list.push({
      key:   'match:' + m.label,
      label: m.label + ' [試合]',
      kind:  'match',
    });
    list.push({
      key:   'matchcard:' + m.label,
      label: m.label + ' [マッチカード]',
      kind:  'matchcard',
    });
  });
  return list;
}

module.exports = {
  ROLE_SUFFIX,
  FIXED_MAIN_TAGS,
  VALID_TYPES,
  parseMainKey,
  resolveType,
  listMainTags,
};
