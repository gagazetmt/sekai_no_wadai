// scripts/v2_thumb/templates/dataHero.js
// サムネ テンプレ A: データ強調型（汎用・最頻出）
//   - 左に選手の顔写真（暗い背景に切り抜き想定）
//   - 右上に巨大な数字
//   - 右下に短いキャッチ
//   - 左下にチャンネルロゴ
//   - tone: 'dark' | 'light' で配色切替

const {
  PALETTE, tonePalette, esc, imgDataUri, wrapThumb,
  channelLogoHtml, channelLogoStyleFor, CHANNEL_NAME,
} = require('../_common');

function buildDataHeroThumb(data = {}) {
  const tone = data.tone || 'dark';
  const isLight = tone === 'light';
  const p = tonePalette(tone);
  const heroImg = imgDataUri(data.heroImage);
  const heroNumber = data.heroNumber || '?';
  const heroLabel = data.heroLabel || '';
  // 2026-05-08 三層構造化:
  //   - badge      : 上部の象徴ラベル (5-8字 推奨, 旧2字決まり文句から拡張)
  //   - catchLeft  : 左下の赤太文字 (物語のサブテーマ)
  //   - catchRight : 右下の白太文字 (メインキャッチ・旧 catch)
  const catchRight = data.catchRight || data.catch || '';  // 後方互換
  const catchLeft  = data.catchLeft  || '';
  const badge = data.badge || '';
  const badgeColor = data.badgeColor || p.red;
  const channelName = data.channelName || CHANNEL_NAME;
  // badge の文字数で自動スケール
  const badgeLen = [...badge].length;
  const badgeSize = badgeLen <= 4 ? 42
                  : badgeLen <= 6 ? 36
                  : badgeLen <= 8 ? 30
                  :                 26;

  // light tone 時はテキストシャドウ控えめ
  const heroNumShadow = isLight
    ? `0 4px 12px rgba(194,116,10,0.25), 0 2px 4px rgba(0,0,0,0.15)`
    : `0 0 40px rgba(245,158,11,0.55), 0 0 100px rgba(245,158,11,0.3), 0 8px 30px rgba(0,0,0,0.95)`;
  const catchShadow = isLight
    ? `0 2px 8px rgba(0,0,0,0.10)`
    : `0 0 12px rgba(255,255,255,0.4), 0 0 28px rgba(245,158,11,0.4), 0 6px 24px rgba(0,0,0,0.95)`;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background: ${isLight
    ? `radial-gradient(ellipse 60% 80% at 30% 50%, rgba(245,158,11,0.12) 0%, transparent 60%),
       linear-gradient(135deg, #fefaf2 0%, #f7f3ec 60%, #f0e8d8 100%)`
    : `radial-gradient(ellipse 60% 80% at 30% 50%, rgba(245,158,11,0.18) 0%, transparent 60%),
       linear-gradient(135deg, #1f2a4a 0%, #0a0e1a 60%, #060a14 100%)`};
}
/* ── 左側：選手画像 ── */
.hero-photo {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 64%;
  ${heroImg ? `background-image: url('${heroImg}');` : `background: ${isLight ? 'radial-gradient(circle at 50% 60%, #d8c8a8, #b8a888)' : 'radial-gradient(circle at 50% 60%, #2a3560, #0d1220)'};`}
  background-size: cover;
  background-position: center 25%;
  filter: contrast(1.1) saturate(1.05);
}
.hero-photo::after {
  content: '';
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 110px;
  background: linear-gradient(to right, transparent 0%, ${p.bg} 100%);
}

/* ── 右側：データブロック ── */
.data-zone {
  position: absolute;
  right: 0; top: 0; bottom: 0;
  width: 44%;
  padding: 30px 40px 40px 50px;
  display: flex; flex-direction: column;
  z-index: 5;
}

.top-badge {
  display: ${badge ? 'inline-block' : 'none'};
  align-self: flex-start;
  background: ${badgeColor};
  color: #fff;
  padding: 14px 32px;
  font-size: ${badgeSize}px;
  font-weight: 900;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Impact', 'Bebas Neue', sans-serif;
  letter-spacing: ${badgeLen <= 4 ? 8 : badgeLen <= 6 ? 5 : 3}px;
  border-radius: 4px;
  box-shadow: 0 6px 24px ${badgeColor}99, 0 0 0 3px ${isLight ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.18)'} inset;
  margin-bottom: 18px;
  text-shadow: 0 2px 6px rgba(0,0,0,0.35);
  -webkit-text-stroke: 0.5px rgba(0,0,0,0.25);
  white-space: nowrap;
}

/* ── 左下: catchLeft（赤太文字 + 黒モヤ） 2026-05-08 三層化 ── */
.catch-left {
  display: ${catchLeft ? 'flex' : 'none'};
  position: absolute;
  left: 0; bottom: 0;
  width: 56%;
  min-height: 130px;
  padding: 22px 38px 28px 36px;
  align-items: flex-end;
  z-index: 6;
  /* 黒モヤ：写真の左下から立ち上る暗いグラデーション */
  background: linear-gradient(to top,
    rgba(0,0,0,0.92) 0%,
    rgba(0,0,0,0.78) 35%,
    rgba(0,0,0,0.45) 70%,
    rgba(0,0,0,0) 100%);
}
.catch-left-text {
  font-size: 42px;
  font-weight: 900;
  font-family: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Impact', sans-serif;
  color: #ef4444;
  line-height: 1.18;
  letter-spacing: 1px;
  -webkit-text-stroke: 1.5px rgba(255,255,255,0.12);
  text-shadow:
    0 0 12px rgba(239,68,68,0.55),
    0 0 22px rgba(239,68,68,0.32),
    0 4px 18px rgba(0,0,0,0.95);
  word-break: break-word;
  overflow-wrap: anywhere;
  max-width: 100%;
}

/* 数字ゾーン: 上寄り配置 */
.hero-num-zone {
  text-align: right;
  margin-top: ${badge ? '0' : '20px'};
  margin-bottom: 20px;
}
.hero-num {
  font-family: 'Georgia', 'Times New Roman', serif;
  font-size: 180px;
  font-weight: 900;
  font-style: italic;
  color: ${p.accent};
  letter-spacing: -8px;
  line-height: 0.9;
  text-shadow: ${heroNumShadow};
  display: inline-block;
}
.hero-label {
  font-size: 24px;
  font-weight: 700;
  color: ${p.text};
  letter-spacing: 4px;
  margin-top: 4px;
  text-shadow: ${isLight ? 'none' : '0 2px 10px rgba(0,0,0,0.8)'};
}

/* キャッチ: 下寄り配置で 2行折返し対応 */
.catch-zone {
  display: flex; flex-direction: column; align-items: flex-end;
  margin-top: auto;
  font-size: 44px;
  font-weight: 900;
  color: ${p.text};
  line-height: 1.22;
  ${isLight ? '' : `-webkit-text-stroke: 2px rgba(255,255,255,0.18);`}
  text-shadow: ${catchShadow};
  letter-spacing: 1px;
  max-width: 100%;
  word-break: break-word;
  overflow-wrap: anywhere;
  text-align: right;
}
.catch-bar {
  display: block;
  width: 80px; height: 6px;
  background: ${p.accent};
  margin-bottom: 14px;
  box-shadow: 0 0 18px ${isLight ? 'rgba(194,116,10,0.4)' : 'rgba(245,158,11,0.5)'};
  align-self: flex-end;
}

${channelLogoStyleFor(tone)}
`;

  const thumbBody = `
<div class="bg-gradient"></div>
<div class="hero-photo"></div>
${catchLeft ? `<div class="catch-left"><div class="catch-left-text">${esc(catchLeft)}</div></div>` : ''}
<div class="data-zone">
  ${badge ? `<div class="top-badge">${esc(badge)}</div>` : '<div></div>'}
  <div class="hero-num-zone">
    <div class="hero-num">${esc(heroNumber)}</div>
    ${heroLabel ? `<div class="hero-label">${esc(heroLabel)}</div>` : ''}
  </div>
  <div class="catch-zone"><span class="catch-bar"></span>${esc(catchRight)}</div>
</div>
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: `Thumbnail A (${tone}): Data Hero`, tone });
}

module.exports = { buildDataHeroThumb };
