// scripts/v2_thumb/templates/vs.js
// サムネ テンプレ C: VS型 (tone: 'dark' | 'light')

const {
  PALETTE, tonePalette, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildVsThumb(data = {}) {
  const tone = data.tone || 'dark';
  const isLight = tone === 'light';
  const p = tonePalette(tone);
  const title = data.title || 'VS';
  const leftName = data.leftName || '?';
  const leftValue = data.leftValue || '';
  const leftImg = imgDataUri(data.leftImage);
  const rightName = data.rightName || '?';
  const rightValue = data.rightValue || '';
  const rightImg = imgDataUri(data.rightImage);
  const bottomCatch = data.bottomCatch || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background: ${isLight
    ? `linear-gradient(90deg, rgba(59, 130, 246, 0.15) 0%, transparent 35%, transparent 65%, rgba(239, 68, 68, 0.15) 100%),
       radial-gradient(ellipse at 50% 50%, #fefaf2 0%, #efeae0 100%)`
    : `linear-gradient(90deg, rgba(59, 130, 246, 0.18) 0%, transparent 35%, transparent 65%, rgba(239, 68, 68, 0.18) 100%),
       radial-gradient(ellipse at 50% 50%, #1f2a4a 0%, #060a14 100%)`};
}

.vs-title {
  position: absolute;
  top: 30px; left: 50%;
  transform: translateX(-50%);
  font-size: 38px;
  font-weight: 900;
  color: ${isLight ? '#fff' : p.text};
  letter-spacing: 6px;
  padding: 8px 28px;
  background: ${isLight ? p.accent : 'rgba(0, 0, 0, 0.7)'};
  border: 2px solid ${p.accent};
  border-radius: 6px;
  z-index: 6;
  white-space: nowrap;
  text-shadow: ${isLight ? 'none' : '0 0 10px rgba(245,158,11,0.4)'};
  box-shadow: ${isLight ? '0 4px 16px rgba(245,158,11,0.4)' : 'none'};
}

.fighter-zone {
  position: absolute;
  top: 110px; bottom: 110px; left: 0; right: 0;
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center;
  z-index: 5;
}
.fighter {
  display: flex; flex-direction: column; align-items: center;
  gap: 16px;
  padding: 0 24px;
}
.fighter.left { padding-right: 60px; }
.fighter.right { padding-left: 60px; }
.fighter-photo {
  width: 280px; height: 280px;
  border-radius: 50%;
  background-size: cover;
  background-position: center 20%;
  filter: contrast(1.1) saturate(1.1);
}
.fighter.left .fighter-photo {
  border: 6px solid #3b82f6;
  box-shadow: 0 0 36px rgba(59,130,246,0.65), 0 0 0 4px rgba(59,130,246,0.25) inset;
}
.fighter.right .fighter-photo {
  border: 6px solid #ef4444;
  box-shadow: 0 0 36px rgba(239,68,68,0.65), 0 0 0 4px rgba(239,68,68,0.25) inset;
}
.fighter-name {
  font-size: 48px;
  font-weight: 900;
  color: ${p.text};
  letter-spacing: 1px;
  ${isLight ? '' : '-webkit-text-stroke: 1.5px rgba(255,255,255,0.18);'}
  text-shadow: ${isLight ? '0 2px 6px rgba(0,0,0,0.10)' : '0 4px 16px rgba(0,0,0,0.95)'};
  white-space: nowrap;
}
.fighter-value {
  font-family: 'Georgia', serif;
  font-size: 50px;
  font-weight: 900;
  font-style: italic;
  color: ${p.accent};
  letter-spacing: -1px;
  text-shadow: ${isLight ? '0 2px 6px rgba(194,116,10,0.25)' : '0 0 16px rgba(245,158,11,0.5)'};
  white-space: nowrap;
}

.vs-badge {
  display: flex; flex-direction: column; align-items: center;
  font-family: 'Georgia', serif;
  font-style: italic;
}
.vs-text {
  font-size: 180px;
  font-weight: 900;
  color: ${p.accent};
  letter-spacing: -10px;
  line-height: 0.85;
  text-shadow: ${isLight
    ? `0 0 30px rgba(245,158,11,0.35), 0 4px 12px rgba(194,116,10,0.4)`
    : `0 0 40px rgba(245,158,11,0.8), 0 0 80px rgba(245,158,11,0.5), 0 8px 30px rgba(0,0,0,0.95)`};
  filter: drop-shadow(0 0 12px rgba(245,158,11,0.6));
}
.vs-spark {
  font-size: 24px;
  letter-spacing: 6px;
  color: ${p.text};
  margin-top: -10px;
  font-style: normal;
  font-weight: 900;
  text-shadow: ${isLight ? 'none' : '0 0 10px rgba(255,255,255,0.4)'};
}

.bottom-catch {
  position: absolute;
  bottom: 26px; left: 50%;
  transform: translateX(-50%);
  font-size: 32px;
  font-weight: 900;
  color: #000;
  background: ${p.accent};
  padding: 12px 36px;
  border-radius: 8px;
  letter-spacing: 2px;
  box-shadow: 0 6px 24px rgba(245,158,11,0.6);
  z-index: 7;
  white-space: nowrap;
}

${channelLogoStyleFor(tone)}
.channel-logo { left: 24px; bottom: 24px; }
`;

  const thumbBody = `
<div class="bg-gradient"></div>
<div class="vs-title">${esc(title)}</div>
<div class="fighter-zone">
  <div class="fighter left">
    <div class="fighter-photo" style="${leftImg ? `background-image: url('${leftImg}')` : `background: linear-gradient(135deg, ${isLight ? '#bfdbfe, #93c5fd' : '#1e3a8a, #0f1729'})`}"></div>
    <div class="fighter-name">${esc(leftName)}</div>
    ${leftValue ? `<div class="fighter-value">${esc(leftValue)}</div>` : ''}
  </div>
  <div class="vs-badge">
    <div class="vs-text">VS</div>
    <div class="vs-spark">CLASH</div>
  </div>
  <div class="fighter right">
    <div class="fighter-photo" style="${rightImg ? `background-image: url('${rightImg}')` : `background: linear-gradient(135deg, ${isLight ? '#fecaca, #fca5a5' : '#991b1b, #3f0a0a'})`}"></div>
    <div class="fighter-name">${esc(rightName)}</div>
    ${rightValue ? `<div class="fighter-value">${esc(rightValue)}</div>` : ''}
  </div>
</div>
${bottomCatch ? `<div class="bottom-catch">${esc(bottomCatch)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail C (${tone}): VS`, tone });
}

module.exports = { buildVsThumb };
