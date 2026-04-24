// routes/step4_routes.js
// ═══════════════════════════════════════════════════════
// STEP 4: シナリオ編集（指示書V2 #4）
// Phase 2: ナレーション一括/単体生成（DeepSeek）実装
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const { callAI } = require('../scripts/ai_client');

const router   = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) { return fallback; }
}

function modulesPath(postId) {
  return path.join(DATA_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '_modules.json');
}

function siPath(postId) {
  return path.join(SI_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '.json');
}

// ─── 共通口調プリセット ─────────────────────────────────
const TONE_PRESET = `
【口調】熱量6/情報量4のバランス。
  - 熱狂実況（例:「やべぇぇぇ！」）が10、ニュース解説（例:「〜しました」）が0とすると 6 の熱量。
  - 断定口調で情報を正確に伝えつつ、視聴者の興奮を自然に煽る。
  - 同じ語尾の連発を避け、メリハリをつける。
  - 文末は「〜だ」「〜でしょう」「〜なんです」「〜！」など多様に。
  - 選手/チーム名は必ずカタカナ（例: Lionel Messi → リオネル・メッシ、Manchester City → マンチェスター・シティ）。`;

// ─── タイプ別ナレーション生成プロンプト ─────────────────
function buildPrompt(mod, siSummary) {
  const base = `あなたはプロのサッカーYouTubeチャンネルの脚本家。
${TONE_PRESET}

【スライド情報】
- タイトル: ${mod.title}
- タイプ: ${mod.type}
- 脚本指示: ${mod.scriptDir || '(なし)'}
- SIバインド: ${mod.siBinding || '(なし)'}

【取得済みSIデータ（該当ラベル分のみ）】
${siSummary || '(なし)'}
`;

  switch (mod.type) {
    case 'opening':
      return base + `
【生成ルール】
- タイトルコールとして1文 30〜50字で生成
- スライド冒頭で読み上げるインパクトのある問いかけ or 断定
- 例:「セビージャ、27年ぶりの降格危機！」

JSONのみ: {"narration": "..."}`;

    case 'insight': {
      const phrases = Array.isArray(mod.catchphrases) ? mod.catchphrases : [];
      return base + `
【キャッチコピー（catchphrases）】
${phrases.map((p, i) => '  ' + (i+1) + '. ' + p).join('\n') || '(なし)'}

【生成ルール】
- 各キャッチコピーに対応するナレーション断片を1対1で生成（合計 ${phrases.length} 個）
- 各chunk は 40〜70字で、そのキャッチコピーを深掘り解説する
- chunk 間でテンポよく繋がるように

JSONのみ: {"narrationChunks": [${phrases.map((_,i) => '"chunk' + (i+1) + '"').join(',')}]}`;
    }

    case 'stats':
      return base + `
【データスロット】
${(mod.dataSlots || []).map(s => '- ' + (s.label || '') + ': ' + (s.value || '')).join('\n') || '(なし)'}

【生成ルール】
- 80〜150字で、選手orチームの好調/不調をデータで裏付けて解説
- 数字を織り込み、パフォーマンス状態を詳細に述べる
- 「信じられない数字」「圧倒的」など感情的評価も入れる

JSONのみ: {"narration": "..."}`;

    case 'profile':
      return base + `
【データスロット】
${(mod.dataSlots || []).map(s => '- ' + (s.label || '') + ': ' + (s.value || '')).join('\n') || '(なし)'}

【生成ルール】
- 120〜180字で、選手/監督のプロフィールと魅力を深掘り
- データを軸に、キャリアや実力、期待感を語る

JSONのみ: {"narration": "..."}`;

    case 'comparison':
      return base + `
【対比データ】
左: ${mod.siBindingLeft || '(未指定)'}
右: ${mod.siBindingRight || '(未指定)'}
${(mod.dataSlots || []).map(s => '- ' + (s.label || '') + ': ' + (s.leftValue || '') + ' vs ' + (s.rightValue || '')).join('\n') || '(なし)'}

【生成ルール】
- 100〜150字で、各対比項目を順に比較しながら解説
- どちらが優位か明確に指摘、その理由もデータで補強
- 例:「ゴール数はAが大きく上回っています。チーム全体の好調がここにもあらわれていますね」

JSONのみ: {"narration": "..."}`;

    case 'reaction': {
      const coms = Array.isArray(mod.comments) ? mod.comments : [];
      return base + `
【コメント一覧】
${coms.map((c, i) => '  ' + (i+1) + '. ' + (c.text || '')).join('\n') || '(なし)'}

【生成ルール】
- まずスライド冒頭の導入ナレーション（40〜70字）を "narration" に
- その後、各コメントに対応する紹介ナレーション断片を "narrationChunks" に1対1で生成（合計 ${coms.length} 個）
- 各chunk は 15〜30字で、そのコメントを「視聴者に読ませる前の煽り」として短く

JSONのみ: {
  "narration": "導入ナレーション",
  "narrationChunks": [${coms.map((_, i) => '"chunk' + (i+1) + '"').join(',')}]
}`;
    }

    case 'history': {
      const chunks = Array.isArray(mod.catchphrases) && mod.catchphrases.length
        ? mod.catchphrases
        : (Array.isArray(mod.dataSlots) ? mod.dataSlots.map(s => (s.label || '') + (s.value ? ': '+s.value : '')) : []);
      return base + `
【イベント一覧（時系列）】
${chunks.map((e, i) => '  ' + (i+1) + '. ' + e).join('\n') || '(なし)'}

【生成ルール】
- 各イベントに対応するナレーション断片を1対1で生成（合計 ${chunks.length} 個）
- 各chunk は 30〜50字、象徴的な出来事を淡々と（熱量は抑えめ 4〜5）
- 「〇〇年、〜〜」の年号起点の淡々とした語り

JSONのみ: {"narrationChunks": [${chunks.map((_, i) => '"chunk' + (i+1) + '"').join(',')}]}`;
    }

    case 'matchcard':
      return base + `
【データスロット】
${(mod.dataSlots || []).map(s => '- ' + (s.label || '') + ': ' + (s.value || '')).join('\n') || '(なし)'}

【生成ルール】
- 80〜120字で、今後の試合予定を伝える
- 両チームの情報、見どころ、注目選手に触れて盛り上げる
- 試合への期待感を煽る

JSONのみ: {"narration": "..."}`;

    case 'matchcenter':
      return base + `
【データスロット】
${(mod.dataSlots || []).map(s => '- ' + (s.label || '') + ': ' + (s.value || '')).join('\n') || '(なし)'}

【生成ルール】
- 150〜200字で、試合のスコアと流れを一気に伝える
- オープニング直後に配置される想定。試合の山場や見所を早めに展開
- スタッツを軸に、試合展開のハイライトを解説

JSONのみ: {"narration": "..."}`;

    case 'ending':
      return base + `
【生成ルール】
- 30〜50字で、視聴者が「チャンネル登録したい」と思う締めくくり
- 次回への期待を残しつつ、感謝と登録促しを自然に

JSONのみ: {"narration": "..."}`;

    default:
      return base + `\nJSONのみ: {"narration": "汎用ナレーション80-120字"}`;
  }
}

// SI データを siBinding 関連分だけ圧縮してプロンプトに渡す
function buildSiSummaryForModule(mod, siData) {
  if (!siData?.boxes) return '';
  const keys = [];
  if (mod.siBinding)      keys.push(mod.siBinding);
  if (mod.siBindingLeft)  keys.push(mod.siBindingLeft);
  if (mod.siBindingRight) keys.push(mod.siBindingRight);
  if (!keys.length) return '';

  const pieces = [];
  Object.entries(siData.boxes).forEach(([boxType, box]) => {
    (box.fetched || []).forEach(f => {
      if (!keys.includes(f.label)) return;
      const d = f.data;
      if (!d || d.ok === false) return;
      // 各 box type で要点だけ抽出
      let summary;
      if (boxType === 'sofascore_player') {
        summary = `${f.label}(選手): pos=${d.position}, team=${d.team}, goals=${d.seasonStats?.goals}, assists=${d.seasonStats?.assists}, rating=${d.seasonStats?.rating}, xG=${d.seasonStats?.expectedGoals}, market=${d.marketValue}, age=${d.age}`;
      } else if (boxType === 'sofascore_team') {
        summary = `${f.label}(チーム): league=${d.leagueName}, 順位=${d.standing?.position}, 勝=${d.standing?.wins}, 敗=${d.standing?.losses}, pts=${d.standing?.points}, 監督=${d.managerName}`;
      } else if (boxType === 'sofascore_manager') {
        summary = `${f.label}(監督): 現チーム=${d.currentTeam}, 通算勝率=${d.overallPerformance?.winRate}%, フォーメーション=${d.preferredFormation}`;
      } else if (boxType === 'sofascore_match') {
        summary = `${f.label}(試合): ${d.scoreline}, ${d.matchDate}, ${d.tournament}, 得点=${(d.goals||[]).length}件`;
      } else if (boxType === 'wikipedia') {
        summary = `${f.label}(wiki): ${(d.extract || '').slice(0, 200)}`;
      } else {
        summary = `${f.label}(${boxType}): ${JSON.stringify(d).slice(0, 150)}`;
      }
      pieces.push(summary);
    });
  });
  return pieces.join('\n');
}

// AI 応答から JSON を寛容にパース
function tryParseJson(raw) {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[ --]/g, ' ')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); }
  catch (_) {
    try {
      const lastClose = m[0].lastIndexOf('}');
      if (lastClose > 0) return JSON.parse(m[0].slice(0, lastClose + 1));
    } catch (_) {}
    return null;
  }
}

// 1モジュールのナレーション生成
async function generateOneModule(mod, siSummary) {
  const prompt = buildPrompt(mod, siSummary);
  try {
    const raw = await callAI({
      model: 'claude-haiku-4-5-20251001', // DeepSeek 設定時は自動的に deepseek-chat が使われる
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const parsed = tryParseJson(raw);
    return parsed || { error: 'JSONパース失敗' };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── API ─────────────────────────────────────────────

// 既存のモジュール構成を取得（Step3 が save-modules で保存したもの）
router.get('/v2/modules', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const data = safeJson(modulesPath(postId), { modules: [] });
  res.json(data);
});

// Phase 2: 全モジュールのナレーション一括生成（DeepSeek 並列）
router.post('/v2/generate-scenario', async (req, res) => {
  const { postId, modules } = req.body;
  if (!postId || !Array.isArray(modules)) {
    return res.status(400).json({ error: 'postId + modules required' });
  }

  const siData = safeJson(siPath(postId), {});
  console.log(`[Step4] 一括ナレーション生成: ${modules.length}件`);

  // モジュール数だけ並列で生成（DeepSeek 側レート制限は十分余裕）
  const tasks = modules.map(async (mod, idx) => {
    const siSummary = buildSiSummaryForModule(mod, siData);
    const result    = await generateOneModule(mod, siSummary);
    return { idx, result };
  });

  const results = await Promise.all(tasks);
  const updated = modules.map(m => ({ ...m })); // shallow copy

  let successCount = 0;
  let failCount    = 0;
  results.forEach(({ idx, result }) => {
    if (result.error) {
      failCount++;
      console.warn(`  [${idx+1}] ${updated[idx].type} 失敗: ${result.error}`);
    } else {
      successCount++;
      if (typeof result.narration === 'string') updated[idx].narration = result.narration;
      if (Array.isArray(result.narrationChunks)) updated[idx].narrationChunks = result.narrationChunks;
    }
  });

  console.log(`[Step4] 一括生成完了: 成功 ${successCount} / 失敗 ${failCount}`);

  // 永続化（Step3と同じ modulesPath に書き戻す）
  try {
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules: updated, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) { console.warn('[Step4] 保存失敗:', e.message); }

  res.json({ ok: true, modules: updated, successCount, failCount });
});

// Phase 3: 1モジュールのナレーション再生成
router.post('/v2/regen-narration', async (req, res) => {
  const { postId, module: mod } = req.body;
  if (!postId || !mod) return res.status(400).json({ error: 'postId + module required' });
  const siData    = safeJson(siPath(postId), {});
  const siSummary = buildSiSummaryForModule(mod, siData);
  const result    = await generateOneModule(mod, siSummary);

  if (result.error) return res.status(500).json({ ok: false, error: result.error });
  res.json({
    ok: true,
    narration:       result.narration || null,
    narrationChunks: result.narrationChunks || null,
  });
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

  /* タイプ別にナレーション編集UIを組み立てる（chunk分割対応）*/
  function _buildNarrationUi(m) {
    // chunks連動タイプ: catchphrases / comments / history eventsと1対1のナレーション断片
    const needsChunks = ['insight', 'reaction', 'history'].includes(m.type);
    const needsMainNarration = !['history'].includes(m.type); // history は chunks のみ

    let html = '';

    // 【メインナレーション欄】
    if (needsMainNarration) {
      const caption = m.type === 'reaction' ? '導入ナレーション（冒頭）' : 'ナレーション本文';
      html += '<div style="margin-bottom:14px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px">'
        + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F4E2; ' + caption + '</span>'
        + '<button class="btn btn-sm" id="s4BtnRegen">&#x21BB; このモジュールを再生成</button>'
        + '</div>'
        + '<textarea id="s4Narration" class="inp" rows="' + (m.type === 'reaction' ? 3 : 6) + '"'
        + ' placeholder="「全ナレーション一括生成」を押すと DeepSeek が脚本本文を書き込みます..."'
        + ' style="width:100%;font-size:13px;line-height:1.6;resize:vertical">' + _e(m.narration || '') + '</textarea>'
        + '</div>';
    }

    // 【chunk 対応欄】catchphrases / comments / history
    if (needsChunks) {
      let items = [];
      let captionKey;
      if (m.type === 'insight') {
        items = Array.isArray(m.catchphrases) ? m.catchphrases : [];
        captionKey = 'キャッチコピー';
      } else if (m.type === 'reaction') {
        items = (Array.isArray(m.comments) ? m.comments : []).map(c => c.text || '');
        captionKey = 'コメント';
      } else if (m.type === 'history') {
        // history は catchphrases（イベント羅列）もしくは dataSlots を使う
        items = Array.isArray(m.catchphrases) && m.catchphrases.length
          ? m.catchphrases
          : (Array.isArray(m.dataSlots) ? m.dataSlots.map(s => (s.label || '') + (s.value ? ' / ' + s.value : '')) : []);
        captionKey = 'イベント';
      }
      const chunks = Array.isArray(m.narrationChunks) ? m.narrationChunks : [];

      if (!m.type === 'reaction') {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">'
          + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F9E9; chunk連動ナレーション</span>'
          + (!needsMainNarration
              ? '<button class="btn btn-sm" id="s4BtnRegen">&#x21BB; このモジュールを再生成</button>'
              : '')
          + '</div>';
      } else {
        html += '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:8px">&#x1F9E9; 各コメントに対する紹介ナレーション</div>';
      }

      if (!items.length) {
        html += '<div style="background:#0d1220;border-radius:8px;padding:12px;color:#5a6a8a;font-size:11px">'
          + 'Step3 で ' + captionKey + ' を先に登録してください'
          + '</div>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px">';
        items.forEach(function(item, i) {
          const chunk = chunks[i] || '';
          html += '<div style="background:#0d1220;border-left:3px solid ' + (TYPE_COLORS[m.type] || '#555') + ';border-radius:6px;padding:10px">'
            + '<div style="font-size:10px;color:#8a9aba;margin-bottom:4px">' + captionKey + ' ' + (i+1) + ':</div>'
            + '<div style="font-size:12px;color:#fbbf24;margin-bottom:6px;font-weight:bold">' + _e((item || '').slice(0, 120)) + '</div>'
            + '<textarea class="inp s4-chunk" data-idx="' + i + '" rows="2"'
            + ' placeholder="このchunkの連動ナレーション" '
            + ' style="width:100%;font-size:12px;line-height:1.5;resize:vertical">' + _e(chunk) + '</textarea>'
            + '</div>';
        });
        html += '</div>';
      }
    }

    return html;
  }

  function _s4RenderEditor() {
    const editor = document.getElementById('s4Editor');
    const mods = window.APP.modules || [];
    if (!mods.length) {
      editor.innerHTML = '<div style="color:#5a6a8a;padding:20px;text-align:center">Step3 で「モジュール確定」を押してからこちらへ遷移してください</div>';
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

      // 脚本指示
      + (m.scriptDir
          ? '<div style="background:#0d1220;border-radius:8px;padding:10px;margin-bottom:14px">'
            + '<div style="font-size:10px;color:#f59e0b;margin-bottom:4px">&#x1F3AD; 脚本指示（Step3）</div>'
            + '<div style="font-size:12px;color:#c0cce0;line-height:1.5">' + _e(m.scriptDir) + '</div>'
            + '</div>'
          : '')

      // ナレーション編集欄（タイプ別 chunk対応）
      + _buildNarrationUi(m)

      // プレースホルダー: 背景画像（Phase 4後）+ 音声テスト（Phase 5後）
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;text-align:center;color:#5a6a8a;font-size:11px">'
      + '&#x1F5BC; 背景画像選択<br><span style="font-size:10px">Step4完了後にまとめて実装</span>'
      + '</div>'
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;text-align:center;color:#5a6a8a;font-size:11px">'
      + '&#x1F50A; 音声テスト<br><span style="font-size:10px">MiniMax 連携で実装予定</span>'
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
    // chunks も DOM から拾う
    const chunkEls = document.querySelectorAll('.s4-chunk');
    if (chunkEls.length) {
      const chunks = Array.from(chunkEls).map(el => el.value);
      m.narrationChunks = chunks;
    }
  }

  /* ── 1モジュールのナレーション再生成 ── */
  window.s4RegenNarration = async function() {
    _s4SaveCurrent();
    const i = window.APP.s4.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const btn = document.getElementById('s4BtnRegen');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 再生成中...'; }
    _s4Msg('&#x1F504; ' + (m.title || '') + ' のナレーション再生成中...');

    try {
      const d = await fetchJson('/api/v2/regen-narration', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          postId: window.APP.selected?.id,
          module: m,
        }),
      });
      if (!d.ok) { _s4Msg('&#x274C; ' + (d.error || '失敗')); return; }
      if (typeof d.narration === 'string') m.narration = d.narration;
      if (Array.isArray(d.narrationChunks)) m.narrationChunks = d.narrationChunks;
      _s4Render();
      _s4Msg('&#x2705; ' + m.title + ' 再生成完了');
    } catch (e) {
      _s4Msg('&#x274C; 再生成エラー: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↻ このモジュールを再生成'; }
    }
  };

  /* ── 全モジュールのナレーション一括生成 ── */
  window.s4GenerateAll = async function() {
    _s4SaveCurrent();
    const mods = window.APP.modules || [];
    if (!mods.length) return alert('モジュールがありません');

    const btn = document.getElementById('s4BtnGenAll');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 一括生成中...（約15〜30秒）'; }
    _s4Msg('&#x1F4D6; 全' + mods.length + 'モジュールのナレーション生成中...');

    try {
      const d = await fetchJson('/api/v2/generate-scenario', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          postId:  window.APP.selected?.id,
          modules: mods,
        }),
      });
      if (!d.ok) { _s4Msg('&#x274C; ' + (d.error || '失敗')); return; }
      window.APP.modules = d.modules || mods;
      _s4Render();
      _s4Msg('&#x2705; 生成完了: 成功 ' + d.successCount + ' / 失敗 ' + d.failCount);
    } catch (e) {
      _s4Msg('&#x274C; 一括生成エラー: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📖 全ナレーション一括生成'; }
    }
  };

  /* ── イベント委任 ── */
  document.addEventListener('click', function(e) {
    if (e.target.id === 's4BtnGenAll') {
      window.s4GenerateAll();
    } else if (e.target.id === 's4BtnRegen') {
      window.s4RegenNarration();
    } else if (e.target.id === 's4BtnNext') {
      _s4SaveCurrent();
      _s4Msg('&#x23F3; Phase 6（動画生成 or Step5遷移）で実装予定');
    }
  });

  /* ヘルパー */
  function _s4Msg(t) { const el = document.getElementById('s4Msg'); if (el) el.innerHTML = t; }
  function _e(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

})();
</script>`;
}

module.exports = { router, getUI };
