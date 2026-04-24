// scripts/v2_video/slides/history.js
// History スライド：左ヒーロー画像 + 右タイムライン（ドット+カード）
// テンプレート元: /history/index.html

const { PALETTE, esc, imgDataUri, wrapHTML } = require('./_common');

function buildHistoryHTML(mod) {
  const bg = imgDataUri(mod.bgImage);
  // dataSlots から events を組み立てる（label = 日付, value = タイトル）
  // catchphrases があれば「タイトル」として使う（narrationChunks との1対1対応）
  let events = [];
  if (Array.isArray(mod.dataSlots) && mod.dataSlots.length) {
    events = mod.dataSlots.map((s, i) => ({
      date:  s.label || `${i+1}`,
      title: s.value || (mod.catchphrases?.[i] || ''),
      sub:   mod.narrationChunks?.[i] || '',
    }));
  } else if (Array.isArray(mod.catchphrases) && mod.catchphrases.length) {
    events = mod.catchphrases.map((p, i) => ({
      date:  `${i+1}`,
      title: p,
      sub:   mod.narrationChunks?.[i] || '',
    }));
  }
  events = events.slice(0, 5);

  // タイトル・サブタイトル
  const heroTitle   = (mod.title || '').replace(/ /g, '<br>');
  const heroSubject = mod.type === 'history' ? 'JOURNEY' : (mod.type || '').toUpperCase();
  const subText     = mod.narration || '';

  const extraStyles = `
.slide { display: flex; }
.panel-hero {
  width: 35%;
  height: 100%;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}
.panel-hero .bg-img {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: ${PALETTE.surface};`}
  background-size: cover;
  background-position: center;
}
.panel-hero .overlay {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    rgba(6, 14, 28, 0.15) 0%,
    rgba(6, 14, 28, 0.45) 60%,
    rgba(6, 14, 28, 0.95) 100%);
}
.panel-hero .hero-title-box {
  position: absolute;
  left: 60px; right: 60px;
  bottom: 100px;
}
.panel-hero .hero-subject {
  font-size: 34px;
  font-weight: 700;
  color: ${PALETTE.accent};
  letter-spacing: 3px;
  margin-bottom: 10px;
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.9);
}
.panel-hero .hero-title {
  font-size: 72px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.15;
  text-shadow: 0 3px 14px rgba(0, 0, 0, 0.95);
}
.panel-timeline {
  flex: 1;
  height: 100%;
  padding: 80px 80px 100px 60px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  position: relative;
  background: ${PALETTE.bg};
}
.tl-header {
  font-size: 28px;
  font-weight: 700;
  color: #6080b0;
  letter-spacing: 4px;
  text-transform: uppercase;
  margin-bottom: 10px;
}
.tl-body {
  flex: 1;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-around;
  padding-left: 80px;
}
.tl-body::before {
  content: '';
  position: absolute;
  left: 36px; top: 20px; bottom: 20px;
  width: 4px;
  background: linear-gradient(to bottom, rgba(245, 158, 11, 0.8), rgba(245, 158, 11, 0.1));
  border-radius: 2px;
}
.tl-event {
  position: relative;
  display: flex;
  align-items: center;
  gap: 40px;
  padding: 12px 0;
}
.tl-event::before {
  content: '';
  position: absolute;
  left: -66px;
  width: 32px; height: 32px;
  border-radius: 50%;
  background: ${PALETTE.accent};
  border: 6px solid ${PALETTE.bg};
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.4);
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
}
.tl-event.current::before {
  background: ${PALETTE.green};
  box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.4), 0 0 20px rgba(16, 185, 129, 0.5);
}
.tl-date {
  width: 180px;
  font-size: 32px;
  font-weight: 800;
  color: ${PALETTE.accent};
  flex-shrink: 0;
  letter-spacing: 1px;
}
.tl-card {
  flex: 1;
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02));
  border: 1px solid rgba(255, 255, 255, 0.10);
  border-radius: 14px;
  padding: 18px 28px;
  display: flex; flex-direction: column; gap: 6px;
}
.tl-title {
  font-size: 34px;
  font-weight: 800;
  color: ${PALETTE.text};
  line-height: 1.25;
}
.tl-sub {
  font-size: 22px;
  font-weight: 500;
  color: ${PALETTE.muted};
  line-height: 1.3;
}
.sub-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 90px;
  background: rgba(0, 0, 0, 0.90);
  border-top: 3px solid rgba(245, 158, 11, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 20;
}
.sub-bar .sub-text {
  color: ${PALETTE.text};
  font-size: 36px;
  font-weight: 800;
  text-align: center;
  padding: 0 60px;
  max-height: 76px;
  overflow: hidden;
}
`;

  const eventsHtml = events.map((e, i) => {
    const isLast = i === events.length - 1;
    return `<div class="tl-event${isLast ? ' current' : ''}">
      <div class="tl-date">${esc(e.date)}</div>
      <div class="tl-card">
        <div class="tl-title">${esc(e.title)}</div>
        ${e.sub ? `<div class="tl-sub">${esc(e.sub)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const slideBody = `
<div class="panel-hero">
  <div class="bg-img"></div>
  <div class="overlay"></div>
  <div class="hero-title-box">
    <div class="hero-subject">${esc(heroSubject)}</div>
    <div class="hero-title">${heroTitle}</div>
  </div>
</div>
<div class="panel-timeline">
  <div class="tl-header">KEY MILESTONES</div>
  <div class="tl-body">${eventsHtml}</div>
</div>
${subText ? `<div class="sub-bar"><div class="sub-text">${esc(subText)}</div></div>` : ''}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildHistoryHTML };
