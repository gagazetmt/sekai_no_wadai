// scripts/v2_video/slides/universal.js
// 汎用フォールバック：背景 + タイトル + ナレーションテキスト
// stats / profile / comparison / reaction など、個別テンプレを書いてない型の fallback

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar } = require('./_common');

function buildUniversalHTML(mod) {
  const bg    = imgDataUri(mod.bgImage);
  const title = mod.title || '';
  const narr  = mod.narration || '';

  // 追加情報（dataSlots / catchphrases / comments）を短くまとめて表示
  const extras = [];
  if (Array.isArray(mod.dataSlots) && mod.dataSlots.length) {
    mod.dataSlots.slice(0, 6).forEach(s => {
      if (s.label || s.value || s.leftValue) {
        if (s.leftValue !== undefined) {
          extras.push(`${esc(s.label || '')}: ${esc(s.leftValue || '')} vs ${esc(s.rightValue || '')}`);
        } else {
          extras.push(`${esc(s.label || '')}: ${esc(s.value || '')}`);
        }
      }
    });
  }
  if (Array.isArray(mod.catchphrases) && mod.catchphrases.length) {
    mod.catchphrases.slice(0, 5).forEach(p => { if (p) extras.push(esc(p)); });
  }
  if (Array.isArray(mod.comments) && mod.comments.length) {
    mod.comments.slice(0, 4).forEach(c => { if (c?.text) extras.push('「' + esc(c.text) + '」'); });
  }

  const extraStyles = `
.bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover;
  background-position: center;
  filter: brightness(0.28);
}
.content-wrap {
  position: absolute; inset: 0;
  padding: 90px 100px 120px;
  display: flex; flex-direction: column;
  z-index: 5;
}
.u-type-badge {
  display: inline-block;
  padding: 8px 24px;
  background: ${PALETTE.accent};
  color: #000;
  font-size: 22px;
  font-weight: 800;
  letter-spacing: 3px;
  border-radius: 6px;
  align-self: flex-start;
  margin-bottom: 30px;
}
.u-title {
  font-size: 84px;
  font-weight: 900;
  border-left: 14px solid ${PALETTE.accent};
  padding-left: 36px;
  margin-bottom: 50px;
  line-height: 1.2;
  text-shadow: 0 4px 20px rgba(0,0,0,0.8);
}
.u-extras {
  display: flex; flex-direction: column; gap: 18px;
  flex: 1;
  margin-bottom: 40px;
}
.u-extra {
  background: linear-gradient(135deg, rgba(245,158,11,0.18) 0%, rgba(245,158,11,0.04) 100%);
  border-left: 8px solid ${PALETTE.accent};
  border-radius: 0 12px 12px 0;
  padding: 20px 32px;
  font-size: 40px;
  font-weight: 700;
  color: ${PALETTE.text};
}
.u-narr-bar {
  background: rgba(0,0,0,0.85);
  border-top: 3px solid rgba(245,158,11,0.5);
  padding: 28px 60px;
  font-size: 36px;
  font-weight: 700;
  text-align: center;
  color: ${PALETTE.text};
  line-height: 1.4;
  position: absolute; bottom: 0; left: 0; right: 0;
  max-height: 220px;
  overflow: hidden;
}
`;

  const slideBody = `
<div class="bg-img"></div>
<div class="content-wrap">
  <div class="u-type-badge">${esc((mod.type || '').toUpperCase())}</div>
  <div class="u-title">${esc(title)}</div>
  <div class="u-extras">
    ${extras.slice(0, 5).map(x => `<div class="u-extra">${x}</div>`).join('')}
  </div>
</div>
${buildSubtitleBar(narr, { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildUniversalHTML };
