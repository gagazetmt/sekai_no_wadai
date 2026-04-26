// scripts/v3_tags.js
// ═══════════════════════════════════════════════════════════
// V3: 主タグ × 従タグ マッピング定数 + 解決ヘルパー
// ═══════════════════════════════════════════════════════════

const ROLE_SUFFIX = { player: '選手', manager: '監督', team: 'チーム', tournament: '大会' };

// 固定メインタグ（従タグ無し、type 直接決定）
const FIXED_MAIN_TAGS = [
  { key: 'opening',  label: 'オープニング', type: 'opening'  },
  { key: 'toc',      label: '目次',         type: 'insight'  },
  { key: 'overview', label: '概要説明',     type: 'insight'  },
  { key: 'reaction', label: 'リアクション', type: 'reaction' },
  { key: 'ending',   label: 'エンディング', type: 'ending'   },
];

// 動的メインタグ用サブタグマップ
// key: <data source>.<role> → 従タグリスト [{value, label, type}]
const SUB_TAGS_BY_KEY = {
  // === wiki系（歴史・エピソード・タイトル） ===
  'wiki.player': [
    { value: 'history',     label: '来歴',         type: 'history' },
    { value: 'episode',     label: 'エピソード',   type: 'insight' },
    { value: 'titles',      label: '獲得タイトル', type: 'stats'   },
    { value: 'club_stats',  label: 'チーム毎成績', type: 'stats'   },
  ],
  'wiki.manager': [
    { value: 'history',     label: '来歴',         type: 'history' },
    { value: 'episode',     label: 'エピソード',   type: 'insight' },
    { value: 'titles',      label: '獲得タイトル', type: 'stats'   },
    { value: 'club_stats',  label: 'チーム毎成績', type: 'stats'   },
  ],
  'wiki.team': [
    { value: 'history',     label: '来歴',           type: 'history' },
    { value: 'episode',     label: 'エピソード',     type: 'insight' },
    { value: 'titles',      label: '獲得タイトル',   type: 'stats'   },
    { value: 'profile',     label: '基本情報',       type: 'stats'   },
    { value: 'manager_hist',label: '過去の監督歴',   type: 'history' },
  ],
  'wiki.tournament': [
    { value: 'history',     label: '来歴',             type: 'history' },
    { value: 'episode',     label: 'エピソード',       type: 'insight' },
    { value: 'rules',       label: 'レギュレーション', type: 'stats'   },
  ],
  // === sofa系（現在のスタッツ・比較） ===
  'sofa.player': [
    { value: 'profile',     label: '基本情報',       type: 'stats'      },
    { value: 'season',      label: '今季スタッツ',   type: 'stats'      },
    { value: 'match',       label: '今試合スタッツ', type: 'stats'      },
    { value: 'compare',     label: '比較対象',       type: 'comparison' },
  ],
  'sofa.manager': [
    { value: 'profile',     label: '基本情報',     type: 'stats'      },
    { value: 'season',      label: '今季スタッツ', type: 'stats'      },
    { value: 'compare',     label: '比較対象',     type: 'comparison' },
    { value: 'history',     label: '監督歴',       type: 'history'    },
  ],
  'sofa.team': [
    { value: 'profile',     label: '基本情報',       type: 'stats'      },
    { value: 'season',      label: '今季成績',       type: 'stats'      },
    { value: 'match',       label: '今試合スタッツ', type: 'stats'      },
    { value: 'compare',     label: '比較対象',       type: 'comparison' },
  ],
  // === match系 ===
  'sofa.match': [
    { value: 'match_stats',     label: '試合スタッツ', type: 'matchcard'  },
    { value: 'team_compare',    label: 'チーム比較',   type: 'comparison' },
    { value: 'player_compare',  label: '選手比較',     type: 'comparison' },
    { value: 'manager_compare', label: '監督比較',     type: 'comparison' },
  ],
};

// メインキー文字列を解析
//   'opening' / 'toc' / ...      → fixed
//   'entity:<label>'             → entity (role は siData から取得)
//   'match:<label>'              → match (従タグ必要)
//   'matchcenter:<label>'        → matchcenter (従タグ不要、type=matchcenter固定)
function parseMainKey(mainKey, siData) {
  const fixed = FIXED_MAIN_TAGS.find(t => t.key === mainKey);
  if (fixed) return { kind: 'fixed', def: fixed };
  if (typeof mainKey === 'string' && mainKey.startsWith('entity:')) {
    const label = mainKey.slice(7);
    const e = (siData?.boxes?.entity?.items || []).find(x => x.label === label);
    return { kind: 'entity', label, role: e?.role || 'player', item: e };
  }
  if (typeof mainKey === 'string' && mainKey.startsWith('matchcenter:')) {
    const label = mainKey.slice(12);
    const m = (siData?.boxes?.match?.items || []).find(x => x.label === label);
    return { kind: 'matchcenter', label, item: m };
  }
  if (typeof mainKey === 'string' && mainKey.startsWith('match:')) {
    const label = mainKey.slice(6);
    const m = (siData?.boxes?.match?.items || []).find(x => x.label === label);
    return { kind: 'match', label, item: m };
  }
  return { kind: 'unknown' };
}

// メインタグから「使える従タグリスト」を返す（source付き）
function getSubTagsForMain(mainKey, siData) {
  const p = parseMainKey(mainKey, siData);
  if (p.kind === 'fixed') return [];
  if (p.kind === 'entity') {
    const wikiSubs = SUB_TAGS_BY_KEY['wiki.' + p.role] || [];
    const sofaSubs = SUB_TAGS_BY_KEY['sofa.' + p.role] || [];
    // sofa側は実データ無ければ除外（player/manager/team のみ判定、tournament は元から無い）
    const hasSofa = !!p.item?.sofa?.ok;
    return [
      ...wikiSubs.map(s => ({ ...s, source: 'wiki' })),
      ...(hasSofa ? sofaSubs.map(s => ({ ...s, source: 'sofa' })) : []),
    ];
  }
  if (p.kind === 'match') {
    return (SUB_TAGS_BY_KEY['sofa.match'] || []).map(s => ({ ...s, source: 'sofa' }));
  }
  if (p.kind === 'matchcenter') return [];
  return [];
}

// メイン+サブ から type を決定
function resolveType(mainKey, subSource, subValue, siData) {
  const p = parseMainKey(mainKey, siData);
  if (p.kind === 'fixed')       return p.def.type;
  if (p.kind === 'matchcenter') return 'matchcenter';
  const subs = getSubTagsForMain(mainKey, siData);
  const hit = subs.find(s => s.source === subSource && s.value === subValue);
  return hit?.type || 'insight';
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
      key:   'matchcenter:' + m.label,
      label: m.label + ' [マッチセンター]',
      kind:  'matchcenter',
    });
  });
  return list;
}

module.exports = {
  ROLE_SUFFIX,
  FIXED_MAIN_TAGS,
  SUB_TAGS_BY_KEY,
  parseMainKey,
  getSubTagsForMain,
  resolveType,
  listMainTags,
};
