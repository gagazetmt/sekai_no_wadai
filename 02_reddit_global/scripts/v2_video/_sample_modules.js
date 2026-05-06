// scripts/v2_video/_sample_modules.js
// 各スライドタイプのサンプルデータ（プレビュー用）
//
// 使い方:
//   const { SAMPLES, getSample } = require('./_sample_modules');
//   const mod = getSample('stats');
//
// 各サンプルは現実的な audio.durationSec を含み、
// chunk連動アニメーション・字幕遷移が visual に確認できる。

const SAMPLE_AUDIO_5 = [
  { chunkIdx: 0, text: '最初のチャンクです。スライドが始まって最初に読まれます。', durationSec: 4.5 },
  { chunkIdx: 1, text: '2つ目のチャンク。少し短めの文章。', durationSec: 3.2 },
  { chunkIdx: 2, text: '3つ目のチャンクは少し長くなります。読み上げに時間がかかります。', durationSec: 5.0 },
  { chunkIdx: 3, text: '4つ目。', durationSec: 1.5 },
  { chunkIdx: 4, text: '最後のチャンクで締めくくります。', durationSec: 3.8 },
];
const SAMPLE_AUDIO_4 = SAMPLE_AUDIO_5.slice(0, 4);
const SAMPLE_AUDIO_3 = SAMPLE_AUDIO_5.slice(0, 3);
const SAMPLE_AUDIO_1 = [{ chunkIdx: 0, text: 'タイトル冒頭の煽りナレーション。短いです。', durationSec: 6.0 }];

