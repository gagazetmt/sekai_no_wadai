// scripts/v2_video/slides/stats.js
// Stats / Profile スライド：型3 ベース（左=画像 / 右=データカード grid）
//   stats   : 6〜8 件、3〜4 列 grid
//   profile : 4 件、2x2 grid
//
//  演出:
//   - 画像: fade in（0.5s）
//   - 名前ボックス: 下から浮上ゴーストトレイル + 本体 fade in（insight の縦版）
//   - データカード: 該当 chunk が再生中だけ active（金枠 + scale 1.04 + グロー）

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, _t, _player } = require('./_common');

// チーム or 選手 → 日本語/カタカナ
function _entityName(raw) {
  if (!raw) return '';
  const ja = _t(raw);
  if (ja !== raw) return ja;
  return _player(raw);
}

// 件数別 grid layout（6-8件は 3-4列、4件は 2列、3件以下は 1行）
function _gridLayout(count) {
  if (count <= 3) return { cols: count, gap: 18, maxValFont: 78, maxLabelFont: 32, padTop: 80, padBottom: 130 };
  if (count === 4) return { cols: 2, gap: 18, maxValFont: 78, maxLabelFont: 32, padTop: 80, padBottom: 130 };
  if (count <= 6) return { cols: 3, gap: 16, maxValFont: 68, maxLabelFont: 28, padTop: 70, padBottom: 120 };
  return            { cols: 4, gap: 14, maxValFont: 56, maxLabelFont: 24, padTop: 60, padBottom: 116 }; // 7-8件
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

  // dataSlots: stats は 6-8、profile は 4 を想定
  const slots = (Array.isArray(mod.dataSlots) ? mod.dataSlots : []).slice(0, 8);
  const minCount = mod.type === 'stats' ? 6 : 4;
  while (slots.length < minCount) slots.push({ label: '', value: '' });
  const layout = _gridLayout(slots.length);

  const title    = _t(mod.title) || _entityName(mod.siBinding) || 'STATS';
  const subTitle = _entityName(mod.siBinding) || (mod.type === 'profile' ? 'PROFILE' : 'STATISTICS');

  // type バッジの色（profile=紫 / stats=緑）
  const badgeColor = mod.type === 'profile' ? '#8b5cf6' : '#10b981';

  // ── 音声 chunk 解析（カード active 制御用）─────────────
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audioSec + 0.4 || 8;  // tail pad 含む。音声無いときは 8s 想定
  const chunkStarts = audio.map((_, i) =>
    audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));

  // 各 slot に chunk index を割当（ラベルが含まれる chunk）
  const slotChunkIdx = slots.map(s => {
    const lbl = (s.merged && s.merged.includes('：')) ? s.merged.split('：')[0] : s.label;
    return audio.length ? _matchLabelToChunk(lbl, audio) : -1;
  });

  // カード active 用 keyframes 生成
  //   chunk 範囲: 0.25s 前から fade in、終了 0.3s 後に fade out
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
    return `
@keyframes cardActive_${i} {
  0%, ${preStartPct.toFixed(2)}%      { transform: scale(1);    border-color: rgba(255,255,255,0.10); box-shadow: 0 0 0 0 rgba(252,211,77,0); }
  ${startPct.toFixed(2)}%, ${endPct.toFixed(2)}%  { transform: scale(1.04); border-color: rgba(252,211,77,0.85); box-shadow: 0 0 0 3px rgba(252,211,77,0.30), 0 0 36px rgba(252,211,77,0.55); }
  ${postEndPct.toFixed(2)}%, 100%     { transform: scale(1);    border-color: rgba(255,255,255,0.10); box-shadow: 0 0 0 0 rgba(252,211,77,0); }
}
.data-card.active-${i} { animation: cardActive_${i} ${totalSec.toFixed(2)}s linear forwards; }`;
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
  opacity: 0;
  animation: imgFadeIn 0.5s ease-out forwards;
}
@keyframes imgFadeIn { from { opacity: 0; } to { opacity: 1; } }
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

/* 名前タグ：本体 + ゴーストトレイル（縦版） */
.img-name-row {
  position: absolute;
  bottom: 130px;
  left: 0; right: 0;
  padding: 0 40px;
}
.img-name-real, .img-name-trail {
  position: relative;
}
.img-name-trail {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 2;
  opacity: 0;
  animation: nameTrail 0.55s ease-out 0.4s backwards;
}
.img-name-real {
  opacity: 0;
  animation: nameAppear 0.55s ease-out 0.5s forwards;
  z-index: 1;
}
@keyframes nameTrail {
  from { transform: translateY(80px); opacity: 1; }
  to   { transform: translateY(0);    opacity: 0; }
}
@keyframes nameAppear {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.player-name {
  font-size: 56px;
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
.card-label {
  font-weight: 800;
  color: #8aa8d8;
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
    if (len <= 10) return Math.max(m - 4, 20);
    if (len <= 14) return Math.max(m - 8, 18);
    if (len <= 18) return Math.max(m - 12, 16);
    return Math.max(m - 14, 14);
  }

  const cardsHtml = slots.map((s, i) => {
    let lbl, val;
    if (s.merged && s.merged.includes('：')) {
      [lbl, val] = s.merged.split('：');
    } else {
      lbl = s.label || '';
      val = s.value || '-';
    }
    const activeClass = (slotChunkIdx[i] >= 0 && audio.length) ? ` active-${i}` : '';
    return `<div class="data-card${activeClass}">
      <div class="card-label" style="font-size:${_labelFont(lbl)}px">${esc(lbl)}</div>
      <div class="card-value" style="font-size:${_valFont(val)}px">${esc(val)}</div>
    </div>`;
  }).join('');

  const slideBody = `
<div class="panel-img">
  <div class="img-bg"></div>
  <div class="img-fade"></div>
  <div class="img-vfade"></div>
  <div class="img-name-row">
    <div class="img-name-trail">
      <div class="player-name">${esc(title)}</div>
      <div class="player-sub">${esc(subTitle)}</div>
    </div>
    <div class="img-name-real">
      <div class="player-name">${esc(title)}</div>
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
