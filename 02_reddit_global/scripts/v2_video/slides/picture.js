// scripts/v2_video/slides/picture.js
// ピクチャースライド：シンプルに 1 枚の画像をメインに見せるスライド
//
// データ:
//   mod.type        = 'picture'
//   mod.title       = '...'                            (任意。 縦画像時に左側に大きく表示)
//   mod.images      = ['/path/to/image.jpg']           (1 枚目を使用)
//   mod.orientation = 'horizontal' | 'vertical'        (省略時 'horizontal')
//   mod.narration   = '...'                            (字幕バー用)
//
// レイアウト:
//   horizontal: 字幕バー (110px) の上をフル活用、 画像を最大配置
//   vertical  : 画像を右側に縦幅いっぱい、 左側に title

const { PALETTE, esc, imgDataUri, wrapHTML, buildSubtitleBar, subtitleArgFromMod } = require('./_common');

const SUB_BAR_HEIGHT = 110;

function buildPictureHTML(mod) {
  const m = mod || {};
  const imgPath = (Array.isArray(m.images) && m.images.length) ? m.images[0] : null;
  const imgSrc = imgPath ? imgDataUri(imgPath) : '';

  // orientation: 手動指定 > デフォルト horizontal
  const orientation = (m.orientation === 'vertical') ? 'vertical' : 'horizontal';

  const subtitleArg = subtitleArgFromMod(m);
  const subBarHTML  = buildSubtitleBar(subtitleArg, { height: SUB_BAR_HEIGHT });

  const title = String(m.title || '');

  // ─── レイアウト構築 ─────────────────────────────────
  let bodyHTML;
  if (orientation === 'horizontal') {
    bodyHTML = `
      <div class="pic-area-h">
        ${imgSrc ? `<img class="pic-img pic-img-h" src="${imgSrc}" alt="">` : '<div class="pic-empty">画像未選択</div>'}
      </div>
    `;
  } else {
    bodyHTML = `
      <div class="pic-area-v">
        <div class="pic-text">
          ${title ? `<div class="pic-title">${esc(title)}</div>` : ''}
        </div>
        ${imgSrc ? `<img class="pic-img pic-img-v" src="${imgSrc}" alt="">` : '<div class="pic-empty">画像未選択</div>'}
      </div>
    `;
  }

  const extraStyles = `
.bg-base {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 25% 20%, rgba(245,158,11,0.12), transparent 55%),
    radial-gradient(circle at 75% 80%, rgba(245,158,11,0.06), transparent 55%),
    linear-gradient(135deg, #0a1428 0%, #060e1c 50%, #0d1830 100%);
}
.grid-overlay {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(rgba(245,158,11,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(245,158,11,0.04) 1px, transparent 1px);
  background-size: 80px 80px;
}

/* ─── 横画像 ─────────────────────────── */
.pic-area-h {
  position: absolute;
  top: 40px; left: 60px; right: 60px;
  bottom: ${SUB_BAR_HEIGHT + 40}px;
  display: flex; align-items: center; justify-content: center;
}
.pic-img-h {
  max-width: 100%; max-height: 100%;
  width: auto; height: auto;
  object-fit: contain;
}

/* ─── 縦画像 (右寄せ + 左タイトル) ─────── */
.pic-area-v {
  position: absolute;
  top: 40px; left: 60px; right: 60px;
  bottom: ${SUB_BAR_HEIGHT + 40}px;
  display: flex;
  gap: 60px;
  align-items: stretch;
}
.pic-text {
  flex: 1;
  display: flex; align-items: center;
  min-width: 0;
}
.pic-title {
  font-size: 96px; font-weight: 900;
  color: #ffffff;
  line-height: 1.15;
  border-left: 16px solid #f59e0b;
  padding-left: 40px;
  text-shadow: 0 4px 20px rgba(0,0,0,0.8);
  word-break: break-word;
}
.pic-img-v {
  height: 100%;
  width: auto;
  object-fit: contain;
  flex-shrink: 0;
}

/* ─── 共通: 画像枠グロー + pulse ─────── */
.pic-img {
  border-radius: 14px;
  box-shadow:
    0 0 60px rgba(245,158,11,0.55),
    0 0 120px rgba(245,158,11,0.25),
    inset 0 0 0 2px rgba(245,158,11,0.35);
  animation: picGlow 3.2s ease-in-out infinite;
}
@keyframes picGlow {
  0%, 100% {
    box-shadow:
      0 0 60px rgba(245,158,11,0.55),
      0 0 120px rgba(245,158,11,0.25),
      inset 0 0 0 2px rgba(245,158,11,0.35);
  }
  50% {
    box-shadow:
      0 0 100px rgba(245,158,11,0.85),
      0 0 200px rgba(245,158,11,0.40),
      inset 0 0 0 2px rgba(251,191,36,0.60);
  }
}
.pic-empty {
  color: #6b7280; font-size: 28px; padding: 60px; text-align: center;
  border: 2px dashed #374151; border-radius: 14px;
}
  `;

  const slideBody = `
<div class="bg-base"></div>
<div class="grid-overlay"></div>
${bodyHTML}
${subBarHTML}
`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildPictureHTML };
