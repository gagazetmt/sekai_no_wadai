// scripts/v2_video/slides/comparison.js
// Comparison スライド：型4 ベース（左右画像 + VS + 中央データ比較行）
// テンプレート元: /型４/index.html
//
//  演出:
//   - 画像: 左右で時差 fade in（左 0.4s → 右 0.5s）
//   - 名前タグ: 縦ゴーストトレイル（下から浮上 + 本体 fade in）
//   - 上部バナー: 上から滑り込み
//   - VS バッジ: 下方配置（テキスト被り解消）+ pulse animation
//   - データ行: 該当 chunk 再生中だけ active（金枠 + scale + glow）

const {
  PALETTE, esc, escBr, hasNewline, imgDataUri, wrapHTML,
  buildSubtitleBar, subtitleArgFromMod,
  _t, _player, LEAD_PAD_SEC, TAIL_PAD_SEC,
  imageAdjustCss, fitFont,
} = require('./_common');

// label を chunk text と部分一致で対応付け（active 強調用）
function _matchLabelToChunk(label, chunks) {
  const t = String(label || '').trim();
  if (!t || !chunks.length) return -1;
  for (let i = 0; i < chunks.length; i++) {
    if (String(chunks[i].text || '').includes(t)) return i;
  }
  const tokens = t.replace(/[の・はがをにでとや、。「」（）\s〜ー]/g, ' ')
    .split(/\s+/).filter(s => s.length >= 2);
  if (!tokens.length) return -1;
  let best = -1, bestScore = 0;
  chunks.forEach((c, i) => {
    const text = String(c.text || '');
    const score = tokens.reduce((s, tk) => s + (text.includes(tk) ? tk.length : 0), 0);
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore > 0 ? best : -1;
}

function buildComparisonHTML(mod) {
  const leftBg  = imgDataUri(mod.leftImage)  || imgDataUri(mod.bgImage);
  const rightBg = imgDataUri(mod.rightImage);
  // 左右別個 zoom/offset。imageAdjustLeft/Right が無ければ既存 imageAdjust にフォールバック
  const imgAdjLeft  = imageAdjustCss(mod.imageAdjustLeft  || mod.imageAdjust);
  const imgAdjRight = imageAdjustCss(mod.imageAdjustRight || mod.imageAdjust);
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

  // dataSlots: [{label, leftValue, rightValue}, ...]
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 7);

  // ── 音声 chunk 解析（行 active 制御用） ─────────────────
  //   先頭 LEAD_PAD_SEC を chunkStarts に加算、totalSec も LEAD+TAIL 含む全体時間に揃える
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audio.length ? (audioSec + LEAD_PAD_SEC + TAIL_PAD_SEC) : 8;
  const chunkStarts = audio.map((_, i) =>
    LEAD_PAD_SEC + audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));
  const slotChunkIdx = slots.map(s => audio.length ? _matchLabelToChunk(s.label, audio) : -1);

  // 行 active 用 keyframes 生成
  const rowActiveStyles = slots.map((_, i) => {
    const cIdx = slotChunkIdx[i];
    if (cIdx < 0 || !audio.length) return '';
    const start = chunkStarts[cIdx];
    const dur   = audio[cIdx].durationSec || 1;
    const end   = start + dur;
    const fadeIn = 0.25, fadeOut = 0.30;
    const p = (sec) => Math.max(0, Math.min(100, sec / totalSec * 100));
    const preStartPct = p(start - fadeIn);
    const startPct    = p(start);
    const endPct      = p(end);
    const postEndPct  = p(end + fadeOut);
    return `
@keyframes rowActive_${i} {
  0%, ${preStartPct.toFixed(2)}%      { background-color: transparent; transform: scale(1); box-shadow: none; }
  ${startPct.toFixed(2)}%, ${endPct.toFixed(2)}%  { background-color: rgba(252,211,77,0.06); transform: scale(1.02); box-shadow: 0 0 0 1px rgba(252,211,77,0.40), inset 0 0 30px rgba(252,211,77,0.18); }
  ${postEndPct.toFixed(2)}%, 100%     { background-color: transparent; transform: scale(1); box-shadow: none; }
}
.data-row.active-${i} { animation: rowActive_${i} ${totalSec.toFixed(2)}s linear forwards; }`;
  }).join('\n');

  const extraStyles = `
.slide { display: flex; background: ${PALETTE.bg}; }

/* 上部バナー：上から下に滑り込み */
.top-banner {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 90px;
  background: rgba(0,0,0,0.82);
  border-bottom: 4px solid ${PALETTE.accent};
  display: flex; align-items: center; justify-content: center;
  z-index: 20;
  animation: bannerDown 0.4s ease-out backwards;
}
@keyframes bannerDown {
  from { transform: translateY(-100%); }
  to   { transform: translateY(0); }
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
  opacity: 0;
}
@keyframes imgFadeIn { from { opacity: 0; } to { opacity: 1; } }
.panel-left .panel-bg {
  ${leftBg ? `background-image: url('${leftBg}');` : `background: linear-gradient(160deg, #1e3a8a 0%, ${PALETTE.bg} 100%);`}
  background-size: ${imgAdjLeft.isDefault ? 'cover' : `${100 * imgAdjLeft.zoom}%`};
  background-position: ${imgAdjLeft.isDefault ? 'center top' : imgAdjLeft.bgPosition};
  animation: imgFadeIn 0.4s ease-out 0.1s forwards;
}
.panel-right .panel-bg {
  ${rightBg ? `background-image: url('${rightBg}');` : `background: linear-gradient(160deg, #7f1d1d 0%, ${PALETTE.bg} 100%);`}
  background-size: ${imgAdjRight.isDefault ? 'cover' : `${100 * imgAdjRight.zoom}%`};
  background-position: ${imgAdjRight.isDefault ? 'center top' : imgAdjRight.bgPosition};
  animation: imgFadeIn 0.5s ease-out 0.2s forwards;
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

/* 名前タグ：本体 + 縦ゴーストトレイル（下から浮上） */
.name-tag {
  position: absolute;
  bottom: 145px;
  left: 0; right: 0;
  padding: 0 20px;
  z-index: 5;
}
.name-real, .name-trail {
  text-align: center;
  position: relative;
}
.name-trail {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  opacity: 0;
  animation: nameTrail 0.55s ease-out 0.5s backwards;
}
.name-real {
  opacity: 0;
  animation: nameAppear 0.55s ease-out 0.6s forwards;
  z-index: 1;
}
@keyframes nameTrail {
  from { transform: translateY(60px); opacity: 1; }
  to   { transform: translateY(0);    opacity: 0; }
}
@keyframes nameAppear {
  from { opacity: 0; }
  to   { opacity: 1; }
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
/* VS バッジ：データ行とテキストの被り解消で下方配置（字幕バー直上）+ pulse */
.vs-badge {
  position: absolute;
  bottom: 130px;
  left: 50%;
  transform: translateX(-50%) scale(1);
  width: 88px; height: 88px;
  background: ${PALETTE.accent};
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px;
  font-weight: 900;
  color: #000;
  z-index: 30;
  box-shadow: 0 0 0 6px rgba(245,158,11,0.25), 0 0 0 12px rgba(245,158,11,0.10);
  animation: vsAppear 0.5s ease-out 0.7s backwards, vsPulse 2.5s ease-in-out 1.4s infinite;
}
@keyframes vsAppear {
  from { transform: translateX(-50%) scale(0.6); opacity: 0; }
  to   { transform: translateX(-50%) scale(1);   opacity: 1; }
}
@keyframes vsPulse {
  0%, 100% { transform: translateX(-50%) scale(1);    box-shadow: 0 0 0 6px rgba(245,158,11,0.25), 0 0 0 12px rgba(245,158,11,0.10); }
  50%      { transform: translateX(-50%) scale(1.06); box-shadow: 0 0 0 9px rgba(245,158,11,0.40), 0 0 0 18px rgba(245,158,11,0.18); }
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
  border-radius: 8px;
  transform-origin: center;
  transition: none; /* keyframes が制御 */
}
.data-row:last-child { border-bottom: none; }

.val {
  width: 35%;
  font-size: 50px;
  font-weight: 900;
  line-height: 1.05;
  /* データ値は白+グロー演出で目立たせる */
  color: #ffffff;
  text-shadow:
    0 0 12px rgba(255, 255, 255, 0.55),
    0 0 28px rgba(252, 211, 77, 0.45),
    0 4px 14px rgba(0, 0, 0, 0.85);
  overflow: hidden;
  hyphens: auto;
}
/* 2026-05-16 相棒指示: 1行に縮小して収める / 70%以下なら2行折り返し */
.val-1line {
  white-space: nowrap;
  text-overflow: ellipsis;
}
.val-2line {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
.val-left {
  text-align: right;
  padding-right: 40px;
}
.val-right {
  text-align: left;
  padding-left: 40px;
}
/* 数値比較で勝ってる方は更に金色グロー強化、負けは少し控えめ */
.val.win {
  color: #fff;
  text-shadow:
    0 0 16px rgba(255, 255, 255, 0.75),
    0 0 36px rgba(252, 211, 77, 0.85),
    0 4px 14px rgba(0, 0, 0, 0.9);
}
.val.lose { opacity: 0.55; }

.label-col {
  width: 30%;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 8px;
}
.label-text {
  /* +30% (22→29) / 金色 / 浮かび上がり (embossed) 効果 */
  color: ${PALETTE.accent};
  font-size: 29px;
  font-weight: 900;
  letter-spacing: 1.5px;
  text-align: center;
  line-height: 1.15;
  /* 上に細いハイライト + 下に影 + 金色グロー で「彫り込まれた」立体感 */
  text-shadow:
    0 -1px 0 rgba(255, 255, 255, 0.22),
    0  1px 0 rgba(0, 0, 0, 0.85),
    0  2px 0 rgba(0, 0, 0, 0.7),
    0  3px 8px rgba(0, 0, 0, 0.7),
    0  0   16px rgba(245, 158, 11, 0.55);
  /* 長文は2行まで */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* 行 active 用 keyframes（chunk マッチした row だけ生成） */
${rowActiveStyles}
`;

  // 数値比較で大きい方をハイライト
  function compareSides(s) {
    const lv = parseFloat(String(s.leftValue || '').replace(/[^\d.\-]/g, ''));
    const rv = parseFloat(String(s.rightValue || '').replace(/[^\d.\-]/g, ''));
    if (isNaN(lv) || isNaN(rv) || lv === rv) return ['', ''];
    if (lv > rv) return [' win', ' lose'];
    return [' lose', ' win'];
  }

  // 値の文字数 → { fontSize, oneLine } (2026-05-17 相棒指示で再改修)
  //   - 1行に収まるなら base サイズで 1 行表示
  //   - 収まらないなら font を縮小して 1 行に収める
  //   - 縮小率が 70% を下回る場合のみ 2 行折り返し許可（70% で固定）
  //   - val width: 35% × 1920 = 672px、 左右余白 40px → 632px 利用可
  //   - 2026-05-17: 「テキスト大きすぎてはみ出す」 (相棒) ため:
  //       (1) base を win/lose 関係なく 50px に統一 (旧: win 64 / lose 48 / neutral 56)
  //           勝ち方を「光らせる」効果は text-shadow で残す、 フォント拡大は廃止
  //       (2) charRatio を 0.55 → 0.62 / 0.50 → 0.56 に厳しく (実測ベース)
  //       (3) availW を 632 → 600 に詰めて padding 余裕確保
  function _valFontWithMode(text, mod) {
    const base = 50;  // win/lose 共通の base サイズ
    const t    = String(text || '');
    const len  = t.length;
    const hasJp = /[ぁ-んァ-ヶ一-龯]/.test(t);
    const charRatio = hasJp ? 0.62 : 0.56;
    const availW = 600;
    const fitsAtBase = len * base * charRatio <= availW;
    if (fitsAtBase) return { fontSize: base, oneLine: true };
    const scale = availW / (len * base * charRatio);
    // 2026-05-17: 縮小許可を 70% → 60% に拡大（相棒指示）
    //   60-70% でも 1 行で粘る、 60% 未満で 2 行折り返し
    if (scale >= 0.6) {
      return { fontSize: Math.max(18, Math.round(base * scale)), oneLine: true };
    }
    return { fontSize: Math.max(18, Math.round(base * 0.6)), oneLine: false };
  }
  // 後方互換 (使ってる箇所が他にあれば fontSize だけ返す)
  function _valFont(text, mod) { return _valFontWithMode(text, mod).fontSize; }
  // 2026-05-18: 横幅実測ベース (_common.fitFont) + 縮小率 70% 未満で 2 行折り返し
  //   中央の label column 幅は約 280px (VS バッジ含むエリア)
  const _labelFit = (text) => fitFont(text, 30, 280, { maxLines: 2, minFontPx: 17 });

  const rowsHtml = slots.length
    ? slots.map((s, i) => {
        const [lc, rc] = compareSides(s);
        const lv = String(s.leftValue  || '-');
        const rv = String(s.rightValue || '-');
        const lb = String(s.label      || '');
        const lMod = (lc || '').trim();
        const rMod = (rc || '').trim();
        const { fontSize: lFsNum, oneLine: lOne } = _valFontWithMode(lv, lMod);
        const { fontSize: rFsNum, oneLine: rOne } = _valFontWithMode(rv, rMod);
        const lFs = lFsNum + 'px';
        const rFs = rFsNum + 'px';
        const lWrap = lOne ? ' val-1line' : ' val-2line';
        const rWrap = rOne ? ' val-1line' : ' val-2line';
        const lbFit = _labelFit(lb);
        const lbFs = lbFit.fontSize + 'px';
        const lbClamp = lbFit.lines;
        const activeClass = (slotChunkIdx[i] >= 0 && audio.length) ? ` active-${i}` : '';
        return `<div class="data-row${activeClass}">
          <div class="val val-left${lc}${lWrap}" style="font-size:${lFs}">${esc(lv)}</div>
          <div class="label-col"><div class="label-text" style="font-size:${lbFs};-webkit-line-clamp:${lbClamp}">${escBr(lb)}</div></div>
          <div class="val val-right${rc}${rWrap}" style="font-size:${rFs}">${esc(rv)}</div>
        </div>`;
      }).join('')
    : '<div style="text-align:center;color:#5a6a8a;font-size:24px">対比データなし</div>';

  // 名前タグ HTML（実体 + ゴーストトレイル）
  const _nameTagHtml = (name, side) => `<div class="name-tag">
    <div class="name-trail">
      <div class="player-name">${esc(name)}</div>
      <div class="team-tag">${side}</div>
    </div>
    <div class="name-real">
      <div class="player-name">${esc(name)}</div>
      <div class="team-tag">${side}</div>
    </div>
  </div>`;

  const slideBody = `
<div class="top-banner"><div class="module-label">${esc(title)}</div></div>

<div class="panel-left">
  <div class="panel-bg"></div>
  <div class="panel-fade"></div>
  <div class="panel-top-fade"></div>
  ${_nameTagHtml(leftName, 'LEFT')}
</div>

<div class="panel-center">
  <div class="data-rows">${rowsHtml}</div>
</div>

<div class="vs-badge">VS</div>

<div class="panel-right">
  <div class="panel-bg"></div>
  <div class="panel-fade"></div>
  <div class="panel-top-fade"></div>
  ${_nameTagHtml(rightName, 'RIGHT')}
</div>

${buildSubtitleBar(subtitleArgFromMod(mod), { height: 110, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildComparisonHTML };
