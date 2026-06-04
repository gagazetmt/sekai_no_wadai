// routes/viewpoint_routes.js
// 視点パレット: 案件データを読んで「視点カード」12〜18枚を生成する
// 各カードが1スライドに対応し、ユーザーが選んだカードで脚本生成まで直結する
'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router   = express.Router();
const DATA_DIR = path.join(__dirname, '..', 'data');
const SI_DIR   = path.join(DATA_DIR, 'si_data');
const JOB_DIR  = path.join(DATA_DIR, 'v3_jobs');
const PLAN_DIR = path.join(DATA_DIR, 'v25_plans');

const { callAI }        = require('../scripts/ai_client');
const { getBindingMeta } = require('../scripts/v2_story/binding_meta');

// ─── Helpers ───────────────────────────────────────────────────────
function siPath(postId) {
  return path.join(SI_DIR, (postId||'unknown').replace(/[/\?%*:|"<>.]/g,'_') + '.json');
}
function jobPath(jobId) { return path.join(JOB_DIR, jobId + '.json'); }
function readJob(jobId)  { try { return JSON.parse(fs.readFileSync(jobPath(jobId), 'utf8')); } catch (_) { return null; } }
function writeJob(jobId, data) { try { fs.writeFileSync(jobPath(jobId), JSON.stringify(data, null, 2)); } catch (_) {} }
function safeJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fb; } }

// レシピカタログ（AI に提示して recipeKey を選ばせる）
const RECIPE_CATALOG = `
player.profile_basic     → type:profile  | 年齢/国籍/所属/ポジション/市場価値/契約
player.fw_match_stats    → type:stats    | ゴール/アシスト/シュート/xG/ドリブル/評定（FW向け）
player.mf_match_stats    → type:stats    | パス成功率/キーパス/タックル/デュエル/評定（MF向け）
player.df_match_stats    → type:stats    | タックル/インターセプト/クリア/評定（DF向け）
player.gk_match_stats    → type:stats    | セーブ/完封/ゴール阻止/評定（GK向け）
player.season_trend5     → type:history  | 過去5シーズン推移（試合数・G・A）
comparison.player_season → type:comparison | 選手間比較（G/A/評定/xG/キーパス）
team.season_overall      → type:stats    | チーム今季成績（順位/勝点/勝敗/得失点）
`.trim();

// ─── 視点カード生成（メイン処理）─────────────────────────────────
async function _runGenerateViewpoints(postId) {
  const si  = safeJson(siPath(postId), { boxes: { entity: { items: [] }, match: { items: [] } } });
  const sp  = safeJson(path.join(DATA_DIR, 'saved_projects.json'), []);
  const proj = (Array.isArray(sp) ? sp : []).find(p => p.id === postId) || {};

  const titleJa    = proj.title || '(タイトル不明)';
  const bodyExcerpt = String(proj.raw?.bodyJa || proj.raw?.body || '').slice(0, 500);
  const topComments = (proj.raw?.comments || []).slice(0, 6)
    .map(c => '- ' + String(c.bodyJa || c.body || '').slice(0, 160))
    .filter(s => s.length > 4).join('\n');
  const hasComments = Boolean(topComments.length);

  // ── エンティティブロック（実スロット値付き）──
  const entityItems = si.boxes?.entity?.items || [];
  const entityBlocks = entityItems.map(it => {
    const label = it.label || '?';
    const role  = it.role || '?';
    const sofaOk = Boolean(it.sofa?.ok);
    const wikiOk = Boolean(it.wiki?.ok);

    // binding_meta 経由で実スロット値を取得
    const meta  = getBindingMeta({ type: 'stats', mainKey: `entity:${label}` }, si);
    const slots = (meta?.availableSlots || []).slice(0, 18)
      .map(s => `${s.label}:${s.value}`).join(' / ') || '(スロットなし)';
    const recipes = (meta?.recipes || []).map(r => r.key).join(', ') || '(なし)';
    const wikiText = wikiOk ? String(it.wiki?.extract || '').slice(0, 250) : '';

    return [
      `### ${label} [${role}]  sofa:${sofaOk?'ok':'×'}  wiki:${wikiOk?'ok':'×'}`,
      `スロット値: ${slots}`,
      wikiText ? `Wikipedia: ${wikiText}` : '',
      `利用可能レシピ: ${recipes}`,
    ].filter(Boolean).join('\n');
  }).join('\n\n') || '(エンティティなし)';

  // ── 記事ブロック ──
  const curated = (si.curatedArticles?.articles || []).slice(0, 5)
    .map((a, i) => `${i+1}. [${a.host||'?'}] ${a.title||''}\n   ${String(a.content||a.snippet||'').slice(0,200)}`)
    .join('\n');
  const planData = safeJson(
    path.join(PLAN_DIR, (postId||'').replace(/[/\?%*:|"<>.]/g,'_') + '.json'), {}
  );
  const planArticles = (planData.articles || []).slice(0, 3)
    .map((a, i) => `${i+1}. [${a.host||'?'}] ${a.title||''}\n   ${String(a.text||a.snippet||'').slice(0,200)}`)
    .join('\n');
  const articleBlock = [curated, planArticles].filter(Boolean).join('\n') || '(記事なし)';

  // ── プロンプト ──
  const prompt = `あなたはサッカーYouTube動画の構成エキスパートです。
以下の案件データから「視点カード」を12〜18枚生成してください。

各カードは独立した1スライドを表します。ユーザーが好きなカードを選んで動画を組み立てます。
だから多様な視点を網羅し、短尺（4〜5枚）でも長尺（8〜10枚）でも使えるように設計する。

【案件タイトル】
${titleJa}

【案件本文（抜粋）】
${bodyExcerpt || '(なし)'}

${hasComments ? `【Reddit上位コメント（reaction カード用）】\n${topComments}\n` : ''}

【取得済みエンティティデータ（これが confidence:high の根拠）】
${entityBlocks}

【関連記事（confidence:medium の根拠）】
${articleBlock}

【利用可能レシピ一覧】
${RECIPE_CATALOG}

【生成ルール（厳守）】
1. opening を必ず1枚目に（固定・選択解除不可）
2. ending を必ず最後に（固定・選択解除不可）
3. ${hasComments ? 'Reddit コメントがあるので reaction カードを1枚生成する' : 'Reddit コメントがないので reaction カードは生成しない'}
4. confidence:
   - high  → sofa:ok または wiki:ok で確認済みのデータ
   - medium → 記事のみ確認（SofaScore未確認）
   - low   → 記事にも言及なし・推測
5. stats/profile/timeline/history の recipeKey → sofa:ok エンティティのみ指定。それ以外は null
6. 1エンティティに対して複数カードを出してよい（プロフィール・スタッツ・シーズン推移など）
7. 同じ論点を insight × 2 で出すな。1つのinsightカードに論点を4〜5個まとめる
8. scriptDir は30〜60字で具体的な数字を含めて書く
9. id は英小文字・アンダースコアのみ

【出力（JSONのみ。コードブロック・説明文一切不要）】
{"cards":[
  {"id":"opening","title":"動画冒頭フック","slideType":"opening","mainKey":"opening","secondary":null,"recipeKey":null,"dataSource":"","dataPreview":"","scriptDir":"タイトルで視聴者を掴む","confidence":"high"},
  {"id":"sample_stats","title":"今季スタッツ","slideType":"stats","mainKey":"entity:選手名","secondary":null,"recipeKey":"player.fw_match_stats","dataSource":"sofa:選手名","dataPreview":"G32 A7 評8.1 出場31試合","scriptDir":"今季G32・A7・評8.1の数字で存在感を可視化（FWスタッツ）","confidence":"high"},
  ...
  {"id":"ending","title":"締め・問いかけ","slideType":"ending","mainKey":"ending","secondary":null,"recipeKey":null,"dataSource":"","dataPreview":"","scriptDir":"視聴者への投げかけと登録誘導","confidence":"high"}
]}`;

  const raw = await callAI({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 6000,
  });

  // ── パース ──
  let parsed = null;
  try {
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (_) {}

  if (!parsed?.cards?.length) {
    throw new Error('視点カード生成失敗: ' + String(raw || '').slice(0, 400));
  }

  const VALID_TYPES = new Set(['opening','ending','stats','profile','comparison','history',
                                'insight','reaction','timeline','matchcard','ranking','picture']);

  let cards = parsed.cards
    .filter(c => c && c.id && VALID_TYPES.has(c.slideType))
    .map(c => ({
      id:          String(c.id).replace(/[^a-z0-9_]/g, '_').slice(0, 60),
      title:       String(c.title || '').slice(0, 40),
      slideType:   c.slideType,
      mainKey:     String(c.mainKey || '').slice(0, 100),
      secondary:   c.secondary ? String(c.secondary).slice(0, 80) : null,
      recipeKey:   c.recipeKey || null,
      dataSource:  String(c.dataSource || '').slice(0, 80),
      dataPreview: String(c.dataPreview || '').slice(0, 120),
      scriptDir:   String(c.scriptDir || '').slice(0, 120),
      confidence:  ['high','medium','low'].includes(c.confidence) ? c.confidence : 'medium',
    }));

  // opening / ending を保証
  const openings = cards.filter(c => c.slideType === 'opening');
  const endings  = cards.filter(c => c.slideType === 'ending');
  const middles  = cards.filter(c => c.slideType !== 'opening' && c.slideType !== 'ending');

  if (!openings.length) openings.push({
    id:'opening', title:'動画冒頭フック', slideType:'opening', mainKey:'opening',
    secondary:null, recipeKey:null, dataSource:'', dataPreview:'', scriptDir:'タイトルでフック', confidence:'high',
  });
  if (!endings.length) endings.push({
    id:'ending', title:'締め・問いかけ', slideType:'ending', mainKey:'ending',
    secondary:null, recipeKey:null, dataSource:'', dataPreview:'', scriptDir:'視聴者への投げかけと登録誘導', confidence:'high',
  });

  return [...openings, ...middles, ...endings];
}

// ─── Routes ────────────────────────────────────────────────────────

router.post('/v3/generate-viewpoints', express.json(), (req, res) => {
  const { postId } = req.body || {};
  if (!postId) return res.status(400).json({ error: 'postId required' });
  if (!fs.existsSync(JOB_DIR)) fs.mkdirSync(JOB_DIR, { recursive: true });
  const jobId = 'vp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  writeJob(jobId, { jobId, postId, status: 'queued', step: 'init', createdAt: new Date().toISOString() });
  res.json({ ok: true, jobId });
  setImmediate(async () => {
    try {
      writeJob(jobId, { jobId, postId, status: 'running', step: 'generating' });
      const cards = await _runGenerateViewpoints(postId);
      writeJob(jobId, { jobId, postId, status: 'done', step: 'done', cards, count: cards.length,
        finishedAt: new Date().toISOString() });
      console.log(`[viewpoints] ${cards.length} cards generated for ${postId}`);
    } catch (e) {
      console.error('[viewpoints]', e.message);
      writeJob(jobId, { jobId, postId, status: 'error', error: e.message });
    }
  });
});

router.get('/v3/viewpoints-status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});

module.exports = { router };