const SAMPLES = {
  opening: {
    type: 'opening',
    title: '相棒、これがopening スライドだよ',
    narration: '',  // タイトル読み上げのみ（narration なし）
    audio: [{ chunkIdx: 0, text: '相棒、これがopening スライドだよ', durationSec: 3.5 }],
    badge: { text: '速報', color: 'red' },
  },

  toc: {
    type: 'toc',
    title: '今日のラインナップ',
    tocItems: [
      { text: 'マンチェスター・シティ vs アーセナル', chunkText: 'まずは注目の試合プレビューから。' },
      { text: '注目選手の今シーズン成績',             chunkText: '続いて両チームのキープレイヤー。' },
      { text: '直近10戦の対戦カード',                 chunkText: '次に直近10戦の対戦カード。' },
      { text: 'CL 進出の鍵となる戦術比較',            chunkText: 'CL 出場権争いを左右する戦術。' },
      { text: 'ファンの本音',                         chunkText: '最後に Reddit 民の本音。' },
    ],
    // 煽り入りオープニング目次案内 (150〜200字)
    narration: 'サッカーファンのみなさん、こんにちは。プレミアリーグ最終盤、CL出場権をかけた天王山、マンチェスター・シティとアーセナルの直接対決が今週末に迫っています。本日は、試合プレビュー、注目選手のスタッツ、直近10戦の対戦カード、戦術比較、そしてファンの本音の5つのラインナップで、膨大なデータから読み取った独自解説をお届けします。',
    audio: [
      { chunkIdx: 0, text: 'サッカーファンのみなさん、こんにちは。',                                           durationSec: 2.6 },
      { chunkIdx: 1, text: 'プレミアリーグ最終盤、CL出場権をかけた天王山、',                                   durationSec: 3.4 },
      { chunkIdx: 2, text: 'マンチェスター・シティとアーセナルの直接対決が今週末に迫っています。',             durationSec: 4.6 },
      { chunkIdx: 3, text: '本日は、試合プレビュー、注目選手のスタッツ、',                                     durationSec: 3.5 },
      { chunkIdx: 4, text: '直近10戦の対戦カード、戦術比較、そしてファンの本音の5つのラインナップで、',        durationSec: 5.0 },
      { chunkIdx: 5, text: '膨大なデータから読み取った独自解説をお届けします。',                                durationSec: 3.8 },
    ],
  },

  insight: {
    type: 'insight',
    title: '注目ポイント',
    catchphrases: [
      { text: '勝点差わずか3、運命のシーズン終盤',     chunkText: '現在勝点差わずか3で迎える運命の終盤戦。' },
      { text: 'シティの脅威の得点力 (87ゴール)',       chunkText: 'シティはここまで87ゴールを記録。' },
      { text: 'アーセナル、守護神サリバの存在',         chunkText: 'アーセナルは守護神サリバが安定。' },
      { text: 'マッチアップ：ハーランド vs ガブリエル', chunkText: '注目はハーランドとガブリエルの直接対決。' },
      { text: '直近対戦は熱狂的な打ち合い',             chunkText: '直近の対戦は熱狂的な打ち合いだった。' },
    ],
    narration: 'では本題、シーズン終盤の天王山に迫ります。両者の勝点差はわずか3。シティはここまで87ゴールを記録、ハーランド中心の脅威の得点力を維持しています。一方アーセナルは守護神サリバの存在でリーグ屈指の堅守を誇り、ハーランド対ガブリエルというリーグ最強同士のマッチアップが実現する見込みです。直近の対戦は熱狂的な打ち合いとなり、今回も両者譲らない緊迫の90分が予想されます。',
    audio: [
      { chunkIdx: 0, text: 'では本題、シーズン終盤の天王山に迫ります。', durationSec: 3.2 },
      { chunkIdx: 1, text: '両者の勝点差はわずか3。', durationSec: 2.0 },
      { chunkIdx: 2, text: 'シティはここまで87ゴールを記録、ハーランド中心の脅威の得点力を維持しています。', durationSec: 5.5 },
      { chunkIdx: 3, text: '一方アーセナルは守護神サリバの存在でリーグ屈指の堅守を誇り、', durationSec: 4.5 },
      { chunkIdx: 4, text: 'ハーランド対ガブリエルというリーグ最強同士のマッチアップが実現する見込みです。', durationSec: 5.0 },
      { chunkIdx: 5, text: '直近の対戦は熱狂的な打ち合いとなり、今回も両者譲らない緊迫の90分が予想されます。', durationSec: 5.0 },
    ],
  },

  history: {
    type: 'history',
    title: '過去の対戦の歴史',
    dataSlots: [
      { label: '2018', value: 'シティ 3-1 勝利、絶頂期の象徴' },
      { label: '2020', value: 'アーセナル 2-0 勝利、覚醒の予兆' },
      { label: '2022', value: 'シティ 2-1 勝利、終盤の劇的勝負' },
      { label: '2023', value: 'アーセナル 0-0 ドロー、防御の真価' },
      { label: '2024', value: 'シティ 5-1 勝利、圧倒的な攻撃力' },
    ],
    narration: '両チームの過去5年間の対戦は劇的な歴史を刻んできました。',
    audio: SAMPLE_AUDIO_5,
  },

  stats: {
    type: 'stats',
    title: 'マンチェスター・シティ 今季スタッツ',
    dataSlots: [
      { label: '出場',   value: '32' },
      { label: 'ゴール', value: '87' },
      { label: 'アシスト', value: '52' },
      { label: '勝利',   value: '23' },
      { label: 'クリーンシート', value: '15' },
      { label: 'xG',     value: '78.4' },
    ],
    narration: 'マンチェスター・シティは今シーズン圧倒的なパフォーマンスを見せています。',
    audio: SAMPLE_AUDIO_4,
  },

  profile: {
    type: 'profile',
    title: 'ジョアン・ペドロ',
    subtitle: 'チェルシー / フォワード',
    dataSlots: [
      { label: '年齢', value: '23' },
      { label: '身長', value: '180cm' },
      { label: '出場', value: '28' },
      { label: 'ゴール', value: '14' },
      { label: 'アシスト', value: '6' },
      { label: '評定', value: '7.42' },
    ],
    narration: 'ブラジル代表のジョアン・ペドロは今シーズン孤独な奮闘を続けています。',
    audio: SAMPLE_AUDIO_4,
  },

  comparison: {
    type: 'comparison',
    title: 'シティ vs アーセナル スタッツ対決',
    dataSlots: [
      { label: '今季ゴール',   leftValue: '87', rightValue: '74' },
      { label: '今季失点',     leftValue: '32', rightValue: '28' },
      { label: 'ポゼッション', leftValue: '63%', rightValue: '60%' },
      { label: 'シュート/試合', leftValue: '17.2', rightValue: '15.8' },
      { label: '勝点',         leftValue: '76', rightValue: '73' },
    ],
    leftLabel: 'Manchester City',
    rightLabel: 'Arsenal',
    narration: 'シーズン終盤、両チームのスタッツを徹底比較します。',
    audio: SAMPLE_AUDIO_5,
  },

  matchcard: {
    type: 'matchcard',
    title: 'プレビュー',
    matchData: {
      league: 'プレミアリーグ',
      kickoff: '2026年5月10日 21:00',
      venue: 'エティハド・スタジアム',
      home: { name: 'Man City', abbr: 'MCI' },
      away: { name: 'Arsenal',  abbr: 'ARS' },
    },
    dataSlots: [
      { label: '直近対戦', value: 'シティ 5-1 アーセナル' },
      { label: 'リーグ順位', value: '1位 vs 2位' },
      { label: '注目選手', value: 'ハーランド / ガブリエル' },
      { label: 'キックオフ', value: '21:00 (JST 翌5:00)' },
    ],
    narration: 'プレミアリーグ最終盤の天王山。両者譲れない一戦です。',
    audio: SAMPLE_AUDIO_3,
  },

  reaction: {
    type: 'reaction',
    title: 'ファンの本音',
    comments: [
      { text: 'シティの強さがエグすぎる、PL 4連覇は確定だな',          score: 1245 },
      { text: 'アーセナル、後半は良かったけど前半の失点が痛かった',     score: 832 },
      { text: 'ハーランドの動き、もう人類じゃない',                   score: 691 },
      { text: 'サカの個人技は世界トップクラス',                       score: 542 },
      { text: 'グアルディオラの戦術、相変わらず読めない',             score: 411 },
      { text: 'アルテタの修正力に期待してる',                         score: 312 },
      { text: 'ノルウェー人の得点センスは異次元',                     score: 287 },
    ],
    narration: '勝負を観戦したファンたちの反応をまとめました。',
    audio: [
      { chunkIdx: 0, text: '勝負を観戦したファンたちの反応をまとめました', durationSec: 3.0 },
      { chunkIdx: 1, text: 'シティの強さがエグすぎる、PL 4連覇は確定だな', durationSec: 3.5 },
      { chunkIdx: 2, text: 'アーセナル、後半は良かったけど前半の失点が痛かった', durationSec: 4.0 },
      { chunkIdx: 3, text: 'ハーランドの動き、もう人類じゃない', durationSec: 2.5 },
      { chunkIdx: 4, text: 'サカの個人技は世界トップクラス', durationSec: 2.5 },
      { chunkIdx: 5, text: 'グアルディオラの戦術、相変わらず読めない', durationSec: 3.0 },
      { chunkIdx: 6, text: 'アルテタの修正力に期待してる', durationSec: 2.5 },
      { chunkIdx: 7, text: 'ノルウェー人の得点センスは異次元', durationSec: 2.8 },
    ],
  },

  ending: {
    type: 'ending',
    title: 'ご視聴ありがとうございました',
    narration: 'チャンネル登録、いいね、コメントお待ちしてます。次回もお楽しみに。',
    endingCta: { text: 'チャンネル登録お願いします' },
    audio: [
      { chunkIdx: 0, text: 'チャンネル登録、いいね、コメントお待ちしてます', durationSec: 4.0 },
      { chunkIdx: 1, text: '次回もお楽しみに', durationSec: 2.5 },
    ],
  },
};

function getSample(type) {
  return SAMPLES[type] || null;
}

function listTypes() {
  return Object.keys(SAMPLES);
}

module.exports = { SAMPLES, getSample, listTypes };
