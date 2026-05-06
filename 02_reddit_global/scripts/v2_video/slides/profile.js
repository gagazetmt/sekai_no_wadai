// scripts/v2_video/slides/profile.js
// Profile スライド：選手プロフィール
//   左カラム: [国旗][クラブロゴ] / タイトル(選手名) / メイン画像(選手写真)
//   右カラム: データ行（出場・ゴール等のスタッツ）

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar, subtitleArgFromMod, splitSubtitle, _t } = require('./_common');

function buildProfileHTML(mod) {
  // dataSlots 4件を data-row で使う
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 4);
  while (slots.length < 4) slots.push({ label: '', value: '' });

  const mainImg  = imgDataUri(mod.bgImage);
  // 国旗（leftImage / countryImage / flagImage いずれか）+ クラブロゴ（rightImage / clubLogo / homeImage いずれか）
  const flagImg  = mod.countryImage || mod.flagImage || imgDataUri(mod.leftImage)  || imgDataUri(mod.homeImage);
  const clubImg  = mod.clubLogo     || mod.homeLogo  || imgDataUri(mod.rightImage) || imgDataUri(mod.awayImage);
  const mainTitleSrc = _t(mod.title) || 'PROFILE';
  // オーファン回避: 長文 title は splitSubtitle で 1〜2 行に整形
  const mainTitleLines = splitSubtitle(mainTitleSrc, 12).lines.filter(Boolean);
  const mainTitleHtml = mainTitleLines.map(l => esc(l)).join('<br>');
  // 1行 8字以内なら大、12字以内なら中、それ以外は縮小
  const mainTitleFontPx = mainTitleLines.length === 1 && mainTitleSrc.length <= 8 ? 60
                        : mainTitleLines.length === 1                              ? 52
                        : mainTitleLines.some(l => l.length > 13)                  ? 44
                        : 48;
  const subText   = mod.narration || '';
  const subtitle  = mod.subtitle || '';

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
/* 🆕 左カラム上部: 国旗 + クラブロゴ */
.logo-row {
  display: flex;
  gap: 20px;
  height: 120px;
  flex-shrink: 0;
}
.logo-cell {
  flex: 1;
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.logo-cell .img-fill {
  width: 100%; height: 100%;
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
}
.logo-cell .logo-empty {
  font-size: 18px;
  color: rgba(255,255,255,0.3);
  font-weight: 700;
}
.flag-cell { background: rgba(96,128,180,0.1); }
.club-cell { background: rgba(252,211,77,0.1); }
.main-title {
  font-size: ${mainTitleFontPx}px;
  font-weight: 900;
  border-left: 12px solid ${PALETTE.accent};
  padding-left: 30px;
  padding-top: 20px;
  padding-bottom: 20px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  background: linear-gradient(to right, rgba(245,158,11,0.15), transparent);
  color: ${PALETTE.text};
  flex-shrink: 0;
}
.main-subtitle {
  font-size: 28px;
  font-weight: 600;
  color: rgba(255,255,255,0.7);
  margin-top: 8px;
}
/* main-title アニメーション（タイトル浮上） */
.main-title {
  opacity: 0;
  transform: translateY(40px);
  animation: titleRise 0.7s ease-out 0.8s forwards;
}
@keyframes titleRise {
  from { opacity: 0; transform: translateY(40px); }
  to   { opacity: 1; transform: translateY(0);    }
}
/* logo-row アニメーション（最初に降下） */
.logo-row {
  opacity: 0;
  transform: translateY(-30px);
  animation: logoDrop 0.6s ease-out 0.3s forwards;
}
@keyframes logoDrop {
  from { opacity: 0; transform: translateY(-30px); }
  to   { opacity: 1; transform: translateY(0);     }
}
.main-img-frame {
  flex: 1;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 30px;
  overflow: hidden;
  background: rgba(0,0,0,0.3);
  /* 透明から 1.5秒かけて実像に。以降そのまま残る */
  opacity: 0;
  animation: imgFadeIn 1.5s ease-in-out forwards;
}
@keyframes imgFadeIn { from { opacity: 0; } to { opacity: 1; } }
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
  font-size: 38px;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
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
  border: 1px solid rgba(255,215,0,0.25);
  border-radius: 14px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  align-items: center;
  padding: 8px 24px 8px 35px;
  font-size: 46px;
  font-weight: 900;
  color: #FFD700;  /* 黄金色 — データを目立たせる */
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.6), 0 0 18px rgba(255, 215, 0, 0.22);
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
    if (len <= 6)  return 49;
    if (len <= 10) return 41;
    if (len <= 14) return 35;
    if (len <= 18) return 30;
    return 27;
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
  <div class="main-title">
    ${mainTitleHtml}
    ${subtitle ? `<div class="main-subtitle">${esc(subtitle)}</div>` : ''}
  </div>
  <div class="main-img-frame">${mainImg ? `<div class="img-fill" style="background-image:url('${mainImg}')"></div>` : '<div class="img-fill"></div>'}</div>
</div>
<div class="panel-right">
  <div class="logo-row">
    <div class="logo-cell flag-cell"   title="${esc(mod.countryName || '国籍')}">
      ${flagImg ? `<div class="img-fill" style="background-image:url('${flagImg}')"></div>` : '<div class="logo-empty">国旗</div>'}
    </div>
    <div class="logo-cell club-cell"   title="${esc(mod.clubName || 'クラブ')}">
      ${clubImg ? `<div class="img-fill" style="background-image:url('${clubImg}')"></div>` : '<div class="logo-empty">クラブ</div>'}
    </div>
  </div>
  <div class="data-list">${dataRows}</div>
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 90, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildProfileHTML };
