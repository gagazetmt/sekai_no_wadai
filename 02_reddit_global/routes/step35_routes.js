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

// "entity:Jude Bellingham" → { type: 'entity', entity: 'Jude Bellingham' }
// "matchcard:home_vs_away" → { type: 'matchcard', entity: 'home_vs_away' }
// "opening" / "ending" → { type: 'opening', entity: '' }
function parseMainKey(mainKey) {
  if (!mainKey) return { type: 'unknown', entity: '' };
  const idx = mainKey.indexOf(':');
  if (idx < 0) return { type: mainKey, entity: '' };
  return { type: mainKey.slice(0, idx).trim(), entity: mainKey.slice(idx + 1).trim() };
}

// type:"entity" の場合、si から role (player/manager/team) を推測する
//   - si.boxes.entity.items[].role を優先
//   - si に該当 entity がない場合は team_x_accounts.json と照合 (team判定)
function inferEntityRole(si, entityName) {
  if (!entityName) return null;
  const items = si?.boxes?.entity?.items || [];
  const item = findEntityItem(items, entityName);
  if (item?.role) return item.role;
  // フォールバック: チームマップに entity 名があれば team 扱い
  try {
    const fs = require('fs');
    const path = require('path');
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

// 部分一致でも entity item を見つける
function findEntityItem(items, entityName) {
  if (!items?.length || !entityName) return null;
  const en = entityName.toLowerCase().trim();
  // 完全一致を優先
  let hit = items.find(it => (it.label || '').toLowerCase() === en);
  if (hit) return hit;
  // 部分一致（label が entityName を含む or 逆）
  hit = items.find(it => {
    const lab = (it.label || '').toLowerCase();
    return lab.includes(en) || en.includes(lab);
  });
  return hit || null;
}

// si_data (V3 boxes構造) から選手・監督の所属チーム名を解決
//   優先順位:
//     1. 該当 entity の sofa.team / sofa.player.team から取る (理想形)
//     2. wiki.extract から team_x_accounts のキーで部分マッチ (本命)
//     3. 同じ post 内の role: "team" entity を使う (フォールバック)
function resolveTeamForEntity(si, entityName) {
  if (!si || !entityName) return null;
  const items = si?.boxes?.entity?.items || [];
  if (!items.length) return null;

  const target = findEntityItem(items, entityName);

  // Step 1: sofa が成功してれば、そこから取得
  if (target?.sofa?.ok) {
    const t = target.sofa.team?.name
           || target.sofa.player?.team?.name
           || target.sofa.data?.team?.name
           || target.sofa.club
           || null;
    if (t) return t;
  }

  // Step 2: wiki.extract から team_x_accounts のキーで照合 (一番正確)
  if (target?.wiki?.extract) {
    try {
      const fs   = require('fs');
      const path = require('path');
      const mapPath = path.join(__dirname, '..', 'logos', 'team_x_accounts.json');
      const map  = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      const teams = map.teams || {};
      const extract = target.wiki.extract;
      // 長い名前から先にマッチ（"Real Madrid" を "Real" より優先）
      const teamNames = Object.keys(teams).sort((a, b) => b.length - a.length);
      for (const name of teamNames) {
        if (extract.includes(name)) return name;
      }
    } catch (_) { /* skip */ }
  }

  // Step 3: 同じ post に role:"team" の entity があれば使う（曖昧フォールバック）
  const teamItems = items.filter(it => it.role === 'team');
  if (teamItems.length) return teamItems[0].label;

  return null;
}

// si_data から最新の match の kickoff (ISO) を抽出
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

// si_data から match の 両チーム名を取得
function resolveMatchTeams(si) {
  const items = si?.boxes?.match?.items || [];
  for (const m of items) {
    const sofa = m.sofa || m;
    const home = sofa.homeTeam?.name || sofa.home?.name || sofa.homeName;
    const away = sofa.awayTeam?.name || sofa.away?.name || sofa.awayName;
    if (home || away) return [home, away].filter(Boolean);
  }
  // フォールバック: entity から role:"team" を2つ取る
  const teamItems = (si?.boxes?.entity?.items || []).filter(it => it.role === 'team');
  return teamItems.slice(0, 2).map(it => it.label);
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

    // --- type が "entity" なら role を si から推測 ---
    //   実際のmainKey形式は "entity:<label>" で role情報なし。si.boxes.entity.items から引く。
    let effectiveType = type;
    if (type === 'entity') {
      const inferred = inferEntityRole(si, entity);
      effectiveType = inferred || 'entity';   // 推測失敗なら 'entity' のまま (X名前/時間ソートはスキップ)
    }

    // --- チーム名と試合時刻を解決 ---
    let teamName     = null;
    let teamNameAway = null;       // match の場合は2つ目のチーム
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
    } else if (effectiveType === 'news') {
      // news は entity にキーワード入る想定。X名前ソートは実行不可。
    } else if (effectiveType === 'entity') {
      // role 推測失敗 = チーム解決不能。Wikimedia のみ実行。
    }

    // --- 並列取得タスク組み立て ---
    const tasks = [];

    // 1. X 名前ソート（player/manager のみ）
    if ((effectiveType === 'player' || effectiveType === 'manager') && teamName && entity) {
      tasks.push(
        fetchOfficialXImagesByName(teamName, entity, '', 10, { outDir })
          .then(paths => ({ source: 'x_by_name', paths }))
          .catch(e => { console.warn('[x_by_name]', e.message); return { source: 'x_by_name', paths: [] }; })
      );
    } else {
      tasks.push(Promise.resolve({ source: 'x_by_name', paths: [] }));
    }

    // 2. X 時間ソート（teamName が解決できた場合）
    if (teamName) {
      tasks.push(
        fetchOfficialXImagesByTime(teamName, '', 10, { outDir, matchKickoff })
          .then(paths => ({ source: 'x_by_time', paths }))
          .catch(e => { console.warn('[x_by_time]', e.message); return { source: 'x_by_time', paths: [] }; })
      );
    } else {
      tasks.push(Promise.resolve({ source: 'x_by_time', paths: [] }));
    }

    // 3. match の場合は away も時間ソート
    if (teamNameAway) {
      tasks.push(
        fetchOfficialXImagesByTime(teamNameAway, 'away', 10, { outDir, matchKickoff })
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
      effectiveType,
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

// ─── UI: Step3.5 タブのHTML+CSS+JS を返す ──────────────────
function getUI() {
  return `
<div id="step35" class="step-container" style="display:none">
<div style="padding:0 20px 20px;">

  <!-- TOP PANEL -->
  <div class="panel" style="margin-bottom:14px;">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <span id="s35Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">案件を選択してください</span>
      <button class="btn btn-sm" id="s35BtnFetchAll" style="background:#3b82f6;color:#fff;">📥 全カード一括取得</button>
      <button class="btn btn-sm" id="s35BtnSave" style="background:#10b981;color:#fff;">💾 選択を保存</button>
      <button class="btn btn-success" id="s35BtnNext" style="font-size:13px;padding:8px 18px;">→ Step4 (動画生成)</button>
      <span id="s35Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
    <div style="font-size:11px;color:#8a9aba;margin-top:6px;">📸 各カードの mainKey に応じて X公式 (名前/時間ソート) + Wikimedia から画像を取得し、サムネをクリックして選択。動画背景に使われる。</div>
  </div>

  <!-- カード別エリア -->
  <div id="s35CardList"></div>

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
</style>

<script>(function(){
  'use strict';

  window.APP = window.APP || {};
  window.APP.s35 = { modules: [], images: {}, selections: {} };

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _msg(s) { const e = document.getElementById('s35Msg'); if (e) e.innerHTML = s; }

  /* ── 初期化 (goStep(35) で呼ばれる) ── */
  window.step35Init = async function() {
    const post = window.APP.selected;
    document.getElementById('s35Title').textContent = post
      ? (post.titleJa || post.title || '(タイトル不明)').slice(0, 80)
      : '案件を選択してください';
    if (!post?.id) { window.APP.s35.modules = []; _renderCards(); return; }

    try {
      // modules 読込
      const m = await fetchJson('/api/v3/modules?postId=' + encodeURIComponent(post.id));
      window.APP.s35.modules = m.modules || [];
      // 既存選択読込
      const s = await fetchJson('/api/v35/get-selection?postId=' + encodeURIComponent(post.id));
      window.APP.s35.selections = s.selections || {};
    } catch (e) {
      console.warn('[Step3.5] init failed:', e.message);
    }
    _renderCards();
  };

  /* ── カード一覧描画 ── */
  function _renderCards() {
    const el = document.getElementById('s35CardList');
    if (!el) return;
    const mods = window.APP.s35.modules || [];
    if (!mods.length) {
      el.innerHTML = '<div class="s35-empty">Step3 でモジュールを作成してから戻ってきてください。</div>';
      return;
    }
    el.innerHTML = mods.map((m, idx) => _renderCard(m, idx)).join('');
  }

  function _renderCard(m, idx) {
    const mainKey  = m.mainKey || '';
    const imgGroups = window.APP.s35.images[idx];
    const sel       = window.APP.s35.selections[idx] || [];

    const btnLabel = imgGroups ? '🔄 再取得' : '📥 画像取得';
    const btnHTML  = '<button class="btn btn-sm" onclick="s35Fetch(' + idx + ')" style="background:#3b82f6;color:#fff;">' + btnLabel + '</button>';

    let body = '';
    if (imgGroups) {
      body =
          _renderGroup('X公式・名前ソート',          imgGroups.x_by_name,      idx, sel)
        + _renderGroup('X公式・時間ソート',          imgGroups.x_by_time,      idx, sel)
        + _renderGroup('X公式・時間ソート (Away)',   imgGroups.x_by_time_away, idx, sel)
        + _renderGroup('Wikimedia Commons',          imgGroups.wikimedia,      idx, sel);
      if (!body) body = '<div class="s35-empty">画像が取得できませんでした（チーム解決失敗 or 該当なし）</div>';
    }

    return ''
      + '<div class="panel" style="margin-bottom:14px;">'
      +   '<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">'
      +     '<span style="background:var(--c);padding:3px 8px;border-radius:4px;font-size:11px;color:#fff;font-weight:bold;">#' + (idx+1) + '</span>'
      +     '<span style="font-size:13px;font-weight:bold;color:#7dc8ff">' + _esc(mainKey || '(空)') + '</span>'
      +     '<span style="font-size:11px;color:#8a9aba">' + _esc(m.title || m.type || '') + '</span>'
      +     '<span style="flex:1"></span>'
      +     btnHTML
      +     '<span style="font-size:11px;color:#10b981;">' + sel.length + ' 枚選択中</span>'
      +   '</div>'
      +   body
      + '</div>';
  }

  function _renderGroup(label, paths, idx, sel) {
    if (!paths || !paths.length) return '';
    return ''
      + '<div style="margin-bottom:10px;">'
      +   '<div class="s35-grouplabel">' + _esc(label) + ' <span style="color:#5a6a8a;font-weight:normal">(' + paths.length + '枚)</span></div>'
      +   '<div class="s35-grid">'
      +     paths.map(p => {
            const isSel = sel.includes(p);
            return '<div class="s35-thumb' + (isSel ? ' selected' : '') + '" onclick="s35Toggle(' + idx + ', \\'' + p.replace(/'/g, "\\\\'") + '\\')">'
              + '<img src="' + p + '" loading="lazy">'
              + (isSel ? '<div class="check">✓</div>' : '')
              + '</div>';
          }).join('')
      +   '</div>'
      + '</div>';
  }

  /* ── 画像取得 (1カード) ── */
  window.s35Fetch = async function(idx) {
    const post = window.APP.selected;
    const m    = window.APP.s35.modules[idx];
    if (!post?.id || !m) return;
    _msg('⏳ 画像取得中... (#' + (idx+1) + ')');
    try {
      const r = await fetchJson('/api/v35/fetch-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, moduleIdx: idx, mainKey: m.mainKey || '' }),
      });
      window.APP.s35.images[idx] = r.images || {};
      _msg('✅ #' + (idx+1) + ' 取得完了 (' + (r.total || 0) + '枚 / team=' + _esc(r.teamName || '?') + ')');
    } catch (e) {
      _msg('❌ #' + (idx+1) + ' 取得失敗: ' + e.message);
    }
    _renderCards();
  };

  /* ── 選択トグル ── */
  window.s35Toggle = function(idx, path) {
    const cur = window.APP.s35.selections[idx] || [];
    const i = cur.indexOf(path);
    if (i >= 0) cur.splice(i, 1);
    else        cur.push(path);
    window.APP.s35.selections[idx] = cur;
    _renderCards();
  };

  /* ── ボタン: 全カード一括取得 ── */
  document.getElementById('s35BtnFetchAll')?.addEventListener('click', async () => {
    const mods = window.APP.s35.modules || [];
    if (!mods.length) { _msg('カードがありません'); return; }
    if (!confirm('全 ' + mods.length + ' カードの画像を取得します（' + (mods.length * 3) + '回前後のAPIコール）。OK?')) return;
    for (let i = 0; i < mods.length; i++) {
      await window.s35Fetch(i);
    }
    _msg('✅ 全カード取得完了 (' + mods.length + '件)');
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

  /* ── ボタン: Step4 へ ── */
  document.getElementById('s35BtnNext')?.addEventListener('click', () => {
    if (typeof window.goStep === 'function') window.goStep(4);
  });

})();</script>`;
}

module.exports = { router, getUI };
