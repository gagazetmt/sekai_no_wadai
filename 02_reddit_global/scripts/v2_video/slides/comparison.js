// scripts/v2_video/slides/comparison.js
// Comparison スライド：型4 ベース（左右画像 + VS + 中央データ比較行）
// テンプレート元: /型４/index.html

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar, _t, _player } = require('./_common');

function buildComparisonHTML(mod) {
  const leftBg  = imgDataUri(mod.leftImage)  || imgDataUri(mod.bgImage);
  const rightBg = imgDataUri(mod.rightImage);
  // チーム or 選手の主役名。マップに有れば日本語、無ければ last word
  function _entityName(raw) {
    if (!raw) return '';
    const ja = _t(raw);
    if (ja !== raw) return ja;       // チーム/会場/大会のヒット
    return _player(raw);             // 選手名 or last word fallback
  }
  const leftName  = _entityName(mod.siBindingLeft)  || 'PLAYER A';
  const rightName = _entityName(mod.siBindingRight) || 'PLAYER B';
  const title     = _t(mod.title) || 'COMPARISON';
  const narr      = mod.narration || '';

  // dataSlots: [{label, leftValue, rightValue}, ...]
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 5);

  const extraStyles = `
.slide { display: flex; background: ${PALETTE.bg}; }

/* 上部バナー */
.top-banner {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 90px;
  background: rgba(0,0,0,0.82);
  border-bottom: 4px solid ${PALETTE.accent};
  display: flex; align-items: center; justify-content: center;
  z-index: 20;
}
.module-label {
  color: ${PALETTE.accent};
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 4px;
  text-transform: uppercase;
}

/* 字幕 */
.sub-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 110px;
  background: rgba(0,0,0,0.90);
  border-top: 3px solid rgba(245,158,11,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 20;
}
.sub-text {
  color: ${PALETTE.text};
  font-size: 38px;
  font-weight: 800;
  text-align: center;
  padding: 0 80px;
  line-height: 1.4;
  max-height: 100px;
  overflow: hidden;
}

/* 左右パネル */
.panel-left, .panel-right {
  width: 30%; height: 100%;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}
.panel-bg {
  position: absolute; inset: 0;
  background-size: cover;
  background-position: center top;
}
.panel-left .panel-bg {
  ${leftBg ? `background-image: url('${leftBg}');` : `background: linear-gradient(160deg, #1e3a8a 0%, ${PALETTE.bg} 100%);`}
}
.panel-right .panel-bg {
  ${rightBg ? `background-image: url('${rightBg}');` : `background: linear-gradient(160deg, #7f1d1d 0%, ${PALETTE.bg} 100%);`}
}
.panel-left .panel-fade {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    rgba(8,18,32,0.10) 0%,
    rgba(8,18,32,0.60) 70%,
    rgba(8,18,32,1.00) 100%);
}
.panel-right .panel-fade {
  position: absolute; inset: 0;
  background: linear-gradient(to left,
    rgba(8,18,32,0.10) 0%,
    rgba(8,18,32,0.60) 70%,
    rgba(8,18,32,1.00) 100%);
}
.panel-left .panel-top-fade,
.panel-right .panel-top-fade {
  position: absolute; inset: 0;
  background: linear-gradient(to bottom,
    rgba(8,18,32,0.80) 0%,
    transparent 12%,
    transparent 72%,
    rgba(8,18,32,0.90) 100%);
}

/* 名前タグ */
.name-tag {
  position: absolute;
  bottom: 145px;
  left: 0; right: 0;
  text-align: center;
  padding: 0 20px;
  z-index: 5;
}
.player-name {
  font-size: 38px;
  font-weight: 900;
  color: ${PALETTE.text};
  text-shadow: 0 2px 12px rgba(0,0,0,0.9);
  line-height: 1.2;
}
.team-tag {
  font-size: 22px;
  font-weight: 700;
  color: ${PALETTE.accent};
  margin-top: 6px;
  text-shadow: 0 1px 6px rgba(0,0,0,0.8);
}

/* 中央：データ比較 */
.panel-center {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 110px 0 130px;
  position: relative;
  z-index: 10;
}
.vs-badge {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 88px; height: 88px;
  background: ${PALETTE.accent};
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px;
  font-weight: 900;
  color: #000;
  z-index: 30;
  box-shadow: 0 0 0 6px rgba(245,158,11,0.25), 0 0 0 12px rgba(245,158,11,0.10);
}
.data-rows {
  display: flex;
  flex-direction: column;
  width: 100%;
  gap: 0;
}
.data-row {
  display: flex;
  align-items: center;
  height: 90px;
  width: 100%;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  position: relative;
}
.data-row:last-child { border-bottom: none; }

.val {
  width: 35%;
  font-size: 56px;
  font-weight: 900;
  line-height: 1.05;
  /* 長文は2行まで折り返し可能 + はみ出しは省略 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  hyphens: auto;
}
.val-left {
  text-align: right;
  padding-right: 40px;
  color: #93c5fd;
}
.val-right {
  text-align: left;
  padding-left: 40px;
  color: #fca5a5;
}
/* 数値比較で勝ってる方を白くハイライト（色だけ。フォントサイズは長さで動的調整） */
.val.win  { color: ${PALETTE.text}; }
.val.lose { opacity: 0.55; }

.label-col {
  width: 30%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 8px;
}
.label-text {
  color: #94a3b8;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 1.5px;
  text-align: center;
  line-height: 1.15;
  /* 長文は2行まで */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
`;

  // 数値比較で大きい方をハイライト
  function compareSides(s) {
    const lv = parseFloat(String(s.leftValue || '').replace(/[^\d.\-]/g, ''));
    const rv = parseFloat(String(s.rightValue || '').replace(/[^\d.\-]/g, ''));
    if (isNaN(lv) || isNaN(rv) || lv === rv) return ['', ''];
    if (lv > rv) return [' win', ' lose'];
    return [' lose', ' win'];
  }

  // 値の文字数 → フォントサイズ（base 56px、win=+8 / lose=-8 を内包）
  function _valFont(text, mod) {
    const base  = mod === 'win' ? 64 : (mod === 'lose' ? 48 : 56);
    const len   = String(text || '').length;
    if (len <= 5)  return base;
    if (len <= 7)  return Math.round(base * 0.82);
    if (len <= 10) return Math.round(base * 0.66);
    if (len <= 14) return Math.round(base * 0.52);
    if (len <= 20) return Math.round(base * 0.42);
    return Math.round(base * 0.34);  // 21文字超
  }
  // ラベル文字数 → フォントサイズ（base 30px）
  // 真ん中の項目名が見えないと比較スライドが「何の比較なのか」分からなくなるので大きめに
  function _labelFont(text) {
    const len = String(text || '').length;
    if (len <= 6)  return 30;
    if (len <= 10) return 26;
    if (len <= 14) return 22;
    if (len <= 18) return 19;
    return 17;
  }

  const rowsHtml = slots.length
    ? slots.map(s => {
        const [lc, rc] = compareSides(s);
        const lv = String(s.leftValue  || '-');
        const rv = String(s.rightValue || '-');
        const lb = String(s.label      || '');
        const lMod = (lc || '').trim();
        const rMod = (rc || '').trim();
        const lFs = _valFont(lv, lMod) + 'px';
        const rFs = _valFont(rv, rMod) + 'px';
        const lbFs = _labelFont(lb) + 'px';
        return `<div class="data-row">
          <div class="val val-left${lc}" style="font-size:${lFs}">${esc(lv)}</div>
          <div class="label-col"><div class="label-text" style="font-size:${lbFs}">${esc(lb)}</div></div>
          <div class="val val-right${rc}" style="font-size:${rFs}">${esc(rv)}</div>
        </div>`;
      }).join('')
    : '<div style="text-align:center;color:#5a6a8a;font-size:24px">対比データなし</div>';

  const slideBody = `
<div class="top-banner"><div class="module-label">${esc(title)}</div></div>

<div class="panel-left">
  <div class="panel-bg"></div>
  <div class="panel-fade"></div>
  <div class="panel-top-fade"></div>
  <div class="name-tag">
    <div class="player-name">${esc(leftName)}</div>
    <div class="team-tag">LEFT</div>
  </div>
</div>

<div class="panel-center">
  <div class="data-rows">${rowsHtml}</div>
</div>

<div class="vs-badge">VS</div>

<div class="panel-right">
  <div class="panel-bg"></div>
  <div class="panel-fade"></div>
  <div class="panel-top-fade"></div>
  <div class="name-tag">
    <div class="player-name">${esc(rightName)}</div>
    <div class="team-tag">RIGHT</div>
  </div>
</div>

${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildComparisonHTML };
