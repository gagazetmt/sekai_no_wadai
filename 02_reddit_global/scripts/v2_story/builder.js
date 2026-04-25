// scripts/v2_story/builder.js
// ═══════════════════════════════════════════════════════════════
// レシピを使って binding からモジュール本体を組み立てるビルダー
// ═══════════════════════════════════════════════════════════════
//
// 使い方：
//   const { buildModuleFromBinding } = require('./builder');
//   const mod = await buildModuleFromBinding(binding, { siData, post });
//
// binding:
//   { subject, aspect, primary, secondary? }
//
// 戻り値（部分モジュール）：
//   { type, binding, siBinding[, siBindingLeft, siBindingRight],
//     dataSlots? / matchData? / catchphrases? / comments?,
//     [homeTeam, awayTeam, homeScore, awayScore など補助フィールド] }
//
// ═══════════════════════════════════════════════════════════════

const {
  RECIPES,
  getRecipe,
  findEntity,
  buildDataSlotsFromRecipe,
} = require('./recipes');

// ─── matchcenter 用 matchData の組み立て ──────────────────────
// sofa.match の生データ → matchcenter テンプレが期待する形へ
function buildMatchData(matchEntity) {
  if (!matchEntity) return null;
  // SofaScore の stats は [{ name, home, away }, ...] 形式
  // matchcenter テンプレは flat { 'Ball possession': '52% / 48%', ... } を期待
  const flatStats = {};
  if (Array.isArray(matchEntity.stats)) {
    matchEntity.stats.forEach(s => {
      if (s?.name) {
        const home = s.home != null ? s.home : '-';
        const away = s.away != null ? s.away : '-';
        flatStats[s.name] = `${home} / ${away}`;
      }
    });
  }
  return {
    homeTeam:   matchEntity.homeTeam,
    awayTeam:   matchEntity.awayTeam,
    homeScore:  matchEntity.homeScore,
    awayScore:  matchEntity.awayScore,
    tournament: matchEntity.tournament,
    matchDate:  matchEntity.matchDate,
    venue:      matchEntity.venue,
    goals:      Array.isArray(matchEntity.goals) ? matchEntity.goals : [],
    stats:      flatStats,
    topPlayers: Array.isArray(matchEntity.topPlayers) ? matchEntity.topPlayers : [],
  };
}

// ─── Wiki career events → history テンプレ用 dataSlots へ変換 ─
// events: [{ year, title, description }]
// → dataSlots: [{ label: year, value: title }]
//   description は catchphrases に並列で格納（narration生成時に活用）
function eventsToHistoryShape(events, max = 5) {
  if (!Array.isArray(events) || !events.length) return { dataSlots: [], catchphrases: [] };
  const trimmed = events.slice(-max);  // 直近 max 件（時系列の最新側）
  return {
    dataSlots:    trimmed.map(e => ({ label: e.year || '-', value: e.title || '' })),
    catchphrases: trimmed.map(e => e.description || ''),
  };
}

// ─── 試合の home/away 判別（team.matchStats 用） ─────────────
function detectMatchSide(matchEntity, teamLabel) {
  if (!matchEntity || !teamLabel) return 'home';
  const home = (matchEntity.homeTeam || '').toLowerCase();
  const away = (matchEntity.awayTeam || '').toLowerCase();
  const tl   = teamLabel.toLowerCase();
  if (home && (home.includes(tl) || tl.includes(home))) return 'home';
  if (away && (away.includes(tl) || tl.includes(away))) return 'away';
  return 'home';
}

// ─── siData の sofa.match 群から、両チームを含む match を探す ─
function findMatchBetweenTeams(siData, teamA, teamB) {
  if (!siData?.boxes?.sofascore_match?.fetched || !teamA || !teamB) return null;
  const a = teamA.toLowerCase();
  const b = teamB.toLowerCase();
  for (const f of siData.boxes.sofascore_match.fetched) {
    const d = f.data;
    if (!d) continue;
    const ht = (d.homeTeam || '').toLowerCase();
    const at = (d.awayTeam || '').toLowerCase();
    const aMatchH = ht.includes(a) || a.includes(ht);
    const aMatchA = at.includes(a) || a.includes(at);
    const bMatchH = ht.includes(b) || b.includes(ht);
    const bMatchA = at.includes(b) || b.includes(at);
    if ((aMatchH && bMatchA) || (aMatchA && bMatchH)) return d;
  }
  // フォールバック：先頭の match を返す（h2hMatches が両チームを含む可能性）
  const first = siData.boxes.sofascore_match.fetched[0]?.data;
  if (first?.h2hMatches?.length) return first;
  return null;
}

