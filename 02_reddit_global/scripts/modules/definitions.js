// scripts/modules/definitions.js
// v2 モジュールタイプ定義
//
// DeepSeekはこのリストを参照し、案件に合わせて適切なモジュールを選んで提案する。
// 各モジュールはスライド1枚に対応する。

const MODULE_TYPES = {

  // ══════════════════════════════════════════════════════
  // 共通（どんなトピックにも使える）
  // ══════════════════════════════════════════════════════

  news_overview: {
    id:          'news_overview',
    label:       'ニュース概要',
    description: '今回の話題の背景・経緯・何が起きたか',
    icon:        '📰',
    dataSource:  'existing',   // 既存コンテンツから生成。追加フェッチ不要
    alwaysInclude: true,       // 必ず含める
    requiredParams: [],
  },

  reddit_reaction: {
    id:          'reddit_reaction',
    label:       '海外の反応',
    description: 'Redditの海外サポーター・ファンのコメント',
    icon:        '🌍',
    dataSource:  'existing',
    alwaysInclude: true,
    requiredParams: [],
  },

  domestic_reaction: {
    id:          'domestic_reaction',
    label:       '国内の反応',
    description: '日本語Twitter/ニュースでの反応・評価',
    icon:        '🇯🇵',
    dataSource:  'serper',
    requiredParams: ['searchQuery'], // 例: "ハーランド マンチェスターシティ 反応"
  },

  // ══════════════════════════════════════════════════════
  // 選手関連
  // ══════════════════════════════════════════════════════

  player_profile: {
    id:          'player_profile',
    label:       '選手プロフィール',
    description: '年齢・国籍・ポジション・現所属クラブなど基本情報',
    icon:        '👤',
    dataSource:  'wikipedia',
    requiredParams: ['playerNameEn'], // 例: "Erling Haaland"
  },

  player_career: {
    id:          'player_career',
    label:       '選手の来歴',
    description: 'キャリアの歩み・過去の所属クラブ・代表歴',
    icon:        '📋',
    dataSource:  'wikipedia',
    requiredParams: ['playerNameEn'],
  },

  player_season_stats: {
    id:          'player_season_stats',
    label:       '今シーズンの成績',
    description: '出場数・ゴール・アシスト・評価点など今季スタッツ',
    icon:        '📊',
    dataSource:  'sofascore',
    requiredParams: ['playerNameEn'],
  },

  player_episode: {
    id:          'player_episode',
    label:       '選手エピソード',
    description: '選手にまつわる名場面・逸話・伝説のシーン',
    icon:        '✨',
    dataSource:  'serper',
    requiredParams: ['playerNameEn', 'episodeKeyword'], // 例: "bicycle kick" "comeback"
  },

  transfer_rumor: {
    id:          'transfer_rumor',
    label:       '移籍の噂',
    description: '移籍市場での情報・噂・推定市場価値',
    icon:        '🔄',
    dataSource:  'serper',
    requiredParams: ['playerNameEn'],
  },

  injury_report: {
    id:          'injury_report',
    label:       '負傷・欠場情報',
    description: '離脱の経緯・復帰見込み・チームへの影響',
    icon:        '🏥',
    dataSource:  'serper',
    requiredParams: ['playerNameEn'],
  },

  // ══════════════════════════════════════════════════════
  // クラブ関連
  // ══════════════════════════════════════════════════════

  club_history: {
    id:          'club_history',
    label:       'クラブの来歴',
    description: 'クラブの設立から現在までの歴史・タイトル',
    icon:        '🏛️',
    dataSource:  'wikipedia',
    requiredParams: ['clubNameEn'], // 例: "Manchester City"
  },

  club_legends: {
    id:          'club_legends',
    label:       '全盛期とレジェンド',
    description: 'クラブの黄金時代・最多得点者・伝説の選手たち',
    icon:        '🏆',
    dataSource:  'serper+wikipedia',
    requiredParams: ['clubNameEn'],
  },

  club_current_season: {
    id:          'club_current_season',
    label:       '今シーズンの戦績',
    description: 'リーグ戦の勝敗・順位・直近の調子',
    icon:        '📈',
    dataSource:  'sofascore',
    requiredParams: ['clubName'], // チーム名（SofaScore検索用）
  },

  club_rival_history: {
    id:          'club_rival_history',
    label:       'ライバルとの因縁',
    description: '伝統的なライバル関係・過去の名勝負・相性',
    icon:        '⚔️',
    dataSource:  'serper+wikipedia',
    requiredParams: ['clubNameEn', 'rivalClubNameEn'],
  },

  club_key_players: {
    id:          'club_key_players',
    label:       '現在のキープレーヤー',
    description: '今シーズンのチームを支える主要選手の紹介',
    icon:        '⭐',
    dataSource:  'serper',
    requiredParams: ['clubNameEn'],
  },

  // ══════════════════════════════════════════════════════
  // 試合関連
  // ══════════════════════════════════════════════════════

  match_stats: {
    id:          'match_stats',
    label:       '試合スタッツ',
    description: 'ポゼッション・シュート・コーナー等の詳細統計',
    icon:        '⚽',
    dataSource:  'sofascore',
    requiredParams: ['homeTeam', 'awayTeam'], // 例: "Arsenal", "Chelsea"
  },

  formation_board: {
    id:          'formation_board',
    label:       'フォーメーション',
    description: '両チームのスターティングイレブンと布陣',
    icon:        '🗺️',
    dataSource:  'sofascore',
    requiredParams: ['homeTeam', 'awayTeam'],
  },

  head_to_head: {
    id:          'head_to_head',
    label:       '直近の対戦成績',
    description: '両チームの直近の対戦履歴・勝率・ゴール数',
    icon:        '📉',
    dataSource:  'sofascore',
    requiredParams: ['team1NameEn', 'team2NameEn'],
  },

  next_match_preview: {
    id:          'next_match_preview',
    label:       '次節プレビュー',
    description: '次の対戦相手・日程・見どころ・注目点',
    icon:        '🔭',
    dataSource:  'serper',
    requiredParams: ['clubName', 'searchQuery'],
  },

  match_key_moment: {
    id:          'match_key_moment',
    label:       '試合の決定的瞬間',
    description: 'ゴールシーン・退場・PKなど試合を動かしたプレー',
    icon:        '🎯',
    dataSource:  'serper',
    requiredParams: ['homeTeam', 'awayTeam', 'searchQuery'],
  },

  // ══════════════════════════════════════════════════════
  // データ・分析・記録
  // ══════════════════════════════════════════════════════

  stats_comparison: {
    id:          'stats_comparison',
    label:       'スタッツ比較',
    description: '2人の選手・2チームのデータを並べて徹底比較',
    icon:        '📊',
    dataSource:  'sofascore+serper',
    requiredParams: ['subject1En', 'subject2En'],
  },

  season_standings: {
    id:          'season_standings',
    label:       'リーグ順位表',
    description: '現在のリーグ上位の勝点・得失点差・注目チーム',
    icon:        '🏅',
    dataSource:  'sofascore',
    requiredParams: ['leagueName'], // 例: "Premier League"
  },

  historical_record: {
    id:          'historical_record',
    label:       '歴史的記録・節目',
    description: '前人未到の記録・通算ゴール・歴史的な出来事',
    icon:        '📜',
    dataSource:  'serper+wikipedia',
    requiredParams: ['searchQuery'], // 例: "Ronaldo all-time goal record"
  },

  tactical_analysis: {
    id:          'tactical_analysis',
    label:       '戦術分析',
    description: '戦術的な変化・フォーメーション変更・監督の意図',
    icon:        '🔬',
    dataSource:  'serper',
    requiredParams: ['clubNameEn', 'searchQuery'],
  },

  // ══════════════════════════════════════════════════════
  // カスタム（ユーザーが自由にテーマを指定）
  // ══════════════════════════════════════════════════════

  custom_research: {
    id:          'custom_research',
    label:       'カスタム調査',
    description: 'ユーザー指定テーマをSerper+DeepSeekで調査',
    icon:        '🔍',
    dataSource:  'serper',
    requiredParams: ['customQuery'],
  },
};

// モジュールIDの配列（DeepSeekへのプロンプト用）
const MODULE_ID_LIST = Object.keys(MODULE_TYPES);

module.exports = { MODULE_TYPES, MODULE_ID_LIST };
