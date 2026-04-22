// scripts/stat_presets.js
// type1/type2スライド用プリセットデータ定義

const STAT_PRESETS = {

  // ─── 選手 ────────────────────────────────────────────────────────────────────
  player: [
    // 成績
    { key: 'season_summary',    label: '今期成績（G+A）',    get: d => { const s=d.seasonStats||{}; return `${s.appearances??'?'}試合 ${s.goals??'?'}G ${s.assists??'?'}A`; } },
    { key: 'goals',             label: '今期ゴール',          get: d => d.seasonStats?.goals != null ? `${d.seasonStats.goals}点` : null },
    { key: 'assists',           label: '今期アシスト',        get: d => d.seasonStats?.assists != null ? `${d.seasonStats.assists}本` : null },
    { key: 'goal_assist_total', label: 'G+A 合計',           get: d => { const s=d.seasonStats||{}; const n=(s.goals??0)+(s.assists??0); return n>0?`${n}`:null; } },
    { key: 'appearances',       label: '出場試合数',          get: d => d.seasonStats?.appearances != null ? `${d.seasonStats.appearances}試合` : null },
    { key: 'minutes_played',    label: 'プレー時間',          get: d => d.seasonStats?.minutesPlayed != null ? `${d.seasonStats.minutesPlayed}分` : null },
    { key: 'goals_per90',       label: '90分換算得点',        get: d => { const s=d.seasonStats||{}; if(s.goals&&s.minutesPlayed) return (s.goals/s.minutesPlayed*90).toFixed(2)+'点'; return null; } },
    { key: 'ga_per90',          label: '90分換算G+A',        get: d => { const s=d.seasonStats||{}; if((s.goals||s.assists)&&s.minutesPlayed) return (((s.goals||0)+(s.assists||0))/s.minutesPlayed*90).toFixed(2); return null; } },
    // 精度・分析
    { key: 'expected_goals',    label: '今期xG',             get: d => d.seasonStats?.expectedGoals != null ? `${d.seasonStats.expectedGoals}` : null },
    { key: 'key_passes',        label: 'キーパス',            get: d => d.seasonStats?.keyPasses != null ? `${d.seasonStats.keyPasses}本` : null },
    { key: 'shots_on_target',   label: '枠内シュート率',      get: d => d.positionStats?.shotAccuracy != null ? `${d.positionStats.shotAccuracy}%` : null },
    { key: 'pass_accuracy',     label: 'パス成功率',          get: d => d.positionStats?.passSuccessRate != null ? `${d.positionStats.passSuccessRate}%` : null },
    { key: 'dribbles',          label: '成功ドリブル',        get: d => d.positionStats?.successfulDribbles != null ? `${d.positionStats.successfulDribbles}回` : null },
    { key: 'tackles',           label: 'タックル成功',        get: d => d.positionStats?.tackles != null ? `${d.positionStats.tackles}回` : null },
    { key: 'aerials',           label: '空中戦勝率',          get: d => d.positionStats?.aerialWon != null ? `${d.positionStats.aerialWon}%` : null },
    { key: 'saves',             label: 'セーブ数（GK用）',    get: d => d.positionStats?.saves != null ? `${d.positionStats.saves}回` : null },
    // 評価
    { key: 'rating',            label: '平均評価点',          get: d => d.seasonStats?.rating != null ? `${d.seasonStats.rating}` : null },
    { key: 'recent_rating',     label: '直近平均評価点',      get: d => d.recentAvgRating ? `${d.recentAvgRating}（直近${d.recentMatchCount}試合）` : null },
    // プロフィール
    { key: 'market_value',      label: '市場価値',            get: d => d.marketValue || null },
    { key: 'contract_until',    label: '契約終了',            get: d => d.contractUntil ? `〜${d.contractUntil}` : null },
    { key: 'nationality',       label: '国籍',                get: d => d.nationality || null },
    { key: 'height',            label: '身長',                get: d => d.height ? `${d.height}cm` : null },
    { key: 'age',               label: '年齢',                get: d => d.age ? `${d.age}歳` : null },
    { key: 'position',          label: 'ポジション',          get: d => d.position || null },
    { key: 'team',              label: '所属クラブ',          get: d => d.team || null },
    { key: 'league',            label: 'リーグ',              get: d => [d.leagueName, d.seasonYear].filter(Boolean).join(' ') || null },
    // 欧州大会
    { key: 'ucl_summary',           label: 'CL成績（G+A）',      get: d => d.uclStats ? `${d.uclStats.appearances}試合 ${d.uclStats.goals}G ${d.uclStats.assists}A` : null },
    { key: 'ucl_rating',            label: 'CL平均評価点',       get: d => d.uclStats?.rating != null ? `${d.uclStats.rating}` : null },
    // プロフィール追加項目
    { key: 'player_name',           label: '氏名',               get: d => d.name || null },
    { key: 'shirt_number',          label: '背番号',              get: d => d.shirtNumber != null ? `${d.shirtNumber}番` : null },
    { key: 'weight',                label: '体重',               get: d => d.weight ? `${d.weight}kg` : null },
    // 代表関連
    { key: 'national_team',         label: '代表国',              get: d => d.nationality || null },
    { key: 'national_caps',         label: '代表試合数',          get: d => d.nationalStats?.appearances != null ? `${d.nationalStats.appearances}試合` : null },
    { key: 'national_ga',           label: '代表GOAL&ASSIST',    get: d => d.nationalStats ? `${d.nationalStats.goals??'?'}G ${d.nationalStats.assists??'?'}A` : null },
    { key: 'national_avg_rating',   label: '代表平均評価点',      get: d => d.nationalStats?.rating != null ? `${d.nationalStats.rating}` : null },
    { key: 'national_shirt_number', label: '代表背番号',          get: d => d.nationalShirtNumber != null ? `${d.nationalShirtNumber}番` : null },
  ],

  // ─── 監督 ────────────────────────────────────────────────────────────────────
  manager: [
    { key: 'win_record',        label: '今季成績（勝分負）',  get: d => { const r=d.manager?.record; if(!r) return null; const t=(r.wins||0)+(r.draws||0)+(r.losses||0); return `${t}試合 ${r.wins??'?'}勝${r.draws??'?'}分${r.losses??'?'}敗`; } },
    { key: 'win_rate',          label: '勝率',                get: d => { const r=d.manager?.record; if(!r) return null; const t=(r.wins||0)+(r.draws||0)+(r.losses||0); return t?`${Math.round((r.wins||0)/t*100)}%`:null; } },
    { key: 'goals_per_game',    label: '1試合平均得点',       get: d => d.team?.avgGoalsScored != null ? `${d.team.avgGoalsScored}点` : null },
    { key: 'conceded_per_game', label: '1試合平均失点',       get: d => d.team?.avgGoalsConceded != null ? `${d.team.avgGoalsConceded}点` : null },
    { key: 'clean_sheets',      label: 'クリーンシート数',    get: d => d.team?.cleanSheets != null ? `${d.team.cleanSheets}試合` : null },
    { key: 'possession_avg',    label: '平均ポゼッション',    get: d => d.team?.avgBallPossession != null ? `${d.team.avgBallPossession}%` : null },
    { key: 'xg_for',            label: '平均xG（攻撃）',     get: d => d.team?.avgExpectedGoals != null ? `${d.team.avgExpectedGoals}` : null },
    { key: 'shots_per_game',    label: '1試合平均シュート',   get: d => d.team?.avgTotalShots != null ? `${d.team.avgTotalShots}本` : null },
    { key: 'formation',         label: '主採用フォーメーション', get: d => d.manager?.preferredFormation || null },
    { key: 'appointed',         label: '就任日',              get: d => d.manager?.appointed || null },
    { key: 'nationality',       label: '監督国籍',            get: d => d.manager?.nationality || null },
    { key: 'age',               label: '監督年齢',            get: d => d.manager?.age ? `${d.manager.age}歳` : null },
    { key: 'home_record',       label: 'ホーム成績',          get: () => null },
    { key: 'away_record',       label: 'アウェイ成績',        get: () => null },
    { key: 'european_record',   label: '欧州カップ成績',      get: () => null },
    { key: 'title_history',     label: '獲得タイトル',        get: () => null },
    { key: 'prev_clubs',        label: '指導履歴',            get: () => null },
    { key: 'contract_end',      label: '契約終了',            get: () => null },
    { key: 'recent_form',       label: '直近5試合成績',       get: d => (d.team?.last5||[]).length ? d.team.last5.map(r=>r.result==='W'?'○':r.result==='D'?'△':'●').join('') : null },
    { key: 'team_league_pos',   label: 'リーグ順位',          get: d => d.team?.standing?.position ? `第${d.team.standing.position}位` : null },
  ],

  // ─── 試合 ────────────────────────────────────────────────────────────────────
  match: [
    { key: 'scoreline',         label: 'スコア',              get: d => d.scoreline || null },
    { key: 'scorers',           label: '得点経緯',            get: d => (d.goals||[]).length ? d.goals.map(g=>`${g.timeStr}' ${g.player}`).join(' / ') : null },
    { key: 'top_player',        label: 'MVP',                 get: d => d.topPlayers?.[0] ? `${d.topPlayers[0].name}（${d.topPlayers[0].rating}）` : null },
    { key: 'top2_players',      label: '評価点上位2名',       get: d => (d.topPlayers||[]).slice(0,2).map(p=>`${p.name} ${p.rating}`).join(' / ') || null },
    { key: 'possession',        label: 'ポゼッション',        get: d => { const s=d.stats?.['Ball possession']; if(!s) return null; const h=String(s.home??'?').replace('%',''); const a=String(s.away??'?').replace('%',''); return `${h}% vs ${a}%`; } },
    { key: 'total_shots',       label: 'シュート数',          get: d => { const s=d.stats?.['Total shots']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'shots_on_target',   label: '枠内シュート',        get: d => { const s=d.stats?.['Shots on target']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'xg',                label: 'xG',                 get: d => { const s=d.stats?.['Expected goals']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'passes',            label: 'パス本数',            get: d => { const s=d.stats?.['Passes']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'pass_accuracy',     label: 'パス精度',            get: d => { const s=d.stats?.['Accurate passes']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'fouls',             label: 'ファウル',            get: d => { const s=d.stats?.['Fouls']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'corners',           label: 'コーナーキック',      get: d => { const s=d.stats?.['Corner kicks']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'yellow_cards',      label: 'イエローカード',      get: d => { const s=d.stats?.['Yellow cards']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'red_cards',         label: 'レッドカード',        get: d => { const s=d.stats?.['Red cards']; return s?`${s.home??'?'} vs ${s.away??'?'}`:null; } },
    { key: 'red_card_players',  label: '退場者',              get: d => (d.incidents||[]).filter(e=>e.incidentType==='card'&&e.cardType==='red').map(e=>e.player?.name||'').filter(Boolean).join(', ') || null },
    { key: 'h2h',               label: '直接対決（H2H）',    get: d => d.h2hSummary || null },
    { key: 'match_date',        label: '試合日',              get: d => d.matchDate || null },
    { key: 'tournament',        label: '大会名',              get: d => d.tournament || null },
    { key: 'venue',             label: 'スタジアム',          get: d => d.venue || null },
    { key: 'attendance',        label: '観衆',                get: d => d.attendance?`${Number(d.attendance).toLocaleString()}人`:null },
    { key: 'last5_home',        label: 'ホーム直近成績',      get: d => d.homeTeamLast5 || null },
    { key: 'last5_away',        label: 'アウェイ直近成績',    get: d => d.awayTeamLast5 || null },
    { key: 'h2h_last5',         label: 'H2H直近5試合',        get: d => d.h2hSummary || null },
  ],

  // ─── チーム ──────────────────────────────────────────────────────────────────
  team: [
    { key: 'league_position',   label: 'リーグ順位',          get: d => d.standing?.position ? `第${d.standing.position}位` : null },
    { key: 'points',            label: 'ポイント',            get: d => d.standing?.points != null ? `${d.standing.points}pt` : null },
    { key: 'wdl',               label: '成績（勝分負）',      get: d => d.standing ? `${d.standing.wins??'?'}勝${d.standing.draws??'?'}分${d.standing.losses??'?'}敗` : null },
    { key: 'goals_for',         label: '総得点',              get: d => d.standing?.goalsFor != null ? `${d.standing.goalsFor}点` : null },
    { key: 'goals_against',     label: '総失点',              get: d => d.standing?.goalsAgainst != null ? `${d.standing.goalsAgainst}点` : null },
    { key: 'goal_diff',         label: '得失点差',            get: d => d.standing?.goalDifference != null ? `${d.standing.goalDifference>0?'+':''}${d.standing.goalDifference}` : null },
    { key: 'form',              label: '直近5試合',           get: d => (d.last5||[]).length ? d.last5.map(r=>r.result==='W'?'○':r.result==='D'?'△':'●').join('') : null },
    { key: 'team_name',         label: 'チーム名',            get: d => d.teamName || null },
    { key: 'season',            label: 'シーズン',            get: d => d.seasonYear || null },
    { key: 'home_record',       label: 'ホーム成績',          get: () => null },
    { key: 'away_record',       label: 'アウェイ成績',        get: () => null },
    { key: 'top_scorer',        label: 'トップスコアラー',    get: () => null },
    { key: 'clean_sheets',      label: 'クリーンシート数',    get: () => null },
    { key: 'avg_age',           label: '平均年齢',            get: () => null },
    { key: 'squad_value',       label: 'スカッド総額',        get: () => null },
    { key: 'ucl_position',      label: 'CL/ELグループ順位',  get: () => null },
    { key: 'coach_name',        label: '監督名',              get: () => null },
    { key: 'club_founded',      label: '設立年',              get: () => null },
    { key: 'titles',            label: '獲得タイトル',        get: () => null },
    { key: 'stadium',           label: '本拠地',              get: () => null },
    { key: 'league_name',       label: '所属リーグ',          get: d => d.leagueName || null },
    { key: 'legends',           label: 'レジェンド',          get: () => null },
  ],

  // ─── 移籍 ────────────────────────────────────────────────────────────────────
  transfer: [
    { key: 'transfer_fee',        label: '推定移籍金',          get: () => null },
    { key: 'from_club',           label: '移籍元チーム',        get: () => null },
    { key: 'to_club',             label: '移籍先チーム',        get: () => null },
    { key: 'from_to',             label: '移籍元→移籍先',       get: () => null },
    { key: 'contract_length',     label: '契約期間',            get: () => null },
    { key: 'weekly_wage',         label: '週給（推定）',        get: () => null },
    { key: 'annual_salary',       label: '年俸（推定）',        get: () => null },
    { key: 'transfer_type',       label: '移籍タイプ',          get: () => null },
    { key: 'remaining_contract',  label: '旧クラブ残余契約',    get: () => null },
    { key: 'release_clause',      label: '違約金',              get: () => null },
    { key: 'agent',               label: '代理人',              get: () => null },
    { key: 'competing_clubs',     label: '競合クラブ',          get: () => null },
    { key: 'announcement_date',   label: '発表日',              get: () => null },
    { key: 'shirt_number',        label: '背番号',              get: () => null },
    { key: 'transfer_history',    label: '過去の移籍',          get: () => null },
    { key: 'transfer_likelihood', label: '移籍可能性',          get: () => null },
    { key: 'prev_transfer_fee',   label: '前回移籍金',          get: () => null },
    { key: 'market_value',        label: '市場価値',            get: () => null },
  ],

  // ─── ケガ・コンディション ─────────────────────────────────────────────────────
  injury: [
    { key: 'injury_date',         label: 'ケガの発生日',        get: () => null },
    { key: 'injury_type',         label: 'ケガの部位・種類',    get: () => null },
    { key: 'absence_weeks',       label: '離脱期間',            get: () => null },
    { key: 'expected_return',     label: '復帰予定',            get: () => null },
    { key: 'season_appearances',  label: '今期の出場試合数',    get: d => d.seasonStats?.appearances != null ? `${d.seasonStats.appearances}試合` : null },
    { key: 'season_ga',           label: '今期の成績（G+A）',   get: d => d.seasonStats ? `${d.seasonStats.goals??'?'}G ${d.seasonStats.assists??'?'}A` : null },
    { key: 'injury_count',        label: '今季ケガ回数',        get: () => null },
    { key: 'missed_games',        label: '欠場試合数',          get: () => null },
    { key: 'surgery_needed',      label: '手術有無',            get: () => null },
    { key: 'prev_same_injury',    label: '同部位の前歴',        get: () => null },
    { key: 'severity',            label: '重症度',              get: () => null },
    { key: 'team_impact',         label: 'チームへの影響',      get: () => null },
    { key: 'replacement',         label: '代替選手',            get: () => null },
    { key: 'key_matches_missed',  label: '不在となる主要試合',  get: () => null },
    { key: 'return_training',     label: 'チーム練習復帰',      get: () => null },
    { key: 'injury_history',      label: '過去のケガ歴',        get: () => null },
  ],

  // ─── 選手×試合個人スタッツ ───────────────────────────────────────────────────
  player_match: [
    { key: 'pm_rating',           label: '評価点',              get: d => d.playerMatchStats?.rating != null ? `${d.playerMatchStats.rating}` : null },
    { key: 'pm_ga',               label: 'ゴール＆アシスト',    get: d => { const s=d.playerMatchStats; if(!s) return null; return `${s.goals??0}G ${s.assists??0}A`; } },
    { key: 'pm_minutes',          label: '出場時間',            get: d => d.playerMatchStats?.minutesPlayed != null ? `${d.playerMatchStats.minutesPlayed}分` : null },
    { key: 'pm_distance',         label: '走行距離',            get: d => d.playerMatchStats?.totalDistance != null ? `${d.playerMatchStats.totalDistance}km` : null },
    { key: 'pm_shots',            label: 'シュート',            get: d => d.playerMatchStats?.totalShots != null ? `${d.playerMatchStats.totalShots}本` : null },
    { key: 'pm_shots_on_target',  label: '枠内シュート',        get: d => d.playerMatchStats?.shotsOnTarget != null ? `${d.playerMatchStats.shotsOnTarget}本` : null },
    { key: 'pm_dribble_rate',     label: 'ドリブル成功率',      get: d => { const s=d.playerMatchStats; if(!s?.successfulDribbles||!s?.totalDribbles) return null; return `${Math.round(s.successfulDribbles/s.totalDribbles*100)}%`; } },
    { key: 'pm_pass_rate',        label: 'パス成功率',          get: d => d.playerMatchStats?.accuratePassesPercentage != null ? `${d.playerMatchStats.accuratePassesPercentage}%` : null },
    { key: 'pm_key_passes',       label: 'キーパス',            get: d => d.playerMatchStats?.keyPasses != null ? `${d.playerMatchStats.keyPasses}本` : null },
    { key: 'pm_interceptions',    label: 'インターセプト',      get: d => d.playerMatchStats?.interceptions != null ? `${d.playerMatchStats.interceptions}回` : null },
    { key: 'pm_tackles',          label: 'タックル',            get: d => d.playerMatchStats?.tackles != null ? `${d.playerMatchStats.tackles}回` : null },
    { key: 'pm_aerials',          label: '空中戦勝率',          get: d => { const s=d.playerMatchStats; if(!s?.aerialDuelsWon||!s?.aerialDuelsTotal) return null; return `${Math.round(s.aerialDuelsWon/s.aerialDuelsTotal*100)}%`; } },
  ],

  // ─── 汎用 ────────────────────────────────────────────────────────────────────
  general: [
    { key: 'ranking',           label: 'ランキング',          get: () => null },
    { key: 'record',            label: '記録・更新',          get: () => null },
    { key: 'comparison',        label: '比較データ',          get: () => null },
    { key: 'trend',             label: 'トレンド',            get: () => null },
    { key: 'competition',       label: '大会名',              get: () => null },
    { key: 'season',            label: 'シーズン',            get: () => '2024/25' },
    { key: 'date',              label: '日付',                get: () => new Date().toISOString().slice(0,10) },
    { key: 'source',            label: '情報元',              get: () => null },
    { key: 'custom1',           label: 'カスタム1',           get: () => null },
    { key: 'custom2',           label: 'カスタム2',           get: () => null },
    { key: 'custom3',           label: 'カスタム3',           get: () => null },
    { key: 'custom4',           label: 'カスタム4',           get: () => null },
  ],
};

// モジュールID → プリセットカテゴリ
const MODULE_TO_CATEGORY = {
  player_profile:      'player',
  player_stats:        'player',
  player_comparison:   'player',
  player_career:       'player',
  manager_profile:     'manager',
  tactical_analysis:   'manager',
  match_key_moment:    'match',
  match_stats:         'match',
  head_to_head:        'match',
  club_current_season: 'team',
  season_standings:    'team',
  club_profile:        'team',
  transfer_news:       'transfer',
  transfer_rumor:      'transfer',
  transfer_history:    'transfer',
  injury_news:         'injury',
  injury_update:       'injury',
};

// カテゴリ別：デフォルト表示する項目キー（上位6件）
const DEFAULT_ROW_KEYS = {
  player:   ['season_summary', 'rating',        'recent_rating',    'market_value',     'contract_until',  'ucl_summary'],
  manager:  ['win_record',     'win_rate',       'goals_per_game',   'conceded_per_game','possession_avg',  'formation'],
  match:    ['scoreline',      'h2h',            'last5_home',       'last5_away',       'possession',      'top_player'],
  team:     ['league_position','points',         'wdl',              'form',             'goals_for',       'goals_against'],
  transfer: ['transfer_fee',   'from_to',        'contract_length',  'weekly_wage',      'transfer_type',   'market_value'],
  injury:   ['injury_type',    'expected_return','absence_weeks',    'team_impact',      'missed_games',    'severity'],
  general:  ['custom1',        'custom2',        'custom3',          'custom4',          'custom5',         'custom6'],
};

function getCategory(moduleId) {
  return MODULE_TO_CATEGORY[moduleId] || 'general';
}

function getPresetsForModule(moduleId) {
  const cat = getCategory(moduleId);
  return STAT_PRESETS[cat] || STAT_PRESETS.general;
}

// fetchedDataからプリセット値を全計算してオブジェクトで返す { key: '表示文字列' }
const MAX_PRESET_VALUE_LEN = 40; // これ以上長い値はゴミデータとみなして除外

function computePresetValues(moduleId, fetchedData) {
  const presets = getPresetsForModule(moduleId);
  const result = {};
  for (const p of presets) {
    try {
      const v = p.get(fetchedData || {});
      if (v == null) continue;
      const s = String(v).trim();
      if (s === '' || s.length > MAX_PRESET_VALUE_LEN) continue;
      result[p.key] = s;
    } catch (_) {}
  }
  return result;
}

// type1/type2用 statsRows を自動生成（デフォルト6行）
function autoStatsRows(moduleId, fetchedData) {
  const cat      = getCategory(moduleId);
  const presets  = STAT_PRESETS[cat] || STAT_PRESETS.general;
  const pMap     = Object.fromEntries(presets.map(p => [p.key, p]));
  const defKeys  = DEFAULT_ROW_KEYS[cat] || DEFAULT_ROW_KEYS.general;
  const values   = computePresetValues(moduleId, fetchedData);

  return defKeys
    .map(key => {
      const p = pMap[key];
      if (!p) return null;
      return { key, label: p.label, value: values[key] || '' };
    })
    .filter(Boolean);
}

// クライアントに渡す用（get関数を除いたシリアライズ可能な形）
function getPresetsForClient() {
  const result = {};
  for (const [cat, items] of Object.entries(STAT_PRESETS)) {
    result[cat] = items.map(({ key, label }) => ({ key, label }));
  }
  return result;
}

// ─── トピック別2段階プリセット（UI用） ────────────────────────────────────────
// auto: true  → SofaScore等から自動取得できる項目
// research: true → AIが脚本生成時に調査して埋める項目
const TOPIC_PRESETS = {
  '選手': [
    { key: 'season_summary',     label: '今期成績（G+A）',        format: '〇試合 〇G 〇A',          auto: true  },
    { key: 'goals',              label: '今期ゴール',              format: '〇点',                    auto: true  },
    { key: 'assists',            label: '今期アシスト',            format: '〇本',                    auto: true  },
    { key: 'appearances',        label: '今期出場試合数',          format: '〇試合',                  auto: true  },
    { key: 'rating',             label: '今期平均評価点',          format: '7.80',                    auto: true  },
    { key: 'recent_rating',      label: '直近平均評価点',          format: '7.9（直近5試合）',        auto: true  },
    { key: 'expected_goals',     label: '今期xG',                 format: '12.3',                    auto: true  },
    { key: 'key_passes',         label: 'キーパス',                format: '〇本',                    auto: true  },
    { key: 'market_value',       label: '市場価値',                format: '€50M',                    auto: true  },
    { key: 'contract_until',     label: '契約終了',                format: '2026年夏',                auto: true  },
    { key: 'nationality',        label: '国籍',                    format: 'ブラジル',                auto: true  },
    { key: 'age',                label: '年齢',                    format: '24歳',                    auto: true  },
    { key: 'position',           label: 'ポジション',              format: 'LW',                      auto: true  },
    { key: 'height',             label: '身長',                    format: '176cm',                   auto: true  },
    { key: 'ucl_summary',        label: 'CL今期成績（G+A）',      format: '〇試合 〇G 〇A',          auto: true  },
    { key: 'club_career_goals',  label: 'クラブ通算得点',          format: '〇G',                     research: true },
    { key: 'club_career_ga',     label: 'クラブ通算G+A',           format: '〇G 〇A',                 research: true },
    { key: 'goals_by_manager',   label: '監督別得点',              format: '〇〇監督: 〇G/〇A',       research: true },
    { key: 'national_goals',     label: '代表通算得点',            format: '〇G（〇試合）',           research: true },
    { key: 'ucl_career_goals',   label: 'CL通算得点',              format: '〇G',                     research: true },
    { key: 'world_cup_goals',    label: 'W杯通算得点',             format: '〇G（〇大会）',           research: true },
    { key: 'career_trophies',    label: '獲得タイトル数',          format: '〇冠',                    research: true },
    { key: 'debut_year',         label: 'プロデビュー年',          format: '〇年（〇歳）',            research: true },
  ],
  '監督': [
    { key: 'win_record',         label: '今季成績（勝分負）',      format: '〇勝〇分〇敗',            auto: true  },
    { key: 'win_rate',           label: '今季勝率',                format: '〇%',                     auto: true  },
    { key: 'goals_per_game',     label: '1試合平均得点',           format: '〇.〇点',                 auto: true  },
    { key: 'conceded_per_game',  label: '1試合平均失点',           format: '〇.〇点',                 auto: true  },
    { key: 'clean_sheets',       label: 'クリーンシート',          format: '〇試合',                  auto: true  },
    { key: 'possession_avg',     label: '平均ポゼッション',        format: '〇%',                     auto: true  },
    { key: 'formation',          label: '主フォーメーション',      format: '4-3-3',                   auto: true  },
    { key: 'appointed',          label: '就任日',                  format: '〇年〇月',                auto: true  },
    { key: 'nationality',        label: '監督国籍',                format: 'ポルトガル',              auto: true  },
    { key: 'age',                label: '監督年齢',                format: '〇歳',                    auto: true  },
    { key: 'career_win_rate',    label: 'キャリア通算勝率',        format: '〇%（〇試合）',           research: true },
    { key: 'career_trophies',    label: '監督通算タイトル',        format: '〇冠',                    research: true },
    { key: 'prev_clubs',         label: '歴代指導クラブ',          format: 'A→B→C',                  research: true },
    { key: 'contract_end',       label: '契約終了',                format: '〇年〇月',                research: true },
    { key: 'home_record',        label: 'ホーム成績',              format: '〇勝〇分〇敗',            research: true },
    { key: 'away_record',        label: 'アウェイ成績',            format: '〇勝〇分〇敗',            research: true },
    { key: 'goals_per_game_career', label: 'キャリア平均得点/試合', format: '〇.〇点',               research: true },
  ],
  'チーム': [
    { key: 'league_position',    label: 'リーグ順位',              format: '第〇位',                  auto: true  },
    { key: 'points',             label: 'ポイント',                format: '〇pt',                    auto: true  },
    { key: 'wdl',                label: '成績（勝分負）',          format: '〇勝〇分〇敗',            auto: true  },
    { key: 'form',               label: '直近5試合',               format: '○△○○●',                 auto: true  },
    { key: 'goals_for',          label: '総得点',                  format: '〇点',                    auto: true  },
    { key: 'goals_against',      label: '総失点',                  format: '〇点',                    auto: true  },
    { key: 'goal_diff',          label: '得失点差',                format: '+〇',                     auto: true  },
    { key: 'squad_value',        label: 'スカッド総額',            format: '€〇億',                   research: true },
    { key: 'top_scorer',         label: 'トップスコアラー',        format: '選手名（〇G）',           research: true },
    { key: 'ucl_position',       label: 'CL/ELグループ順位',       format: '第〇位',                  research: true },
    { key: 'home_record',        label: 'ホーム成績',              format: '〇勝〇分〇敗',            research: true },
    { key: 'away_record',        label: 'アウェイ成績',            format: '〇勝〇分〇敗',            research: true },
    { key: 'avg_age',            label: '平均年齢',                format: '〇.〇歳',                 research: true },
    { key: 'clean_sheets',       label: 'クリーンシート数',        format: '〇試合',                  research: true },
    { key: 'coach_name',         label: '監督名',                  format: '選手名',                  research: true },
    { key: 'club_founded',       label: 'クラブ創設年',            format: '〇年創設',                research: true },
  ],
  '移籍': [
    { key: 'transfer_fee',       label: '移籍金',                  format: '€〇億',                   research: true },
    { key: 'from_to',            label: '移籍元→移籍先',           format: 'A→B',                     research: true },
    { key: 'contract_length',    label: '契約期間',                format: '〇年',                    research: true },
    { key: 'weekly_wage',        label: '週給（推定）',            format: '€〇万/週',                research: true },
    { key: 'annual_salary',      label: '年俸（推定）',            format: '€〇億',                   research: true },
    { key: 'release_clause',     label: '違約金',                  format: '€〇億',                   research: true },
    { key: 'competing_clubs',    label: '競合クラブ',              format: 'A、B、C',                 research: true },
    { key: 'shirt_number',       label: '背番号',                  format: '〇番',                    research: true },
    { key: 'announcement_date',  label: '発表日',                  format: '〇月〇日',                research: true },
    { key: 'transfer_type',      label: '移籍タイプ',              format: '完全/ローン/フリー',      research: true },
    { key: 'prev_transfer_fee',  label: '前回移籍金',              format: '€〇億（〇年）',           research: true },
    { key: 'market_value',       label: '現在の市場価値',          format: '€〇億',                   research: true },
  ],
  'ケガ': [
    { key: 'injury_type',        label: 'ケガ部位・種類',          format: '右膝靭帯損傷',            research: true },
    { key: 'expected_return',    label: '復帰予定',                format: '〇月〇日頃',              research: true },
    { key: 'absence_weeks',      label: '離脱期間',                format: '〇〜〇週間',              research: true },
    { key: 'missed_games',       label: '欠場試合数',              format: '〇試合',                  research: true },
    { key: 'key_matches_missed', label: '不在の主要試合',          format: 'CL vs 〇〇など',          research: true },
    { key: 'team_impact',        label: 'チームへの影響',          format: '不可欠な主力',            research: true },
    { key: 'prev_same_injury',   label: '同部位の前歴',            format: '〇年に同部位',            research: true },
    { key: 'severity',           label: '重症度',                  format: '軽傷/中程度/重傷',        research: true },
    { key: 'replacement',        label: '代替選手候補',            format: '選手名',                  research: true },
    { key: 'surgery_needed',     label: '手術の有無',              format: '手術あり/なし',           research: true },
    { key: 'injury_count',       label: '今季ケガ回数',            format: '〇回目',                  research: true },
    { key: 'return_training',    label: 'チーム練習復帰',          format: '〇月〇日頃',              research: true },
  ],
  '大会': [
    { key: 'scoreline',          label: 'スコア',                  format: '〇-〇',                   auto: true  },
    { key: 'scorers',            label: '得点者',                  format: '〇\' 選手名',             auto: true  },
    { key: 'possession',         label: 'ポゼッション',            format: '〇% vs 〇%',              auto: true  },
    { key: 'total_shots',        label: 'シュート数',              format: '〇 vs 〇',                auto: true  },
    { key: 'xg',                 label: 'xG',                     format: '〇.〇 vs 〇.〇',          auto: true  },
    { key: 'top_player',         label: 'MVP（評価点）',           format: '選手名（〇.〇）',         auto: true  },
    { key: 'tournament',         label: '大会名',                  format: 'プレミアリーグ',          auto: true  },
    { key: 'venue',              label: 'スタジアム',              format: 'エミレーツ・スタジアム',  auto: true  },
    { key: 'attendance',         label: '観衆',                    format: '〇万人',                  auto: true  },
    { key: 'h2h',                label: '直近対戦（H2H）',         format: '〇勝〇分〇敗',            research: true },
    { key: 'match_date',         label: '試合日',                  format: '〇月〇日',                auto: true  },
    { key: 'referee',            label: '主審',                    format: '審判名（国籍）',          research: true },
  ],
  '代表': [
    { key: 'national_goals',     label: '代表通算得点',            format: '〇G（〇試合）',           research: true },
    { key: 'national_ga',        label: '代表通算G+A',             format: '〇G 〇A',                 research: true },
    { key: 'world_cup_goals',    label: 'W杯通算得点',             format: '〇G（〇大会）',           research: true },
    { key: 'euro_goals',         label: 'EURO通算得点',            format: '〇G',                     research: true },
    { key: 'copa_goals',         label: 'コパ通算得点',            format: '〇G',                     research: true },
    { key: 'national_ranking',   label: 'FIFAランキング',          format: '第〇位',                  research: true },
    { key: 'national_caps',      label: '代表試合数（通算）',      format: '〇試合',                  research: true },
    { key: 'national_record',    label: '代表最多得点記録',        format: '歴代〇位（〇G）',         research: true },
    { key: 'national_recent_ga', label: '代表直近成績（G+A）',     format: '〇G 〇A（直近〇試合）',   research: true },
  ],
};

function findTopicPreset(key) {
  for (const items of Object.values(TOPIC_PRESETS)) {
    const found = items.find(p => p.key === key);
    if (found) return found;
  }
  return null;
}

function getTopicPresetsForClient() {
  const result = {};
  for (const [topic, items] of Object.entries(TOPIC_PRESETS)) {
    result[topic] = items.map(({ key, label, format, auto: isAuto, research }) => ({
      key, label, format, auto: isAuto, research,
    }));
  }
  return result;
}

module.exports = {
  STAT_PRESETS,
  MODULE_TO_CATEGORY,
  getCategory,
  getPresetsForModule,
  computePresetValues,
  autoStatsRows,
  getPresetsForClient,
  TOPIC_PRESETS,
  findTopicPreset,
  getTopicPresetsForClient,
};
