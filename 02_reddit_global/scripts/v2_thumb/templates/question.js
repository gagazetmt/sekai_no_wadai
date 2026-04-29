// scripts/v2_thumb/templates/question.js
// サムネ テンプレ D: 問いかけ型 (tone: 'dark' | 'light')

const {
  PALETTE, tonePalette, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildQuestionThumb(data = {}) {
  const tone = data.tone || 'dark';
  const isLight = tone === 'light';
  const p = tonePalette(tone);
  const bg = imgDataUri(data.bgImage);
  const question = data.question || 'なぜ?';
  const subData = data.subData || '';
  const heroImg = imgDataUri(data.heroImage);
  const bottomBadge = data.bottomBadge || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: ${isLight ? 'radial-gradient(ellipse at 30% 50%, #fefaf2 0%, #efeae0 100%)' : 'radial-gradient(ellipse at 30% 50%, #1f2a4a 0%, #060a14 100%)'};`}
  background-size: cover;
  background-position: center;
  filter: ${isLight ? 'brightness(0.98) contrast(1.05)' : 'brightness(0.85) contrast(1.08)'};
}
/* 横帯オーバーレイ：上下明るい（画像のまま見せる）/ 中央暗い（タイトル映え）*/
.bg-overlay {
  position: absolute; inset: 0;
  background: ${isLight
    ? `linear-gradient(180deg,
        rgba(255,255,255,0.0) 0%,
        rgba(255,255,255,0.0) 22%,
        rgba(8,12,24,0.78) 38%,
        rgba(8,12,24,0.85) 60%,
        rgba(255,255,255,0.0) 78%,
        rgba(255,255,255,0.0) 100%)`
    : `linear-gradient(180deg,
        rgba(0,0,0,0.0) 0%,
        rgba(0,0,0,0.0) 22%,
        rgba(0,0,0,0.85) 38%,
        rgba(0,0,0,0.85) 60%,
        rgba(0,0,0,0.0) 78%,
        rgba(0,0,0,0.0) 100%)`};
}
/* 暗帯左右の縁にアクセントライン */
.band-line-top, .band-line-bot {
  position: absolute;
  left: 0; right: 0;
  height: 4px;
  background: linear-gradient(90deg, transparent, ${p.accent}, transparent);
  z-index: 4;
  box-shadow: 0 0 16px rgba(245,158,11,0.5);
}
.band-line-top { top: 36%; }
.band-line-bot { top: 64%; }

.qmark-bg {
  position: absolute;
  top: -100px; left: -50px;
  font-family: 'Georgia', serif;
  font-size: 720px;
  font-weight: 900;
  font-style: italic;
  color: ${isLight ? 'rgba(245, 158, 11, 0.16)' : 'rgba(245, 158, 11, 0.10)'};
  line-height: 1;
  z-index: 2;
  user-select: none;
}

/* 暗帯ゾーンに合わせて中央配置（top 36% から bottom 64% まで） */
.question-zone {
  position: absolute;
  top: 36%; bottom: 36%;
  left: 60px; right: 60px;
  display: flex; flex-direction: column; justify-content: center;
  z-index: 5;
}
.question-text {
  font-size: 96px;
  font-weight: 900;
  color: #fff;
  line-height: 1.15;
  letter-spacing: 1px;
  -webkit-text-stroke: 2px rgba(255,255,255,0.22);
  text-shadow:
    0 0 16px rgba(255,255,255,0.6),
    0 0 36px rgba(245,158,11,0.55),
    0 6px 24px rgba(0,0,0,0.9);
  word-break: keep-all;
  text-align: center;
}
.question-text .accent {
  color: ${p.accent};
  text-shadow: ${isLight
    ? `0 0 20px rgba(245,158,11,0.5), 0 4px 12px rgba(194,116,10,0.4)`
    : `0 0 22px rgba(245,158,11,0.8), 0 0 50px rgba(245,158,11,0.5), 0 6px 28px rgba(0,0,0,0.95)`};
  font-style: italic;
  font-family: 'Georgia', serif;
}

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
  background: ${isLight ? 'rgba(255, 255, 255, 0.85)' : 'rgba(0, 0, 0, 0.72)'};
  border-left: 5px solid ${p.accent};
  padding: 14px 24px;
  border-radius: 0 8px 8px 0;
  font-size: 26px;
  font-weight: 700;
  color: ${p.text};
  letter-spacing: 1px;
  text-shadow: ${isLight ? 'none' : '0 2px 8px rgba(0,0,0,0.7)'};
  flex: 1;
  max-width: 700px;
  box-shadow: ${isLight ? '0 4px 16px rgba(0,0,0,0.10)' : 'none'};
}
.sub-data::before {
  content: '⚡';
  color: ${p.accent};
  font-size: 28px;
}
.bottom-badge {
  display: ${bottomBadge ? 'inline-block' : 'none'};
  background: ${p.accent};
  color: #000;
  padding: 12px 26px;
  border-radius: 6px;
  font-size: 26px;
  font-weight: 900;
  letter-spacing: 4px;
  box-shadow: 0 6px 24px rgba(245,158,11,0.5);
}

.hero-photo-corner {
  position: absolute;
  right: 36px; top: 80px;
  width: 200px; height: 200px;
  border-radius: 50%;
  background-size: cover;
  background-position: center 20%;
  border: 5px solid ${p.accent};
  box-shadow: 0 0 30px rgba(245,158,11,0.6), 0 8px 20px rgba(0,0,0,0.7);
  z-index: 4;
  display: ${heroImg ? 'block' : 'none'};
}

${channelLogoStyleFor(tone)}
`;

  const questionHtml = (() => {
    const m = question.match(/^([\s\S]+?)([?？!！]+)$/);
    if (m) return `${esc(m[1])}<span class="accent">${esc(m[2])}</span>`;
    return esc(question);
  })();

  const thumbBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="band-line-top"></div>
<div class="band-line-bot"></div>
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

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail D (${tone}): Question`, tone });
}

module.exports = { buildQuestionThumb };
