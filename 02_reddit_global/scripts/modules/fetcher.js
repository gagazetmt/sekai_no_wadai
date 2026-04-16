// scripts/modules/fetcher.js
// v2 モジュールデータ取得オーケストレーター
// モジュールIDに応じて適切なフェッチャーを呼び出す

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const { fetchWikipediaSafe }         = require('./fetchers/wikipedia');
const { fetchSofaScorePlayer }       = require('./fetchers/sofascore_player');
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
    // reddit / X / slide3 から海外コメントを収集
    const reddit  = (post._rawComments?.reddit || []).map(c => typeof c === 'string' ? c : c.text || '');
    const xCmts   = (post._rawComments?.x || []).map(c => typeof c === 'string' ? c : c.text || '');
    const s3Cmts  = (post.slide3?.comments || []).map(c => c.text || '');
    const s4Cmts  = (post.slide4?.comments || []).map(c => c.text || '');
    const comments = [...reddit, ...xCmts, ...s3Cmts, ...s4Cmts].filter(Boolean);
    return {
      ok:       true,
      comments,
      source:   'existing',
    };
  }
  return { ok: true, source: 'existing' };
}

// ── 1モジュールのデータ取得 ──────────────────────────────────────────────────
async function fetchModuleData(module, post) {
  const { id, params = {} } = module;

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
      case 'player_season_stats':
        return await fetchSofaScorePlayer(params.playerNameEn);

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
        return await serperWithArticles(
          `${params.clubName} current season results standings 2025 2026`, id
        );

      case 'club_key_players':
        return await serperWithArticles(
          `${params.clubNameEn} key players best performers season 2025 2026`, id
        );

      case 'next_match_preview':
        return await serperWithArticles(
          params.searchQuery || `${params.clubName} next match fixture preview`, id
        );

      case 'match_key_moment':
        return await serperWithArticles(
          params.searchQuery || `${params.homeTeam} ${params.awayTeam} goal highlights`, id
        );

      case 'stats_comparison':
        return await serperWithArticles(
          `${params.subject1En} vs ${params.subject2En} stats comparison 2025 2026`, id
        );

      case 'tactical_analysis':
        return await serperWithArticles(
          params.searchQuery || `${params.clubNameEn} tactics formation analysis 2026`, id
        );

      case 'match_stats':
      case 'formation_board':
        return await serperWithArticles(
          `${params.homeTeam} vs ${params.awayTeam} match stats lineups 2026`, id
        );

      case 'head_to_head':
        return await serperWithArticles(
          `${params.team1NameEn} vs ${params.team2NameEn} head to head history results`, id
        );

      case 'season_standings':
        return await serperWithArticles(
          `${params.leagueName} standings table 2025 2026 season`, id
        );

      // ── カスタム調査（ユーザー指定テーマ） ───────────────────────────
      case 'custom_research': {
        const userQuery = params.customQuery || '';
        if (!userQuery) return { ok: false, error: 'カスタムクエリが未指定' };

        // ① DeepSeekに最適な検索クエリ3つを生成させる
        let queries = [userQuery]; // フォールバック
        try {
          const planRaw = await callAI({
            model:      'deepseek-chat',
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
      if (statsRows?.length && (mod.slideType === 'type1' || mod.slideType === 'type2')) {
        const contextQuery = mod.params?.customQuery || mod.params?.searchQuery || mod.label || '';
        statsRows = await fillStatsRows(statsRows, contextQuery);
      }
      return { ...mod, fetchedData, ...(statsRows ? { statsRows } : {}) };
    })
  );
  return results;
}

module.exports = { fetchModuleData, fetchAllModuleData, fillStatsRows };
