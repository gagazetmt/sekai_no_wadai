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
  left: 50px; right: 50px; bottom: 70px;
  display: flex; align-items: flex-end; justify-content: space-between; gap: 24px;
  z-index: 5;
}
.sub-data {
  display: ${subData ? 'flex' : 'none'};
  align-items: center;
  gap: 18px;
  background: ${isLight
    ? 'linear-gradient(135deg, #fff 0%, #fff8e1 100%)'
    : 'linear-gradient(135deg, rgba(20,15,25,0.95) 0%, rgba(40,30,15,0.92) 100%)'};
  border: 3px solid ${p.accent};
  border-left: 8px solid ${p.accent};
  padding: 18px 28px 18px 22px;
  border-radius: 12px;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
  font-size: 28px;
  font-weight: 900;
  color: ${p.text};
  letter-spacing: 1px;
  text-shadow: ${isLight ? '0 1px 0 #fff' : '0 2px 8px rgba(0,0,0,0.7)'};
  flex: 1;
  max-width: 720px;
  box-shadow:
    0 0 0 2px #000 inset,
    0 0 24px rgba(245,158,11,0.5),
    0 8px 24px rgba(0,0,0,0.55);
}
/* 雷アイコン（SVG, グロー強め）*/
.sub-data::before {
  content: '';
  flex-shrink: 0;
  width: 56px; height: 56px;
  background: ${p.accent};
  border: 3px solid #000;
  border-radius: 50%;
  -webkit-mask-image: radial-gradient(circle, black 60%, transparent 62%);
  mask-image: none;
  position: relative;
  background-image:
    radial-gradient(circle at 50% 50%, ${p.accent} 0%, #fff 70%, ${p.accent} 100%);
  box-shadow:
    0 0 0 3px #000,
    0 0 18px ${p.accent},
    inset 0 -6px 12px rgba(180,83,9,0.4);
}
.sub-data .icon-wrap {
  flex-shrink: 0;
  position: relative;
  width: 64px; height: 64px;
  background: radial-gradient(circle at 35% 30%, #fef3c7 0%, ${p.accent} 60%, #b45309 100%);
  border: 4px solid #000;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  box-shadow:
    0 0 0 3px ${p.accent} inset,
    0 0 24px rgba(252,211,77,0.7),
    0 6px 16px rgba(0,0,0,0.6);
}
.sub-data .icon-wrap svg {
  width: 36px; height: 36px;
  filter: drop-shadow(2px 2px 0 #000);
}
/* デフォルトの ::before は隠す（icon-wrap で代替）*/
.sub-data::before { display: none; }
.bottom-badge {
  display: ${bottomBadge ? 'inline-flex' : 'none'};
  align-items: center; gap: 10px;
  background: linear-gradient(180deg, #fde047 0%, ${p.accent} 100%);
  color: #000;
  padding: 14px 30px;
  border: 3px solid #000;
  border-radius: 8px;
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 28px;
  font-weight: 900;
  letter-spacing: 4px;
  box-shadow:
    4px 4px 0 #000,
    0 0 28px rgba(245,158,11,0.7);
  -webkit-text-stroke: 0.5px #000;
}
.bottom-badge::before {
  content: '▶';
  font-size: 22px;
  color: #ef4444;
  text-shadow: 1px 1px 0 #000;
}

/* ── 装飾: スパークル（4隅）── */
.sparkle {
  position: absolute;
  width: 36px; height: 36px;
  z-index: 4;
  pointer-events: none;
  filter: drop-shadow(0 0 8px ${p.accent});
}
.sp-tl { top: 90px; left: 40px; }
.sp-tr { top: 110px; right: 40px; }
.sp-bl { bottom: 60px; left: 30px; }
.sp-br { bottom: 90px; right: 30px; transform: scale(1.2); }

/* ── ハロライン（質問テキストに沿った金線）── */
.halo-line {
  position: absolute;
  left: 30%; right: 30%;
  height: 3px;
  background: linear-gradient(90deg, transparent, ${p.accent} 20%, #fff 50%, ${p.accent} 80%, transparent);
  z-index: 3;
  box-shadow: 0 0 18px rgba(252,211,77,0.7);
}
.halo-top { top: 38%; }
.halo-bot { top: 62%; }

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

  const sparkleSvg = `
<svg viewBox="0 0 24 24" fill="${p.accent}" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 0L14 9L23 11L14 13L12 22L10 13L1 11L10 9Z"/>
</svg>`;
  const lightningSvg = `
<svg viewBox="0 0 24 24" fill="#000" xmlns="http://www.w3.org/2000/svg">
  <path d="M14 0L4 14H10L8 24L20 9H13L15 0Z"/>
</svg>`;

  const thumbBody = `
<div class="bg-img"></div>
<div class="bg-overlay"></div>
<div class="halo-line halo-top"></div>
<div class="halo-line halo-bot"></div>
<div class="qmark-bg">?</div>
<div class="sparkle sp-tl">${sparkleSvg}</div>
<div class="sparkle sp-tr">${sparkleSvg}</div>
<div class="sparkle sp-bl">${sparkleSvg}</div>
<div class="sparkle sp-br">${sparkleSvg}</div>
${heroImg ? `<div class="hero-photo-corner" style="background-image: url('${heroImg}')"></div>` : ''}
<div class="question-zone">
  <div class="question-text">${questionHtml}</div>
</div>
<div class="bottom-zone">
  ${subData ? `<div class="sub-data"><div class="icon-wrap">${lightningSvg}</div><span>${esc(subData)}</span></div>` : '<div></div>'}
  ${bottomBadge ? `<div class="bottom-badge">${esc(bottomBadge)}</div>` : ''}
</div>
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail D (${tone}): Question`, tone });
}

module.exports = { buildQuestionThumb };
