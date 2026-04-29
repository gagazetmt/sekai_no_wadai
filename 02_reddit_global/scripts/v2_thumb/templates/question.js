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
  filter: ${isLight ? 'brightness(0.95) contrast(1.05)' : 'brightness(0.45) contrast(1.08)'};
}
.bg-overlay {
  position: absolute; inset: 0;
  background: ${isLight
    ? `radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(247,243,236,0.3) 100%),
       linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(247,243,236,0.20) 100%)`
    : `radial-gradient(ellipse at 50% 50%, transparent 30%, rgba(6,14,28,0.7) 100%),
       linear-gradient(180deg, rgba(6,14,28,0.30) 0%, rgba(6,14,28,0.55) 100%)`};
}

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

.question-zone {
  position: absolute;
  top: 90px; left: 60px; right: 60px; bottom: 140px;
  display: flex; flex-direction: column; justify-content: center;
  z-index: 5;
}
.question-text {
  font-size: 110px;
  font-weight: 900;
  color: ${p.text};
  line-height: 1.15;
  letter-spacing: 1px;
  ${isLight ? '' : '-webkit-text-stroke: 2.5px rgba(255,255,255,0.2);'}
  text-shadow: ${isLight
    ? `0 4px 12px rgba(0,0,0,0.10), 0 0 18px rgba(255,255,255,0.6)`
    : `0 0 14px rgba(255,255,255,0.5), 0 0 32px rgba(245,158,11,0.5), 0 8px 32px rgba(0,0,0,0.95), 0 2px 6px rgba(0,0,0,1)`};
  word-break: keep-all;
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
