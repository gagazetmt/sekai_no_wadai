// scripts/v2_video/slides/matchcenter.js
// Matchcenter スライド：試合詳細（スコア + 得点 + スタッツ）
// テンプレート元: /matchcenter/index.html の compact 版

const { PALETTE, esc, imgDataUri, wrapHTML , buildSubtitleBar } = require('./_common');

function buildMatchcenterHTML(mod) {
  // siBinding の sofascore_match データから組み立てるのが理想
  // mod.matchData があればそれ、なければ dataSlots から推定
  const match = mod.matchData || {};
  const homeTeam  = match.homeTeam  || mod.homeTeam  || 'HOME';
  const awayTeam  = match.awayTeam  || mod.awayTeam  || 'AWAY';
  const homeScore = match.homeScore ?? mod.homeScore ?? '-';
  const awayScore = match.awayScore ?? mod.awayScore ?? '-';
  const tournament= match.tournament|| mod.title     || 'MATCH';
  const matchDate = match.matchDate || mod.matchDate || '';
  const goals     = Array.isArray(match.goals) ? match.goals.slice(0, 8) : [];
  const stats     = match.stats || {};
  const subText   = mod.narration || '';

  // スタッツは上位6項目だけ表示
  const statsEntries = Object.entries(stats).slice(0, 6);

  const extraStyles = `
.slide {
  background: ${PALETTE.bg};
  display: flex;
  flex-direction: column;
}
.mc-top {
  height: 100px;
  background: ${PALETTE.surface};
  border-bottom: 4px solid ${PALETTE.accent};
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 60px;
}
.mc-tournament {
  font-size: 32px;
  font-weight: 700;
  color: ${PALETTE.accent};
  letter-spacing: 4px;
  text-transform: uppercase;
}
.mc-date {
  font-size: 26px;
  color: ${PALETTE.muted};
  font-weight: 500;
}
.mc-main {
  flex: 1;
  display: flex;
  padding: 50px 60px 40px;
  gap: 40px;
}
/* スコア表示 */
.mc-score-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 40px;
  padding: 40px 60px;
  background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 20px;
  margin-bottom: 30px;
  width: 100%;
}
.team-block { text-align: center; flex: 1; }
.team-badge-large {
  width: 120px; height: 120px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 36px;
  font-weight: 900;
  letter-spacing: 2px;
  margin: 0 auto 20px;
}
.team-home .team-badge-large {
  background: rgba(79,195,247,0.2);
  border: 3px solid #4fc3f7;
  color: ${PALETTE.text};
}
.team-away .team-badge-large {
  background: rgba(239,83,80,0.2);
  border: 3px solid #ef5350;
  color: ${PALETTE.text};
}
.team-name {
  font-size: 42px;
  font-weight: 800;
  color: ${PALETTE.text};
}
.score-center {
  font-size: 160px;
  font-weight: 900;
  font-family: "Barlow Condensed", sans-serif;
  letter-spacing: 6px;
  color: ${PALETTE.text};
  text-shadow: 0 6px 24px rgba(0,0,0,0.6);
}
.score-sep {
  color: ${PALETTE.muted};
  font-size: 100px;
  margin: 0 8px;
}
/* 下段：得点＋スタッツ */
.mc-bottom {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 30px;
  width: 100%;
}
.mc-goals {
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 16px;
  padding: 24px 30px;
}
.mc-stats {
  background: rgba(0,0,0,0.4);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 16px;
  padding: 24px 30px;
}
.mc-section-title {
  font-size: 24px;
  font-weight: 700;
  color: ${PALETTE.accent};
  letter-spacing: 2px;
  margin-bottom: 16px;
}
.goal-item {
  font-size: 22px;
  color: ${PALETTE.text};
  padding: 6px 0;
  border-bottom: 1px dashed rgba(255,255,255,0.08);
  display: flex; gap: 12px;
}
.goal-time {
  color: ${PALETTE.accent};
  font-weight: 700;
  min-width: 60px;
}
.stat-row {
  display: grid;
  grid-template-columns: 80px 1fr 80px;
  gap: 10px;
  align-items: center;
  padding: 10px 0;
  font-size: 22px;
}
.stat-val-h { color: #4fc3f7; font-weight: 700; text-align: right; }
.stat-val-a { color: #ef5350; font-weight: 700; text-align: left; }
.stat-label {
  text-align: center;
  color: ${PALETTE.muted};
  font-size: 18px;
  text-transform: uppercase;
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
  font-size: 34px;
  font-weight: 800;
  text-align: center;
  padding: 0 60px;
  max-height: 76px;
  overflow: hidden;
}
`;

  const goalsHtml = goals.length
    ? goals.map(g => `<div class="goal-item">
        <span class="goal-time">${esc(g.timeStr || g.time + '\'')}</span>
        <span>${esc(g.player || '不明')} (${esc(g.team || '')})</span>
      </div>`).join('')
    : '<div style="color:#5a6a8a;font-size:20px">得点情報なし</div>';

  const statsHtml = statsEntries.length
    ? statsEntries.map(([k, v]) => `<div class="stat-row">
        <div class="stat-val-h">${esc(v.home || '-')}</div>
        <div class="stat-label">${esc(k)}</div>
        <div class="stat-val-a">${esc(v.away || '-')}</div>
      </div>`).join('')
    : '<div style="color:#5a6a8a;font-size:20px">スタッツなし</div>';

  const slideBody = `
<div class="mc-top">
  <div class="mc-tournament">${esc(tournament)}</div>
  <div class="mc-date">${esc(matchDate || '試合詳細')}</div>
</div>
<div class="mc-main" style="flex-direction:column;align-items:center">
  <div class="mc-score-wrap">
    <div class="team-block team-home">
      <div class="team-badge-large">${esc(homeTeam.slice(0, 3).toUpperCase())}</div>
      <div class="team-name">${esc(homeTeam)}</div>
    </div>
    <div class="score-center">${esc(String(homeScore))}<span class="score-sep">-</span>${esc(String(awayScore))}</div>
    <div class="team-block team-away">
      <div class="team-badge-large">${esc(awayTeam.slice(0, 3).toUpperCase())}</div>
      <div class="team-name">${esc(awayTeam)}</div>
    </div>
  </div>
  <div class="mc-bottom">
    <div class="mc-goals">
      <div class="mc-section-title">⚽ 得点</div>
      ${goalsHtml}
    </div>
    <div class="mc-stats">
      <div class="mc-section-title">📊 スタッツ</div>
      ${statsHtml}
    </div>
  </div>
</div>
${buildSubtitleBar(subText, { height: 90, maxLineLen: 32 })}`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildMatchcenterHTML };
