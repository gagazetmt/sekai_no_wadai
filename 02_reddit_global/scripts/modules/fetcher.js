// scripts/modules/fetcher.js
// v2 モジュールデータ取得オーケストレーター
// モジュールIDに応じて適切なフェッチャーを呼び出す

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const { fetchWikipediaSafe }         = require('./fetchers/wikipedia');
const { fetchSofaScorePlayer }       = require('./fetchers/sofascore_player');
const { fetchSofaScoreMatch, fetchSofaScoreH2H } = require('./fetchers/sofascore_match');
const { fetchSofaScoreTeam }         = require('./fetchers/sofascore_team');
const { fetchSofaScoreManager }      = require('./fetchers/sofascore_manager');
const { fetchSerper, fetchSerperBilingual } = require('./fetchers/serper_module');
const { enrichSerperWithArticles }   = require('./fetchers/article_fetcher');
const { callAI }                     = require('../ai_client');

// Serper検索 + 記事本文取得をセットで行うヘルパー
// tbs: 'qdr:d'=24h, 'qdr:w'=1週間, 'qdr:m'=1ヶ月（日付フィルター）
async function serperWithArticles(query, moduleId, lang, tbs = null) {
  const result = await fetchSerper(query, moduleId, lang, tbs);
  return await enrichSerperWithArticles(result);
}

// ── 既存コンテンツから抽出（追加APIコール不要） ──────────────────────────────
function extractFromPost(moduleId, post) {
  if (moduleId === 'news_overview') {
    return {
      ok:     true,
      text:   post.overviewNarration || '',
      source: 'existing',
    };
  }
  if (moduleId === 'reddit_reaction') {
    const postSrc = post.source || 'reddit';   // 'reddit' | '5ch' | 'rss'
    // post.comments（Reddit/5ch候補から取得済み）
    const postCmts = (post.comments || []).map(c => ({
      text:   (typeof c === 'string' ? c : (c.body || c.text || '')).slice(0, 300),
      source: postSrc === '5ch' ? '5ch' : 'reddit',
      score:  typeof c === 'object' ? (c.score ?? c.ups ?? null) : null,
    }));
    // V1互換：_rawComments.reddit / .x
    const legacyReddit = (post._rawComments?.reddit || []).map(c => ({
      text:   (typeof c === 'string' ? c : (c.text || '')).slice(0, 300),
      source: 'reddit',
      score:  typeof c === 'object' ? (c.score ?? c.ups ?? null) : null,
    }));
    const legacyX = (post._rawComments?.x || []).map(c => ({
      text:   (typeof c === 'string' ? c : (c.text || '')).slice(0, 300),
      source: 'x',
      score:  typeof c === 'object' ? (c.score ?? null) : null,
    }));
    const comments = [...postCmts, ...legacyReddit, ...legacyX].filter(c => c.text.trim().length > 5);
    return { ok: true, comments, source: 'existing' };
  }
  return { ok: true, source: 'existing' };
}

// ── 1モジュールのデータ取得 ──────────────────────────────────────────────────
async function fetchModuleData(module, post) {
  const { id } = module;
  // paramsが空のときpostメタ情報でフォールバック補完
  const rawParams = module.params || {};
  const meta = post?._meta || {};
  const params = {
    // postメタをベースにし、rawParamsの実値で上書き
    playerNameEn:    meta.playerNameEn    || null,
    clubNameEn:      meta.clubNameEn      || null,
    clubName:        meta.clubNameEn      || null,
    homeTeam:        meta.homeTeam        || null,
    awayTeam:        meta.awayTeam        || null,
    team1NameEn:     meta.homeTeam        || null,
    team2NameEn:     meta.awayTeam        || null,
    searchQuery:     module.searchQuery   || null,
    ...rawParams,    // proposerが設定した値で上書き（存在する場合のみ）
  };
  // Claudeが返す代替キー名を正規キーに統一
  if (!params.playerNameEn && params.playerName) params.playerNameEn = params.playerName;
  if (!params.team1NameEn  && params.teamA)      params.team1NameEn  = params.teamA;
  if (!params.team2NameEn  && params.teamB)      params.team2NameEn  = params.teamB;
  if (!params.homeTeam && params.team1NameEn)    params.homeTeam     = params.team1NameEn;
  if (!params.awayTeam && params.team2NameEn)    params.awayTeam     = params.team2NameEn;

  // null値を除去
  Object.keys(params).forEach(k => { if (!params[k]) delete params[k]; });

  const userSource = module.dataSource && module.dataSource !== 'auto' ? module.dataSource : null;
  const userQuery  = module.searchQuery || '';

  // ── モジュールのカテゴリー判定（紐付け厳格化のため） ────────────────
  const { getCategory } = require('../stat_presets');
  const category = getCategory(id); // 'player', 'team', 'match', 'manager' etc.

  // ── ユーザー指定ソースがある場合は switch より先に処理 ──────────────────
  if (userSource) {
    try {
      if (userSource === 'wikipedia') {
        const candidates = userQuery
          ? [userQuery, params.playerNameEn, params.clubNameEn].filter(Boolean)
          : [params.playerNameEn || params.clubNameEn || params.searchQuery || id].filter(Boolean);
        return await fetchWikipediaSafe(candidates);
      }
      if (userSource === 'sofascore') {
        // カテゴリーに合わせてターゲットを厳選
        let target = '';
        if (category === 'player') {
          target = params.playerNameEn || userQuery;
        } else if (category === 'team') {
          target = params.clubName || params.clubNameEn || userQuery;
        } else if (category === 'match') {
          // 試合系なのに単一ターゲット検索に来た場合は、homeTeamを優先
          target = params.homeTeam || params.clubNameEn || userQuery;
        } else {
          target = params.playerNameEn || params.clubName || userQuery;
        }

        const finalTarget = (target || '').split(/[,、]/)[0].trim();
        if (!finalTarget) return { ok: false, error: `SofaScore: ${category}名が必要です` };

        // カテゴリーが明確な場合はそのフェッチャーを優先
        if (category === 'player') {
          const res = await fetchSofaScorePlayer(finalTarget);
          if (res.ok) return res;
        } else if (category === 'team') {
          const res = await fetchSofaScoreTeam(finalTarget);
          if (res.ok) return res;
        } else if (category === 'manager') {
          const res = await fetchSofaScoreManager(finalTarget);
          if (res.ok) return res;
        }

        // フォールバック（従来通り順に試す）
        const playerRes = await fetchSofaScorePlayer(finalTarget);
        if (playerRes.ok) return playerRes;
        const teamRes = await fetchSofaScoreTeam(finalTarget);
        if (teamRes.ok) return teamRes;
        const mgrRes = await fetchSofaScoreManager(finalTarget);
        if (mgrRes.ok) return mgrRes;
        return { ok: false, error: `SofaScore に "${finalTarget}" が見つかりません` };
      }
      if (userSource === 'news') {
        const q = userQuery || params.searchQuery || params.playerNameEn || params.clubNameEn || '';
        if (!q) return { ok: false, error: 'ニュース検索: 参考ワードを入力してください' };
        return await serperWithArticles(q, id, 'en', 'qdr:d3');
      }
      if (userSource === 'url') {
        const { fetchArticleContent } = require('./fetchers/article_fetcher');
        const url = module.sourceUrl || '';
        if (!url) return { ok: false, error: 'URL入力: URLを入力してください' };
        const art = await fetchArticleContent(url);
        // Serper organic 形式に揃えてシナリオ生成側で統一的に扱えるようにする
        return {
          ok:             art.ok,
          organic:        art.ok ? [{ title: url, snippet: art.content?.slice(0, 200) || '', link: url }] : [],
          articleContent: art.ok ? art.content : null,
          error:          art.error,
        };
      }
    } catch (e) {
      return { ok: false, error: `[${userSource}] ${e.message}` };
    }
  }

  try {
    switch (id) {

      // ── 既存コンテンツ（追加フェッチなし） ──────────────────────────
      case 'opening':
      case 'ending':
      case 'news_overview':
      case 'reddit_reaction':
        return extractFromPost(id, post);

      // ── Wikipedia（失敗時はSerperフォールバック） ────────────────
      case 'player_profile':
      case 'player_career': {
        const wikiRes = await fetchWikipediaSafe([
          params.playerNameEn,
          `${params.playerNameEn} footballer`,
          `${params.playerNameEn} soccer`,
        ]);
        if (wikiRes.ok) return wikiRes;
        // Serperフォールバック（Wikipedia不在・日本語名失敗など）
        console.log(`[fetcher] Wikipedia失敗 → Serperフォールバック: ${params.playerNameEn}`);
        const fallback = await fetchSerper(
          `${params.playerNameEn} footballer profile career stats nationality`,
          id
        );
        return {
          ok:      fallback.organic?.length > 0,
          source:  'serper_fallback',
          playerNameEn: params.playerNameEn,
          summary: (fallback.organic || []).slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n'),
        };
      }

      case 'club_history': {
        const wikiRes = await fetchWikipediaSafe([
          params.clubNameEn,
          `${params.clubNameEn} F.C.`,
          `${params.clubNameEn} football club`,
        ]);
        if (wikiRes.ok) return wikiRes;
        // Serperフォールバック
        console.log(`[fetcher] Wikipedia失敗 → Serperフォールバック: ${params.clubNameEn}`);
        const fallback = await fetchSerper(
          `${params.clubNameEn} football club history founded titles`,
          id
        );
        return {
          ok:         fallback.organic?.length > 0,
          source:     'serper_fallback',
          clubNameEn: params.clubNameEn,
          summary:    (fallback.organic || []).slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join('\n'),
        };
      }

      // ── Wikipedia + Serper 組み合わせ ─────────────────────────────
      case 'club_legends': {
        const wiki   = await fetchWikipediaSafe([params.clubNameEn, `${params.clubNameEn} F.C.`]);
        const serper = await serperWithArticles(
          `${params.clubNameEn} greatest players legends golden era history`, id
        );
        return { ok: true, wiki, serper };
      }

      case 'club_rival_history': {
        const wiki   = await fetchWikipediaSafe([
          `${params.clubNameEn} vs ${params.rivalClubNameEn}`,
          `${params.clubNameEn}`,
        ]);
        const serper = await serperWithArticles(
          `${params.clubNameEn} ${params.rivalClubNameEn} rivalry history classic derby`, id
        );
        return { ok: true, wiki, serper };
      }

      case 'historical_record': {
        const wiki   = await fetchWikipediaSafe([params.searchQuery]).catch(() => ({ ok: false }));
        const serper = await serperWithArticles(params.searchQuery || '', id);
        return { ok: true, wiki, serper };
      }

      // ── SofaScore ────────────────────────────────────────────────
      case 'player_season_stats': {
        // カンマ区切りで複数名が入ってきた場合は最初の1人だけ使う
        const singleName = (params.playerNameEn || '').split(/[,、]/)[0].trim();
        if (!singleName) return { ok: false, error: '選手名が未指定' };
        return await fetchSofaScorePlayer(singleName);
      }

      // ── Serper + 記事本文 ─────────────────────────────────────────
      case 'domestic_reaction':
        return await serperWithArticles(params.searchQuery || '', id, 'ja');

      case 'transfer_rumor':
        return await serperWithArticles(
          `${params.playerNameEn} transfer rumor latest 2025 2026`, id, 'en', 'qdr:m'
        );

      case 'player_episode':
        return await serperWithArticles(
          `${params.playerNameEn} ${params.episodeKeyword || 'famous moment story'}`, id
        );

      case 'injury_report':
        return await serperWithArticles(
          `${params.playerNameEn} injury latest update return`, id, 'en', 'qdr:m'
        );

      case 'club_current_season':
      case 'club_profile': {
        // SofaScore でチーム情報取得（失敗時はSerperフォールバック）
        const teamRes = await fetchSofaScoreTeam(params.clubName || params.clubNameEn);
        if (teamRes.ok) return teamRes;
        console.log(`[fetcher] SofaScore team失敗 → Serperフォールバック: ${teamRes.error}`);
        return await serperWithArticles(
          `${params.clubName || params.clubNameEn} football club current season results standings 2026`, id, 'en', 'qdr:m'
        );
      }

      case 'manager_profile': {
        const mgrName = params.managerName || params.clubNameEn;
        if (!mgrName) return { ok: false, error: '監督名またはチーム名が必要です' };
        const mgrRes = await fetchSofaScoreManager(mgrName);
        if (mgrRes.ok) return mgrRes;
        return await serperWithArticles(
          `${mgrName} manager profile career stats record`, id, 'en', 'qdr:m'
        );
      }

      case 'club_key_players':
        return await serperWithArticles(
          `${params.clubNameEn} key players best performers season 2025 2026`, id, 'en', 'qdr:m'
        );

      case 'next_match_preview':
        return await serperWithArticles(
          params.searchQuery || `${params.clubName} next match fixture preview 2026`, id, 'en', 'qdr:w'
        );

      case 'match_key_moment': {
        // SofaScore で試合イベント取得（失敗時はSerperフォールバック）
        const matchRes = await fetchSofaScoreMatch(params.homeTeam, params.awayTeam);
        if (matchRes.ok) return matchRes;
        console.log(`[fetcher] SofaScore match失敗 → Serperフォールバック: ${matchRes.error}`);
        return await serperWithArticles(
          params.searchQuery || `${params.homeTeam} ${params.awayTeam} goal highlights`, id, 'en', 'qdr:d3'
        );
      }

      case 'match_stats':
      case 'formation_board': {
        // SofaScore で試合データ取得（失敗時はSerperフォールバック）
        const matchRes = await fetchSofaScoreMatch(params.homeTeam, params.awayTeam);
        if (matchRes.ok) return matchRes;
        console.log(`[fetcher] SofaScore match失敗 → Serperフォールバック: ${matchRes.error}`);
        return await serperWithArticles(
          `${params.homeTeam} vs ${params.awayTeam} match stats lineups 2026`, id, 'en', 'qdr:w'
        );
      }

      case 'head_to_head': {
        // SofaScore でH2H（通算成績＋過去対戦リスト）を取得
        const t1 = params.team1NameEn || params.homeTeam;
        const t2 = params.team2NameEn || params.awayTeam;
        const h2hRes = await fetchSofaScoreH2H(t1, t2);
        if (h2hRes.ok) return { ...h2hRes, summary: h2hRes.summaryText };
        // フォールバック：Serper
        console.log(`[fetcher] H2H SofaScore失敗 → Serperフォールバック: ${h2hRes.error}`);
        return await serperWithArticles(
          `${t1} vs ${t2} head to head history all time record results`, id
        );
      }

      case 'tactical_analysis': {
        // 監督情報をSofaScoreから取得（失敗時はSerperフォールバック）
        const mgrName = params.managerName || params.clubNameEn;
        if (mgrName) {
          const mgrRes = await fetchSofaScoreManager(mgrName);
          if (mgrRes.ok) {
            // チーム情報も合わせて取得
            const teamRes = await fetchSofaScoreTeam(params.clubNameEn || mgrName).catch(() => ({ ok: false }));
            return { ok: true, manager: mgrRes, team: teamRes.ok ? teamRes : null };
          }
        }
        return await serperWithArticles(
          params.searchQuery || `${params.clubNameEn} tactics formation analysis 2026`, id, 'en', 'qdr:m'
        );
      }

      case 'season_standings': {
        // SofaScore でチーム順位取得（クラブ名があれば）
        const clubForStandings = params.clubName || params.clubNameEn;
        if (clubForStandings) {
          const teamRes = await fetchSofaScoreTeam(clubForStandings);
          if (teamRes.ok) return teamRes;
        }
        return await serperWithArticles(
          `${params.leagueName} standings table 2025 2026 season`, id
        );
      }

      // ── カスタム調査（ユーザー指定テーマ） ───────────────────────────
      case 'custom_research': {
        const userQuery = params.customQuery || '';
        if (!userQuery) return { ok: false, error: 'カスタムクエリが未指定' };

        // ① DeepSeekに最適な検索クエリ3つを生成させる
        let queries = [userQuery]; // フォールバック
        try {
          const planRaw = await callAI({
            model:      'deepseek-v4-flash',
            max_tokens: 400,
            messages:   [{ role: 'user', content:
              `サッカーYouTube動画のリサーチです。
以下のテーマについて、Google検索で最も具体的な情報が得られる検索クエリを3つ生成してください。
テーマ: ${userQuery}

ルール:
- クエリは日本語・英語を混在させてOK
- できるだけ具体的に（年・大会名・数字・固有名詞を含める）
- 1つは日本語クエリ、1〜2つは英語クエリにする

JSONのみ: {"queries": ["クエリ1", "クエリ2", "クエリ3"]}`
            }],
            system: 'リサーチ専門家です。JSONのみ返します。',
          });
          const m = planRaw.match(/\{[\s\S]*?\}/);
          if (m) queries = JSON.parse(m[0]).queries || queries;
        } catch (e) {
          console.warn(`[custom_research] クエリ生成失敗: ${e.message}`);
        }

        // ② 並列検索（記事本文取得込み）
        const searchResults = await Promise.all(
          queries.map(q => serperWithArticles(q, id))
        );

        // ③ 結果をまとめる
        const allItems = searchResults.flatMap((r, i) =>
          (r.organic || []).slice(0, 3).map(a => ({
            query:   queries[i],
            title:   a.title,
            snippet: a.snippet,
            link:    a.link,
          }))
        );

        // ④ 記事本文をまとめる（全クエリ分）
        const allArticles = searchResults
          .map(r => r.articleContent)
          .filter(Boolean)
          .join('\n\n===\n\n');

        return {
          ok:             allItems.length > 0,
          userQuery,
          queries,
          results:        allItems,
          summary:        allItems.map(r => `[${r.query}]\n  ${r.title}: ${r.snippet}`).join('\n'),
          articleContent: allArticles || null,
        };
      }

      case 'stats_comparison': {
        // チーム比較（homeTeam/awayTeam or team1NameEn/team2NameEn）
        const t1 = params.homeTeam || params.team1NameEn || params.teamA;
        const t2 = params.awayTeam || params.team2NameEn || params.teamB;
        if (t1 && t2) {
          const matchRes = await fetchSofaScoreMatch(t1, t2);
          if (matchRes.ok) return { ok: true, mode: 'team', match: matchRes };
          return await serperWithArticles(
            `${t1} vs ${t2} stats comparison possession shots xG`, id, 'en', 'qdr:w'
          );
        }
        // 選手比較（playerNameEn + subject2En）
        const p1 = (params.playerNameEn || params.subject1En || '').split(/[,、]/)[0].trim();
        const p2 = (params.subject2En   || '').split(/[,、]/)[0].trim();
        if (!p1 || !p2) return { ok: false, error: 'stats_comparison: homeTeam/awayTeam または playerNameEn/subject2En が必要です' };
        const [r1, r2] = await Promise.all([
          fetchSofaScorePlayer(p1),
          fetchSofaScorePlayer(p2),
        ]);
        return { ok: true, mode: 'player', player1: r1, player2: r2 };
      }

      default:
        return { ok: false, error: `未実装のモジュール: ${id}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── statsRows の value を Serper で補完 ──────────────────────────────────────
// statsRows: [{ label: "2022年カタール大会 放映権料" }, ...]
// → [{ label: "...", value: "Serperが見つけた情報" }, ...]
async function fillStatsRows(statsRows, contextQuery = '') {
  if (!statsRows?.length) return statsRows;

  const filled = await Promise.all(
    statsRows.map(async row => {
      if (row.value) return row; // すでに値があればスキップ
      try {
        const query = contextQuery ? `${contextQuery} ${row.label}` : row.label;
        const result = await fetchSerper(query, 'statsRows');
        // answerBox > knowledgeGraph > 最初のorganicのsnippet の順で取る
        const value =
          result.answerBox?.answer ||
          result.answerBox?.snippet ||
          result.knowledgeGraph?.description ||
          result.organic?.[0]?.snippet ||
          '（データ取得失敗）';
        return { label: row.label, value: value.slice(0, 120) };
      } catch (e) {
        return { label: row.label, value: '（データ取得失敗）' };
      }
    })
  );
  return filled;
}

// ── 複数モジュールを並列でフェッチ ───────────────────────────────────────────
async function fetchAllModuleData(modules, post) {
  const results = await Promise.all(
    modules.map(async mod => {
      const fetchedData = await fetchModuleData(mod, post);
      // type1/type2 の statsRows を Serper で補完
      let statsRows = mod.statsRows || null;
      if (statsRows?.length && ['type1', 'type2', 'type3', 'type4'].includes(mod.slideType)) {
        const contextQuery = mod.params?.customQuery || mod.params?.searchQuery || mod.label || '';
        statsRows = await fillStatsRows(statsRows, contextQuery);
      }
      return { ...mod, fetchedData, ...(statsRows ? { statsRows } : {}) };
    })
  );
  return results;
}

module.exports = { fetchModuleData, fetchAllModuleData, fillStatsRows };
