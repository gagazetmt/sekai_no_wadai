// scripts/slide_builder.js
// スライドHTML生成ロジック共有モジュール
// generate_soccer_yt_video_v2.js と soccer_yt_server_v2.js の両方から require される

const fs   = require('fs');
const path = require('path');

const BASE_DIR  = path.join(__dirname, '..');
const LOGOS_DIR = path.join(BASE_DIR, 'logos');

const W = 1920, H = 1080;

const CMT_PRE_DELAY = 2.0;  // ナレーション終了後〜コメント1件目開始までの待機(秒)
const CMT_STEP      = 1.5;  // コメント間隔(秒)

// ─── 共通配色・定数 ───────────────────────────────────────────────────────────
const THEME = {
  bg: '#060e1c',
  accent: '#f59e0b',
  muted: '#6080b0',
  glassBg: 'linear-gradient(135deg, rgba(255,255,255,0.045), rgba(255,255,255,0.018))',
  glassBorder: '1px solid rgba(255,255,255,0.10)',
};

// ─── ユーティリティ ───────────────────────────────────────────────────────────
const esc     = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const escLine = s => esc(String(s || '').replace(/\\n/g, '\n')).replace(/\n/g, '<br>');

function resolveImgPath(imgPath) {
  if (!imgPath) return null;
  if (imgPath.startsWith('/images/')) {
    return path.join(BASE_DIR, imgPath.replace(/\//g, path.sep));
  }
  return imgPath;
}

function imgBase64(imgPath) {
  const resolved = resolveImgPath(imgPath);
  if (!resolved || !fs.existsSync(resolved)) return { b64: null, mime: 'image/jpeg' };
  const ext  = path.extname(resolved).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
  return { b64: fs.readFileSync(resolved).toString('base64'), mime };
}

function getImageSize(imgPath) {
  const resolved = resolveImgPath(imgPath);
  if (!resolved || !fs.existsSync(resolved)) return null;
  try {
    const buf = fs.readFileSync(resolved);
    const ext = path.extname(imgPath).toLowerCase();
    if (ext === '.png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) break;
      const m = buf[i + 1];
      if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(m))
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch (_) {}
  return null;
}

function imgMeta(imgPath) {
  const { b64, mime } = imgBase64(imgPath);
  const size = getImageSize(imgPath);
  return { b64, mime, isPortrait: size ? size.height > size.width : false };
}

function splitSubText(text) {
  const str = (text || '').trim();
  if (!str) return [str];

  const cw = s => [...s].reduce((n, c) => n + (/[\u3040-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(c) ? 2 : 1), 0);
  const total = cw(str);
  if (total <= 28) return [str];

  const MIN_HALF = 12;
  const target = total / 2;
  let bestIdx = -1, bestScore = Infinity;

  const PRIO = { '。': 0, '！': 0, '？': 0, '、': 1, '，': 1, ' ': 2, '　': 2 };

  let w = 0;
  for (let idx = 0; idx < str.length; idx++) {
    const c = str[idx];
    w += /[\u3040-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(c) ? 2 : 1;
    if (!(c in PRIO)) continue;
    const rem = total - w;
    if (w < MIN_HALF || rem < MIN_HALF) continue;
    const score = Math.abs(w - target) + PRIO[c] * 4;
    if (score < bestScore) { bestScore = score; bestIdx = idx + 1; }
  }

  if (bestIdx > 0) {
    const a = str.slice(0, bestIdx).trim();
    const b = str.slice(bestIdx).trim();
    if (a && b) {
      const aParts = cw(a) > 36 ? splitSubText(a) : [a];
      const bParts = cw(b) > 36 ? splitSubText(b) : [b];
      return [...aParts, ...bParts];
    }
  }
  return [str];
}

function logoHtml(teamName, size = 100) {
  const TEAM_LOGOS = (() => {
    try { const { _comment, ...m } = JSON.parse(fs.readFileSync(path.join(LOGOS_DIR, 'team_logos.json'), 'utf8')); return m; } catch { return {}; }
  })();
  const file = TEAM_LOGOS[teamName];
  if (file) {
    const lp = path.join(LOGOS_DIR, file);
    if (fs.existsSync(lp)) {
      const { b64, mime } = imgBase64(lp);
      if (b64) return `<img src="data:${mime};base64,${b64}" style="width:${size}px;height:${size}px;object-fit:contain;filter:drop-shadow(0 2px 8px rgba(0,0,0,0.5));">`;
    }
  }
  const initials = (teamName || '?').replace(/[^A-Za-z ]/g, '').trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 3) || '?';
  const hue = [...(teamName || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,hsl(${hue},60%,35%),hsl(${hue},60%,20%));border:3px solid rgba(255,255,255,0.25);color:#fff;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.27)}px;font-weight:900;flex-shrink:0;">${initials}</div>`;
}

// ─── 共通CSS ──────────────────────────────────────────────────────────────────
const COMMON_CSS = `
  *{margin:0;padding:0;box-sizing:border-box;}
  body{width:${W}px;height:${H}px;overflow:hidden;
    font-family:"Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic",sans-serif;}
  .bg{width:${W}px;height:${H}px;position:relative;overflow:hidden;}
  @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
  @keyframes slideUp{from{opacity:0;transform:translateY(30px)}to{opacity:1;transform:translateY(0)}}
  @keyframes kbZoom{from{transform:scale(1.0) translate(-2%,0)}to{transform:scale(1.1) translate(2%,0)}}
  @keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}
  @keyframes fadeIn{from{opacity:0}to{opacity:1}}
  @keyframes fadeOut{to{opacity:0}}
  @keyframes subFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
`;

// ─── 字幕オーバーレイ ─────────────────────────────────────────────────────────
function buildSubtitleHtml(text, narrDurSec, startDelaySec) {
  if (!text) return '';
  const parts = splitSubText(text);

  const groups = [];
  for (let i = 0; i < parts.length; i += 2) groups.push(parts.slice(i, i + 2));

  const n = groups.length;
  let t = startDelaySec;

  const groupsHtml = groups.map((grp, gi) => {
    const fi   = t.toFixed(2);
    t += narrDurSec / n;
    const isLast = gi === n - 1;
    const fo     = isLast ? '' : `,fadeOut 0.25s ${(t - 0.3).toFixed(2)}s ease-out forwards`;
    const lines  = grp.map((p, li) =>
      `<div class="s-l" style="animation-delay:${(li * 0.18).toFixed(2)}s">${esc(p)}</div>`
    ).join('');
    return `<div class="s-g" style="animation:subFadeIn 0.3s ${fi}s ease-out both${fo}">${lines}</div>`;
  }).join('');

  return `
    <div style="position:fixed;bottom:0;left:0;right:0;height:172px;overflow:hidden;
      background:rgba(0,0,0,0.90);border-top:3px solid rgba(245,158,11,0.55);
      z-index:9999;pointer-events:none;">
      ${groupsHtml}
    </div>
    <style>
      .s-g{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
        justify-content:center;gap:6px;padding:10px 80px;opacity:0;}
      .s-l{color:#fff;font-size:46px;font-weight:800;text-align:center;
        line-height:1.35;overflow:hidden;max-height:66px;width:100%;
        opacity:0;animation:subFadeIn 0.25s ease-out both;}
    </style>`;
}

// ─── 背景スタイル共通生成 ─────────────────────────────────────────────────────
function bgCss(b64, mime, isPortrait, zoom = 1.0, x = 50, y = 50) {
  if (!b64) return `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;
  if (isPortrait)
    return `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`;
  return `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:${x}% ${y}%;`;
}

// ─────────────────────────────────────────────────────────────────────────────
// スライドビルダー群
// ─────────────────────────────────────────────────────────────────────────────

function buildOpening(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime, isPortrait } = imgMeta(imgPath);
  const bgStyle = bgCss(b64, mime, isPortrait);
  const animCss = isPortrait
    ? `.bg-img{position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;}`
    : `.bg-img{position:absolute;inset:0;${bgStyle}animation:kbZoom 25s linear forwards;transform-origin:50% 50%;}`;
  const title = mod.catchLine || post.youtubeTitle || mod.label || '';
  const label = mod.label || '【速報】';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS} ${animCss}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.22);}
  .title-area{position:absolute;bottom:140px;left:0;right:0;display:flex;flex-direction:column;align-items:flex-start;gap:16px;}
  .badge{display:inline-block;font-size:38px;font-weight:900;padding:4px 24px;border-radius:6px;
    background:rgba(200,0,0,0.92);color:#fff;margin-left:60px;animation:fadeUp 0.4s ease-out both;}
  .title-main{color:#fff;font-size:76px;font-weight:900;line-height:1.35;
    background:rgba(0,0,0,0.65);padding:40px 60px;width:100%;overflow-wrap:break-word;
    animation:fadeUp 0.5s 0.5s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="title-area">
      <div class="badge">${esc(label)}</div>
      <div class="title-main">${escLine(title)}</div>
    </div>
  </div></body></html>`;
}

function buildReaction(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime, isPortrait } = imgMeta(imgPath);

  const CMT_BG    = ['#FFF9C4', '#C8EEFF', '#D4F5D4', '#EDD5FF', '#FFE8CC', '#FFD5EA'];
  const CMT_BG_HL = ['#FFD700', '#5BB8F5', '#5ED45E', '#B86FFF', '#FF9F43', '#FF70A6'];
  const highlightIdx = mod.highlightIdx !== undefined ? Number(mod.highlightIdx) : 0;

  const comments = (mod.keyPoints || []).slice(0, 6);
  const cmtBase = startDelaySec + narrDurSec + CMT_PRE_DELAY;

  const bgStyle = b64
    ? isPortrait
      ? `background-image:url('data:${mime};base64,${b64}');background-size:100% auto;background-position:50% 0%;`
      : `background-image:url('data:${mime};base64,${b64}');background-size:cover;background-position:50% 50%;`
    : `background:linear-gradient(135deg,#0a1520,#1a2a3a);`;
  const kbAnim = isPortrait
    ? `@keyframes panDown{from{background-position:50% 0%}to{background-position:50% 100%}}`
    : `@keyframes kbZoom{from{transform:scale(1.0) translate(-2%,0)}to{transform:scale(1.08) translate(2%,0)}}`;
  const bgImgCss = isPortrait
    ? `position:absolute;inset:0;${bgStyle}animation:panDown 39s linear forwards;`
    : `position:absolute;inset:0;${bgStyle}animation:kbZoom 25s linear forwards;transform-origin:50% 50%;`;

  const FONT_SIZE = 48;
  const SAFE_PX   = 60;
  const AREA_TOP  = SAFE_PX + 60;
  const AREA_BOT  = 115;

  const commentsHtml = comments.map((c, i) => {
    const text  = typeof c === 'string' ? c : (c.text || '');
    const isHL  = i === highlightIdx;
    const side  = i % 2 === 0 ? 'flex-start' : 'flex-end';
    const bg    = isHL ? CMT_BG_HL[i % CMT_BG_HL.length] : CMT_BG[i % CMT_BG.length];
    const delay = (cmtBase + i * CMT_STEP).toFixed(2);
    return `<div class="c-card${isHL ? ' c-hl' : ''}"
      style="align-self:${side};background:${bg};animation:slideDown 0.45s ${delay}s ease-out both;">
      <div class="c-text">${esc(text).replace(/\n/g, '<br>')}</div>
    </div>`;
  }).join('');

  const narrText = mod.narration || '';
  const subFadeOutAt = (startDelaySec + narrDurSec + CMT_PRE_DELAY).toFixed(2);
  const rParts  = splitSubText(narrText);
  const rGroups = [];
  for (let k = 0; k < rParts.length; k += 2) rGroups.push(rParts.slice(k, k + 2));
  const rN = rGroups.length;
  let rT = startDelaySec;
  const subPartsHtml = rGroups.map((grp, gi) => {
    const fi   = rT.toFixed(2);
    rT += narrDurSec / rN;
    const isLast = gi === rN - 1;
    const fo     = isLast ? '' : `,subPtFO 0.25s ${(rT - 0.3).toFixed(2)}s ease-out forwards`;
    const lines  = grp.map((p, li) =>
      `<div class="sp" style="animation-delay:${(li * 0.18).toFixed(2)}s">${esc(p)}</div>`
    ).join('');
    return `<div class="rg" style="animation:subPtFI 0.3s ${fi}s ease-out both${fo}">${lines}</div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  ${kbAnim}
  .bg-img{${bgImgCss}}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.15);}
  .comments-area{
    position:absolute;top:${AREA_TOP}px;bottom:${AREA_BOT}px;
    left:${SAFE_PX}px;right:${SAFE_PX}px;
    display:flex;flex-direction:column;justify-content:flex-start;gap:18px;}
  .c-card{border:3px solid #000;border-radius:8px;padding:10px 18px;
    width:fit-content;max-width:90%;opacity:0;}
  .c-hl{border:4px solid #000;}
  .c-text{color:#111;font-size:${FONT_SIZE}px;font-weight:700;line-height:1.4;overflow-wrap:break-word;}
  .c-hl .c-text{color:#000;font-weight:900;}
  @keyframes slideDown{from{opacity:0;transform:translateY(-18px)}to{opacity:1;transform:translateY(0)}}
  @keyframes subBO{to{opacity:0;visibility:hidden;}}
  @keyframes subPtFI{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
  @keyframes subPtFO{to{opacity:0}}
  .sub-box{
    position:absolute;bottom:0;left:0;right:0;height:172px;overflow:hidden;
    background:rgba(0,0,0,0.88);border-top:1px solid rgba(255,255,255,0.08);
    animation:slideUp 0.6s 0s ease-out both, subBO 0.3s ${subFadeOutAt}s ease-out forwards;}
  .rg{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:6px;padding:10px 80px;opacity:0;}
  .sp{color:#fff;font-size:44px;font-weight:800;text-align:center;
    line-height:1.35;overflow:hidden;max-height:64px;width:100%;
    opacity:0;animation:subPtFI 0.25s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div>
    <div class="overlay"></div>
    <div class="comments-area">${commentsHtml}</div>
    ${narrText ? `<div class="sub-box">${subPartsHtml}</div>` : ''}
  </div></body></html>`;
}

function buildMatchCenter(mod, post, narrDurSec, startDelaySec) {
  const mcPath = path.join(BASE_DIR, 'match_center_wide.html');
  if (!fs.existsSync(mcPath)) {
    console.warn('⚠️  match_center_wide.html が見つかりません。simpleにフォールバック');
    return buildInsight(mod, post, narrDurSec, startDelaySec);
  }

  let html = fs.readFileSync(mcPath, 'utf8');

  // topbar 削除 + ダークテーマ注入
  html = html.replace(/<div class="topbar"[\s\S]*?<\/div>\s*/, '');
  const _darkCss = `<style id="dark-fix">:root{--bg:#011e2a;--surface:#012c36;--surface2:#1a3a50;--border:rgba(255,255,255,0.12);--text:#e0e8ff;--muted:#8090b0;}body{background:#011e2a;}.main{padding-bottom:148px!important;}</style>`;
  html = html.replace('</head>', _darkCss + '</head>');

  const fd = mod.fetchedData || {};
  const homeGoals = [], awayGoals = [], homeReds = [], awayReds = [];
  (fd.goals || []).forEach(g => {
    const str = `${g.timeStr} ${g.player}${g.type !== '通常' ? ` [${g.type}]` : ''}`;
    (g.isHome ? homeGoals : awayGoals).push(str);
  });
  (fd.cards || []).forEach(c => {
    if (c.color.includes('退場') || c.color === 'レッド') {
      const str = `${c.timeStr} ${c.player}`;
      (c.isHome ? homeReds : awayReds).push(str);
    }
  });

  const statsRows = mod.statsRows || [];
  const statsData = statsRows
    .filter(r => r.label && r.value != null)
    .map(r => {
      const parts = String(r.value).split(/[-–]/);
      return { label: r.label, hv: parseInt(parts[0]) || 0, av: parseInt(parts[1]) || 0 };
    });

  const matchObj = {
    league:    fd.tournament || mod.label || 'UEFA Champions League',
    kickoff:   fd.matchDate  ? `${fd.matchDate.replace(/-/g,'年').replace(/-/,'月')}日` : '試合日',
    status:    '試合終了',
    scoreTime: `試合終了 · 90'`,
    home: {
      abbr:  (fd.homeTeam || 'HOM').replace(/[^A-Za-z]/g,'').slice(0,3).toUpperCase() || 'HOM',
      name:  fd.homeTeam  || 'ホーム',
      score: fd.homeScore ?? 0,
      goals: homeGoals,
      reds:  homeReds,
      subs:  [],
    },
    away: {
      abbr:  (fd.awayTeam || 'AWY').replace(/[^A-Za-z]/g,'').slice(0,3).toUpperCase() || 'AWY',
      name:  fd.awayTeam  || 'アウェイ',
      score: fd.awayScore ?? 0,
      goals: awayGoals,
      reds:  awayReds,
      subs:  [],
    },
  };

  html = html.replace(
    /const matchData\s*=\s*\{[\s\S]*?\};(?=\s*\n)/,
    `const matchData = ${JSON.stringify(matchObj, null, 2)};`
  );
  if (statsData.length) {
    html = html.replace(
      /const statsData\s*=\s*\[[\s\S]*?\];(?=\s*\n)/,
      `const statsData = ${JSON.stringify(statsData)};`
    );
  }

  const SCALE = 1920 / 1280;
  html = html.replace(
    'html, body {',
    `html, body { width:${W}px !important; height:${H}px !important;`
  );
  html = html.replace(
    /width:\s*1280px;\s*height:\s*720px;/g,
    `width:${W}px; height:${H}px;`
  );
  html = html.replace(
    '.wrapper {',
    `.wrapper { transform:scale(${SCALE}); transform-origin:top left; width:1280px !important; height:720px !important;`
  );
  html = html.replace(
    /width:\s*1280px;\s*height:\s*720px;[\s\S]{0,20}overflow:\s*hidden;[\s\S]{0,20}background:/,
    m => m
  );

  const subtitle = buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    + `<style>.sub-line{position:fixed !important;inset:0;display:flex;align-items:center;
        justify-content:center;padding:16px 80px;
        color:#fff;font-size:50px;font-weight:800;text-align:center;
        line-height:1.5;overflow-wrap:break-word;opacity:0;z-index:10001;}
      @keyframes subFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      @keyframes fadeOut{to{opacity:0}}</style>`;
  html = html.replace('</body>', subtitle + '</body>');

  return html;
}

function buildType1(mod, post, narrDurSec, startDelaySec) {
  const imgPath  = mod.imagePath  || post.mainImagePath;
  const { b64, mime } = imgMeta(imgPath);
  const imgSrc   = b64 ? `data:${mime};base64,${b64}` : '';

  const { b64: b2, mime: m2 } = imgMeta(mod.imagePath2);
  const { b64: b3, mime: m3 } = imgMeta(mod.imagePath3);
  const imgSrc2  = b2 ? `data:${m2};base64,${b2}` : '';
  const imgSrc3  = b3 ? `data:${m3};base64,${b3}` : '';

  const rows  = (mod.statsRows || []).slice(0, 6);
  const title = mod.label || '';

  const rowsHtml = rows.map(r =>
    `<div class="data-row">
      <div class="data-label">${esc(r.label || '')}</div>
      <div class="data-value">${esc(r.value || '—')}</div>
    </div>`
  ).join('');

  let rightTopContent;
  if (imgSrc2 && imgSrc3) {
    rightTopContent = `
      <div class="rt-cell"><img src="${imgSrc2}" alt=""></div>
      <div class="rt-cell" style="border-right:none"><img src="${imgSrc3}" alt=""></div>`;
  } else if (imgSrc2) {
    rightTopContent = `<div class="rt-cell" style="border-right:none;flex:1"><img src="${imgSrc2}" alt=""></div>`;
  } else {
    rightTopContent = `<div class="rt-cell" style="border-right:none;flex:1;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.05);font-size:48px;">📷</div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  body{background:${THEME.bg};}
  .slide-wrap{width:${W}px;height:${H}px;display:flex;position:relative;}
  .left-col{width:42%;height:100%;display:flex;flex-direction:column;padding:48px;gap:32px;}
  .left-top{height:160px;font-size:64px;font-weight:900;color:#fff;border-left:12px solid ${THEME.accent};
    padding-left:32px;display:flex;align-items:center;
    background:linear-gradient(to right, rgba(245,158,11,0.1), transparent);
    animation:fadeUp 0.4s ease-out both;}
  .left-img{flex:1;border:1px solid rgba(255,255,255,0.1);border-radius:24px;overflow:hidden;
    background:rgba(0,0,0,0.2);display:flex;justify-content:center;align-items:center;}
  .left-img img{width:100%;height:100%;object-fit:cover;}
  
  .right-col{width:58%;height:100%;display:flex;flex-direction:column;padding:48px 48px 172px 12px;gap:24px;}
  .right-top{height:35%;display:flex;gap:24px;}
  .rt-cell{flex:1;border:1px solid rgba(255,255,255,0.1);border-radius:16px;overflow:hidden;background:rgba(0,0,0,0.2);}
  .rt-cell img{width:100%;height:100%;object-fit:cover;}
  
  .data-rows{flex:1;display:flex;flex-direction:column;gap:12px;}
  .data-row{flex:1;display:flex;gap:16px;animation:fadeUp 0.3s ease-out both;}
  .data-label{width:35%;background:rgba(0,0,0,0.3);border-left:6px solid ${THEME.accent};border-radius:8px;
    display:flex;align-items:center;padding-left:24px;font-size:24px;font-weight:700;color:${THEME.muted};}
  .data-value{flex:1;background:${THEME.glassBg};border:${THEME.glassBorder};border-radius:12px;
    display:flex;align-items:center;padding-left:32px;font-size:42px;font-weight:900;color:#fff;}
  </style></head><body>
  <div class="slide-wrap">
    <div class="left-col">
      <div class="left-top">${escLine(title)}</div>
      <div class="left-img">${imgSrc ? `<img src="${imgSrc}">` : ''}</div>
    </div>
    <div class="right-col">
      <div class="right-top">${rightTopContent}</div>
      <div class="data-rows">${rowsHtml}</div>
    </div>
  </div>
  ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </body></html>`;
}

function buildType2(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime } = imgMeta(imgPath);
  const imgSrc  = b64 ? `data:${mime};base64,${b64}` : '';
  const rows    = (mod.statsRows || []).slice(0, 5);
  const title   = mod.label || '';

  const rowsHtml = rows.map((r, i) =>
    `<div class="data-row" style="animation-delay:${(i * 0.1).toFixed(1)}s">
      <div class="data-label">${esc(r.label || '')}</div>
      <div class="data-value">${esc(r.value || '—')}</div>
    </div>`
  ).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  body{background:${THEME.bg};}
  .slide-wrap{width:${W}px;height:${H}px;display:flex;position:relative;}
  .left-col{width:50%;height:100%;display:flex;flex-direction:column;padding:64px 24px 172px 64px;gap:20px;}
  .data-rows{flex:1;display:flex;flex-direction:column;gap:16px;}
  .data-row{flex:1;display:flex;gap:16px;animation:fadeUp 0.3s ease-out both;}
  .data-label{width:30%;background:rgba(0,0,0,0.3);border-left:8px solid ${THEME.accent};border-radius:8px;
    display:flex;align-items:center;padding-left:24px;font-size:28px;font-weight:700;color:${THEME.muted};}
  .data-value{flex:1;background:${THEME.glassBg};border:${THEME.glassBorder};border-radius:12px;
    display:flex;align-items:center;padding-left:32px;font-size:48px;font-weight:900;color:#fff;}
  
  .right-col{width:50%;height:100%;display:flex;flex-direction:column;padding:64px 64px 172px 24px;gap:32px;}
  .right-top{height:140px;font-size:64px;font-weight:900;color:#fff;border-left:12px solid ${THEME.accent};
    padding-left:32px;display:flex;align-items:center;
    background:linear-gradient(to right, rgba(245,158,11,0.1), transparent);
    animation:fadeUp 0.4s ease-out both;}
  .right-img{flex:1;border:1px solid rgba(255,255,255,0.1);border-radius:24px;overflow:hidden;
    background:rgba(0,0,0,0.2);display:flex;justify-content:center;align-items:center;}
  .right-img img{width:100%;height:100%;object-fit:cover;}
  </style></head><body>
  <div class="slide-wrap">
    <div class="left-col">
      <div class="data-rows">${rowsHtml}</div>
    </div>
    <div class="right-col">
      <div class="right-top">${escLine(title)}</div>
      <div class="right-img">${imgSrc ? `<img src="${imgSrc}">` : ''}</div>
    </div>
  </div>
  ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </body></html>`;
}

function buildType3(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime } = imgMeta(imgPath);
  const bgDataUrl = b64 ? `data:${mime};base64,${b64}` : '';
  
  const rows  = mod.statsRows || [];
  const title = mod.label || '';
  const subTitle = post.youtubeTitle || '';

  const cardsHtml = rows.slice(0, 5).map((r, i) => {
    const isHero = i === 0;
    const accent = THEME.accent;
    return `
      <div class="data-card ${isHero ? 'hero' : ''}" style="--accent:${accent}; animation-delay:${(i*0.15).toFixed(2)}s">
        <div class="card-label">${esc(r.label)}</div>
        <div class="card-value">${esc(r.value)}</div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  body{background:#111;}
  .bg-img{position:absolute;inset:0;background-image:url('${bgDataUrl}');background-size:cover;background-position:center top;animation:kbZoom 30s linear forwards;}
  .img-fade{position:absolute;inset:0;background:linear-gradient(to right, transparent 0%, transparent 40%, ${THEME.bg} 85%, ${THEME.bg} 100%);}
  .img-vfade{position:absolute;inset:0;background:linear-gradient(to bottom, rgba(6,14,28,0.8) 0%, transparent 15%, transparent 80%, rgba(6,14,28,0.9) 100%);}

  .slide-content{position:absolute;inset:0;display:flex;}
  .panel-img{width:40%;height:100%;position:relative;}
  .img-name{position:absolute;bottom:200px;left:60px;right:40px;animation:fadeUp 0.6s 0.3s ease-out both;}
  .player-name{font-size:80px;font-weight:900;color:#fff;text-shadow:0 4px 20px rgba(0,0,0,0.8);line-height:1.1;}
  .player-sub{font-size:32px;font-weight:700;color:${THEME.accent};margin-top:12px;text-shadow:0 2px 10px rgba(0,0,0,0.5);}

  .panel-data{width:60%;height:100%;display:flex;flex-direction:column;padding:120px 60px 200px 20px;gap:20px;justify-content:center;}
  .card-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
  .data-card{background:${THEME.glassBg};border:${THEME.glassBorder};border-radius:20px;padding:32px;
    display:flex;flex-direction:column;justify-content:center;gap:8px;position:relative;overflow:hidden;
    animation:fadeUp 0.5s ease-out both;opacity:0;}
  .data-card::before{content:'';position:absolute;top:0;left:0;width:6px;height:100%;background:var(--accent);border-radius:4px;}
  .card-label{font-size:24px;font-weight:700;color:${THEME.muted};text-transform:uppercase;letter-spacing:1px;}
  .card-value{font-size:64px;font-weight:900;color:#fff;line-height:1;letter-spacing:-1px;}
  .data-card.hero{grid-column:1/-1;padding:40px;background:linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05));border-color:rgba(245,158,11,0.3);}
  .data-card.hero .card-value{font-size:110px;color:${THEME.accent};}
  .data-card.hero .card-label{font-size:32px;}
  
  .top-banner{position:absolute;top:0;left:0;right:0;height:100px;background:rgba(0,0,0,0.7);border-bottom:4px solid ${THEME.accent};
    display:flex;align-items:center;padding:0 60px;gap:20px;z-index:10;}
  .banner-title{color:#fff;font-size:40px;font-weight:900;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="img-fade"></div><div class="img-vfade"></div>
    <div class="top-banner"><div class="banner-title">${esc(title)}</div></div>
    <div class="slide-content">
      <div class="panel-img">
        <div class="img-name">
          <div class="player-name">${esc(mod.params?.playerNameEn || title)}</div>
          <div class="player-sub">${esc(subTitle)}</div>
        </div>
      </div>
      <div class="panel-data"><div class="card-grid">${cardsHtml}</div></div>
    </div>
    ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </div></body></html>`;
}

function buildType4(mod, post, narrDurSec, startDelaySec) {
  const imgL  = mod.imagePath  || post.mainImagePath;
  const imgR  = mod.imagePath2 || mod.imagePath;
  const { b64: bL, mime: mL } = imgMeta(imgL);
  const { b64: bR, mime: mR } = imgMeta(imgR);
  const imgSrcL = bL ? `data:${mL};base64,${bL}` : '';
  const imgSrcR = bR ? `data:${mR};base64,${bR}` : '';
  
  const rows  = (mod.statsRows || []).slice(0, 6);
  const title = mod.label || 'COMPARISON';

  const rowsHtml = rows.map((r, i) => {
    const parts = String(r.value || '0 - 0').split(/[-–/]/);
    const v1Str = (parts[0] || '0').trim();
    const v2Str = (parts[1] || '0').trim();
    const v1 = parseFloat(v1Str) || 0;
    const v2 = parseFloat(v2Str) || 0;
    const total = v1 + v2 || 1;
    const p1 = Math.min(100, Math.max(0, (v1 / total) * 100));
    const p2 = Math.min(100, Math.max(0, (v2 / total) * 100));
    
    const isL = v1 > v2;
    const isR = v2 > v1;
    
    return `
      <div class="data-row" style="animation-delay:${(i*0.1).toFixed(2)}s">
        <div class="row-main">
          <div class="v-cell v-l ${isL ? 'win' : ''}">${esc(v1Str)}</div>
          <div class="v-cell v-c">${esc(r.label)}</div>
          <div class="v-cell v-r ${isR ? 'win' : ''}">${esc(v2Str)}</div>
        </div>
        <div class="row-bar">
          <div class="bar-fill l" style="width:${p1/2}%"></div>
          <div class="bar-fill r" style="width:${p2/2}%"></div>
        </div>
      </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  body { background: #060e1c; color: #fff; }
  
  .slide-main { display: flex; width: 100%; height: 100%; }
  
  /* 三等分割カラム */
  .col { width: 33.33%; height: 100%; position: relative; overflow: hidden; }
  
  /* 左右画像 */
  .bg-img { position: absolute; inset: 0; background-size: cover; background-position: center top; filter: brightness(0.7); }
  .overlay-l { position: absolute; inset: 0; background: linear-gradient(to right, rgba(6,14,28,0.2), #060e1c); }
  .overlay-r { position: absolute; inset: 0; background: linear-gradient(to left, rgba(6,14,28,0.2), #060e1c); }
  
  .name-box { position: absolute; bottom: 180px; width: 100%; text-align: center; z-index: 5; }
  .p-name { font-size: 54px; font-weight: 900; text-shadow: 0 4px 20px rgba(0,0,0,0.8); }
  .p-team { font-size: 24px; font-weight: 700; color: ${THEME.accent}; margin-top: 8px; }

  /* 中央データエリア */
  .col-center { display: flex; flex-direction: column; padding: 100px 0 172px; z-index: 10; background: #060e1c; }
  .title-banner { height: 80px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.4); border-bottom: 3px solid ${THEME.accent}; margin-bottom: 20px; }
  .title-text { font-size: 32px; font-weight: 800; color: ${THEME.accent}; letter-spacing: 4px; }

  .data-list { flex: 1; display: flex; flex-direction: column; justify-content: space-around; }
  .data-row { display: flex; flex-direction: column; padding: 10px 0; animation: fadeUp 0.5s ease-out both; opacity: 0; }
  
  /* 行内三等分割 */
  .row-main { display: flex; width: 100%; align-items: center; }
  .v-cell { width: 33.33%; text-align: center; }
  .v-l, .v-r { font-size: 64px; font-weight: 900; color: rgba(255,255,255,0.4); transition: 0.3s; }
  .v-c { font-size: 20px; font-weight: 700; color: ${THEME.muted}; text-transform: uppercase; letter-spacing: 2px; }
  .win { color: #fff; font-size: 80px; text-shadow: 0 0 20px rgba(245,158,11,0.3); }

  /* 下部のバー表示 */
  .row-bar { display: flex; justify-content: center; height: 6px; margin-top: 8px; width: 80%; margin-left: 10%; background: rgba(255,255,255,0.05); border-radius: 3px; position: relative; overflow: hidden; }
  .bar-fill { height: 100%; position: absolute; top: 0; }
  .bar-fill.l { right: 50%; background: linear-gradient(to left, #3b82f6, #1d4ed8); border-radius: 3px 0 0 3px; }
  .bar-fill.r { left: 50%; background: linear-gradient(to right, #ef4444, #b91c1c); border-radius: 0 3px 3px 0; }

  .vs-tag { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 120px; font-weight: 900; color: rgba(245,158,11,0.05); z-index: 1; pointer-events: none; }
  </style></head><body>
  <div class="bg">
    <div class="slide-main">
      <!-- 左カラム -->
      <div class="col">
        <div class="bg-img" style="background-image:url('${imgSrcL}')"></div>
        <div class="overlay-l"></div>
        <div class="name-box">
          <div class="p-name">${esc(mod.params?.homeTeam || 'PLAYER A')}</div>
          <div class="p-team">CONTENDER</div>
        </div>
      </div>

      <!-- 中央カラム -->
      <div class="col col-center">
        <div class="title-banner"><div class="title-text">${esc(title)}</div></div>
        <div class="data-list">${rowsHtml}</div>
        <div class="vs-tag">VS</div>
      </div>

      <!-- 右カラム -->
      <div class="col">
        <div class="bg-img" style="background-image:url('${imgSrcR}')"></div>
        <div class="overlay-r"></div>
        <div class="name-box">
          <div class="p-name">${esc(mod.params?.awayTeam || 'PLAYER B')}</div>
          <div class="p-team">CHALLENGER</div>
        </div>
      </div>
    </div>
    ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </div></body></html>`;
}

function buildInsight(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime } = imgMeta(imgPath);
  const bgDataUrl = b64 ? `data:${mime};base64,${b64}` : '';
  const kp = mod.keyPoints || [];

  const CARD_STYLES = [
    { border: '#f59e0b', bg: 'rgba(245,158,11,0.12)', fontSize: '50px', fontWeight: '900', color: '#fff' },
    { border: '#3b82f6', bg: 'rgba(59,130,246,0.10)', fontSize: '38px', fontWeight: '800', color: '#e0eeff' },
    { border: '#22c55e', bg: 'rgba(34,197,94,0.10)',  fontSize: '38px', fontWeight: '800', color: '#e0ffe8' },
    { border: '#a78bfa', bg: 'rgba(167,139,250,0.10)',fontSize: '38px', fontWeight: '800', color: '#ede8ff' },
  ];

  const cardsHtml = kp.slice(0, 4).map((text, i) => {
    const s = CARD_STYLES[i] || CARD_STYLES[1];
    const delay = (0.2 + i * 0.25).toFixed(2);
    return `<div class="insight-card" style="
      border-left:6px solid ${s.border};
      background:${s.bg};
      font-size:${s.fontSize};
      font-weight:${s.fontWeight};
      color:${s.color};
      animation-delay:${delay}s;">
      ${escLine(text)}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  .bg-img{position:absolute;inset:0;
    ${bgDataUrl ? `background-image:url('${bgDataUrl}');background-size:cover;background-position:50%;` : 'background:#050a12;'}
    animation:kbZoom 25s linear forwards;}
  .overlay{position:absolute;inset:0;background:linear-gradient(135deg,rgba(5,10,18,0.90) 0%,rgba(10,20,40,0.82) 100%);}
  .cards-wrap{position:absolute;top:0;left:0;right:0;bottom:132px;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:24px;padding:60px 240px;}
  .insight-card{
    width:100%;padding:28px 40px;border-radius:12px;
    line-height:1.5;overflow-wrap:break-word;text-align:left;
    border:1px solid rgba(255,255,255,0.08);
    animation:cardIn 0.5s ease-out both;opacity:0;}
  @keyframes cardIn{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="cards-wrap">${cardsHtml || '<div class="insight-card" style="font-size:42px;color:#fff;animation-delay:0.2s">テキストを追加してください</div>'}</div>
    ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </div></body></html>`;
}

// ─── メニュースライド（news_overview 専用：目次バーが1秒ごとにスライドイン） ───
function buildMenu(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime } = imgBase64(imgPath);
  const bgDataUrl = b64 ? `data:${mime};base64,${b64}` : '';

  const menuItems = mod.menuItems || [];
  const MENU_START    = 2.8;  // スライド表示後、最初のバーが出るまでの秒数
  const ITEM_INTERVAL = 1.0;  // バー間隔（秒）
  const COLORS = ['#f59e0b','#3b82f6','#22c55e','#a78bfa','#ef4444','#06b6d4','#ec4899'];

  const itemsHtml = menuItems.slice(0, 7).map((label, i) => {
    const delay = (MENU_START + i * ITEM_INTERVAL).toFixed(1);
    const color = COLORS[i % COLORS.length];
    return `<div class="m-bar" style="border-left-color:${color};animation-delay:${delay}s;">
      <span class="m-num" style="color:${color};">${i + 1}</span>
      <span class="m-lbl">${esc(label)}</span>
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS}
  .bg-img{position:absolute;inset:0;
    ${bgDataUrl ? `background-image:url('${bgDataUrl}');background-size:cover;background-position:50%;` : 'background:#050a12;'}
    animation:kbZoom 25s linear forwards;}
  .overlay{position:absolute;inset:0;
    background:linear-gradient(135deg,rgba(4,8,18,0.93) 0%,rgba(8,18,40,0.88) 100%);}
  .m-wrap{position:absolute;top:0;left:0;right:0;bottom:172px;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:16px;padding:0 140px;}
  .m-title{color:#fff;font-size:48px;font-weight:900;letter-spacing:0.08em;
    margin-bottom:10px;animation:fadeUp 0.5s 0.4s ease-out both;opacity:0;}
  .m-bar{width:100%;padding:18px 32px;border-radius:8px;
    background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.09);
    border-left:6px solid #f59e0b;
    display:flex;align-items:center;gap:20px;
    animation:menuIn 0.45s ease-out both;opacity:0;}
  @keyframes menuIn{from{opacity:0;transform:translateX(-36px)}to{opacity:1;transform:translateX(0)}}
  .m-num{font-size:36px;font-weight:900;min-width:44px;text-align:center;flex-shrink:0;}
  .m-lbl{color:#d8e4ff;font-size:36px;font-weight:800;flex:1;line-height:1.3;overflow:hidden;
    white-space:nowrap;text-overflow:ellipsis;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="m-wrap">
      <div class="m-title">📋 本日のメニュー</div>
      ${itemsHtml || '<div class="m-bar" style="animation-delay:1s;border-left-color:#f59e0b"><span class="m-num" style="color:#f59e0b">—</span><span class="m-lbl">メニューを準備中...</span></div>'}
    </div>
    ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </div></body></html>`;
}

function buildEnding(mod, post, narrDurSec, startDelaySec) {
  const imgPath = mod.imagePath || post.mainImagePath;
  const { b64, mime, isPortrait } = imgMeta(imgPath);
  const bgStyle = bgCss(b64, mime, isPortrait);
  const animCss = isPortrait
    ? `.bg-img{position:absolute;inset:0;${bgStyle}animation:panDown 30s linear forwards;}`
    : `.bg-img{position:absolute;inset:0;${bgStyle}animation:kbZoom 25s linear forwards;transform-origin:50% 50%;}`;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  ${COMMON_CSS} ${animCss}
  .overlay{position:absolute;inset:0;background:rgba(0,0,0,0.45);}
  .cta-wrap{position:absolute;inset:0;bottom:132px;display:flex;flex-direction:column;
    align-items:center;justify-content:center;gap:28px;}
  .cta-main{color:#fff;font-size:68px;font-weight:900;text-align:center;line-height:1.4;
    text-shadow:0 4px 24px rgba(0,0,0,0.9);animation:fadeUp 0.5s 0.3s ease-out both;}
  .cta-sub{background:rgba(200,0,0,0.88);color:#fff;font-size:38px;font-weight:900;
    padding:14px 48px;border-radius:40px;animation:fadeUp 0.4s 0.7s ease-out both;}
  .cta-channel{color:rgba(255,255,255,0.7);font-size:24px;font-weight:500;
    animation:fadeIn 0.4s 1.1s ease-out both;}
  </style></head><body><div class="bg">
    <div class="bg-img"></div><div class="overlay"></div>
    <div class="cta-wrap">
      <div class="cta-main">${escLine(mod.catchLine || mod.narration?.slice(0, 40) || 'ご視聴ありがとうございました！')}</div>
      <div class="cta-sub">👍 チャンネル登録よろしくお願いします！</div>
      <div class="cta-channel">速報！サッカーニュース</div>
    </div>
    ${buildSubtitleHtml(mod.narration, narrDurSec, startDelaySec)}
  </div></body></html>`;
}

function buildSlide(mod, post, narrDurSec, startDelaySec) {
  const type = mod.slideType === 'story' ? 'insight' : (mod.slideType || 'insight');
  switch (type) {
    case 'opening':   return buildOpening(mod, post, narrDurSec, startDelaySec);
    case 'simple':    return buildInsight(mod, post, narrDurSec, startDelaySec);
    case 'menu':      return buildMenu(mod, post, narrDurSec, startDelaySec);
    case 'reaction':  return buildReaction(mod, post, narrDurSec, startDelaySec);
    case 'stats':
    case 'formation': return buildMatchCenter(mod, post, narrDurSec, startDelaySec);
    case 'type1':     return buildType1(mod, post, narrDurSec, startDelaySec);
    case 'type2':     return buildType2(mod, post, narrDurSec, startDelaySec);
    case 'type3':     return buildType3(mod, post, narrDurSec, startDelaySec);
    case 'type4':     return buildType4(mod, post, narrDurSec, startDelaySec);
    case 'insight':   return buildInsight(mod, post, narrDurSec, startDelaySec);
    case 'ending':    return buildEnding(mod, post, narrDurSec, startDelaySec);
    default:          return buildInsight(mod, post, narrDurSec, startDelaySec);
  }
}

module.exports = { buildSlide, CMT_PRE_DELAY, CMT_STEP };
