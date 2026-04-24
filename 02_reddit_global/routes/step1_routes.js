// routes/step1_routes.js
// ═══════════════════════════════════════════════════════
// STEP 1: 案件選択
// このファイルのみ編集することで Step1 の挙動・表示を変更できます。
// 他の Step ファイルへの依存: なし
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router   = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVED_FILE = path.join(DATA_DIR, 'saved_projects.json');

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
router.get('/saved-projects', (req, res) => {
  res.json(safeJson(SAVED_FILE, []));
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
      <span id="s1Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- 案件一覧（アコーディオン） -->
  <div id="s1List"></div>

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

})();
</script>`;
}

module.exports = { router, getUI };
