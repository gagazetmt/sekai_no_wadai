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

// テンプレA: データ強調型 × 3
[
  {
    name: 'thumb_A1_hakimi',
    label: 'A-1: ハキミ怪我',
    data: {
      heroImage: IMG.hakimi,
      heroNumber: '161',
      heroLabel: 'PSGでの試合数',
      catch: 'ハキミ離脱の衝撃',
      badge: '緊急',
      badgeColor: '#ef4444',
    },
  },
  {
    name: 'thumb_A2_olise',
    label: 'A-2: オリーセ覚醒',
    data: {
      heroImage: IMG.olise,
      heroNumber: '+5.2',
      heroLabel: 'xG超過',
      catch: 'オリーセ 異次元の決定力',
      badge: '衝撃',
      badgeColor: '#ef4444',
    },
  },
  {
    name: 'thumb_A3_casemiro',
    label: 'A-3: カゼミーロ復活',
    data: {
      heroImage: IMG.casemiro,
      heroNumber: '8.4',
      heroLabel: '直近試合 評定',
      catch: 'カゼミーロ 完全復活',
      badge: '朗報',
      badgeColor: '#10b981',
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
      catch: 'オリーセ 異次元の決定力',
      badge: '衝撃',
      badgeColor: '#dc2626',
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
<p class="section-note">クリックで原寸表示。サムネは静的画像（アニメなし）。</p>

<h3>テンプレA: データ強調型</h3>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_A\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>テンプレB: ランキング型</h3>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_B\d+_/.test(s.name)).map(s => `
<div class="thumb-card">
  <div class="iframe-wrap thumb"><iframe src="${s.name}.html" id="if-${s.name}"></iframe></div>
  <div class="label">${s.label}<small><a href="${s.name}.html" target="_blank">原寸</a></small></div>
</div>`).join('')}
</div>

<h3>テンプレC: VS型</h3>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_C\d+_/.test(s.name)).map(s => `
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

<h2>☀️ Light tone バリエーション（4種）</h2>
<p class="section-note">
ダーク版と同じレイアウトで配色を明るめに。クリームペーパー風の落ち着いた印象。<br>
A=データ強調 / B=ランキング / C=VS / D=問いかけ
</p>
<div class="thumbs-grid">
${thumbSamples.filter(s => /thumb_[A-D]L_/.test(s.name)).map(s => `
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

console.log(`✅ サムネ ${thumbSamples.length}件 + OP/ED ${opEdSamples.length}件 + showcase.html 出力完了`);
console.log(`📋 URL: http://37.60.224.54:3004/v2_videos/voice_test/showcase.html`);
