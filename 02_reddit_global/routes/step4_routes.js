// routes/step4_routes.js
// ═══════════════════════════════════════════════════════
// STEP 4: シナリオ編集（指示書V2 #4）
// Phase 2: ナレーション一括/単体生成（DeepSeek）実装
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { spawn } = require('child_process');

const { callAI } = require('../scripts/ai_client');

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, '..', 'data');
const SI_DIR    = path.join(DATA_DIR, 'si_data');
const VIDEO_DIR = path.join(DATA_DIR, 'v2_videos');
const JOB_DIR   = path.join(DATA_DIR, 'v2_jobs');

[VIDEO_DIR, JOB_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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

// Phase 4a: 動画生成ジョブ起動（非同期、バックグラウンド実行）
router.post('/v2/generate-video', (req, res) => {
  const { postId, modules } = req.body;
  if (!postId) return res.status(400).json({ error: 'postId required' });

  // モジュールが渡された場合は先に保存（Step4 編集状態を反映）
  if (Array.isArray(modules) && modules.length) {
    try {
      const mp = path.join(DATA_DIR, (postId || 'unknown').replace(/[\/\?%*:|"<>\.]/g, '_') + '_modules.json');
      fs.writeFileSync(mp, JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
    } catch (e) { console.warn('[Step4] modules保存失敗:', e.message); }
  }

  const jobId = 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const jp    = path.join(JOB_DIR, jobId + '.json');
  fs.writeFileSync(jp, JSON.stringify({
    jobId, postId, status: 'queued', createdAt: new Date().toISOString(),
  }, null, 2));

  // 非同期で render.js を spawn
  const renderScript = path.join(__dirname, '..', 'scripts', 'v2_video', 'render.js');
  const proc = spawn('node', [renderScript, postId, jobId], {
    detached: true,
    stdio:    'ignore',
    cwd:      path.join(__dirname, '..'),
  });
  proc.unref();

  console.log(`[Step4] 動画生成 job 起動: ${jobId} (postId: ${postId})`);
  res.json({ ok: true, jobId });
});

// ジョブ進捗
router.get('/v2/video-status', (req, res) => {
  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const jp = path.join(JOB_DIR, jobId + '.json');
  if (!fs.existsSync(jp)) return res.status(404).json({ error: 'job not found' });
  try {
    res.json(JSON.parse(fs.readFileSync(jp, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// postId に紐づく生成済み動画一覧
router.get('/v2/videos', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.status(400).json({ error: 'postId required' });
  const prefix = (postId || '').replace(/[\/\?%*:|"<>\.]/g, '_').slice(-20);
  try {
    const all = fs.readdirSync(VIDEO_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.mp4'));
    const videos = all.map(f => {
      const full = path.join(VIDEO_DIR, f);
      const st   = fs.statSync(full);
      return {
        file:      f,
        sizeBytes: st.size,
        createdAt: st.birthtime || st.ctime,
        url:       '/v2_videos/' + f,
      };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ videos });
  } catch (e) {
    res.json({ videos: [], error: e.message });
  }
});

// Phase 5 で実装: 1モジュールの音声テスト（MiniMax）
router.post('/v2/tts-single', (req, res) => {
  res.status(501).json({ error: 'Phase 5 未実装' });
});

// Step4 プレビュー用：1モジュールの スライドHTMLを返す
router.get('/v2/preview-slide', (req, res) => {
  const { postId, idx } = req.query;
  if (!postId) return res.status(400).send('<!doctype html><title>err</title><body>postId required</body>');
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).send('<!doctype html><title>err</title><body>modules not found</body>');
    const { modules = [] } = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const i = Math.max(0, Math.min(modules.length - 1, parseInt(idx || '0', 10)));
    const mod = modules[i];
    if (!mod) return res.status(404).send('<!doctype html><title>err</title><body>module out of range</body>');

    // 動画生成と同じスライド HTML ジェネレータを使う
    const { buildOpeningHTML }    = require('../scripts/v2_video/slides/opening');
    const { buildEndingHTML }     = require('../scripts/v2_video/slides/ending');
    const { buildUniversalHTML }  = require('../scripts/v2_video/slides/universal');
    const { buildInsightHTML }    = require('../scripts/v2_video/slides/insight');
    const { buildHistoryHTML }    = require('../scripts/v2_video/slides/history');
    const { buildMatchcardHTML }  = require('../scripts/v2_video/slides/matchcard');
    const { buildMatchcenterHTML }= require('../scripts/v2_video/slides/matchcenter');
    const { buildStatsHTML, buildProfileHTML } = require('../scripts/v2_video/slides/stats');
    const { buildComparisonHTML } = require('../scripts/v2_video/slides/comparison');
    const { buildReactionHTML }   = require('../scripts/v2_video/slides/reaction');

    let html;
    switch (mod.type) {
      case 'opening':     html = buildOpeningHTML(mod);     break;
      case 'ending':      html = buildEndingHTML(mod);      break;
      case 'insight':     html = buildInsightHTML(mod);     break;
      case 'history':     html = buildHistoryHTML(mod);     break;
      case 'matchcard':   html = buildMatchcardHTML(mod);   break;
      case 'matchcenter': html = buildMatchcenterHTML(mod); break;
      case 'stats':       html = buildStatsHTML(mod);       break;
      case 'profile':     html = buildProfileHTML(mod);     break;
      case 'comparison':  html = buildComparisonHTML(mod);  break;
      case 'reaction':    html = buildReactionHTML(mod);    break;
      default:            html = buildUniversalHTML(mod);
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    res.status(500).send('<!doctype html><title>err</title><body>' + String(e.message).replace(/</g, '&lt;') + '</body>');
  }
});

// Step4 画像ギャラリー：サンプル画像の一覧
router.get('/v2/gallery', (req, res) => {
  const galleryDirs = [
    path.join(__dirname, '..', 'images'),
    path.join(__dirname, '..', '型１', 'stock'),
    path.join(__dirname, '..', '型３', 'stock'),
  ];
  const images = [];
  galleryDirs.forEach(d => {
    if (!fs.existsSync(d)) return;
    try {
      // 直下の画像ファイル
      fs.readdirSync(d).forEach(f => {
        if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) return;
        const rel = path.relative(path.join(__dirname, '..'), path.join(d, f)).replace(/\\/g, '/');
        images.push({ path: rel, name: f, url: '/' + rel });
      });
      // 日付フォルダ配下も 1 階層掘る
      fs.readdirSync(d).forEach(sub => {
        const subPath = path.join(d, sub);
        if (!fs.statSync(subPath).isDirectory()) return;
        try {
          fs.readdirSync(subPath).forEach(f => {
            if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) return;
            const rel = path.relative(path.join(__dirname, '..'), path.join(subPath, f)).replace(/\\/g, '/');
            images.push({ path: rel, name: sub + '/' + f, url: '/' + rel });
          });
        } catch (_) {}
      });
    } catch (_) {}
  });
  // 最大30件、ユニーク
  const seen = new Set();
  const unique = images.filter(im => { if (seen.has(im.path)) return false; seen.add(im.path); return true; }).slice(0, 30);
  res.json({ images: unique });
});

// 背景画像候補取得（Step4後の「裏」フェーズで実装予定）
router.get('/v2/images', (req, res) => {
  res.json({ images: [], note: 'Step4完了後に画像取得機能を実装予定' });
});

// レシピメタデータ取得：UIプルダウン用に subject/aspect/availableSlots/SIラベル一覧を返す
router.get('/v2/recipes', (req, res) => {
  const { RECIPES, SUBJECTS, SUBJECT_LABELS, SUBJECT_BOX_MAP } = require('../scripts/v2_story/recipes');
  const postId = req.query.postId;

  // recipes 全件をフロント用に整形
  const recipeList = Object.entries(RECIPES).map(([key, r]) => {
    const [subject, aspect] = key.split('.');
    return {
      key, subject, aspect,
      label:        r.label,
      description:  r.description,
      template:     r.template,
      priority:     r.priority,
      populates:    r.populates,
      historyShape: !!r.historyShape,
      requiresSecondary: !!r.requiresSecondary,
      needsMatchSide:    !!r.needsMatchSide,
      availableSlots: (r.availableSlots || []).map(s => ({ key: s.key, label: s.label })),
      defaultSelection: r.defaultSelection || [],
    };
  });

  // SI ラベル一覧（postId 指定時）
  const siLabels = { player: [], team: [], manager: [], match: [] };
  if (postId) {
    const siData = safeJson(siPath(postId), {});
    Object.entries(SUBJECT_BOX_MAP).forEach(([subj, box]) => {
      (siData?.boxes?.[box]?.fetched || []).forEach(f => {
        if (f.label && !siLabels[subj].includes(f.label)) siLabels[subj].push(f.label);
      });
    });
  }

  res.json({
    subjects:      SUBJECTS,
    subjectLabels: SUBJECT_LABELS,
    recipes:       recipeList,
    siLabels,
  });
});

// モジュール再構築：binding 変更や customSlotKeys 変更時にビルダー実行 → 1モジュール返す
router.post('/v2/rebuild-module', async (req, res) => {
  const { postId, idx, binding, persist, evalOnly } = req.body;
  if (!postId || idx == null || !binding) {
    return res.status(400).json({ error: 'postId + idx + binding required' });
  }
  try {
    const { buildModuleFromBinding, buildAllEvaluatedSlots } = require('../scripts/v2_story/builder');
    const siData = safeJson(siPath(postId), {});

    // evalOnly: プルダウン表示用の値のみ取得（重い buildModuleFromBinding をスキップ）
    if (evalOnly) {
      const evaluatedSlots = await buildAllEvaluatedSlots(binding, { siData });
      return res.json({ ok: true, evaluatedSlots, persisted: false });
    }

    const r = await buildModuleFromBinding(binding, { siData });
    if (!r.ok) return res.status(400).json({ ok: false, error: r.error });

    const result = r.module;
    // 全 availableSlots を評価（UI のプルダウン「label：value」表示用）
    const evaluatedSlots = await buildAllEvaluatedSlots(binding, { siData });

    // persist=true なら現在のモジュールに合成して保存
    if (persist) {
      const mp = modulesPath(postId);
      if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
      const j = JSON.parse(fs.readFileSync(mp, 'utf8'));
      const i = parseInt(idx, 10);
      if (!j.modules[i]) return res.status(404).json({ error: 'idx out of range' });
      const cur = j.modules[i];

      // 既存の編集済みフィールド（title / scriptDir / narration / bgImage 等）を保持しつつ、
      // type / dataSlots / matchData / siBinding 系をビルダー結果で上書き
      cur.binding = result.binding;
      cur.type    = result.type;
      if (result.dataSlots !== undefined)  cur.dataSlots    = result.dataSlots;
      if (result.matchData !== undefined)  cur.matchData    = result.matchData;
      if (result.catchphrases !== undefined && (!cur.catchphrases || !cur.catchphrases.length)) {
        cur.catchphrases = result.catchphrases;
      }
      cur.siBinding      = result.siBinding      ?? null;
      cur.siBindingLeft  = result.siBindingLeft  ?? null;
      cur.siBindingRight = result.siBindingRight ?? null;
      if (result.homeTeam) cur.homeTeam = result.homeTeam;
      if (result.awayTeam) cur.awayTeam = result.awayTeam;
      if (result.homeScore !== undefined) cur.homeScore = result.homeScore;
      if (result.awayScore !== undefined) cur.awayScore = result.awayScore;
      if (result.matchDate) cur.matchDate = result.matchDate;

      j.savedAt = new Date().toISOString();
      fs.writeFileSync(mp, JSON.stringify(j, null, 2));
      return res.json({ ok: true, module: cur, evaluatedSlots, persisted: true });
    }

    res.json({ ok: true, module: result, evaluatedSlots, persisted: false });
  } catch (e) {
    console.error('[Step4] rebuild-module エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// scriptDir 駆動 データ自動充填（SofaScore + Wikipedia 両方をAIに参照させる）
// stats/profile/matchcard → dataSlots [{label,value}]
// comparison              → dataSlots [{label,leftValue,rightValue}]
// DeepSeek 既定 + Haiku フォールバック / ハルシネーション禁止
router.post('/v2/fill-slots-from-scriptdir', async (req, res) => {
  const { postId, idx, scriptDir } = req.body;
  if (!postId || idx == null || !scriptDir) {
    return res.status(400).json({ error: 'postId + idx + scriptDir required' });
  }
  try {
    // モジュール読込
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
    const j  = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const m  = j.modules?.[parseInt(idx, 10)];
    if (!m) return res.status(404).json({ error: 'idx out of range' });

    const type     = m.type || 'stats';
    const isCmp    = type === 'comparison';
    const isHist   = type === 'history';
    const isIns    = type === 'insight';
    const primary  = m.binding?.primary   || m.siBinding      || m.siBindingLeft  || null;
    const secondary= m.binding?.secondary || m.siBindingRight || null;
    if (!primary && !isCmp && !isIns) {
      return res.status(400).json({ error: 'binding.primary または siBinding が必要' });
    }
    if (isCmp && (!primary || !secondary)) {
      return res.status(400).json({ error: 'comparison は binding.primary と secondary 両方必要' });
    }

    // ── SofaScore 等の SI実データ要約 ──────────────────────
    const siData = safeJson(siPath(postId), {});
    function _siSummaryFor(label) {
      if (!siData?.boxes) return null;
      for (const [boxType, box] of Object.entries(siData.boxes)) {
        const f = (box.fetched || []).find(f => f.label === label);
        if (f?.data && f.data.ok !== false) {
          return { boxType, label, data: f.data };
        }
      }
      return null;
    }
    const siP = primary   ? _siSummaryFor(primary)   : null;
    const siS = secondary ? _siSummaryFor(secondary) : null;

    // ── Wikipedia wikitext 取得（Career statistics 中心）──
    const { fetchWikipediaWikitext } = require('../scripts/modules/fetchers/wikipedia');
    async function _getWiki(title, maxBytes) {
      if (!title) return '';
      try {
        const wt = await fetchWikipediaWikitext(title);
        if (!wt) return '';
        // career stats セクション優先
        let body = wt;
        const idxCS = wt.search(/==\s*Career statistics\s*==|==\s*個人成績\s*==|==\s*クラブでの統計\s*==/i);
        if (idxCS >= 0) {
          const tail = wt.slice(idxCS);
          const idxNext = tail.slice(2).search(/\n==\s/);
          body = idxNext > 0 ? tail.slice(0, idxNext + 2) : tail.slice(0, maxBytes);
        }
        return body.slice(0, maxBytes);
      } catch (_) { return ''; }
    }
    const wikiBudget = isCmp ? 7000 : 12000;
    const wikiP = primary   ? await _getWiki(primary,   wikiBudget) : '';
    const wikiS = secondary ? await _getWiki(secondary, wikiBudget) : '';

    // ── プロンプト生成（type別）──────────────────────────────────────
    function _siBlock(label, si) {
      if (!si) return `(SIデータなし)`;
      return `[${si.boxType}] ${JSON.stringify(si.data, null, 0).slice(0, 1500)}`;
    }

    // 元コメント（insight 用：reaction 素材としても活用）
    const rawComments = (j.modules && j.post)
      ? '' // 後方互換、postなければスキップ
      : '';

    const cmpExample = `{"dataSlots":[
  {"label":"通算ゴール","leftValue":"924","rightValue":"853"},
  {"label":"出場試合","leftValue":"1230","rightValue":"1043"}
]}`;
    const stdExample = `{"dataSlots":[
  {"label":"通算ゴール","value":"924"},
  {"label":"プレミアリーグ","value":"145"}
]}`;
    const histExample = `{"dataSlots":[
  {"label":"2011","value":"アーセナル下部組織加入"},
  {"label":"2014","value":"プレミアリーグ初出場"},
  {"label":"2022","value":"レアル・ベティス移籍"}
]}`;
    const insExample = `{"catchphrases":[
  "18歳でCL出場",
  "アーセナル時代145試合",
  "ベティスで覚醒の決勝弾"
]}`;

    let outputSpec, outputExample;
    if (isCmp) {
      outputSpec = '対比型 dataSlots（label / leftValue / rightValue を最大8個）';
      outputExample = cmpExample;
    } else if (isHist) {
      outputSpec = 'タイムライン dataSlots（label=年, value=出来事 を時系列順に最大8個）';
      outputExample = histExample;
    } else if (isIns) {
      outputSpec = 'catchphrases（短く強いキャッチコピーを3〜5個、各15文字以内）';
      outputExample = insExample;
    } else {
      outputSpec = 'dataSlots（label / value を最大8個）';
      outputExample = stdExample;
    }

    const prompt = `あなたはサッカーデータ抽出の専門家です。
【脚本指示】${scriptDir}

【スライド型】${type}${isCmp ? '（左右対比）' : isHist ? '（タイムライン年表）' : isIns ? '（キャッチコピー）' : ''}
【対象】${primary || '(任意)'}${secondary ? ' vs ' + secondary : ''}

━━━ データソース ━━━
${primary ? `[A] SofaScore 実データ（${primary}）:\n${_siBlock(primary, siP)}\n\n[A] Wikipedia 抜粋（${primary}）:\n"""\n${wikiP || '(取得失敗)'}\n"""\n` : ''}
${secondary ? `\n[B] SofaScore 実データ（${secondary}）:\n${_siBlock(secondary, siS)}\n\n[B] Wikipedia 抜粋（${secondary}）:\n"""\n${wikiS || '(取得失敗)'}\n"""\n` : ''}
━━━━━━━━━━━━━━━━

【タスク】
脚本指示に沿って、${outputSpec}を生成。
**SofaScore は今季データ、Wikipedia は通算/歴史データ。脚本指示の文脈で適切な方を選んで使い分ける。**

【ハルシネーション禁止 — 厳守】
- 値は必ず上記データソースに明記されているもののみ
- データに無い項目は **出力しない**（推測・記憶からの補完は絶対NG）
${isCmp ? '- 比較項目として両者に値が存在するもののみ採用（片側「-」になるなら除外）' : ''}
${isHist ? '- 年は西暦4桁（例「2014」）、出来事は具体的に20文字以内\n- 時系列順（古い→新しい）で並べる' : ''}
${isIns ? '- キャッチコピーは「事実+数字」を含む短句（例「18歳でCL8得点」）\n- 抽象的・主観的表現は避ける' : ''}
${(!isCmp && !isHist && !isIns) ? '- 値は数字+単位（例「311ゴール」「2002年」）' : ''}

JSON のみ（マークダウン不要）。例：
${outputExample}`;

    // ── DeepSeek 既定 → JSON崩れ時 Haiku フォールバック ──
    async function _ask(provider) {
      const model = provider === 'deepseek' ? 'deepseek-chat' : 'claude-haiku-4-5-20251001';
      return callAI({ forceProvider: provider, model, max_tokens: 1500, messages: [{ role: 'user', content: prompt }] });
    }
    function _parse(raw) {
      const m1 = raw && raw.match(/\{[\s\S]*\}/);
      if (!m1) return null;
      try { return JSON.parse(m1[0]); } catch (_) { return null; }
    }

    function _hasOutput(p) {
      if (!p) return false;
      if (isIns) return Array.isArray(p.catchphrases) && p.catchphrases.length;
      return Array.isArray(p.dataSlots) && p.dataSlots.length;
    }

    let raw, parsed = null, used = 'deepseek';
    try {
      raw    = await _ask('deepseek');
      parsed = _parse(raw);
    } catch (e) {
      console.warn('[fill-slots] deepseek 例外:', e.message);
    }
    if (!_hasOutput(parsed)) {
      console.warn('[fill-slots] deepseek 失敗、Haikuにフォールバック');
      raw    = await _ask('anthropic');
      parsed = _parse(raw);
      used   = 'haiku';
    }
    if (!_hasOutput(parsed)) return res.status(500).json({ error: '抽出失敗（出力空）' });

    // ── 整形（型に応じた shape）──
    let result = { ok: true, source: used, type, primary, secondary };
    if (isIns) {
      const phrases = parsed.catchphrases.slice(0, 5)
        .map(s => String(s || '').slice(0, 25))
        .filter(Boolean);
      if (!phrases.length) return res.status(500).json({ error: '有効な catchphrase が0件' });
      result.catchphrases = phrases;
      console.log(`[fill-slots] type=insight primary="${primary}" / ${used} → ${phrases.length}コピー`);
    } else if (isCmp) {
      const slots = parsed.dataSlots.slice(0, 8).map(s => ({
        label:      String(s.label || '').slice(0, 30),
        leftValue:  String(s.leftValue ?? s.left ?? '').slice(0, 30),
        rightValue: String(s.rightValue ?? s.right ?? '').slice(0, 30),
      })).filter(s => s.leftValue && s.rightValue && s.leftValue !== '-' && s.rightValue !== '-');
      if (!slots.length) return res.status(500).json({ error: '有効な dataSlot が0件' });
      result.dataSlots = slots;
      console.log(`[fill-slots] type=comparison primary="${primary}" vs "${secondary}" / ${used} → ${slots.length}スロット`);
    } else {
      // stats / matchcard / history
      const slots = parsed.dataSlots.slice(0, 8).map(s => ({
        label: String(s.label || '').slice(0, 30),
        value: String(s.value || '').slice(0, 30),
      })).filter(s => s.value && s.value !== '-');
      if (!slots.length) return res.status(500).json({ error: '有効な dataSlot が0件' });
      result.dataSlots = slots;
      console.log(`[fill-slots] type=${type} primary="${primary}" / ${used} → ${slots.length}スロット`);
    }
    res.json(result);
  } catch (e) {
    console.error('[fill-slots] エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 現在編集中モジュールの bgImage を保存
router.post('/v2/set-bg-image', (req, res) => {
  const { postId, idx, bgImage } = req.body;
  if (!postId || idx == null) return res.status(400).json({ error: 'postId + idx required' });
  try {
    const mp = modulesPath(postId);
    if (!fs.existsSync(mp)) return res.status(404).json({ error: 'modules not found' });
    const j = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const i = parseInt(idx, 10);
    if (!j.modules[i]) return res.status(404).json({ error: 'idx out of range' });
    j.modules[i].bgImage = bgImage || null;
    j.savedAt = new Date().toISOString();
    fs.writeFileSync(mp, JSON.stringify(j, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── UI ─────────────────────────────────────────────────

function getUI() {
  return `
<div id="step4" class="step-container" style="display:none;padding:12px 16px">

  <!-- トップ操作バー -->
  <div class="panel" style="margin-bottom:10px;padding:12px 14px">
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span id="s4Title" style="font-size:13px;font-weight:bold;flex:1;color:#7dc8ff;min-width:200px">
        案件を選択してください
      </span>
      <button class="btn btn-primary" id="s4BtnGenAll" title="全モジュールのナレーションを一括生成">
        &#x1F4D6; 全ナレーション一括生成
      </button>
      <button class="btn btn-success" id="s4BtnNext" title="動画生成を開始">
        &#x1F3AC; 動画生成・書き出し
      </button>
      <span id="s4Msg" style="font-size:11px;color:#8a9aba"></span>
    </div>
  </div>

  <!-- タブ行 -->
  <div id="s4Tabs" style="display:flex;gap:3px;flex-wrap:wrap;margin-bottom:6px"></div>

  <!-- ★★★ 2カラム レイアウト ★★★ -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;min-height:720px">

    <!-- ═══ 左カラム ═══ -->
    <div style="display:flex;flex-direction:column;gap:10px">
      <!-- 左上: エディタ -->
      <div id="s4Editor"
           style="background:var(--panel);border:1px solid var(--c);border-radius:0 10px 10px 10px;padding:16px;min-height:480px;overflow-y:auto">
        <div style="color:#5a6a8a;text-align:center;padding:20px">
          Step3 でモジュールを確定した後、このStepで各モジュールの脚本を生成・編集します
        </div>
      </div>

      <!-- 左下: 画像ギャラリー -->
      <div class="panel" style="padding:12px;min-height:220px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F5BC; 背景画像ギャラリー（クリックで現モジュールにセット）</span>
          <button class="btn btn-sm" id="s4BtnRefreshGallery">&#x21BB;</button>
        </div>
        <div id="s4Gallery" style="display:grid;grid-template-columns:repeat(5,1fr);gap:6px;max-height:360px;overflow-y:auto">
          <div style="grid-column:1/-1;color:#5a6a8a;font-size:11px;text-align:center;padding:12px">読込中...</div>
        </div>
        <div style="margin-top:8px;font-size:10px;color:#8a9aba">
          現在のスライド背景: <span id="s4CurrentBg" style="color:#fff">(未設定)</span>
        </div>
      </div>
    </div>

    <!-- ═══ 右カラム ═══ -->
    <div style="display:flex;flex-direction:column;gap:10px">
      <!-- 右上: プレビュー -->
      <div class="panel" style="padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F4FA; スライドプレビュー（動画と同じ見た目）</span>
          <button class="btn btn-sm" id="s4BtnReloadPreview">&#x21BB; リロード</button>
        </div>
        <div id="s4PreviewWrap" style="position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:6px;overflow:hidden">
          <iframe id="s4PreviewFrame"
                  style="position:absolute;top:0;left:0;width:1920px;height:1080px;border:0;transform-origin:top left"
                  sandbox="allow-same-origin allow-scripts">
          </iframe>
        </div>
      </div>

      <!-- 右中: 音声生成 -->
      <div class="panel" style="padding:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F3A4; 音声生成（現スライド）</span>
          <button class="btn btn-sm" id="s4BtnGenVoice" style="background:#8b5cf6;color:#fff">&#x2728; 音声生成</button>
        </div>
        <div id="s4VoiceList" style="display:flex;flex-direction:column;gap:4px;min-height:40px;font-size:11px;color:#5a6a8a">
          Phase 5 で MiniMax 連携予定
        </div>
      </div>

      <!-- 右下: ログ -->
      <div class="panel" style="padding:10px 12px;flex:1;min-height:180px;display:flex;flex-direction:column">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F4C4; ログ</span>
          <button class="btn btn-sm" id="s4BtnClearLog">クリア</button>
        </div>
        <div id="s4Log"
             style="flex:1;background:#000;color:#9bb5e0;padding:8px 10px;border-radius:6px;font-family:monospace;font-size:10px;line-height:1.55;overflow-y:auto;max-height:300px">
          <div style="color:#5a6a8a">[log] 準備完了</div>
        </div>
      </div>
    </div>
  </div>

  <!-- 動画生成進捗（下部） -->
  <div id="s4GenProgress" class="panel" style="display:none;margin-top:10px;padding:10px 14px">
    <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:4px">
      &#x1F3A5; 動画生成ジョブ <span id="s4JobId" style="font-size:10px;color:#8a9aba"></span>
    </div>
    <div id="s4JobStatus" style="font-size:12px;color:#c0cce0;margin-bottom:4px">準備中...</div>
    <div style="background:#0d1220;height:6px;border-radius:3px;overflow:hidden">
      <div id="s4JobBar" style="background:var(--c);height:100%;width:0%;transition:width .3s"></div>
    </div>
  </div>

  <!-- 生成済み動画一覧 -->
  <div class="panel" style="margin-top:10px;padding:10px 14px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
      <span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F4FD; 生成済み動画</span>
      <button class="btn btn-sm" id="s4BtnRefreshVideos">&#x21BB; 一覧更新</button>
    </div>
    <div id="s4VideoList" style="display:flex;flex-direction:column;gap:4px">
      <div style="font-size:11px;color:#5a6a8a">まだ生成した動画はありません</div>
    </div>
  </div>

</div>

<script>
(function() {
  /* ────────────── Step4 スコープ ────────────── */

  const TYPE_COLORS = {
    opening:'#ff4d4d', insight:'#1a6ef5', stats:'#10b981', reaction:'#f59e0b',
    comparison:'#ef4444', history:'#6366f1',
    matchcard:'#14b8a6', matchcenter:'#06b6d4', ending:'#64748b',
  };
  const TYPE_LABELS = {
    opening:'オープニング', insight:'キャッチコピー', stats:'スタッツ',
    reaction:'コメント反応', comparison:'対比',
    history:'ヒストリー', matchcard:'試合プレビュー',
    matchcenter:'試合詳細', ending:'エンディング',
  };

  window.APP = window.APP || {};
  window.APP.s4 = {
    activeTab: 0,         // 現在選択中のモジュール index
    recipes: [],          // /api/v2/recipes の結果
    recipesByKey: {},     // 'subject.aspect' → recipe（キャッシュ）
    subjects: [],
    subjectLabels: {},
    siLabels: { player:[], team:[], manager:[], match:[] },
  };

  /* ── レシピ + SIラベル一覧を取得 ── */
  async function _s4LoadRecipes() {
    const post = window.APP.selected;
    const url = '/api/v2/recipes' + (post?.id ? '?postId=' + encodeURIComponent(post.id) : '');
    try {
      const r = await fetch(url);
      const j = await r.json();
      window.APP.s4.recipes = j.recipes || [];
      window.APP.s4.recipesByKey = {};
      (j.recipes || []).forEach(function(rec) {
        window.APP.s4.recipesByKey[rec.key] = rec;
      });
      window.APP.s4.subjects      = j.subjects      || [];
      window.APP.s4.subjectLabels = j.subjectLabels || {};
      window.APP.s4.siLabels      = j.siLabels      || { player:[], team:[], manager:[], match:[] };
      console.log('[Step4] レシピ読込OK:', (j.recipes || []).length, '件 / SIラベル:', j.siLabels);
    } catch (e) { console.warn('[Step4] recipes読込失敗', e); }
  }

  /* ── 初期化（goStep(4) で呼ばれる）── */
  window.step4Init = function() {
    const post = window.APP.selected;
    document.getElementById('s4Title').textContent = post
      ? (post.title || '(タイトル不明)').slice(0, 80)
      : '← 左サイドバーの保存済み案件をクリックしてください';
    _s4Msg('');

    // レシピ読込（並行）
    _s4LoadRecipes().then(_s4Render);

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
    const i = window.APP.s4?.activeTab ?? 0;
    if (window.APP.modules?.[i] && typeof _s4FetchEvalSlots === 'function') {
      _s4FetchEvalSlots(i);
    }
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

  /* タイプ別データ編集UI（dataSlots / catchphrases / comments）*/
  function _buildDataEditUi(m) {
    const t = m.type;
    let html = '';

    // 現binding に対応するレシピの availableSlots を取得（プルダウン用）
    function _getAvailableSlots() {
      const b = m.binding || {};
      const r = window.APP.s4?.recipesByKey?.[b.subject + '.' + b.aspect];
      return r?.availableSlots || [];
    }
    // プルダウン選択肢を「label：value」表示で生成（_evalSlots キャッシュ参照）
    function _slotKeyOptions(currentKey) {
      const slots = _getAvailableSlots();
      if (!slots.length) return '';
      const evalSlots = m._evalSlots || [];
      const evalByKey = {};
      evalSlots.forEach(function(es) { evalByKey[es.key] = es; });
      let html = '';
      slots.forEach(function(s) {
        const ev = evalByKey[s.key];
        let display = s.label;
        if (ev) {
          if (ev.value !== undefined && ev.value !== '-') display = s.label + '：' + ev.value;
          else if (ev.leftValue !== undefined) display = s.label + '：' + ev.leftValue + ' vs ' + ev.rightValue;
        }
        html += '<option value="' + _e(s.key) + '"' + (s.key === currentKey ? ' selected' : '') + '>'
          + _e(display) + '</option>';
      });
      html += '<option value=""' + (!currentKey ? ' selected' : '') + '>(カスタム)</option>';
      return html;
    }

    // dataSlots 系（stats/profile/matchcard）
    if (['stats','profile','matchcard'].includes(t)) {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      if (!slots.length) m.dataSlots = slots;
      const slotOpts = _slotKeyOptions.bind(null);
      const hasRecipe = _getAvailableSlots().length > 0;
      html += '<div style="margin-bottom:10px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap;">'
        + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F3AF; データスロット（編集可）'
        + (hasRecipe ? '<span style="font-size:9px;color:#5a6a8a;margin-left:6px">※ ラベル変更後は ↻ データ再取得 で値を更新</span>' : '')
        + '</span>'
        + '<div style="display:flex;gap:4px;">'
        + '<button class="btn btn-sm" id="s4BtnFillFromScript" style="background:#a855f7;color:#fff" title="脚本指示の内容に応じてWikipediaからデータ抽出">&#x2728; scriptDirから取得</button>'
        + '<button class="btn btn-sm" id="s4BtnAddSlot" style="background:#10b981;color:#fff">+ 追加</button>'
        + '</div>'
        + '</div>';
      slots.forEach(function(s, idx) {
        const slotKey = s.slotKey || '';
        if (hasRecipe) {
          // 3カラム：[ラベルプルダウン] [値（編集可）] [削除]
          html += '<div style="display:grid;grid-template-columns:24px 140px 1fr 28px;gap:6px;margin-bottom:5px;align-items:center">'
            + '<span style="font-size:10px;color:#8a9aba;text-align:center">#' + (idx+1) + '</span>'
            + '<select class="inp s4-slot-key" data-idx="' + idx + '" style="font-size:11px;padding:4px 6px">' + slotOpts(slotKey) + '</select>'
            + '<input class="inp s4-slot-value" data-idx="' + idx + '" placeholder="値"'
            + ' style="font-size:12px;padding:5px 8px" value="' + _e(s.value || '') + '">'
            + '<button class="btn btn-sm s4-slot-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
            + '</div>';
        } else {
          // 旧来の merged 入力（ラベル：値）
          const merged = (s.label && s.value) ? (s.label + '：' + s.value) : (s.merged || '');
          html += '<div style="display:grid;grid-template-columns:24px 1fr 28px;gap:6px;margin-bottom:5px;align-items:center">'
            + '<span style="font-size:10px;color:#8a9aba;text-align:center">#' + (idx+1) + '</span>'
            + '<input class="inp s4-slot" data-idx="' + idx + '" placeholder="例: 今季ゴール：24"'
            + ' style="font-size:12px;padding:5px 8px" value="' + _e(merged) + '">'
            + '<button class="btn btn-sm s4-slot-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
            + '</div>';
        }
      });
      html += '</div>';
    }

    // comparison: 3カラム（label/left/right）
    else if (t === 'comparison') {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      m.dataSlots = slots;
      const hasRecipe = _getAvailableSlots().length > 0;
      html += '<div style="margin-bottom:10px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap;">'
        + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F3AF; 対比データ（label / 左 / 右）</span>'
        + '<div style="display:flex;gap:4px;">'
        + '<button class="btn btn-sm" id="s4BtnFillFromScript" style="background:#a855f7;color:#fff" title="脚本指示の内容に応じてSofaScore/Wikipediaから対比抽出">&#x2728; scriptDirから取得</button>'
        + '<button class="btn btn-sm" id="s4BtnAddCmpSlot" style="background:#10b981;color:#fff">+ 追加</button>'
        + '</div>'
        + '</div>';
      // siBindingLeft/Right 表示（読込専用、Step3 で設定済み想定）
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;font-size:11px;color:#94a3b8">'
        + '<div>左: <span style="color:#93c5fd">' + _e(m.siBindingLeft || '(未設定)') + '</span></div>'
        + '<div>右: <span style="color:#fca5a5">' + _e(m.siBindingRight || '(未設定)') + '</span></div>'
        + '</div>';
      slots.forEach(function(s, idx) {
        const slotKey = s.slotKey || '';
        if (hasRecipe) {
          // ラベル＝プルダウン、左/右値＝編集可
          html += '<div style="display:grid;grid-template-columns:140px 1fr 1fr 28px;gap:5px;margin-bottom:5px">'
            + '<select class="inp s4-slot-key s4-cmp-label-sel" data-idx="' + idx + '" style="font-size:11px;padding:4px 6px">' + _slotKeyOptions(slotKey) + '</select>'
            + '<input class="inp s4-cmp-left"  data-idx="' + idx + '" placeholder="左"    style="font-size:11px;padding:4px 6px;color:#93c5fd" value="' + _e(s.leftValue || '') + '">'
            + '<input class="inp s4-cmp-right" data-idx="' + idx + '" placeholder="右"    style="font-size:11px;padding:4px 6px;color:#fca5a5" value="' + _e(s.rightValue || '') + '">'
            + '<button class="btn btn-sm s4-cmp-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
            + '</div>';
        } else {
          // 旧来の自由入力ラベル
          html += '<div style="display:grid;grid-template-columns:1fr 1fr 1fr 28px;gap:5px;margin-bottom:5px">'
            + '<input class="inp s4-cmp-label" data-idx="' + idx + '" placeholder="LABEL" style="font-size:11px;padding:4px 6px" value="' + _e(s.label || '') + '">'
            + '<input class="inp s4-cmp-left"  data-idx="' + idx + '" placeholder="左"    style="font-size:11px;padding:4px 6px;color:#93c5fd" value="' + _e(s.leftValue || '') + '">'
            + '<input class="inp s4-cmp-right" data-idx="' + idx + '" placeholder="右"    style="font-size:11px;padding:4px 6px;color:#fca5a5" value="' + _e(s.rightValue || '') + '">'
            + '<button class="btn btn-sm s4-cmp-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
            + '</div>';
        }
      });
      html += '</div>';
    }

    // insight: catchphrases 編集（既存の chunk UI と重複するため、catchphrases を編集可能にする）
    else if (t === 'insight') {
      const phrases = Array.isArray(m.catchphrases) ? m.catchphrases : [];
      m.catchphrases = phrases;
      html += '<div style="margin-bottom:10px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap;">'
        + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F3AF; キャッチコピー見出し（編集可）</span>'
        + '<div style="display:flex;gap:4px;">'
        + '<button class="btn btn-sm" id="s4BtnFillFromScript" style="background:#a855f7;color:#fff" title="脚本指示の内容に応じてSofaScore/Wikipedia/コメントから事実ベースで生成">&#x2728; scriptDirから取得</button>'
        + '<button class="btn btn-sm" id="s4BtnAddPhrase" style="background:#10b981;color:#fff">+ 追加</button>'
        + '</div>'
        + '</div>';
      phrases.forEach(function(p, idx) {
        html += '<div style="display:grid;grid-template-columns:24px 1fr 28px;gap:6px;margin-bottom:5px;align-items:center">'
          + '<span style="font-size:10px;color:#8a9aba;text-align:center">' + (idx+1) + '.</span>'
          + '<input class="inp s4-phrase" data-idx="' + idx + '" placeholder="見出し' + (idx+1) + '"'
          + ' style="font-size:12px;padding:5px 8px" value="' + _e(p) + '">'
          + '<button class="btn btn-sm s4-phrase-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
          + '</div>';
      });
      html += '</div>';
    }

    // reaction: comments 編集
    else if (t === 'reaction') {
      const coms = Array.isArray(m.comments) ? m.comments : [];
      m.comments = coms;
      html += '<div style="margin-bottom:10px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F3AF; コメント（編集可）</span>'
        + '<button class="btn btn-sm" id="s4BtnAddComment" style="background:#10b981;color:#fff">+ 追加</button>'
        + '</div>';
      coms.forEach(function(c, idx) {
        html += '<div style="display:grid;grid-template-columns:24px 1fr 60px 28px;gap:5px;margin-bottom:5px;align-items:center">'
          + '<span style="font-size:10px;color:#8a9aba;text-align:center">' + (idx+1) + '.</span>'
          + '<input class="inp s4-cmt-text"  data-idx="' + idx + '" placeholder="コメント" style="font-size:11px;padding:4px 6px" value="' + _e(c.text || '') + '">'
          + '<input type="number" class="inp s4-cmt-score" data-idx="' + idx + '" placeholder="score" style="font-size:11px;padding:4px 6px" value="' + (c.score || 0) + '">'
          + '<button class="btn btn-sm s4-cmt-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
          + '</div>';
      });
      html += '</div>';
    }

    // history: dataSlots（label=日付/value=タイトル）+ chunks（既存）
    else if (t === 'history') {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      m.dataSlots = slots;
      html += '<div style="margin-bottom:10px">'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:6px;flex-wrap:wrap;">'
        + '<span style="font-size:11px;color:var(--c);font-weight:bold">&#x1F3AF; タイムラインイベント（日付 / タイトル）</span>'
        + '<div style="display:flex;gap:4px;">'
        + '<button class="btn btn-sm" id="s4BtnFillFromScript" style="background:#a855f7;color:#fff" title="脚本指示の内容に応じてWikipedia infoboxから年表抽出">&#x2728; scriptDirから取得</button>'
        + '<button class="btn btn-sm" id="s4BtnAddHistEvt" style="background:#10b981;color:#fff">+ 追加</button>'
        + '</div>'
        + '</div>';
      slots.forEach(function(s, idx) {
        html += '<div style="display:grid;grid-template-columns:24px 100px 1fr 28px;gap:5px;margin-bottom:5px;align-items:center">'
          + '<span style="font-size:10px;color:#8a9aba;text-align:center">' + (idx+1) + '.</span>'
          + '<input class="inp s4-hist-date"  data-idx="' + idx + '" placeholder="2024" style="font-size:11px;padding:4px 6px;color:#fbbf24" value="' + _e(s.label || '') + '">'
          + '<input class="inp s4-hist-title" data-idx="' + idx + '" placeholder="出来事"  style="font-size:11px;padding:4px 6px" value="' + _e(s.value || '') + '">'
          + '<button class="btn btn-sm s4-hist-remove" data-idx="' + idx + '" style="background:#ef4444;color:#fff;padding:4px 6px">&#xD7;</button>'
          + '</div>';
      });
      html += '</div>';
    }

    return html;
  }

  /* ── binding 編集UI（観点 + 対象（役割サフィックス付き）） ── */
  // 役割サフィックス（primary/secondary プルダウンの「人名 (監督)」表示用）
  const ROLE_SUFFIX = { player: '選手', team: 'チーム', manager: '監督', match: '試合' };

  function _buildBindingUi(m) {
    const s4 = window.APP.s4 || {};
    const recipesByKey = s4.recipesByKey || {};
    const siLabels = s4.siLabels || {};

    // binding が無ければ最低限のスケルトンを作る（generic.free）
    if (!m.binding) m.binding = { subject:'generic', aspect:'free', primary:null, secondary:null };
    const b = m.binding;

    // ── 役割つき統合ラベル一覧の構築 ──
    // すべての SI ラベルを {subject, label} の形でフラット化、表示は「label (役割)」
    const allEntities = [];
    Object.keys(ROLE_SUFFIX).forEach(function(subj) {
      (siLabels[subj] || []).forEach(function(lbl) {
        allEntities.push({ subject: subj, label: lbl, role: ROLE_SUFFIX[subj] });
      });
    });

    // primary 対象プルダウン（全エンティティ）
    function buildEntityOpts(currentSubj, currentLabel, filterSubj) {
      const opts = ['<option value="">(なし)</option>'];
      allEntities.forEach(function(e) {
        if (filterSubj && e.subject !== filterSubj) return;
        const val = e.subject + '||' + e.label;
        const sel = (currentSubj === e.subject && currentLabel === e.label) ? ' selected' : '';
        opts.push('<option value="' + _e(val) + '"' + sel + '>'
          + _e(e.label) + ' (' + e.role + ')</option>');
      });
      return opts.join('');
    }

    // 観点プルダウン（subject 自動推定 → そのsubjectで使えるaspectのみ）
    // primary が選ばれていない時は b.subject を使う（generic.free 等）
    const inferredSubj = b.primary
      ? (allEntities.find(function(e) { return e.label === b.primary; }) || {}).subject || b.subject
      : b.subject;
    const aspectsForSubj = (s4.recipes || []).filter(function(r) { return r.subject === inferredSubj; });
    const aspectOpts = aspectsForSubj.length
      ? aspectsForSubj.map(function(r) {
          return '<option value="' + r.aspect + '"' + (b.aspect === r.aspect ? ' selected' : '') + '>'
            + r.label + ' [' + r.priority + ']</option>';
        }).join('')
      : '<option value="free" selected>(汎用フリー)</option>';

    const recipe = recipesByKey[inferredSubj + '.' + b.aspect];
    const showSecondary = !!(recipe && recipe.requiresSecondary);
    const primaryOpts   = buildEntityOpts(b.subject, b.primary, null);
    const secondaryOpts = buildEntityOpts(b.subject, b.secondary, inferredSubj);

    // バインドキーの色
    const isFree = b.subject === 'generic' && b.aspect === 'free';
    const borderCol = isFree ? '#3a4458' : '#3b82f6';

    let html = '<div style="background:#0d1220;border:1px solid ' + borderCol + ';border-radius:6px;padding:8px 10px;margin-bottom:10px">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
      + '<span style="font-size:10px;color:#94a3b8;font-weight:bold">&#x1F517; binding（対象 × 観点）</span>'
      + (isFree
          ? '<span style="font-size:10px;color:#5a6a8a">※フリー編集モジュール（自動充填なし）</span>'
          : '<button class="btn btn-sm" id="s4BtnRebuild" style="background:#3b82f6;color:#fff;font-size:10px;padding:3px 8px">&#x21BB; データ再取得</button>'
        )
      + '</div>'
      + '<div style="display:grid;grid-template-columns:' + (showSecondary ? '1fr 1fr 1fr' : '1fr 1fr') + ';gap:6px;margin-bottom:5px">'
      + '<div><div style="font-size:9px;color:#8a9aba;margin-bottom:2px">対象 (primary)</div>'
      + '<select id="s4BindPrimary" class="inp" style="font-size:11px;padding:4px 6px;width:100%" onchange="s4OnBindEntityChange()">' + primaryOpts + '</select></div>'
      + (showSecondary
          ? '<div><div style="font-size:9px;color:#8a9aba;margin-bottom:2px">対象2 ※必須</div>'
            + '<select id="s4BindSecondary" class="inp" style="font-size:11px;padding:4px 6px;width:100%" onchange="s4OnBindEntityChange()">' + secondaryOpts + '</select></div>'
          : '')
      + '<div><div style="font-size:9px;color:#8a9aba;margin-bottom:2px">観点 (aspect)</div>'
      + '<select id="s4BindAspect" class="inp" style="font-size:11px;padding:4px 6px;width:100%" onchange="s4OnBindAspectChange()">' + aspectOpts + '</select></div>'
      + '</div>';
    // hidden subj field — 後方互換のため _s4SaveCurrent 用に残す
    html += '<input type="hidden" id="s4BindSubj" value="' + _e(inferredSubj) + '">';
    if (recipe && recipe.description) {
      html += '<div style="font-size:10px;color:#6080b0;margin-top:5px">&#x1F4D6; ' + _e(recipe.description) + '</div>';
    }
    html += '</div>';

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

    // 型プルダウン候補
    // profile は stats と中身同じのため UI から削除（既存モジュールは render側で stats扱い）
    const ALL_TYPES = ['opening','insight','stats','reaction','comparison','history','matchcard','matchcenter','ending'];
    const typeOpts = ALL_TYPES.map(function(t) {
      return '<option value="' + t + '"' + (m.type === t ? ' selected' : '') + '>' + t + ' — ' + (TYPE_LABELS[t] || '') + '</option>';
    }).join('');

    editor.innerHTML =
      // ★ タイトル（編集可）+ タイプセレクト（編集可、変更で再描画）
      '<div style="display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:10px;align-items:end">'
      + '<div>'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:3px">&#x1F4DD; タイトル</div>'
      + '<input id="s4TitleInp" class="inp" style="width:100%;font-size:14px;font-weight:bold" value="' + _e(m.title || '') + '">'
      + '</div>'
      + '<div>'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:3px">&#x1F39E; タイプ</div>'
      + '<select id="s4TypeSel" class="inp" style="font-size:12px;padding:5px 8px;background:' + col + '33;border-color:' + col + '">'
      + typeOpts
      + '</select>'
      + '</div>'
      + '</div>'

      // ★ binding（主題/観点/対象）UI
      + _buildBindingUi(m)

      // 脚本指示（編集可）
      + '<div style="margin-bottom:10px">'
      + '<div style="font-size:10px;color:#f59e0b;margin-bottom:3px">&#x1F3AD; 脚本指示</div>'
      + '<textarea id="s4ScriptDirInp" class="inp" rows="2" style="width:100%;font-size:11px;line-height:1.5">' + _e(m.scriptDir || '') + '</textarea>'
      + '</div>'

      // タイプ別データ編集（dataSlots/catchphrases/comments）
      + _buildDataEditUi(m)

      // ナレーション編集欄（既存）
      + _buildNarrationUi(m)

      // 位置表示
      + '<div style="margin-top:8px;font-size:10px;color:#5a6a8a">モジュール ' + (i + 1) + ' / ' + mods.length + '</div>';
  }

  /* ── タブ切替 ── */
  window.s4Switch = function(i) {
    _s4SaveCurrent();
    window.APP.s4.activeTab = i;
    _s4Render();
    _s4FetchEvalSlots(i);
  };

  /* ── eval slots を背景で取得（プルダウン「label：値」表示用）
         dataSlots / matchData 等のユーザー編集状態は触らない ── */
  async function _s4FetchEvalSlots(idx) {
    const m    = window.APP.modules?.[idx];
    const post = window.APP.selected;
    if (!m || !post?.id) return;
    if (!m.binding?.subject || !m.binding?.aspect) return;
    if (m.binding.subject === 'generic') return;
    if (Array.isArray(m._evalSlots) && m._evalSlots.length) return;
    try {
      const r = await fetch('/api/v2/rebuild-module', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId:  post.id,
          idx:     idx,
          binding: m.binding,
          persist: false,
          evalOnly: true,
        }),
      });
      const j = await r.json();
      if (!j.ok) return;
      m._evalSlots = j.evaluatedSlots || [];
      if (window.APP.s4.activeTab === idx) _s4RenderEditor();
    } catch (_) { /* silent */ }
  }
  window._s4FetchEvalSlots = _s4FetchEvalSlots;

  /* ── binding: subject 変更時 → aspect プルダウン更新 ── */
  window.s4OnBindSubjChange = function() {
    _s4SaveCurrent();
    const m = window.APP.modules?.[window.APP.s4.activeTab];
    if (!m) return;
    const subjEl = document.getElementById('s4BindSubj');
    if (!subjEl) return;
    const newSubj = subjEl.value;
    // 同じsubjectで一番優先度の高いaspectを自動選択
    const recipes = (window.APP.s4.recipes || []).filter(r => r.subject === newSubj);
    recipes.sort((a, b) => (a.priority || 'Z').localeCompare(b.priority || 'Z'));
    m.binding = m.binding || {};
    m.binding.subject = newSubj;
    m.binding.aspect  = recipes[0]?.aspect || 'free';
    m.binding.primary = null;
    m.binding.secondary = null;
    m.binding.customSlotKeys = recipes[0]?.defaultSelection || null;
    m._evalSlots = null;
    _s4Render();
  };

  /* ── binding: aspect 変更時 → defaultSelection を反映 ── */
  window.s4OnBindAspectChange = function() {
    _s4SaveCurrent();
    const m = window.APP.modules?.[window.APP.s4.activeTab];
    if (!m) return;
    const aspEl = document.getElementById('s4BindAspect');
    if (!aspEl) return;
    const newAsp = aspEl.value;
    m.binding = m.binding || {};
    m.binding.aspect = newAsp;
    const recipe = window.APP.s4.recipesByKey?.[m.binding.subject + '.' + newAsp];
    m.binding.customSlotKeys = recipe?.defaultSelection || null;
    m._evalSlots = null;
    _s4Render();
  };

  /* ── binding: primary/secondary 変更時 → subject自動推定 + フルrebuild ── */
  window.s4OnBindEntityChange = function() {
    _s4SaveCurrent();
    const m = window.APP.modules?.[window.APP.s4.activeTab];
    if (!m || !m.binding) return;
    // 現在の aspect が新 subject の recipes に存在しなければ先頭にリセット
    const recipes = (window.APP.s4.recipes || []).filter(r => r.subject === m.binding.subject);
    const validAspects = recipes.map(r => r.aspect);
    if (!validAspects.includes(m.binding.aspect)) {
      recipes.sort((a, b) => (a.priority || 'Z').localeCompare(b.priority || 'Z'));
      m.binding.aspect = recipes[0]?.aspect || 'free';
      const recipe = window.APP.s4.recipesByKey?.[m.binding.subject + '.' + m.binding.aspect];
      m.binding.customSlotKeys = recipe?.defaultSelection || null;
    }
    m._evalSlots = null;
    if (typeof window.s4Rebuild === 'function') {
      window.s4Rebuild();
    } else {
      _s4Render();
    }
  };

  /* ── scriptDir駆動 dataSlots自動充填（Wikipedia実データから抽出） ── */
  window.s4FillFromScriptDir = async function() {
    _s4SaveCurrent();
    const i = window.APP.s4.activeTab;
    const m = window.APP.modules?.[i];
    const post = window.APP.selected;
    if (!m || !post?.id) return;
    if (!m.scriptDir || !m.scriptDir.trim()) {
      _s4Msg('&#x26A0; 脚本指示が空です');
      return;
    }
    const btn = document.getElementById('s4BtnFillFromScript');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Wikipedia取得中...'; }
    _s4Msg('&#x2728; scriptDir → Wikipedia → AI抽出 中...');
    try {
      const r = await fetch('/api/v2/fill-slots-from-scriptdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId:    post.id,
          idx:       i,
          scriptDir: m.scriptDir,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        _s4Msg('&#x274C; 失敗: ' + (j.error || ''));
        if (btn) { btn.disabled = false; btn.textContent = '✨ scriptDirから取得'; }
        return;
      }
      // type別に該当フィールドへ反映
      if (j.catchphrases) {
        m.catchphrases = j.catchphrases;
        _s4Msg('&#x2705; ' + j.catchphrases.length + 'キャッチコピー充填 (' + j.source + ')');
      } else if (j.dataSlots) {
        m.dataSlots = j.dataSlots;
        _s4Msg('&#x2705; ' + j.dataSlots.length + 'スロット充填 (' + j.source + ')');
      }
      _s4Render();
    } catch (e) {
      _s4Msg('&#x274C; エラー: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '✨ scriptDirから取得'; }
    }
  };

  /* ── データ再取得：ビルダーAPIを呼んで現モジュールに反映 ── */
  window.s4Rebuild = async function() {
    _s4SaveCurrent();
    const i = window.APP.s4.activeTab;
    const m = window.APP.modules?.[i];
    const post = window.APP.selected;
    if (!m || !post?.id) return;
    if (!m.binding || m.binding.subject === 'generic') {
      _s4Msg('&#x26A0; generic.free のため再取得不要');
      return;
    }
    const btn = document.getElementById('s4BtnRebuild');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 再取得中...'; }
    _s4Msg('&#x1F504; ビルダー実行中...');
    try {
      const r = await fetch('/api/v2/rebuild-module', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          postId:  post.id,
          idx:     i,
          binding: m.binding,
          persist: false,
        }),
      });
      const j = await r.json();
      if (!j.ok) {
        _s4Msg('&#x274C; 再取得失敗: ' + (j.error || ''));
        if (btn) { btn.disabled = false; btn.textContent = '↻ データ再取得'; }
        return;
      }
      // ビルダー結果を現モジュールにマージ
      const result = j.module;
      m.type = result.type;
      if (result.dataSlots !== undefined) m.dataSlots = result.dataSlots;
      if (result.matchData !== undefined) m.matchData = result.matchData;
      if (result.catchphrases !== undefined) m.catchphrases = result.catchphrases;
      m.siBinding      = result.siBinding      ?? null;
      m.siBindingLeft  = result.siBindingLeft  ?? null;
      m.siBindingRight = result.siBindingRight ?? null;
      if (result.homeTeam) m.homeTeam = result.homeTeam;
      if (result.awayTeam) m.awayTeam = result.awayTeam;
      // 全評価済みスロットをキャッシュ（プルダウンの「label：value」表示用）
      m._evalSlots = j.evaluatedSlots || [];
      _s4Msg('&#x2705; データ再取得完了 (' + (j.evaluatedSlots?.length || 0) + '項目)');
      _s4Render();
    } catch (e) {
      _s4Msg('&#x274C; 再取得エラー: ' + e.message);
      if (btn) { btn.disabled = false; btn.textContent = '↻ データ再取得'; }
    }
  };

  function _s4SaveCurrent() {
    const i = window.APP.s4.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;

    // タイトル / タイプ / 脚本指示
    const t = document.getElementById('s4TitleInp');
    const tp = document.getElementById('s4TypeSel');
    const sd = document.getElementById('s4ScriptDirInp');
    if (t)  m.title     = t.value;
    if (tp) m.type      = tp.value;
    if (sd) m.scriptDir = sd.value;

    // binding 編集状態の収集（primary/secondary は "subject||label" 形式）
    function _parseEntityVal(v) {
      if (!v) return { subject: null, label: null };
      const ix = v.indexOf('||');
      if (ix < 0) return { subject: null, label: v };
      return { subject: v.slice(0, ix), label: v.slice(ix + 2) };
    }
    const bsubj   = document.getElementById('s4BindSubj');
    const baspect = document.getElementById('s4BindAspect');
    const bprim   = document.getElementById('s4BindPrimary');
    const bsec    = document.getElementById('s4BindSecondary');
    if (bsubj || baspect || bprim || bsec) {
      m.binding = m.binding || {};
      const pp = _parseEntityVal(bprim?.value);
      const ss = _parseEntityVal(bsec?.value);
      // subject は primary から自動推定（hidden の bsubj は表示用 fallback）
      if (pp.subject)      m.binding.subject = pp.subject;
      else if (bsubj)      m.binding.subject = bsubj.value;
      if (baspect)         m.binding.aspect  = baspect.value;
      m.binding.primary    = pp.label || null;
      m.binding.secondary  = ss.label || null;
    }
    // customSlotKeys: dataSlots プルダウンから収集
    const slotKeyEls = document.querySelectorAll('.s4-slot-key');
    if (slotKeyEls.length && m.binding) {
      const keys = Array.from(slotKeyEls).map(el => el.value).filter(Boolean);
      if (keys.length) m.binding.customSlotKeys = keys;
    }

    // ナレーション
    const n = document.getElementById('s4Narration');
    if (n) m.narration = n.value;

    // chunks
    const chunkEls = document.querySelectorAll('.s4-chunk');
    if (chunkEls.length) m.narrationChunks = Array.from(chunkEls).map(el => el.value);

    // タイプ別データ収集
    const t2 = m.type;
    if (['stats','profile','matchcard'].includes(t2)) {
      // 新形式（プルダウン+値）
      const keyEls = document.querySelectorAll('.s4-slot-key');
      const valEls = document.querySelectorAll('.s4-slot-value');
      if (keyEls.length) {
        const recipe = window.APP.s4?.recipesByKey?.[m.binding?.subject + '.' + m.binding?.aspect];
        const availSlots = recipe?.availableSlots || [];
        const slots = [];
        for (let j = 0; j < keyEls.length; j++) {
          const key = keyEls[j].value || '';
          const slotMeta = availSlots.find(s => s.key === key);
          slots.push({
            slotKey: key || undefined,
            label:   slotMeta?.label || (m.dataSlots?.[j]?.label || ''),
            value:   valEls[j]?.value || '',
          });
        }
        m.dataSlots = slots;
      } else {
        // 旧形式（merged入力）
        const merged = document.querySelectorAll('.s4-slot');
        const slots = Array.from(merged).map(el => {
          const raw = el.value || '';
          const parts = raw.split(/[:：]/);
          const lbl = (parts[0] || '').trim();
          const val = parts.slice(1).join(':').trim();
          return { label: lbl, value: val, merged: raw };
        });
        m.dataSlots = slots;
      }
    } else if (t2 === 'comparison') {
      // 新形式（プルダウンラベル）
      const cmpKeyEls = document.querySelectorAll('.s4-cmp-label-sel');
      const lefts  = document.querySelectorAll('.s4-cmp-left');
      const rights = document.querySelectorAll('.s4-cmp-right');
      if (cmpKeyEls.length) {
        const recipe = window.APP.s4?.recipesByKey?.[m.binding?.subject + '.' + m.binding?.aspect];
        const availSlots = recipe?.availableSlots || [];
        const slots = [];
        for (let j = 0; j < cmpKeyEls.length; j++) {
          const key = cmpKeyEls[j].value || '';
          const slotMeta = availSlots.find(s => s.key === key);
          slots.push({
            slotKey:    key || undefined,
            label:      slotMeta?.label || (m.dataSlots?.[j]?.label || ''),
            leftValue:  lefts[j]?.value  || '',
            rightValue: rights[j]?.value || '',
          });
        }
        m.dataSlots = slots;
      } else {
        // 旧形式
        const labels = document.querySelectorAll('.s4-cmp-label');
        const slots = [];
        for (let j = 0; j < labels.length; j++) {
          slots.push({
            label:      labels[j]?.value || '',
            leftValue:  lefts[j]?.value  || '',
            rightValue: rights[j]?.value || '',
          });
        }
        m.dataSlots = slots;
      }
    } else if (t2 === 'insight') {
      const inputs = document.querySelectorAll('.s4-phrase');
      m.catchphrases = Array.from(inputs).map(el => el.value);
    } else if (t2 === 'reaction') {
      const texts  = document.querySelectorAll('.s4-cmt-text');
      const scores = document.querySelectorAll('.s4-cmt-score');
      const coms = [];
      for (let j = 0; j < texts.length; j++) {
        coms.push({
          text:  texts[j]?.value || '',
          score: Number(scores[j]?.value) || 0,
        });
      }
      m.comments = coms;
    } else if (t2 === 'history') {
      const dates  = document.querySelectorAll('.s4-hist-date');
      const titles = document.querySelectorAll('.s4-hist-title');
      const slots = [];
      for (let j = 0; j < dates.length; j++) {
        slots.push({
          label: dates[j]?.value  || '',
          value: titles[j]?.value || '',
        });
      }
      m.dataSlots = slots;
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

  /* ── 動画生成（Phase 4a） ── */
  window.s4GenerateVideo = async function() {
    _s4SaveCurrent();
    const mods = window.APP.modules || [];
    if (!mods.length) return alert('モジュールがありません');
    const postId = window.APP.selected?.id;
    if (!postId) return alert('案件が選択されていません');

    // 1. ジョブ起動
    _s4Msg('&#x1F3AC; 動画生成ジョブ起動中...');
    let jobId;
    try {
      const d = await fetchJson('/api/v2/generate-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId, modules: mods }),
      });
      if (!d.ok) { _s4Msg('&#x274C; ' + (d.error || '起動失敗')); return; }
      jobId = d.jobId;
    } catch (e) {
      _s4Msg('&#x274C; 起動エラー: ' + e.message);
      return;
    }

    // 2. 進捗パネル表示
    const panel = document.getElementById('s4GenProgress');
    const jobIdEl = document.getElementById('s4JobId');
    const statusEl = document.getElementById('s4JobStatus');
    const bar = document.getElementById('s4JobBar');
    panel.style.display = 'block';
    jobIdEl.textContent = jobId;
    statusEl.textContent = 'キュー登録完了、レンダリング開始待ち...';
    bar.style.width = '0%';
    _s4Msg('&#x2705; ジョブID ' + jobId);

    // 3. ポーリング（2秒間隔）
    const timer = setInterval(async function() {
      try {
        const s = await fetchJson('/api/v2/video-status?jobId=' + encodeURIComponent(jobId));
        const st = s.status || '?';
        const total = s.totalSlides || 0;
        const done  = s.doneSlides || 0;
        const pct = total ? Math.round(done / total * 85) : 10; // 最後のconcat/audioで+15%

        if (st === 'done') {
          bar.style.width = '100%';
          statusEl.textContent = '&#x2705; 完成！';
          statusEl.innerHTML = '&#x2705; 完成しました！';
          clearInterval(timer);
          setTimeout(function() { panel.style.display = 'none'; }, 3000);
          _s4LoadVideos(); // 一覧リロード
        } else if (st === 'error') {
          statusEl.innerHTML = '&#x274C; 失敗: ' + _e(s.error || '不明なエラー');
          bar.style.background = '#ef4444';
          clearInterval(timer);
        } else {
          statusEl.textContent = st + (total ? ' (' + done + '/' + total + ')' : '');
          bar.style.width = pct + '%';
        }
      } catch (e) {
        // ポーリングで404等は無視（まだ書き出し直後の可能性）
      }
    }, 2000);
  };

  /* ── 生成済み動画一覧ロード ── */
  window._s4LoadVideos = async function() {
    const postId = window.APP.selected?.id;
    if (!postId) return;
    const listEl = document.getElementById('s4VideoList');
    try {
      const d = await fetchJson('/api/v2/videos?postId=' + encodeURIComponent(postId));
      const vids = d.videos || [];
      if (!vids.length) {
        listEl.innerHTML = '<div style="font-size:11px;color:#5a6a8a">まだ生成した動画はありません</div>';
        return;
      }
      listEl.innerHTML = vids.map(v => {
        const sizeMB = (v.sizeBytes / 1024 / 1024).toFixed(1);
        const dt = new Date(v.createdAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
        return '<div style="background:#0d1220;border:1px solid var(--border);border-radius:8px;padding:10px 14px;display:flex;align-items:center;gap:10px">'
          + '<span style="flex:1;font-size:12px;color:#c0cce0">&#x1F39E; ' + _e(v.file) + '</span>'
          + '<span style="font-size:10px;color:#8a9aba">' + dt + ' / ' + sizeMB + 'MB</span>'
          + '<a href="' + v.url + '" target="_blank" class="btn btn-sm" style="background:var(--c);color:#fff;text-decoration:none">&#x25B6; 再生</a>'
          + '<a href="' + v.url + '" download class="btn btn-sm" style="background:#10b981;color:#fff;text-decoration:none">&#x2B07; DL</a>'
          + '</div>';
      }).join('');
    } catch (e) {
      listEl.innerHTML = '<div style="font-size:11px;color:#ef4444">一覧取得エラー: ' + e.message + '</div>';
    }
  };

  /* step4Init の後に動画一覧もロード */
  const _origInit = window.step4Init;
  window.step4Init = function() {
    _origInit();
    setTimeout(window._s4LoadVideos, 300);
  };

  /* ── 追加/削除ヘルパー ── */
  function _s4AddArrayItem(field, defaultVal) {
    _s4SaveCurrent();
    const m = window.APP.modules?.[window.APP.s4.activeTab];
    if (!m) return;
    if (!Array.isArray(m[field])) m[field] = [];
    m[field].push(defaultVal);
    _s4Render();
  }
  function _s4RemoveArrayItem(field, idx) {
    _s4SaveCurrent();
    const m = window.APP.modules?.[window.APP.s4.activeTab];
    if (!m || !Array.isArray(m[field])) return;
    if (m[field].length > 0) m[field].splice(idx, 1);
    _s4Render();
  }

  /* ── イベント委任 ── */
  document.addEventListener('click', function(e) {
    const id = e.target.id;
    const cls = e.target.classList;
    const idx = cls && cls.length ? parseInt(e.target.dataset.idx, 10) : null;

    if (id === 's4BtnGenAll')         return window.s4GenerateAll();
    if (id === 's4BtnRegen')          return window.s4RegenNarration();
    if (id === 's4BtnNext')           return window.s4GenerateVideo();
    if (id === 's4BtnRefreshVideos')  return window._s4LoadVideos();
    if (id === 's4BtnRebuild')        return window.s4Rebuild();
    if (id === 's4BtnFillFromScript') return window.s4FillFromScriptDir();

    // 追加ボタン
    if (id === 's4BtnAddSlot')      return _s4AddArrayItem('dataSlots', { label: '', value: '', merged: '' });
    if (id === 's4BtnAddCmpSlot')   return _s4AddArrayItem('dataSlots', { label: '', leftValue: '', rightValue: '' });
    if (id === 's4BtnAddPhrase')    return _s4AddArrayItem('catchphrases', '');
    if (id === 's4BtnAddComment')   return _s4AddArrayItem('comments', { text: '', score: 0 });
    if (id === 's4BtnAddHistEvt')   return _s4AddArrayItem('dataSlots', { label: '', value: '' });

    // 削除ボタン（class名で判別）
    if (cls.contains('s4-slot-remove'))    return _s4RemoveArrayItem('dataSlots', idx);
    if (cls.contains('s4-cmp-remove'))     return _s4RemoveArrayItem('dataSlots', idx);
    if (cls.contains('s4-phrase-remove'))  return _s4RemoveArrayItem('catchphrases', idx);
    if (cls.contains('s4-cmt-remove'))     return _s4RemoveArrayItem('comments', idx);
    if (cls.contains('s4-hist-remove'))    return _s4RemoveArrayItem('dataSlots', idx);
  });

  /* ── プルダウン変更時：選択した slot の評価値を value 入力に自動転記 ── */
  document.addEventListener('change', function(e) {
    if (e.target.classList && e.target.classList.contains('s4-slot-key')) {
      const idx = parseInt(e.target.dataset.idx, 10);
      const newKey = e.target.value;
      const m = window.APP.modules?.[window.APP.s4.activeTab];
      if (!m || !newKey) return;
      const ev = (m._evalSlots || []).find(function(s) { return s.key === newKey; });
      if (!ev) return;
      // single-side
      if (ev.value !== undefined) {
        const valEl = document.querySelector('.s4-slot-value[data-idx="' + idx + '"]');
        if (valEl) valEl.value = ev.value;
      }
      // compare（左右）
      if (ev.leftValue !== undefined) {
        const lEl = document.querySelector('.s4-cmp-left[data-idx="' + idx + '"]');
        const rEl = document.querySelector('.s4-cmp-right[data-idx="' + idx + '"]');
        if (lEl) lEl.value = ev.leftValue;
        if (rEl) rEl.value = ev.rightValue;
      }
      // ラベルも recipe のラベルに揃える（dataSlot[i].label）
      _s4SaveCurrent();
      return;
    }
  });

  /* ── 型変更時の再描画 + プレビュー更新 ── */
  document.addEventListener('change', function(e) {
    if (e.target.id === 's4TypeSel') {
      _s4SaveCurrent();
      _s4Render();
      setTimeout(window._s4ReloadPreview, 100);
    }
  });

  /* ── 編集内容を即時プレビューに反映（debounce 1000ms）── */
  let _s4PreviewTimer = null;
  document.addEventListener('input', function(e) {
    if (!document.getElementById('s4Editor')?.contains(e.target)) return;
    clearTimeout(_s4PreviewTimer);
    _s4PreviewTimer = setTimeout(function() {
      window._s4ReloadPreview();
    }, 1000);
  });

  /* ヘルパー */
  function _s4Msg(t) {
    const el = document.getElementById('s4Msg');
    if (el) el.innerHTML = t;
    // ログにも追記
    _s4Log(t.replace(/&#x[0-9A-F]+;/g, '').trim());
  }
  function _s4Log(msg) {
    const el = document.getElementById('s4Log');
    if (!el) return;
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    const line = document.createElement('div');
    line.innerHTML = '<span style="color:#5a6a8a">[' + ts + ']</span> ' + String(msg || '');
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  function _e(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ── プレビュー iframe 更新（modules を server に save→ iframe 再読込）── */
  window._s4ReloadPreview = async function() {
    const post = window.APP.selected;
    if (!post) return;
    const i = window.APP.s4.activeTab;
    const frame = document.getElementById('s4PreviewFrame');
    if (!frame) return;

    _s4SaveCurrent();

    // modules をサーバーに保存（preview-slide が読むファイル）
    try {
      await fetchJson('/api/save-modules', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ postId: post.id, modules: window.APP.modules || [] }),
      });
    } catch (_) {}

    // cache bust で強制リロード
    const ts = Date.now();
    frame.src = '/api/v2/preview-slide?postId=' + encodeURIComponent(post.id) + '&idx=' + i + '&_ts=' + ts;
  };

  /* ── プレビュー枠のリサイズ時にスケール計算 ── */
  window._s4FitPreview = function() {
    const wrap = document.getElementById('s4PreviewWrap');
    const frame = document.getElementById('s4PreviewFrame');
    if (!wrap || !frame) return;
    const w = wrap.clientWidth;
    const scale = w / 1920;
    frame.style.transform = 'scale(' + scale + ')';
  };
  window.addEventListener('resize', function() { window._s4FitPreview(); });

  /* ── 画像ギャラリー ── */
  window._s4LoadGallery = async function() {
    const el = document.getElementById('s4Gallery');
    try {
      const d = await fetchJson('/api/v2/gallery');
      const imgs = d.images || [];
      if (!imgs.length) {
        el.innerHTML = '<div style="grid-column:1/-1;color:#5a6a8a;font-size:11px;text-align:center;padding:12px">画像がありません</div>';
        return;
      }
      el.innerHTML = imgs.map(function(im) {
        return '<div class="s4-gal-item" data-url="' + _e(im.url) + '" data-path="' + _e(im.path) + '"'
          + ' style="cursor:pointer;position:relative;aspect-ratio:16/9;background:#000 url(' + im.url + ') center/cover;'
          + 'border-radius:4px;border:2px solid transparent;transition:border-color .1s" title="' + _e(im.name) + '"></div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<div style="grid-column:1/-1;color:#ef4444;font-size:11px;text-align:center">ギャラリーロード失敗: ' + e.message + '</div>';
    }
  };

  /* ── ギャラリー画像クリック → 現モジュールにセット ── */
  document.addEventListener('click', function(e) {
    if (!e.target.classList) return;
    if (e.target.classList.contains('s4-gal-item')) {
      const url = e.target.dataset.url;
      const path = e.target.dataset.path;
      const i = window.APP.s4.activeTab;
      const m = window.APP.modules?.[i];
      if (!m) return;
      m.bgImage = path;
      const curBgEl = document.getElementById('s4CurrentBg');
      if (curBgEl) curBgEl.textContent = path;
      _s4Log('背景画像セット: ' + path);
      window._s4ReloadPreview();
    }
  });

  /* ログクリアボタン */
  document.addEventListener('click', function(e) {
    if (e.target.id === 's4BtnClearLog') {
      const el = document.getElementById('s4Log');
      if (el) el.innerHTML = '<div style="color:#5a6a8a">[log] クリア</div>';
    } else if (e.target.id === 's4BtnReloadPreview') {
      window._s4ReloadPreview();
    } else if (e.target.id === 's4BtnRefreshGallery') {
      window._s4LoadGallery();
    } else if (e.target.id === 's4BtnGenVoice') {
      _s4Log('⏳ 音声生成: Phase 5（MiniMax連携）で実装予定');
    }
  });

  /* ── モジュールタブ切替時にプレビューも更新 ── */
  const _s4SwitchOrig = window.s4Switch;
  window.s4Switch = function(i) {
    _s4SwitchOrig(i);
    // 現モジュールの bgImage 表示
    const m = window.APP.modules?.[i];
    const curBgEl = document.getElementById('s4CurrentBg');
    if (curBgEl) curBgEl.textContent = m?.bgImage || '(未設定)';
    // プレビューロード
    setTimeout(window._s4ReloadPreview, 100);
  };

  /* ── step4Init 完了後のフック：プレビュー + ギャラリー ── */
  const _origStep4Init = window.step4Init;
  window.step4Init = function() {
    _origStep4Init();
    setTimeout(function() {
      window._s4LoadVideos();
      window._s4LoadGallery();
      window._s4FitPreview();
      setTimeout(window._s4ReloadPreview, 300);
      // 現モジュールの bgImage 表示
      const m = window.APP.modules?.[window.APP.s4.activeTab];
      const curBgEl = document.getElementById('s4CurrentBg');
      if (curBgEl) curBgEl.textContent = m?.bgImage || '(未設定)';
    }, 300);
  };

})();
</script>`;
}

module.exports = { router, getUI };
