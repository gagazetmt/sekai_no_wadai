// routes/step4_routes.js
// ═══════════════════════════════════════════════════════
// STEP 4: シナリオ編集（指示書V2 #4）
// Phase 1: 骨格とタブUIのみ
//   - Step3で確定したモジュール一覧をタブ表示
//   - 選択モジュールの title/type/siBinding/scriptDir を表示
//   - ナレーション編集欄（UIのみ、API未接続）
//   - 一括生成・音声テスト・動画生成ボタンのスタブ
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router   = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}

function modulesPath(postId) {
  return path.join(DATA_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '_modules.json');
}

// ─── API（Phase 1: スタブのみ。実装は Phase 2 以降）───────

// 既存のモジュール構成を取得（Step3 が save-modules で保存したもの）
router.get('/v2/modules', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const data = safeJson(modulesPath(postId), { modules: [] });
  res.json(data);
});

// Phase 2 で実装: ナレーション一括生成（DeepSeek）
router.post('/v2/generate-scenario', (req, res) => {
  res.json({ ok: false, error: 'Phase 2 未実装' });
});

// Phase 3 で実装: 1モジュールのナレーション再生成
router.post('/v2/regen-narration', (req, res) => {
  res.json({ ok: false, error: 'Phase 3 未実装' });
});

// Phase 4 で実装: 背景画像候補取得
router.get('/v2/images', (req, res) => {
  res.json({ images: [], note: 'Phase 4 未実装' });
});

// Phase 5 で実装: 1モジュールの音声テスト（MiniMax）
router.post('/v2/tts-single', (req, res) => {
  res.status(501).json({ error: 'Phase 5 未実装' });
});

// ─── UI ─────────────────────────────────────────────────

function getUI() {
  return `
<div id="step4" class="step-container" style="display:none">

  <!-- トップパネル -->
  <div class="panel" style="margin-bottom:12px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <span id="s4Title" style="font-size:14px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">
        案件を選択してください
      </span>
      <button class="btn btn-primary" id="s4BtnGenAll" title="全モジュールのナレーションを一括生成">
        &#x1F4D6; 全ナレーション一括生成
      </button>
      <span id="s4Msg" style="font-size:12px;color:#8a9aba"></span>
    </div>
  </div>

  <!-- タブ行（Step3 と同じ並び）-->
  <div id="s4Tabs" style="display:flex;gap:3px;flex-wrap:wrap;"></div>

  <!-- モジュールエディタ -->
  <div id="s4Editor"
       style="background:var(--panel);border:1px solid var(--c);border-radius:0 12px 12px 12px;padding:20px;min-height:280px;margin-bottom:16px">
    <div style="color:#5a6a8a;text-align:center;padding:20px">
      Step3 でモジュールを確定した後、このStepで各モジュールの脚本を生成・編集します
    </div>
  </div>

  <!-- ボトム：次のステップへ -->
  <div style="display:flex;gap:8px">
    <button class="btn btn-success" id="s4BtnNext" style="flex:1;padding:13px;font-size:14px;font-weight:bold">
      &#x1F3AC; 動画生成・書き出し &#x2192;
    </button>
  </div>

</div>

<script>
(function() {
  /* ────────────── Step4 スコープ ────────────── */

  const TYPE_COLORS = {
    opening:'#ff4d4d', insight:'#1a6ef5', stats:'#10b981', reaction:'#f59e0b',
    profile:'#8b5cf6', comparison:'#ef4444', history:'#6366f1',
    matchcard:'#14b8a6', matchcenter:'#06b6d4', ending:'#64748b',
  };
  const TYPE_LABELS = {
    opening:'オープニング', insight:'キャッチコピー', stats:'スタッツ',
    reaction:'コメント反応', profile:'プロフィール', comparison:'対比',
    history:'ヒストリー', matchcard:'試合プレビュー',
    matchcenter:'試合詳細', ending:'エンディング',
  };

  window.APP = window.APP || {};
  window.APP.s4 = {
    activeTab: 0, // 現在選択中のモジュール index
  };

  /* ── 初期化（goStep(4) で呼ばれる）── */
  window.step4Init = function() {
    const post = window.APP.selected;
    document.getElementById('s4Title').textContent = post
      ? (post.title || '(タイトル不明)').slice(0, 80)
      : '← 左サイドバーの保存済み案件をクリックしてください';
    _s4Msg('');

    // Step3 から引き継いだモジュールがあれば使う。無ければサーバーから読み込む
    if (!window.APP.modules || !window.APP.modules.length) {
      if (post?.id) {
        fetchJson('/api/v2/modules?postId=' + encodeURIComponent(post.id))
          .then(function(d) {
            window.APP.modules = d.modules || [];
            _s4Render();
          })
          .catch(function() { _s4Render(); });
        return;
      }
    }
    _s4Render();
  };

  /* ── タブ + エディタを再描画 ── */
  function _s4Render() {
    _s4RenderTabs();
    _s4RenderEditor();
  }

  function _s4RenderTabs() {
    const tabs = document.getElementById('s4Tabs');
    const mods = window.APP.modules || [];
    if (!mods.length) { tabs.innerHTML = ''; return; }
    tabs.innerHTML = mods.map(function(m, i) {
      const col = TYPE_COLORS[m.type] || '#555';
      const act = (i === window.APP.s4.activeTab);
      return '<div class="s3-tab' + (act ? ' s3-tab-active' : '') + '"'
        + ' style="' + (act ? 'background:' + col + ';color:#fff;' : '') + '"'
        + ' onclick="s4Switch(' + i + ')">'
        + '<span style="font-size:9px;opacity:.8">S' + (i + 1) + '</span><br>'
        + '<span style="font-size:10px">' + _e((m.title || '').slice(0, 10)) + ((m.title || '').length > 10 ? '…' : '') + '</span>'
        + '</div>';
    }).join('');
  }

  function _s4RenderEditor() {
    const editor = document.getElementById('s4Editor');
    const mods = window.APP.modules || [];
    if (!mods.length) {
      editor.innerHTML = '<div style="color:#5a6a8a;padding:20px;text-align:center">Step3 で「シナリオ生成・画像取得開始」を押してください</div>';
      return;
    }
    const i = window.APP.s4.activeTab;
    const m = mods[i];
    if (!m) return;
    const col = TYPE_COLORS[m.type] || '#555';

    editor.innerHTML =
      // タイトル + タイプバッジ
      '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:14px;align-items:center">'
      + '<div>'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:3px">&#x1F4DD; スライドタイトル</div>'
      + '<div style="font-size:15px;font-weight:bold;color:#fff">' + _e(m.title || '') + '</div>'
      + '</div>'
      + '<div style="background:' + col + ';color:#fff;padding:6px 14px;border-radius:6px;font-size:11px;font-weight:bold">'
      + (m.type || '?').toUpperCase() + ' &middot; ' + _e(TYPE_LABELS[m.type] || '')
      + '</div>'
      + '</div>'

      // SIバインド
      + (m.siBinding
          ? '<div style="margin-bottom:10px;font-size:11px;color:#94a3b8">'
            + '&#x1F517; SIバインド: <span style="color:#fff;font-weight:bold">' + _e(m.siBinding) + '</span>'
            + '</div>'
          : '')

      // 脚本指示（Step3で決めたもの、参照のみ）
      + (m.scriptDir
          ? '<div style="background:#0d1220;border-radius:8px;padding:10px;margin-bottom:14px">'
            + '<div style="font-size:10px;color:#f59e0b;margin-bottom:4px">&#x1F3AD; 脚本指示（Step3）</div>'
            + '<div style="font-size:12px;color:#c0cce0;line-height:1.5">' + _e(m.scriptDir) + '</div>'
            + '</div>'
          : '')

      // ナレーション編集欄
      + '<div style="margin-bottom:14px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">'
      + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F4E2; ナレーション本文</span>'
      + '<button class="btn btn-sm" id="s4BtnRegen" onclick="s4RegenNarration()">&#x21BB; このモジュールを再生成</button>'
      + '</div>'
      + '<textarea id="s4Narration" class="inp" rows="6"'
      + ' placeholder="「全ナレーション一括生成」を押すと DeepSeek が脚本本文を書き込みます..."'
      + ' style="width:100%;font-size:13px;line-height:1.6;resize:vertical">' + _e(m.narration || '') + '</textarea>'
      + '</div>'

      // プレースホルダー：背景画像（Phase 4）+ 音声テスト（Phase 5）
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;text-align:center;color:#5a6a8a;font-size:11px">'
      + '&#x1F5BC; 背景画像選択<br><span style="font-size:10px">Phase 4 で実装</span>'
      + '</div>'
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;text-align:center;color:#5a6a8a;font-size:11px">'
      + '&#x1F50A; 音声テスト<br><span style="font-size:10px">Phase 5 で実装</span>'
      + '</div>'
      + '</div>'

      // 位置表示
      + '<div style="margin-top:10px;font-size:10px;color:#5a6a8a">モジュール ' + (i + 1) + ' / ' + mods.length + '</div>';
  }

  /* ── タブ切替 ── */
  window.s4Switch = function(i) {
    _s4SaveCurrent();
    window.APP.s4.activeTab = i;
    _s4Render();
  };

  function _s4SaveCurrent() {
    const i = window.APP.s4.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const n = document.getElementById('s4Narration');
    if (n) m.narration = n.value;
  }

  /* ── スタブ実装（Phase 2〜で差し替え）── */
  window.s4RegenNarration = function() {
    _s4Msg('&#x23F3; Phase 3 で実装予定（1モジュールの再生成）');
  };

  document.addEventListener('click', function(e) {
    if (e.target.id === 's4BtnGenAll') {
      _s4Msg('&#x23F3; Phase 2 で実装予定（DeepSeek で全ナレーション一括生成）');
    } else if (e.target.id === 's4BtnNext') {
      _s4SaveCurrent();
      _s4Msg('&#x23F3; Phase 6 で Step5 へ遷移予定');
    }
  });

  /* ヘルパー */
  function _s4Msg(t) { const el = document.getElementById('s4Msg'); if (el) el.innerHTML = t; }
  function _e(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

})();
</script>`;
}

module.exports = { router, getUI };