// ─── メイン：binding から モジュール部分構造を作る ───────────
async function buildModuleFromBinding(binding, ctx = {}) {
  if (!binding?.subject || !binding?.aspect) {
    return { ok: false, error: 'binding.subject と binding.aspect が必須' };
  }

  const recipe = getRecipe(binding.subject, binding.aspect);
  if (!recipe) {
    return { ok: false, error: `レシピ "${binding.subject}.${binding.aspect}" が未定義` };
  }

  const siData = ctx.siData || {};
  const out = {
    type:    recipe.template,
    binding: { ...binding },
  };

  // ── populates の種類で分岐 ──────────────────────────────
  if (recipe.populates === 'matchData') {
    // matchcenter 用：試合エンティティから matchData オブジェクトを構築
    const matchEntity = findEntity(siData, binding.subject, binding.primary);
    if (!matchEntity) {
      return { ok: false, error: `試合データ "${binding.primary}" が siData に無い` };
    }
    out.matchData  = buildMatchData(matchEntity);
    out.homeTeam   = matchEntity.homeTeam;
    out.awayTeam   = matchEntity.awayTeam;
    out.homeScore  = matchEntity.homeScore;
    out.awayScore  = matchEntity.awayScore;
    out.matchDate  = matchEntity.matchDate;
    out.siBinding  = binding.primary;
    return { ok: true, module: out };
  }

  if (recipe.populates === 'comments' || recipe.populates === 'catchphrases') {
    // reaction / insight 系：AI に埋めさせる前提で空配列をセット
    out[recipe.populates] = [];
    out.siBinding = binding.primary;
    if (binding.secondary) {
      out.siBindingLeft  = binding.primary;
      out.siBindingRight = binding.secondary;
    }
    return { ok: true, module: out };
  }

  if (recipe.populates === 'dataSlots') {

    // ── history shape：Wiki から career events を取得して変換 ──
    if (recipe.historyShape && recipe.needsWikiInfobox) {
      let events = [];
      try {
        if (binding.subject === 'player') {
          const { fetchPlayerCareerEvents } = require('../modules/fetchers/wikipedia');
          const r = await fetchPlayerCareerEvents(binding.primary);
          if (r.ok) events = r.events;
          else console.warn(`[builder] player.history Wiki取得失敗: ${r.error}`);
        } else if (binding.subject === 'team') {
          const { fetchTeamHonoursEvents } = require('../modules/fetchers/wikipedia');
          const r = await fetchTeamHonoursEvents(binding.primary);
          if (r.ok) events = r.events;
          else console.warn(`[builder] team.history Wiki取得失敗: ${r.error}`);
        }
      } catch (e) {
        console.warn('[builder] history取得例外:', e.message);
      }
      const shaped = eventsToHistoryShape(events, 5);
      out.dataSlots    = shaped.dataSlots;
      out.catchphrases = shaped.catchphrases;
      out.siBinding    = binding.primary;
      return { ok: true, module: out, eventsCount: events.length };
    }

    // ── 通常 dataSlots：レシピのプルダウンで構築 ──────────
    const primaryEntity   = findEntity(siData, binding.subject, binding.primary);
    const secondaryEntity = binding.secondary
      ? findEntity(siData, binding.subject, binding.secondary)
      : null;

    if (!primaryEntity) {
      return { ok: false, error: `エンティティ "${binding.primary}" (${binding.subject}) が siData に無い` };
    }

    // customSlotKeys 解決：binding 側 → ctx 側 → recipe.defaultSelection
    const selectedKeys = binding.customSlotKeys || ctx.customSlotKeys || recipe.defaultSelection;

    let ctxForExtract = {};

    // ── needsTeamH2H：team.h2h 用、両チームを含む match を探す ──
    if (recipe.needsTeamH2H) {
      if (!binding.secondary) {
        return { ok: false, error: 'team.h2h は secondary（対戦相手チーム）必須' };
      }
      const matchEntity = findMatchBetweenTeams(siData, binding.primary, binding.secondary);
      if (!matchEntity) {
        return { ok: false, error: `${binding.primary} vs ${binding.secondary} を含む試合データが siData に無い` };
      }
      // 左右で primaryTeam を入れ替えて extract
      out.dataSlots = selectedKeys.map(k => {
        const slot = recipe.availableSlots.find(s => s.key === k);
        if (!slot) return null;
        return {
          slotKey:    k,
          label:      slot.label,
          leftValue:  String(slot.extract(matchEntity, { primaryTeam: binding.primary })   ?? '-'),
          rightValue: String(slot.extract(matchEntity, { primaryTeam: binding.secondary }) ?? '-'),
        };
      }).filter(Boolean);
      out.siBindingLeft  = binding.primary;
      out.siBindingRight = binding.secondary;
      return { ok: true, module: out };
    }

    // ── needsMatchPreview：matchcard 型、homeTeam/awayTeam 自動セット ──
    if (recipe.needsMatchPreview) {
      // primaryEntity は match データ
      out.dataSlots = buildDataSlotsFromRecipe(recipe, primaryEntity, null, selectedKeys, {});
      out.homeTeam  = primaryEntity.homeTeam;
      out.awayTeam  = primaryEntity.awayTeam;
      out.matchDate = primaryEntity.matchDate;
      out.siBinding = binding.primary;
      return { ok: true, module: out };
    }

    // ── team.matchStats のような needsMatchSide ケース ───────
    if (recipe.needsMatchSide) {
      const matchEntities = siData?.boxes?.sofascore_match?.fetched || [];
      const matchEntity   = matchEntities[0]?.data;
      if (matchEntity) {
        ctxForExtract.side = detectMatchSide(matchEntity, binding.primary);
        out.dataSlots = buildDataSlotsFromRecipe(
          recipe, matchEntity, null,
          selectedKeys,
          ctxForExtract
        );
      } else {
        out.dataSlots = [];
      }
    } else {
      // 通常 dataSlots：レシピの extract で primary/secondary を直接評価
      out.dataSlots = buildDataSlotsFromRecipe(
        recipe, primaryEntity, secondaryEntity,
        selectedKeys,
        ctxForExtract
      );
    }

    if (binding.secondary) {
      out.siBindingLeft  = binding.primary;
      out.siBindingRight = binding.secondary;
    } else {
      out.siBinding = binding.primary;
    }
    return { ok: true, module: out };
  }

  return { ok: false, error: `未対応 populates: ${recipe.populates}` };
}

