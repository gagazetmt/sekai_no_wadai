// scripts/v2_video/slides/history.js
// History スライド：左ヒーロー画像 + 右タイムライン（ドット+カード）
//   - 1〜7 件可変
//   - 音声 chunk と substring match で各 event の登場時刻を検出 → 並べ替え
//   - センチメンタル方針：純 fade のみ（slide なし）
//   - 数字+単位を金色ハイライト（年代・冠・歳・度目 等）
//   - 最新イベント dot は緑脈動を維持
//   - hero-subject / tl-header は AI 動的生成 or 日本語既定

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod, splitSubtitle, _t, LEAD_PAD_SEC, TAIL_PAD_SEC } = require('./_common');

const MAX_EVENTS = 7;

// 数字+単位を金色ハイライト（insight と共通の語彙＋年代対応）
function _highlightNumbers(escapedText) {
  return escapedText.replace(
    /([\d０-９]+(?:[\.,．，][\d０-９]+)?)\s*(年|年代|試合|ゴール|得点|アシスト|億|万|歳|位|連勝|連敗|連覇|周年|シーズン|度目|冠|勝|敗|本|点|個|G|A|％|%)/g,
    '<span class="hl-num">$1$2</span>'
  );
}

// catchphrase / event title を音声 chunk と照合
function _matchToChunk(text, chunks) {
  const tokens = String(text || '')
    .replace(/[の・はがをにでとや、。…!?！？「」『』【】（）\s〜ー]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
  if (!tokens.length || !chunks.length) return -1;
  let bestIdx = -1, bestScore = 0;
  chunks.forEach((c, i) => {
    const t = String(c.text || '');
    const score = tokens.reduce((s, tok) => s + (t.includes(tok) ? tok.length : 0), 0);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  return bestScore > 0 ? bestIdx : -1;
}

// 件数で min-height / フォントサイズ／余白を動的調整
function _layoutForCount(n) {
  if (n <= 3) return { gap: 32, padTop: 80, padBottom: 100, maxTitle: 36, maxSub: 24 };
  if (n <= 5) return { gap: 22, padTop: 70, padBottom: 96,  maxTitle: 32, maxSub: 22 };
  if (n === 6) return { gap: 16, padTop: 60, padBottom: 92, maxTitle: 28, maxSub: 19 };
  return        { gap: 12, padTop: 56, padBottom: 90,  maxTitle: 25, maxSub: 17 }; // 7件
}

function _titleFont(text, layout) {
  const len = String(text || '').length;
  const m = layout.maxTitle;
  if (len <= 14) return m;
  if (len <= 20) return Math.max(m - 4, 22);
  if (len <= 28) return Math.max(m - 9, 19);
  if (len <= 38) return Math.max(m - 13, 16);
  return Math.max(m - 16, 14);
}
function _subFont(text, layout) {
  const len = String(text || '').length;
  const m = layout.maxSub;
  if (len <= 18) return m;
  if (len <= 28) return Math.max(m - 3, 17);
  if (len <= 40) return Math.max(m - 6, 14);
  return Math.max(m - 8, 13);
}

function buildHistoryHTML(mod) {
  const bg = imgDataUri(mod.bgImage);

  // dataSlots から events を組み立てる（label = 日付, value = タイトル）
  let eventsRaw = [];
  if (Array.isArray(mod.dataSlots) && mod.dataSlots.length) {
    eventsRaw = mod.dataSlots.map((s, i) => ({
      date:  s.label || `${i+1}`,
      title: s.value || (mod.catchphrases?.[i] || ''),
      sub:   mod.narrationChunks?.[i] || '',
    }));
  } else if (Array.isArray(mod.catchphrases) && mod.catchphrases.length) {
    eventsRaw = mod.catchphrases.map((p, i) => ({
      date:  `${i+1}`,
      title: p,
      sub:   mod.narrationChunks?.[i] || '',
    }));
  }
  eventsRaw = eventsRaw.slice(0, MAX_EVENTS);

  const layout = _layoutForCount(eventsRaw.length);

  // ── 登場タイミング決定（insight と同じロジック） ─────────
  const audio = Array.isArray(mod.audio) ? mod.audio : [];
  // 先頭 LEAD_PAD_SEC を chunkStarts に加算、totalSec も LEAD+TAIL 含む全体時間に揃える
  const audioSec = audio.length ? audio.reduce((s, c) => s + (c.durationSec || 0), 0) : 0;
  const totalSec = audio.length ? (audioSec + LEAD_PAD_SEC + TAIL_PAD_SEC) : 8;
  const chunkStarts = audio.map((_, i) =>
    LEAD_PAD_SEC + audio.slice(0, i).reduce((s, c) => s + (c.durationSec || 0), 0));
  const startSec = LEAD_PAD_SEC + 0.5;
  const lastSec  = Math.max(totalSec - TAIL_PAD_SEC - 1, startSec + 1);
  const evenStep = eventsRaw.length > 1 ? (lastSec - startSec) / (eventsRaw.length - 1) : 0;

  // 1:1 対応を優先：chunks 数 == events 数なら index ベースで直接マッピング
  //   （AI が narrationChunks を dataSlots と同数で返した場合）
  const directMapping = audio.length === eventsRaw.length;
  const tempDelays = eventsRaw.map((e, i) => {
    if (directMapping) return chunkStarts[i] + 0.3;
    const cIdx = audio.length ? _matchToChunk(`${e.title} ${e.date}`, audio) : -1;
    return cIdx >= 0 ? chunkStarts[cIdx] + 0.3 : (startSec + evenStep * i);
  });

  // 検出 delay 順に並べ替え（早く話される event を画面上に）
  //   ただし「最新イベント」(緑脈動) を判別できなくなるので、元順での "最後" を記憶
  const originalLastIdx = eventsRaw.length - 1;
  const orderIdx = eventsRaw.map((_, i) => i)
    .sort((a, b) => (tempDelays[a] - tempDelays[b]) || (a - b));
  const events = orderIdx.map(i => ({
    ...eventsRaw[i],
    isLastInData: i === originalLastIdx, // データ上の最新を保持
  }));
  const delays = orderIdx.map(i => tempDelays[i]);

  // タイトル系 ─ AI 生成 or 既定（日本語）
  //   オーファン回避のため splitSubtitle で 1〜2 行に整形
  const _heroSrc = _t(mod.title || '');
  const _heroLines = splitSubtitle(_heroSrc, 11).lines.filter(Boolean);
  const _longestHero = Math.max(..._heroLines.map(l => l.length), 1);
  // 1行 12字以内なら font 大きめ、超えると 2行で表示
  let heroTitleFontPx = _heroLines.length === 1 && _heroLines[0].length <= 8 ? 84
                     : _heroLines.length === 1                              ? 72
                     : _longestHero > 12                                    ? 56
                     : 64;
  // 安全クランプ: panel-hero ≈ 720px 幅
  const _heroSafeFont = Math.floor((720 / _longestHero) * 0.95);
  if (heroTitleFontPx > _heroSafeFont) heroTitleFontPx = Math.max(_heroSafeFont, 36);
  const heroTitle = _heroLines.map(l => esc(l)).join('<br>');
  const heroSubject = (mod.historyHero            && String(mod.historyHero).trim())            || '軌跡';
  const tlHeader    = (mod.historyMilestoneLabel  && String(mod.historyMilestoneLabel).trim())  || '主な歩み';

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
  ${bg ? 'animation: bgZoom 14s ease-out forwards;' : ''}
}
@keyframes bgZoom { from { transform: scale(1); } to { transform: scale(1.05); } }
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
  font-size: ${heroTitleFontPx}px;
  font-weight: 900;
  color: ${PALETTE.text};
  line-height: 1.15;
  text-shadow: 0 3px 14px rgba(0, 0, 0, 0.95);
}
.panel-timeline {
  flex: 1;
  height: 100%;
  padding: ${layout.padTop}px 80px ${layout.padBottom}px 60px;
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
/* ── センチメンタル方針：純 fade のみ。slide 動きなし ── */
@keyframes evtFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@keyframes dotPulse {
  0%   { box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.4); }
  50%  { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0.5), 0 0 24px rgba(16, 185, 129, 0.6); }
  100% { box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.4); }
}
.tl-event {
  position: relative;
  display: flex;
  align-items: center;
  gap: 40px;
  padding: 8px 0;
  opacity: 0;
  animation: evtFadeIn 0.85s ease-in-out forwards;
}
/* 最新イベント dot の緑脈動：データ最終 event のみ、最終 delay 後から開始 */
.tl-event.is-last::before {
  animation: dotPulse 1.6s ease-in-out infinite;
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
.tl-event.is-last::before {
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
  padding: 14px 28px;
  display: flex; flex-direction: column; gap: 4px;
}
.tl-title {
  font-weight: 800;
  color: ${PALETTE.text};
  line-height: 1.2;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.tl-sub {
  font-weight: 500;
  color: ${PALETTE.muted};
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
/* 数字+単位ハイライト：金色＋強グロー */
.hl-num {
  color: #fcd34d;
  font-weight: 900;
  text-shadow: 0 0 14px rgba(252, 211, 77, 0.7), 0 2px 10px rgba(0,0,0,0.8);
}
`;

  const eventsHtml = events.map((e, displayIdx) => {
    const ttl = String(e.title || '');
    const sub = String(e.sub   || '');
    const dateHtml = _highlightNumbers(esc(String(e.date || '')));
    const ttlHtml  = _highlightNumbers(esc(ttl));
    const subHtml  = _highlightNumbers(esc(sub));
    const delay = delays[displayIdx].toFixed(2);
    const lastClass = e.isLastInData ? ' is-last' : '';
    return `<div class="tl-event${lastClass}" style="animation-delay:${delay}s;${e.isLastInData ? `--pulse-delay:${(parseFloat(delay) + 0.3).toFixed(2)}s;` : ''}">
      <div class="tl-date">${dateHtml}</div>
      <div class="tl-card">
        <div class="tl-title" style="font-size:${_titleFont(ttl, layout)}px">${ttlHtml}</div>
        ${e.sub ? `<div class="tl-sub" style="font-size:${_subFont(sub, layout)}px">${subHtml}</div>` : ''}
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
  <div class="tl-header">${esc(tlHeader)}</div>
  <div class="tl-body">${eventsHtml}</div>
</div>
${buildSubtitleBar(subtitleArgFromMod(mod), { height: 90, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildHistoryHTML };
