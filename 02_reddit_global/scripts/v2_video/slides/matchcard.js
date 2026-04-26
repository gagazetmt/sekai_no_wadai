// scripts/v2_video/slides/matchcard.js
// Matchcard スライド (旧 matchcenter)：左 = リーグ/スコア/得点/交代/フォーメーションラベル/スタッツ
//                       右 = ピッチ + 先発11人ドット
// テンプレート元: /match_center_wide.html (1280x720) を transform: scale(1.5) で 1920x1080 化

const {
  PALETTE, esc, wrapHTML, buildSubtitleBar,
  _t, _abbr, _player, _fmtDate,
} = require('./_common');

// 試合データなしフォールバック用 (ジェネリック 4-3-3)
const DEFAULT_LINEUP = [
  { name: 'GK', pos: 'goalkeeper' },
  { name: 'DF', pos: 'defender'   },
  { name: 'DF', pos: 'defender'   },
  { name: 'DF', pos: 'defender'   },
  { name: 'DF', pos: 'defender'   },
  { name: 'MF', pos: 'midfielder' },
  { name: 'MF', pos: 'midfielder' },
  { name: 'MF', pos: 'midfielder' },
  { name: 'FW', pos: 'forward'    },
  { name: 'FW', pos: 'forward'    },
  { name: 'FW', pos: 'forward'    },
];
const DEFAULT_STATS = [
  { label: 'ポゼッション', hv: 50, av: 50, unit: '%' },
  { label: 'シュート',     hv: 0,  av: 0  },
  { label: '枠内シュート', hv: 0,  av: 0  },
  { label: 'コーナー',     hv: 0,  av: 0  },
  { label: 'ファウル',     hv: 0,  av: 0  },
  { label: 'イエロー',     hv: 0,  av: 0  },
];

// SofaScore stats label → 表示日本語ラベル + 単位
const STAT_MAP = [
  ['Ball possession',     'ポゼッション', '%'],
  ['Total shots',         'シュート',     ''],
  ['Shots on target',     '枠内シュート', ''],
  ['Corner kicks',        'コーナー',     ''],
  ['Fouls',               'ファウル',     ''],
  ['Yellow cards',        'イエロー',     ''],
];

function _toInt(v) {
  if (v == null) return 0;
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function buildMatchcardHTML(mod) {
  const md = mod.matchData || {};
  const homeTeamRaw = md.homeTeam  || mod.homeTeam  || 'HOME';
  const awayTeamRaw = md.awayTeam  || mod.awayTeam  || 'AWAY';
  const homeTeam  = _t(homeTeamRaw);
  const awayTeam  = _t(awayTeamRaw);
  const homeLogo  = md.homeLogo || null;
  const awayLogo  = md.awayLogo || null;
  const homeScore = md.homeScore ?? mod.homeScore ?? 0;
  const awayScore = md.awayScore ?? mod.awayScore ?? 0;
  const tournament = _t(md.tournament || mod.title || 'MATCH');
  const matchDate  = md.matchDate || mod.matchDate || '';
  const venue      = _t(md.venue || '');
  const subText    = mod.narration || '';

  // ── イベントを home/away に振り分けてフォーマット（選手名はカタカナ短縮）──
  const _evt = g => `${_player(g.player) || '不明'} ${g.timeStr || (g.time != null ? g.time + "'" : '')}`;
  const homeGoals = (md.goals || []).filter(g => g.isHome).map(_evt);
  const awayGoals = (md.goals || []).filter(g => !g.isHome).map(_evt);
  const homeReds  = (md.cards || []).filter(c => c.isHome && c.color && c.color !== 'イエロー').map(_evt);
  const awayReds  = (md.cards || []).filter(c => !c.isHome && c.color && c.color !== 'イエロー').map(_evt);
  const _sub = s => `${_player(s.playerOut) || '?'} → ${_player(s.playerIn) || '?'} ${s.timeStr || (s.time != null ? s.time + "'" : '')}`;
  const homeSubs  = (md.subs || []).filter(s => s.isHome).map(_sub);
  const awaySubs  = (md.subs || []).filter(s => !s.isHome).map(_sub);

  // ── lineup（先発11人）──選手名をカタカナ短縮
  const _mapLineup = arr => arr.map(p => ({ ...p, name: _player(p.name) }));
  const homeLineup = (md.lineup?.home && md.lineup.home.length) ? _mapLineup(md.lineup.home) : DEFAULT_LINEUP;
  const awayLineup = (md.lineup?.away && md.lineup.away.length) ? _mapLineup(md.lineup.away) : DEFAULT_LINEUP;

  // ── stats を STAT_MAP 順で抽出 ──
  const statsArr = [];
  STAT_MAP.forEach(([key, label, unit]) => {
    const entry = md.stats?.[key];
    if (!entry) return;
    statsArr.push({
      label, unit,
      hv: _toInt(entry.home),
      av: _toInt(entry.away),
    });
  });
  const finalStats = statsArr.length ? statsArr : DEFAULT_STATS;

  // ── status / kickoffText ──
  const hasResult  = (md.scoreline || homeScore !== 0 || awayScore !== 0);
  const status     = hasResult ? '試合終了' : 'プレビュー';
  const scoreTime  = hasResult ? "試合終了 · 90'" : 'キックオフ前';
  const dateJa     = _fmtDate(matchDate);
  const leagueText = tournament || '試合詳細';
  const kickoffText= [dateJa, venue].filter(Boolean).join(' · ') || '';

  // ── データを JS embed ──
  const dataPayload = JSON.stringify({
    matchData: {
      league:    leagueText,
      kickoff:   kickoffText,
      status, scoreTime,
      home: {
        abbr: _abbr(homeTeamRaw),
        name: homeTeam, score: homeScore,
        goals: homeGoals, reds: homeReds, subs: homeSubs,
      },
      away: {
        abbr: _abbr(awayTeamRaw),
        name: awayTeam, score: awayScore,
        goals: awayGoals, reds: awayReds, subs: awaySubs,
      },
    },
    lineups:   { HOME: homeLineup, AWAY: awayLineup },
    statsData: finalStats,
  });

  // ── 1280×640 wrapper を 1.5x スケールで 1920×960 にフィット
  //    残り 1080-960=120px を字幕バーが占める ──
  const extraStyles = `
.slide { background: ${PALETTE.bg}; }
.mc-scale {
  position: absolute; top: 0; left: 0;
  width: 1280px; height: 640px;
  transform-origin: top left;
  transform: scale(1.5);
}
.wrapper {
  width: 1280px; height: 640px;
  display: flex; flex-direction: column; position: relative; overflow: hidden;
  background: ${PALETTE.bg};
  font-family: 'Barlow', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
  color: ${PALETTE.text};
}
.wrapper * { box-sizing: border-box; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
.main {
  flex: 1; display: grid; grid-template-columns: 11fr 10fr;
  overflow: hidden; padding: 6px 16px 8px 16px; gap: 16px; align-items: stretch;
}
.left-col {
  display: flex; flex-direction: column;
  border: 1px solid rgba(255,255,255,0.15); border-radius: 6px;
  overflow: hidden; background: ${PALETTE.surface}; height: auto;
}
.league-info-block {
  display: flex; align-items: center; padding: 8px 24px 0;
  background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);
}
.league-name-row {
  display: flex; align-items: center; gap: 8px;
  font-family: 'Barlow Condensed', sans-serif; font-size: 15px; font-weight: 700;
  color: ${PALETTE.text}; letter-spacing: 0.5px; white-space: nowrap;
}
.league-name-row .dot {
  width: 8px; height: 8px; border-radius: 50%; background: ${PALETTE.accent};
  box-shadow: 0 0 6px ${PALETTE.accent}; animation: pulse 2s ease-in-out infinite; flex-shrink: 0;
}
.kickoff-inline {
  font-family: 'Barlow Condensed', sans-serif; font-size: 15px; font-weight: 400;
  color: ${PALETTE.muted}; letter-spacing: 0.3px; white-space: nowrap; margin-left: 10px;
}
.score-block {
  flex-shrink: 0; padding: 8px 24px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  background: linear-gradient(160deg, ${PALETTE.surface} 0%, ${PALETTE.bg} 100%);
}
.score-row { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; }
.team-info { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
.team-logo {
  width: 70px; height: 70px;
  display: flex; align-items: center; justify-content: center;
}
.team-logo img {
  max-width: 100%; max-height: 100%;
  width: auto; height: auto;
  object-fit: contain;
  display: block;
}
.team-logo-fb {
  font-family: 'Barlow Condensed', sans-serif;
  font-size: 22px; font-weight: 900;
  letter-spacing: 1px;
  width: 70px; height: 70px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15);
  color: ${PALETTE.text};
}
.team-abbr {
  font-family: 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif;
  font-size: 13px; font-weight: 700;
  letter-spacing: 0; text-align: center; line-height: 1.2;
  width: 100%; padding: 0 4px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.team-abbr-home { color: ${PALETTE.blue}; }
.team-abbr-away { color: ${PALETTE.red}; }
.score-center { text-align: center; min-width: 160px; }
.score-nums {
  font-family: 'Barlow Condensed', sans-serif; font-size: 72px; font-weight: 900;
  line-height: 1; letter-spacing: 6px; white-space: nowrap;
}
.s-sep  { color: ${PALETTE.muted}; font-size: 42px; margin: 0 4px; }
.score-time { font-size: 13px; color: ${PALETTE.muted}; letter-spacing: 2px; text-transform: uppercase; margin-top: 4px; font-family: 'Barlow Condensed', sans-serif; }
.goals-row {
  display: flex; justify-content: space-between; margin-top: 4px;
  font-size: 18px; color: ${PALETTE.muted}; line-height: 1.7; gap: 8px;
}
.goals-home { color: ${PALETTE.text}; flex: 1; overflow: hidden; }
.goals-away { text-align: right; color: ${PALETTE.text}; flex: 1; overflow: hidden; }
.goal-item { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.goal-item::before { content: '⚽ '; }
.red-item::before  { content: '🟥 '; }
.red-item { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subs-row {
  flex-shrink: 0; display: flex; justify-content: space-between;
  padding: 3px 20px 8px; font-size: 13px;
  border-bottom: 1px solid rgba(255,255,255,0.08); gap: 8px; line-height: 1.7;
}
.subs-home { color: ${PALETTE.text}; flex: 1; overflow: hidden; }
.subs-away { text-align: right; color: ${PALETTE.text}; flex: 1; overflow: hidden; }
.sub-item { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sub-item::before { content: '🔄 '; }
.formation-row {
  flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;
  padding: 5px 24px; background: rgba(255,255,255,0.05); border-bottom: 1px solid rgba(255,255,255,0.08);
  font-family: 'Barlow Condensed', sans-serif; font-size: 20px; letter-spacing: 0.5px; text-transform: uppercase;
}
.form-home { color: ${PALETTE.text}; font-weight: 700; }
.form-label { color: ${PALETTE.muted}; font-size: 17px; }
.form-away  { color: ${PALETTE.text}; font-weight: 700; }
.stats-block {
  flex: 1; overflow: hidden; padding: 8px 24px 6px;
  display: flex; flex-direction: column; gap: 5px;
}
.right-col {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 4px; overflow: hidden; height: 100%;
}
.pitch-outer {
  position: relative; width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.pitch {
  position: relative;
  height: calc(640px - 8px);
  max-height: calc(640px - 8px);
  width: auto; aspect-ratio: 90 / 100;
  background: #1a4a1e; border-radius: 6px; overflow: hidden;
  box-shadow: 0 4px 32px rgba(0,0,0,0.6);
}
.pitch::before {
  content: ''; position: absolute; inset: 0;
  background: repeating-linear-gradient(to bottom, transparent 0, transparent 7%,
    rgba(0,0,0,0.1) 7%, rgba(0,0,0,0.1) 14%);
}
.pitch-svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.player {
  position: absolute; transform: translate(-50%, -50%);
  display: flex; flex-direction: column; align-items: center; pointer-events: none;
}
.p-dot {
  width: 45px; height: 45px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 800;
  letter-spacing: 0.3px; border: 2px solid rgba(255,255,255,0.85);
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  background-size: cover; background-position: center top; background-repeat: no-repeat;
  overflow: hidden;
}
.p-home .p-dot { background-color: #4fc3f7; color: #0d1117; }
.p-away .p-dot { background-color: #ef5350; color: #fff; }
.p-gk .p-dot   { background-color: #e6a800 !important; color: #0d1117 !important; border-color: rgba(255,255,255,0.95); }
.p-photo .p-dot { color: transparent; }
.p-home.p-photo .p-dot { border-color: #4fc3f7; }
.p-away.p-photo .p-dot { border-color: #ef5350; }
.p-gk.p-photo .p-dot   { border-color: #e6a800 !important; }
.p-name {
  margin-top: 2px; font-size: 13px; font-weight: 600;
  font-family: 'Barlow Condensed', 'Hiragino Kaku Gothic ProN', 'Noto Sans JP', sans-serif; letter-spacing: 0;
  color: #fff; background: rgba(0,0,0,0.65); padding: 1px 4px; border-radius: 2px;
  white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis;
}
@keyframes fadeUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.score-block  { animation: fadeUp 0.5s ease both; }
.formation-row{ animation: fadeUp 0.5s 0.1s ease both; }
.stats-block  { animation: fadeUp 0.5s 0.2s ease both; }
.right-col    { animation: fadeUp 0.5s 0.15s ease both; }
`;

  const slideBody = `
<div class="mc-scale">
<div class="wrapper">
  <div class="main">
    <div class="left-col">
      <div class="league-info-block">
        <div class="league-name-row">
          <span class="dot"></span>
          <span id="league-name">${esc(leagueText)}</span>
          <span class="kickoff-inline" id="kickoff-time">${esc(kickoffText)}</span>
        </div>
      </div>
      <div class="score-block">
        <div class="score-row">
          <div class="team-info">
            <div class="team-logo">${homeLogo ? `<img src="${homeLogo}" alt="">` : `<span class="team-logo-fb">${esc(_abbr(homeTeamRaw))}</span>`}</div>
            <div class="team-abbr team-abbr-home">${esc(homeTeam)}</div>
          </div>
          <div class="score-center">
            <div class="score-nums">
              <span class="s-home" id="score-home">${esc(String(homeScore))}</span>
              <span class="s-sep">–</span>
              <span class="s-away" id="score-away">${esc(String(awayScore))}</span>
            </div>
            <div class="score-time" id="score-time">${esc(scoreTime)}</div>
          </div>
          <div class="team-info">
            <div class="team-logo">${awayLogo ? `<img src="${awayLogo}" alt="">` : `<span class="team-logo-fb">${esc(_abbr(awayTeamRaw))}</span>`}</div>
            <div class="team-abbr team-abbr-away">${esc(awayTeam)}</div>
          </div>
        </div>
        <div class="goals-row">
          <div class="goals-home" id="goals-home"></div>
          <div class="goals-away" id="goals-away"></div>
        </div>
      </div>
      <div class="subs-row">
        <div class="subs-home" id="subs-home"></div>
        <div class="subs-away" id="subs-away"></div>
      </div>
      <div class="formation-row">
        <span class="form-home" id="fl-home">–</span>
        <span class="form-label">フォーメーション</span>
        <span class="form-away" id="fl-away">–</span>
      </div>
      <div class="stats-block">
        <div id="stats-container"></div>
      </div>
    </div>
    <div class="right-col">
      <div class="pitch-outer">
        <div style="display:flex;flex-direction:column;align-items:flex-start;height:100%;justify-content:center;gap:4px;width:100%;">
          <div class="pitch" id="pitch">
            <svg class="pitch-svg" viewBox="14 0 72 154" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="14" y="2"  width="72" height="150" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.7"/>
              <line x1="14" y1="77" x2="86" y2="77" stroke="rgba(255,255,255,0.28)" stroke-width="0.7"/>
              <circle cx="50" cy="77" r="11.5" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="0.7"/>
              <circle cx="50" cy="77" r="0.9" fill="rgba(255,255,255,0.4)"/>
              <rect x="29" y="2"  width="42" height="18" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="0.6"/>
              <rect x="39" y="2"  width="22" height="7.5" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="0.6"/>
              <circle cx="50" cy="13.5" r="0.8" fill="rgba(255,255,255,0.3)"/>
              <rect x="29" y="134" width="42" height="18" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="0.6"/>
              <rect x="39" y="144.5" width="22" height="7.5" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="0.6"/>
              <circle cx="50" cy="140.5" r="0.8" fill="rgba(255,255,255,0.3)"/>
              <rect x="43" y="0.2" width="14" height="2.5" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="0.6"/>
              <rect x="43" y="151.3" width="14" height="2.5" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="0.6"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
${buildSubtitleBar(subText, { height: 120, maxLineLen: 36 })}
<div style="position:absolute;top:0;left:0;width:1920px;height:1080px;border:4px dashed #ff2266;pointer-events:none;z-index:9999;box-sizing:border-box;"></div>
<script>
(function() {
  const PAYLOAD = ${dataPayload};
  const matchData = PAYLOAD.matchData;
  const lineups   = PAYLOAD.lineups;
  const statsData = PAYLOAD.statsData;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function applyMatchData() {
    function buildEvents(d) {
      return (d.goals||[]).map(g => '<div class="goal-item">' + esc(g) + '</div>').join('')
           + (d.reds ||[]).map(r => '<div class="red-item">'  + esc(r) + '</div>').join('');
    }
    document.getElementById('goals-home').innerHTML = buildEvents(matchData.home);
    document.getElementById('goals-away').innerHTML = buildEvents(matchData.away);

    const maxCount = Math.max(
      (matchData.home.goals||[]).length + (matchData.home.reds||[]).length,
      (matchData.away.goals||[]).length + (matchData.away.reds||[]).length
    );
    const gr = document.querySelector('.goals-row');
    if (gr) {
      if (maxCount >= 6)      gr.style.fontSize = '11px';
      else if (maxCount >= 4) gr.style.fontSize = '14px';
    }

    document.getElementById('subs-home').innerHTML =
      (matchData.home.subs||[]).map(s => '<div class="sub-item">' + esc(s) + '</div>').join('');
    document.getElementById('subs-away').innerHTML =
      (matchData.away.subs||[]).map(s => '<div class="sub-item">' + esc(s) + '</div>').join('');
  }

  function detectFormation(players) {
    const def = players.filter(p => p.pos === 'defender').length;
    const mid = players.filter(p => p.pos === 'midfielder').length;
    const fwd = players.filter(p => p.pos === 'forward').length;
    return def + '-' + mid + '-' + fwd;
  }

  function layoutPlayers(players, isHome) {
    const order = ['goalkeeper','defender','midfielder','forward'];
    const yLines = isHome ? [6,17,30,42] : [94,83,70,58];
    const result = [];
    order.forEach((pos, li) => {
      const line = players.filter(p => p.pos === pos);
      line.forEach((pl, i) => {
        const n = line.length;
        const x = n === 1 ? 50 : 10 + (80 / (n - 1)) * i;
        result.push(Object.assign({}, pl, { x: x, y: yLines[li], isHome: isHome }));
      });
    });
    return result;
  }
  function posLabel(pos) { return ({ goalkeeper:'GK', defender:'DF', midfielder:'MF', forward:'FW' })[pos] || ''; }

  // 選手名 文字数 → フォントサイズ調整（8文字以下デフォルト、長いほど縮小）
  function nameFontSize(name) {
    const len = String(name || '').length;
    if (len <= 8)  return null;     // デフォルト 13px
    if (len <= 10) return '12px';
    if (len <= 12) return '11px';
    if (len <= 14) return '10px';
    return '9px';
  }

  function renderPitch() {
    const pitch = document.getElementById('pitch');
    const fh = detectFormation(lineups.HOME);
    const fa = detectFormation(lineups.AWAY);
    document.getElementById('fl-home').textContent = fh;
    document.getElementById('fl-away').textContent = fa;
    [...layoutPlayers(lineups.HOME, true), ...layoutPlayers(lineups.AWAY, false)].forEach(p => {
      const div = document.createElement('div');
      const hasPhoto = !!p.photo;
      div.className = 'player ' + (p.isHome ? 'p-home' : 'p-away')
                    + (p.pos === 'goalkeeper' ? ' p-gk' : '')
                    + (hasPhoto ? ' p-photo' : '');
      div.style.left = p.x + '%';
      div.style.top  = p.y + '%';
      const fz = nameFontSize(p.name);
      const nameStyle = fz ? ' style="font-size:' + fz + '"' : '';
      const dotStyle  = hasPhoto ? ' style="background-image:url(' + p.photo + ')"' : '';
      const dotText   = hasPhoto ? '' : posLabel(p.pos);
      div.innerHTML = '<div class="p-dot"' + dotStyle + '>' + dotText + '</div>'
                    + '<div class="p-name"' + nameStyle + '>' + esc(p.name) + '</div>';
      pitch.appendChild(div);
    });
  }

  function renderStats() {
    const container = document.getElementById('stats-container');
    statsData.forEach(s => {
      const total = s.hv + s.av || 1;
      const hw = (s.hv / total * 100).toFixed(1);
      const aw = (s.av / total * 100).toFixed(1);
      const hDisp = s.hv + (s.unit || '');
      const aDisp = s.av + (s.unit || '');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;width:100%;';
      row.innerHTML =
        '<div style="font-size:24px;min-width:42px;text-align:right;font-family:Barlow Condensed,sans-serif;font-weight:700;color:#fff;">' + hDisp + '</div>'
      + '<div style="width:110px;text-align:center;font-size:17px;color:#94a3b8;flex-shrink:0;">' + esc(s.label) + '</div>'
      + '<div style="flex:1;height:6px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;display:flex;">'
      + '  <div style="width:' + hw + '%;background:linear-gradient(to right,rgba(79,195,247,0.45),#4fc3f7);border-radius:4px 0 0 4px;"></div>'
      + '  <div style="width:' + aw + '%;background:linear-gradient(to left,rgba(239,83,80,0.45),#ef5350);border-radius:0 4px 4px 0;"></div>'
      + '</div>'
      + '<div style="font-size:24px;min-width:42px;text-align:left;font-family:Barlow Condensed,sans-serif;font-weight:700;color:#fff;">' + aDisp + '</div>';
      container.appendChild(row);
    });
  }

  applyMatchData();
  renderPitch();
  renderStats();
})();
</script>`;

  return wrapHTML({ slideBody, extraStyles });
}

module.exports = { buildMatchcardHTML };
