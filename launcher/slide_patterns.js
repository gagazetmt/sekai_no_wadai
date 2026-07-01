// launcher/slide_patterns.js
// 脚本の文脈 → スライド構成 + 必須データフィールド のルックアップテーブル
//
// 各パターンは slides[] を持ち、各スライドに type（テンプレート名）と
// requiredFields（そのスライドに渡す必須データ）を定義する。
// スクリプト生成AIはパターン名を選ぶだけで、必要なデータ型が確定する。

const PATTERNS = {

  // ==================== 試合系 ====================

  match_result: {
    label: '試合結果速報',
    when: '試合終了直後の速報。スコア・得点者・スタッツを伝える',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'matchcard',
        required: ['homeTeam', 'awayTeam', 'homeScore', 'awayScore',
                   'goals', 'stats', 'lineup', 'formations',
                   'tournament', 'matchDate', 'venue'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  match_preview: {
    label: '試合プレビュー',
    when: '試合前の展望。対戦カード・過去の対戦成績・注目ポイント',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'comparison',
        required: ['title', 'siBindingLeft', 'siBindingRight', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  match_turning_point: {
    label: '試合ターニングポイント',
    when: '試合の流れを変えた決定的瞬間にフォーカス',
    slides: [
      { type: 'opening',   badge: '衝撃',
        required: ['title'] },
      { type: 'matchcard',
        required: ['homeTeam', 'awayTeam', 'homeScore', 'awayScore',
                   'goals', 'stats', 'lineup', 'formations',
                   'tournament', 'matchDate', 'venue'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== 選手系 ====================

  player_performance: {
    label: '選手パフォーマンス（単試合）',
    when: '特定の試合での選手の活躍を深掘り',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  player_season: {
    label: '選手シーズン総括',
    when: 'シーズン通しての選手成績・成長・評価',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'history',
        required: ['title', 'historyHero', 'dataSlots'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  player_comparison: {
    label: '選手比較',
    when: '2選手のスタッツを並べて比較',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'comparison',
        required: ['title', 'siBindingLeft', 'siBindingRight', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  player_milestone: {
    label: '選手マイルストーン',
    when: '通算100ゴール、代表50キャップなど節目の達成',
    slides: [
      { type: 'opening',   badge: '朗報',
        required: ['title'] },
      { type: 'history',
        required: ['title', 'historyHero', 'dataSlots'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== 移籍・契約系 ====================

  transfer_confirmed: {
    label: '移籍確定',
    when: '移籍が正式発表された',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  transfer_rumor: {
    label: '移籍噂・交渉中',
    when: '移籍の噂や交渉段階のニュース',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  contract_extension: {
    label: '契約延長・更新',
    when: '選手の契約延長が発表',
    slides: [
      { type: 'opening',   badge: '朗報',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== 大会・順位系 ====================

  tournament_standings: {
    label: '大会グループ・順位経過',
    when: 'W杯グループステージ結果や順位表の解説',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  tournament_bracket: {
    label: 'トーナメント展望',
    when: '決勝トーナメントの組み合わせ・展望',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'history',
        required: ['title', 'historyHero', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  league_race: {
    label: 'リーグ優勝争い',
    when: 'リーグ終盤の優勝・降格争い分析',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'comparison',
        required: ['title', 'siBindingLeft', 'siBindingRight', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== チーム系 ====================

  team_analysis: {
    label: 'チーム戦術分析',
    when: 'チームの戦術・フォーメーション・強み弱みの分析',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'comparison',
        required: ['title', 'siBindingLeft', 'siBindingRight', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  manager_change: {
    label: '監督交代・就任',
    when: '監督の解任・就任・辞任ニュース',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'history',
        required: ['title', 'historyHero', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== 事件・話題系 ====================

  controversy: {
    label: '物議・事件',
    when: '審判判定、VAR、暴力行為、差別問題など物議を醸す出来事',
    slides: [
      { type: 'opening',   badge: '衝撃',
        required: ['title'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  injury_update: {
    label: '怪我・離脱情報',
    when: '主力選手の怪我、復帰時期の発表',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  record_breaking: {
    label: '記録更新',
    when: '歴代記録の更新・タイ記録達成',
    slides: [
      { type: 'opening',   badge: '朗報',
        required: ['title'] },
      { type: 'history',
        required: ['title', 'historyHero', 'dataSlots'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  retirement: {
    label: '引退・現役引退',
    when: '選手の引退発表',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'history',
        required: ['title', 'historyHero', 'dataSlots'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== 日本代表特化 ====================

  japan_nt_callup: {
    label: '日本代表メンバー発表',
    when: '代表招集メンバーの発表・サプライズ選出・落選',
    slides: [
      { type: 'opening',   badge: '速報',
        required: ['title'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  japan_abroad: {
    label: '海外組 週間まとめ',
    when: '海外リーグでプレーする日本人選手の週間活躍',
    slides: [
      { type: 'opening',   badge: '注目',
        required: ['title'] },
      { type: 'stats',
        required: ['title', 'siBinding', 'dataSlots'] },
      { type: 'insight',
        required: ['title', 'catchphrases'] },
      { type: 'ending',
        required: ['title'] },
    ],
  },

  // ==================== 企画ピース系（op + content×N + ed）====================

  pieces_1: {
    label: '企画ピース×1（3枚）',
    when: '企画ピース1個を深掘り。op + insight + ed',
    slides: [
      { type: 'opening', badge: '速報',
        required: ['title', 'narration'] },
      { type: 'insight',
        required: ['title', 'narration', 'catchphrases', 'comments'] },
      { type: 'ending',
        required: ['title', 'narration'] },
    ],
  },

  pieces_2: {
    label: '企画ピース×2（4枚）',
    when: '企画ピース2個をまとめて。op + insight + insight + ed',
    slides: [
      { type: 'opening', badge: '速報',
        required: ['title', 'narration'] },
      { type: 'insight',
        required: ['title', 'narration', 'catchphrases', 'comments'] },
      { type: 'insight',
        required: ['title', 'narration', 'catchphrases', 'comments'] },
      { type: 'ending',
        required: ['title', 'narration'] },
    ],
  },
};

// パターン名からスライド構成を取得
function getPattern(name) {
  const p = PATTERNS[name];
  if (!p) throw new Error(`Unknown pattern: ${name}. Available: ${Object.keys(PATTERNS).join(', ')}`);
  return p;
}

// 全パターン名を取得
function listPatterns() {
  return Object.entries(PATTERNS).map(([key, p]) => ({
    key,
    label: p.label,
    when: p.when,
    slideCount: p.slides.length,
    slideTypes: p.slides.map(s => s.type),
  }));
}

// mod データがパターンの required を満たしているか検証
function validateMods(patternName, mods) {
  const pattern = getPattern(patternName);
  const errors = [];
  pattern.slides.forEach((slot, i) => {
    const mod = mods[i];
    if (!mod) {
      errors.push(`slides[${i}] (${slot.type}): mod データが無い`);
      return;
    }
    for (const field of slot.required) {
      if (mod[field] === undefined || mod[field] === null) {
        errors.push(`slides[${i}] (${slot.type}): "${field}" が未設定`);
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

// スライドタイプごとの required フィールド定義
const CONTENT_SLIDE_REQUIRED = {
  insight:    ['title', 'narration', 'catchphrases', 'comments'],
  matchcard:  ['homeTeam', 'awayTeam', 'homeScore', 'awayScore', 'goals', 'stats', 'lineup', 'formations', 'tournament', 'matchDate', 'venue'],
  stats:      ['title', 'narration', 'siBinding', 'dataSlots', 'comments'],
  comparison: ['title', 'narration', 'siBindingLeft', 'siBindingRight', 'dataSlots', 'comments'],
  history:    ['title', 'narration', 'historyHero', 'dataSlots', 'comments'],
};

// 企画ピース用の動的パターン生成
// contentTypes: スライドタイプ文字列の配列（1〜2個）
function buildPiecesPattern(contentTypes) {
  if (!contentTypes || !contentTypes.length || contentTypes.length > 2) {
    throw new Error('contentTypes は1〜2個の配列');
  }
  const slides = [
    { type: 'opening', badge: '速報', required: ['title', 'narration'] },
    ...contentTypes.map(t => ({
      type: t,
      required: CONTENT_SLIDE_REQUIRED[t] || CONTENT_SLIDE_REQUIRED.insight,
    })),
    { type: 'ending', required: ['title', 'narration'] },
  ];
  return {
    label: `企画ピース×${contentTypes.length}（${slides.length}枚）`,
    when:  `op + ${contentTypes.join(' + ')} + ed`,
    slides,
    _dynamic: true,
  };
}

module.exports = { PATTERNS, getPattern, listPatterns, validateMods, buildPiecesPattern, CONTENT_SLIDE_REQUIRED };
