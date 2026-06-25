// launcher/scout.js
// サッカーニュースの話題を収集
// Yahoo News + Reddit r/soccer → DeepSeek選定 → 各15件

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// ── DeepSeek AI 呼び出し ─────────────────────────────

async function callDeepSeek(systemPrompt, userPrompt) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not set');
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

// ── Yahoo News スクレイピング ────────────────────────

async function fetchYahooRaw() {
  const cheerio = require('cheerio');
  const articles = [];
  const seen = new Set();

  const queries = [
    '%E3%82%B5%E3%83%83%E3%82%AB%E3%83%BC+W%E6%9D%AF',
    '%E3%82%B5%E3%83%83%E3%82%AB%E3%83%BC+%E7%A7%BB%E7%B1%8D',
    '%E3%82%B5%E3%83%83%E3%82%AB%E3%83%BC+%E6%97%A5%E6%9C%AC%E4%BB%A3%E8%A1%A8',
  ];

  for (const q of queries) {
    try {
      const url = `https://news.yahoo.co.jp/search?p=${q}&ei=UTF-8`;
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) continue;
      const html = await res.text();
      const $ = cheerio.load(html);

      $('a').each((i, el) => {
        const href = $(el).attr('href') || '';
        const rawText = $(el).text().trim().replace(/\s+/g, ' ');
        if (!href.includes('news.yahoo.co.jp/articles/') || rawText.length < 15) return;

        const cleanHref = href.split('?')[0];
        if (seen.has(cleanHref)) return;
        seen.add(cleanHref);

        let title = rawText;
        const ellipsis = title.indexOf('…');
        if (ellipsis > 10 && ellipsis < 80) title = title.slice(0, ellipsis);
        title = title.replace(/\d+\/\d+\(.\)\s*\d+:\d+/g, '').replace(/NEW\d*/g, '').trim();
        if (title.length < 10 || title.length > 100) return;

        articles.push({ title, url: cleanHref, source: 'yahoo' });
      });
    } catch (err) {
      console.warn(`  [yahoo] failed: ${err.message}`);
    }
  }
  console.log(`  [yahoo] raw: ${articles.length}件`);
  return articles;
}

// ── Reddit r/soccer HOT ─────────────────────────────

async function fetchRedditRaw() {
  const cookie = process.env.REDDIT_SESSION_COOKIE || '';
  if (!cookie) { console.warn('  [reddit] REDDIT_SESSION_COOKIE not set'); return []; }

  try {
    const res = await fetch('https://www.reddit.com/r/soccer/hot.json?limit=50', {
      headers: { 'User-Agent': UA, Cookie: cookie },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.warn(`  [reddit] ${res.status}`); return []; }

    const data = await res.json();
    const posts = (data.data?.children || [])
      .filter(c => c.kind === 't3')
      .map(c => c.data)
      .filter(p => !p.stickied);

    const articles = posts.map(p => ({
      title: p.title,
      flair: p.link_flair_text || '',
      score: p.score,
      comments: p.num_comments,
      url: `https://www.reddit.com${p.permalink}`,
      source: 'reddit',
    }));
    console.log(`  [reddit] raw: ${articles.length}件`);
    return articles;
  } catch (err) {
    console.warn(`  [reddit] failed: ${err.message}`);
    return [];
  }
}

// ── DeepSeek で動画ネタ向きトピック選定 ──────────────

const SELECTION_SYSTEM = `あなたはサッカーYouTubeチャンネルの編集者です。
与えられたニュース/投稿リストから、YouTube動画のネタとして盛り上がりそうなものを選んでください。

選定基準:
- 試合結果、選手パフォーマンス、移籍、論争、記録的な出来事を優先
- 芸能人のW杯観戦、ファッション、ゴシップ系は除外
- 「Daily Discussion」のような汎用スレッドは除外
- 同じ話題の重複は1つに絞る
- 日本語タイトルに翻訳して返す（元が英語の場合）

JSON形式で返してください:
{"selected": [{"index": 0, "title_ja": "日本語タイトル", "reason": "選定理由（10字以内）"}]}`;

async function selectByAI(articles, count, sourceLabel) {
  const list = articles.map((a, i) => {
    const parts = [`${i}. ${a.title}`];
    if (a.flair) parts.push(`[${a.flair}]`);
    if (a.score) parts.push(`↑${a.score}`);
    return parts.join(' ');
  }).join('\n');

  const userPrompt = `以下の${sourceLabel}の記事リストから、動画ネタに最適な${count}件を選んでください:\n\n${list}`;

  try {
    const result = await callDeepSeek(SELECTION_SYSTEM, userPrompt);
    const selected = (result.selected || []).slice(0, count);

    return selected.map(s => {
      const orig = articles[s.index];
      if (!orig) return null;
      return {
        title: s.title_ja || orig.title,
        url: orig.url,
        source: orig.source,
        score: orig.score || 0,
        reason: s.reason || '',
      };
    }).filter(Boolean);
  } catch (err) {
    console.warn(`  [AI選定] ${sourceLabel} failed: ${err.message}`);
    return articles.slice(0, count).map(a => ({
      title: a.title,
      url: a.url,
      source: a.source,
      score: a.score || 0,
      reason: '',
    }));
  }
}

// ── メインAPI ─────────────────────────────────────────

async function scoutWithAI() {
  console.log('\n=== Scout: Yahoo + Reddit → DeepSeek選定 ===\n');

  const [yahooRaw, redditRaw] = await Promise.all([
    fetchYahooRaw(),
    fetchRedditRaw(),
  ]);

  console.log('\n  DeepSeek選定中...\n');

  const [yahooSelected, redditSelected] = await Promise.all([
    yahooRaw.length ? selectByAI(yahooRaw, 15, 'Yahooニュース') : [],
    redditRaw.length ? selectByAI(redditRaw, 15, 'Reddit r/soccer') : [],
  ]);

  console.log(`  [yahoo] 選定: ${yahooSelected.length}件`);
  console.log(`  [reddit] 選定: ${redditSelected.length}件`);

  const topics = [...yahooSelected, ...redditSelected];
  console.log(`\n  Total: ${topics.length}件\n`);
  return topics;
}

module.exports = { scoutWithAI, fetchYahooRaw, fetchRedditRaw };
