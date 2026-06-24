// scripts/modules/v4_script.js
// ⑥ 企画ピース → 脚本生成（modules.json）
// viewpoints カード群を 4-6 セグメント × 二段構成にまとめ、ナレーション付き modules.json を出力
'use strict';

const path = require('path');
const fs   = require('fs');
const { callAI } = require('../ai_client');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function _safePostId(topic) {
  return 'v4_' + String(topic || 'unknown').replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, '_').slice(0, 50) + '_' + Date.now();
}

function _buildEntityBlock(book) {
  const rows = book.fetchedData || [];
  if (!rows.length) return '(エンティティデータなし)';
  const byEntity = {};
  for (const r of rows) {
    const e = r.entity || '不明';
    if (!byEntity[e]) byEntity[e] = [];
    byEntity[e].push(r);
  }
  return Object.entries(byEntity).map(([entity, items]) => {
    const slots = items.slice(0, 18).map(r => `${r.label}:${r.value}`).join(' / ');
    const sources = [...new Set(items.map(r => r.source))].join(',');
    return `### ${entity} [${sources}]\nスロット値: ${slots}`;
  }).join('\n\n');
}

function _buildCommentBlock(book) {
  const lines = [];
  for (const sfx of ['1', '2']) {
    const cs = book[`comments${sfx}`];
    if (Array.isArray(cs) && cs.length) {
      lines.push(`【${book[`commentAngle${sfx}`] || `コメント${sfx}`}】`);
      cs.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    }
  }
  return lines.join('\n');
}

function _buildArticleBlock(book) {
  const articles = book.articles || [];
  if (!articles.length) return '(記事なし)';
  return articles.slice(0, 5).map((a, i) =>
    `${i + 1}. [${a.host || '?'}] ${a.title || ''}\n   ${(a.summary || a.body || '').slice(0, 200)}`
  ).join('\n');
}

// viewpoints カードからセグメント化用サマリを作る
function _cardSummary(card) {
  const parts = [
    `id:${card.id}`,
    `type:${card.slideType}`,
    `hook:${card.hookScore}`,
    `conf:${card.confidence}`,
  ];
  if (card.title) parts.push(`title:"${card.title}"`);
  if (card.scriptDir) parts.push(`dir:"${card.scriptDir}"`);
  if (card.recipeKey) parts.push(`recipe:${card.recipeKey}`);
  if (card.dataSource) parts.push(`src:${card.dataSource}`);
  if (card.dataPreview) parts.push(`preview:"${card.dataPreview}"`);
  if (card.insightSubtype && card.insightSubtype !== 'none') parts.push(`sub:${card.insightSubtype}`);
  if (card.bullets?.length) parts.push(`bullets:[${card.bullets.join(' / ')}]`);
  return parts.join(' | ');
}

// ── メイン: 脚本生成 ──
async function generateScript(viewpoints, book, opts = {}) {
  if (!viewpoints?.cards?.length) throw new Error('viewpoints が空');
  if (!book?.topic) throw new Error('ネタブックが未指定');

  const briefing = viewpoints.briefing || {};
  const cards = viewpoints.cards;

  // opening / ending を分離
  const opening = cards.find(c => c.slideType === 'opening') || { id: 'opening', title: book.title || book.topic, slideType: 'opening' };
  const ending = cards.find(c => c.slideType === 'ending') || { id: 'ending', title: '締め', slideType: 'ending' };
  const midCards = cards.filter(c => c.slideType !== 'opening' && c.slideType !== 'ending' && c.slideType !== 'toc');

  const entityBlock = _buildEntityBlock(book);
  const commentBlock = _buildCommentBlock(book);
  const articleBlock = _buildArticleBlock(book);
  const hasComments = Boolean(commentBlock);

  const todayJst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  const cardList = midCards.map((c, i) => `${i + 1}. ${_cardSummary(c)}`).join('\n');

  const prompt = `あなたはサッカーYouTubeショート動画（2-3分）のプロ脚本家です。

以下の企画ピース（${midCards.length}枚）を **4〜6セグメント × 二段構成** にグルーピングし、脚本を生成してください。

━━━ 二段構成とは ━━━
各セグメントは beat1（セットアップ）と beat2（パンチライン）の2スライドで構成:
- beat1: 事実・状況・データ（profile/stats/matchcard/picture/history/timeline）
- beat2: 展開・驚き・反応（insight/reaction/comparison）
例:
  beat1: [matchcard] アルゼンチンが勝利で課題解消
  beat2: [insight] この試合、メッシの異次元パスが話題に
━━━━━━━━━━━━━━

【今日の日付】${todayJst}
【案件タイトル】${book.title || book.topic}

【ブリーフィング】
hookQuestion: ${briefing.hookQuestion || '(なし)'}
angle: ${briefing.angle || '(なし)'}
answer: ${briefing.answer || '(なし)'}
storyPattern: ${briefing.storyPattern || '(なし)'}

【企画ピース一覧（${midCards.length}枚）】
${cardList}

【取得済みエンティティデータ】
${entityBlock}

【関連記事】
${articleBlock}

${hasComments ? `【コメント素材（reaction用）】\n${commentBlock}\n` : ''}

━━━ 生成ルール ━━━

【構成】
1. 企画ピースを 4〜6 セグメントにグルーピング。各セグメントは beat1 + beat2
2. 1つのピースは1つのセグメントにしか使わない
3. hookScore が高いピースを優先的に採用
4. TOC（目次）は生成しない。テンポ重視
5. opening は固定（タイトル読み上げのみ）。ending は固定（締め + CTA）
6. ${hasComments ? 'reaction セグメントを1つ入れる（beat2 に配置）' : 'コメント素材がないので reaction は生成しない'}
7. セグメント順序は hookScore 降順ではなく、**物語の流れ**で並べる

【各スライドの出力フィールド】
全スライド共通:
- "type": スライドタイプ（opening/ending/stats/profile/comparison/history/insight/reaction/timeline/matchcard/ranking/picture）
- "title": 見出し（10〜25文字）
- "narration": ナレーション本文

type 別:
- opening: narration は空文字""（タイトルのみ読み上げ）。"openingBadge": {"text":"2-4文字","color":"#hex","textColor":"#hex"}
- ending: narration 220〜280字。"endingCta": {"text":"CTA文言15字以内"}
- insight: "catchphrases": [{"text":"短句15字以内","chunkText":"narration対応文35-55字"} × 3-6]
- stats: "dataSlots": [{"label":"...","value":"..."} × 6-8]
- profile: "dataSlots": [{"label":"...","value":"..."} × 6-7]
- history: "dataSlots": [{"label":"年YYYY","value":"出来事","chunkText":"対応文35-55字"} × 4-8] 昇順。"historyHero":"2-8字","historyMilestoneLabel":"4-10字"
- comparison: "dataSlots": [{"label":"...","leftValue":"...","rightValue":"..."} × 4-7]
- reaction: "comments": [{"text":"日本語意訳","score":0} × 5-7]。narration は100-140字の短い前置き
- matchcard: 追加フィールド不要（matchData自動注入）。narration は試合ドラマを時系列で
- timeline: "dataSlots": [{"label":"...","value":"..."} × 4-8]
- picture: narration で写真の意味を語る
- ranking: "dataSlots": [{"label":"順位","value":"内容"} × 4-8]

【ナレーション】
- beat1: 180〜240字。事実+数字で状況を提示
- beat2: 220〜280字。beat1を受けて展開・深掘り
- 各スライド最低3個の具体数字
- スライド間は接続フレーズ（30-50字）で自然につなぐ
- 「〜と言われています」等の冗長表現禁止。数字と事実で勝負

【ファクト管理（厳守）】
- narration の事実は【取得済みデータ】と【関連記事】に明記されてるもの限定
- 未来形・予定形を確定形に書き換え禁止
- コメントは reaction で紹介OK、地の文の事実根拠にはしない
- ハルシネーション絶対禁止

【出力（JSONのみ）】
{
  "segments": [
    {
      "segmentTitle": "セグメント見出し",
      "beat1": { "type":"...", "title":"...", "narration":"...", ...type別フィールド },
      "beat2": { "type":"...", "title":"...", "narration":"...", ...type別フィールド },
      "usedCardIds": ["card_id_1", "card_id_2"]
    }
  ],
  "opening": { "type":"opening", "title":"...", "openingBadge":{...} },
  "ending": { "type":"ending", "title":"...", "narration":"...", "endingCta":{...} }
}`;

  console.log(`[v4_script] 脚本生成開始: ${book.topic} (ピース${midCards.length}枚→4-6セグメント)`);

  const raw = await callAI({
    forceProvider: 'anthropic',
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    label: 'v4-script',
    messages: [{ role: 'user', content: prompt }],
  });

  let parsed = null;
  try {
    const m = raw && raw.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch (_) {}

  if (!parsed?.segments?.length) {
    throw new Error('脚本生成失敗: ' + String(raw || '').slice(0, 400));
  }

  // segments → modules.json 形式に変換
  const modules = [];

  // opening
  const op = parsed.opening || {};
  modules.push({
    type: 'opening',
    title: op.title || opening.title || book.title || book.topic,
    images: [],
    bgImage: null,
    narration: '',
    openingBadge: op.openingBadge || null,
  });

  // segments → beat1, beat2
  for (const seg of parsed.segments) {
    for (const beatKey of ['beat1', 'beat2']) {
      const beat = seg[beatKey];
      if (!beat || !beat.type) continue;

      const mod = {
        type: beat.type,
        title: String(beat.title || '').slice(0, 40),
        narration: String(beat.narration || ''),
        images: [],
        bgImage: null,
      };

      if (beat.type === 'insight' && Array.isArray(beat.catchphrases)) {
        mod.catchphrases = beat.catchphrases.map(c => typeof c === 'string' ? c : c.text).slice(0, 6);
      }
      if (['stats', 'profile', 'timeline', 'ranking'].includes(beat.type) && Array.isArray(beat.dataSlots)) {
        mod.dataSlots = beat.dataSlots.slice(0, 8);
      }
      if (beat.type === 'history') {
        mod.dataSlots = Array.isArray(beat.dataSlots) ? beat.dataSlots.slice(0, 8) : [];
        mod.historyHero = beat.historyHero || '軌跡';
        mod.historyMilestoneLabel = beat.historyMilestoneLabel || '主な歩み';
      }
      if (beat.type === 'comparison' && Array.isArray(beat.dataSlots)) {
        mod.dataSlots = beat.dataSlots.slice(0, 7);
      }
      if (beat.type === 'reaction') {
        mod.comments = Array.isArray(beat.comments) ? beat.comments.slice(0, 7) : [];
        mod.narration = String(beat.narration || '').slice(0, 200);
      }
      if (beat.type === 'matchcard') {
        // matchData は後段で自動注入
      }

      modules.push(mod);
    }
  }

  // ending
  const ed = parsed.ending || {};
  modules.push({
    type: 'ending',
    title: ed.title || ending.title || '締め',
    narration: String(ed.narration || ''),
    bgImage: null,
    endingCta: ed.endingCta || { text: 'チャンネル登録 & いいね' },
  });

  // 保存
  const postId = opts.postId || _safePostId(book.topic);
  const result = { postId, modules };
  const outPath = path.join(DATA_DIR, `${postId}_modules.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`[v4_script] 保存: ${outPath} (${modules.length}スライド / ${parsed.segments.length}セグメント)`);

  return { postId, modules, segments: parsed.segments, outPath };
}

// ── フルパイプライン: viewpoints.json パス → 脚本 ──
async function buildScriptFromViewpoints(vpPath, book, opts = {}) {
  const viewpoints = JSON.parse(fs.readFileSync(vpPath, 'utf8'));
  return generateScript(viewpoints, book, opts);
}

// ── 一気通貫: topic → scout → neta → assets → viewpoints → 脚本 ──
async function buildScriptFromTopic(topicData, opts = {}) {
  const { buildViewpointsFromTopic } = require('./v4_viewpoints');
  console.log(`[v4_script] フルパイプライン開始: ${topicData.topic}`);
  const { book, viewpoints } = await buildViewpointsFromTopic(topicData, opts);
  const result = await generateScript(viewpoints, book, opts);
  console.log(`[v4_script] フルパイプライン完了: ${result.modules.length}スライド`);
  return { book, viewpoints, ...result };
}

module.exports = {
  generateScript,
  buildScriptFromViewpoints,
  buildScriptFromTopic,
};

// ── CLI テスト ──
if (require.main === module) {
  const topic = process.argv[2] || 'カゼミーロ、インテル・マイアミ移籍決定';
  buildScriptFromTopic({ topic }).then(result => {
    console.log('\n=== 脚本 ===');
    console.log(`postId: ${result.postId}`);
    console.log(`スライド数: ${result.modules.length}`);
    console.log(`セグメント数: ${result.segments.length}`);
    for (const seg of result.segments) {
      console.log(`\n[${seg.segmentTitle}]`);
      console.log(`  beat1: ${seg.beat1?.type} → ${seg.beat1?.title}`);
      console.log(`  beat2: ${seg.beat2?.type} → ${seg.beat2?.title}`);
    }
  }).catch(console.error);
}
