// scripts/v2_video/slides/stats.js
// Stats / Profile スライド：型3 ベース（左=画像 / 右=データカード2x2 grid）
// テンプレート元: /型３/index.html

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar, _t, _player } = require('./_common');

// チーム or 選手 → 日本語/カタカナ
function _entityName(raw) {
  if (!raw) return '';
  const ja = _t(raw);
  if (ja !== raw) return ja;
  return _player(raw);
}

function buildStatsHTML(mod) {
  const bg     = imgDataUri(mod.bgImage);
  const slots  = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 6);
  while (slots.length < 4) slots.push({ label: '', value: '' });

  const title    = _t(mod.title) || _entityName(mod.siBinding) || 'STATS';
  const subTitle = _entityName(mod.siBinding) || (mod.type === 'profile' ? 'PROFILE' : 'STATISTICS');
  const narr     = mod.narration || '';

  // type バッジの色（profile=紫 / stats=緑）
  const badgeColor = mod.type === 'profile' ? '#8b5cf6' : '#10b981';

  const extraStyles = `
.slide { display: flex; background: ${PALETTE.bg}; }

/* 左：選手画像 40% */
.panel-img {
  width: 40%; height: 100%;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}
.panel-img .img-bg {
  position: absolute; inset: 0;
  ${bg ? `background-image: url('${bg}');` : `background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);`}
  background-size: cover;
  background-position: center top;
}
.panel-img .img-fade {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    transparent 0%,
    transparent 55%,
    rgba(6,14,28,0.70) 80%,
    rgba(6,14,28,1.00) 100%);
}
.panel-img .img-vfade {
  position: absolute; inset: 0;
  background: linear-gradient(to bottom,
    rgba(6,14,28,0.85) 0%,
    transparent 12%,
    transparent 75%,
    rgba(6,14,28,0.95) 100%);
}
/* 名前タグ */
.img-name {
  position: absolute;
  bottom: 130px;
  left: 0; right: 0;
  padding: 0 40px;
}
.img-name .player-name {
  font-size: 56px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.15;
  text-shadow: 0 2px 14px rgba(0,0,0,0.9);
}
.img-name .player-sub {
  font-size: 28px;
  font-weight: 700;
  color: ${PALETTE.accent};
  margin-top: 8px;
  letter-spacing: 4px;
  text-shadow: 0 1px 8px rgba(0,0,0,0.8);
}

/* 右：データカード grid 60% */
.panel-data {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 80px 64px 130px 40px;
  position: relative;
}
.type-badge {
  align-self: flex-start;
  padding: 6px 18px;
  background: ${badgeColor};
  color: #fff;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 3px;
  border-radius: 4px;
  margin-bottom: 24px;
}
.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: 1fr;
  gap: 18px;
  flex: 1;
}
.data-card {
  background: linear-gradient(135deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 16px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  position: relative;
  overflow: hidden;
}
.data-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 4px; height: 100%;
  background: ${PALETTE.accent};
  border-radius: 4px 0 0 4px;
}
.card-label {
  font-size: 22px;
  font-weight: 700;
  color: #6080b0;
  letter-spacing: 1px;
  text-transform: uppercase;
}
.card-value {
  font-size: 64px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1;
  letter-spacing: -1px;
}

/* 字幕 */
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
  font-size: 32px;
  font-weight: 700;
  text-align: center;
  padding: 0 60px;
  line-height: 1.3;
  max-height: 80px;
  overflow: hidden;
}
`;

  const cardsHtml = slots.slice(0, 6).map(s => {
    // merged を優先（"今季ゴール：24"）、無ければ label/value 個別
    if (s.merged && s.merged.includes('：')) {
      const [lbl, val] = s.merged.split('：');
      return `<div class="data-card">
        <div class="card-label">${esc(lbl || '')}</div>
        <div class="card-value">${esc(val || '-')}</div>
      </div>`;
    }
    return `<div class="data-card">
      <div class="card-label">${esc(s.label || '')}</div>
      <div class="card-value">${esc(s.value || '-')}</div>
    </div>`;
  }).join('');

  const slideBody = `
<div class="panel-img">
  <div class="img-bg"></div>
  <div class="img-fade"></div>
  <div class="img-vfade"></div>
  <div class="img-name">
    <div class="player-name">${esc(title)}</div>
    <div class="player-sub">${esc(subTitle)}</div>
  </div>
</div>
<div class="panel-data">
  <div class="type-badge">${esc((mod.type || '').toUpperCase())}</div>
  <div class="card-grid">${cardsHtml}</div>
</div>
${buildSubtitleBar(narr, { height: 90, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

// profile も同じテンプレ（用途違いだけ）
const buildProfileHTML = buildStatsHTML;

module.exports = { buildStatsHTML, buildProfileHTML };
