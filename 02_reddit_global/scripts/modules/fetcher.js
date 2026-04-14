// scripts/modules/fetcher.js
// v2 モジュールデータ取得オーケストレーター
// モジュールIDに応じて適切なフェッチャーを呼び出す

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env'), quiet: true });
const { fetchWikipediaSafe }    = require('./fetchers/wikipedia');
const { fetchSofaScorePlayer }  = require('./fetchers/sofascore_player');
const { fetchSerper, fetchSerperBilingual } = require('./fetchers/serper_module');
const { callAI }                = require('../ai_client');

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
      case 'news_overview':
      case 'reddit_reaction':
        return extractFromPost(id, post);

      // ── Wikipedia ────────────────────────────────────────────────
      case 'player_profile':
      case 'player_career':
        return await fetchWikipediaSafe([
          params.playerNameEn,
          `${params.playerNameEn} footballer`,
          `${params.playerNameEn} soccer`,
        ]);

      case 'club_history':
        return await fetchWikipediaSafe([
          params.clubNameEn,
          `${params.clubNameEn} F.C.`,
          `${params.clubNameEn} football club`,
        ]);

      // ── Wikipedia + Serper 組み合わせ ─────────────────────────────
      case 'club_legends': {
        const wiki   = await fetchWikipediaSafe([params.clubNameEn, `${params.clubNameEn} F.C.`]);
        const serper = await fetchSerper(
          `${params.clubNameEn} greatest players legends golden era history`,
          id
        );
        return { ok: true, wiki, serper };
      }

      case 'club_rival_history': {
        const wiki   = await fetchWikipediaSafe([
          `${params.clubNameEn} vs ${params.rivalClubNameEn}`,
          `${params.clubNameEn}`,
        ]);
        const serper = await fetchSerper(
          `${params.clubNameEn} ${params.rivalClubNameEn} rivalry history classic derby`,
          id
        );
        return { ok: true, wiki, serper };
      }

      case 'historical_record': {
        const wiki   = await fetchWikipediaSafe([params.searchQuery]).catch(() => ({ ok: false }));
        const serper = await fetchSerper(params.searchQuery || '', id);
        return { ok: true, wiki, serper };
      }

      // ── SofaScore ────────────────────────────────────────────────
      case 'player_season_stats':
        return await fetchSofaScorePlayer(params.playerNameEn);

      // ── Serper のみ ───────────────────────────────────────────────
      case 'domestic_reaction':
        return await fetchSerper(params.searchQuery || '', id, 'ja');

      case 'transfer_rumor':
        return await fetchSerper(
          `${params.playerNameEn} transfer rumor latest 2025 2026`,
          id
        );

      case 'player_episode':
        return await fetchSerper(
          `${params.playerNameEn} ${params.episodeKeyword || 'famous moment story'}`,
          id
        );

      case 'injury_report':
        return await fetchSerper(
          `${params.playerNameEn} injury latest update return`,
          id
        );

      case 'club_current_season':
        return await fetchSerper(
          `${params.clubName} current season results standings 2025 2026`,
          id
        );

      case 'club_key_players':
        return await fetchSerper(
          `${params.clubNameEn} key players best performers season 2025 2026`,
          id
        );

      case 'next_match_preview':
        return await fetchSerper(
          params.searchQuery || `${params.clubName} next match fixture preview`,
          id
        );

      case 'match_key_moment':
        return await fetchSerper(
          params.searchQuery || `${params.homeTeam} ${params.awayTeam} goal highlights`,
          id
        );

      case 'stats_comparison':
        return await fetchSerper(
          `${params.subject1En} vs ${params.subject2En} stats comparison 2025 2026`,
          id
        );

      case 'tactical_analysis':
        return await fetchSerper(
          params.searchQuery || `${params.clubNameEn} tactics formation analysis 2026`,
          id
        );

      // ── SofaScore 試合系（今後詳細実装予定） ─────────────────────
      case 'match_stats':
      case 'formation_board':
        // TODO: fetch_match_center.js と連携して詳細データを取得
        return await fetchSerper(
          `${params.homeTeam} vs ${params.awayTeam} match stats lineups 2026`,
          id
        );

      case 'head_to_head':
        return await fetchSerper(
          `${params.team1NameEn} vs ${params.team2NameEn} head to head history results`,
          id
        );

      case 'season_standings':
        return await fetchSerper(
          `${params.leagueName} standings table 2025 2026 season`,
          id
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

        // ② 並列検索
        const searchResults = await Promise.all(
          queries.map(q => fetchSerper(q, id))
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

        return {
          ok:        allItems.length > 0,
          userQuery,
          queries,
          results:   allItems,
          summary:   allItems.map(r => `[${r.query}]\n  ${r.title}: ${r.snippet}`).join('\n'),
        };
      }

      default:
        return { ok: false, error: `未実装のモジュール: ${id}` };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 複数モジュールを並列でフェッチ ───────────────────────────────────────────
async function fetchAllModuleData(modules, post) {
  const results = await Promise.all(
    modules.map(async mod => {
      const fetchedData = await fetchModuleData(mod, post);
      return { ...mod, fetchedData };
    })
  );
  return results;
}

module.exports = { fetchModuleData, fetchAllModuleData };
