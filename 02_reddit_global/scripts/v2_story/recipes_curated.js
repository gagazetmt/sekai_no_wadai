// scripts/v2_story/recipes_curated.js
// ═══════════════════════════════════════════════════════════════
// curated recipes：「よくある引用パターン」を walker キーの組合せで定義
// ═══════════════════════════════════════════════════════════════
//
// 旧 recipes.js（撤廃済）と違い、データ抽出ロジックは持たない。
// あくまで「walker キーの並びを名前で束ねたもの」。
// データ取得層は walker (si_walker.js) が一手に担当。
//
// AI はレシピ名を選ぶだけで dataSlots が組み上がる（推奨）。
// 単発の特殊ケースは customSlotKeys で個別指定（ベース walker から自由）。
//
// 公開 API:
//   applicableRecipes(walkerSlots, role, hasSecondary?) → [{key, label, description, keys}]
//   expandRecipe(recipeKey, walkerSlots) → ['k1','k2',...] | null
//
// ═══════════════════════════════════════════════════════════════

'use strict';

const RECIPES = {

  /* ──────── 選手：単体 / プロフィール ──────── */

  'player.profile_basic': {
    label: '選手プロフィール基本',
    description: '初出スライド向け（年齢/国籍/所属/ポジション/市場価値/契約）',
    keys: ['age', 'nationality', 'team', 'position', 'marketValue', 'contractUntil'],
    appliesTo: { role: ['player'] },
  },

  /* ──────── 選手：試合スタッツ（ポジション別） ──────── */

  'player.fw_match_stats': {
    label: 'FW試合スタッツ',
    description: '点取り屋目線の今季総合（ゴール/アシスト/シュート/xG/ドリブル/評定）',
    keys: ['minutes', 'goals', 'assists', 'totalShots', 'shotsOnTarget',
           'xG', 'passAcc', 'successfulDribbles', 'rating'],
    appliesTo: { role: ['player'] },
  },

  'player.mf_match_stats': {
    label: 'MF試合スタッツ',
    description: '中盤目線（パス/キーパス/タックル/デュエル/評定）',
    keys: ['minutes', 'passAcc', 'keyPasses', 'bigChancesCreated',
           'tackles', 'interceptions', 'successfulDribbles', 'rating'],
    appliesTo: { role: ['player'] },
  },

  'player.df_match_stats': {
    label: 'DF試合スタッツ',
    description: '守備陣目線（タックル/インターセプト/クリア/デュエル/評定）',
    keys: ['minutes', 'ps_tackles', 'ps_interceptions', 'ps_clearances',
           'ps_duelsWon', 'passAcc', 'goals', 'rating'],
    appliesTo: { role: ['player'] },
  },

  'player.gk_match_stats': {
    label: 'GK試合スタッツ',
    description: 'GK目線（セーブ/完封/ゴール阻止/失点/評定）',
    keys: ['minutes', 'ps_saves', 'ps_cleanSheets', 'ps_goalsPrevented',
           'cleanSheets', 'rating'],
    appliesTo: { role: ['player'] },
  },

  /* ──────── 選手：シーズン推移 ──────── */

  'player.season_trend5': {
    label: '過去5シーズン推移（直近5年×3項目）',
    description: '直近5シーズンのリーグ成績を時系列で並べる（試合・G・A）',
    keys: ['season_1_apps', 'season_1_goals', 'season_1_assists',
           'season_2_apps', 'season_2_goals', 'season_2_assists',
           'season_3_apps', 'season_3_goals', 'season_3_assists',
           'season_4_apps', 'season_4_goals', 'season_4_assists',
           'season_5_apps', 'season_5_goals', 'season_5_assists'],
    appliesTo: { role: ['player'] },
    requires: ['seasonHistory'],
  },

  'player.season_summary5': {
    label: '過去5シーズン要約',
    description: '直近5シーズンの「試合 G A 評定」を1行ずつ',
    keys: ['season_1_summary', 'season_2_summary', 'season_3_summary',
           'season_4_summary', 'season_5_summary'],
    appliesTo: { role: ['player'] },
    requires: ['seasonHistory'],
  },

  /* ──────── 選手：来歴・移籍 ──────── */

  'player.career_pro_full': {
    label: 'プロ来歴フル（移籍履歴+移籍金）',
    description: 'プロ加入年×クラブ×移籍金の年表（最大8件）',
    keys: ['transfer_1', 'transfer_2', 'transfer_3', 'transfer_4',
           'transfer_5', 'transfer_6', 'transfer_7', 'transfer_8'],
    appliesTo: { role: ['player'] },
    requires: ['transferHistory'],
  },

  /* ──────── 選手：代表チーム ──────── */

  'player.national_team_summary': {
    label: '代表チーム総合',
    description: '代表通算成績＋大会別エピソード（W杯・大陸選手権 etc）',
    keys: ['nat_team', 'nat_apps', 'nat_goals', 'nat_assists',
           'nat_tour_1', 'nat_tour_2', 'nat_tour_3'],
    appliesTo: { role: ['player'] },
    requires: ['nationalTeam'],
  },

  /* ──────── 選手：比較 ──────── */

  'comparison.player_season': {
    label: '選手 今季比較',
    description: '2選手の今季主要5項目（G/A/評定/xG/キーパス）',
    keys: ['goals', 'assists', 'rating', 'xG', 'keyPasses'],
    appliesTo: { role: ['player'], requiresSecondary: true },
  },

  'comparison.player_career_titles': {
    label: '選手 通算タイトル比較',
    description: '2選手のキャリア通算（市場価値/年齢/CL得点/CL評定）',
    keys: ['marketValue', 'age', 'uclGoals', 'uclRating', 'rating'],
    appliesTo: { role: ['player'], requiresSecondary: true },
  },

  /* ──────── チーム ──────── */

  'team.season_overall': {
    label: 'チーム今季基本',
    description: '順位/勝点/勝敗/得失点/直近フォーム',
    keys: ['position', 'points', 'wdlStr', 'gf', 'ga', 'gd', 'recentForm'],
    appliesTo: { role: ['team'] },
  },

  'team.recent_form': {
    label: 'チーム直近フォーム',
    description: '直近5戦+勝敗内訳',
    keys: ['recentForm', 'last_1', 'last_2', 'last_3', 'last5wins', 'last5losses'],
    appliesTo: { role: ['team'] },
  },

  'team.titles_summary': {
    label: 'チーム獲得タイトル',
    description: '通算タイトル数の内訳（リーグ/カップ/CL/UEFA Super/Club W杯）',
    keys: ['totalTrophies', 'leagueTitles', 'cupTitles', 'clTitles', 'uefaSuper', 'worldClub'],
    appliesTo: { role: ['team'] },
  },

  'team.top_players_season': {
    label: 'チーム今季エース',
    description: '得点・アシスト・評定 各上位3選手',
    keys: ['topScorer_1', 'topScorer_2', 'topScorer_3',
           'topAssist_1', 'topAssist_2', 'topRated_1'],
    appliesTo: { role: ['team'] },
  },

  /* ──────── チーム：比較 ──────── */

  'comparison.team_season': {
    label: 'チーム 今季比較',
    description: '2チームの順位/勝点/守備力/攻撃力',
    keys: ['position', 'points', 'wdlStr', 'avgGoalsScored', 'avgGoalsConceded'],
    appliesTo: { role: ['team'], requiresSecondary: true },
  },

  /* ──────── 監督 ──────── */

  'manager.career_overall': {
    label: '監督通算成績',
    description: '通算試合/勝率/P/G/獲得タイトル数',
    keys: ['totalMatches', 'overallWinRate', 'overallWdl', 'pointsPerGame', 'totalTrophies'],
    appliesTo: { role: ['manager'] },
  },

  'manager.current_team': {
    label: '監督 現所属チーム成績',
    description: '在任中のチームでの直近成績（勝率・勝敗内訳）',
    keys: ['currentTeam', 'curTeamSample', 'curTeamWins', 'curTeamLosses',
           'curTeamWinRate', 'curTeamWdl'],
    appliesTo: { role: ['manager'] },
  },

  /* ──────── 監督：比較 ──────── */

  'comparison.manager_career': {
    label: '監督通算比較',
    description: '2監督の通算成績対決（試合/勝率/P/G/CL優勝/現所属勝率）',
    keys: ['totalMatches', 'overallWinRate', 'pointsPerGame', 'clTitles', 'curTeamWinRate'],
    appliesTo: { role: ['manager'], requiresSecondary: true },
  },

  /* ──────── 大会 ──────── */

  'tournament.standings_top5': {
    label: '大会順位表 上位5+優勝争い',
    description: '順位表 1-5位 + 優勝争い 1-3位',
    keys: ['standing_1', 'standing_2', 'standing_3', 'standing_4', 'standing_5',
           'titleRace_1', 'titleRace_2', 'titleRace_3'],
    appliesTo: { role: ['tournament'] },
  },

  'tournament.top_individual': {
    label: '大会個人タイトル争い',
    description: '得点王・アシスト王・評定TOP3',
    keys: ['topScorer_1', 'topScorer_2', 'topScorer_3',
           'topAssist_1', 'topAssist_2', 'topRated_1'],
    appliesTo: { role: ['tournament'] },
  },

  'tournament.race_breakdown': {
    label: '大会 出場権争い',
    description: '優勝争い・CL圏・降格圏 各上位',
    keys: ['titleRace_1', 'titleRace_2', 'titleRace_3',
           'clRace_1', 'clRace_2', 'relegationRace_1'],
    appliesTo: { role: ['tournament'] },
  },
};

