// scripts/v2_thumb/templates/magazineCover.js
// サムネ テンプレ N: MAGAZINE COVER（雑誌表紙風）
//   - 上部に大きな雑誌タイトル（"FOOTBALL ANALYSIS"）+ 細い金線
//   - 写真フルブリード（左寄せ）
//   - 右側に複数の "stickers" / circular badges (数字+ラベル)
//   - 下部に大きな serif タイトル + 副題
//   - エディトリアル感
//
// 入力:
//   {
//     heroImage: 'path',
//     issueLabel: 'ISSUE 042',  // 上部の号数
//     title: 'メインタイトル',
//     subtitle: 'サブタイトル/煽り',
//     stickers: [
//       { value: '63%', label: 'xG超過', color: 'red' },
//       { value: '+24', label: 'Goal Diff', color: 'gold' },
//       { value: '8.4', label: 'Avg Rating', color: 'green' },
//     ],
//   }

const {
  PALETTE, esc, imgDataUri, wrapThumb, CHANNEL_NAME,
} = require('../_common');

const STICKER_COLORS = {
  red:   { bg: '#dc2626', text: '#fff', border: '#000' },
  gold:  { bg: '#fcd34d', text: '#000', border: '#000' },
  green: { bg: '#10b981', text: '#fff', border: '#000' },
  blue:  { bg: '#3b82f6', text: '#fff', border: '#000' },
};

function buildMagazineCoverThumb(data = {}) {
  const heroImg = imgDataUri(data.heroImage);
  const issueLabel = data.issueLabel || `ISSUE ${String(Math.floor(Math.random() * 99) + 1).padStart(3, '0')}`;
  const title = data.title || 'タイトル';
  const subtitle = data.subtitle || '';
  const stickers = (data.stickers || []).slice(0, 3);
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-base { position: absolute; inset: 0; background: #f5f0e6; }

/* ── 上部 雑誌マストヘッド ── */
.masthead {
  position: absolute;
  top: 0; left: 0; right: 0;
  background: linear-gradient(180deg, #000 0%, #1a1a1a 100%);
  border-bottom: 4px solid #fcd34d;
  padding: 18px 36px 14px;
  display: flex; align-items: baseline; justify-content: space-between;
  z-index: 8;
}
.masthead-title {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 38px;
  font-weight: 900;
  color: #fcd34d;
  letter-spacing: 14px;
  font-style: italic;
  text-transform: uppercase;
  text-shadow: 0 0 14px rgba(252,211,77,0.4);
}
.masthead-issue {
  font-family: 'Georgia', serif;
  font-size: 13px;
  color: #fff;
  letter-spacing: 6px;
  border-left: 2px solid #fcd34d;
  padding-left: 14px;
}
.masthead-channel {
  font-size: 13px;
  color: #fcd34d;
  font-weight: 900;
  letter-spacing: 4px;
}

/* ── 写真（フルブリード、左寄り）── */
.hero-cover {
  position: absolute;
  top: 86px; left: 0; right: 0; bottom: 0;
  ${heroImg ? `background-image: url('${heroImg}');` : 'background: linear-gradient(135deg, #2a3560, #0d1220);'}
  background-size: cover;
  background-position: 30% 22%;
  filter: contrast(1.18) saturate(1.15);
}
/* 右半分を暗化（ステッカーが映えるように）*/
.cover-overlay {
  position: absolute;
  top: 86px; left: 0; right: 0; bottom: 0;
  background:
    linear-gradient(90deg, transparent 0%, transparent 35%, rgba(20,15,10,0.55) 70%, rgba(20,15,10,0.85) 100%),
    linear-gradient(0deg, rgba(20,15,10,0.7) 0%, rgba(20,15,10,0.0) 35%);
}

/* ── 右側ステッカー（円形バッジ）── */
.stickers {
  position: absolute;
  top: 110px; right: 30px;
  display: flex; flex-direction: column; gap: 18px;
  z-index: 6;
}
.sticker {
  width: 165px; height: 165px;
  border-radius: 50%;
  border: 5px solid;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  box-shadow: 0 8px 22px rgba(0,0,0,0.6), 0 0 0 3px rgba(255,255,255,0.85) inset;
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  text-align: center;
}
.sticker:nth-child(1) { transform: rotate(-6deg); }
.sticker:nth-child(2) { transform: rotate(4deg); margin-left: 28px; }
.sticker:nth-child(3) { transform: rotate(-3deg); margin-left: -8px; }
.sticker .s-num {
  font-size: 48px;
  font-weight: 900;
  letter-spacing: -1px;
  line-height: 1;
  -webkit-text-stroke: 1.5px;
  text-shadow: 2px 2px 0 currentColor;
}
.sticker .s-label {
  font-size: 13px;
  font-weight: 900;
  letter-spacing: 1px;
  margin-top: 6px;
  line-height: 1.2;
  font-family: 'Georgia', serif;
  font-style: italic;
}

/* ── 下部 大タイトル ── */
.cover-title-zone {
  position: absolute;
  bottom: 28px; left: 36px; right: 350px;
  z-index: 7;
}
.cover-title {
  font-family: 'Hiragino Kaku Gothic ProN', sans-serif;
  font-size: 70px;
  font-weight: 900;
  color: #fff;
  line-height: 1.05;
  letter-spacing: -2px;
  -webkit-text-stroke: 1px #fff;
  text-shadow:
    0 0 14px rgba(252,211,77,0.7),
    2px 2px 0 #000,
    4px 4px 0 #000,
    0 8px 24px rgba(0,0,0,0.95);
  word-break: keep-all;
  ${title.length > 14 ? 'font-size: 58px;' : ''}
  ${title.length > 20 ? 'font-size: 48px;' : ''}
}
.cover-subtitle {
  display: ${subtitle ? 'inline-block' : 'none'};
  margin-top: 14px;
  font-family: 'Georgia', 'Times New Roman', serif;
  font-style: italic;
  font-size: 26px;
  font-weight: 700;
  color: #fcd34d;
  letter-spacing: 2px;
  background: rgba(0,0,0,0.7);
  padding: 6px 18px;
  border-left: 4px solid #fcd34d;
  text-shadow: 0 2px 6px rgba(0,0,0,0.8);
}

/* ── 左側装飾: 縦バーコード風 ── */
.barcode-strip {
  position: absolute;
  top: 100px; left: 16px;
  width: 4px; height: 360px;
  background:
    linear-gradient(180deg,
      #000 0%, #000 5%,
      transparent 5%, transparent 8%,
      #000 8%, #000 13%,
      transparent 13%, transparent 16%,
      #000 16%, #000 28%,
      transparent 28%, transparent 32%,
      #000 32%, #000 38%,
      transparent 38%, transparent 41%,
      #000 41%, #000 55%,
      transparent 55%, transparent 58%,
      #000 58%, #000 70%);
  z-index: 4;
  opacity: 0.7;
}
`;

  // ステッカー色付け
  const stickerHtml = stickers.map(st => {
    const c = STICKER_COLORS[st.color] || STICKER_COLORS.red;
    return `<div class="sticker" style="background:${c.bg};color:${c.text};border-color:${c.border};">
      <div class="s-num" style="color:${c.text};">${esc(st.value || '')}</div>
      <div class="s-label" style="color:${c.text};">${esc(st.label || '')}</div>
    </div>`;
  }).join('');

  const thumbBody = `
<div class="bg-base"></div>
<div class="hero-cover"></div>
<div class="cover-overlay"></div>
<div class="barcode-strip"></div>
<div class="masthead">
  <span class="masthead-title">FOOTBALL ANALYSIS</span>
  <span class="masthead-issue">${esc(issueLabel)}</span>
  <span class="masthead-channel">${esc(channelName)}</span>
</div>
<div class="stickers">
  ${stickerHtml}
</div>
<div class="cover-title-zone">
  <div class="cover-title">${esc(title)}</div>
  ${subtitle ? `<div class="cover-subtitle">${esc(subtitle)}</div>` : ''}
</div>
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail N: Magazine Cover', tone: 'dark' });
}

module.exports = { buildMagazineCoverThumb };
