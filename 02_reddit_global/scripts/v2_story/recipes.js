// scripts/v2_story/recipes.js
// ═══════════════════════════════════════════════════════════════
// レシピテーブル：Subject × Aspect → スライドテンプレート + データ取得
// ═══════════════════════════════════════════════════════════════
// 各レシピは「主題（subject）と観点（aspect）の組み合わせ」を
// 1セルとして定義し、以下を持つ：
//
//   - priority      : A〜E（実装順）
//   - label         : 日本語ラベル（UIプルダウン用）
//   - description   : AIプロンプト・UIツールチップ用
//   - template      : v2_video/slides の visual template 名
//   - sources       : 必要なデータソース（参考情報）
//   - populates     : 埋めるモジュール側のフィールド
//                     ('dataSlots' | 'events' | 'catchphrases' | 'comments' | 'matchData')
//   - availableSlots: dataSlots 系で選べるスロット候補（プルダウン）
//                     [{ key, label, extract: (entityData, ctx?) => string }]
//   - defaultSelection: availableSlots から最初に選ばれる key 配列
//   - requiresSecondary: 対比型（comparison）で secondary 必須なら true
//   - build         : (entityPrimary, entitySecondary?, opts?) => { 部分モジュール }
//
// ═══════════════════════════════════════════════════════════════

// ─── 主題・観点 一覧 ────────────────────────────────────────────
const SUBJECTS = ['player', 'team', 'manager', 'match', 'transfer', 'tournament', 'generic'];

// 主題ラベル
const SUBJECT_LABELS = {
  player:     '選手',
  team:       'チーム',
  manager:    '監督',
  match:      '試合',
  transfer:   '移籍',
  tournament: '大会',
  generic:    'その他',
};

// 主題と SI box type のマッピング（既存 si_data の構造とブリッジ）
const SUBJECT_BOX_MAP = {
  player:  'sofascore_player',
  team:    'sofascore_team',
  manager: 'sofascore_manager',
  match:   'sofascore_match',
};

// ─── ヘルパー ─────────────────────────────────────────────────
function fmtNum(v, fallback = '-') {
  if (v == null || v === '') return fallback;
  return String(v);
}
function fmtPct(v, fallback = '-') {
  if (v == null || v === '') return fallback;
  return Number(v).toFixed(0) + '%';
}
function fmtFloat(v, digits = 2, fallback = '-') {
  if (v == null || v === '') return fallback;
  return Number(v).toFixed(digits);
}

// SIデータから entity を取得（label一致）
function findEntity(siData, subject, label) {
  const box = SUBJECT_BOX_MAP[subject];
  if (!box || !siData?.boxes?.[box]?.fetched) return null;
  return siData.boxes[box].fetched.find(f => f.label === label)?.data || null;
}

// 旧モジュール（siBinding ベース）→ binding スキーマへの推測
// 新規 binding が無い場合のフォールバック
function inferBindingFromLegacy(mod, siData) {
  if (mod.binding) return mod.binding;
  const subject = guessSubjectFromType(mod.type, mod.siBinding, siData);
  const aspect  = guessAspectFromType(mod.type);
  return {
    subject,
    aspect,
    primary:   mod.siBinding || mod.siBindingLeft || null,
    secondary: mod.siBindingRight || null,
  };
}
function guessSubjectFromType(type, label, siData) {
  // ラベルがあれば実データから判別
  if (label && siData?.boxes) {
    for (const subj of SUBJECTS) {
      const box = SUBJECT_BOX_MAP[subj];
      if (box && siData.boxes[box]?.fetched?.some(f => f.label === label)) return subj;
    }
  }
  // 型からの粗推定
  if (type === 'matchcard' || type === 'matchcenter') return 'match';
  if (type === 'comparison') return 'player';  // デフォ
  return 'player';
}
function guessAspectFromType(type) {
  return ({
    profile:     'profile',
    history:     'history',
    stats:       'careerStats',
    matchcard:   'matchStats',
    matchcenter: 'matchStats',
    comparison:  'careerStats',
    reaction:    'free',
    insight:     'free',
    opening:     'free',
    ending:      'free',
  })[type] || 'free';
}

// ─── レシピ本体 ───────────────────────────────────────────────
const RECIPES = {

  // ════════════════════════════════════════════════════════════
  // 【A判定】最優先実装：MVPの中核 9セル
  // ════════════════════════════════════════════════════════════

  // ── A1. 選手の基本情報 ──────────────────────────────────────
  'player.profile': {
    priority: 'A',
    label: '選手の基本情報',
    description: '選手1人のプロフィール（ポジション・年齢・国籍・所属・市場価値）',
    template: 'stats',
    sources: ['sofa.player', 'wiki.summary'],
    populates: 'dataSlots',
    availableSlots: [
      { key: 'position',    label: 'ポジション',  extract: d => fmtNum(d?.position) },
      { key: 'age',         label: '年齢',        extract: d => fmtNum(d?.age) + '歳' },
      { key: 'nationality', label: '国籍',        extract: d => fmtNum(d?.nationality) },
      { key: 'team',        label: '所属',        extract: d => fmtNum(d?.team) },
      { key: 'height',      label: '身長',        extract: d => d?.height ? d.height + 'cm' : '-' },
      { key: 'weight',      label: '体重',        extract: d => d?.weight ? d.weight + 'kg' : '-' },
      { key: 'preferredFoot', label: '利き足',    extract: d => fmtNum(d?.preferredFoot) },
      { key: 'shirtNumber', label: '背番号',      extract: d => d?.shirtNumber != null ? '#' + d.shirtNumber : '-' },
      { key: 'marketValue', label: '市場価値',    extract: d => fmtNum(d?.marketValue) },
      { key: 'contractUntil', label: '契約満了',  extract: d => fmtNum(d?.contractUntil) },
      { key: 'league',      label: 'リーグ',      extract: d => fmtNum(d?.leagueName) },
    ],
    defaultSelection: ['position', 'age', 'nationality', 'marketValue'],
  },

  // ── A2. 選手の来歴（Wikipedia キャリア年表）────────────────
  'player.history': {
    priority: 'A',
    label: '選手の来歴',
    description: '選手のキャリア年表（所属クラブ遍歴、主要トピックを時系列で）',
    template: 'history',
    sources: ['wiki.infobox', 'sofa.player'],
    populates: 'dataSlots',  // history テンプレ: {label: 年, value: タイトル}
    historyShape: true,       // ビルダーが Wiki events → dataSlots 変換
    needsWikiInfobox: true,   // Wikipedia API 呼び出しが必要（VPS推奨）
  },

  // ── A3. 選手の今季成績 ──────────────────────────────────────
  'player.careerStats': {
    priority: 'A',
    label: '選手の今季成績',
    description: '選手1人の今シーズン統計（リーグ戦の通算）',
    template: 'stats',
    sources: ['sofa.player'],
    populates: 'dataSlots',
    availableSlots: [
      { key: 'goals',         label: 'ゴール',       extract: d => fmtNum(d?.seasonStats?.goals) },
      { key: 'assists',       label: 'アシスト',     extract: d => fmtNum(d?.seasonStats?.assists) },
      { key: 'apps',          label: '出場',         extract: d => fmtNum(d?.seasonStats?.appearances) + '試合' },
      { key: 'minutes',       label: '出場時間',     extract: d => d?.seasonStats?.minutesPlayed ? d.seasonStats.minutesPlayed + '分' : '-' },
      { key: 'rating',        label: '平均評定',     extract: d => fmtFloat(d?.seasonStats?.rating, 2) },
      { key: 'xG',            label: 'xG',           extract: d => fmtFloat(d?.seasonStats?.expectedGoals, 2) },
      { key: 'keyPasses',     label: 'キーパス',     extract: d => fmtNum(d?.seasonStats?.keyPasses) },
      { key: 'yellowCards',   label: '警告',         extract: d => fmtNum(d?.seasonStats?.yellowCards) },
      { key: 'redCards',      label: '退場',         extract: d => fmtNum(d?.seasonStats?.redCards) },
      { key: 'recentAvgRating', label: '直近10戦平均', extract: d => fmtFloat(d?.recentAvgRating, 2) },
      // ポジション別（DF）
      { key: 'tackles',       label: 'タックル',     extract: d => fmtNum(d?.positionStats?.tackles) },
      { key: 'interceptions', label: 'インターセプト', extract: d => fmtNum(d?.positionStats?.interceptions) },
      { key: 'clearances',    label: 'クリア',       extract: d => fmtNum(d?.positionStats?.clearances) },
      { key: 'duelsWon',      label: 'デュエル勝',   extract: d => fmtNum(d?.positionStats?.duelsWon) },
      // ポジション別（GK）
      { key: 'saves',         label: 'セーブ',       extract: d => fmtNum(d?.positionStats?.saves) },
      { key: 'cleanSheets',   label: '完封',         extract: d => fmtNum(d?.positionStats?.cleanSheets) },
      { key: 'goalsPrevented', label: 'ゴール阻止',  extract: d => fmtNum(d?.positionStats?.goalsPrevented) },
      // ポジション別（FW）
      { key: 'shotsOnTarget', label: '枠内シュート', extract: d => fmtNum(d?.positionStats?.shotsOnTarget) },
      { key: 'bigChancesMissed', label: '決定機外し', extract: d => fmtNum(d?.positionStats?.bigChancesMissed) },
      { key: 'successfulDribbles', label: 'ドリブル成功', extract: d => fmtNum(d?.positionStats?.successfulDribbles) },
      // CL
      { key: 'uclGoals',      label: 'CL得点',       extract: d => fmtNum(d?.uclStats?.goals) },
      { key: 'uclRating',     label: 'CL評定',       extract: d => fmtFloat(d?.uclStats?.rating, 2) },
    ],
    defaultSelection: ['goals', 'assists', 'rating', 'apps'],
  },

  // ── A4. 選手の今試合スタッツ ────────────────────────────────
  'player.matchStats': {
    priority: 'A',
    label: '選手の今試合スタッツ',
    description: '選手1人の直近1試合（or 指定試合）のパフォーマンス',
    template: 'stats',
    sources: ['sofa.player.lastMatch'],
    populates: 'dataSlots',
    availableSlots: [
      { key: 'rating',       label: '評定',         extract: d => fmtFloat(d?.lastMatchStats?.rating, 2) },
      { key: 'goals',        label: 'ゴール',       extract: d => fmtNum(d?.lastMatchStats?.goals) },
      { key: 'assists',      label: 'アシスト',     extract: d => fmtNum(d?.lastMatchStats?.assists) },
      { key: 'minutes',      label: '出場時間',     extract: d => d?.lastMatchStats?.minutesPlayed ? d.lastMatchStats.minutesPlayed + '分' : '-' },
      { key: 'shots',        label: 'シュート',     extract: d => fmtNum(d?.lastMatchStats?.shots) },
      { key: 'shotsOnTarget', label: '枠内シュート', extract: d => fmtNum(d?.lastMatchStats?.shotsOnTarget) },
      { key: 'keyPasses',    label: 'キーパス',     extract: d => fmtNum(d?.lastMatchStats?.keyPasses) },
      { key: 'passes',       label: 'パス',         extract: d => fmtNum(d?.lastMatchStats?.passes) },
      { key: 'passAcc',      label: 'パス成功率',   extract: d => fmtPct(d?.lastMatchStats?.accuratePassesPct) },
      { key: 'dribbles',     label: 'ドリブル試行', extract: d => fmtNum(d?.lastMatchStats?.dribbles) },
      { key: 'dribblesWon',  label: 'ドリブル成功', extract: d => fmtNum(d?.lastMatchStats?.dribblesWon) },
      { key: 'touches',      label: 'タッチ数',     extract: d => fmtNum(d?.lastMatchStats?.touches) },
      { key: 'xG',           label: 'xG(本試合)',   extract: d => fmtFloat(d?.lastMatchStats?.expectedGoals, 2) },
      { key: 'opponent',     label: '対戦相手',     extract: d => fmtNum(d?.lastMatchStats?.opponent) },
      { key: 'score',        label: 'スコア',       extract: d => fmtNum(d?.lastMatchStats?.score) },
    ],
    defaultSelection: ['rating', 'goals', 'shots', 'passAcc'],
  },

  // ── A5. チームの基本情報 ────────────────────────────────────
  'team.profile': {
    priority: 'A',
    label: 'チームの基本情報',
    description: 'クラブ1つの基本情報（リーグ・監督・スタジアム・市場価値）',
    template: 'stats',
    sources: ['sofa.team', 'wiki.summary'],
    populates: 'dataSlots',
    availableSlots: [
      { key: 'league',      label: 'リーグ',       extract: d => fmtNum(d?.leagueName) },
      { key: 'country',     label: '国',           extract: d => fmtNum(d?.country) },
      { key: 'founded',     label: '創設',         extract: d => fmtNum(d?.founded) },
      { key: 'manager',     label: '監督',         extract: d => fmtNum(d?.managerName) },
      { key: 'venue',       label: 'スタジアム',   extract: d => fmtNum(d?.venue) },
      { key: 'marketValue', label: '総資産',       extract: d => fmtNum(d?.marketValue) },
    ],
    defaultSelection: ['league', 'manager', 'founded', 'marketValue'],
  },

  // ── A6. チームの今季成績 ────────────────────────────────────
  'team.seasonStats': {
    priority: 'A',
    label: 'チームの今季成績',
    description: 'クラブ1つの今季リーグ成績（順位・勝点・W/D/L・得失点）',
    template: 'stats',
    sources: ['sofa.team'],
    populates: 'dataSlots',
    availableSlots: [
      { key: 'position', label: '順位',     extract: d => d?.standing?.position != null ? d.standing.position + '位' : '-' },
      { key: 'points',   label: '勝点',     extract: d => fmtNum(d?.standing?.points) },
      { key: 'wins',     label: '勝利',     extract: d => fmtNum(d?.standing?.wins) },
      { key: 'draws',    label: '引分',     extract: d => fmtNum(d?.standing?.draws) },
      { key: 'losses',   label: '敗戦',     extract: d => fmtNum(d?.standing?.losses) },
      { key: 'gf',       label: '得点',     extract: d => fmtNum(d?.standing?.goalsFor) },
      { key: 'ga',       label: '失点',     extract: d => fmtNum(d?.standing?.goalsAgainst) },
      { key: 'gd',       label: '得失点差',
        extract: d => (d?.standing?.goalsFor != null && d?.standing?.goalsAgainst != null)
          ? String(d.standing.goalsFor - d.standing.goalsAgainst) : '-' },
      { key: 'played',   label: '試合数',   extract: d => fmtNum(d?.standing?.played) },
      { key: 'wdlStr',   label: 'W-D-L',
        extract: d => d?.standing ? `${d.standing.wins||0}-${d.standing.draws||0}-${d.standing.losses||0}` : '-' },
    ],
    defaultSelection: ['position', 'points', 'wins', 'gf'],
  },

  // ── A7. チームの今試合スタッツ ──────────────────────────────
  'team.matchStats': {
    priority: 'A',
    label: 'チームの今試合スタッツ',
    description: 'チーム1つの直近1試合のパフォーマンス（支配率・シュート等）',
    template: 'stats',
    sources: ['sofa.match'],
    populates: 'dataSlots',
    // 注：team の matchStats は match データから取得（home/away の片側）
    // build時に primary チームが home/away どちらかを判定して extract
    needsMatchSide: true,
    availableSlots: [
      // ※ ctx.side === 'home' or 'away' で extract が分岐する想定
      // sofa.match.stats は [{ name, home, away }, ...] 形式
      { key: 'possession',    label: '支配率',     extract: (d, ctx) => extractMatchStat(d, ctx, 'Ball possession') },
      { key: 'shots',         label: 'シュート',   extract: (d, ctx) => extractMatchStat(d, ctx, 'Total shots') },
      { key: 'shotsOnTarget', label: '枠内',       extract: (d, ctx) => extractMatchStat(d, ctx, 'Shots on target') },
      { key: 'corners',       label: 'CK',         extract: (d, ctx) => extractMatchStat(d, ctx, 'Corner kicks') },
      { key: 'fouls',         label: 'ファウル',   extract: (d, ctx) => extractMatchStat(d, ctx, 'Fouls') },
      { key: 'passes',        label: 'パス',       extract: (d, ctx) => extractMatchStat(d, ctx, 'Passes') },
      { key: 'passAccuracy',  label: 'パス成功率', extract: (d, ctx) => extractMatchStat(d, ctx, 'Accurate passes') },
      { key: 'expectedGoals', label: 'xG',         extract: (d, ctx) => extractMatchStat(d, ctx, 'Expected goals') },
      { key: 'tackles',       label: 'タックル',   extract: (d, ctx) => extractMatchStat(d, ctx, 'Tackles') },
    ],
    defaultSelection: ['possession', 'shots', 'corners', 'expectedGoals'],
  },

  // ── A8. 試合詳細（matchcenter）──────────────────────────────
  'match.matchStats': {
    priority: 'A',
    label: '試合詳細',
    description: '試合1つの全貌（スコア・得点者・両チームスタッツ・キープレイヤー）',
    template: 'matchcenter',
    sources: ['sofa.match'],
    populates: 'matchData',
    // matchcenter は固定形状でレンダリング。プルダウン選択肢なし。
    // build時に sofa.match の生データから matchData オブジェクトを構築
  },

  // ── A9. 過去対戦成績（H2H）─── subject=team, 2チーム比較
  'team.h2h': {
    priority: 'A',
    label: '過去対戦成績(H2H)',
    description: '2チーム間の過去対戦成績（comparison型でレンダリング）',
    template: 'comparison',
    sources: ['sofa.match.h2h'],
    populates: 'dataSlots',
    requiresSecondary: true,
    needsTeamH2H: true,  // builder が siData.matches から該当試合を探す
    availableSlots: [
      // ctx.primaryTeam = primary側のチーム名 / d = 該当matchの sofa.match data
      { key: 'wins',       label: '勝利数',    extract: (d, ctx) => h2hCountForTeam(d, ctx.primaryTeam, 'wins') },
      { key: 'draws',      label: '引分',      extract: (d, ctx) => h2hCountForTeam(d, ctx.primaryTeam, 'draws') },
      { key: 'losses',     label: '敗戦',      extract: (d, ctx) => h2hCountForTeam(d, ctx.primaryTeam, 'losses') },
      { key: 'lastResult', label: '直近結果',  extract: (d, ctx) => h2hCountForTeam(d, ctx.primaryTeam, 'lastResult') },
      { key: 'recentScores', label: '直近スコア', extract: (d, ctx) => h2hCountForTeam(d, ctx.primaryTeam, 'recentScores') },
    ],
    defaultSelection: ['wins', 'draws', 'losses', 'lastResult'],
  },

  // ── A10. 選手 vs 選手 通算スタッツ比較 ────────────────────
  'player.compareCareerStats': {
    priority: 'A',
    label: '選手 vs 選手 通算スタッツ',
    description: '2選手の今シーズン通算スタッツを comparison 型で並べる',
    template: 'comparison',
    sources: ['sofa.player'],
    populates: 'dataSlots',
    requiresSecondary: true,
    availableSlots: [  // player.careerStats と同じ extract を流用
      { key: 'goals',     label: 'ゴール',   extract: d => fmtNum(d?.seasonStats?.goals) },
      { key: 'assists',   label: 'アシスト', extract: d => fmtNum(d?.seasonStats?.assists) },
      { key: 'apps',      label: '出場',     extract: d => fmtNum(d?.seasonStats?.appearances) + '試合' },
      { key: 'minutes',   label: '出場時間', extract: d => d?.seasonStats?.minutesPlayed ? d.seasonStats.minutesPlayed + '分' : '-' },
      { key: 'rating',    label: '平均評定', extract: d => fmtFloat(d?.seasonStats?.rating, 2) },
      { key: 'xG',        label: 'xG',       extract: d => fmtFloat(d?.seasonStats?.expectedGoals, 2) },
      { key: 'keyPasses', label: 'キーパス', extract: d => fmtNum(d?.seasonStats?.keyPasses) },
      { key: 'recentAvgRating', label: '直近10戦平均', extract: d => fmtFloat(d?.recentAvgRating, 2) },
      { key: 'marketValue', label: '市場価値', extract: d => fmtNum(d?.marketValue) },
    ],
    defaultSelection: ['goals', 'assists', 'rating', 'apps'],
  },

  // ── A11. 選手 vs 選手 試合スタッツ比較 ────────────────────
  'player.compareMatchStats': {
    priority: 'A',
    label: '選手 vs 選手 試合スタッツ',
    description: '2選手の同試合（または直近）パフォーマンス比較',
    template: 'comparison',
    sources: ['sofa.player.lastMatch'],
    populates: 'dataSlots',
    requiresSecondary: true,
    availableSlots: [
      { key: 'rating',       label: '評定',       extract: d => fmtFloat(d?.lastMatchStats?.rating, 2) },
      { key: 'goals',        label: 'ゴール',     extract: d => fmtNum(d?.lastMatchStats?.goals) },
      { key: 'assists',      label: 'アシスト',   extract: d => fmtNum(d?.lastMatchStats?.assists) },
      { key: 'shots',        label: 'シュート',   extract: d => fmtNum(d?.lastMatchStats?.shots) },
      { key: 'shotsOnTarget',label: '枠内',       extract: d => fmtNum(d?.lastMatchStats?.shotsOnTarget) },
      { key: 'keyPasses',    label: 'キーパス',   extract: d => fmtNum(d?.lastMatchStats?.keyPasses) },
      { key: 'passAcc',      label: 'パス成功率', extract: d => fmtPct(d?.lastMatchStats?.accuratePassesPct) },
      { key: 'dribblesWon',  label: 'ドリブル成功',extract: d => fmtNum(d?.lastMatchStats?.dribblesWon) },
      { key: 'touches',      label: 'タッチ数',   extract: d => fmtNum(d?.lastMatchStats?.touches) },
    ],
    defaultSelection: ['rating', 'goals', 'shots', 'passAcc'],
  },

  // ── A12. チーム vs チーム 今季成績比較 ─────────────────────
  'team.compareSeasonStats': {
    priority: 'A',
    label: 'チーム vs チーム 今季成績',
    description: '2クラブの今季リーグ成績を並べて比較',
    template: 'comparison',
    sources: ['sofa.team'],
    populates: 'dataSlots',
    requiresSecondary: true,
    availableSlots: [  // team.seasonStats と同じ extract を流用
      { key: 'position', label: '順位',     extract: d => d?.standing?.position != null ? d.standing.position + '位' : '-' },
      { key: 'points',   label: '勝点',     extract: d => fmtNum(d?.standing?.points) },
      { key: 'wins',     label: '勝利',     extract: d => fmtNum(d?.standing?.wins) },
      { key: 'draws',    label: '引分',     extract: d => fmtNum(d?.standing?.draws) },
      { key: 'losses',   label: '敗戦',     extract: d => fmtNum(d?.standing?.losses) },
      { key: 'gf',       label: '得点',     extract: d => fmtNum(d?.standing?.goalsFor) },
      { key: 'ga',       label: '失点',     extract: d => fmtNum(d?.standing?.goalsAgainst) },
      { key: 'gd',       label: '得失点差',
        extract: d => (d?.standing?.goalsFor != null && d?.standing?.goalsAgainst != null)
          ? String(d.standing.goalsFor - d.standing.goalsAgainst) : '-' },
      { key: 'wdlStr',   label: 'W-D-L',
        extract: d => d?.standing ? `${d.standing.wins||0}-${d.standing.draws||0}-${d.standing.losses||0}` : '-' },
      { key: 'marketValue', label: '総資産', extract: d => fmtNum(d?.marketValue) },
    ],
    defaultSelection: ['position', 'points', 'gf', 'gd'],
  },

  // ── A13. 試合プレビュー ─────────────────────────────────────
  'match.preview': {
    priority: 'A',
    label: '試合プレビュー',
    description: '試合前情報（H2H・両チームスタッツ・主役選手）。matchcard型で表示',
    template: 'matchcard',
    sources: ['sofa.match'],
    populates: 'dataSlots',
    needsMatchPreview: true,  // builder が homeTeam/awayTeam を自動セット
    availableSlots: [
      // d は sofa.match data（試合エンティティ）
      { key: 'h2hRecord',  label: 'H2H通算',
        extract: (d) => d?.h2hSummary || (d?.h2hMatches?.length ? `直近${d.h2hMatches.length}戦` : '-') },
      { key: 'tournament', label: '大会',
        extract: (d) => fmtNum(d?.tournament) },
      { key: 'venue',      label: '会場',
        extract: (d) => fmtNum(d?.venue) },
      { key: 'matchDate',  label: '日付',
        extract: (d) => fmtNum(d?.matchDate) },
      { key: 'topScorer',  label: 'トップスコアラー',
        extract: (d) => {
          const tp = (d?.topPlayers || [])[0];
          return tp ? `${tp.name}(${tp.rating || '-'})` : '-';
        } },
      { key: 'attendance', label: '観客数',
        extract: (d) => d?.attendance ? d.attendance.toLocaleString() + '人' : '-' },
      { key: 'lastH2HResult', label: '直近対戦',
        extract: (d) => d?.h2hMatches?.[0]?.scoreline || '-' },
    ],
    defaultSelection: ['h2hRecord', 'tournament', 'venue', 'matchDate'],
  },

  // ════════════════════════════════════════════════════════════
  // 【B判定】次フェーズ実装：14セル（スタブ・概要のみ）
  // ════════════════════════════════════════════════════════════

  'player.injuries': {
    priority: 'B', label: '選手の怪我履歴', template: 'history',
    description: '選手の怪我・離脱の年表',
    sources: ['wiki.sectionInjuries', 'news'], populates: 'dataSlots', historyShape: true,
  },
  'team.history': {
    priority: 'B', label: 'クラブの歴史・タイトル', template: 'history',
    description: 'クラブの歴代偉業・タイトル獲得史',
    sources: ['wiki.sectionHonours'], populates: 'dataSlots', historyShape: true,
  },
  'team.squad': {
    priority: 'B', label: 'チームの現有戦力', template: 'stats',
    description: 'スタメン・主力の名前と背番号',
    sources: ['sofa.team.players'], populates: 'dataSlots',
    availableSlots: [], defaultSelection: [],
  },
  'manager.profile': {
    priority: 'B', label: '監督の基本情報', template: 'stats',
    description: '監督1人の基本情報（国籍・年齢・現職・フォーメーション）',
    sources: ['sofa.manager', 'wiki.summary'], populates: 'dataSlots',
    availableSlots: [
      { key: 'nationality', label: '国籍',       extract: d => fmtNum(d?.nationality) },
      { key: 'age',         label: '年齢',       extract: d => fmtNum(d?.age) + '歳' },
      { key: 'currentTeam', label: '現職',       extract: d => fmtNum(d?.currentTeam) },
      { key: 'since',       label: '就任',       extract: d => fmtNum(d?.currentTeamSince) },
      { key: 'formation',   label: 'フォーメーション', extract: d => fmtNum(d?.preferredFormation) },
    ],
    defaultSelection: ['nationality', 'age', 'currentTeam', 'formation'],
  },
  'manager.history': {
    priority: 'B', label: '監督の来歴', template: 'history',
    description: '監督のキャリア年表',
    sources: ['wiki.sectionCareer', 'sofa.manager.career'], populates: 'dataSlots', historyShape: true,
  },
  'manager.achievements': {
    priority: 'B', label: '監督の獲得タイトル', template: 'stats',
    description: '監督の獲得トロフィー',
    sources: ['wiki.sectionHonours'], populates: 'dataSlots',
    availableSlots: [], defaultSelection: [],
  },
  'manager.recentForm': {
    priority: 'B', label: '監督の直近成績', template: 'stats',
    description: '監督の直近N試合の戦績',
    sources: ['sofa.manager'], populates: 'dataSlots',
    availableSlots: [
      { key: 'totalMatches', label: '通算試合', extract: d => fmtNum(d?.overallPerformance?.total) },
      { key: 'overallWinRate', label: '通算勝率', extract: d => fmtPct(d?.overallPerformance?.winRate) },
      { key: 'currentTeamW', label: '現職W',  extract: d => fmtNum(d?.currentTeamStats?.wins) },
      { key: 'currentTeamD', label: '現職D',  extract: d => fmtNum(d?.currentTeamStats?.draws) },
      { key: 'currentTeamL', label: '現職L',  extract: d => fmtNum(d?.currentTeamStats?.losses) },
      { key: 'currentTeamWinRate', label: '現職勝率', extract: d => fmtPct(d?.currentTeamStats?.winRate) },
    ],
    defaultSelection: ['currentTeamW', 'currentTeamD', 'currentTeamL', 'currentTeamWinRate'],
  },
  'match.rivalry': {
    priority: 'B', label: '試合の因縁・歴史', template: 'reaction',
    description: '対戦カードの歴史的背景・名場面・ライバル関係',
    sources: ['news', 'wiki', 'reddit'], populates: 'comments',
  },
  'match.keyMatchups': {
    priority: 'B', label: 'キーマッチアップ', template: 'comparison',
    description: '試合の鍵を握る選手同士の対決',
    sources: ['sofa.match.lineup'], populates: 'dataSlots', requiresSecondary: true,
    availableSlots: [], defaultSelection: [],
  },
  'transfer.profile': {
    priority: 'B', label: '移籍の基本情報', template: 'stats',
    description: '移籍噂の概要（誰がどこから何処へ・金額・条件）',
    sources: ['news', 'wiki'], populates: 'dataSlots',
    availableSlots: [], defaultSelection: [],
  },
  'transfer.competition': {
    priority: 'B', label: '移籍の争奪戦', template: 'comparison',
    description: '同選手を狙う複数クラブの比較',
    sources: ['news', 'sofa.team'], populates: 'dataSlots', requiresSecondary: true,
    availableSlots: [], defaultSelection: [],
  },
  'tournament.currentFocus': {
    priority: 'B', label: '今大会の注目', template: 'reaction',
    description: '進行中の大会の見どころ・注目選手・優勝候補',
    sources: ['news', 'sofa'], populates: 'comments',
  },
  'generic.free': {
    priority: 'B', label: 'フリー編集', template: 'universal',
    description: '主題が定型に当てはまらない場合の安全網',
    sources: [], populates: 'dataSlots',
    availableSlots: [], defaultSelection: [],
  },
  'generic.ranking': {
    priority: 'B', label: 'ランキング系', template: 'stats',
    description: 'TOP5・歴代1位など、リスト型のスライド',
    sources: ['news', 'curated'], populates: 'dataSlots',
    availableSlots: [], defaultSelection: [],
  },

  // ════════════════════════════════════════════════════════════
  // 【C判定】余力時実装：16セル（スタブ・概要のみ）
  // ════════════════════════════════════════════════════════════

  'player.nationalTeam':   { priority: 'C', label: '選手の代表での活躍', template: 'stats',   description: '代表チームでの成績・出場記録', sources: ['sofa.player.national', 'wiki'], populates: 'dataSlots', availableSlots: [], defaultSelection: [] },
  'player.styleAnalysis':  { priority: 'C', label: '選手のプレースタイル', template: 'insight', description: '選手の特徴・強み・戦術的役割', sources: ['wiki', 'sofa.heatmap'], populates: 'catchphrases' },
  'player.contractStatus': { priority: 'C', label: '選手の契約状況', template: 'stats',   description: '契約期間・違約金・延長交渉', sources: ['news'], populates: 'dataSlots', availableSlots: [], defaultSelection: [] },
  'team.transferActivity': { priority: 'C', label: 'チームの近年の補強・放出', template: 'history', description: '直近シーズンの大型移籍', sources: ['news'], populates: 'dataSlots', historyShape: true },
  'manager.teamStatsUnder': { priority: 'C', label: '監督在任中のチーム統計', template: 'stats',   description: '監督が指揮した期間のクラブ成績', sources: ['sofa.manager'], populates: 'dataSlots', availableSlots: [], defaultSelection: [] },
  'manager.tactics':       { priority: 'C', label: '監督の戦術・哲学', template: 'insight', description: '監督のサッカー観・主戦略', sources: ['news', 'wiki'], populates: 'catchphrases' },
  'manager.conflicts':     { priority: 'C', label: '監督の確執・トラブル史', template: 'history', description: '過去の対立・解任・選手との衝突', sources: ['news'], populates: 'dataSlots', historyShape: true },
  'match.preMatchBuzz':    { priority: 'C', label: '試合の前哨戦・煽り', template: 'reaction', description: '試合前のメディア・選手の発言', sources: ['news', 'reddit'], populates: 'comments' },
  'match.predictions':     { priority: 'C', label: '試合の予想・賭け率', template: 'stats',   description: '事前予想・ブックメーカーオッズ', sources: ['news'], populates: 'dataSlots', availableSlots: [], defaultSelection: [] },
  'match.postAnalysis':    { priority: 'C', label: '試合後の分析', template: 'reaction', description: '試合後の専門家・ファンの分析', sources: ['news', 'reddit'], populates: 'comments' },
  'transfer.timeline':     { priority: 'C', label: '移籍の噂タイムライン', template: 'history', description: '移籍話の経時的な動き', sources: ['news'], populates: 'dataSlots', historyShape: true },
  'transfer.feeRanking':   { priority: 'C', label: '移籍金ランキング', template: 'stats',   description: '歴代/今夏の移籍金トップリスト', sources: ['news', 'curated'], populates: 'dataSlots', availableSlots: [], defaultSelection: [] },
  'tournament.profile':    { priority: 'C', label: '大会の基本情報', template: 'stats', description: '大会概要（出場国・歴史・形式）', sources: ['wiki', 'sofa'], populates: 'dataSlots', availableSlots: [], defaultSelection: [] },
  'tournament.pastResults':{ priority: 'C', label: '大会の過去結果', template: 'history', description: '過去の優勝・準優勝', sources: ['wiki'], populates: 'dataSlots', historyShape: true },
  'tournament.favorites':  { priority: 'C', label: '大会の優勝候補', template: 'reaction', description: '今大会の優勝候補・有力選手', sources: ['news'], populates: 'comments' },
  'generic.topic':         { priority: 'C', label: 'フリートピック', template: 'reaction', description: 'その他のサッカー時事ネタ', sources: ['news', 'reddit'], populates: 'comments' },
};

// ─── stat 名から home/away 値を抽出するヘルパー ─────────────
// sofa.match.stats は [{ name: 'Ball possession', home: '52%', away: '48%' }, ...]
function extractMatchStat(matchData, ctx, statName) {
  if (!matchData?.stats || !Array.isArray(matchData.stats)) return '-';
  const row = matchData.stats.find(s => s?.name === statName);
  if (!row) return '-';
  const side = ctx?.side === 'away' ? 'away' : 'home';
  return fmtNum(row[side]);
}

// ─── 2チーム間のh2h集計（primary視点で W/D/L カウント） ────
// matchEntity = sofa.match data（h2hMatches を含む）
// primaryTeam = primary側の team 名
// scoreline 形式： "Real Madrid 3-1 Real Betis"
function h2hCountForTeam(matchEntity, primaryTeam, key) {
  const matches = matchEntity?.h2hMatches || [];
  if (!matches.length || !primaryTeam) return '-';
  const primaryName = String(primaryTeam).toLowerCase();
  let w = 0, d = 0, l = 0;
  matches.forEach(m => {
    const sm = (m.scoreline || '').match(/^(.+?)\s+(\d+)-(\d+)\s+(.+?)$/);
    if (!sm) return;
    const [, hN, hS, aS, aN] = sm;
    const hScore = parseInt(hS), aScore = parseInt(aS);
    const homeLower = hN.trim().toLowerCase();
    const awayLower = aN.trim().toLowerCase();
    const primaryIsHome = homeLower.includes(primaryName) || primaryName.includes(homeLower);
    const primaryIsAway = awayLower.includes(primaryName) || primaryName.includes(awayLower);
    if (!primaryIsHome && !primaryIsAway) return;
    if (hScore === aScore) d++;
    else if (primaryIsHome ? hScore > aScore : aScore > hScore) w++;
    else l++;
  });
  if (key === 'wins')   return String(w);
  if (key === 'draws')  return String(d);
  if (key === 'losses') return String(l);
  if (key === 'lastResult')   return matches[0]?.scoreline || '-';
  if (key === 'recentScores') return matches.slice(0, 3).map(m => m.scoreline).filter(Boolean).join(' / ');
  return '-';
}

// ─── 公開API ───────────────────────────────────────────────
function getRecipe(subject, aspect) {
  return RECIPES[`${subject}.${aspect}`] || null;
}

function listAspectsBySubject(subject) {
  return Object.entries(RECIPES)
    .filter(([key]) => key.startsWith(subject + '.'))
    .map(([key, r]) => ({
      aspect:   key.split('.')[1],
      label:    r.label,
      priority: r.priority,
      template: r.template,
    }));
}

function listRecipesByPriority(priority) {
  return Object.entries(RECIPES)
    .filter(([, r]) => r.priority === priority)
    .map(([key, r]) => ({ key, ...r }));
}

// レシピ + entityData → モジュール部分構造を構築（dataSlots系のみ）
function buildDataSlotsFromRecipe(recipe, primaryData, secondaryData = null, selectedKeys = null, ctx = {}) {
  if (!recipe?.availableSlots?.length) return [];
  const keys = selectedKeys || recipe.defaultSelection || [];
  const slots = recipe.availableSlots;

  return keys.map(k => {
    const slot = slots.find(s => s.key === k);
    if (!slot) return null;

    if (recipe.requiresSecondary && secondaryData) {
      // comparison shape
      return {
        label:      slot.label,
        leftValue:  String(slot.extract(primaryData, { ...ctx, side: 'home' }) ?? '-'),
        rightValue: String(slot.extract(secondaryData, { ...ctx, side: 'away' }) ?? '-'),
        slotKey:    k,
      };
    }
    return {
      label:   slot.label,
      value:   String(slot.extract(primaryData, ctx) ?? '-'),
      slotKey: k,
    };
  }).filter(Boolean);
}

module.exports = {
  RECIPES,
  SUBJECTS,
  SUBJECT_LABELS,
  SUBJECT_BOX_MAP,
  getRecipe,
  listAspectsBySubject,
  listRecipesByPriority,
  findEntity,
  inferBindingFromLegacy,
  buildDataSlotsFromRecipe,
};