// ─── 「このエンティティで使えるレシピ」を絞り込む ─────
//   walkerSlots 出力に必要 family が含まれてないレシピは除外
//   role が match しないレシピは除外
//   requiresSecondary レシピは hasSecondary=true の場合のみ提示
function applicableRecipes(walkerSlots, role, hasSecondary = false) {
  const slotKeys = new Set((walkerSlots || []).map(s => s.key));
  return Object.entries(RECIPES)
    .filter(([_, r]) => r.appliesTo.role.includes(role))
    .filter(([_, r]) => !!r.appliesTo.requiresSecondary === hasSecondary)
    .filter(([_, r]) => {
      if (!Array.isArray(r.requires)) return true;
      return r.requires.every(req => {
        if (req === 'seasonHistory')   return slotKeys.has('season_1_summary');
        if (req === 'transferHistory') return slotKeys.has('transfer_1');
        if (req === 'nationalTeam')    return slotKeys.has('nat_team');
        return true;
      });
    })
    .map(([key, r]) => ({
      key,
      label: r.label,
      description: r.description,
      keys: r.keys.slice(),  // shallow copy
    }));
}

// ─── recipeKey → walker キー配列に展開 ─────────────────
//   walker に存在しないキーは除外（古いデータ対応）
function expandRecipe(recipeKey, walkerSlots) {
  const r = RECIPES[recipeKey];
  if (!r) return null;
  const slotKeys = new Set((walkerSlots || []).map(s => s.key));
  return r.keys.filter(k => slotKeys.has(k));
}

// ─── レシピ存在確認 ─────────────────────────────
function hasRecipe(recipeKey) {
  return !!RECIPES[recipeKey];
}

module.exports = {
  RECIPES,
  applicableRecipes,
  expandRecipe,
  hasRecipe,
};
