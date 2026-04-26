// routes/step35_routes.js  (Step 3.5: 画像選定)
// ═══════════════════════════════════════════════════════════
// STEP 3.5: 各カードのmainKeyに対して画像を取得・選択
//   - X公式 名前ソート (player/managerの場合)
//   - X公式 時間ソート (試合前後24h or 直近168h)
//   - Wikimedia Commons
//   - ユーザーがチェックボックスで選択 → image_selections.json
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const {
  fetchOfficialXImagesByName,
  fetchOfficialXImagesByTime,
} = require('../scripts/fetch_x_images');
const { fetchWikimediaImages } = require('../scripts/fetch_wikimedia_images');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');
const SEL_DIR  = path.join(DATA_DIR, 'image_selections');
const IMG_BASE = path.join(__dirname, '..', 'images'); // /images で配信中

if (!fs.existsSync(SEL_DIR)) fs.mkdirSync(SEL_DIR, { recursive: true });

// ─── ヘルパ ────────────────────────────────────────────────

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}
function safeId(s)             { return (s || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_'); }
function siPath(postId)        { return path.join(SI_DIR,  safeId(postId) + '.json'); }
function selectionPath(postId) { return path.join(SEL_DIR, safeId(postId) + '.json'); }
function imageOutDir(postId, moduleIdx) {
  return path.join(IMG_BASE, safeId(postId), String(moduleIdx));
}

// "player:Bellingham" → { type: 'player', entity: 'Bellingham' }
function parseMainKey(mainKey) {
  if (!mainKey) return { type: 'unknown', entity: '' };
  const idx = mainKey.indexOf(':');
  if (idx < 0) return { type: mainKey, entity: '' };
  return { type: mainKey.slice(0, idx).trim(), entity: mainKey.slice(idx + 1).trim() };
}

// si_data から選手・監督の所属チーム名を解決
function resolveTeamForEntity(si, entityName) {
  if (!si || !entityName) return null;
  // si は { "EntityName": { ok, siType, ...sofaData } } の形式
  const entry = si[entityName] || Object.values(si).find(e =>
    e?.siType === 'player' || e?.siType === 'manager'
  );
  if (!entry || !entry.ok) return null;
  return entry.team?.name
      || entry.data?.team?.name
      || entry.player?.team?.name
      || entry.club
      || null;
}

// si_data から最新の match の kickoff (ISO) を抽出
function resolveMatchKickoff(si) {
  if (!si) return null;
  for (const key of Object.keys(si)) {
    const e = si[key];
    if (e?.siType !== 'match') continue;
    const ts = e.startTimestamp || e.startDateTimestamp || e.kickoffTimestamp;
    if (ts) return new Date(ts * 1000).toISOString();
    if (e.kickoff)   return e.kickoff;
    if (e.startDate) return e.startDate;
  }
  return null;
}

// si_data から match の 両チーム名を取得
function resolveMatchTeams(si) {
  if (!si) return [];
  for (const key of Object.keys(si)) {
    const e = si[key];
    if (e?.siType !== 'match') continue;
    const home = e.homeTeam?.name || e.home?.name || e.homeName;
    const away = e.awayTeam?.name || e.away?.name || e.awayName;
    return [home, away].filter(Boolean);
  }
  return [];
}

// ファイルパス → ブラウザ用URL（/images/...）
function pathToUrl(filePath) {
  if (!filePath) return '';
  const fwd = filePath.replace(/\\/g, '/');
  const idx = fwd.indexOf('/images/');
  if (idx < 0) {
    // images で始まるケースもケア
    const i2 = fwd.indexOf('images/');
    if (i2 >= 0) return '/' + fwd.slice(i2);
    return fwd;
  }
  return fwd.slice(idx);
}

// ─── /api/v35/fetch-images : 画像取得 ─────────────────────
// Body: { postId, moduleIdx, mainKey }
// Response: { ok, teamName, matchKickoff, images: { x_by_name, x_by_time, wikimedia } }
router.post('/v35/fetch-images', async (req, res) => {
  const { postId, moduleIdx, mainKey } = req.body || {};
  if (!postId || moduleIdx == null || !mainKey) {
    return res.status(400).json({ error: 'postId + moduleIdx + mainKey required' });
  }

  try {
    const si = safeJson(siPath(postId), {});
    const { type, entity } = parseMainKey(mainKey);
    const outDir = imageOutDir(postId, moduleIdx);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // --- チーム名と試合時刻を解決 ---
    let teamName     = null;
    let teamNameAway = null;       // match の場合は2つ目のチーム
    let matchKickoff = null;

    if (type === 'team') {
      teamName = entity;
    } else if (type === 'player' || type === 'manager') {
      teamName     = resolveTeamForEntity(si, entity);
      matchKickoff = resolveMatchKickoff(si);
    } else if (type === 'match' || type === 'matchcard' || type === 'matchcenter') {
      const teams  = resolveMatchTeams(si);
      teamName     = teams[0] || null;
      teamNameAway = teams[1] || null;
      matchKickoff = resolveMatchKickoff(si);
    } else if (type === 'news') {
      // news は entity にキーワード入る想定。X名前ソートは実行不可。
    }

    // --- 並列取得タスク組み立て ---
    const tasks = [];

    // 1. X 名前ソート（player/manager のみ）
    if ((type === 'player' || type === 'manager') && teamName && entity) {
      tasks.push(
        fetchOfficialXImagesByName(teamName, entity, '', 6, { outDir })
          .then(paths => ({ source: 'x_by_name', paths }))
          .catch(e => { console.warn('[x_by_name]', e.message); return { source: 'x_by_name', paths: [] }; })
      );
    } else {
      tasks.push(Promise.resolve({ source: 'x_by_name', paths: [] }));
    }

    // 2. X 時間ソート（teamName が解決できた場合）
    if (teamName) {
      tasks.push(
        fetchOfficialXImagesByTime(teamName, '', 6, { outDir, matchKickoff })
          .then(paths => ({ source: 'x_by_time', paths }))
          .catch(e => { console.warn('[x_by_time]', e.message); return { source: 'x_by_time', paths: [] }; })
      );
    } else {
      tasks.push(Promise.resolve({ source: 'x_by_time', paths: [] }));
    }

    // 3. match の場合は away も時間ソート
    if (teamNameAway) {
      tasks.push(
        fetchOfficialXImagesByTime(teamNameAway, 'away', 4, { outDir, matchKickoff })
          .then(paths => ({ source: 'x_by_time_away', paths }))
          .catch(e => { console.warn('[x_by_time_away]', e.message); return { source: 'x_by_time_away', paths: [] }; })
      );
    } else {
      tasks.push(Promise.resolve({ source: 'x_by_time_away', paths: [] }));
    }

    // 4. Wikimedia（entity名で検索）
    if (entity) {
      tasks.push(
        fetchWikimediaImages(entity, '', 3, { outDir })
          .then(paths => ({ source: 'wikimedia', paths }))
          .catch(e => { console.warn('[wikimedia]', e.message); return { source: 'wikimedia', paths: [] }; })
      );
    } else {
      tasks.push(Promise.resolve({ source: 'wikimedia', paths: [] }));
    }

    const results = await Promise.all(tasks);

    // ファイルパス → URL に変換
    const images = {};
    for (const r of results) {
      images[r.source] = r.paths.map(pathToUrl);
    }

    // 統計
    const total = Object.values(images).reduce((s, a) => s + a.length, 0);

    res.json({
      ok: true,
      mainKey,
      type,
      entity,
      teamName,
      teamNameAway,
      matchKickoff,
      images,
      total,
    });
  } catch (e) {
    console.error('[step35/fetch-images]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/v35/save-selection : 選択結果を保存 ────────────────
// Body: { postId, selections: { "<moduleIdx>": ["<urlOrPath>", ...] } }
router.post('/v35/save-selection', (req, res) => {
  const { postId, selections } = req.body || {};
  if (!postId || typeof selections !== 'object' || selections === null) {
    return res.status(400).json({ error: 'postId + selections (object) required' });
  }
  try {
    const data = { postId, selections, savedAt: new Date().toISOString() };
    fs.writeFileSync(selectionPath(postId), JSON.stringify(data, null, 2));
    res.json({ ok: true, count: Object.keys(selections).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/v35/get-selection : 既存の選択を取得 ─────────────
router.get('/v35/get-selection', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ selections: {} });
  const j = safeJson(selectionPath(postId), { selections: {} });
  res.json(j);
});

// ─── UI: Phase 1 はバックエンドのみ。空文字列を返す ──────────
// Phase 3 でタブUI / プレビュー / チェックボックス選択を実装する
function getUI() {
  return '';
}

module.exports = { router, getUI };
