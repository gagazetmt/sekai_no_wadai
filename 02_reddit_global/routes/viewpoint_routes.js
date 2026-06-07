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

function _clampScore(v, fallback = 50) {
  const n = Number(v);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? n : fallback));
}

function _fallbackHookScore(card) {
  const text = [card.title, card.scriptDir, card.dataPreview, ...(card.bullets || [])].join(' ');
  let score = 45;
  if (card.slideType === 'opening') score += 35;
  if (card.slideType === 'insight') score += 12;
  if (card.slideType === 'comparison') score += 10;
  if (card.slideType === 'profile' || card.slideType === 'history' || card.slideType === 'picture') score += 7;
  if (/[0-9０-９]{2,}|年|億|万|€|£|CL|契約|移籍|退団|噂|水面下|ライバル|会長|レアル|マドリー|バルサ|ハーランド|エムバペ/.test(text)) score += 12;
  if ((card.bullets || []).length >= 4) score += 8;
  if (card.confidence === 'high') score += 6;
  if (card.confidence === 'low') score -= 10;
  return _clampScore(score);
}

function _normalizeSubtype(v) {
  const s = String(v || '').trim();
  const allowed = new Set(['shock','strategy','timeline','rumor','fan','money','profile','none']);
  return allowed.has(s) ? s : 'none';
}

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
  const storyFactBlock = (si.storyFacts || []).slice(0, 12)
    .map((f, i) => {
      const uses = Array.isArray(f.usableAs) ? f.usableAs.join('/') : '';
      return `${i+1}. (${f.catchiness || 50}) [${f.angle || 'other'}:${uses}] ${f.fact || ''}${f.detail ? ' - ' + f.detail : ''}${f.sourceHint ? ` / ${f.sourceHint}` : ''}`;
    })
    .join('\n') || '(storyFactsなし)';

  // ── プロンプト ──
  const prompt = `あなたはサッカーYouTube動画の構成エキスパートです。
以下の案件データから、ユーザーが企画書に組み込む「企画ピース」を12〜18枚生成してください。

各ピースは独立した1スライドを表します。ユーザーが好きなピースを選んで動画を組み立てます。
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

【記事熟読で抽出した storyFacts（hookScore と insight の最重要材料）】
${storyFactBlock}

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
7. insight を出す前に、profile / stats / history / picture で視覚化できないか必ず検討する
8. 人物が中心なら profile を優先する。選手だけでなく会長・代理人・監督も profile 可。実績・役職・影響力・契約条件を dataPreview/scriptDir に入れる
8b. **timeline と history の使い分け（厳守）**:
    - timeline → **数値の推移・折れ線グラフ系**（市場価値推移・順位変動・得点ペース・契約残年数など「数字が変化する」内容のみ）
    - history  → **出来事の時系列・年表**（事件経緯・移籍歴・キャリア年表・交渉の流れなど「何が起きたか」を上→下に並べる内容）
    - 今回のような「ESTA承認→取り消し→大使館→許可」の出来事の流れ → **history が正解**（数値推移ではないので timeline は不適切）
9. 契約条項・市場価値・年齢・所属・契約年数など、人物に紐づく固定情報は profile/stats を優先する
10. 会長選挙→補強戦略→選手獲得のような時系列は history/timeline を優先する
11. ペレス、ハーランド、マドリー、会見、スタジアムなど「1枚絵で持つ」場面は picture も候補に入れる
12. insight は「その他」ではない。最後に残った、明確な結論・皮肉・伏線・違和感・クラブ構造の見立てだけに使う
13. insight は必ず bullets を4〜6個入れる。各 bullet はテロップに使える短い日本語フレーズにする
14. insight は1記事だけで完結させない。複数記事・Wiki・スタッツ・過去事例・噂を横断して「なぜ今ヤバいのか」を作る
15. insight の組み立て例:
    - 契約/移籍の伏線: 延長間近報道 → 条件不一致 → 他主力流出 → 次の接触噂 → 今夏補強への影響
    - ブランド戦略の事実列挙: 2021アラバ → 2022リュディガー → 2024エムバペ → 2025トレント → 次の標的
    - 数字の違和感: 出場数/評価/年齢/契約年数のズレから、クラブが動く理由を作る
16. 未確定情報は「報道」「噂」「可能性」と明示する。断定しない
17. 同じ論点を insight × 2 で出すな。1つのinsightカードに論点を4〜6個まとめる
18. 12〜18枚のうち insight は最大4枚まで。profile/history/picture/comparison/stats に分散する
19. scriptDir は30〜60字で具体的な数字・時期・固有名のどれかを含めて書く
20. id は英小文字・アンダースコアのみ
21. 各カードに hookScore を0〜100で必ず付ける。衝撃・意外性・対立・有名度・数字の強さ・1文の強さで採点する
22. hookScore 80以上は冒頭候補、70以上は量産モードで優先。普通の説明カードは50〜65に抑える
23. insight には insightSubtype を付ける: shock / strategy / timeline / rumor / fan / money / profile。insight以外は "none"
24. storyFacts の catchiness が高い事実は opening / insight / history / profile のどれかに必ず反映する
25. 画面変化のため、insight が続く論点は profile/history/picture に降格できないか再判定する

【出力（JSONのみ。コードブロック・説明文一切不要）】
{
  "briefing": {
    "hookQuestion": "視聴者が最初に抱く疑問・驚き（30〜60字）。動画全体のフック",
    "angle": "この動画独自の切り口・視点（20〜40字）。他チャンネルと差別化する観点",
    "answer": "動画を見終えた視聴者に残る結論・メッセージ（30〜60字）",
    "storyPattern": "物語の流れ型（例: 個人の試練→背景の構造→問いかけ / 栄光→転落→復活 / 比較→驚き→考察）"
  },
  "cards":[
  {"id":"opening","title":"動画冒頭フック","slideType":"opening","mainKey":"opening","secondary":null,"recipeKey":null,"dataSource":"","dataPreview":"","scriptDir":"タイトルで視聴者を掴む","confidence":"high","hookScore":90,"insightSubtype":"none","bullets":[]},
  {"id":"sample_stats","title":"今季スタッツ","slideType":"stats","mainKey":"entity:選手名","secondary":null,"recipeKey":"player.fw_match_stats","dataSource":"sofa:選手名","dataPreview":"G32 A7 評8.1 出場31試合","scriptDir":"今季G32・A7・評8.1の数字で存在感を可視化（FWスタッツ）","confidence":"high","hookScore":72,"insightSubtype":"none","bullets":[]},
  {"id":"sample_insight","title":"契約満了スター戦略","slideType":"insight","mainKey":"insight:contract_strategy","secondary":null,"recipeKey":null,"dataSource":"articles+wiki","dataPreview":"複数ソースの文脈統合","scriptDir":"過去の契約満了獲得と今回の噂をブランド戦略として語る","confidence":"medium","hookScore":86,"insightSubtype":"strategy","bullets":["2021年夏にアラバを獲得","2022年夏にリュディガーも加入","2024年夏にはエムバペ獲得","2025年にはトレントも確保","次の標的として主役の名前","ブランド力だけに許された戦略"]},
  ...
  {"id":"ending","title":"締め・問いかけ","slideType":"ending","mainKey":"ending","secondary":null,"recipeKey":null,"dataSource":"","dataPreview":"","scriptDir":"視聴者への投げかけと登録誘導","confidence":"high","bullets":[]}
]}`;

  const raw = await callAI({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 8000,
  });

  // ── パース（途中切れリカバリ付き）──
  let parsed = null;
  try {
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (_) {
    // JSON途中切れ → 完結しているカードだけ抽出してリカバリ
    try {
      const cardMatches = [...(raw || '').matchAll(/\{[^{}]*"slideType"[^{}]*\}/g)];
      if (cardMatches.length) {
        parsed = { cards: cardMatches.map(m => { try { return JSON.parse(m[0]); } catch(_) { return null; } }).filter(Boolean) };
      }
    } catch (_2) {}
  }

  if (!parsed?.cards?.length) {
    throw new Error('視点カード生成失敗: ' + String(raw || '').slice(0, 400));
  }

  // briefing を正規化して抽出（cards と一緒に返す）
  const rawBriefing = parsed.briefing || {};
  const briefing = {
    hookQuestion: String(rawBriefing.hookQuestion || '').slice(0, 120),
    angle:        String(rawBriefing.angle        || '').slice(0, 80),
    answer:       String(rawBriefing.answer       || '').slice(0, 120),
    storyPattern: String(rawBriefing.storyPattern || '').slice(0, 80),
  };

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
      hookScore:   _clampScore(c.hookScore, 0),
      insightSubtype: c.slideType === 'insight' ? _normalizeSubtype(c.insightSubtype) : 'none',
      bullets:     Array.isArray(c.bullets) ? c.bullets.filter(Boolean).slice(0, 6).map(b => String(b).slice(0, 60)) : [],
    }))
    .map(c => ({ ...c, hookScore: c.hookScore > 0 ? c.hookScore : _fallbackHookScore(c) }));

  // opening / ending を保証
  const openings = cards.filter(c => c.slideType === 'opening');
  const endings  = cards.filter(c => c.slideType === 'ending');
  let middles  = cards.filter(c => c.slideType !== 'opening' && c.slideType !== 'ending');

  const insightSeen = new Set();
  middles = middles
    .sort((a, b) => (b.hookScore || 0) - (a.hookScore || 0))
    .filter(c => {
      if (c.slideType !== 'insight') return true;
      const key = (c.insightSubtype || 'none') + ':' + (c.mainKey || c.title || '');
      if (insightSeen.has(key)) return false;
      insightSeen.add(key);
      return true;
    });
  const visualTypes = new Set(['profile','history','timeline','picture','stats','comparison']);
  const insights = middles.filter(c => c.slideType === 'insight').slice(0, 4);
  const visuals  = middles.filter(c => c.slideType !== 'insight' && visualTypes.has(c.slideType));
  const others   = middles.filter(c => c.slideType !== 'insight' && !visualTypes.has(c.slideType));
  middles = [];
  const maxLen = Math.max(insights.length, visuals.length, others.length);
  for (let i = 0; i < maxLen; i++) {
    if (visuals[i]) middles.push(visuals[i]);
    if (insights[i]) middles.push(insights[i]);
    if (others[i]) middles.push(others[i]);
  }

  if (!openings.length) openings.push({
    id:'opening', title:'動画冒頭フック', slideType:'opening', mainKey:'opening',
    secondary:null, recipeKey:null, dataSource:'', dataPreview:'', scriptDir:'タイトルでフック', confidence:'high', hookScore:90, insightSubtype:'none', bullets:[],
  });
  if (!endings.length) endings.push({
    id:'ending', title:'締め・問いかけ', slideType:'ending', mainKey:'ending',
    secondary:null, recipeKey:null, dataSource:'', dataPreview:'', scriptDir:'視聴者への投げかけと登録誘導', confidence:'high', hookScore:55, insightSubtype:'none', bullets:[],
  });

  const finalCards = [{ ...openings[0], hookScore: Math.max(openings[0].hookScore || 0, 85) }, ...middles.slice(0, 16), endings[0]];
  return { cards: finalCards, briefing };
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
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        writeJob(jobId, { jobId, postId, status: 'running', step: 'generating',
          message: attempt > 1 ? `生成中（リトライ ${attempt}/2）` : '生成中' });
        const { cards, briefing } = await _runGenerateViewpoints(postId);
        writeJob(jobId, { jobId, postId, status: 'done', step: 'done', cards, briefing, count: cards.length,
          finishedAt: new Date().toISOString() });
        console.log(`[viewpoints] attempt${attempt} 成功: ${cards.length} cards | hook: ${briefing.hookQuestion.slice(0,40)}`);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`[viewpoints] attempt${attempt} 失敗: ${e.message}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
    }
    console.error('[viewpoints] 2回試行後も失敗:', lastError.message);
    writeJob(jobId, { jobId, postId, status: 'error', error: lastError.message });
  });
});

router.get('/v3/viewpoints-status', (req, res) => {
  const j = readJob(req.query.jobId);
  if (!j) return res.status(404).json({ error: 'job not found' });
  res.json(j);
});

module.exports = { router, _runGenerateViewpoints };
