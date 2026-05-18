// scripts/v2_video/slides/profile.js
// Profile スライド：選手プロフィール
//   左カラム: [国旗][クラブロゴ] / タイトル(選手名) / メイン画像(選手写真)
//   右カラム: データ行（出場・ゴール等のスタッツ）

const { PALETTE, esc, escBr, hasNewline, imgDataUri, wrapHTML , buildSubtitleBar, subtitleArgFromMod, splitSubtitle, _t, imageAdjustCss, fitFont } = require('./_common');

function buildProfileHTML(mod) {
  // dataSlots 4〜7 件を data-row で使う
  //   panel-right 利用可能高 = 1080 - 60(top) - 130(bottom: subtitle bar 90 + 余白) = 890
  //   logo-row 120 + gap 30 を引いて data-list 残 ≈ 740px
  //   N に応じて 行高/フォント/line-clamp/padding を縮小して overflow 回避
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 7);
  while (slots.length < 4) slots.push({ label: '', value: '' });
  const N = slots.length;
  // 行間 gap (px)：少ない時は広く、多い時は詰める
  const dataGap     = N >= 7 ? 6  : N >= 6 ? 8  : N >= 5 ? 12 : 15;
  // ラベル基準フォント (px)
  const labelBase   = N >= 7 ? 22 : N >= 6 ? 26 : N >= 5 ? 32 : 38;
  // 値基準フォント (px) - 2026-05-18: 相棒指示で 48 に統一 (件数依存を廃止)
  const valueBase   = 48;
  // 行内 padding：上下 (高さ膨張を抑える)
  const rowPad      = N >= 7 ? 4  : N >= 6 ? 6  : 10;
  // line-clamp：N が多い時は 1 行に絞って overflow 回避
  const rowLineClamp = N >= 6 ? 1 : 2;

  const mainImg  = imgDataUri(mod.bgImage);
  const imgAdj   = imageAdjustCss(mod.imageAdjust);
  // 国旗（leftImage / countryImage / flagImage いずれか）+ クラブロゴ（rightImage / clubLogo / homeImage いずれか）
  //   各フィールドは "data:..." 直接 or プロジェクトルート相対パスのどちらでも受ける
  const _resolve = (v) => !v ? null : (typeof v === 'string' && v.startsWith('data:')) ? v : imgDataUri(v);
  const flagImg  = _resolve(mod.countryImage) || _resolve(mod.flagImage) || imgDataUri(mod.leftImage)  || imgDataUri(mod.homeImage);
  const clubImg  = _resolve(mod.clubLogo)     || _resolve(mod.homeLogo)  || imgDataUri(mod.rightImage) || imgDataUri(mod.awayImage);
  const mainTitleSrc = _t(mod.title) || 'PROFILE';
  // オーファン回避: 長文 title は splitSubtitle で 1〜2 行に整形
  const mainTitleLines = splitSubtitle(mainTitleSrc, 12).lines.filter(Boolean);
  const mainTitleHtml = mainTitleLines.map(l => esc(l)).join('<br>');
  const _longestMain = Math.max(...mainTitleLines.map(l => l.length), 1);
  let mainTitleFontPx = mainTitleLines.length === 1 && mainTitleSrc.length <= 8 ? 60
                      : mainTitleLines.length === 1                              ? 52
                      : _longestMain > 13                                         ? 44
                      : 48;
  // 安全クランプ: 約 820px の panel-left コンテナ内に収める
  const _profSafeFont = Math.floor((820 / _longestMain) * 0.95);
  if (mainTitleFontPx > _profSafeFont) mainTitleFontPx = Math.max(_profSafeFont, 28);
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
  /* padding-bottom 130: 字幕バー 90px + 余白 40px ぶん下げて data-list と重ねない */
  padding: 60px 60px 130px 20px;
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
  background-size: ${imgAdj.isDefault ? 'cover' : `${100 * imgAdj.zoom}%`};
  background-position: ${imgAdj.bgPosition};
  background-repeat: no-repeat;
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
  min-height: 0;            /* flex shrink を有効化（オーバーフロー防止） */
  display: flex;
  flex-direction: column;
  gap: ${dataGap}px;
  overflow: hidden;         /* 万一はみ出しても切る */
}
.data-row {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  gap: 20px;
}
.row-label {
  width: 35%;
  background: rgba(0,0,0,0.4);
  border-left: 6px solid ${PALETTE.accent};
  border-radius: 10px;
  align-items: center;
  padding: ${rowPad}px 0 ${rowPad}px 28px;
  font-size: ${labelBase}px;
  font-weight: 700;
  color: #ffffff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  line-height: 1.15;
  display: -webkit-box;
  -webkit-line-clamp: ${rowLineClamp};
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  min-height: 0;
}
.row-value {
  flex: 1;
  background: linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
  border: 1px solid rgba(255,215,0,0.25);
  border-radius: 14px;
  display: -webkit-box;
  -webkit-line-clamp: ${rowLineClamp};
  -webkit-box-orient: vertical;
  padding: ${rowPad}px 24px ${rowPad}px 35px;
  font-size: ${valueBase}px;
  font-weight: 900;
  color: #FFD700;  /* 黄金色 — データを目立たせる */
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.6), 0 0 18px rgba(255, 215, 0, 0.22);
  line-height: 1.05;
  overflow: hidden;
  word-break: break-word;
  min-height: 0;
  position: relative;
}
/* 値テキスト（.row-value 内のテキスト直下子）を最初は非表示にして、左カラム効果完了後（1.7s〜）に順次フェードイン
   N に応じて stagger delay を細かく刻む */
.row-value > .val-text {
  opacity: 0;
  transform: translateY(8px);
  animation: valueRise 0.55s ease-out forwards;
}
${slots.map((_, i) => `.data-row:nth-of-type(${i + 1}) .val-text { animation-delay: ${(1.7 + i * 0.18).toFixed(2)}s; }`).join('\n')}
@keyframes valueRise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
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

  // 2026-05-18: 横幅実測ベース (_common.fitFont) + 縮小率 70% 未満で 2 行折り返し
  //   panel-right 幅 (58%) - padding 80 - gap 20 → row 内訳
  //   row-label: 35% - padding/border ≈ 320px / row-value: 残 - padding 60 ≈ 590px
  //   data-row は flex: 1 1 0 で row 高さ均等 → 2 行になっても他カードに侵食しない
  const _panelInnerW = 1920 * 0.58 - 60 - 20; // 1033.6
  const _labelW      = _panelInnerW * 0.35;
  const _valueW      = _panelInnerW - _labelW - 20; // gap 20
  const _labelInnerW = _labelW - 28 - 14;
  const _valueInnerW = _valueW - 35 - 24 - 8;
  const _valFit   = (t) => fitFont(t, valueBase,     _valueInnerW, { maxLines: 2, minFontPx: 20 });
  const _labelFit = (t) => fitFont(t, labelBase + 8, _labelInnerW, { maxLines: 2, minFontPx: 18 });

  // 2026-05-18: 全 row でフォントサイズを統一（行ごとにサイズが違うと比較しにくい）
  //   slots 全体の中で最も縮小される (= 最長) value/label に合わせて単一サイズで描画
  const _longestLabel = slots.reduce((m, s) => (s.label || '').length > m.length ? (s.label || '') : m, '');
  const _longestVal   = slots.reduce((m, s) => (s.value || '-').length > m.length ? (s.value || '-') : m, '');
  const _unifLabel = _labelFit(_longestLabel);
  const _unifVal   = _valFit(_longestVal);
  const _unifClamp = Math.max(_unifLabel.lines, _unifVal.lines);

  const dataRows = slots.map(s => {
    const lbl = s.label || '';
    const val = s.value || '-';
    return `<div class="data-row">
      <div class="row-label" style="font-size:${_unifLabel.fontSize}px;-webkit-line-clamp:${_unifClamp}">${escBr(lbl)}</div>
      <div class="row-value" style="font-size:${_unifVal.fontSize}px;-webkit-line-clamp:${_unifClamp}"><span class="val-text">${escBr(val)}</span></div>
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
