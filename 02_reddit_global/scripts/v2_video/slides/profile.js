// scripts/v2_video/slides/profile.js
// Profile スライド (旧 matchcard)：試合プレビュー（左=メイン画像+タイトル / 右=HOME/AWAYミニ+データ行4件）
// テンプレート元: /matchcard/index.html（= 型1）

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar, _t } = require('./_common');

function buildProfileHTML(mod) {
  // dataSlots 4件を data-row で使う
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 4);
  while (slots.length < 4) slots.push({ label: '', value: '' });

  const mainImg  = imgDataUri(mod.bgImage);
  // ロゴが取れていればそれ、無ければ既存 imgDataUri 経由のローカル画像
  const homeImg  = mod.homeLogo || imgDataUri(mod.homeImage);
  const awayImg  = mod.awayLogo || imgDataUri(mod.awayImage);
  const mainTitle = _t(mod.title) || 'MATCH PREVIEW';
  const subText   = mod.narration || '';
  const homeLabel = _t(mod.homeTeam) || 'HOME';
  const awayLabel = _t(mod.awayTeam) || 'AWAY';

  const extraStyles = `
.slide { display: flex; background: ${PALETTE.bg}; }
.panel-left {
  width: 42%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 60px;
  gap: 40px;
  position: relative;
}
.panel-right {
  width: 58%;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 60px 60px 60px 20px;
  gap: 30px;
  position: relative;
}
.main-title {
  height: 180px;
  font-size: 72px;
  font-weight: 900;
  border-left: 12px solid ${PALETTE.accent};
  padding-left: 40px;
  display: flex;
  align-items: center;
  background: linear-gradient(to right, rgba(245,158,11,0.15), transparent);
  color: ${PALETTE.text};
}
.main-img-frame {
  flex: 1;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 30px;
  overflow: hidden;
  background: rgba(0,0,0,0.3);
}
.main-img-frame .img-fill {
  width: 100%; height: 100%;
  ${mainImg ? `background-image: url('${mainImg}');` : ''}
  background-size: cover;
  background-position: center;
}
.mini-grid {
  height: 35%;
  display: flex;
  gap: 30px;
}
.mini-card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 15px;
}
.mini-label {
  height: 54px;
  background: rgba(255,255,255,0.05);
  border-radius: 12px;
  display: flex;
  justify-content: center; align-items: center;
  font-size: 24px;
  font-weight: 800;
  color: #6080b0;
  border: 1px solid rgba(255,255,255,0.05);
}
.mini-img-frame {
  flex: 1;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 20px;
  overflow: hidden;
  background: rgba(0,0,0,0.3);
}
.mini-img-frame .img-fill {
  width: 100%; height: 100%;
  background-size: cover;
  background-position: center;
}
.data-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 15px;
}
.data-row {
  flex: 1;
  display: flex;
  gap: 20px;
}
.row-label {
  width: 35%;
  background: rgba(0,0,0,0.4);
  border-left: 6px solid ${PALETTE.accent};
  border-radius: 10px;
  display: flex; align-items: center;
  padding-left: 28px;
  font-size: 28px;
  font-weight: 700;
  color: #6080b0;
  line-height: 1.15;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.row-value {
  flex: 1;
  background: linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  align-items: center;
  padding: 8px 24px 8px 35px;
  font-size: 46px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.05;
  overflow: hidden;
  word-break: break-word;
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

  // 値の長さに応じてフォント縮小（base 56px）
  function _valFont(text) {
    const len = String(text || '').length;
    if (len <= 6)  return 56;
    if (len <= 9)  return 46;
    if (len <= 13) return 36;
    if (len <= 18) return 28;
    return 24;
  }
  // ラベルは何の項目か即座にわかる大きさ（base 36px）
  function _labelFont(text) {
    const len = String(text || '').length;
    if (len <= 6)  return 36;
    if (len <= 10) return 30;
    if (len <= 14) return 26;
    if (len <= 18) return 22;
    return 20;
  }

  const dataRows = slots.map(s => {
    const lbl = s.label || '';
    const val = s.value || '-';
    return `<div class="data-row">
      <div class="row-label" style="font-size:${_labelFont(lbl)}px">${esc(lbl)}</div>
      <div class="row-value" style="font-size:${_valFont(val)}px">${esc(val)}</div>
    </div>`;
  }).join('');

  const slideBody = `
<div class="panel-left">
  <div class="main-title">${esc(mainTitle)}</div>
  <div class="main-img-frame"><div class="img-fill"></div></div>
</div>
<div class="panel-right">
  <div class="mini-grid">
    <div class="mini-card">
      <div class="mini-label">${esc(homeLabel)}</div>
      <div class="mini-img-frame"><div class="img-fill" ${homeImg ? `style="background-image:url('${homeImg}')"` : ''}></div></div>
    </div>
    <div class="mini-card">
      <div class="mini-label">${esc(awayLabel)}</div>
      <div class="mini-img-frame"><div class="img-fill" ${awayImg ? `style="background-image:url('${awayImg}')"` : ''}></div></div>
    </div>
  </div>
  <div class="data-list">${dataRows}</div>
</div>
${buildSubtitleBar(subText, { height: 90, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildProfileHTML };
