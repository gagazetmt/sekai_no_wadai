// scripts/v2_video/slides/stats.js
// Stats / Profile スライド：型3 ベース（左=画像 / 右=データカード grid）
//   stats   : 6〜8 件、3〜4 列 grid
//   profile : 4 件、2x2 grid
//
//  演出:
//   - 画像: fade in（0.5s）
//   - 名前ボックス: 下から浮上ゴーストトレイル + 本体 fade in（insight の縦版）
//   - データカード: 該当 chunk が再生中だけ active（金枠 + scale 1.04 + グロー）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, splitSubtitle, _t, _player, LEAD_PAD_SEC, TAIL_PAD_SEC } = require('./_common');

// チーム or 選手 → 日本語/カタカナ
function _entityName(raw) {
  if (!raw) return '';
  const ja = _t(raw);
  if (ja !== raw) return ja;
  return _player(raw);
}

// 件数別 grid layout（横2 列を基本に、縦の行数で件数をさばく）
//   profile: 4件 → 2x2（コンパクトで impact 大きい）
//   stats:   6件 → 2x3（基本形）/ 7-8件 → 2x4
function _gridLayout(count) {
  // maxLabelFont は元値の +35% (白色化と合わせて見出しを目立たせる)
  if (count <= 2) return { cols: count, gap: 18, maxValFont: 88, maxLabelFont: 49, padTop: 80, padBottom: 130 };
  if (count <= 4) return { cols: 2, gap: 18, maxValFont: 80, maxLabelFont: 46, padTop: 80, padBottom: 130 }; // profile 2x2
  if (count <= 6) return { cols: 2, gap: 16, maxValFont: 76, maxLabelFont: 43, padTop: 70, padBottom: 120 }; // stats 2x3 ← 基本形
  return            { cols: 2, gap: 14, maxValFont: 60, maxLabelFont: 35, padTop: 60, padBottom: 116 };       // stats 2x4 (7-8件)
}

// 金粒パーティクル（左カラム背景の動き出し用・toc から流用、件数 8）
function _buildDust() {
  const dusts = [];
  for (let i = 0; i < 8; i++) {
    const left    = Math.random() * 100;
    const dur     = 7 + Math.random() * 9;     // 7〜16秒
    const delay   = -Math.random() * dur;       // 開始位相をランダム化
    const size    = 3 + Math.random() * 4;      // 3〜7px
    const opacity = 0.4 + Math.random() * 0.4;
    dusts.push(`<div class="dust" style="left:${left.toFixed(1)}%;width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;animation-duration:${dur.toFixed(1)}s;animation-delay:${delay.toFixed(2)}s;opacity:${opacity.toFixed(2)};"></div>`);
  }
  return dusts.join('');
}

// label を chunk text と部分一致で対応付け（active 強調用）
function _matchLabelToChunk(label, chunks) {
  const t = String(label || '').trim();
  if (!t || !chunks.length) return -1;
  // 完全一致を優先
  for (let i = 0; i < chunks.length; i++) {
    if (String(chunks[i].text || '').includes(t)) return i;
  }
  // tokens 部分マッチ
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

function buildStatsHTML(mod) {
  const bg = imgDataUri(mod.bgImage);

  // dataSlots: stats / profile ともに 6-8 件を想定（基本 2x3 grid）
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 8);
  const minCount = (mod.type === 'stats' || mod.type === 'profile') ? 6 : 4;
  while (slots.length < minCount) slots.push({ label: '', value: '' });
  const layout = _gridLayout(slots.length);

  const title    = _t(mod.title) || _entityName(mod.siBinding) || 'STATS';
  // オーファン回避: 長文 title を 1〜2 行に整形
  const _titleLines = splitSubtitle(title, 13).lines.filter(Boolean);
  const titleHtml = _titleLines.map(l => esc(l)).join('<br>');
  const titleFontPx = _titleLines.length === 1 && title.length <= 9 ? 56
                    : _titleLines.length === 1                       ? 48
                    : _titleLines.some(l => l.length > 14)            ? 40
                    : 44;
  const subTitle = _entityName(mod.siBinding) || (mod.type === 'profile' ? 'PROFILE' : 'STATISTICS');

  // type バッジの色（profile=紫 / stats=緑）
  const badgeColor = mod.type === 'profile' ? '#8b5cf6' : '#10b981';

  // ── 音声 chunk 解析（カード active 制御用）─────────────
  //   chunkStarts は先頭 LEAD_PAD_SEC（音声前無音）を加算。
  //   totalSec も LEAD + TAIL を含めた全体時間に揃える（音声と動画の同期用）。
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audio.length ? (audioSec + LEAD_PAD_SEC + TAIL_PAD_SEC) : 8;
  const chunkStarts = audio.map((_, i) =>
    LEAD_PAD_SEC + audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));

  // 各 slot に chunk index を割当（ラベルが含まれる chunk）
  const slotChunkIdx = slots.map(s => {
    const lbl = (s.merged && s.merged.includes('：')) ? s.merged.split('：')[0] : s.label;
    return audio.length ? _matchLabelToChunk(lbl, audio) : -1;
  });

  // カード active 用 keyframes 生成（カード本体 + 値グロー脈動 + 波形アイコン opacity）
  //   chunk 範囲: 0.25s 前から fade in、終了 0.3s 後に fade out
  //   - cardActive: 枠+scale+box-shadow (既存)
  //   - valuePulse: active 期間中に値の text-shadow が 3回脈動（呼吸感）
  //   - iconShow:   active 期間だけ波形アイコン opacity 1
  const cardActiveStyles = slots.map((_, i) => {
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
    // 値脈動の山3つ（active 期間内を 1/4, 2/4, 3/4 で振動）
    const span = endPct - startPct;
    const m1 = startPct + span * 0.25;
    const m2 = startPct + span * 0.50;
    const m3 = startPct + span * 0.75;
    return `
@keyframes cardActive_${i} {
  0%, ${preStartPct.toFixed(2)}%      { transform: scale(1);    border-color: rgba(255,255,255,0.10); box-shadow: 0 0 0 0 rgba(252,211,77,0); }
  ${startPct.toFixed(2)}%, ${endPct.toFixed(2)}%  { transform: scale(1.04); border-color: rgba(252,211,77,0.85); box-shadow: 0 0 0 3px rgba(252,211,77,0.30), 0 0 36px rgba(252,211,77,0.55); }
  ${postEndPct.toFixed(2)}%, 100%     { transform: scale(1);    border-color: rgba(255,255,255,0.10); box-shadow: 0 0 0 0 rgba(252,211,77,0); }
}
.data-card.active-${i} { animation: cardActive_${i} ${totalSec.toFixed(2)}s linear forwards; }
@keyframes valuePulse_${i} {
  0%, ${preStartPct.toFixed(2)}%      { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 18px rgba(255,215,0,0.25); }
  ${startPct.toFixed(2)}%             { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 24px rgba(255,215,0,0.55); }
  ${m1.toFixed(2)}%                   { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 42px rgba(255,215,0,0.95); }
  ${m2.toFixed(2)}%                   { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 24px rgba(255,215,0,0.55); }
  ${m3.toFixed(2)}%                   { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 42px rgba(255,215,0,0.95); }
  ${endPct.toFixed(2)}%               { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 24px rgba(255,215,0,0.55); }
  ${postEndPct.toFixed(2)}%, 100%     { text-shadow: 0 2px 6px rgba(0,0,0,0.6), 0 0 18px rgba(255,215,0,0.25); }
}
.data-card.active-${i} .card-value { animation: valuePulse_${i} ${totalSec.toFixed(2)}s linear forwards; }
@keyframes iconShow_${i} {
  0%, ${preStartPct.toFixed(2)}%       { opacity: 0; }
  ${startPct.toFixed(2)}%, ${endPct.toFixed(2)}%  { opacity: 1; }
  ${postEndPct.toFixed(2)}%, 100%      { opacity: 0; }
}
.data-card.active-${i} .sound-wave { animation: iconShow_${i} ${totalSec.toFixed(2)}s linear forwards; }`;
  }).join('\n');

  const extraStyles = `
.slide { display: flex; background: ${PALETTE.bg}; }

/* ── 左：人物・チーム画像 40% ── */
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
  /* 透明から 1.5秒かけて実像に → そのままゆっくり Ken Burns ズーム（写真が「生きてる」感） */
  opacity: 0;
  transform: scale(1);
  animation: imgFadeIn 1.5s ease-in-out forwards, kenBurns 18s ease-out forwards;
}
@keyframes imgFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes kenBurns  { from { transform: scale(1); } to { transform: scale(1.06); } }

/* 金粒パーティクル（左カラム背景でじんわり漂う・toc と統一感） */
.dust-layer {
  position: absolute; inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 2;
}
.dust {
  position: absolute;
  bottom: -10px;
  background: radial-gradient(circle, rgba(245,158,11,0.85) 0%, rgba(245,158,11,0.4) 40%, transparent 70%);
  border-radius: 50%;
  animation-name: dustFloat;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
  filter: blur(0.5px);
}
@keyframes dustFloat {
  0%   { transform: translateY(0) translateX(0); opacity: 0; }
  10%  { opacity: 0.6; }
  50%  { transform: translateY(-50vh) translateX(15px); opacity: 0.75; }
  90%  { opacity: 0.55; }
  100% { transform: translateY(-110vh) translateX(-12px); opacity: 0; }
}
.panel-img .img-fade {
  position: absolute; inset: 0;
  background: linear-gradient(to right,
    transparent 0%,
    transparent 55%,
    rgba(6,14,28,0.70) 80%,
    rgba(6,14,28,1.00) 100%);
  opacity: 0;
  animation: imgFadeIn 1.5s ease-in-out forwards;
}
.panel-img .img-vfade {
  position: absolute; inset: 0;
  background: linear-gradient(to bottom,
    rgba(6,14,28,0.85) 0%,
    transparent 12%,
    transparent 75%,
    rgba(6,14,28,0.95) 100%);
  opacity: 0;
  animation: imgFadeIn 1.5s ease-in-out forwards;
}

/* 名前タグ：画像が実像化したあと、下から浮上 + フェードイン（dust の前面に） */
.img-name-row {
  position: absolute;
  bottom: 130px;
  left: 0; right: 0;
  padding: 0 40px;
  z-index: 5;
}
.img-name-real {
  position: relative;
  opacity: 0;
  transform: translateY(60px);
  animation: nameRise 0.85s ease-out 1.5s forwards;
  z-index: 1;
}
@keyframes nameRise {
  from { opacity: 0; transform: translateY(60px); }
  to   { opacity: 1; transform: translateY(0);    }
}
.player-name {
  font-size: ${titleFontPx}px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.15;
  text-shadow: 0 2px 14px rgba(0,0,0,0.9);
}
.player-sub {
  font-size: 28px;
  font-weight: 700;
  color: ${PALETTE.accent};
  margin-top: 8px;
  letter-spacing: 4px;
  text-shadow: 0 1px 8px rgba(0,0,0,0.8);
}

/* ── 右：データカード grid 60% ── */
.panel-data {
  flex: 1;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: ${layout.padTop}px 64px ${layout.padBottom}px 40px;
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
  grid-template-columns: repeat(${layout.cols}, 1fr);
  grid-auto-rows: 1fr;
  gap: ${layout.gap}px;
  flex: 1;
}
.data-card {
  background: linear-gradient(135deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018));
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 16px;
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  position: relative;
  overflow: hidden;
  transform-origin: center;
}
.data-card::before {
  content: '';
  position: absolute;
  top: 0; left: 0;
  width: 4px; height: 100%;
  background: ${PALETTE.accent};
  border-radius: 4px 0 0 4px;
}
/* 波形アイコン（active カードの右上に出る・読み上げ中サイン） */
.sound-wave {
  position: absolute;
  top: 10px; right: 12px;
  display: flex; gap: 3px;
  align-items: flex-end;
  height: 20px;
  opacity: 0;
  z-index: 5;
}
.sound-wave span {
  display: block;
  width: 3px;
  background: ${PALETTE.accent};
  border-radius: 2px;
  transform-origin: bottom;
  box-shadow: 0 0 8px rgba(245,158,11,0.7);
}
.sound-wave span:nth-child(1) { height: 60%;  animation: barWave 0.55s ease-in-out 0.00s infinite alternate; }
.sound-wave span:nth-child(2) { height: 100%; animation: barWave 0.55s ease-in-out 0.18s infinite alternate; }
.sound-wave span:nth-child(3) { height: 50%;  animation: barWave 0.55s ease-in-out 0.36s infinite alternate; }
@keyframes barWave { from { transform: scaleY(0.30); } to { transform: scaleY(1); } }
.card-label {
  font-weight: 800;
  color: #ffffff;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.7);
  letter-spacing: 0.5px;
  line-height: 1.18;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.card-value {
  font-weight: 900;
  color: #FFD700;
  text-shadow: 0 2px 6px rgba(0, 0, 0, 0.6), 0 0 18px rgba(255, 215, 0, 0.25);
  line-height: 1.05;
  letter-spacing: -1px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* カード active 用 keyframes（chunk マッチした card だけ生成） */
${cardActiveStyles}
`;

  // 値・ラベルの長さに応じてフォント縮小（layout の最大値起点）
  function _valFont(text) {
    const len = String(text || '').length;
    const m = layout.maxValFont;
    if (len <= 4)  return m;
    if (len <= 6)  return Math.max(m - 10, 36);
    if (len <= 9)  return Math.max(m - 24, 32);
    if (len <= 13) return Math.max(m - 36, 28);
    if (len <= 18) return Math.max(m - 46, 24);
    return Math.max(m - 52, 20);
  }
  function _labelFont(text) {
    const len = String(text || '').length;
    const m = layout.maxLabelFont;
    if (len <= 6)  return m;
    if (len <= 10) return Math.max(m - 5, 27);
    if (len <= 14) return Math.max(m - 11, 24);
    if (len <= 18) return Math.max(m - 16, 22);
    return Math.max(m - 19, 19);
  }

  const cardsHtml = slots.map((s, i) => {
    let lbl, val;
    if (s.merged && s.merged.includes('：')) {
      [lbl, val] = s.merged.split('：');
    } else {
      lbl = s.label || '';
      val = s.value || '-';
    }
    const isActive = (slotChunkIdx[i] >= 0 && audio.length);
    const activeClass = isActive ? ` active-${i}` : '';
    // active カードのみ波形アイコン（active 期間だけ opacity 1 になる）
    const wave = isActive
      ? `<div class="sound-wave"><span></span><span></span><span></span></div>`
      : '';
    return `<div class="data-card${activeClass}">
      <div class="card-label" style="font-size:${_labelFont(lbl)}px">${esc(lbl)}</div>
      <div class="card-value" style="font-size:${_valFont(val)}px">${esc(val)}</div>
      ${wave}
    </div>`;
  }).join('');

  const slideBody = `
<div class="panel-img">
  <div class="img-bg"></div>
  <div class="img-fade"></div>
  <div class="img-vfade"></div>
  <div class="dust-layer">${_buildDust()}</div>
  <div class="img-name-row">
    <div class="img-name-real">
      <div class="player-name">${titleHtml}</div>
      <div class="player-sub">${esc(subTitle)}</div>
    </div>
  </div>
</div>
<div class="panel-data">
  <div class="type-badge">${esc((mod.type || '').toUpperCase())}</div>
  <div class="card-grid">${cardsHtml}</div>
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 90, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

// profile も同じテンプレ（用途違いだけ）
module.exports = { buildStatsHTML };
