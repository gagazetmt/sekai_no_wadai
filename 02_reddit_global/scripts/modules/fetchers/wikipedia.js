// scripts/modules/fetchers/wikipedia.js
// Wikipedia REST API でテキスト・要約を取得（無料・安定）
//
// 使用API:
//   直接: https://en.wikipedia.org/api/rest_v1/page/summary/{title}
//   検索: https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}

const axios = require('axios');

const HEADERS = {
  'User-Agent': 'SoccerYTBot/2.0 (soccer-yt-project)',
  'Accept':     'application/json',
};

// 単一タイトルでWikipedia要約を取得
async function fetchWikipedia(nameEn) {
  if (!nameEn) return { ok: false, error: '名前が未指定' };

  const title = encodeURIComponent(nameEn.trim().replace(/ /g, '_'));
  try {
    const res = await axios.get(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,
      { headers: HEADERS, timeout: 10000 }
    );
    const d = res.data;

    // disambiguation（曖昧さ回避ページ）は除外
    if (d.type === 'disambiguation') {
      return { ok: false, error: `${nameEn} は曖昧さ回避ページです` };
    }

    return {
      ok:          true,
      title:       d.title        || nameEn,
      description: d.description  || '',
      extract:     d.extract      || '',
      thumbnail:   d.thumbnail?.source || null,
      url:         d.content_urls?.desktop?.page || '',
      type:        d.type,
    };
  } catch (e) {
    if (e.response?.status === 404) return { ok: false, error: `Wikipedia に "${nameEn}" が見つかりません` };
    return { ok: false, error: e.message };
  }
}

// MediaWiki Search API で検索 → 上位ヒットのタイトルリストを返す
async function searchWikipediaTitles(query, limit = 3) {
  try {
    const res = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action:   'query',
        list:     'search',
        srsearch: query,
        srlimit:  limit,
        format:   'json',
        origin:   '*',
      },
      headers: HEADERS,
      timeout: 10000,
    });
    return (res.data?.query?.search || []).map(r => r.title);
  } catch (e) {
    return [];
  }
}

// 複数の候補名でフォールバック検索（最初に成功したものを返す）
// ① 各candidateを直接検索
// ② 全て失敗した場合、最初のcandidateでSearch APIを叩いてヒットしたタイトルを試す
async function fetchWikipediaSafe(candidates) {
  const names = Array.isArray(candidates) ? candidates : [candidates];

  // ── ① 直接タイトル検索 ───────────────────────────────────────────────────
  for (const name of names) {
    if (!name) continue;
    const r = await fetchWikipedia(name);
    if (r.ok && r.extract && r.extract.length > 50) return r;
  }

  // ── ② Search API フォールバック ──────────────────────────────────────────
  // 最初の有効な候補でSearch APIを使い、ヒットしたタイトルをさらに試す
  const primaryQuery = names.find(n => n) || '';
  if (primaryQuery) {
    const searchTitles = await searchWikipediaTitles(primaryQuery);
    for (const title of searchTitles) {
      const r = await fetchWikipedia(title);
      if (r.ok && r.extract && r.extract.length > 50) {
        console.log(`[wikipedia] Search fallback hit: "${primaryQuery}" → "${title}"`);
        return r;
      }
    }
  }

  return { ok: false, error: `取得できませんでした: ${names.join(', ')}` };
}

// ═══════════════════════════════════════════════════════════════
// セクション・wikitext 取得（来歴 / トロフィー履歴 抽出用）
// ═══════════════════════════════════════════════════════════════

// 生 wikitext を取得（infobox や セクションを構造化抽出するための原文）
async function fetchWikipediaWikitext(title) {
  if (!title) return { ok: false, error: 'title未指定' };
  const t = title.trim().replace(/ /g, '_');
  try {
    const res = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'parse',
        page:   t,
        prop:   'wikitext',
        format: 'json',
        origin: '*',
        redirects: 1,
      },
      headers: HEADERS,
      timeout: 12000,
    });
    const wt = res.data?.parse?.wikitext?.['*'];
    if (!wt) return { ok: false, error: 'wikitext取得失敗' };
    return {
      ok:       true,
      title:    res.data?.parse?.title || title,
      wikitext: wt,
    };
  } catch (e) {
    if (e.response?.status === 404) return { ok: false, error: `Wikipedia "${title}" 不在` };
    return { ok: false, error: e.message };
  }
}

// セクション一覧を取得（[{ index, line, level }, ...]）
async function fetchWikipediaSections(title) {
  if (!title) return { ok: false, error: 'title未指定' };
  const t = title.trim().replace(/ /g, '_');
  try {
    const res = await axios.get('https://en.wikipedia.org/w/api.php', {
      params: {
        action: 'parse',
        page:   t,
        prop:   'sections',
        format: 'json',
        origin: '*',
        redirects: 1,
      },
      headers: HEADERS,
      timeout: 10000,
    });
    return {
      ok:       true,
      title:    res.data?.parse?.title || title,
      sections: res.data?.parse?.sections || [],
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── wikitext ヘルパー ────────────────────────────────────────
// [[Page Name|表示名]] → 表示名 / [[Page Name]] → Page Name
function stripWikilinks(s) {
  return String(s || '')
    .replace(/<ref[^>]*\/>/g, '')                      // self-closing ref
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')         // <ref>...</ref>
    .replace(/<!--[\s\S]*?-->/g, '')                   // HTML コメント
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, '$2')     // [[A|B]] → B
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                // [[A]] → A
    .replace(/'{2,}/g, '')                              // bold/italic
    .replace(/\{\{[^}]+\}\}/g, '')                     // {{template}} 簡易除去
    .replace(/<[^>]+>/g, '')                            // 残った HTML tag
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// "2017–2019" / "2017-2019" / "2017–" → { start, end }
function parseYearRange(s) {
  const cleaned = stripWikilinks(s).replace(/[–—]/g, '-');
  const m = cleaned.match(/(\d{4})\s*-\s*(\d{0,4})/);
  if (m) return { start: m[1], end: m[2] || null };
  const single = cleaned.match(/(\d{4})/);
  if (single) return { start: single[1], end: null };
  return { start: null, end: null };
}

// 選手 infobox から career データを抽出
//  | years1 = 2017–2019
//  | clubs1 = [[FC Salzburg|Salzburg]]
//  | caps1  = 28
//  | goals1 = 17
// → [{ index, years:{start,end}, club, caps, goals }, ...]
function extractCareerFromInfobox(wikitext) {
  if (!wikitext) return [];
  const career = {};
  const re = /\|\s*(years|clubs|caps|goals)(\d+)\s*=\s*(.+)/g;
  let m;
  while ((m = re.exec(wikitext)) !== null) {
    const field = m[1];
    const idx   = parseInt(m[2]);
    const value = stripWikilinks(m[3]);
    career[idx] = career[idx] || { index: idx };
    if (field === 'years') career[idx].years = parseYearRange(value);
    else if (field === 'clubs') career[idx].club = value;
    else if (field === 'caps') career[idx].caps = parseInt(value) || null;
    else if (field === 'goals') career[idx].goals = parseInt(value) || null;
  }
  return Object.values(career)
    .filter(c => c.years?.start && c.club)
    .sort((a, b) => a.index - b.index);
}

// 選手 infobox から代表チーム career を抽出（nationalyears系）
function extractNationalCareerFromInfobox(wikitext) {
  if (!wikitext) return [];
  const career = {};
  const re = /\|\s*(nationalyears|nationalteam|nationalcaps|nationalgoals)(\d+)\s*=\s*(.+)/g;
  let m;
  while ((m = re.exec(wikitext)) !== null) {
    const field = m[1];
    const idx   = parseInt(m[2]);
    const value = stripWikilinks(m[3]);
    career[idx] = career[idx] || { index: idx };
    if (field === 'nationalyears') career[idx].years = parseYearRange(value);
    else if (field === 'nationalteam') career[idx].team = value;
    else if (field === 'nationalcaps') career[idx].caps = parseInt(value) || null;
    else if (field === 'nationalgoals') career[idx].goals = parseInt(value) || null;
  }
  return Object.values(career)
    .filter(c => c.years?.start && c.team)
    .sort((a, b) => a.index - b.index);
}

// {{Football team honours table}} など、テンプレ形式の honours を抽出
//   | competition1 = European Cup / [[UEFA Champions League]]
//   | total1       = 6
//   | seasons1     = 1973-74, 1974-75, ...
// → [{ category: 'Honours', items: ['UEFA Champions League: 6 (1973-74, ...)'] }]
function extractHonoursTable(wikitext) {
  if (!wikitext) return [];
  // テーブルテンプレを全部拾う（複数あっても良い）
  const tableRe = /\{\{\s*Football team honours[\s\S]*?\n\}\}/gi;
  const matches = wikitext.match(tableRe) || [];
  if (!matches.length) return [];

  const items = [];
  for (const tbl of matches) {
    const rows = {};
    const fieldRe = /\|\s*(competition|total|seasons?)\s*(\d+)\s*=\s*([^\n|]*?)(?=\n|$|\|)/g;
    let m;
    while ((m = fieldRe.exec(tbl)) !== null) {
      const idx = parseInt(m[2], 10);
      rows[idx] = rows[idx] || {};
      const key = m[1].toLowerCase().replace(/^seasons$/, 'seasons');
      rows[idx][key] = stripWikilinks(m[3]).trim();
    }
    Object.values(rows)
      .filter(r => r.competition && (r.total || r.seasons))
      .forEach(r => {
        const total = r.total || (r.seasons ? (r.seasons.match(/,/g) || []).length + 1 : '');
        const seasonsBit = r.seasons ? ` (${r.seasons})` : '';
        items.push(`${r.competition}: ${total}${seasonsBit}`);
      });
  }
  return items.length ? [{ category: 'Honours', items }] : [];
}

// Honours セクションを抽出 → [{ category, items: [...] }, ...]
function extractHonoursSection(wikitext) {
  if (!wikitext) return [];
  // == Honours == セクションを抽出（次のレベル2セクションまで）
  const m = wikitext.match(/==\s*Honours?\s*==([\s\S]*?)(?=\n==[^=]|$)/i);
  if (!m) {
    // ページ内にセクションが無くても、テンプレ形式があれば拾う
    return extractHonoursTable(wikitext);
  }
  const body = m[1];

  // サブセクション：=== カテゴリ === 以下の * リスト
  const result = [];
  const subRe = /===\s*([^=]+?)\s*===([\s\S]*?)(?=\n===|\n==[^=]|$)/g;
  let sub;
  while ((sub = subRe.exec(body)) !== null) {
    const category = stripWikilinks(sub[1]).trim();
    const items = sub[2].split('\n')
      .map(line => line.match(/^\s*\*\s*(.+)/))
      .filter(Boolean)
      .map(x => stripWikilinks(x[1]));
    if (items.length) result.push({ category, items });
  }
  // サブセクション無い場合：直下の * リスト
  if (!result.length) {
    const items = body.split('\n')
      .map(line => line.match(/^\s*\*\s*(.+)/))
      .filter(Boolean)
      .map(x => stripWikilinks(x[1]));
    if (items.length) result.push({ category: 'Honours', items });
  }
  // それでも空（テンプレ形式のみ使われている記事）→ テンプレを拾う
  if (!result.length) {
    const fromTable = extractHonoursTable(body);
    if (fromTable.length) return fromTable;
    // セクション内じゃなく全文も試す（記事末尾にある場合あり）
    return extractHonoursTable(wikitext);
  }
  return result;
}

// ── 選手の career events を組み立て（history テンプレ用） ──
// 戻り値: [{ year, title, description }]
async function fetchPlayerCareerEvents(name) {
  const wt = await fetchWikipediaWikitext(name);
  if (!wt.ok) return { ok: false, error: wt.error };
  const career    = extractCareerFromInfobox(wt.wikitext);
  const national  = extractNationalCareerFromInfobox(wt.wikitext);
  const events = [];

  career.forEach(c => {
    const yr = c.years.start;
    let desc = '';
    if (c.caps != null && c.goals != null) desc = `${c.caps}試合 ${c.goals}得点`;
    else if (c.caps != null) desc = `${c.caps}試合`;
    else if (c.goals != null) desc = `${c.goals}得点`;
    events.push({
      year:        yr,
      title:       `${c.club} 加入`,
      description: desc + (c.years.end ? ` (〜${c.years.end})` : ' (現在)'),
    });
  });

  national.forEach(n => {
    events.push({
      year:        n.years.start,
      title:       `${n.team} 招集`,
      description: (n.caps != null ? `${n.caps}試合 ` : '') + (n.goals != null ? `${n.goals}得点` : '') || '代表入り',
    });
  });

  events.sort((a, b) => parseInt(a.year || 0) - parseInt(b.year || 0));
  return { ok: true, title: wt.title, events };
}

// ── チームの honours events 組み立て（history テンプレ用） ──
async function fetchTeamHonoursEvents(name) {
  const wt = await fetchWikipediaWikitext(name);
  if (!wt.ok) return { ok: false, error: wt.error };
  const honours = extractHonoursSection(wt.wikitext);
  // honours: [{ category: 'Domestic', items: ['La Liga: 36 (...)', ...] }]
  // events 形式に簡易変換（年度を頭に出す）
  const events = [];
  honours.forEach(h => {
    h.items.forEach(item => {
      const yearM = item.match(/(\d{4})/);
      events.push({
        year:        yearM ? yearM[1] : '-',
        title:       item.split(':')[0].trim() || h.category,
        description: item,
      });
    });
  });
  events.sort((a, b) => parseInt(a.year || 0) - parseInt(b.year || 0));
  return { ok: true, title: wt.title, events };
}

module.exports = {
  fetchWikipedia,
  fetchWikipediaSafe,
  searchWikipediaTitles,
  fetchWikipediaWikitext,
  fetchWikipediaSections,
  extractCareerFromInfobox,
  extractNationalCareerFromInfobox,
  extractHonoursSection,
  extractHonoursTable,
  fetchPlayerCareerEvents,
  fetchTeamHonoursEvents,
  stripWikilinks,
  parseYearRange,
};
