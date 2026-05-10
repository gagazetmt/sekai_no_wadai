// routes/step1_routes.js
// ═══════════════════════════════════════════════════════
// STEP 1: 案件選択
// このファイルのみ編集することで Step1 の挙動・表示を変更できます。
// 他の Step ファイルへの依存: なし
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, '..', 'data');
const SAVED_FILE = path.join(DATA_DIR, 'saved_projects.json');
const VIDEO_DIR = path.join(DATA_DIR, 'v2_videos');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── ユーティリティ ───────────────────────────────────────
function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('[Step1] JSON読み込みエラー:', file, e.message);
    return fallback;
  }
}

// JST の今日（YYYY-MM-DD）
function todayJst() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 案件IDから動画生成済みかを判定（動画ファイル prefix 一致）
function _videoFilesCache() {
  try { return fs.readdirSync(VIDEO_DIR).filter(f => f.endsWith('.mp4')); }
  catch (_) { return []; }
}
function hasGeneratedVideo(postId, files) {
  if (!postId) return false;
  const prefix = String(postId).replace(/[\/\?%*:|"<>\.]/g, '_').slice(-20);
  if (!prefix) return false;
  return files.some(f => f.startsWith(prefix));
}

// ─── API ─────────────────────────────────────────────────

// 案件一覧取得（stories_YYYY_MM_DD.json → 正規化して返す）
router.get('/content', (req, res) => {
  const d = req.query.date;
  if (!d) return res.status(400).json({ error: 'date パラメータが必要です' });

  const file = path.join(DATA_DIR, `stories_${d.replace(/-/g, '_')}.json`);
  const data = safeJson(file, { posts: [] });

  const posts = (data.posts || []).map((p, i) => ({
    idx:       i,
    id:        p.id || String(i),
    title:     p.titleJa || p.title || '(タイトル不明)',
    titleOrig: p.title || '',
    addedAt:   p.added_at || p.addedAt
               || (p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null),
    source:    p.source || 'reddit',
    score:     p.score  || 0,
    raw:       p,
  }));

  res.json({ posts });
});

// 保存済み案件取得
// ※自動クリーンアップ：①addedAtが今日(JST)より前の案件 ②動画生成済みの案件 を除外
//   ただし custom 案件（id が custom_ で始まる）は日付フィルタをスキップ（複数日跨ぎで作業可能）
router.get('/saved-projects', (req, res) => {
  const all = safeJson(SAVED_FILE, []);
  if (!Array.isArray(all) || !all.length) return res.json(all || []);

  const today = todayJst();
  const videos = _videoFilesCache();
  const filtered = all.filter(p => {
    const isCustom = String(p.id || p.source || '').startsWith('custom') || p.source === 'custom';
    const addedDate = (p.addedAt || '').slice(0, 10);
    if (!isCustom && addedDate && addedDate < today) return false;  // 古い日付（custom は除く）
    if (hasGeneratedVideo(p.id, videos)) return false;               // 動画生成済み
    return true;
  });

  // 件数が変わっていれば永続化
  if (filtered.length !== all.length) {
    try { fs.writeFileSync(SAVED_FILE, JSON.stringify(filtered, null, 2)); }
    catch (e) { console.error('[Step1] saved-projects 自動クリーンアップ書込失敗:', e.message); }
  }
  res.json(filtered);
});

// 保存済み案件更新
router.post('/saved-projects', (req, res) => {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SAVED_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    console.error('[Step1] 保存エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// カスタム案件作成（Reddit 起点でない独自テーマで動画作成するため）
//   入力: { title (必須), note (任意) }
//   出力: 仮想 postId 付きの project 1 件、saved_projects.json に append
function _customPostId(title) {
  const now = new Date(Date.now() + 9 * 3600_000);
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, '');
  const hm  = now.toISOString().slice(11, 16).replace(':', '');
  const ascii = String(title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  const slug = ascii.length >= 3 ? ascii : Math.random().toString(36).slice(2, 8);
  return `custom_${ymd}_${hm}_${slug}`;
}

router.post('/create-custom-project', (req, res) => {
  try {
    const { title, note } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title required' });
    }
    const cleanTitle = String(title).trim().slice(0, 200);
    const cleanNote  = String(note || '').trim().slice(0, 500);
    const id = _customPostId(cleanTitle);
    const now = new Date().toISOString();
    const newProj = {
      id,
      title:    cleanTitle,
      titleOrig: '',
      addedAt:  now,
      source:   'custom',
      score:    0,
      raw: {
        id,
        title:    cleanTitle,
        source:   'custom',
        isCustom: true,
        customNote: cleanNote,
        addedAt:  now,
      },
    };
    const all = safeJson(SAVED_FILE, []);
    const list = Array.isArray(all) ? all : [];
    list.push(newProj);
    fs.writeFileSync(SAVED_FILE, JSON.stringify(list, null, 2));
    res.json({ ok: true, project: newProj });
  } catch (e) {
    console.error('[Step1] create-custom-project エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── UI（このファイルを触るだけで Step1 表示が変わる）──────

function getUI() {
  return /* html */`
<div id="step1" class="step-container">

  <!-- 操作パネル -->
  <div class="panel">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
      <input type="date" id="s1Date" class="inp">
      <button class="btn btn-primary" onclick="s1Load()">📡 案件読込</button>
      <button class="btn btn-success" onclick="s1Save()">💾 選択を保存</button>
      <button class="btn" onclick="s1OpenCustom()" style="background:#7c3aed;color:#fff;">✨ カスタム案件作成</button>
      <span id="s1Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- 案件一覧（アコーディオン） -->
  <div id="s1List"></div>

  <!-- カスタム案件作成 モーダル -->
  <div id="s1CustomModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:1000; align-items:center; justify-content:center;">
    <div style="background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:24px; width:min(520px, 92vw); box-shadow:0 10px 40px rgba(0,0,0,0.5);">
      <h3 style="margin:0 0 6px 0; color:#a78bfa; font-size:18px;">✨ カスタム案件作成</h3>
      <p style="margin:0 0 16px 0; font-size:11px; color:var(--muted);">Reddit に該当が無い独自テーマで動画を作るためのエントリ。Step2 以降の流れは Reddit 案件と同じ（reaction スライドは自動省略）。</p>
      <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px;">動画タイトル <span style="color:#ff4d4d;">*</span></label>
      <input type="text" id="s1cmTitle" class="inp" maxlength="200" placeholder="例: 久保建英 今季総括 / W杯メンバー予想 / Big6 監督ランキング" style="width:100%; margin-bottom:12px;">
      <label style="display:block; font-size:11px; color:var(--muted); margin-bottom:4px;">補足メモ（任意・Step3 で AI が参考にする）</label>
      <textarea id="s1cmNote" class="inp" rows="3" maxlength="500" placeholder="例: La Liga 残り3節での久保評価。比較対象は伊東純也・南野拓実・三笘薫" style="width:100%; resize:vertical; margin-bottom:18px;"></textarea>
      <div style="display:flex; gap:10px; justify-content:flex-end;">
        <button class="btn btn-sm" onclick="s1CloseCustom()">キャンセル</button>
        <button class="btn" onclick="s1SubmitCustom()" style="background:#7c3aed;color:#fff;">✨ 作成 → サイドバー追加</button>
      </div>
    </div>
  </div>

</div>

<script>
(function() {
  /* === Step1 スコープ（他 Step に干渉しない） === */

  window.step1Init = function() {
    document.getElementById('s1Date').value = new Date().toISOString().slice(0, 10);
    s1Load();
  };

  window.s1Load = async function() {
    const d = document.getElementById('s1Date').value;
    if (!d) return;
    _s1Msg('⏳ 読込中...');
    try {
      const data = await fetchJson('/api/content?date=' + d);
      window.APP.posts    = data.posts || [];
      window.APP.postMap  = {};
      window.APP.posts.forEach((p, i) => { window.APP.postMap[p.id] = p; });
      _s1Render(window.APP.posts);
      _s1Msg(window.APP.posts.length + '件');
    } catch(e) {
      _s1Msg('❌ 読込失敗: ' + e.message);
    }
  };

  function _s1Render(posts) {
    /* 時刻でグルーピング */
    const groups = {};
    posts.forEach((p, i) => {
      let t = '不明';
      const at = p.addedAt || '';
      if (at.includes('T'))      t = at.split('T')[1].slice(0, 5);
      else if (at.includes(':')) t = at.slice(0, 5);
      if (!groups[t]) groups[t] = [];
      groups[t].push({ p, i });
    });

    if (!Object.keys(groups).length) {
      document.getElementById('s1List').innerHTML =
        '<div style="padding:20px;color:#5a6a8a;text-align:center;">この日の案件はありません</div>';
      return;
    }

    const html = Object.keys(groups).sort().reverse().map(t => {
      const rows = groups[t].map(({ p, i }) => {
        const sel  = window.APP.selectedIds.has(p.id);
        const badge = p.source === '5ch'
          ? '<span class="src-badge badge-5ch">5ch</span>'
          : '<span class="src-badge badge-reddit">Reddit</span>';
        return '<div class="post-row' + (sel ? ' selected' : '') + '"'
          + ' data-idx="' + i + '" onclick="_s1Toggle(' + i + ',this)">'
          + '<input type="checkbox"' + (sel ? ' checked' : '') + ' onclick="event.stopPropagation();_s1Toggle(' + i + ',this.parentElement)">'
          + badge
          + '<span style="flex:1">' + _esc(p.title) + '</span>'
          + '</div>';
      }).join('');

      return '<div class="time-group">'
        + '<div class="time-summary" onclick="_s1Toggle_acc(this)">'
        + '🕒 ' + t + ' 取得分 (' + groups[t].length + '件)</div>'
        + '<div class="time-content" style="display:none;">' + rows + '</div>'
        + '</div>';
    }).join('');

    document.getElementById('s1List').innerHTML = html;
  }

  window._s1Toggle_acc = function(el) {
    const c = el.nextElementSibling;
    c.style.display = c.style.display === 'none' ? 'block' : 'none';
  };

  window._s1Toggle = function(idx, el) {
    const p = window.APP.posts[idx];
    if (!p) return;
    const chk = el.querySelector('input[type=checkbox]');
    if (window.APP.selectedIds.has(p.id)) {
      window.APP.selectedIds.delete(p.id);
      el.classList.remove('selected');
      if (chk) chk.checked = false;
    } else {
      window.APP.selectedIds.add(p.id);
      el.classList.add('selected');
      if (chk) chk.checked = true;
    }
  };

  window.s1Save = async function() {
    if (!window.APP.selectedIds.size) return alert('案件を選択してください');
    window.APP.selectedIds.forEach(id => {
      const p = window.APP.postMap[id];
      if (p && !window.APP.saved.find(x => x.id === id)) window.APP.saved.push(p);
    });
    try {
      await fetchJson('/api/saved-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(window.APP.saved),
      });
      window.APP.selectedIds = new Set();
      window.renderSidebar();
      _s1Msg('✅ ' + window.APP.saved.length + '件保存済み');
      s1Load();
    } catch(e) {
      _s1Msg('❌ 保存失敗');
    }
  };

  function _s1Msg(t) { document.getElementById('s1Msg').textContent = t; }
  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // ═══ ✨ カスタム案件作成 ═══
  window.s1OpenCustom = function() {
    document.getElementById('s1CustomModal').style.display = 'flex';
    setTimeout(() => document.getElementById('s1cmTitle').focus(), 50);
  };
  window.s1CloseCustom = function() {
    document.getElementById('s1CustomModal').style.display = 'none';
  };
  window.s1SubmitCustom = async function() {
    const title = document.getElementById('s1cmTitle').value.trim();
    if (!title) { alert('タイトル必須だよ'); return; }
    const note = document.getElementById('s1cmNote').value.trim();
    try {
      const r = await fetchJson('/api/create-custom-project', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title, note }),
      });
      // sidebar に即追加（再描画 + 自動選択）
      window.APP.saved = window.APP.saved || [];
      window.APP.saved.push(r.project);
      window.APP.selected = r.project;
      window.renderSidebar();
      // 入力 reset & close
      s1CloseCustom();
      document.getElementById('s1cmTitle').value = '';
      document.getElementById('s1cmNote').value  = '';
      _s1Msg('✅ カスタム案件作成: ' + r.project.id);
      // Step2 に遷移（既存の selectLead と同じ動線）
      window.APP.keywords = []; window.APP.siData = {}; window.APP.modules = []; window.APP.activeTab = 0;
      window.goStep(2);
    } catch (e) {
      alert('作成失敗: ' + e.message);
    }
  };
  // ESC でモーダル閉じる
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('s1CustomModal').style.display === 'flex') {
      s1CloseCustom();
    }
  });

})();
</script>`;
}

module.exports = { router, getUI };
