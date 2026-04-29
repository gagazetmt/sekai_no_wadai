// scripts/v2_thumb/templates/vs.js
// サムネ テンプレ C: VS型
//   - 左右に2選手・2チームの顔写真
//   - 中央に大きな VS バッジ（黄金色グロー）
//   - 上部に対戦タイトル
//   - 下部にデータ比較ヒント
//
// 入力:
//   {
//     title: 'マンU時代',
//     leftName: 'ロナウド',
//     leftValue: '145ゴール',
//     leftImage: 'path/to/ronaldo.jpg',
//     rightName: 'ルーニー',
//     rightValue: '253ゴール',
//     rightImage: 'path/to/rooney.jpg',
//     bottomCatch: 'どっちが上？',
//   }

const { PALETTE, esc, imgDataUri, wrapThumb, channelLogoHtml, channelLogoStyle, CHANNEL_NAME } = require('../_common');

function buildVsThumb(data = {}) {
  const title = data.title || 'VS';
  const leftName = data.leftName || '?';
  const leftValue = data.leftValue || '';
  const leftImg = imgDataUri(data.leftImage);
  const rightName = data.rightName || '?';
  const rightValue = data.rightValue || '';
  const rightImg = imgDataUri(data.rightImage);
  const bottomCatch = data.bottomCatch || '';
  const channelName = data.channelName || CHANNEL_NAME;

  const extraStyles = `
.bg-gradient {
  position: absolute; inset: 0;
  background:
    linear-gradient(90deg, rgba(59, 130, 246, 0.18) 0%, transparent 35%, transparent 65%, rgba(239, 68, 68, 0.18) 100%),
    radial-gradient(ellipse at 50% 50%, #1f2a4a 0%, #060a14 100%);
}

/* ── 中央タイトル ── */
.vs-title {
  position: absolute;
  top: 30px; left: 50%;
  transform: translateX(-50%);
  font-size: 38px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 6px;
  padding: 8px 28px;
  background: rgba(0, 0, 0, 0.7);
  border: 2px solid ${PALETTE.accent};
  border-radius: 6px;
  z-index: 6;
  white-space: nowrap;
  text-shadow: 0 0 10px rgba(245,158,11,0.4);
}

/* ── 2人エリア ── */
.fighter-zone {
  position: absolute;
  top: 110px; bottom: 110px; left: 0; right: 0;
  display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center;
  z-index: 5;
}
.fighter {
  display: flex; flex-direction: column; align-items: center;
  gap: 16px;
  padding: 0 24px;
}
.fighter.left { padding-right: 60px; }
.fighter.right { padding-left: 60px; }
.fighter-photo {
  width: 280px; height: 280px;
  border-radius: 50%;
  background-size: cover;
  background-position: center 20%;
  filter: contrast(1.1) saturate(1.1);
}
.fighter.left .fighter-photo {
  border: 6px solid #3b82f6;
  box-shadow: 0 0 36px rgba(59,130,246,0.65), 0 0 0 4px rgba(59,130,246,0.25) inset;
}
.fighter.right .fighter-photo {
  border: 6px solid #ef4444;
  box-shadow: 0 0 36px rgba(239,68,68,0.65), 0 0 0 4px rgba(239,68,68,0.25) inset;
}
.fighter-name {
  font-size: 48px;
  font-weight: 900;
  color: ${PALETTE.text};
  letter-spacing: 1px;
  -webkit-text-stroke: 1.5px rgba(255,255,255,0.18);
  text-shadow: 0 4px 16px rgba(0,0,0,0.95);
  white-space: nowrap;
}
.fighter-value {
  font-family: 'Georgia', serif;
  font-size: 50px;
  font-weight: 900;
  font-style: italic;
  color: ${PALETTE.accent};
  letter-spacing: -1px;
  text-shadow: 0 0 16px rgba(245,158,11,0.5);
  white-space: nowrap;
}

/* ── 中央 VS ── */
.vs-badge {
  display: flex; flex-direction: column; align-items: center;
  font-family: 'Georgia', serif;
  font-style: italic;
}
.vs-text {
  font-size: 180px;
  font-weight: 900;
  color: ${PALETTE.accent};
  letter-spacing: -10px;
  line-height: 0.85;
  text-shadow:
    0 0 40px rgba(245,158,11,0.8),
    0 0 80px rgba(245,158,11,0.5),
    0 8px 30px rgba(0,0,0,0.95);
  filter: drop-shadow(0 0 12px rgba(245,158,11,0.6));
}
.vs-spark {
  font-size: 24px;
  letter-spacing: 6px;
  color: ${PALETTE.text};
  margin-top: -10px;
  font-style: normal;
  font-weight: 900;
  text-shadow: 0 0 10px rgba(255,255,255,0.4);
}

/* ── 下部キャッチ ── */
.bottom-catch {
  position: absolute;
  bottom: 26px; left: 50%;
  transform: translateX(-50%);
  font-size: 32px;
  font-weight: 900;
  color: ${PALETTE.text};
  background: rgba(245, 158, 11, 0.95);
  color: #000;
  padding: 12px 36px;
  border-radius: 8px;
  letter-spacing: 2px;
  box-shadow: 0 6px 24px rgba(245,158,11,0.6);
  z-index: 7;
  white-space: nowrap;
}

${channelLogoStyle}
.channel-logo { left: 24px; bottom: 24px; }
`;

  const thumbBody = `
<div class="bg-gradient"></div>
<div class="vs-title">${esc(title)}</div>
<div class="fighter-zone">
  <div class="fighter left">
    <div class="fighter-photo" style="${leftImg ? `background-image: url('${leftImg}')` : `background: linear-gradient(135deg, #1e3a8a, #0f1729)`}"></div>
    <div class="fighter-name">${esc(leftName)}</div>
    ${leftValue ? `<div class="fighter-value">${esc(leftValue)}</div>` : ''}
  </div>
  <div class="vs-badge">
    <div class="vs-text">VS</div>
    <div class="vs-spark">CLASH</div>
  </div>
  <div class="fighter right">
    <div class="fighter-photo" style="${rightImg ? `background-image: url('${rightImg}')` : `background: linear-gradient(135deg, #991b1b, #3f0a0a)`}"></div>
    <div class="fighter-name">${esc(rightName)}</div>
    ${rightValue ? `<div class="fighter-value">${esc(rightValue)}</div>` : ''}
  </div>
</div>
${bottomCatch ? `<div class="bottom-catch">${esc(bottomCatch)}</div>` : ''}
${channelLogoHtml(channelName)}
`;

  return wrapThumb({ thumbBody, extraStyles, title: 'Thumbnail C: VS' });
}

module.exports = { buildVsThumb };
