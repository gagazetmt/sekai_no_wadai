// scripts/v2_thumb/generate_samples.js
// サムネ + OP/ED の全バリエーションをサンプルデータで HTML 出力
//   data/v2_videos/voice_test/ に index と各サンプル html を保存
//   試聴URL: http://VPS:3004/v2_videos/voice_test/showcase.html

const path = require('path');
const fs = require('fs');

const { buildDataHeroThumb } = require('./templates/dataHero');
const { buildRankingThumb }  = require('./templates/ranking');
const { buildVsThumb }       = require('./templates/vs');
const { buildQuestionThumb } = require('./templates/question');
const { buildViralDataThumb } = require('./templates/viralData');
const { buildStadiumBoardThumb } = require('./templates/stadiumBoard');
const { buildMagazineCoverThumb } = require('./templates/magazineCover');
const { buildTradingCardThumb }  = require('./templates/tradingCard');
const { buildRegalRedThumb }     = require('./templates/regalRed');
const { buildRegalBlueThumb }    = require('./templates/regalBlue');
const { buildRegalGreenThumb }   = require('./templates/regalGreen');

// OP/ED スライドビルダー
const { buildOpeningHTML: buildOpV1 } = require('../v2_video/slides/opening');
const { buildOpeningHTML: buildOpV2 } = require('../v2_video/slides/opening_v2');
const { buildOpeningHTML: buildOpV3 } = require('../v2_video/slides/opening_v3');
const { buildEndingHTML: buildEdV1 } = require('../v2_video/slides/ending');
const { buildEndingHTML: buildEdV2 } = require('../v2_video/slides/ending_v2');
const { buildEndingHTML: buildEdV3 } = require('../v2_video/slides/ending_v3');

const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'v2_videos', 'voice_test');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function saveHtml(filename, html) {
  fs.writeFileSync(path.join(OUT_DIR, filename), html);
  return filename;
}

// ─── 画像パスマップ（既存案件の image directories から借用）──
const IMG = {
  hakimi:  'images/_r_soccer_comments_1sygftm_hakimi_pulls_a_hamstring_/entity_Achraf_Hakimi/_byname1.jpg',
  hakimi2: 'images/_r_soccer_comments_1sygftm_hakimi_pulls_a_hamstring_/entity_Achraf_Hakimi/_byname2.jpg',
  morocco: 'images/_r_soccer_comments_1sygftm_hakimi_pulls_a_hamstring_/entity_morocco/_byname1.jpg',
  olise:   'images/_r_soccer_comments_1swzqx1_would_bayern_reject_200m_for_olise_rummenigge_in_/entity_Michael_Olise/_byname1.jpg',
  casemiro:'images/_r_soccer_comments_1sxdgza_manchester_united_1_0_brentford_casemiro_11_/entity_Casemiro/_byname1.jpg',
  realMadrid:'images/_r_soccer_comments_1sxh6lt_la_liga_standings_after_matchweek_33_/entity_Real_Madrid/_bytime1.jpg',
  barcelona:'images/_r_soccer_comments_1sxh6lt_la_liga_standings_after_matchweek_33_/entity_Barcelona/_bytime1.jpg',
  bayern:  'images/_r_soccer_comments_1sxt9ji_with_this_seasons_semifinal_bayern_and_psg_have_/entity_Bayern_Munich/_bytime1.jpg',
};

// ─── サムネ サンプルデータ ──────────────────────────────────
const thumbSamples = [];

// テンプレA: データ強調型 × 3 （三層構造: badge / 数字 / 左赤+右白 catch）
[
  {
    name: 'thumb_A1_hakimi',
    label: 'A-1: ハキミ怪我',
    data: {
      heroImage: IMG.hakimi,
      heroNumber: '161',
      heroLabel: 'PSGでの試合数',
      badge: 'PSG崩壊の予兆',
      badgeColor: '#dc2626',
      catchLeft: '161試合の経験',
      catchRight: 'ハキミ離脱の衝撃',
    },
  },
  {
    name: 'thumb_A2_olise',
    label: 'A-2: オリーセ覚醒',
    data: {
      heroImage: IMG.olise,
      heroNumber: '+5.2',
      heroLabel: 'xG超過',
      badge: '異次元の決定力',
      badgeColor: '#dc2626',
      catchLeft: 'バイエルン200億',
      catchRight: 'オリーセ覚醒の真相',
    },
  },
  {
    name: 'thumb_A3_casemiro',
    label: 'A-3: カゼミーロ復活',
    data: {
      heroImage: IMG.casemiro,
      heroNumber: '8.4',
      heroLabel: '直近試合 評定',
      badge: 'マンU救世主',
      badgeColor: '#059669',
      catchLeft: '5勝1分の好調',
      catchRight: 'カゼミーロ完全復活',
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildDataHeroThumb(s.data) });
});

// テンプレB: ランキング × 2
[
  {
    name: 'thumb_B1_psg_top3',
    label: 'B-1: PSG主役TOP3',
    data: {
      title: 'PSG 主役プレイヤーTOP3',
      items: [
        { rank: 1, name: 'ハキミ',    value: '161試合', image: IMG.hakimi },
        { rank: 2, name: 'オリーセ',  value: '23ゴール', image: IMG.olise },
        { rank: 3, name: 'カゼミーロ',value: '評定 8.4', image: IMG.casemiro },
      ],
      bottomCatch: 'あなたの一番は？',
    },
  },
  {
    name: 'thumb_B2_laliga_top3',
    label: 'B-2: La Liga 順位 TOP3',
    data: {
      title: 'La Liga 上位3チーム',
      items: [
        { rank: 1, name: 'レアル・マドリード', value: '勝点85', image: IMG.realMadrid },
        { rank: 2, name: 'バルセロナ',         value: '勝点78', image: IMG.barcelona },
        { rank: 3, name: 'バイエルン',         value: '勝点72', image: IMG.bayern },
      ],
      bottomCatch: '大混戦の優勝争い',
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildRankingThumb(s.data) });
});

// テンプレC: VS型 × 2
[
  {
    name: 'thumb_C1_hakimi_olise',
    label: 'C-1: ハキミ vs オリーセ',
    data: {
      title: '今季キーマン対決',
      leftName: 'ハキミ',
      leftValue: '6A 評定7.5',
      leftImage: IMG.hakimi,
      rightName: 'オリーセ',
      rightValue: '12G 評定7.8',
      rightImage: IMG.olise,
      bottomCatch: 'どっちがPSG主役？',
    },
  },
  {
    name: 'thumb_C2_real_barca',
    label: 'C-2: クラシコ',
    data: {
      title: '今季 クラシコ',
      leftName: 'レアル',
      leftValue: '勝点 85',
      leftImage: IMG.realMadrid,
      rightName: 'バルサ',
      rightValue: '勝点 78',
      rightImage: IMG.barcelona,
      bottomCatch: '優勝はどっち？',
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildVsThumb(s.data) });
});

// テンプレD: 問いかけ型 × 2
[
  {
    name: 'thumb_D1_psg_question',
    label: 'D-1: PSGはどうなる？',
    data: {
      bgImage: IMG.bayern,  // 試合の暗い背景として流用
      heroImage: IMG.hakimi2,
      question: 'ハキミ離脱でPSGは？',
      subData: '失う 161試合の経験 / 5勝1分の好調も終焉',
      bottomBadge: '徹底分析',
    },
  },
  {
    name: 'thumb_D2_real_decline',
    label: 'D-2: レアル不振の真相',
    data: {
      bgImage: IMG.realMadrid,
      question: 'なぜレアルは負ける？',
      subData: '勝ち点 -8 vs 昨年同時期 / 失点 +12',
      bottomBadge: '5分で解説',
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildQuestionThumb(s.data) });
});

// ─── テンプレ L: 5ch反応集スタイル × データ（リネカ大胆刷新版）──
[
  {
    name: 'thumb_L1_hakimi_viral',
    label: 'L-1: ハキミ離脱',
    data: {
      heroImage: IMG.hakimi,
      breakingLabel: 'PSG崩壊の予兆',
      title: 'ハキミ離脱でPSGどうなる',
      titleHighlight: '衝撃の事態',
      mainStat: { value: '161', label: 'PSG在籍試合' },
      subStat:  { value: '6週', label: '離脱予想' },
    },
  },
  {
    name: 'thumb_L2_olise_viral',
    label: 'L-2: オリーセ覚醒',
    data: {
      heroImage: IMG.olise,
      breakingLabel: '今季最強の数字',
      title: 'オリーセ覚醒の真相',
      titleHighlight: '異次元xG',
      mainStat: { value: '+5.2', label: 'xG超過 異次元' },
      subStat:  { value: '12G', label: '今季得点' },
    },
  },
  {
    name: 'thumb_L3_casemiro_viral',
    label: 'L-3: カゼミーロ復活',
    data: {
      heroImage: IMG.casemiro,
      breakingLabel: '不死鳥データ',
      title: 'カゼミーロ完全復活',
      titleHighlight: 'マンU救世主',
      mainStat: { value: '8.4', label: '直近試合 評定' },
      subStat:  { value: '5勝1分', label: '今月戦績' },
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildViralDataThumb(s.data) });
});

// ─── テンプレ M: STADIUM SCOREBOARD ──
[
  {
    name: 'thumb_M1_psg_bayern',
    label: 'M-1: PSG vs Bayern',
    data: {
      heroImage: IMG.bayern,
      title: 'PSG vs バイエルン CL準決勝',
      scoreLabel: 'PSG ━ BAYERN MUNICH',
      scoreLeft: '5',
      scoreRight: '4',
      mainStat: { value: '+1', label: 'GOAL DIFFERENCE' },
      subStats: [
        { label: 'POSSESSION', value: '52%' },
        { label: 'SHOTS',      value: '15' },
        { label: 'XG',         value: '3.8' },
      ],
    },
  },
  {
    name: 'thumb_M2_olise_data',
    label: 'M-2: オリーセデータ',
    data: {
      heroImage: IMG.olise,
      title: 'オリーセ 今夜の数字',
      scoreLabel: 'OLISE · BAYERN',
      mainStat: { value: '8.7', label: 'MATCH RATING' },
      subStats: [
        { label: 'GOALS',  value: '2' },
        { label: 'XG',     value: '+2.1' },
        { label: 'PASSES', value: '64' },
      ],
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildStadiumBoardThumb(s.data) });
});

// ─── テンプレ N: MAGAZINE COVER ──
[
  {
    name: 'thumb_N1_hakimi_cover',
    label: 'N-1: ハキミ表紙',
    data: {
      heroImage: IMG.hakimi,
      issueLabel: 'ISSUE 042',
      title: 'ハキミ\nPSGの危機',
      subtitle: '161試合の経験を失う',
      stickers: [
        { value: '161', label: 'PSG Apps',      color: 'red' },
        { value: '+5.2', label: 'xG超過',        color: 'gold' },
        { value: '6週',  label: 'Out',           color: 'green' },
      ],
    },
  },
  {
    name: 'thumb_N2_olise_cover',
    label: 'N-2: オリーセ表紙',
    data: {
      heroImage: IMG.olise,
      issueLabel: 'ISSUE 043',
      title: 'オリーセの真価',
      subtitle: 'バイエルンが200億で奪う理由',
      stickers: [
        { value: '12G',  label: 'Goals',         color: 'red' },
        { value: '7.8',  label: 'Avg Rating',    color: 'gold' },
        { value: '+2.1', label: 'xG vs Real',    color: 'green' },
      ],
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildMagazineCoverThumb(s.data) });
});

// ─── テンプレ O: TRADING CARD ──
[
  {
    name: 'thumb_O1_hakimi_card',
    label: 'O-1: ハキミ TCG',
    data: {
      heroImage: IMG.hakimi,
      playerName: 'A. Hakimi',
      position: 'RB · DF',
      team: 'PSG',
      overallRating: 89,
      stats: [
        { label: 'GOL', value: 4 },
        { label: 'AST', value: 6 },
        { label: 'RAT', value: '7.5' },
        { label: 'APP', value: 18 },
      ],
      bottomCatch: 'PSG攻撃の心臓',
    },
  },
  {
    name: 'thumb_O2_olise_card',
    label: 'O-2: オリーセ TCG',
    data: {
      heroImage: IMG.olise,
      playerName: 'M. Olise',
      position: 'RW · MF',
      team: 'BAYERN',
      overallRating: 87,
      stats: [
        { label: 'GOL', value: 12 },
        { label: 'AST', value: 8 },
        { label: 'RAT', value: '7.8' },
        { label: 'XG',  value: '+5.2' },
      ],
      bottomCatch: '今季覚醒の異才',
    },
  },
  {
    name: 'thumb_O3_casemiro_card',
    label: 'O-3: カゼミーロ TCG',
    data: {
      heroImage: IMG.casemiro,
      playerName: 'Casemiro',
      position: 'CDM · MF',
      team: 'MAN UTD',
      overallRating: 85,
      stats: [
        { label: 'INT', value: 47 },
        { label: 'TKL', value: 62 },
        { label: 'RAT', value: '8.4' },
        { label: 'APP', value: 22 },
      ],
      bottomCatch: 'マンUの守護神',
    },
  },
].forEach(s => {
  thumbSamples.push({ ...s, html: buildTradingCardThumb(s.data) });
});

// ─── テンプレ R: REGAL シリーズ（gpt-image-1 提案を HTML/CSS 化）──
//   赤×ネイビー / 青×ゴールド / 緑×ゴールド の3案。
//   重厚な edit. design + 巨大ゴールド数字 + 白太ゴシックタイトル + 下端帯。
[
  {
    name: 'thumb_R_red_hakimi',
    label: 'R-Red: ハキミ離脱（衝撃系）',
    builder: buildRegalRedThumb,
    data: {
      heroImage:  IMG.hakimi,
      heroNumber: '161',
      heroLabel:  'PSG在籍試合',
      title:      'ハキミ\n離脱の衝撃',
      subtitle:   'PSG崩壊の予兆',
    },
  },
  {
    name: 'thumb_R_blue_olise',
    label: 'R-Blue: オリーセ覚醒（知的分析）',
    builder: buildRegalBlueThumb,
    data: {
      heroImage:  IMG.olise,
      heroNumber: '+5.2',
      heroLabel:  'xG超過',
      title:      'オリーセ覚醒の真相',
      subtitle:   'バイエルンが200億で奪う理由',
    },
  },
  {
    name: 'thumb_R_green_casemiro',
    label: 'R-Green: カゼミーロ復活（朗報系）',
    builder: buildRegalGreenThumb,
    data: {
      heroImage:  IMG.casemiro,
      heroNumber: '8.4',
      heroLabel:  '直近試合 評定',
      title:      'カゼミーロ\n完全復活',
      subtitle:   'マンU救世主の証明',
    },
  },
].forEach(s => {
  thumbSamples.push({ name: s.name, label: s.label, html: s.builder(s.data) });
});

// ─── Light tone サンプル（4テンプレ × 1サンプル）──
const lightThumbs = [
  {
    name: 'thumb_AL_olise',
    label: 'A-Light: オリーセ xG',
    builder: buildDataHeroThumb,
    data: {
      tone: 'light',
      heroImage: IMG.olise,
      heroNumber: '+5.2',
      heroLabel: 'xG超過',
      badge: '異次元の決定力',
      badgeColor: '#dc2626',
      catchLeft: 'バイエルン200億',
      catchRight: 'オリーセ覚醒の真相',
    },
  },
  {
    name: 'thumb_BL_psg_top3',
    label: 'B-Light: PSG主役TOP3',
    builder: buildRankingThumb,
    data: {
      tone: 'light',
      title: 'PSG 主役プレイヤーTOP3',
      items: [
        { rank: 1, name: 'ハキミ',    value: '161試合', image: IMG.hakimi },
        { rank: 2, name: 'オリーセ',  value: '23ゴール', image: IMG.olise },
        { rank: 3, name: 'カゼミーロ',value: '評定 8.4', image: IMG.casemiro },
      ],
      bottomCatch: 'あなたの一番は？',
    },
  },
  {
    name: 'thumb_CL_real_barca',
    label: 'C-Light: クラシコ',
    builder: buildVsThumb,
    data: {
      tone: 'light',
      title: '今季 クラシコ',
      leftName: 'レアル',
      leftValue: '勝点 85',
      leftImage: IMG.realMadrid,
      rightName: 'バルサ',
      rightValue: '勝点 78',
      rightImage: IMG.barcelona,
      bottomCatch: '優勝はどっち？',
    },
  },
  {
    name: 'thumb_DL_real_decline',
    label: 'D-Light: レアル不振',
    builder: buildQuestionThumb,
    data: {
      tone: 'light',
      bgImage: IMG.realMadrid,
      question: 'なぜレアルは負ける？',
      subData: '勝ち点 -8 vs 昨年同時期 / 失点 +12',
      bottomBadge: '5分で解説',
    },
  },
];
lightThumbs.forEach(s => {
  thumbSamples.push({ name: s.name, label: s.label, html: s.builder(s.data) });
});

// 全てのサムネHTMLを出力
thumbSamples.forEach(s => saveHtml(s.name + '.html', s.html));

// ─── OP/ED サンプル ──────────────────────────────────────
const opEdSamples = [];

const opSampleData = {
  type: 'opening',
  title: '【衝撃】ハキミ離脱でPSG崩壊か',
  narration: 'ハキミ離脱の衝撃が世界を揺らす。',
  channelName: '5分でサッカー分析',
  heroNumber: '161',
  heroLabel: '在籍試合数',
  bgImage: IMG.hakimi,
};

opEdSamples.push({ name: 'op_v1_hakimi', label: 'OP V1 (現行) ハキミ',  html: buildOpV1(opSampleData) });
opEdSamples.push({ name: 'op_v2_hakimi', label: 'OP V2 (数字フラッシュ) ハキミ', html: buildOpV2(opSampleData) });
opEdSamples.push({ name: 'op_v3_hakimi', label: 'OP V3 (タイトル爆発) ハキミ', html: buildOpV3(opSampleData) });

const opSampleData2 = {
  type: 'opening',
  title: 'PSG 5-4 バイエルン 完全解説',
  narration: '激闘の全てを5分で。',
  channelName: '5分でサッカー分析',
  heroNumber: '5-4',
  heroLabel: 'CL準決勝',
  openingBadge: { text: '速報', color: '#f59e0b', textColor: '#000' },
  bgImage: IMG.bayern,
};

opEdSamples.push({ name: 'op_v1_psg', label: 'OP V1 PSG vs Bayern',  html: buildOpV1(opSampleData2) });
opEdSamples.push({ name: 'op_v2_psg', label: 'OP V2 PSG vs Bayern', html: buildOpV2(opSampleData2) });
opEdSamples.push({ name: 'op_v3_psg', label: 'OP V3 PSG vs Bayern', html: buildOpV3(opSampleData2) });

// ED
const edSampleData = {
  type: 'ending',
  title: '次回もお楽しみに！',
  narration: '今日はハキミの全てを解説。次回もデータでサッカーを楽しもう。',
  channelName: '5分でサッカー分析',
  endingCta: { text: 'チャンネル登録お願い' },
  summaryStats: [
    { value: '161', label: 'PSG在籍試合' },
    { value: '6週', label: '想定離脱期間' },
    { value: '5勝1分', label: '今月の戦績' },
  ],
  nextTopic: 'ベリンガムが背負う重圧の真相',
  commentPrompt: 'あなたの予想を教えて！',
  bgImage: IMG.hakimi2,
};

opEdSamples.push({ name: 'ed_v1_hakimi', label: 'ED V1 (現行)',  html: buildEdV1(edSampleData) });
opEdSamples.push({ name: 'ed_v2_hakimi', label: 'ED V2 (要点サマリ)', html: buildEdV2(edSampleData) });
opEdSamples.push({ name: 'ed_v3_hakimi', label: 'ED V3 (次回予告)', html: buildEdV3(edSampleData) });

// フォールバック動作確認用追加サンプル
const opNoHero = {
  type: 'opening',
  title: '【朗報】ベリンガム、復帰決定',
  narration: '待望のベリンガム帰還。',
  channelName: '5分でサッカー分析',
  // heroNumber 無し → タイトル中央配置にフォールバック
};
opEdSamples.push({ name: 'op_v2_no_hero', label: 'OP V2 (heroなし → 中央配置)', html: buildOpV2(opNoHero) });

const edCatchOnly = {
  type: 'ending',
  title: '次回もお楽しみに！',
  narration: '今日のポイント振り返り。',
  channelName: '5分でサッカー分析',
  endingCta: { text: 'チャンネル登録お願い' },
  // summaryStats 無し → catchphrases から数字+ラベル抽出
  catchphrases: [
    '24ゴール 史上最速',
    '78%の決定機',
    '5戦無敗の好調',
  ],
};
opEdSamples.push({ name: 'ed_v2_catch_fallback', label: 'ED V2 (catchphrases fallback)', html: buildEdV2(edCatchOnly) });

opEdSamples.forEach(s => saveHtml(s.name + '.html', s.html));

// ─── インデックスページ ───────────────────────────────────
const indexHtml = `<!doctype html><meta charset=utf-8>
<title>動画素材 全体ショーケース</title>
<style>
:root { --bg:#0a0e1a; --panel:#161b2e; --border:#2a3050; --text:#f1f5ff; --muted:#8a9aba; --accent:#f59e0b; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: sans-serif; background: var(--bg); color: var(--text); padding: 24px; max-width: 1400px; margin: 0 auto; }
h1 { color: var(--accent); margin-bottom: 8px; font-size: 26px; }
h2 { color: #7dc8ff; margin: 32px 0 14px; font-size: 18px; padding-bottom: 8px; border-bottom: 2px solid var(--border); }
h3 { color: var(--accent); margin-top: 18px; font-size: 14px; letter-spacing: 1px; }
.intro { color: var(--muted); margin-bottom: 14px; line-height: 1.5; }

.thumbs-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 18px;
  margin-bottom: 28px;
}
.thumb-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  transition: border-color .2s;
}
.thumb-card:hover { border-color: var(--accent); }
.thumb-card iframe {
  width: 100%;
  aspect-ratio: 16/9;
  border: 0;
  display: block;
  background: #000;
  transform-origin: top left;
}
.thumb-card .label {
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 700;
  display: flex; justify-content: space-between; align-items: center;
}
.thumb-card .label small {
  color: var(--muted);
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.thumb-card .label a {
  color: var(--accent);
  text-decoration: none;
  font-size: 11px;
  border: 1px solid var(--accent);
  padding: 3px 10px;
  border-radius: 4px;
}
.thumb-card .label a:hover { background: var(--accent); color: #000; }

/* OP/ED は16:9 1920x1080なのでiframe縮小 */
.opedb-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(440px, 1fr));
  gap: 18px;
  margin-bottom: 28px;
}
.opedb-grid .thumb-card iframe {
  /* iframe 内の 1920x1080 を 全幅で見えるよう scale */
}
.section-note { color: var(--muted); font-size: 12px; margin-bottom: 12px; }

/* iframe 内のスケーリング用 wrapper */
.iframe-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16/9;
  overflow: hidden;
  background: #000;
}
.iframe-wrap iframe {
  position: absolute;
  top: 0; left: 0;
  width: 1920px; height: 1080px;
  transform-origin: top left;
  border: 0;
}
.iframe-wrap.thumb iframe {
  width: 1280px; height: 720px;
}
</style>

<h1>🎬 動画素材ショーケース</h1>
<p class="intro">
チャンネル「5分でサッカー分析」の動画素材集。<br>
サムネイル4テンプレ × OP/ED 各3バリエーション。実コンテンツのサンプルデータでレンダー済。
</p>

<h2>🎨 サムネイル候補（1280×720）</h2>
<p class="section-note">採用候補: A=データ強調 / D=問いかけ / C=対比(VS) / L=BREAKING / N=雑誌 / O=トレカ / R=REGAL（AI提案系）</p>

<h3>👑 テンプレR: REGAL シリーズ（gpt-image-1 提案 → HTML/CSS 化）</h3>
<p class="section-note">
赤×ネイビー / 青×ゴールド / 緑×ゴールド の3案。AI が描いたサムネ完成画像のレイアウト・配色を
HTML/CSS で再現したテンプレ。本番では選手写真・数字・タイトルを差し替えるだけで量産可能。
</p>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_R_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>テンプレA: データ強調型</h3>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_A\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>テンプレD: 問いかけ型</h3>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_D\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>テンプレC: 対比型（VS）</h3>
<p class="section-note">2エンティティの直接対決。クラシコ/キーマン対決/今季の MVP 候補比較などに最適。</p>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_C\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>🔥 テンプレL: BREAKING JUMBOTRON（5ch風 × データ）</h3>
<p class="section-note">
赤い斜めリボン + 円形プレミアムバッジ + 斜め黄色帯。フォント大幅増強。
</p>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_L\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>📰 テンプレN: MAGAZINE COVER（雑誌表紙風）</h3>
<p class="section-note">
"FOOTBALL ANALYSIS" マストヘッド + 円形ステッカー × 3 + バーコード。エディトリアル感MAX。
</p>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_N\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>🃏 テンプレO: TRADING CARD（トレカ風）</h3>
<p class="section-note">
ホログラフィック金枠カード + OVR スコア + 4種スタッツグリッド。コレクション感×データ。
</p>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_O\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h2>🎬 オープニング 3バリエーション</h2>
<p class="section-note">
ハキミ案件 / PSG vs バイエルン案件 で各バリエーションを試したサンプル。<br>
V1=現行 / V2=数字フラッシュ / V3=タイトル爆発
</p>

<div class="opedb-grid">
${opEdSamples.filter(s => s.name.startsWith('op_')).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap"><iframe src="${s.name}.html"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h2>🎬 エンディング 3バリエーション</h2>
<p class="section-note">
V1=現行（CTAのみ）/ V2=要点サマリ + CTA / V3=次回予告 + CTA
</p>

<div class="opedb-grid">
${opEdSamples.filter(s => s.name.startsWith('ed_')).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap"><iframe src="${s.name}.html"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<script>
// iframe を実コンテナサイズに合わせて scale
function fitIframes() {
  document.querySelectorAll('.iframe-wrap').forEach(wrap => {
    const iframe = wrap.querySelector('iframe');
    if (!iframe) return;
    const wrapW = wrap.clientWidth;
    const isThumb = wrap.classList.contains('thumb');
    const baseW = isThumb ? 1280 : 1920;
    const scale = wrapW / baseW;
    iframe.style.transform = 'scale(' + scale + ')';
  });
}
window.addEventListener('load', fitIframes);
window.addEventListener('resize', fitIframes);
</script>
`;

saveHtml('showcase.html', indexHtml);

// ─── REGAL シリーズ 比較ページ（AI画像 vs HTML テンプレ）──
const regalCompareHtml = `<!doctype html><meta charset=utf-8>
<title>REGAL シリーズ 比較: AI画像 vs HTML テンプレ</title>
<style>
:root { --bg:#0a0e1a; --panel:#161b2e; --border:#2a3050; --text:#f1f5ff; --muted:#8a9aba; --accent:#f59e0b; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Hiragino Kaku Gothic ProN', sans-serif; background: var(--bg); color: var(--text); padding: 24px; max-width: 1700px; margin: 0 auto; }
h1 { color: var(--accent); margin-bottom: 8px; font-size: 24px; }
h2 { color: #7dc8ff; margin: 28px 0 14px; font-size: 18px; padding-bottom: 8px; border-bottom: 2px solid var(--border); }
.intro { color: var(--muted); margin-bottom: 18px; line-height: 1.6; }
.intro b { color: var(--text); }

.compare-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
  margin-bottom: 28px;
}
.compare-cell {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.compare-cell .cell-label {
  padding: 10px 16px;
  background: rgba(245,158,11,0.08);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;
}
.compare-cell .cell-label.ai    { color: #fbbf24; }
.compare-cell .cell-label.html  { color: #7dc8ff; }

/* iframe (HTML 1280x720) と img (AI 1536x1024) でアスペクト比違うが
   width 100% で揃える。aspect-ratio で見た目の高さを揃える */
.cell-media {
  width: 100%;
  aspect-ratio: 16/9;
  overflow: hidden;
  background: #000;
  position: relative;
}
.cell-media iframe {
  position: absolute;
  top: 0; left: 0;
  width: 1280px; height: 720px;
  transform-origin: top left;
  border: 0;
  pointer-events: none;
}
.cell-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center center;
  display: block;
}
</style>

<h1>👑 REGAL シリーズ 実装 vs AI 画像 比較</h1>
<p class="intro">
左: gpt-image-1 が生成した <b>AI 完成画像</b>（参考デザイン）<br>
右: それを基に書き起こした <b>HTML/CSS テンプレ</b>（差替可能・量産可能）<br>
※ AI 画像は 1536×1024（3:2）、HTML テンプレは 1280×720（16:9）。表示時は 16:9 にトリミング表示。
</p>

<h2>R-Red: ハキミ離脱（衝撃系）</h2>
<div class="compare-row">
  <div class="compare-cell">
    <div class="cell-label ai">🎨 AI画像（参考）</div>
    <div class="cell-media"><img src="/v2_thumbs/_ai_proposals_v3/finished_01_hakimi.png" alt="AI"></div>
  </div>
  <div class="compare-cell">
    <div class="cell-label html">⚙️ HTML テンプレ実装</div>
    <div class="cell-media"><iframe src="thumb_R_red_hakimi.html"></iframe></div>
  </div>
</div>

<h2>R-Blue: オリーセ覚醒（知的分析）</h2>
<div class="compare-row">
  <div class="compare-cell">
    <div class="cell-label ai">🎨 AI画像（参考）</div>
    <div class="cell-media"><img src="/v2_thumbs/_ai_proposals_v3/finished_02_olise.png" alt="AI"></div>
  </div>
  <div class="compare-cell">
    <div class="cell-label html">⚙️ HTML テンプレ実装</div>
    <div class="cell-media"><iframe src="thumb_R_blue_olise.html"></iframe></div>
  </div>
</div>

<h2>R-Green: カゼミーロ復活（朗報系）</h2>
<div class="compare-row">
  <div class="compare-cell">
    <div class="cell-label ai">🎨 AI画像（参考）</div>
    <div class="cell-media"><img src="/v2_thumbs/_ai_proposals_v3/finished_03_casemiro.png" alt="AI"></div>
  </div>
  <div class="compare-cell">
    <div class="cell-label html">⚙️ HTML テンプレ実装</div>
    <div class="cell-media"><iframe src="thumb_R_green_casemiro.html"></iframe></div>
  </div>
</div>

<script>
function fitIframes() {
  document.querySelectorAll('.cell-media').forEach(wrap => {
    const iframe = wrap.querySelector('iframe');
    if (!iframe) return;
    const scale = wrap.clientWidth / 1280;
    iframe.style.width  = '1280px';
    iframe.style.height = '720px';
    iframe.style.transform = 'scale(' + scale + ')';
    // wrap の高さは aspect-ratio 16/9 が CSS で確保するので変更しない
  });
}
window.addEventListener('load', fitIframes);
window.addEventListener('resize', fitIframes);
</script>
`;
saveHtml('regal_compare.html', regalCompareHtml);

console.log(`✅ サムネ ${thumbSamples.length}件 + OP/ED ${opEdSamples.length}件 + showcase.html + regal_compare.html 出力完了`);
console.log(`📋 URL: http://37.60.224.54:3004/v2_videos/voice_test/showcase.html`);
console.log(`👑 比較: http://37.60.224.54:3004/v2_videos/voice_test/regal_compare.html`);
