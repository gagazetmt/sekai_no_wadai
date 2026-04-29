// scripts/v2_thumb/templates/question.js
// サムネ テンプレ D: 問いかけ型
//   - 試合写真の暗いオーバーレイ背景
//   - 中央に大きな疑問文タイトル（黄色グロー）
//   - 下に小さく数字 + ヒント
//   - 視聴者の好奇心を直接刺激する
//
// 入力:
//   {
//     bgImage: 'path/to/match.jpg',
//     question: 'ハキミ離脱で PSGは？',  // 大きな疑問文
//     subData: '失う 161試合の経験',     // 小さな補足
//     heroImage: 'path/to/face.jpg',     // 任意：右下に小さく顔
//     bottomBadge: '徹底分析',
//   }

const { PALETTE, esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyle, CHANNEL_NAME } = require('../_common');

function buildQuestionThumb(data = {}) {
  const bg = imgDataUri(data.bgImage);
  const question = data.question || 'なぜ?';
  const subData = data.subData || '';
  const heroImg = imgDataUri(data.heroImage);
  const bottomBadge = data.bottomBadge || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: radial-gradient(ellipse at 30% 50%, #1f2a4a 0%, #060a14 100%);`}
  background-size: cover;
  background-position: center;
  filter: brightness(0.45) contrast(1.08);
}
.bg-overlay {
  position: absolute; inset: 0;
  background:
    radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(6,14,28,0.7) 100%),
    linear-gradient(180deg, rgba(6,14,28,0.30) 0%, rgba(6,14,28,0.55) 100%);
}

/* ── ?マーク背景装飾 ── */
.qmark-bg {
  position: absolute;
  top: -100px; left: -50px;
  font-family: 'Georgia', serif;
  font-size: 720px;
  font-weight: 900;
  font-style: italic;
  color: rgba(245, 158, 11, 0.10);
  line-height: 1;
  z-index: 2;
  user-select: none;
}

/* ── 疑問文（大）── */
.question-zone {
  position: absolute;
  top: 90px; left: 60px; right: 60px; bottom: 140px;
  display: flex; flex-direction: column; justify-content: center;
  z-index: 5;
}
.question-text {
  font-size: 110px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.15;
  letter-spacing: 1px;
  -webkit-text-stroke: 2.5px rgba(255,255,255,0.2);
  text-shadow:
    0 0 14px rgba(255,255,255,0.5),
    0 0 32px rgba(245,158,11,0.5),
    0 8px 32px rgba(0,0,0,0.95),
    0 2px 6px rgba(0,0,0,1);
  word-break: keep-all;
}
.question-text .accent {
  color: ${PALETTE.accent};
  text-shadow:
    0 0 22px rgba(245,158,11,0.8),
    0 0 50px rgba(245,158,11,0.5),
    0 6px 28px rgba(0,0,0,0.95);
  font-style: italic;
  font-family: 'Georgia', serif;
}

/* ── 下部 サブデータ + バッジ + ヒーロー画像 ── */
.bottom-zone {
  position: absolute;
  left: 60px; right: 60px; bottom: 80px;
  display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  z-index: 5;
}
.sub-data {
  display: ${subData ? 'flex' : 'none'};
  align-items: center;
  gap: 12px;
  background: rgba(0, 0, 0, 0.72);
  border-left: 5px solid ${PALETTE.accent};
  padding: 14px 24px;
  border-radius: 0 8px 8px 0;
  font-size: 26px;
  font-weight: 700;
  color: ${PALETTE.text};
  letter-spacing: 1px;
  text-shadow: 0 2px 8px rgba(0,0,0,0.7);
  flex: 1;
  max-width: 700px;
}
.sub-data::before {
  content: '⚡';
  color: ${PALETTE.accent};
  font-size: 28px;
}
.bottom-badge {
  display: ${bottomBadge ? 'inline-block' : 'none'};
  background: ${PALETTE.accent};
  color: #000;
  padding: 12px 26px;
  border-radius: 6px;
  font-size: 26px;
  font-weight: 900;
  letter-spacing: 4px;
  box-shadow: 0 6px 24px rgba(245,158,11,0.5);
}

/* ── 右下：顔写真（任意）── */
.hero-photo-corner {
  position: absolute;
  right: 36px; top: 80px;
  width: 200px; height: 200px;
  border-radius: 50%;
  background-size: cover;
  background-position: center 20%;
  border: 5px solid ${PALETTE.accent};
  box-shadow: 0 0 30px rgba(245,158,11,0.6), 0 8px 20px rgba(0,0,0,0.7);
  z-index: 4;
  display: ${heroImg ? 'block' : 'none'};
}

${channelLogoStyle}
`;

  // 疑問文の最後の「?」「？」を accent カラーで強調
  const questionHtml = (() => {
    const m = question.match(/^([\s\S]+?)([?？!！]+)$/);
    if (m) return `${esc(m[1])}<span class="accent">${esc(m[2])}</span>`;
    return esc(question);
  })();

  const thumbBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="qmark-bg">?</div>
${heroImg ? `<div class="hero-photo-corner" style="background-image: url('${heroImg}')"></div>` : ''}
<div class="question-zone">
  <div class="question-text">${questionHtml}</div>
</div>
<div class="bottom-zone">
  ${subData ? `<div class="sub-data">${esc(subData)}</div>` : '<div></div>'}
  ${bottomBadge ? `<div class="bottom-badge">${esc(bottomBadge)}</div>` : ''}
</div>
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail D: Question' });
}

module.exports = { buildQuestionThumb };
