// routes/step35_routes.js  (Step 3.5: 画像選定 — ラベル単位版)
// ═══════════════════════════════════════════════════════════
// STEP 3.5: 案件内のユニークラベル（mainKey + secondary）に対して画像を取得・選択
//   - X公式 名前ソート (player/managerの場合)
//   - X公式 時間ソート (試合前後24h or 直近168h)
//   - Wikimedia Commons
//   - ユーザーがサムネをクリックして選択 → image_selections.json
//   - 選定はラベル文字列をキーに保存。複数スライドが同じラベルを参照すると自動共有
// ═══════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');

const {
  fetchOfficialXImagesByName,
  fetchOfficialXImagesByTime,
} = require('../scripts/fetch_x_images');
const { fetchWikimediaImages } = require('../scripts/fetch_wikimedia_images');
const { findStockMatches }     = require('../scripts/modules/stock_match');

const router = express.Router();

const REPO_ROOT = path.join(__dirname, '..');
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash';
const GEMINI_IMAGE_CLASSIFY_LIMIT = Number(process.env.GEMINI_IMAGE_CLASSIFY_LIMIT || 60);
const PLAYER_STOCK_DIR = path.join(REPO_ROOT, 'images_stock', 'players_official');
const PLAYER_INDEX_FILE = path.join(REPO_ROOT, 'data', 'players_official_index.json');

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
function modulesPath(postId)   { return path.join(DATA_DIR, safeId(postId) + '_modules.json'); }
function selectionPath(postId) { return path.join(SEL_DIR, safeId(postId) + '.json'); }

// ラベル文字列 → ファイルシステム安全な文字列
//   "entity:Lionel Messi" → "entity_Lionel_Messi"
//   "team:Bayern Munich"  → "team_Bayern_Munich"
function labelSafe(label) {
  return (label || 'unknown')
    .replace(/[\/\?%*:|"<>\.]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function imageOutDirForLabel(postId, label) {
  return path.join(IMG_BASE, safeId(postId), labelSafe(label));
}

function slugifyName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown-player';
}

function imageDataUriToBuffer(dataUri) {
  const m = String(dataUri || '').match(/^data:(image\/(?:png|jpe?g|webp));base64,(.*)$/i);
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
  return { mime, ext, buffer: Buffer.from(m[2], 'base64') };
}

// "entity:Jude Bellingham" → { type: 'entity', entity: 'Jude Bellingham' }
function parseMainKey(mainKey) {
  if (!mainKey) return { type: 'unknown', entity: '' };
  const idx = mainKey.indexOf(':');
  if (idx < 0) return { type: mainKey, entity: '' };
  return { type: mainKey.slice(0, idx).trim(), entity: mainKey.slice(idx + 1).trim() };
}

function inferEntityRole(si, entityName) {
  if (!entityName) return null;
  const items = si?.boxes?.entity?.items || [];
  const item = findEntityItem(items, entityName);
  if (item?.role) return item.role;
  // フォールバック: チームマップ
  try {
    const mapPath = path.join(__dirname, '..', 'logos', 'team_x_accounts.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const teams = map.teams || {};
    const en = entityName.toLowerCase().trim();
    for (const k of Object.keys(teams)) {
      if (k.toLowerCase() === en) return 'team';
    }
  } catch (_) {}
  return null;
}

function findEntityItem(items, entityName) {
  if (!items?.length || !entityName) return null;
  const en = entityName.toLowerCase().trim();
  let hit = items.find(it => (it.label || '').toLowerCase() === en);
  if (hit) return hit;
  hit = items.find(it => {
    const lab = (it.label || '').toLowerCase();
    return lab.includes(en) || en.includes(lab);
  });
  return hit || null;
}

function resolveSofaPlayerInfo(si, entityName) {
  const target = findEntityItem(si?.boxes?.entity?.items || [], entityName);
  const sofa = target?.sofa || {};
  const playerId = sofa.playerId
    || sofa.sofaPlayerId
    || sofa.player?.id
    || sofa.data?.player?.id
    || sofa.id
    || null;
  if (!playerId) return null;
  return {
    playerId,
    name: sofa.name || sofa.player?.name || sofa.data?.player?.name || target?.label || entityName,
    team: sofa.team?.name || sofa.player?.team?.name || sofa.teamName || sofa.club || null,
    league: sofa.leagueName || sofa.tournament?.name || sofa.player?.team?.tournament?.name || null,
  };
}

function resolveTeamForEntity(si, entityName) {
  if (!si || !entityName) return null;
  const items = si?.boxes?.entity?.items || [];
  if (!items.length) return null;

  const target = findEntityItem(items, entityName);

  if (target?.sofa?.ok) {
    // SofaScore の sofa パスは構造ばらつき多い：
    //   - team entity → 直下に teamName
    //   - player entity → sofa.team または sofa.player.team
    //   - 旧構造 → sofa.data.team / sofa.club
    const t = target.sofa.team?.name
           || target.sofa.player?.team?.name
           || target.sofa.data?.team?.name
           || target.sofa.teamName
           || target.sofa.player?.teamName
           || target.sofa.club
           || null;
    if (t) return t;
  }

  if (target?.wiki?.extract) {
    try {
      const mapPath = path.join(__dirname, '..', 'logos', 'team_x_accounts.json');
      const map  = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const teams = map.teams || {};
      const extract = target.wiki.extract;
      const teamNames = Object.keys(teams).sort((a, b) => b.length - a.length);
      for (const name of teamNames) {
        if (extract.includes(name)) return name;
      }
    } catch (_) {}
  }

  const teamItems = items.filter(it => it.role === 'team');
  if (teamItems.length) return teamItems[0].label;

  return null;
}

function resolveMatchKickoff(si) {
  const items = si?.boxes?.match?.items || [];
  for (const m of items) {
    const sofa = m.sofa || m;
    const ts = sofa.startTimestamp || sofa.startDateTimestamp || sofa.kickoffTimestamp;
    if (ts) return new Date(ts * 1000).toISOString();
    if (sofa.kickoff)   return sofa.kickoff;
    if (sofa.startDate) return sofa.startDate;
  }
  return null;
}

function resolveMatchTeams(si) {
  const items = si?.boxes?.match?.items || [];
  for (const m of items) {
    const sofa = m.sofa || m;
    const home = sofa.homeTeam?.name || sofa.home?.name || sofa.homeName;
    const away = sofa.awayTeam?.name || sofa.away?.name || sofa.awayName;
    if (home || away) return [home, away].filter(Boolean);
  }
  const teamItems = (si?.boxes?.entity?.items || []).filter(it => it.role === 'team');
  return teamItems.slice(0, 2).map(it => it.label);
}

function pathToUrl(filePath) {
  if (!filePath) return '';
  const fwd = filePath.replace(/\\/g, '/');
  const idx = fwd.indexOf('/images/');
  if (idx < 0) {
    const i2 = fwd.indexOf('images/');
    if (i2 >= 0) return '/' + fwd.slice(i2);
    return fwd;
  }
  return fwd.slice(idx);
}

// modules + si_data からユニークラベル一覧を抽出。
// 各ラベルに「使用スライド」「役割（player/team/manager）」を付与して返す。
//   matchcard:home_vs_away は team:home / team:away に展開
//   opening / ending はラベル無しなのでスキップ
function imageUrlToLocalPath(url) {
  const cleaned = String(url || '').split('?')[0];
  if (!cleaned.startsWith('/images/') && !cleaned.startsWith('/images_stock/')) return null;
  const local = path.join(REPO_ROOT, cleaned.replace(/^\//, ''));
  return fs.existsSync(local) ? local : null;
}

function imageMimeFromPath(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function parseGeminiJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) { return null; }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function classifyImageCandidate(candidate, ctx) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const filePath = imageUrlToLocalPath(candidate.url);
  if (!filePath) return null;
  const b64 = fs.readFileSync(filePath).toString('base64');
  const prompt = [
    'You are selecting soccer images for a short-form video editor.',
    'Return only JSON.',
    'Target label: ' + (ctx.label || ''),
    'Target entity/person/team: ' + (ctx.entity || ''),
    'Role/type: ' + (ctx.effectiveType || ctx.type || ''),
    'Related club home: ' + (ctx.teamName || ''),
    'Related club away: ' + (ctx.teamNameAway || ''),
    'Candidate source: ' + candidate.source,
    'Decide whether this image should be kept for the target video context.',
    'JSON schema: {"keep":true,"category":"target_person|same_team|match_context|club_asset|wrong_person|other","contentType":"portrait|action|celebration|training|logo|stadium|squad|other","confidence":0.0,"reason":"short Japanese"}'
  ].join('\n');
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: imageMimeFromPath(filePath), data: b64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${apiKey}`;
  const res = await axios.post(url, body, { timeout: 25000 });
  const text = res.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n') || '';
  const parsed = parseGeminiJson(text) || {};
  const confidence = Number(parsed.confidence || 0);
  return {
    url: candidate.url,
    source: candidate.source,
    keep: Boolean(parsed.keep),
    category: parsed.category || 'other',
    contentType: parsed.contentType || 'other',
    confidence: Number.isFinite(confidence) ? confidence : 0,
    reason: parsed.reason || '',
  };
}

async function classifyImageGroups(images, ctx) {
  const sourceOrder = ['warehouse_adopted', 'stock', 'x_by_name', 'x_by_time', 'x_by_time_away', 'wikimedia', 'manual'];
  const seen = new Set();
  const candidates = [];
  for (const source of sourceOrder) {
    for (const url of images[source] || []) {
      if (typeof url !== 'string' || !url || seen.has(url)) continue;
      seen.add(url);
      candidates.push({ source, url });
    }
  }
  const fallback = candidates.map(c => c.url).slice(0, 20);
  if (!candidates.length) {
    return { gemini_selected: [], gemini_rejected: [], gemini_meta: [], gemini_status: { ok: false, reason: 'no candidates' } };
  }
  if (!process.env.GEMINI_API_KEY) {
    return {
      gemini_selected: fallback,
      gemini_rejected: [],
      gemini_meta: [],
      gemini_status: { ok: false, reason: 'GEMINI_API_KEY missing; fallback order used', checked: 0, selected: fallback.length },
    };
  }
  const limit = Math.max(1, Math.min(GEMINI_IMAGE_CLASSIFY_LIMIT || 60, candidates.length));
  const batch = candidates.slice(0, limit);
  const results = (await mapLimit(batch, 3, async (candidate) => {
    try { return await classifyImageCandidate(candidate, ctx); }
    catch (e) {
      console.warn('[gemini-image-classify]', candidate.source, candidate.url, e.message);
      return { url: candidate.url, source: candidate.source, keep: false, category: 'other', contentType: 'other', confidence: 0, reason: e.message };
    }
  })).filter(Boolean);
  const priority = { target_person: 0, match_context: 1, same_team: 2, club_asset: 3, other: 4, wrong_person: 9 };
  const kept = results
    .filter(r => r.keep && r.confidence >= 0.4 && r.category !== 'wrong_person')
    .sort((a, b) => (priority[a.category] ?? 5) - (priority[b.category] ?? 5) || b.confidence - a.confidence);
  const rejected = results.filter(r => !kept.find(k => k.url === r.url)).slice(0, 20);
  return {
    gemini_selected: kept.map(r => r.url).slice(0, 24),
    gemini_rejected: rejected.map(r => r.url).slice(0, 20),
    gemini_meta: results,
    gemini_status: { ok: true, checked: results.length, selected: kept.length },
  };
}

async function fetchSofaProfileToStock({ si, postId, label, entity, teamName }) {
  const info = resolveSofaPlayerInfo(si, entity);
  if (!info?.playerId) return null;

  const { apiGetImage } = require('../scripts/modules/fetchers/_sofa_common');
  const dataUri = await apiGetImage(`/player/${info.playerId}/image`);
  const img = imageDataUriToBuffer(dataUri);
  if (!img?.buffer?.length) return null;

  const playerName = info.name || entity;
  const playerSlug = slugifyName(playerName);
  const outDir = path.join(PLAYER_STOCK_DIR, playerSlug);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const filename = `${playerSlug}_sofa_${info.playerId}.${img.ext}`;
  const outPath = path.join(outDir, filename);
  if (!fs.existsSync(outPath)) fs.writeFileSync(outPath, img.buffer);

  const localPath = path.relative(REPO_ROOT, outPath).replace(/\\/g, '/');
  const idx = safeJson(PLAYER_INDEX_FILE, { players: {} });
  idx.players = idx.players || {};
  const indexKey = `sofascore:${info.playerId}`;
  idx.players[indexKey] = {
    ...(idx.players[indexKey] || {}),
    name: playerName,
    slug: playerSlug,
    club: teamName || info.team || '',
    league: info.league || '',
    sofaPlayerId: info.playerId,
    photoUrl: `https://api.sofascore.com/api/v1/player/${info.playerId}/image`,
    localPath,
    sizeBytes: fs.statSync(outPath).size,
    source: 'sofascore-profile',
    confidence: 0.99,
    label,
    postId,
    addedAt: new Date().toISOString().slice(0, 10),
  };
  idx.updatedAt = new Date().toISOString();
  idx.total = Object.keys(idx.players).length;
  fs.writeFileSync(PLAYER_INDEX_FILE, JSON.stringify(idx, null, 2));

  try {
    const { registerNewImage } = require('../scripts/image_score_manager');
    registerNewImage(localPath, { visionScore: 99, confidence: 0.99, source: 'sofascore-profile' });
  } catch (_) {}

  return {
    url: '/' + localPath,
    localPath,
    playerId: info.playerId,
    name: playerName,
    team: teamName || info.team || null,
    league: info.league || null,
  };
}

function extractLabels(modules, si) {
  const seen = new Map(); // key -> { key, role, displayName, slidesUsing, source }

  function addLabel(key, role, displayName, slideIdx, source) {
    if (!key) return;
    if (!seen.has(key)) {
      seen.set(key, { key, role: role || null, displayName: displayName || key, slidesUsing: [], sources: new Set() });
    }
    const e = seen.get(key);
    if (!e.slidesUsing.includes(slideIdx)) e.slidesUsing.push(slideIdx);
    e.sources.add(source);
    if (!e.role && role) e.role = role;
  }

  (modules || []).forEach((m, i) => {
    if (!m) return;
    const mk = m.mainKey || '';
    const { type, entity } = parseMainKey(mk);

    if (type === 'opening' || type === 'ending' || !mk) return;

    if (type === 'matchcard' || type === 'match') {
      // matchcard は両チーム取りに行く
      const teams = resolveMatchTeams(si);
      if (teams[0]) addLabel(`team:${teams[0]}`, 'team', teams[0], i, 'matchcard.home');
      if (teams[1]) addLabel(`team:${teams[1]}`, 'team', teams[1], i, 'matchcard.away');
      return;
    }

    if (type === 'entity') {
      const role = inferEntityRole(si, entity) || 'entity';
      addLabel(mk, role, entity, i, 'mainKey');
    } else if (type === 'team' || type === 'player' || type === 'manager') {
      addLabel(mk, type, entity, i, 'mainKey');
    } else if (type === 'news') {
      addLabel(mk, 'news', entity, i, 'mainKey.news');
    } else {
      // 未知 type は entity 扱い
      addLabel(mk, 'unknown', entity || mk, i, 'mainKey.other');
    }

    // secondary を持つスライド（comparison など）
    const sec = m.secondary || m.binding?.secondary;
    if (sec) {
      // secondary は entity 名そのもの（"entity:" プレフィックスなし）の場合あり
      const k2 = sec.includes(':') ? sec : `entity:${sec}`;
      const { type: t2, entity: e2 } = parseMainKey(k2);
      const r2 = (t2 === 'entity' ? inferEntityRole(si, e2) : t2) || 'entity';
      addLabel(k2, r2, e2 || sec, i, 'secondary');
    }
  });

  return Array.from(seen.values()).map(e => ({
    key:          e.key,
    role:         e.role,
    displayName:  e.displayName,
    slidesUsing:  e.slidesUsing.sort((a, b) => a - b),
    sources:      Array.from(e.sources),
  }));
}

// ─── /api/v35/labels : ユニークラベル一覧 ──────────────────
// Query: ?postId=...
// Response: { ok, labels: [{ key, role, displayName, slidesUsing, sources }] }
router.get('/v35/labels', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  try {
    const data = safeJson(modulesPath(postId), { modules: [] });
    const si   = safeJson(siPath(postId), {});
    const labels = extractLabels(data.modules || [], si);
    res.json({ ok: true, labels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 画像取得コア関数 (postId, label) → { ok, images, ... }
// Step 2 の fetch-label/fetch-all から並行発火するためにモジュール export
async function fetchImagesForLabel(postId, label) {
  if (!postId || !label) return { ok: false, error: 'postId + label required' };
  const si = safeJson(siPath(postId), {});
  const { type, entity } = parseMainKey(label);
  const outDir = imageOutDirForLabel(postId, label);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let effectiveType = type;
  if (type === 'entity') {
    const inferred = inferEntityRole(si, entity);
    effectiveType = inferred || 'entity';
  }

  let teamName     = null;
  let teamNameAway = null;
  let matchKickoff = null;

  if (effectiveType === 'team') {
    teamName = entity;
  } else if (effectiveType === 'player' || effectiveType === 'manager') {
    teamName     = resolveTeamForEntity(si, entity);
    matchKickoff = resolveMatchKickoff(si);
  } else if (effectiveType === 'match' || effectiveType === 'matchcard') {
    const teams  = resolveMatchTeams(si);
    teamName     = teams[0] || null;
    teamNameAway = teams[1] || null;
    matchKickoff = resolveMatchKickoff(si);
  }

  const tasks = [];

  if ((effectiveType === 'player' || effectiveType === 'manager') && teamName && entity) {
    tasks.push(
      fetchOfficialXImagesByName(teamName, entity, '', 20, { outDir })
        .then(paths => ({ source: 'x_by_name', paths }))
        .catch(e => { console.warn('[x_by_name]', e.message); return { source: 'x_by_name', paths: [] }; })
    );
  } else {
    tasks.push(Promise.resolve({ source: 'x_by_name', paths: [] }));
  }

  // x_by_time: チーム公式 X の直近投稿（題材問わず）
  //   ⚠️ 監督ラベルでは混入源（チーム他選手・ファン写真等）になるためスキップ（2026-05-10）
  if (teamName && effectiveType !== 'manager') {
    tasks.push(
      fetchOfficialXImagesByTime(teamName, '', 20, { outDir, matchKickoff })
        .then(paths => ({ source: 'x_by_time', paths }))
        .catch(e => { console.warn('[x_by_time]', e.message); return { source: 'x_by_time', paths: [] }; })
    );
  } else {
    tasks.push(Promise.resolve({ source: 'x_by_time', paths: [] }));
  }

  // x_by_time_away: 同上、監督ラベルではスキップ
  if (teamNameAway && effectiveType !== 'manager') {
    tasks.push(
      fetchOfficialXImagesByTime(teamNameAway, 'away', 20, { outDir, matchKickoff })
        .then(paths => ({ source: 'x_by_time_away', paths }))
        .catch(e => { console.warn('[x_by_time_away]', e.message); return { source: 'x_by_time_away', paths: [] }; })
    );
  } else {
    tasks.push(Promise.resolve({ source: 'x_by_time_away', paths: [] }));
  }

  // wikimedia: 監督は本人画像が他のソースから取りにくいため枚数増（3→8）
  if (entity) {
    const wmCount = effectiveType === 'manager' ? 8 : 3;
    tasks.push(
      fetchWikimediaImages(entity, '', wmCount, { outDir })
        .then(paths => ({ source: 'wikimedia', paths }))
        .catch(e => { console.warn('[wikimedia]', e.message); return { source: 'wikimedia', paths: [] }; })
    );
  } else {
    tasks.push(Promise.resolve({ source: 'wikimedia', paths: [] }));
  }

  const results = await Promise.all(tasks);

  const images = {};
  for (const r of results) {
    images[r.source] = r.paths.map(pathToUrl);
  }

  try {
    if (process.env.ENABLE_SOFA_PROFILE_IMAGES === '1' && effectiveType === 'player' && entity) {
      const sofaProfile = await fetchSofaProfileToStock({ si, postId, label, entity, teamName });
      images.sofa_profile = sofaProfile?.url ? [sofaProfile.url] : [];
      images.sofa_profile_meta = sofaProfile ? [sofaProfile] : [];
    } else {
      images.sofa_profile = [];
      images.sofa_profile_meta = [];
    }
  } catch (e) {
    console.warn('[sofa-profile-image]', e.message);
    images.sofa_profile = [];
    images.sofa_profile_meta = [];
  }

  // ストック画像（images_stock の indices からラベル一致を引く）
  try {
    const stockMatches = findStockMatches({ type: effectiveType, entity, teamName, teamNameAway, limit: 20 });
    images.stock = stockMatches.map(m => m.url).filter(Boolean);
    images.stock_meta = stockMatches.map(m => ({ url: m.url, role: m.role, name: m.name, score: m.score, usageScore: m.usageScore || 0, visionScore: m.visionScore || 0, confidence: m.confidence ?? null, league: m.league || null }));
  } catch (e) {
    console.warn('[stock]', e.message);
    images.stock = [];
    images.stock_meta = [];
  }

  // 手動アップロード画像（outDir 内の manual_*.png/jpg/webp をスキャン）
  try {
    const manualFiles = fs.existsSync(outDir)
      ? fs.readdirSync(outDir)
          .filter(f => f.startsWith('manual_') && /\.(png|jpe?g|webp)$/i.test(f))
          .map(f => pathToUrl(path.join(outDir, f)))
      : [];
    images.manual = manualFiles;
  } catch (e) {
    console.warn('[manual]', e.message);
    images.manual = [];
  }

  // Gemini分類 + warehouse ingest をバックグラウンドで統合実行
  if (effectiveType === 'player' && entity) {
    images.warehouse_adopted = [];
    images.warehouse_status = { ok: true, checked: 0, adopted: 0, async: true };
    const imagesSnap = {};
    for (const k of ['x_by_name', 'x_by_time', 'x_by_time_away', 'stock', 'wikimedia', 'manual']) {
      imagesSnap[k] = images[k] ? [...images[k]] : [];
    }
    setImmediate(async () => {
      try {
        const classified = await classifyImageGroups(imagesSnap, {
          label, type, effectiveType, entity, teamName, teamNameAway, matchKickoff,
        });
        const sourceMap = new Map();
        const warehouseSources = new Set(['x_by_name', 'x_by_time', 'x_by_time_away']);
        Array.from(warehouseSources).forEach(k => {
          (imagesSnap[k] || []).forEach(url => sourceMap.set(url, k));
        });
        const geminiMeta = classified.gemini_meta || [];
        const selectedRows = geminiMeta.filter(r => r.keep && r.category !== 'wrong_person' && warehouseSources.has(r.source));
        const selectedUrls = (selectedRows.length ? selectedRows.map(r => r.url) : (classified.gemini_selected || []))
          .filter((url, i, arr) => typeof url === 'string'
            && url
            && !url.startsWith('/images_stock/')
            && warehouseSources.has(sourceMap.get(url))
            && arr.indexOf(url) === i)
          .slice(0, Number(process.env.WAREHOUSE_INGEST_LIMIT || 12));
        const warehouseCandidates = selectedUrls.map(url => ({
          url,
          localPath: imageUrlToLocalPath(url),
          source: sourceMap.get(url) || 'step2',
        })).filter(c => c.localPath);
        const { ingestImagesForPlayer } = require('../scripts/warehouse_recognize');
        await ingestImagesForPlayer(warehouseCandidates, {
          postId, label, playerHint: entity, clubHint: teamName || '',
          source: 'step2-image-fetch',
          limit: Number(process.env.WAREHOUSE_INGEST_LIMIT || 12),
        });
        console.log(`[bg-classify-ingest] 完了: ${label} (${warehouseCandidates.length}枚候補)`);
      } catch (e) {
        console.warn('[bg-classify-ingest] 失敗:', e.message);
      }
    });
  }

  const total = new Set(
    Object.values(images)
      .flatMap(a => Array.isArray(a) ? a : [])
      .filter(v => typeof v === 'string' && v)
  ).size;

  return {
    ok: true,
    label, type, effectiveType, entity,
    teamName, teamNameAway, matchKickoff,
    images, total,
  };
}

// ─── /api/v35/fetch-images : 画像取得（ラベル単位）──────────
// Body: { postId, label }   ← label は "entity:Messi" / "team:Bayern" 等の mainKey 文字列
// Response: { ok, label, teamName, matchKickoff, images: { x_by_name, x_by_time, wikimedia } }
router.post('/v35/fetch-images', async (req, res) => {
  const { postId, label } = req.body || {};
  if (!postId || !label) {
    return res.status(400).json({ error: 'postId + label required' });
  }
  try {
    const result = await fetchImagesForLabel(postId, label);
    res.json(result);
  } catch (e) {
    console.error('[step35/fetch-images]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/v35/upload-image : 手動画像アップロード（label 単位）──
// Body: { postId, label, filename, dataUrl }
//   dataUrl: "data:image/png;base64,..." 形式
//   保存先: data/v2_thumbs/{postId}/{labelSafe}/manual_{ts}_{name}.{ext}
router.post('/v35/upload-image', (req, res) => {
  const { postId, label, filename, dataUrl } = req.body || {};
  if (!postId || !label || !dataUrl) {
    return res.status(400).json({ error: 'postId/label/dataUrl required' });
  }
  const m = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid dataUrl format' });

  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buffer = Buffer.from(m[2], 'base64');

  const outDir = imageOutDirForLabel(postId, label);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const safeName = String(filename || 'manual')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 40);
  const finalFile = `manual_${Date.now()}_${safeName}.${ext}`;
  const finalPath = path.join(outDir, finalFile);
  fs.writeFileSync(finalPath, buffer);

  res.json({
    ok: true,
    file: finalFile,
    url: pathToUrl(finalPath),
    size: buffer.length,
  });
});

// ─── /api/v35/save-selection : 選択結果を保存（ラベルキー）─
// Body: { postId, selections: { "<label>": ["<urlOrPath>", ...] } }
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

  // バックグラウンド: ストック画像の使用スコア記録 + 非ストック画像の強制ストック追加
  setImmediate(async () => {
    try {
      const { recordImageUsage } = require('../scripts/image_score_manager');
      const { addToStockDirect } = require('../scripts/warehouse_recognize');
      const si = safeJson(siPath(postId), {});
      const stockPaths = [];
      for (const [label, urls] of Object.entries(selections || {})) {
        const { type, entity } = parseMainKey(label);
        const nonStockCandidates = [];
        for (const url of (urls || [])) {
          const localPath = imageUrlToLocalPath(url);
          if (!localPath) continue;
          if (url.startsWith('/images_stock/')) {
            stockPaths.push(localPath);
          } else if (type === 'player' && entity) {
            nonStockCandidates.push({ url, localPath, source: 'user-selected' });
          }
        }
        if (nonStockCandidates.length && type === 'player' && entity) {
          const teamName = resolveTeamForEntity(si, entity);
          await addToStockDirect(nonStockCandidates, {
            playerHint: entity, clubHint: teamName || '', source: 'user-selected',
          });
        }
      }
      if (stockPaths.length) recordImageUsage(stockPaths);
    } catch (e) {
      console.warn('[save-selection bg]', e.message);
    }
  });
});

// ─── /api/v35/get-selection : 既存の選択を取得 ─────────────
router.get('/v35/get-selection', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ selections: {} });
  const j = safeJson(selectionPath(postId), { selections: {} });
  res.json(j);
});

// ─── UI: Step3.5 タブ（ラベル一覧版）─────────────────────────
function getUI() {
  return `
<div id="step35" class="step-container" style="display:none">
<div style="padding:0 20px 20px;">

  <!-- TOP PANEL -->
  <div class="panel" style="margin-bottom:14px;">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span id="s35Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件を選択してください</span>
      <button class="btn btn-sm" id="s35BtnFetchAll" style="background:#3b82f6;color:#fff;">📥 全ラベル一括取得</button>
      <button class="btn btn-sm" id="s35BtnSave" style="background:#10b981;color:#fff;">💾 選択を保存</button>
      <span id="s35Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
    <div style="font-size:11px;color:#8a9aba;margin-top:6px;">📸 案件内のユニーク登場人物・チーム（ラベル）ごとに画像を取得。同じラベルを参照する複数スライドで自動共有される。</div>
  </div>

  <!-- ラベル別エリア -->
  <div id="s35LabelList"></div>

</div>
</div>

<style>
.s35-thumb { position:relative; width:120px; height:90px; border:3px solid #2a3050; border-radius:4px; cursor:pointer; background:#000; overflow:hidden; transition:border-color 0.15s; }
.s35-thumb:hover { border-color:#5a7da0; }
.s35-thumb.selected { border-color:#ff4d4d; box-shadow:0 0 8px rgba(255,77,77,0.6); }
.s35-thumb img { width:100%; height:100%; object-fit:cover; display:block; }
.s35-thumb .check { position:absolute; top:0; right:0; background:#ff4d4d; color:#fff; padding:2px 6px; font-size:10px; font-weight:bold; }
.s35-grouplabel { font-size:11px; color:var(--c); font-weight:bold; margin:8px 0 5px 0; }
.s35-grid { display:flex; gap:6px; flex-wrap:wrap; }
.s35-empty { padding:20px; text-align:center; font-size:12px; color:#5a6a8a; }
.s35-rolebadge { padding:2px 7px; border-radius:9px; font-size:10px; font-weight:bold; color:#fff; }
.s35-role-team    { background:#1d4ed8; }
.s35-role-player  { background:#059669; }
.s35-role-manager { background:#7c3aed; }
.s35-role-other   { background:#475569; }
</style>

<script>(function(){
  'use strict';

  window.APP = window.APP || {};
  // images: { "<label>": { x_by_name, x_by_time, wikimedia, ... } }
  // selections: { "<label>": ["url1", "url2", ...] }
  window.APP.s35 = { labels: [], images: {}, selections: {} };

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _msg(s) { const e = document.getElementById('s35Msg'); if (e) e.innerHTML = s; }

  function _roleClass(role) {
    if (role === 'team')    return 's35-role-team';
    if (role === 'player')  return 's35-role-player';
    if (role === 'manager') return 's35-role-manager';
    return 's35-role-other';
  }
  function _roleJa(role) {
    return ({ team: 'チーム', player: '選手', manager: '監督', news: 'ニュース', entity: '人物/組織', unknown: '?' })[role] || role || '?';
  }

  /* ── 初期化 (goStep(35) で呼ばれる) ── */
  window.step35Init = async function() {
    const post = window.APP.selected;
    document.getElementById('s35Title').textContent = post
      ? (post.titleJa || post.title || '(タイトル不明)').slice(0, 80)
      : '案件を選択してください';
    if (!post?.id) { window.APP.s35.labels = []; _renderLabels(); return; }

    try {
      const r = await fetchJson('/api/v35/labels?postId=' + encodeURIComponent(post.id));
      window.APP.s35.labels = r.labels || [];
      const s = await fetchJson('/api/v35/get-selection?postId=' + encodeURIComponent(post.id));
      window.APP.s35.selections = s.selections || {};
    } catch (e) {
      console.warn('[Step3.5] init failed:', e.message);
      window.APP.s35.labels = [];
    }
    _renderLabels();
  };

  /* ── ラベル一覧描画 ── */
  function _renderLabels() {
    const el = document.getElementById('s35LabelList');
    if (!el) return;
    const labels = window.APP.s35.labels || [];
    if (!labels.length) {
      el.innerHTML = '<div class="s35-empty">登場するエンティティが見つかりません。Step3で脚本を生成してから戻ってきてください。</div>';
      return;
    }
    el.innerHTML = labels.map(L => _renderLabel(L)).join('');
  }

  function _renderLabel(L) {
    const imgGroups = window.APP.s35.images[L.key];
    const sel       = window.APP.s35.selections[L.key] || [];

    const btnLabel = imgGroups ? '🔄 再取得' : '📥 画像取得';
    const btnHTML  = '<button class="btn btn-sm s35-fetch-btn" data-key="' + _esc(L.key) + '" style="background:#3b82f6;color:#fff;">' + btnLabel + '</button>';
    const upHTML   = '<button class="btn btn-sm s35-upload-btn" data-key="' + _esc(L.key) + '" style="background:#7c3aed;color:#fff;">📤 手動アップロード</button>';

    let body = '';
    if (imgGroups) {
      body =
          _renderGroup('🖼 手動アップロード',          imgGroups.manual,         L.key, sel)
        + _renderGroup('🎁 ストック (公式素材)',       imgGroups.stock,          L.key, sel)
        + _renderGroup('X公式・名前ソート',          imgGroups.x_by_name,      L.key, sel)
        + _renderGroup('X公式・時間ソート',          imgGroups.x_by_time,      L.key, sel)
        + _renderGroup('X公式・時間ソート (Away)',   imgGroups.x_by_time_away, L.key, sel)
        + _renderGroup('Wikimedia Commons',          imgGroups.wikimedia,      L.key, sel);
      if (!body) body = '<div class="s35-empty">画像が取得できませんでした（チーム解決失敗 or 該当なし）。📤 手動アップロードから追加できる</div>';
    }

    const slideStr = (L.slidesUsing || []).map(i => '#' + (i + 1)).join(', ');

    return ''
      + '<div class="panel" data-label-key="' + _esc(L.key) + '" style="margin-bottom:14px;">'
      +   '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap;">'
      +     '<span class="s35-rolebadge ' + _roleClass(L.role) + '">' + _esc(_roleJa(L.role)) + '</span>'
      +     '<span style="font-size:14px;font-weight:bold;color:#7dc8ff">' + _esc(L.displayName || L.key) + '</span>'
      +     '<span style="font-size:10px;color:#5a6a8a;font-family:monospace;">' + _esc(L.key) + '</span>'
      +     '<span style="font-size:11px;color:#8a9aba">使用スライド: ' + _esc(slideStr || '(なし)') + '</span>'
      +     '<span style="flex:1"></span>'
      +     btnHTML
      +     upHTML
      +     '<span class="s35-sel-count" style="font-size:11px;color:#10b981;">' + sel.length + ' 枚選択中</span>'
      +   '</div>'
      +   body
      + '</div>';
  }

  function _renderGroup(label, paths, key, sel) {
    if (!paths || !paths.length) return '';
    return ''
      + '<div style="margin-bottom:10px;">'
      +   '<div class="s35-grouplabel">' + _esc(label) + ' <span style="color:#5a6a8a;font-weight:normal">(' + paths.length + '枚)</span></div>'
      +   '<div class="s35-grid">'
      +     paths.map(p => {
            const isSel = sel.includes(p);
            return '<div class="s35-thumb' + (isSel ? ' selected' : '') + '" data-key="' + _esc(key) + '" data-path="' + _esc(p) + '">'
              + '<img src="' + _esc(p) + '" loading="lazy">'
              + (isSel ? '<div class="check">✓</div>' : '')
              + '</div>';
          }).join('')
      +   '</div>'
      + '</div>';
  }

  /* ── イベント委譲（再取得・手動アップロード・トグル） ── */
  document.addEventListener('click', function(e) {
    const fb = e.target.closest('.s35-fetch-btn');
    if (fb) { window.s35Fetch(fb.getAttribute('data-key')); return; }
    const ub = e.target.closest('.s35-upload-btn');
    if (ub) { window.s35Upload(ub.getAttribute('data-key')); return; }
    const th = e.target.closest('#s35LabelList .s35-thumb');
    if (th) {
      const key  = th.getAttribute('data-key');
      const path = th.getAttribute('data-path');
      window.s35Toggle(key, path);
    }
  });

  /* ── 手動アップロード ─────────────────────────── */
  let _s35UploadKey = null;
  window.s35Upload = function(key) {
    _s35UploadKey = key;
    let inp = document.getElementById('s35-upload-input');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 's35-upload-input';
      inp.accept = 'image/png,image/jpeg,image/webp';
      inp.style.display = 'none';
      inp.onchange = window.s35HandleUpload;
      document.body.appendChild(inp);
    }
    inp.click();
  };
  window.s35HandleUpload = async function(ev) {
    const file = (ev.target.files || [])[0];
    const key  = _s35UploadKey;
    _s35UploadKey = null;
    ev.target.value = '';
    if (!file || !key) return;
    const post = window.APP.selected;
    if (!post?.id) { alert('案件未選択だよ'); return; }
    _msg('⏳ アップロード中: ' + file.name);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(new Error('読込失敗'));
        r.readAsDataURL(file);
      });
      const r = await fetchJson('/api/v35/upload-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, label: key, filename: file.name, dataUrl }),
      });
      _msg('✅ アップロード完了: ' + r.file);
      // 該当ラベルだけ再 fetch して manual グループに反映
      await window.s35Fetch(key);
    } catch (e) {
      _msg('❌ アップロード失敗: ' + e.message);
    }
  };

  /* ── 画像取得 (1ラベル) ── */
  window.s35Fetch = async function(key) {
    const post = window.APP.selected;
    if (!post?.id || !key) return;
    _msg('⏳ 画像取得中... (' + _esc(key) + ')');
    try {
      const r = await fetchJson('/api/v35/fetch-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, label: key }),
      });
      window.APP.s35.images[key] = r.images || {};
      _msg('✅ 取得完了 (' + (r.total || 0) + '枚 / team=' + _esc(r.teamName || '?') + ')');
    } catch (e) {
      _msg('❌ 取得失敗: ' + e.message);
    }
    _renderLabels();
  };

  /* ── 選択トグル ──
     全ラベル再描画すると <img> が一斉に再生成され、ブラウザのキャッシュ反映前は
     背景の #000 が透けて他サムネが「真っ黒」に見えるため、
     該当サムネのクラスとカウンタだけを部分更新する。 */
  window.s35Toggle = function(key, path) {
    const cur = window.APP.s35.selections[key] || [];
    const i   = cur.indexOf(path);
    const willSelect = (i < 0);
    if (willSelect) cur.push(path);
    else            cur.splice(i, 1);
    window.APP.s35.selections[key] = cur;
    _updateThumbState(key, path, willSelect);
    _updateLabelCounter(key);
  };

  function _updateThumbState(key, path, isSelected) {
    const list = document.getElementById('s35LabelList');
    if (!list) return;
    const thumbs = list.querySelectorAll('.s35-thumb');
    for (const th of thumbs) {
      if (th.getAttribute('data-key') !== key) continue;
      if (th.getAttribute('data-path') !== path) continue;
      if (isSelected) {
        th.classList.add('selected');
        if (!th.querySelector('.check')) {
          const c = document.createElement('div');
          c.className = 'check';
          c.textContent = '✓';
          th.appendChild(c);
        }
      } else {
        th.classList.remove('selected');
        const c = th.querySelector('.check');
        if (c) c.remove();
      }
    }
  }

  function _updateLabelCounter(key) {
    const panel = document.querySelector('[data-label-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')) + '"]');
    if (!panel) return;
    const cnt = panel.querySelector('.s35-sel-count');
    if (cnt) {
      const sel = window.APP.s35.selections[key] || [];
      cnt.textContent = sel.length + ' 枚選択中';
    }
  }

  /* ── ボタン: 全ラベル一括取得 ── */
  document.getElementById('s35BtnFetchAll')?.addEventListener('click', async () => {
    const labels = window.APP.s35.labels || [];
    if (!labels.length) { _msg('ラベルがありません'); return; }
    if (!confirm('全 ' + labels.length + ' ラベルの画像を取得します（' + (labels.length * 3) + '回前後のAPIコール）。OK?')) return;
    for (const L of labels) {
      await window.s35Fetch(L.key);
    }
    _msg('✅ 全ラベル取得完了 (' + labels.length + '件)');
  });

  /* ── ボタン: 選択を保存 ── */
  document.getElementById('s35BtnSave')?.addEventListener('click', async () => {
    const post = window.APP.selected;
    if (!post?.id) { _msg('案件未選択'); return; }
    try {
      await fetchJson('/api/v35/save-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, selections: window.APP.s35.selections }),
      });
      _msg('✅ 保存完了');
    } catch (e) {
      _msg('❌ 保存失敗: ' + e.message);
    }
  });

})();</script>`;
}

module.exports = { router, getUI, fetchImagesForLabel };