// ─── 旧モジュール（siBinding ベース）→ binding 推測 + 再構築 ─
// 既存ストーリーの後方互換用：bindingを推測し、レシピで再構築
async function rebuildLegacyModule(legacyMod, ctx = {}) {
  const { inferBindingFromLegacy } = require('./recipes');
  const binding = inferBindingFromLegacy(legacyMod, ctx.siData);
  const r = await buildModuleFromBinding(binding, ctx);
  if (!r.ok) return { ok: false, error: r.error, binding };
  // 旧モジュールの編集済みフィールド（title / scriptDir / narration 等）を保持
  return {
    ok: true,
    module: {
      ...legacyMod,         // タイトル等を保持
      ...r.module,          // 新フィールドで上書き（type, binding, dataSlots など）
      title:     legacyMod.title     || r.module.title,
      scriptDir: legacyMod.scriptDir || r.module.scriptDir,
      narration: legacyMod.narration || r.module.narration,
    },
    binding,
  };
}

// ─── 評価済みスロット一覧を作る（UI ドロップダウン用） ─────
// 全 availableSlots を評価して、UI が「ラベル：値」表示できるようにする
async function buildAllEvaluatedSlots(binding, ctx = {}) {
  const { getRecipe, findEntity } = require('./recipes');
  const recipe = getRecipe(binding.subject, binding.aspect);
  if (!recipe?.availableSlots?.length) return [];

  const siData = ctx.siData || {};

  // 特殊：team.h2h は両side同じ matchEntity を使い、primaryTeam を変えて評価
  if (recipe.needsTeamH2H) {
    const matchEntity = findMatchBetweenTeams(siData, binding.primary, binding.secondary);
    if (!matchEntity) return [];
    return recipe.availableSlots.map(slot => ({
      key:        slot.key,
      label:      slot.label,
      leftValue:  String(slot.extract(matchEntity, { primaryTeam: binding.primary })   ?? '-'),
      rightValue: String(slot.extract(matchEntity, { primaryTeam: binding.secondary }) ?? '-'),
    }));
  }

  // 特殊：matchPreview は primary が match
  if (recipe.needsMatchPreview) {
    const matchEntity = findEntity(siData, binding.subject, binding.primary);
    if (!matchEntity) return [];
    return recipe.availableSlots.map(slot => ({
      key:   slot.key,
      label: slot.label,
      value: String(slot.extract(matchEntity, {}) ?? '-'),
    }));
  }

  // 特殊：team.matchStats は match から home/away
  if (recipe.needsMatchSide) {
    const matchEntities = siData?.boxes?.sofascore_match?.fetched || [];
    const matchEntity   = matchEntities[0]?.data;
    if (!matchEntity) return [];
    const side = detectMatchSide(matchEntity, binding.primary);
    return recipe.availableSlots.map(slot => ({
      key:   slot.key,
      label: slot.label,
      value: String(slot.extract(matchEntity, { side }) ?? '-'),
    }));
  }

  // 通常：primary [+ secondary]
  const primaryEntity   = findEntity(siData, binding.subject, binding.primary);
  const secondaryEntity = binding.secondary ? findEntity(siData, binding.subject, binding.secondary) : null;
  if (!primaryEntity) return [];

  return recipe.availableSlots.map(slot => {
    if (recipe.requiresSecondary && secondaryEntity) {
      return {
        key:        slot.key,
        label:      slot.label,
        leftValue:  String(slot.extract(primaryEntity, {})   ?? '-'),
        rightValue: String(slot.extract(secondaryEntity, {}) ?? '-'),
      };
    }
    return {
      key:   slot.key,
      label: slot.label,
      value: String(slot.extract(primaryEntity, {}) ?? '-'),
    };
  });
}

module.exports = {
  buildModuleFromBinding,
  buildAllEvaluatedSlots,
  rebuildLegacyModule,
  buildMatchData,
  eventsToHistoryShape,
  detectMatchSide,
  findMatchBetweenTeams,
};
