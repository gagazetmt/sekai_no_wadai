// routes/step3_routes.js
// ═══════════════════════════════════════════════════════
// STEP 3: 構成提案（Claude によるモジュール提案・編集・画像取得）
// 3-1〜3-8 完全実装版
// このファイルのみ編集することで Step3 の挙動・表示を変更できます。
// 他の Step ファイルへの依存: なし
// ═══════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { callAI }               = require('../scripts/ai_client');
const { fetchWikimediaImages } = require('../scripts/fetch_wikimedia');
const { fetchXImages }         = require('../scripts/fetch_x_images');

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, '..', 'data');
const SI_DIR    = path.join(DATA_DIR, 'si_data');
const IMG_DIR   = path.join(__dirname, '..', 'images');

[DATA_DIR, SI_DIR, IMG_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function safeJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}

function siPath(postId)      { return path.join(SI_DIR,   (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '.json'); }
function modulesPath(postId) { return path.join(DATA_DIR, (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '_modules.json'); }
function imagesPath(postId)  { return path.join(DATA_DIR, (postId||'unknown').replace(/[\/\?%*:|"<>\.]/g,'_') + '_images.json'); }

// ─── SI データサマリー（AI プロンプト用に圧縮）─────────────
// 取得済みSIデータから、AIが読みやすい形の「ラベル → 主要フィールド」マップを作る
function buildSiSummary(siData) {
  const summary = {};
  if (!siData?.boxes) return summary;

  Object.entries(siData.boxes).forEach(([boxType, box]) => {
    (box.fetched || []).forEach(f => {
      const d = f.data;
      if (!d || d.ok === false) return;
      const label = f.label;

      if (boxType === 'sofascore_player') {
        summary[label] = {
          type: 'player',
          position:     d.position,
          team:         d.team,
          age:          d.age,
          nationality:  d.nationality,
          height:       d.height,
          preferredFoot:d.preferredFoot,
          marketValue:  d.marketValue,
          league:       d.leagueName,
          goals:        d.seasonStats?.goals,
          assists:      d.seasonStats?.assists,
          appearances:  d.seasonStats?.appearances,
          rating:       d.seasonStats?.rating,
          minutes:      d.seasonStats?.minutesPlayed,
          xG:           d.seasonStats?.expectedGoals,
          keyPasses:    d.seasonStats?.keyPasses,
          lastMatchRating: d.lastMatchStats?.rating,
          last5Results: (d.last5Matches || []).slice(0, 5).map(m => (m.rating || '?') + ' vs ' + m.opponent),
        };
      } else if (boxType === 'sofascore_team') {
        summary[label] = {
          type:     'team',
          league:   d.leagueName,
          country:  d.country,
          founded:  d.founded,
          manager:  d.managerName,
          position: d.standing?.position,
          played:   d.standing?.played,
          wins:     d.standing?.wins,
          draws:    d.standing?.draws,
          losses:   d.standing?.losses,
          gf:       d.standing?.goalsFor,
          ga:       d.standing?.goalsAgainst,
          points:   d.standing?.points,
          marketValue: d.marketValue,
          last5:    (d.last5 || []).map(m => m.result + ':' + m.opponent).join(','),
        };
      } else if (boxType === 'sofascore_manager') {
        summary[label] = {
          type:        'manager',
          nationality: d.nationality,
          age:         d.age,
          formation:   d.preferredFormation,
          currentTeam: d.currentTeam,
          since:       d.currentTeamSince,
          overallWinRate: d.overallPerformance?.winRate,
          totalMatches:   d.overallPerformance?.total,
          currentTeamW:   d.currentTeamStats?.wins,
          currentTeamD:   d.currentTeamStats?.draws,
          currentTeamL:   d.currentTeamStats?.losses,
        };
      } else if (boxType === 'sofascore_match') {
        summary[label] = {
          type:       'match',
          scoreline:  d.scoreline,
          date:       d.matchDate,
          tournament: d.tournament,
          venue:      d.venue,
          goals:      (d.goals || []).slice(0, 5).map(g => g.timeStr + ' ' + g.player).join('; '),
          topPlayers: (d.topPlayers || []).slice(0, 3).map(p => p.name + ':' + p.rating).join(','),
          h2h:        d.h2hSummary,
        };
      } else if (boxType === 'wikipedia') {
        summary[label] = {
          type:   'wiki',
          title:  d.title,
          extract: (d.extract || '').slice(0, 250),
        };
      } else if (boxType === 'news') {
        const top = (d.organic || []).slice(0, 2);
        summary[label] = {
          type: 'news',
          headlines: top.map(r => r.title).join(' | '),
        };
      }
    });
  });
  return summary;
}

// 投稿コメントから reaction 用候補を抽出（英語→Claude翻訳は重いので素のまま7件）
function pickRawComments(post, n = 10) {
  const comments = (post.raw?.comments || [])
    .filter(c => c && (c.body || c.bodyJa))
    .slice(0, n * 2) // 余裕をもって
    .map(c => ({
      text:   c.bodyJa || c.body || '',
      score:  c.score || 0,
    }))
    .filter(c => c.text.length >= 8 && c.text.length <= 280) // 短すぎ/長すぎ除外
    .slice(0, n);
  return comments;
}

// ─── API ─────────────────────────────────────────────────

// モジュール構成提案（Claude Sonnet）
router.post('/propose-modules', async (req, res) => {
  const { post, postId, siDataIn } = req.body;
  if (!post) return res.status(400).json({ error: 'post required' });
  console.log('[Step3] モジュール提案:', post.title || post.titleOrig);

  let siData = siDataIn || {};
  if (postId && !Object.keys(siData).length) siData = safeJson(siPath(postId), {});

  const commentsRaw = (post.raw?.comments || [])
    .map(c => c.bodyJa || c.body || '').filter(Boolean).slice(0, 10).join(' / ');

  // SI データサマリーをJSON化（AIが各ラベルのフィールドを引用できるように）
  const siSummary     = buildSiSummary(siData);
  const siSummaryText = Object.keys(siSummary).length
    ? JSON.stringify(siSummary, null, 0).slice(0, 3500)
    : '(なし)';

  // reaction 用の投稿コメント候補（AIに翻訳/選定させる素材）
  const rawComments = pickRawComments(post, 12);

  const prompt = `あなたはプロのサッカーYouTubeチャンネルの脚本家です。
以下の案件・コメント・SI情報をもとに、スライド構成を6〜9枚で提案し、各モジュールのデータバインドまで埋めてください。

【案件（日本語）】${post.title || post.titleOrig}
【案件（原文）】${post.titleOrig || ''}
【元コメント（翻訳前または日本語）】${commentsRaw || '(なし)'}

【取得済みSIデータ（ラベル→主要フィールド）】
${siSummaryText}

【絶対ルール】
1. 1枚目は type="opening"、最後は type="ending"（固定）
2. 全モジュールに scriptDir を記入
3. stats/profile/matchcard には dataSlots（4個）を必ず記入（SIデータから実値を引用）
4. comparison には dataSlots（4行）と siBindingLeft / siBindingRight を記入
5. insight には catchphrases（3〜5個）を必ず記入
6. reaction には comments（7個、日本語訳済み）を必ず記入
7. matchcenter は siBinding のみ（sofascore_match ラベル必須。dataSlotsは不要）
8. opening/ending/history は dataSlots 不要

【データバインド形式】
- stats/profile/matchcard の dataSlots:
    [{"label":"GOALS","value":"24"},{"label":"ASSISTS","value":"5"},
     {"label":"RATING","value":"7.92"},{"label":"MARKET","value":"€180M"}]
    → value は SIデータ（siBindingラベル）から引用した実値。なければ推定値でも可
- comparison の dataSlots:
    [{"label":"GOALS","leftValue":"24","rightValue":"18"},
     {"label":"ASSISTS","leftValue":"5","rightValue":"3"},...4行]
    → siBindingLeft="選手A", siBindingRight="選手B" を両方記入
- insight の catchphrases:
    ["18歳でCL8得点","ドルトムントで2年で80ゴール","マンCで111試合100ゴール","3年連続得点王"]
    → 短く・強く・数字や事実をベースに
- reaction の comments:
    [{"text":"ハーランドは人外","score":2453},{"text":"...","score":1820},...7件]
    → 上の【元コメント】から上位7件を選定し日本語に意訳（元が日本語ならそのまま）

【使用可能なスライドタイプ】
opening / insight / stats / reaction / profile / comparison / history / matchcard / matchcenter / ending

JSONのみ返すこと（説明・マークダウン不要）。以下は例：
{"modules": [
  {"title":"衝撃！ハーランドの偉業","type":"opening","reason":"視聴者を掴む","scriptDir":"...","siBinding":null},
  {"title":"HAALANDの偉業","type":"insight","reason":"...","scriptDir":"...","siBinding":"Erling Haaland","catchphrases":["18歳でCL8得点","ドルトムントで80ゴール","3年連続得点王"]},
  {"title":"今期スタッツ","type":"stats","reason":"...","scriptDir":"...","siBinding":"Erling Haaland","dataSlots":[{"label":"GOALS","value":"24"},{"label":"ASSISTS","value":"5"},{"label":"RATING","value":"7.92"},{"label":"xG","value":"22.3"}]},
  {"title":"海外の声","type":"reaction","reason":"...","scriptDir":"...","siBinding":null,"comments":[{"text":"...","score":0},{"text":"...","score":0},...7件]},
  {"title":"まとめ","type":"ending","reason":"...","scriptDir":"...","siBinding":null}
]}`;

  try {
    const raw    = await callAI({ model: 'claude-sonnet-4-6', max_tokens: 6000, messages: [{ role: 'user', content: prompt }] });
    const m      = raw.match(/\{[\s\S]*\}/);
    if (!m) { console.error('[Step3] JSONパース失敗:', raw.slice(0,200)); return res.status(500).json({ error: 'JSONパース失敗' }); }
    const parsed = JSON.parse(m[0]);
    const mods   = parsed.modules || [];

    // scriptDir が欠けている場合のデフォルト補完
    const defaultScriptDir = {
      opening:     '衝撃的な問いかけや事実で始め、視聴者を最初の3秒で引き込む。',
      insight:     'キャッチコピーを3〜5個ナレーションに合わせて積み上げ、視聴者の記憶に残す。',
      stats:       '具体的な数字・データを見せ、情報の信頼性と説得力を高める。',
      reaction:    '海外ファンのリアルなコメントを紹介し、視聴者の共感を生む。',
      profile:     '選手・監督のプロフィールや実績を深掘りし、視聴者の興味を引く。',
      comparison:  '2者を比較することで違いを際立たせ、視聴者に気づきを与える。',
      history:     '時系列でストーリーを展開し、出来事の流れを分かりやすく伝える。',
      matchcard:   '両チームの情報を並列で紹介し、試合への期待感を高める。',
      matchcenter: 'スコア・ピッチ・スタッツを順に見せ、試合の全貌を伝える。',
      ending:      '全体のまとめと感想を述べ、コメントへの参加とチャンネル登録を促す。',
    };

    // データバインドの欠落を補完
    mods.forEach(mod => {
      if (!mod.scriptDir || !mod.scriptDir.trim()) {
        mod.scriptDir = defaultScriptDir[mod.type] || '';
      }
      if (['stats','profile','matchcard'].includes(mod.type)) {
        if (!Array.isArray(mod.dataSlots) || mod.dataSlots.length < 4) {
          const existing = Array.isArray(mod.dataSlots) ? mod.dataSlots : [];
          while (existing.length < 4) existing.push({ label: 'ITEM' + (existing.length + 1), value: '-' });
          mod.dataSlots = existing.slice(0, 4);
        }
      }
      if (mod.type === 'comparison') {
        if (!Array.isArray(mod.dataSlots) || mod.dataSlots.length < 4) {
          const existing = Array.isArray(mod.dataSlots) ? mod.dataSlots : [];
          while (existing.length < 4) existing.push({ label: 'ITEM' + (existing.length + 1), leftValue: '-', rightValue: '-' });
          mod.dataSlots = existing.slice(0, 4);
        }
      }
      if (mod.type === 'insight') {
        if (!Array.isArray(mod.catchphrases) || !mod.catchphrases.length) {
          mod.catchphrases = [(mod.title || 'キャッチコピー1'), 'キャッチコピー2', 'キャッチコピー3'];
        }
      }
      if (mod.type === 'reaction') {
        if (!Array.isArray(mod.comments) || !mod.comments.length) {
          // AIが出し忘れた場合は生コメントで埋める（未翻訳・上位7件）
          mod.comments = rawComments.slice(0, 7);
        }
      }
    });

    // opening が先頭になければ自動挿入
    if (!mods.length || mods[0].type !== 'opening') {
      const topTitle = (post.title || post.titleOrig || '').slice(0, 25);
      mods.unshift({
        title:     '衝撃！' + topTitle,
        type:      'opening',
        reason:    '視聴者を最初の3秒で引き込むオープニング',
        scriptDir: defaultScriptDir.opening,
        siBinding: null,
      });
    }
    // ending が末尾になければ自動挿入
    if (!mods.length || mods[mods.length - 1].type !== 'ending') {
      mods.push({
        title:     'まとめ・チャンネル登録を！',
        type:      'ending',
        reason:    '余韻を残しチャンネル登録を促す',
        scriptDir: defaultScriptDir.ending,
        siBinding: null,
      });
    }

    parsed.modules = mods;
    console.log('[Step3] 提案成功:', mods.length, '件 (opening/ending補完済み)');
    res.json(parsed);
  } catch (e) {
    console.error('[Step3] エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール1件のデータバインドのみ再生成（dataSlots / catchphrases / comments）
router.post('/populate-module', async (req, res) => {
  const { post, postId, siDataIn, module: mod } = req.body;
  if (!post || !mod) return res.status(400).json({ error: 'post + module required' });

  let siData = siDataIn || {};
  if (postId && !Object.keys(siData).length) siData = safeJson(siPath(postId), {});
  const siSummary = buildSiSummary(siData);
  const siSummaryText = Object.keys(siSummary).length
    ? JSON.stringify(siSummary, null, 0).slice(0, 3000)
    : '(なし)';

  const type = mod.type;
  const rawComments = pickRawComments(post, 12);

  let askSpec = '';
  if (['stats','profile','matchcard'].includes(type)) {
    askSpec = `この "${type}" スライドの dataSlots（4個）を生成してください。
siBinding="${mod.siBinding || 'なし'}" のデータから適切なラベルと値を抽出。
JSONのみ: {"dataSlots":[{"label":"GOALS","value":"24"},{"label":"...","value":"..."},...4個]}`;
  } else if (type === 'comparison') {
    askSpec = `この "comparison" スライドの dataSlots（4行）と2者の siBinding を生成。
適切な2者を siBindingLeft と siBindingRight で指定し、対比可能な項目を4行作る。
JSONのみ: {"siBindingLeft":"選手A","siBindingRight":"選手B","dataSlots":[{"label":"GOALS","leftValue":"24","rightValue":"18"},...4行]}`;
  } else if (type === 'insight') {
    askSpec = `この "insight" スライドのキャッチコピー（3〜5個）を生成。
siBinding="${mod.siBinding || 'なし'}" の情報や案件の衝撃的事実を短く強く書く。
JSONのみ: {"catchphrases":["短い衝撃コピー1","コピー2","コピー3"]}`;
  } else if (type === 'reaction') {
    askSpec = `この "reaction" スライドの視聴者共感用コメント（7個）を生成。
以下の元コメントから面白い7件を選定し、必要なら日本語に意訳：
${JSON.stringify(rawComments, null, 0)}
JSONのみ: {"comments":[{"text":"...","score":0},...7件]}`;
  } else if (type === 'matchcenter') {
    return res.json({ /* matchcenterは自動解決 */ ok: true, note: 'matchcenter は siBinding の sofascore_match データから自動展開されます' });
  } else {
    return res.json({ ok: true, note: `${type} にはデータバインドがありません` });
  }

  const prompt = `スライドタイトル: 「${mod.title}」
タイプ: ${type}
脚本指示: ${mod.scriptDir || '(なし)'}

【案件】${post.title || post.titleOrig}
【取得済みSIデータ】${siSummaryText}

${askSpec}`;

  try {
    const raw = await callAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ error: 'JSONパース失敗' });
    const parsed = JSON.parse(m[0]);
    console.log('[Step3] populate-module:', type, mod.title.slice(0, 30));
    res.json({ ok: true, ...parsed });
  } catch (e) {
    console.error('[Step3] populate-module エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール1件の脚本指示再提案
router.post('/regen-module-script', async (req, res) => {
  const { post, module: mod, allModules } = req.body;
  if (!post || !mod) return res.status(400).json({ error: 'post + module required' });
  console.log('[Step3] 脚本指示再提案:', mod.title);
  const otherTitles = (allModules || []).filter(m => m.title !== mod.title).map(m => m.title).join(', ');
  try {
    const raw = await callAI({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content:
        `あなたはサッカーYouTubeの脚本家です。以下のスライドの脚本指示を再提案してください。
スライドタイプ: ${mod.type}、タイトル: 「${mod.title}」
案件: ${post.title || post.titleOrig}
全体構成（他のスライド）: ${otherTitles || 'なし'}
SIバインド: ${mod.siBinding || 'なし'}

このスライドの脚本指示（ナレーション方向性・演出ポイント）を2〜3文で提案してください。
JSONのみ: {"scriptDir": "脚本指示テキスト"}` }]
    });
    const m = raw.match(/\{[\s\S]*\}/);
    res.json(m ? JSON.parse(m[0]) : { scriptDir: '' });
  } catch (e) {
    console.error('[Step3] 脚本指示再提案エラー:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// モジュール保存（確定時）
router.post('/save-modules', (req, res) => {
  const { postId, modules } = req.body;
  if (!postId || !modules) return res.status(400).json({ error: 'postId + modules required' });
  try {
    fs.writeFileSync(modulesPath(postId), JSON.stringify({ postId, modules, savedAt: new Date().toISOString() }, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 画像取得（3-7/3-8: X + Wikimedia Commons）
router.post('/fetch-images', async (req, res) => {
  const { postId, keywords } = req.body;
  if (!postId || !keywords?.length) return res.status(400).json({ error: 'postId + keywords required' });
  console.log(`[Step3] 画像取得開始: ${keywords.length}キーワード / postId:${postId}`);

  const prefix    = (postId||'img').replace(/[\/\?%*:|"<>\.]/g,'_').slice(-20);
  const allImages = [];

  for (const kw of keywords) {
    const safeKw = String(kw).trim();
    if (!safeKw) continue;
    console.log(`  → 画像取得: "${safeKw}"`);
    try {
      const wikiPaths = await fetchWikimediaImages(safeKw, `${prefix}_${allImages.length}`, 3);
      wikiPaths.forEach(p => allImages.push({ path: p, keyword: safeKw, source: 'wikimedia' }));
    } catch (e) { console.warn(`  [Wiki] "${safeKw}" 失敗:`, e.message); }
    try {
      const xPaths = await fetchXImages(safeKw, `${prefix}_x_${allImages.length}`, 3);
      xPaths.forEach(p => allImages.push({ path: p, keyword: safeKw, source: 'x' }));
    } catch (e) { console.warn(`  [X] "${safeKw}" 失敗:`, e.message); }
  }

  // 取得結果を保存
  fs.writeFileSync(imagesPath(postId), JSON.stringify({ postId, images: allImages, fetchedAt: new Date().toISOString() }, null, 2));
  console.log(`[Step3] 画像取得完了: ${allImages.length}枚`);
  res.json({ ok: true, count: allImages.length, images: allImages });
});

// 画像一覧取得（保存済み）
router.get('/images', (req, res) => {
  const data = safeJson(imagesPath(req.query.postId), { images: [] });
  res.json(data);
});

// ─── UI（3-1〜3-8 完全実装）─────────────────────────────

function getUI() {
  return /* html */`
<div id="step3" class="step-container" style="display:none;">
<div style="padding:0 20px 20px;">

  <!-- 提案ボタン -->
  <div class="panel" style="margin-bottom:16px;">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn btn-primary" style="font-size:14px;padding:12px 24px;" onclick="s3Propose()">
        ✨ Claude 4.6 に脚本構成を提案させる
      </button>
      <button class="btn btn-sm" onclick="s3AddModule()">＋ スライド追加</button>
      <span id="s3Msg" style="font-size:12px;color:#8a9aba;"></span>
    </div>
  </div>

  <!-- タブ行 -->
  <div id="s3Tabs" style="display:flex;gap:3px;flex-wrap:wrap;"></div>

  <!-- モジュールエディタ（3-4, 3-5, 3-6） -->
  <div id="s3Editor" style="background:var(--panel);border:1px solid var(--c);border-radius:0 12px 12px 12px;padding:20px;min-height:240px;margin-bottom:16px;"></div>

  <!-- 画像取得パネル（3-7, 3-8） -->
  <div id="s3ImgPanel" class="panel" style="display:none;margin-bottom:16px;">
    <div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:10px;">🖼️ 取得済み画像</div>
    <div id="s3ImgGrid" style="display:flex;flex-wrap:wrap;gap:8px;"></div>
  </div>

  <!-- 再提案 + 生成ボタン行 -->
  <div style="display:flex;gap:8px;">
    <button class="btn btn-sm" style="flex:1;" onclick="s3Repropose()">🔄 タイトル編集後に再提案</button>
    <button class="btn btn-success" id="s3GenBtn" style="flex:2;font-size:14px;padding:12px;" onclick="s3Generate()">
      🎬 シナリオ生成・画像取得開始
    </button>
  </div>

</div>
</div>

<script>
(function() {
  /* === Step3 スコープ === */

  const TYPE_COLORS = {
    opening:'#ff4d4d', insight:'#1a6ef5', stats:'#10b981', reaction:'#f59e0b',
    profile:'#8b5cf6', comparison:'#ef4444', history:'#6366f1',
    matchcard:'#14b8a6', matchcenter:'#06b6d4', ending:'#64748b',
  };
  const TYPE_LABELS = {
    opening:'オープニング', insight:'キャッチコピー', stats:'スタッツ・数値',
    reaction:'コメント反応', profile:'プロフィール', comparison:'対比',
    history:'時系列ヒストリー', matchcard:'試合プレビュー',
    matchcenter:'試合詳細', ending:'エンディング',
  };
  const ALL_TYPES = ['opening','insight','stats','reaction','profile','comparison','history','matchcard','matchcenter','ending'];

  /* SIデータ（サーバーから取得）*/
  window.APP = window.APP || {};
  window.APP.s3SiData = {};

  window.step3Init = function() {
    var postId = window.APP.selected && window.APP.selected.id;
    if (!postId) { s3RenderTabs(); s3RenderEditor(); return; }
    /* サーバーからSIデータを取得してからレンダリング */
    fetchJson('/api/si-data?postId=' + encodeURIComponent(postId))
      .then(function(d) {
        window.APP.s3SiData = d || {};
      })
      .catch(function() {})
      .then(function() {
        s3RenderTabs();
        s3RenderEditor();
        s3LoadImages();
      });
  };

  /* ── モジュール提案 (3-1/3-2/3-3) ── */
  window.s3Propose = async function() {
    _s3Msg('⏳ Claude 4.6 が構成を練っています...');
    document.getElementById('s3Editor').innerHTML = '<div style="color:var(--c);padding:20px;">⏳ 提案生成中...</div>';
    document.getElementById('s3Tabs').innerHTML = '';
    try {
      const d = await fetchJson('/api/propose-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ post:window.APP.selected, postId:window.APP.selected?.id, siDataIn:window.APP.s3SiData||{} }),
      });
      window.APP.modules   = d.modules || [];
      window.APP.activeTab = 0;
      s3RenderTabs();
      s3RenderEditor();
      _s3Msg('✅ ' + window.APP.modules.length + ' スライド提案完了');
    } catch(e) {
      _s3Msg('❌ 提案失敗: ' + e.message);
      document.getElementById('s3Editor').innerHTML = '<div style="color:#ef4444;padding:20px;">❌ ' + _e(e.message) + '</div>';
    }
  };

  /* ── タブ描画 ── */
  function s3RenderTabs() {
    const mods = window.APP.modules || [];
    document.getElementById('s3Tabs').innerHTML = mods.length
      ? mods.map((m, i) => {
          const col = TYPE_COLORS[m.type] || '#555';
          const act = i === window.APP.activeTab;
          return '<div class="s3-tab' + (act?' s3-tab-active':'') + '"'
            + ' style="' + (act?'background:'+col+';color:#fff;':'') + '"'
            + ' onclick="s3Switch(' + i + ')">'
            + '<span style="font-size:9px;opacity:.8">S' + (i+1) + '</span><br>'
            + '<span style="font-size:10px;">' + _e(m.title.slice(0,10)) + (m.title.length>10?'…':'') + '</span>'
            + '</div>';
        }).join('')
      : '';
  }

  window.s3Switch = function(i) {
    _s3SaveCurrent();
    window.APP.activeTab = i;
    s3RenderTabs();
    s3RenderEditor();
  };

  /* ── エディタ描画 (3-4/3-5/3-6) ── */
  function s3RenderEditor() {
    const mods = window.APP.modules || [];
    if (!mods.length) {
      document.getElementById('s3Editor').innerHTML =
        '<div style="color:#5a6a8a;padding:20px;text-align:center;">「Claude 4.6 に提案させる」ボタンを押してください</div>';
      return;
    }
    const i   = window.APP.activeTab;
    const m   = mods[i];
    if (!m) return;
    const col = TYPE_COLORS[m.type] || '#555';

    /* タイプドロップダウン */
    const typeOpts = ALL_TYPES.map(t =>
      '<option value="' + t + '"' + (m.type===t?' selected':'') + '>' + t + ' — ' + TYPE_LABELS[t] + '</option>'
    ).join('');

    /* SIデータバインドドロップダウン（新Step2構造対応）*/
    var siItems = [];
    var s3si = window.APP.s3SiData || {};
    if (s3si.boxes) {
      Object.entries(s3si.boxes).forEach(function(entry) {
        var boxType = entry[0], box = entry[1];
        (box.fetched || []).forEach(function(f) {
          siItems.push({ key: f.label, label: f.label + ' [' + boxType + ']' });
        });
      });
    }
    var siOpts = '<option value="">(バインドなし)</option>'
      + siItems.map(function(it) {
          return '<option value="' + _e(it.key) + '"' + (m.siBinding===it.key?' selected':'') + '>' + _e(it.label) + '</option>';
        }).join('');

    document.getElementById('s3Editor').innerHTML =
      /* タイトル */
      '<div style="margin-bottom:14px;">'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">&#x1F4DD; スライドタイトル</div>'
      + '<input id="s3TitleInp" type="text" class="inp" style="width:100%;font-size:15px;font-weight:bold;" value="' + _e(m.title) + '">'
      + '</div>'

      /* タイプ + バッジ */
      + '<div style="display:grid;grid-template-columns:1fr auto;gap:10px;margin-bottom:14px;">'
      + '<div>'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">&#x1F39E; スライドタイプ</div>'
      + '<select id="s3TypeSel" class="inp" style="width:100%;">' + typeOpts + '</select>'
      + '</div>'
      + '<div style="display:flex;flex-direction:column;justify-content:flex-end;gap:6px;">'
      + '<div style="background:'+col+';color:#fff;padding:5px 12px;border-radius:6px;font-size:11px;font-weight:bold;text-align:center;">'
      + (m.type||'?').toUpperCase() + '</div>'
      + '<button class="btn btn-sm" style="background:#dc2626;color:#fff;" onclick="s3Delete('+i+')">&#x1F5D1; 削除</button>'
      + '</div>'
      + '</div>'

      /* SIバインド */
      + '<div style="margin-bottom:14px;">'
      + '<div style="font-size:11px;color:var(--c);font-weight:bold;margin-bottom:5px;">&#x1F517; SIデータバインド</div>'
      + (siItems.length
          ? '<select id="s3SiBind" class="inp" style="width:100%;">' + siOpts + '</select>'
          : '<div style="font-size:11px;color:#5a6a8a;">Step2でSIデータを取得してください</div>')
      + '</div>'

      /* 脚本指示 (#3-2-2) */
      + '<div style="margin-bottom:14px;">'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">'
      + '<span style="font-size:11px;color:var(--c);font-weight:bold;">&#x1F3AD; 脚本指示</span>'
      + '<button class="btn btn-sm" id="s3RegenBtn" onclick="s3RegenScript()">&#x21BB; 再提案</button>'
      + '</div>'
      + '<textarea id="s3ScriptDir" class="inp" style="width:100%;height:80px;font-size:12px;resize:vertical;">'
      + _e(m.scriptDir || '') + '</textarea>'
      + '</div>'

      /* データバインド（タイプ別）*/
      + _s3DataBindHtml(m, siItems)

      /* AI制作意図 */
      + '<div style="background:#0d1220;border-radius:8px;padding:12px;margin-bottom:10px;">'
      + '<div style="font-size:10px;color:#8a9aba;margin-bottom:4px;">&#x1F4A1; AI制作意図</div>'
      + '<div style="font-size:12px;color:#c0cce0;line-height:1.6;">' + _e(m.reason||'') + '</div>'
      + '</div>'

      /* 位置表示 */
      + '<div style="font-size:10px;color:#5a6a8a;">スライド ' + (i+1) + ' / ' + mods.length + '</div>';
  }

  /* ── データバインドUI生成（タイプ別） ── */
  function _s3DataBindHtml(m, siItems) {
    const type = m.type;
    if (!['stats','profile','matchcard','comparison','insight','reaction','matchcenter'].includes(type)) {
      return ''; // opening/ending/history は不要
    }

    const header =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '<span style="font-size:11px;color:var(--c);font-weight:bold;">&#x1F3AF; データバインド</span>'
      + '<button class="btn btn-sm" onclick="s3PopulateModule()">&#x21BB; データ再生成</button>'
      + '</div>';

    const wrap = (inner) =>
      '<div style="background:#0d1220;border-radius:8px;padding:12px;margin-bottom:14px;">'
      + header + inner + '</div>';

    if (type === 'matchcenter') {
      return wrap(
        '<div style="font-size:11px;color:#8a9aba;line-height:1.5;">'
        + 'siBinding で指定した sofascore_match ラベルから自動展開されます（スコア・得点・スタッツ・ラインアップ）。<br>'
        + '現在のバインド: <span style="color:#fff;font-weight:bold;">' + _e(m.siBinding || '(未設定)') + '</span>'
        + '</div>'
      );
    }

    if (type === 'stats' || type === 'profile' || type === 'matchcard') {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      while (slots.length < 4) slots.push({ label: '', value: '' });
      m.dataSlots = slots.slice(0, 4);
      const rows = m.dataSlots.map((s, idx) =>
        '<div style="display:grid;grid-template-columns:40px 1fr 1fr;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;">#' + (idx+1) + '</span>'
        + '<input class="inp s3-slot-label" data-idx="' + idx + '" placeholder="LABEL" style="font-size:12px;padding:4px 8px;" value="' + _e(s.label || '') + '">'
        + '<input class="inp s3-slot-value" data-idx="' + idx + '" placeholder="VALUE" style="font-size:12px;padding:4px 8px;" value="' + _e(s.value || '') + '">'
        + '</div>'
      ).join('');
      return wrap(rows);
    }

    if (type === 'comparison') {
      const slots = Array.isArray(m.dataSlots) ? m.dataSlots : [];
      while (slots.length < 4) slots.push({ label: '', leftValue: '', rightValue: '' });
      m.dataSlots = slots.slice(0, 4);

      const siOptsL = ['<option value="">(左: 未選択)</option>']
        .concat(siItems.map(it =>
          '<option value="' + _e(it.key) + '"' + (m.siBindingLeft===it.key?' selected':'') + '>' + _e(it.label) + '</option>'
        )).join('');
      const siOptsR = ['<option value="">(右: 未選択)</option>']
        .concat(siItems.map(it =>
          '<option value="' + _e(it.key) + '"' + (m.siBindingRight===it.key?' selected':'') + '>' + _e(it.label) + '</option>'
        )).join('');

      const topRow =
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">'
        + '<select class="inp" id="s3BindLeft" style="font-size:11px;padding:5px;">' + siOptsL + '</select>'
        + '<select class="inp" id="s3BindRight" style="font-size:11px;padding:5px;">' + siOptsR + '</select>'
        + '</div>';

      const rows = m.dataSlots.map((s, idx) =>
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:6px;">'
        + '<input class="inp s3-cmp-label" data-idx="' + idx + '" placeholder="LABEL" style="font-size:12px;padding:4px 8px;" value="' + _e(s.label || '') + '">'
        + '<input class="inp s3-cmp-left" data-idx="' + idx + '" placeholder="左" style="font-size:12px;padding:4px 8px;color:#93c5fd;" value="' + _e(s.leftValue || '') + '">'
        + '<input class="inp s3-cmp-right" data-idx="' + idx + '" placeholder="右" style="font-size:12px;padding:4px 8px;color:#fca5a5;" value="' + _e(s.rightValue || '') + '">'
        + '</div>'
      ).join('');
      return wrap(topRow + rows);
    }

    if (type === 'insight') {
      const phrases = Array.isArray(m.catchphrases) ? m.catchphrases : [];
      while (phrases.length < 3) phrases.push('');
      m.catchphrases = phrases;
      const rows = m.catchphrases.map((p, idx) =>
        '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<span style="width:22px;font-size:10px;color:#8a9aba;">' + (idx+1) + '.</span>'
        + '<input class="inp s3-phrase" data-idx="' + idx + '" placeholder="キャッチコピー' + (idx+1) + '" style="flex:1;font-size:13px;padding:5px 10px;" value="' + _e(p) + '">'
        + '<button class="btn btn-sm" style="background:#ef4444;color:#fff;" onclick="s3RemovePhrase(' + idx + ')">&#xD7;</button>'
        + '</div>'
      ).join('');
      const addBtn = m.catchphrases.length < 5
        ? '<button class="btn btn-sm" style="background:#10b981;color:#fff;margin-top:4px;" onclick="s3AddPhrase()">+ 行追加</button>'
        : '';
      return wrap(rows + addBtn);
    }

    if (type === 'reaction') {
      const coms = Array.isArray(m.comments) ? m.comments : [];
      while (coms.length < 7) coms.push({ text: '', score: 0 });
      m.comments = coms.slice(0, 7);
      const rows = m.comments.map((c, idx) =>
        '<div style="display:grid;grid-template-columns:22px 1fr 70px;gap:6px;margin-bottom:6px;align-items:center;">'
        + '<span style="font-size:10px;color:#8a9aba;text-align:center;">' + (idx+1) + '.</span>'
        + '<input class="inp s3-cmt-text" data-idx="' + idx + '" placeholder="コメント" style="font-size:12px;padding:4px 8px;" value="' + _e(c.text || '') + '">'
        + '<input type="number" class="inp s3-cmt-score" data-idx="' + idx + '" placeholder="score" style="font-size:11px;padding:4px 8px;" value="' + (c.score || 0) + '">'
        + '</div>'
      ).join('');
      return wrap(rows);
    }

    return '';
  }

  /* 現在タブの入力を APP に反映 */
  function _s3SaveCurrent() {
    const i = window.APP.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const t = document.getElementById('s3TitleInp');
    const s = document.getElementById('s3TypeSel');
    const b = document.getElementById('s3SiBind');
    const d = document.getElementById('s3ScriptDir');
    if (t) m.title     = t.value;
    if (s) m.type      = s.value;
    if (b) m.siBinding = b.value || null;
    if (d) m.scriptDir = d.value;

    // ── データバインド系の入力を DOM から収集 ──
    const type = m.type;
    if (['stats','profile','matchcard'].includes(type)) {
      const labels = document.querySelectorAll('.s3-slot-label');
      const values = document.querySelectorAll('.s3-slot-value');
      const slots = [];
      for (let j = 0; j < 4; j++) {
        slots.push({
          label: labels[j]?.value || '',
          value: values[j]?.value || '',
        });
      }
      m.dataSlots = slots;
    } else if (type === 'comparison') {
      const labels = document.querySelectorAll('.s3-cmp-label');
      const lefts  = document.querySelectorAll('.s3-cmp-left');
      const rights = document.querySelectorAll('.s3-cmp-right');
      const slots = [];
      for (let j = 0; j < 4; j++) {
        slots.push({
          label:      labels[j]?.value || '',
          leftValue:  lefts[j]?.value  || '',
          rightValue: rights[j]?.value || '',
        });
      }
      m.dataSlots = slots;
      const bL = document.getElementById('s3BindLeft');
      const bR = document.getElementById('s3BindRight');
      if (bL) m.siBindingLeft  = bL.value || null;
      if (bR) m.siBindingRight = bR.value || null;
    } else if (type === 'insight') {
      const inputs = document.querySelectorAll('.s3-phrase');
      m.catchphrases = Array.from(inputs).map(el => el.value).filter(v => v !== undefined);
    } else if (type === 'reaction') {
      const texts  = document.querySelectorAll('.s3-cmt-text');
      const scores = document.querySelectorAll('.s3-cmt-score');
      const coms = [];
      for (let j = 0; j < texts.length; j++) {
        coms.push({
          text:  texts[j]?.value || '',
          score: Number(scores[j]?.value) || 0,
        });
      }
      m.comments = coms;
    }
  }

  /* insight: キャッチコピー行追加/削除 */
  window.s3AddPhrase = function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    if (!Array.isArray(m.catchphrases)) m.catchphrases = [];
    if (m.catchphrases.length < 5) m.catchphrases.push('');
    s3RenderEditor();
  };
  window.s3RemovePhrase = function(idx) {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m || !Array.isArray(m.catchphrases)) return;
    if (m.catchphrases.length > 1) m.catchphrases.splice(idx, 1);
    s3RenderEditor();
  };

  /* データバインドのみ再生成（populate-module 呼び出し） */
  window.s3PopulateModule = async function() {
    _s3SaveCurrent();
    const m = window.APP.modules?.[window.APP.activeTab];
    if (!m) return;
    _s3Msg('&#x1F504; ' + m.title + ' のデータを再生成中...');
    try {
      const d = await fetchJson('/api/populate-module', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          post:     window.APP.selected,
          postId:   window.APP.selected?.id,
          siDataIn: window.APP.s3SiData || {},
          module:   m,
        }),
      });
      if (d.ok === false) { _s3Msg('&#x274C; ' + (d.error || '失敗')); return; }
      if (d.note) { _s3Msg(d.note); return; }
      if (d.dataSlots)       m.dataSlots       = d.dataSlots;
      if (d.catchphrases)    m.catchphrases    = d.catchphrases;
      if (d.comments)        m.comments        = d.comments;
      if (d.siBindingLeft)   m.siBindingLeft   = d.siBindingLeft;
      if (d.siBindingRight)  m.siBindingRight  = d.siBindingRight;
      s3RenderEditor();
      _s3Msg('&#x2705; データ更新完了');
    } catch (e) {
      _s3Msg('&#x274C; エラー: ' + e.message);
    }
  };

  /* 脚本指示再提案 (#3-2-2) */
  window.s3RegenScript = async function() {
    _s3SaveCurrent();
    const i = window.APP.activeTab;
    const m = window.APP.modules?.[i];
    if (!m) return;
    const btn = document.getElementById('s3RegenBtn');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    _s3Msg('脚本指示を再提案中...');
    try {
      const d = await fetchJson('/api/regen-module-script', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ post: window.APP.selected, module: m, allModules: window.APP.modules }),
      });
      if (d.scriptDir) {
        m.scriptDir = d.scriptDir;
        const ta = document.getElementById('s3ScriptDir');
        if (ta) ta.value = d.scriptDir;
        _s3Msg('脚本指示を更新しました');
      }
    } catch(e) { _s3Msg('再提案失敗: ' + e.message); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '↻ 再提案'; } }
  };

  /* 追加 */
  window.s3AddModule = function() {
    _s3SaveCurrent();
    window.APP.modules.push({ title: 'スライド ' + (window.APP.modules.length+1), type: 'insight', reason: '手動追加', siBinding: null });
    window.APP.activeTab = window.APP.modules.length - 1;
    s3RenderTabs(); s3RenderEditor();
  };

  /* 削除 */
  window.s3Delete = function(i) {
    if (window.APP.modules.length <= 1) return alert('最低1枚必要です');
    if (!confirm('このスライドを削除しますか？')) return;
    window.APP.modules.splice(i, 1);
    window.APP.activeTab = Math.min(window.APP.activeTab, window.APP.modules.length-1);
    s3RenderTabs(); s3RenderEditor();
  };

  /* 再提案 (3-5) */
  window.s3Repropose = async function() {
    _s3SaveCurrent();
    if (!window.APP.modules.length) return alert('先に提案してください');
    const titles = window.APP.modules.map(m => m.title).join(', ');
    _s3Msg('⏳ 再提案中...');
    try {
      const d = await fetchJson('/api/propose-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          post: { ...window.APP.selected, titleOrig: '既存タイトル: ' + titles },
          postId: window.APP.selected?.id, siDataIn: window.APP.siData||{},
        }),
      });
      if (d.modules?.length) {
        window.APP.modules = d.modules; window.APP.activeTab = 0;
        s3RenderTabs(); s3RenderEditor(); _s3Msg('✅ 再提案完了');
      }
    } catch(e) { _s3Msg('❌ 失敗: ' + e.message); }
  };

  /* 生成・画像取得 (3-7/3-8) */
  window.s3Generate = async function() {
    _s3SaveCurrent();
    if (!window.APP.modules.length) return alert('モジュールを確定してください');
    const postId = window.APP.selected?.id;
    if (!postId) return alert('案件が選択されていません');

    const btn = document.getElementById('s3GenBtn');
    btn.disabled = true;
    btn.textContent = '⏳ 生成中...';
    _s3Msg('モジュールを保存中...');

    try {
      /* モジュール保存 */
      await fetchJson('/api/save-modules', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ postId, modules: window.APP.modules }),
      });

      /* 画像取得キーワードを収集（SIバインドがある場合は優先） */
      const kwSet = new Set();
      window.APP.modules.forEach(m => {
        if (m.siBinding) kwSet.add(m.siBinding);
      });
      /* SI取得済みのplayer/teamラベルを追加（上限6件）*/
      const s3si = window.APP.s3SiData || {};
      if (s3si.boxes) {
        ['sofascore_player','sofascore_team'].forEach(function(boxType) {
          const box = s3si.boxes[boxType];
          if (box) (box.fetched || []).forEach(function(f) { kwSet.add(f.label); });
        });
      }
      const keywords = [...kwSet].slice(0, 6);

      if (keywords.length) {
        _s3Msg('⏳ 画像取得中 (0/' + keywords.length + ')…');
        const imgRes = await fetchJson('/api/fetch-images', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ postId, keywords }),
        });
        window.APP.images = imgRes.images || [];
        s3RenderImages(window.APP.images);
        _s3Msg('✅ 完了！モジュール ' + window.APP.modules.length + '枚 / 画像 ' + imgRes.count + '枚');
      } else {
        _s3Msg('✅ モジュール保存完了（画像キーワードなし）');
      }
    } catch(e) {
      _s3Msg('❌ 失敗: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🎬 シナリオ生成・画像取得開始';
    }
  };

  /* 既存画像読み込み */
  function s3LoadImages() {
    const id = window.APP.selected?.id;
    if (!id) return;
    fetch('/api/images?postId=' + encodeURIComponent(id))
      .then(r => r.json()).then(d => {
        if (d.images?.length) {
          window.APP.images = d.images;
          s3RenderImages(d.images);
        }
      }).catch(() => {});
  }

  /* 画像グリッド描画 (3-8) */
  function s3RenderImages(images) {
    if (!images?.length) return;
    const panel = document.getElementById('s3ImgPanel');
    const grid  = document.getElementById('s3ImgGrid');
    panel.style.display = 'block';
    grid.innerHTML = images.slice(0, 20).map(img => {
      const fname = img.path.replace(/\\\\/g, '/').split('/').pop();
      const srcBadge = img.source === 'x'
        ? '<span style="background:#1da1f2;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">X</span>'
        : '<span style="background:#339af0;color:#fff;padding:1px 4px;border-radius:3px;font-size:9px;">Wiki</span>';
      return '<div style="text-align:center;width:90px;">'
        + '<img src="/images/' + fname + '" style="width:90px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);"'
        + ' onerror="this.style.display=\\'none\\'">'
        + '<div style="font-size:9px;color:#8a9aba;margin-top:2px;">' + srcBadge + ' ' + _e(img.keyword.slice(0,10)) + '</div>'
        + '</div>';
    }).join('');
  }

  function _s3Msg(t) { document.getElementById('s3Msg').textContent = t; }
  function _e(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

})();
</script>`;
}

module.exports = { router, getUI };
