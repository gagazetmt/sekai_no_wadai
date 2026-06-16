// v4_launcher/scripts/v4_neta.js
// ネタブック生成: 案件1件 → 記事3本+反応素材 → V4構成付きネタブックを生成
//
// 出力（ネタブック）:
//   title       : 2ch風タイトル（必須）
//   overview    : 概要紹介（必須）
//   supplement1 : 補足紹介① (null = AI判断で省略)
//   supplement2 : 補足紹介② (null = AI判断で省略)
//   comments1   : コメント集① (null = AI判断で省略)
//   comments2   : コメント集② (null = AI判断で省略)
//   mainEntity  : 主役の選手/チーム名（画像検索用）
//   layoutType       : info_heavy / comment_heavy
//   overviewType     : insight / picture
//   supplement1Type  : matchcard / stats / comparison / timeline / history / insight / picture
//   supplement2Type  : 同上（null = 省略）
//   commentAngle1/2  : コメントスライドの切り口
//   endingPunch      : EDで読むオチの一言
//
// AI が素材を見て「埋める価値があるセクションだけ」埋める。
// 全体で 1200 字以内を目安とする。
'use strict';

const path = require('path');
const fs   = require('fs');
const { fetchBookAssets } = require('./v4_assets');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const { fetchSerper }         = require('../../scripts/modules/fetchers/brave_search_module');
const { fetchArticleContent } = require('../../scripts/modules/fetchers/article_fetcher');
const { callAI }              = require('../../scripts/ai_client');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const NETA_DIR   = path.join(DATA_DIR, 'neta_books');
const INDEX_FILE = path.join(NETA_DIR, '_index.json');
if (!fs.existsSync(NETA_DIR)) fs.mkdirSync(NETA_DIR, { recursive: true });

const ARTICLE_CHARS  = 2000;
const REACTION_CHARS = 300;

// V4_NETA_MODEL=sonnet → Anthropic Sonnet / それ以外 → DeepSeek Chat（デフォルト）
const NETA_MODEL = (process.env.V4_NETA_MODEL || 'deepseek').toLowerCase();
const LAYOUT_TYPES = new Set(['info_heavy', 'comment_heavy']);
const OVERVIEW_TYPES = new Set(['insight', 'picture']);
const SUPPLEMENT_TYPES = new Set([
  'matchcard', 'stats', 'comparison', 'timeline',
  'history', 'insight', 'picture',
]);

// ── キャッシュ管理 ──────────────────────────────────────────────
function _topicKey(topic) {
  return String(topic || '').toLowerCase()
    .replace(/[\s　。、！？!?.,:;]+/g, '')
    .slice(0, 50);
}

function _loadIndex() {
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function _saveIndex(idx) {
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

/** キャッシュされたネタブックを返す。なければ null */
function getCachedBook(topic) {
  const key  = _topicKey(topic);
  const idx  = _loadIndex();
  const file = idx[key];
  if (!file) return null;
  const full = path.join(NETA_DIR, file);
  if (!fs.existsSync(full)) { delete idx[key]; _saveIndex(idx); return null; }
  try { return JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (_) { return null; }
}

function _cacheBook(topic, book, filename) {
  const idx = _loadIndex();
  idx[_topicKey(topic)] = filename;
  _saveIndex(idx);
}

// ── 信頼メディア + 最新ニュース検索（5件） ─────────────────────
const TRUSTED_DOMAINS = new Set([
  'fifa.com', 'uefa.com', 'bbc.com', 'bbc.co.uk', 'skysports.com',
  'reuters.com', 'apnews.com', 'espn.com', 'marca.com', 'as.com',
  'theathletic.com', 'goal.com', 'transfermarkt.com', 'transfermarkt.co.uk',
  'news.yahoo.co.jp', 'nikkansports.com', 'sponichi.co.jp',
  'football-zone.net', 'soccerking.jp', 'web.gekisaka.jp',
  'number.bunshun.jp', 'theguardian.com', 'telegraph.co.uk',
]);
const BLOCKED_DOMAINS = new Set([
  'youtube.com', 'youtu.be', 'tiktok.com', 'instagram.com',
  'twitter.com', 'x.com', 'facebook.com',
]);

function _trustScore(host) {
  if (!host) return 0.2;
  if (TRUSTED_DOMAINS.has(host)) return 1.0;
  if (/news\.yahoo\.co\.jp/.test(host)) return 0.95;
  if (/\.edu$|\.gov$/.test(host)) return 0.8;
  if (/wikipedia\.org$/.test(host)) return 0.7;
  return 0.4;
}

async function _fetchLatestNews(topic, existingUrl = '') {
  const enQ = topic.replace(/[ぁ-ん]|[ァ-ン]|[一-龥]/g, '').trim() || topic;
  const [enRes, jaRes] = await Promise.all([
    fetchSerper(enQ + ' latest news',     '', 'en', null, { num: 10 }).catch(() => ({ organic: [] })),
    fetchSerper(topic + ' 最新 ニュース', '', 'ja', null, { num: 10 }).catch(() => ({ organic: [] })),
  ]);

  const seen = new Set([existingUrl].filter(Boolean));
  const candidates = [];

  for (const r of [...(enRes.organic || []), ...(jaRes.organic || [])]) {
    let host = '';
    try { host = new URL(r.link || '').hostname.replace(/^www\./, ''); } catch (_) {}
    if (BLOCKED_DOMAINS.has(host) || seen.has(r.link)) continue;
    seen.add(r.link);
    const trust = _trustScore(host);
    candidates.push({
      title: r.title || '', url: r.link || '', snippet: r.snippet || '',
      host, date: r.date || null, trustScore: trust, isTrusted: trust >= 0.7,
    });
  }

  // 信頼メディア優先 → Yahoo News 優先 → その他
  candidates.sort((a, b) => b.trustScore - a.trustScore || (b.isTrusted ? 1 : 0) - (a.isTrusted ? 1 : 0));

  // 上位 8 件から本文取得を試みる（目標 5 件）
  const articles = [];
  for (const c of candidates.slice(0, 8)) {
    try {
      const res = await fetchArticleContent(c.url);
      if (res?.ok && res.content) {
        articles.push({ ...c, fullText: res.content.slice(0, ARTICLE_CHARS) });
        if (articles.length >= 5) break;
      }
    } catch (_) {}
  }
  // 本文取得できなかった分はスニペットで補完
  for (const c of candidates) {
    if (articles.length >= 5) break;
    if (!articles.find(a => a.url === c.url))
      articles.push({ ...c, fullText: c.snippet });
  }
  return articles.slice(0, 5);
}

// ═══════════════════════════════════════════════════════════════
// コメント倉庫
//   収集: Reddit 生コメント / Yahoo 実コメント欄 / X 元投稿への返信
//   保存: data/neta_books/_comments_{topicKey}.json
//   選定: リネカが倉庫から選ぶ。足りない場合のみ生成・意訳OK
// ═══════════════════════════════════════════════════════════════

const REDDIT_COOKIE = process.env.REDDIT_SESSION_COOKIE || '';
const X_API_KEY     = process.env.TWITTER_API_IO_KEY    || '';
const COMMENTS_DIR  = NETA_DIR;  // 同じディレクトリに _comments_ プレフィクスで保存
const COMMENT_WAREHOUSE_VERSION = 5;

function _cleanCommentText(value, maxLen = 280) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/@\w+/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function _uniqueComments(values, limit) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = _cleanCommentText(value);
    const key = text.toLowerCase().replace(/[\s。、！？!?.,・「」『』（）()]+/g, '');
    if (text.length < 8 || key.length < 6 || /[\uFFFD]/.test(text) || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function _isLikelyYahooComment(value) {
  const text = String(value || '').trim();
  if (!text || /[\uFFFD]/.test(text)) return false;

  // Yahooコメントページ内に混ざる関連記事の見出しを除外する。
  if (
    /(?:代表|監督|選手|MF|FW|DF|GK|会長|社長).{0,24}(?:が|は)(?:述懐|告白|明か|語っ|発言|断言|回想|説明)[^。！？]{0,12}[「『]/.test(text)
  ) return false;

  return true;
}

function _isLikelyXReaction(value) {
  const text = _cleanCommentText(value);
  if (!text) return false;

  const reactionSignal =
    /思う|思っ|残念|嬉し|悲し|切な|悔し|すご|凄|ヤバ|やば|ありがとう|お疲れ|べき|だろう|かな|最高|腹が立|応援|期待|心配|驚|納得|好き|嫌い|頑張/;
  const newsSummary =
    /(?:発表|表明|公表|報道|判明|明らかに|離脱|就任|退任|移籍)(?:しました|した|となりました|となった)/;

  return !newsSummary.test(text) || reactionSignal.test(text);
}

// ── Reddit スレッドの生コメント ──────────────────────────────
async function _fromReddit(sourceUrl, topic = '') {
  // ① ソースURLがredditならそのスレッドから取得
  if (sourceUrl && sourceUrl.includes('reddit.com')) {
    try {
      const apiUrl = sourceUrl.replace(/\/$/, '') + '.json?limit=50&sort=top';
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; V4Neta/1.0)',
          ...(REDDIT_COOKIE ? { Cookie: REDDIT_COOKIE } : {}),
        },
        signal: AbortSignal.timeout(12000),
      });
      if (res.ok) {
        const data = await res.json();
        const comments = (data?.[1]?.data?.children || [])
          .filter(c => c.kind === 't1' && c.data?.body && c.data.body !== '[deleted]')
          .map(c => String(c.data.body).replace(/\n+/g, ' ').trim())
          .filter(t => t.length >= 15 && t.length <= 280)
          .slice(0, 25);
        if (comments.length >= 3) return comments;
      }
    } catch (e) { console.warn('[comments] Reddit direct 失敗:', e.message); }
  }
  // ② topicベースでr/soccerを検索してコメント取得
  if (!topic) return [];
  try {
    const enTopic = topic.replace(/[ぁ-ん]|[ァ-ヶ]|[一-龥]/g, '').trim() || topic;
    const searchUrl = `https://www.reddit.com/r/soccer/search.json?q=${encodeURIComponent(enTopic)}&sort=new&restrict_sr=1&limit=5&t=week`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; V4Neta/1.0)' },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const posts = data?.data?.children || [];
    const allComments = [];
    for (const post of posts.slice(0, 3)) {
      const permalink = post.data?.permalink;
      if (!permalink) continue;
      try {
        const threadRes = await fetch(`https://www.reddit.com${permalink}.json?limit=30&sort=top`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; V4Neta/1.0)' },
          signal: AbortSignal.timeout(10000),
        });
        if (!threadRes.ok) continue;
        const threadData = await threadRes.json();
        const comments = (threadData?.[1]?.data?.children || [])
          .filter(c => c.kind === 't1' && c.data?.body && c.data.body !== '[deleted]')
          .map(c => String(c.data.body).replace(/\n+/g, ' ').trim())
          .filter(t => t.length >= 15 && t.length <= 280);
        allComments.push(...comments);
      } catch (_) {}
    }
    return _uniqueComments(allComments, 25);
  } catch (e) {
    console.warn('[comments] Reddit search 失敗:', e.message);
    return [];
  }
}

// ── Yahoo ニュースの実コメント欄 ─────────────────────────────
async function _fromYahoo(topic) {
  try {
    const res = await fetchSerper(
      `site:news.yahoo.co.jp ${topic}`, '', 'ja', null, { num: 6 }
    );
    const urls = [...new Set(
      (res?.organic || [])
        .map(r => r.link)
        .filter(url => /^https?:\/\/news\.yahoo\.co\.jp\//i.test(String(url || '')))
    )].slice(0, 4);

    const comments = [];
    for (const url of urls) {
      try {
        const article = await fetchArticleContent(url);
        if (Array.isArray(article?.comments)) {
          comments.push(...article.comments.filter(_isLikelyYahooComment));
        }
        if (comments.length >= 20) break;
      } catch (_) {}
    }
    return _uniqueComments(comments, 15);
  } catch (e) {
    console.warn('[comments] Yahoo 失敗:', e.message);
    return [];
  }
}

// ── X 元投稿への返信（twitterapi.io）─────────────────────────
async function _fromX(sourceUrl, topic = '') {
  if (!X_API_KEY) return [];
  // ① ソースURLがXならconversation_idで返信取得
  const sourceId = (sourceUrl && /(?:x|twitter)\.com\//i.test(sourceUrl))
    ? String(sourceUrl).match(/status\/(\d+)/)?.[1]
    : null;
  if (sourceId) {
    try {
      const q = `conversation_id:${sourceId} -is:retweet`;
      const res = await fetch(
        'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
        new URLSearchParams({ query: q, queryType: 'Top' }),
        { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
      );
      const data = await res.json();
      const tweets = data?.data?.tweets || data?.tweets || [];
      const replies = tweets
        .filter(t => String(t.id || t.id_str || t.tweetId || t.tweet_id || '') !== sourceId)
        .filter(t => {
          const replyTo = t.inReplyToId || t.in_reply_to_status_id_str || t.in_reply_to_tweet_id;
          const isReply = t.isReply ?? t.is_reply;
          return replyTo != null || isReply === true || String(t.conversationId || t.conversation_id || '') === sourceId;
        })
        .map(t => t.text || t.full_text || '')
        .filter(_isLikelyXReaction);
      const result = _uniqueComments(replies, 20);
      if (result.length >= 3) return result;
    } catch (e) { console.warn('[comments] X direct 失敗:', e.message); }
  }
  // ② topicベースでX上の反応ツイートを検索
  if (!topic) return [];
  try {
    const jaQ = topic.slice(0, 60) + ' lang:ja -is:retweet';
    const res = await fetch(
      'https://api.twitterapi.io/twitter/tweet/advanced_search?' +
      new URLSearchParams({ query: jaQ, queryType: 'Top' }),
      { headers: { 'X-API-Key': X_API_KEY }, signal: AbortSignal.timeout(12000) }
    );
    const data = await res.json();
    const tweets = data?.data?.tweets || data?.tweets || [];
    const reactions = tweets
      .map(t => t.text || t.full_text || '')
      .filter(_isLikelyXReaction);
    return _uniqueComments(reactions, 20);
  } catch (e) {
    console.warn('[comments] X search 失敗:', e.message);
    return [];
  }
}

// ── コメント倉庫を構築・保存 ─────────────────────────────────
async function _buildCommentWarehouse(topic, sourceUrl) {
  const key      = _topicKey(topic);
  const savePath = path.join(COMMENTS_DIR, `_comments_${key}.json`);

  // キャッシュがあればそのまま返す
  if (fs.existsSync(savePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(savePath, 'utf8'));
      if (cached.version === COMMENT_WAREHOUSE_VERSION) {
        console.log(`[comments] キャッシュ使用: reddit=${cached.reddit?.length} yahoo=${cached.yahoo?.length} x=${cached.x?.length}`);
        return cached;
      }
      console.log('[comments] 旧キャッシュを再構築:', path.basename(savePath));
    } catch (_) {}
  }

  // 3ソース並列取得（topicベース検索フォールバック付き）
  const [reddit, yahoo, x] = await Promise.all([
    _fromReddit(sourceUrl, topic),
    _fromYahoo(topic),
    _fromX(sourceUrl, topic),
  ]);

  const warehouse = {
    version: COMMENT_WAREHOUSE_VERSION,
    topic, topicKey: key,
    reddit,
    yahoo,
    x,
    total: reddit.length + yahoo.length + x.length,
    collectedAt: new Date().toISOString(),
  };

  fs.writeFileSync(savePath, JSON.stringify(warehouse, null, 2));
  console.log(`[comments] 倉庫構築: reddit=${reddit.length} yahoo=${yahoo.length} x=${x.length} 計${warehouse.total}件`);
  return warehouse;
}

// ── リネカ: ネタブック 1 発生成 ──────────────────────────────
const RINEKA_SYSTEM = `あなたはリネカ。サッカー専門のクリエイティブ・ディレクター、20代前半。
サッカーが人生のすべて。欧州主要リーグ・移籍市場・戦術に精通し、Reddit/Xの海外トレンドをリアルタイムで追っている。

## リネカのコンテンツ哲学

ネタブックを作る前に、まず問う：「この出来事で視聴者は何を感じるべきか？」

感情の軸は1本。それに全てを奉仕させる。

- 選手の引退・離脱 → 悲しさ＋感謝＋偉大さの再確認
- 移籍・新天地     → ワクワク＋未知への期待＋別れの寂しさ
- 衝撃スキャンダル  → 驚き＋怒り＋「やっぱりな」の入り混じり
- 記録達成・偉業   → 興奮＋誇り＋数字の重さ
- 笑えるミス・失態 → 愛ある笑い（人格攻撃は絶対しない）

## 鉄則

1. **タイトル**: hookを鋭くするだけ。別のニュースを混ぜない。
2. **補足**: 感情軸を深める素材のみ。「この後どうなる？」「誰が代わる？」は別の動画。
3. **コメント**: 視聴者の感情が証明できる言葉のみ。でっち上げ禁止。
4. **主語の一貫性**: 遠藤の話なら最後まで遠藤。板倉や守田は登場しない。
5. **選手・クラブへのリスペクト**: 全てのフットボーラーとクラブに敬意を持つ。
   - 憶測でクラブや選手を貶めない（例: 「ミランに失望」→ 報道ソースが明確な場合のみ）
   - 結果が悪くても人格否定や侮辱的な表現は禁止
   - ただし、愛あるネタ弄りはOK（例: トーレス師匠の宇宙開発、バルサの守備崩壊芸など、ファン間で定番化しているもの）
   - 判断基準: 「その選手/クラブのファンが見て不快にならないか」。際どい場合はリスペクト側に倒す`;

async function _generateNetaBook(topic, hook, articles, warehouse) {
  const articleBlock = articles.map((a, i) => {
    const trustTag = a.isTrusted ? '★信頼メディア' : '';
    return `【ニュース${i+1}】[${a.host}] ${trustTag} ${a.title}\n${a.fullText}`;
  }).join('\n\n---\n\n');

  // コメント倉庫ブロック
  const warehouseLines = [];
  if (warehouse.reddit?.length)
    warehouseLines.push(`【Reddit（生コメント ${warehouse.reddit.length}件）】\n` + warehouse.reddit.map((c,i) => `${i+1}. ${c}`).join('\n'));
  if (warehouse.yahoo?.length)
    warehouseLines.push(`【ヤフコメ/国内反応（${warehouse.yahoo.length}件）】\n` + warehouse.yahoo.map((c,i) => `${i+1}. ${c}`).join('\n'));
  if (warehouse.x?.length)
    warehouseLines.push(`【X ツイート（${warehouse.x.length}件）】\n` + warehouse.x.map((c,i) => `${i+1}. ${c}`).join('\n'));
  const warehouseBlock = warehouseLines.length
    ? warehouseLines.join('\n\n')
    : '（コメント素材なし）';

  const hasRealComments = (warehouse.total || 0) >= 3;

  const prompt = `## 今回の案件

【案件】${topic}
${hook ? `【フックヒント（このトーンで作る）】${hook}` : ''}

## ニュース素材（信頼メディア優先で最新5件を検索済み）

${articleBlock}

**重要**: ★信頼メディアの情報を最優先で事実確認に使うこと。不明確な情報は「報道によると」等で留保する。

## コメント倉庫（実際に収集した生の反応）

${warehouseBlock}

━━━━━━━━━━━━━━━━━━━━━━━━━━
## 出力（JSONのみ）

全体合計 **1200字以内**。感情軸に関係しないセクションは null にする。

| フィールド | 内容 | 文字数目安 | 必須? |
|---|---|---|---|
| title | hookを鋭くした2ch風タイトル。別のニュースは混ぜない | 〜40字 | ✅ |
| overview | 何が起きたか。感情軸を一言で示す導入も含める | 150〜250字 | ✅ |
| supplement1 | 感情軸を深める背景・数字・キャリア・言葉 | 100〜200字 | 素材あれば |
| supplement2 | 同じ感情軸の別の切り口（似てるなら null） | 100〜200字 | 素材あれば |
| comments1 | コメント 3〜4件（1件40〜80字目安） | — | ✅必須 |
| comments2 | 別カテゴリのコメント 3〜4件（1件40〜80字目安） | — | ✅必須 |
| mainEntity | 主役の英語名（選手→フルネーム / 試合→国名のみ例: "Morocco" "Brazil"。"national football team"は不要） | — | ✅ |
| keyPlayer | **試合ネタ必須**。ゴール・MVP・最も目立った選手の英語フルネーム（例: "Hicham Boudaoui"）。日本語・年齢・国籍は含めない | — | 試合時 |
| keyManager | 試合・チームネタ推奨。主役チームの監督英語フルネーム（例: "Walid Regragui"）。不明なら null | — | 試合・チーム時 |
| otherPlayers | keyPlayer 以外の注目選手 1〜2件の英語フルネーム配列（例: ["Achraf Hakimi", "Yassine Bounou"]）。なければ null | — | 試合・チーム時 |
| subEntities | 副役1〜2件（試合→対戦相手チーム名 / 複数選手→2番手）英語名リスト | — | 試合・比較時 |
| layoutType | comment_heavy（②コメント重点型=基本）か info_heavy（①情報重点型）。②を7割採用 | — | ✅ |
| overviewType | 概要スライドの型: insight（論点4つ以上）/ picture（画像中心） | — | ✅ |
| overviewData | overviewType=insight の場合: {catchphrases:[...]} 4件以上。picture なら {} | — | ✅ |
| supplement1Type | 補足1のスライド型（下記参照）。不要なら null | — | 補足時 |
| supplement1Title | 補足1の短い見出し | 〜24字 | 補足時 |
| supplement1Data | 補足1の表示データ（型に応じたスキーマ） | — | 補足時 |
| supplement2Type | 補足2のスライド型。不要なら null | — | 補足時 |
| supplement2Title | 補足2の短い見出し | 〜24字 | 補足時 |
| supplement2Data | 補足2の表示データ（型に応じたスキーマ） | — | 補足時 |
| commentAngle1 | コメント①の切り口 | 〜18字 | コメント時 |
| commentAngle2 | コメント②の切り口 | 〜18字 | コメント時 |
| endingPunch | EDで読むオチの一言。CTAや挨拶は禁止 | 〜32字 | ✅ |
| assetLabels | 画像・データ取得用ラベル（最大8件） | — | ✅ |
| thumbLine1 | サムネ1行目。{red:注目語} {blue:感情語} でカラー強調。衝撃ワード。リスペクトルール厳守（憶測で貶めない） | 〜18字 | ✅ |
| thumbLine2 | サムネ2行目。同じくカラー強調可。なければ null | 〜18字 | あれば |
| thumbLabel1 | サムネ上部ラベル1。短い分類タグ（例: 悲報、速報、衝撃） | 〜6字 | ✅ |
| thumbLabel2 | サムネ上部ラベル2。別角度のタグ（例: 海外の反応）。なければ null | 〜8字 | あれば |
| ytTitle | YouTube動画タイトル。検索に強く、クリックしたくなるもの | 〜60字 | ✅ |
| ytDescription | YouTube概要欄。動画内容の要約+ハッシュタグ | 100〜200字 | ✅ |
| ytTags | YouTube検索タグ配列。5〜10件 | — | ✅ |
| tone_check | "ok" / "ng" | — | ✅ |

**レイアウト型（layoutType）:**
- **comment_heavy**（②コメント重点型）: OP → 概要 → 補足1 → コメ1 → 補足2 → コメ2 → ED ← **基本はこちら（7割）**
- **info_heavy**（①情報重点型）: OP → 概要 → 補足1 → 補足2 → コメ1 → コメ2 → ED
- 補足1・補足2 は文脈上不要なら null で省略OK

**概要スライドの型（overviewType）:**
- **insight** → 論点を4つ以上テキストボックスで表示。overviewData.catchphrases に4件以上
- **picture** → 画像中心。overviewData は {}

**supplement1Type の決定（以下のフローチャートを上から順に判定。最初に当てはまった型を使う）:**

Q1. 記事にスコア（○-○）があるか？
  → YES → **matchcard**（必須。試合ネタでは他の型より常に優先）
Q2. 特定の選手のゴール数・アシスト・レーティング等の数値が話題の中心か？
  → YES → **stats**
Q3. 2者（選手vs選手、チームvsチーム）の比較が感情軸の核か？
  → YES → **comparison**
Q4. 時系列（過去の対戦歴・事件の年表）が感情を深めるか？
  → YES → **history**
Q5. 上記すべてNO
  → **insight**（論点4つ以上でまとめる）

**supplement2Type の決定:**
- supplement1Type と同じ型は選ばない
- 上のQ1〜Q5を supplement1 で使わなかった素材に対して再度判定
- 素材が足りなければ null（無理に埋めない）

**各型の Data スキーマ:**
- matchcard: { "homeTeam": "Japan", "awayTeam": "Netherlands", "homeScore": 2, "awayScore": 2 }
- stats: { "dataSlots": [{"label":"ゴール数","value":"15"}, {"label":"アシスト","value":"8"}] } ← 4〜8件
- comparison: { "leftName": "選手A", "rightName": "選手B", "dataSlots": [{"label":"得点","left":"12","right":"8"}] }
- history: { "events": [{"date":"2024-03","title":"PSG戦","detail":"2-1で勝利"}] } ← 3〜6件
- insight: { "catchphrases": ["論点1","論点2","論点3","論点4"] } ← 4〜6件

**assetLabels（画像・データ取得用ラベル）:**
- この案件に関連するキーパーソン・チームを最大8件提案する
- 各ラベルに name（英語名）, type（player/team/nationalTeam/manager）, team（所属チーム英語名、該当時）を設定
- 主役（mainEntity）は必ず含める
- 所属クラブ、所属代表、対戦相手、関連監督なども含めて広く提案する
- 例: [{"name":"Kaoru Mitoma","type":"player","team":"Brighton"},{"name":"Brighton","type":"team","league":"Premier League"},{"name":"Japan","type":"nationalTeam"},{"name":"Roberto De Zerbi","type":"manager","team":"Brighton"},{"name":"Tottenham","type":"team","league":"Premier League"}]

**コメントの使い方:**
- **comments1 と comments2 は両方とも必ず埋める**（null 禁止）
- 2スライドはカテゴリで分ける。分け方の例:
  - 国内反応（Yahoo/5ch） vs 海外反応（Reddit/X英語コメント）
  - Aチームファンの意見 vs Bチームファンの意見
  - 賞賛・期待 vs 批判・不安
  - 選手への反応 vs 監督・チームへの反応
- commentAngle1/2 でそのカテゴリ分けが伝わる見出しを付ける
- **1件あたり40〜80字**が目安。短すぎるコメントばかりだと満足感がない。面白ければ短文もOKだが、全体バランスを取る
- 外国語（Reddit/X英語）コメントは日本語に意訳OK
- 日本語コメントも長すぎ・短すぎの場合は一部意訳・要約OK（元の感情トーンは維持）
${hasRealComments
  ? '- コメント倉庫に生の反応がある。倉庫の言葉をベースに使い、必要に応じて長さ調整・意訳する'
  : '- 今回は生コメントが不足。感情軸に合ったコメントを自然に生成してよい'}
- 感情軸とズレたコメントは倉庫にあっても使わない

{
  "title": "...",
  "overview": "...",
  "supplement1": "...",
  "supplement2": null,
  "comments1": ["...", "...", "..."],
  "comments2": null,
  "mainEntity": "Wataru Endo",
  "keyPlayer": null,
  "keyManager": null,
  "otherPlayers": null,
  "subEntities": null,
  "layoutType": "comment_heavy",
  "overviewType": "insight",
  "overviewData": {
    "catchphrases": ["キャプテンの決断", "W杯直前の衝撃", "代表57キャップの重み", "リバプールでの挑戦は続く"]
  },
  "supplement1Type": "insight",
  "supplement1Title": "遠藤が残したもの",
  "supplement1Data": {
    "catchphrases": ["主将としてチームを牽引", "代表で積み重ねた信頼", "アンカーの概念を変えた", "最後まで全力だった"]
  },
  "supplement2Type": null,
  "supplement2Title": null,
  "supplement2Data": null,
  "commentAngle1": "感謝の声",
  "commentAngle2": "惜しむ声",
  "assetLabels": [
    {"name": "Wataru Endo", "type": "player", "team": "Liverpool"},
    {"name": "Liverpool", "type": "team", "league": "Premier League"},
    {"name": "Japan", "type": "nationalTeam"}
  ],
  "thumbLine1": "{red:遠藤航}が決断",
  "thumbLine2": "代表{blue:引退}の真相",
  "thumbLabel1": "速報",
  "thumbLabel2": "海外の反応",
  "ytTitle": "【速報】遠藤航、W杯直前に代表引退を発表…その決断の裏側とは",
  "ytDescription": "遠藤航がW杯直前に日本代表からの引退を発表。キャプテンとしてチームを牽引してきた男の決断に、ファンからは感謝と惜しむ声が殺到。\\n\\n#遠藤航 #日本代表 #W杯 #サッカー",
  "ytTags": ["遠藤航", "日本代表", "W杯", "代表引退", "サッカー", "ワールドカップ", "リバプール"],
  "endingPunch": "最後まで、遠藤らしい決断だった。",
  "tone_check": "ok"
}`;

  const aiOpts = NETA_MODEL === 'sonnet'
    ? { forceProvider: 'anthropic', model: 'claude-sonnet-4-6', max_tokens: 3000 }
    : { forceProvider: 'deepseek',  model: 'deepseek-chat',     max_tokens: 3000 };
  console.log(`[v4_neta] モデル: ${NETA_MODEL === 'sonnet' ? 'claude-sonnet-4-6' : 'deepseek-chat'}`);

  const raw = await callAI({
    ...aiOpts,
    label: 'v4-neta',
    system: RINEKA_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const jsonText = raw && raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!jsonText || !jsonText.startsWith('{') || !jsonText.endsWith('}')) {
    throw new Error('ネタブック生成失敗: JSON未検出');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    // JSON が壊れていたら最小構造でフォールバック
    throw new Error('ネタブックJSON parse失敗: ' + e.message);
  }

  if (parsed.tone_check === 'ng') {
    throw new Error('tone_check: NG（誹謗中傷判定）');
  }

  // null/undefined/空文字 の正規化
  function clean(v, maxLen) {
    const s = String(v || '').trim();
    return s ? s.slice(0, maxLen) : null;
  }
  function cleanArr(v, maxItem, maxLen) {
    if (!Array.isArray(v) || !v.length) return null;
    const arr = v.map(x => String(x||'').trim()).filter(Boolean).map(x => x.slice(0, maxLen));
    return arr.length >= 2 ? arr.slice(0, maxItem) : null;
  }
  function cleanObject(v) {
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  const layoutType = LAYOUT_TYPES.has(parsed.layoutType)
    ? parsed.layoutType
    : 'comment_heavy';
  const overviewType = OVERVIEW_TYPES.has(parsed.overviewType)
    ? parsed.overviewType
    : 'picture';
  const supplement1Type = SUPPLEMENT_TYPES.has(parsed.supplement1Type)
    ? parsed.supplement1Type
    : null;
  const supplement2Type = SUPPLEMENT_TYPES.has(parsed.supplement2Type)
    ? parsed.supplement2Type
    : null;

  const subEntities = Array.isArray(parsed.subEntities)
    ? parsed.subEntities.map(x => String(x || '').trim()).filter(Boolean).slice(0, 2)
    : null;

  const assetLabels = Array.isArray(parsed.assetLabels)
    ? parsed.assetLabels
        .filter(l => l && l.name)
        .map(l => ({
          name: String(l.name || '').trim(),
          type: String(l.type || 'player').trim(),
          team: l.team ? String(l.team).trim() : null,
          league: l.league ? String(l.league).trim() : null,
        }))
        .slice(0, 8)
    : [];

  return {
    title:       clean(parsed.title, 60)        || topic,
    overview:    clean(parsed.overview, 300)     || '（概要未生成）',
    supplement1: clean(parsed.supplement1, 250),
    supplement2: clean(parsed.supplement2, 250),
    comments1:   cleanArr(parsed.comments1, 5, 100),
    comments2:   cleanArr(parsed.comments2, 5, 100),
    mainEntity:   clean(parsed.mainEntity, 80)    || '',
    keyPlayer:    clean(parsed.keyPlayer, 80),
    keyManager:   clean(parsed.keyManager, 80),
    otherPlayers: Array.isArray(parsed.otherPlayers)
      ? parsed.otherPlayers.map(p => String(p || '').trim()).filter(Boolean).slice(0, 2)
      : null,
    subEntities: subEntities?.length ? subEntities : null,
    layoutType,
    overviewType,
    overviewData: cleanObject(parsed.overviewData),
    supplement1Type,
    supplement1Title: clean(parsed.supplement1Title, 40),
    supplement1Data: cleanObject(parsed.supplement1Data),
    supplement2Type,
    supplement2Title: clean(parsed.supplement2Title, 40),
    supplement2Data: cleanObject(parsed.supplement2Data),
    // 後方互換: v4_assets / v4_video が参照する旧フィールド
    structurePattern: layoutType === 'info_heavy' ? 'standard' : 'interleaved',
    supplementType: supplement1Type || supplement2Type || null,
    supplementData: cleanObject(parsed.supplement1Data || parsed.supplement2Data),
    commentAngle1: clean(parsed.commentAngle1, 30) || 'ネットの反応',
    commentAngle2: clean(parsed.commentAngle2, 30) || 'さらに反応',
    assetLabels,
    thumbLine1:    clean(parsed.thumbLine1, 30)    || '',
    thumbLine2:    clean(parsed.thumbLine2, 30),
    thumbLabel1:   clean(parsed.thumbLabel1, 12)   || '',
    thumbLabel2:   clean(parsed.thumbLabel2, 12),
    ytTitle:       clean(parsed.ytTitle, 80)        || '',
    ytDescription: clean(parsed.ytDescription, 300) || '',
    ytTags:        Array.isArray(parsed.ytTags) ? parsed.ytTags.map(t => String(t||'').trim()).filter(Boolean).slice(0, 10) : [],
    endingPunch: clean(parsed.endingPunch, 50) || 'この話、まだ動きそうだ。',
    tone_check:  'ok',
  };
}

// ── メイン ────────────────────────────────────────────────────
// force: true → キャッシュを無視して再生成
async function buildNetaBook(topicData, { force = false } = {}) {
  const { topic, hook = '', url = '' } = topicData;

  // キャッシュチェック（force=false のときのみ）
  if (!force) {
    const cached = getCachedBook(topic);
    if (cached) {
      console.log('[v4_neta] キャッシュ使用:', topic);
      return cached;
    }
  }

  console.log('[v4_neta] 開始:', topic);

  // ニュース検索 + コメント倉庫構築 を並列
  const [articles, warehouse] = await Promise.all([
    _fetchLatestNews(topic, url),
    _buildCommentWarehouse(topic, url),
  ]);
  const trustedCount = articles.filter(a => a.isTrusted).length;
  console.log(`[v4_neta] ニュース: ${articles.length}件（信頼${trustedCount}件） / コメント倉庫: ${warehouse.total}件`);

  // AI ネタブック生成（1 API call）
  const neta = await _generateNetaBook(topic, hook, articles, warehouse);
  console.log(`[v4_neta] 生成完了 s1:${!!neta.supplement1} s2:${!!neta.supplement2} c1:${!!neta.comments1} c2:${!!neta.comments2}`);

  const book = {
    topic,
    hook,
    title:            neta.title,
    overview:         neta.overview,
    supplement1:      neta.supplement1,
    supplement2:      neta.supplement2,
    comments1:        neta.comments1,
    comments2:        neta.comments2,
    mainEntity:       neta.mainEntity,
    keyPlayer:        neta.keyPlayer    || null,
    keyManager:       neta.keyManager   || null,
    otherPlayers:     neta.otherPlayers || null,
    subEntities:      neta.subEntities  || null,
    assetLabels:      neta.assetLabels  || [],
    layoutType:       neta.layoutType,
    overviewType:     neta.overviewType,
    overviewData:     neta.overviewData,
    supplement1Type:  neta.supplement1Type,
    supplement1Title: neta.supplement1Title,
    supplement1Data:  neta.supplement1Data,
    supplement2Type:  neta.supplement2Type,
    supplement2Title: neta.supplement2Title,
    supplement2Data:  neta.supplement2Data,
    // 後方互換
    structurePattern: neta.structurePattern,
    supplementType:   neta.supplementType,
    supplementData:   neta.supplementData,
    commentAngle1:    neta.commentAngle1,
    commentAngle2:    neta.commentAngle2,
    thumbLine1:       neta.thumbLine1,
    thumbLine2:       neta.thumbLine2,
    thumbLabel1:      neta.thumbLabel1,
    thumbLabel2:      neta.thumbLabel2,
    ytTitle:          neta.ytTitle,
    ytDescription:    neta.ytDescription,
    ytTags:           neta.ytTags,
    endingPunch:      neta.endingPunch,
    commentWarehouse: { total: warehouse.total, reddit: warehouse.reddit?.length, yahoo: warehouse.yahoo?.length, x: warehouse.x?.length },
    articles:         articles.map(a => ({ title: a.title, url: a.url, host: a.host })),
    createdAt:        new Date().toISOString(),
  };

  try {
    const assets = await fetchBookAssets(book);
    book.dataLabels = assets.labels;
    book.fetchedData = assets.dataRows;
    book.assetImages = assets.images;
    book.selectedImages = assets.images.slice(0, 3).map(image => image.url).filter(Boolean);
    book.assetWarnings = assets.warnings;
    // supplement1 / supplement2 の stats 型にデータ補完
    for (const sfx of ['supplement1', 'supplement2']) {
      const typeKey = `${sfx}Type`;
      const dataKey = `${sfx}Data`;
      if (
        book[typeKey] === 'stats' &&
        assets.dataRows.length &&
        (!Array.isArray(book[dataKey]?.dataSlots) || !book[dataKey].dataSlots.length)
      ) {
        book[dataKey] = {
          ...(book[dataKey] || {}),
          dataSlots: assets.dataRows.slice(0, 8).map(row => ({
            label: row.label,
            value: row.value,
            source: row.source,
            key: row.key,
          })),
        };
      }
    }
    // 後方互換: supplementData も同期
    if (
      ['stats', 'profile'].includes(book.supplementType) &&
      assets.dataRows.length &&
      (!Array.isArray(book.supplementData?.dataSlots) || !book.supplementData.dataSlots.length)
    ) {
      book.supplementData = {
        ...(book.supplementData || {}),
        dataSlots: assets.dataRows.slice(0, 8).map(row => ({
          label: row.label,
          value: row.value,
          source: row.source,
          key: row.key,
        })),
      };
    }
    console.log(
      `[v4_neta] データ取得: labels=${assets.labels.length} rows=${assets.dataRows.length} images=${assets.images.length}`,
    );
  } catch (e) {
    book.dataLabels = [];
    book.fetchedData = [];
    book.assetImages = [];
    book.assetWarnings = [e.message];
    console.warn('[v4_neta] データ・画像取得失敗:', e.message);
  }

  const safeId  = topic.replace(/[^\w぀-ゟ゠-ヿ一-鿿]+/g, '_').slice(0, 40);
  const fname   = `neta_${safeId}_${Date.now()}.json`;
  const outPath = path.join(NETA_DIR, fname);
  fs.writeFileSync(outPath, JSON.stringify(book, null, 2));
  _cacheBook(topic, book, fname);
  console.log('[v4_neta] 保存:', outPath);

  return book;
}

function getWarehousePath(topic) {
  return path.join(COMMENTS_DIR, `_comments_${_topicKey(topic)}.json`);
}

module.exports = {
  buildNetaBook,
  buildCommentWarehouse: _buildCommentWarehouse,
  getCachedBook,
  getWarehousePath,
};

// ── CLI テスト ────────────────────────────────────────────────
if (require.main === module) {
  const topic = process.argv[2] || '遠藤航、W杯直前に離脱＆代表引退';
  buildNetaBook({ topic, hook: '' }).then(book => {
    console.log('\n=== ネタブック ===');
    console.log('①タイトル:', book.title);
    console.log('②概要:', book.overview);
    console.log('③補足1:', book.supplement1 || '（省略）');
    console.log('④補足2:', book.supplement2 || '（省略）');
    console.log('⑤コメント1:', book.comments1 ? book.comments1.join(' / ') : '（省略）');
    console.log('⑥コメント2:', book.comments2 ? book.comments2.join(' / ') : '（省略）');
    console.log('主役:', book.mainEntity);
  }).catch(console.error);
}
