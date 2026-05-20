// routes/persona_routes.js
// ═══════════════════════════════════════════════════════════════
// Entity Card 生成 / 取得 / 削除
//   (ファイル名は persona_routes.js のままだが、機能名は Entity Card に統一。
//    旧称: Subject Profile / ペルソナ — 不正確だったため Entity Card に変更 2026-05-20)
//
// 案件 (postId) × 主体エンティティ (entityName) ごとに、AI が素材を蒸留した
// 「この人物を語る上で外せないエピソード + 数字ハイライト + 現在の文脈」を JSON で構造化。
//
// 目的:
//   - Wiki 全文の冒頭3000字切り取りで象徴的エピソード (W杯離脱等) を取り損なう問題を解消
//   - 重要度判定を AI に明示的に委ねて構造化
//   - ai-fill-slide で各スライド生成時に profile を参照することで、全スライド一貫した素材活用
//
// 安全網:
//   - 完全に opt-in (env SUBJECT_PROFILE_MODE=1 で初めて ai-fill-slide が profile を参照)
//   - profile が無ければ ai-fill-slide は従来通りの wiki 生データ切り取りに fallback
//   - 生成 API も別建てで、叩かなければ何も起きない
//
// ファイル: data/v2_profiles/<safePostId>__<safeEntity>.json
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const { callAI } = require('../scripts/ai_client');

const DATA_DIR    = path.join(__dirname, '..', 'data');
const SI_DIR      = path.join(DATA_DIR, 'si_data');
const PROFILE_DIR = path.join(DATA_DIR, 'v2_profiles');
const SAVED_FILE  = path.join(DATA_DIR, 'saved_projects.json');

if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

function safeId(s) { return String(s || '').replace(/[\/\?%*:|"<>\.]/g, '_'); }
function profilePath(postId, entityName) {
  return path.join(PROFILE_DIR, `${safeId(postId)}__${safeId(entityName)}.json`);
}
function safeJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch { return fallback; }
}

// ─── 素材収集 ─────────────────────────────────────────────────
function gatherMaterials(postId, entityName) {
  const siFile = path.join(SI_DIR, safeId(postId) + '.json');
  const si     = safeJson(siFile, null);
  const proj   = (safeJson(SAVED_FILE, []) || []).find(p => p.id === postId);

  let entity = null;
  if (si?.boxes?.entity?.items) {
    const target = String(entityName).toLowerCase().trim();
    entity = si.boxes.entity.items.find(it => (it.label || '').toLowerCase().trim() === target)
          || si.boxes.entity.items.find(it => (it.label || '').toLowerCase().includes(target))
          || null;
  }

  return {
    title:       proj?.title || proj?.titleOrig || '',
    titleOrig:   proj?.titleOrig || '',
    bodyExcerpt: String(proj?.raw?.bodyJa || proj?.raw?.body || proj?.selftext || '').slice(0, 1500),
    topComments: (proj?.raw?.comments || [])
      .map(c => (c.bodyJa || c.body || '').trim())
      .filter(s => s.length > 4)
      .slice(0, 8),
    entity,
  };
}

// ─── AI 蒸留 ──────────────────────────────────────────────────
async function generateProfile(materials, opts) {
  const { entityName, topic } = opts;
  const m = materials;
  const e = m.entity || {};

  const wikiExtract = e.wiki?.extract || e.wikiExtract || '';
  const wikitext    = e.wikitext || e.wiki?.wikitext || '';
  const sofa        = e.sofa || null;
  const tmGames     = e.tmGames || null;
  const tmManager   = e.tmManager || e.tm || null;

  const dataBlock = `=== Wikipedia 要約 (extract) ===
${wikiExtract || '(なし)'}

=== Wikipedia 本文 (wikitext 抜粋、最大 12,000 字) ===
${(wikitext || '').slice(0, 12000) || '(なし)'}

${sofa ? '=== SofaScore データ ===\n' + JSON.stringify(sofa).slice(0, 4500) + '\n' : ''}
${tmManager ? '=== Transfermarkt 監督データ ===\n' + JSON.stringify(tmManager).slice(0, 3500) + '\n' : ''}
${tmGames ? '=== Transfermarkt 試合データ ===\n' + JSON.stringify(tmGames).slice(0, 4500) + '\n' : ''}`;

  const prompt = `あなたはサッカー専門のリサーチアナリスト。
動画案件で扱う人物「${entityName}」の Entity Card を、以下の素材から JSON で構造化してください。

════ 案件文脈 ════
動画テーマ: ${topic || m.title || '(指定なし)'}
タイトル: ${m.title}
原題: ${m.titleOrig}
本文抜粋:
${m.bodyExcerpt || '(なし)'}
上位コメント (視聴者の声):
${m.topComments.map(c => '- ' + c.slice(0, 200)).join('\n') || '(なし)'}

════ 素材データ ════
${dataBlock}

════ 出力ルール ════
JSON のみ (マークダウン禁止)。構造:
{
  "entityName": "${entityName}",
  "topic": "今回の動画テーマを一行サマリ",
  "iconicEpisodes": [
    {
      "title": "短いタイトル (20字以内)",
      "summary": "詳細 (60-150字)。具体的な数字・年・対戦相手・スコアを含める",
      "year": 数値 or null,
      "tags": ["W杯", "怪我", "移籍", "タイトル獲得"],
      "source": "wiki | news | sofa | tm | general",
      "relevance": "high | medium | low"
    }
  ],
  "numericHighlights": [
    {"label": "通算ゴール (クラブ)", "value": "136G/225試合", "source": "wiki"}
  ],
  "currentContext": {
    "summary": "案件発生時点の現状を 2-3 文で。今のクラブ・状態・周辺ニュース",
    "keyFacts": [{"fact": "...", "source": "wiki|news"}]
  }
}

エピソード抽出ルール (重要):
- **「この人物を語る上で外せないエピソード」を 6〜10 件**
- 案件テーマと直接関係するエピソードを relevance="high" に
- relevance="high" は 3〜5 件、残りは medium / low
- 時系列順ではなく **relevance 順** で並べる
- 具体例 (ネイマールの場合): 「2014 W杯 ズニガ負傷退場」「サントス時代の226G/225試合」「2017 PSG 移籍金記録 €222M」「2024 サントス復帰」「ブラジル代表 通算79G」など
- Wiki/News/sofa/tm に明記がある場合は source を該当値に
- AI 学習知識から補完する場合は source="general" を明示 (ハルシネーション伝播防止)
- 不確かな情報は含めない (確証が無いものは省く)

数字ハイライト:
- 案件テーマで使えそうな数字 6〜10 件
- 重複は避ける (通算ゴール / 今シーズン / 代表通算 など切り口別)

currentContext:
- 案件発生時点 (本文/コメント参照) の状況
- 「今、何が起きているか」が分かる 2-3 文`;

  // 2026-05-20: デフォルト DeepSeek V4-Flash (Sonnet の 1/15 コスト = ¥1/件)
  //   Entity Card は事実整理タスクで創造力不要 → V4-Flash で十分
  //   env ENTITY_CARD_PROVIDER=sonnet で高品質モード (¥14/件) に切替可
  const cardProvider = (process.env.ENTITY_CARD_PROVIDER || 'deepseek').toLowerCase();
  const cardModel    = cardProvider === 'anthropic' || cardProvider === 'sonnet'
    ? 'claude-sonnet-4-6'
    : 'deepseek-v4-flash';
  const forceProv    = (cardProvider === 'anthropic' || cardProvider === 'sonnet') ? 'anthropic' : 'deepseek';

  const raw = await callAI({
    forceProvider: forceProv,
    model:         cardModel,
    max_tokens:    4000,
    messages:      [{ role: 'user', content: prompt }],
  });

  const match = raw && raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Profile JSON 抽出失敗 (AI 応答に JSON 構造なし)');
  const parsed = JSON.parse(match[0]);
  parsed._modelUsed = cardModel;
  return parsed;
}

// ─── API ──────────────────────────────────────────────────────

// POST /api/v3/build-subject-profile
//   body: { postId, entityName, topic? }
router.post('/v3/build-subject-profile', async (req, res) => {
  const t0 = Date.now();
  try {
    const { postId, entityName, topic } = req.body || {};
    if (!postId || !entityName) {
      return res.status(400).json({ error: 'postId + entityName required' });
    }
    const materials = gatherMaterials(postId, entityName);
    if (!materials.entity) {
      return res.status(404).json({
        error: `エンティティ "${entityName}" が si_data.boxes.entity.items に見つかりません。Step2 で取得済みか確認してください。`,
      });
    }
    console.log(`[entity-card/build] postId=${postId} entity=${entityName} 開始`);
    const profile = await generateProfile(materials, { entityName, topic });
    profile.postId       = postId;
    profile.generatedAt  = new Date().toISOString();
    profile.model        = profile._modelUsed || 'unknown';
    delete profile._modelUsed;
    profile.entityName   = entityName;  // AI が変更してきても上書き

    fs.writeFileSync(profilePath(postId, entityName), JSON.stringify(profile, null, 2));
    const ms = Date.now() - t0;
    console.log(`[entity-card/build] 完了 (${ms}ms / model=${profile.model} / episodes=${profile.iconicEpisodes?.length || 0})`);
    res.json({ ok: true, profile, elapsedMs: ms });
  } catch (e) {
    console.error('[entity-card/build] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/v3/get-subject-profile?postId=&entityName=
router.get('/v3/get-subject-profile', (req, res) => {
  const { postId, entityName } = req.query;
  if (!postId || !entityName) return res.json({ profile: null });
  const p = safeJson(profilePath(postId, entityName), null);
  res.json({ profile: p });
});

// DELETE /api/v3/delete-subject-profile?postId=&entityName=
router.delete('/v3/delete-subject-profile', (req, res) => {
  const { postId, entityName } = req.query;
  if (!postId || !entityName) return res.status(400).json({ error: 'postId + entityName required' });
  const file = profilePath(postId, entityName);
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    res.json({ ok: true, removed: true });
  } else {
    res.json({ ok: true, removed: false });
  }
});

// GET /api/v3/list-subject-profiles?postId=
router.get('/v3/list-subject-profiles', (req, res) => {
  const postId = req.query.postId;
  if (!postId) return res.json({ profiles: [] });
  const prefix = safeId(postId) + '__';
  try {
    const files = fs.readdirSync(PROFILE_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    const profiles = files.map(f => {
      const p = safeJson(path.join(PROFILE_DIR, f), null);
      return p ? {
        entityName:    p.entityName,
        topic:         p.topic,
        generatedAt:   p.generatedAt,
        episodeCount:  (p.iconicEpisodes || []).length,
        file:          f,
      } : null;
    }).filter(Boolean);
    res.json({ profiles });
  } catch {
    res.json({ profiles: [] });
  }
});

// ─── ai-fill-slide 側からも呼べるユーティリティ ─────────────────
// env SUBJECT_PROFILE_MODE=1 のときに step4_routes.js が呼ぶ
function getProfileSync(postId, entityName) {
  if (!postId || !entityName) return null;
  return safeJson(profilePath(postId, entityName), null);
}

// profile を ai-fill-slide のプロンプト用テキストブロックに整形
function formatProfileForPrompt(p) {
  if (!p) return '';
  const high  = (p.iconicEpisodes || []).filter(e => e.relevance === 'high').slice(0, 5);
  const med   = (p.iconicEpisodes || []).filter(e => e.relevance === 'medium').slice(0, 4);
  const nums  = (p.numericHighlights || []).slice(0, 10);
  const facts = (p.currentContext?.keyFacts || []).slice(0, 5);

  const _ep = e => `  - ${e.title}${e.year ? ' (' + e.year + ')' : ''} [${e.source || '?'}]: ${e.summary}`;
  const _nm = n => `  - ${n.label}: ${n.value}` + (n.source ? ` [${n.source}]` : '');
  const _fc = f => `  - ${f.fact}` + (f.source ? ` [${f.source}]` : '');

  return `[Entity Card (AI 蒸留・出典タグ付き)]
テーマ: ${p.topic || ''}

★最重要エピソード (この人物の核となる出来事):
${high.map(_ep).join('\n') || '  (なし)'}

参考エピソード:
${med.map(_ep).join('\n') || '  (なし)'}

数字ハイライト:
${nums.map(_nm).join('\n') || '  (なし)'}

現在の文脈:
${p.currentContext?.summary || ''}
${facts.length ? '主な事実:\n' + facts.map(_fc).join('\n') : ''}

※ profile 生成時刻: ${p.generatedAt || '?'} / model: ${p.model || '?'}`;
}

module.exports = { router, getProfileSync, formatProfileForPrompt };
