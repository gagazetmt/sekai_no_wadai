// scripts/v2_story/si_walker.js
// ═══════════════════════════════════════════════════════════════
// SI データ → 全プルダウン候補スロット列挙
// ═══════════════════════════════════════════════════════════════
//
// レシピ撤廃後の中核。entityData (binding_meta._findEntityData の出力)
// を受け取り、role に応じて該当する全 leaf を `{key, label, value,
// category, priority, source}` の配列として返す。
//
// 旧 recipes.js の availableSlots/extract を上限に持っていた構造と違い、
// 「si_data に値がある全フィールドを候補に」というスタンス。
// 「使える情報の数が勝手に狭まってる」を構造的に解消する。
//
// 公開 API:
//   walkEntity(entityData, role)            → slots[]
//   buildPairsForCompare(primary, secondary, role)  → [{key,label,leftValue,rightValue,category,priority}]
//
// slot:
//   { key:'overallWinRate', label:'通算勝率', value:'61.3%',
//     category:'通算成績', priority:10, source:'sofa' }

'use strict';

// ─── フォーマッタ ─────────────────────────────────────────────
function fmtNum(v, fb = '-')          { if (v == null || v === '') return fb; return String(v); }
function fmtPct(v, digits = 0, fb = '-') { if (v == null || v === '') return fb; return Number(v).toFixed(digits) + '%'; }
function fmtFloat(v, n = 2, fb = '-') { if (v == null || v === '') return fb; return Number(v).toFixed(n); }

function fmtLast5Row(r) {
  if (!r) return '-';
  const mark  = r.result === 'W' ? '○' : r.result === 'L' ? '●' : '△';
  const opp   = r.opponent || '?';
  const venue = r.isHome ? 'H' : 'A';
  const score = r.score || '';
  return `${mark} ${venue} ${opp} ${score}`.trim();
}
function fmtTopPlayer(p, key = 'goals') {
  if (!p?.name) return '-';
  const team = p.teamName ? `(${p.teamName})` : '';
  if (key === 'goals')   return `${p.name}${team} ${p.goals ?? '-'}ゴール`;
  if (key === 'assists') return `${p.name}${team} ${p.assists ?? '-'}アシスト`;
  if (key === 'rating')  return `${p.name}${team} 評定${fmtFloat(p.rating, 2)}`;
  return p.name;
}
function fmtStandingRow(standings, pos) {
  if (!Array.isArray(standings) || pos < 1 || pos > standings.length) return '-';
  const r = standings[pos - 1];
  if (!r?.teamName) return '-';
  const gd  = r.goalDiff != null ? (r.goalDiff > 0 ? `+${r.goalDiff}` : `${r.goalDiff}`) : '-';
  const wdl = `${r.wins || 0}-${r.draws || 0}-${r.losses || 0}`;
  return `${r.teamName} 勝点${r.points ?? '-'} (${wdl} GD${gd})`;
}
function isEmpty(v) { return v == null || v === '' || v === '-'; }

// ─── push ヘルパ：空値は捨てる ───────────────────────────────
function _mkPush(slots, source = 'sofa') {
  return (key, label, value, category, priority = 5) => {
    if (!isEmpty(value)) slots.push({ key, label, value: String(value), category, priority, source });
  };
}

// ─── 選手 ────────────────────────────────────────────────────
function walkPlayer(d) {
  if (!d) return [];
  const slots = [];
  const push  = _mkPush(slots);

  push('position',      'ポジション',   fmtNum(d.position),                 '基本情報', 9);
  push('age',           '年齢',         d.age != null ? d.age + '歳' : '-', '基本情報', 9);
  push('nationality',   '国籍',         fmtNum(d.nationality),              '基本情報', 8);
  push('team',          '所属',         fmtNum(d.team),                     '基本情報', 9);
  push('height',        '身長',         d.height ? d.height + 'cm' : '-',   '基本情報', 5);
  push('weight',        '体重',         d.weight ? d.weight + 'kg' : '-',   '基本情報', 4);
  push('preferredFoot', '利き足',       fmtNum(d.preferredFoot),            '基本情報', 5);
  push('shirtNumber',   '背番号',       d.shirtNumber != null ? '#' + d.shirtNumber : '-', '基本情報', 5);
  push('marketValue',   '市場価値',     fmtNum(d.marketValue),              '基本情報', 7);
  push('contractUntil', '契約満了',     fmtNum(d.contractUntil),            '基本情報', 4);
  push('league',        'リーグ',       fmtNum(d.leagueName),               '基本情報', 6);

  const ss = d.seasonStats || {};
  push('goals',             'ゴール',           fmtNum(ss.goals),                                              '今季成績', 10);
  push('assists',           'アシスト',         fmtNum(ss.assists),                                            '今季成績', 10);
  push('apps',              '出場',             ss.appearances != null ? ss.appearances + '試合' : '-',       '今季成績', 8);
  push('minutes',           '出場時間',         ss.minutesPlayed ? ss.minutesPlayed + '分' : '-',             '今季成績', 5);
  push('rating',            '平均評定',         fmtFloat(ss.rating, 2),                                       '今季成績', 10);
  push('xG',                'xG',               fmtFloat(ss.expectedGoals, 2),                                '今季成績', 9);
  push('xA',                'xA',               fmtFloat(ss.expectedAssists, 2),                              '今季成績', 7);
  push('keyPasses',         'キーパス',         fmtNum(ss.keyPasses),                                         '今季成績', 8);
  push('bigChancesCreated', 'チャンスメイク',   fmtNum(ss.bigChancesCreated),                                 '今季成績', 7);
  push('passAcc',           'パス成功率',       fmtPct(ss.accuratePassesPct),                                 '今季成績', 7);
  push('shotsOnTarget',     '枠内シュート',     fmtNum(ss.shotsOnTarget),                                     '今季成績', 6);
  push('totalShots',        'シュート総数',     fmtNum(ss.totalShots),                                        '今季成績', 5);
  push('bigChancesMissed',  '決定機外し',       fmtNum(ss.bigChancesMissed),                                  '今季成績', 5);
  push('successfulDribbles','ドリブル成功',     fmtNum(ss.successfulDribbles),                                '今季成績', 7);
  push('yellowCards',       '警告',             fmtNum(ss.yellowCards),                                       '今季成績', 3);
  push('redCards',          '退場',             fmtNum(ss.redCards),                                          '今季成績', 3);
  push('cleanSheets',       '完封 (GK)',        fmtNum(ss.cleanSheets),                                       '今季成績', 6);
  push('saves',             'セーブ (GK)',      fmtNum(ss.saves),                                             '今季成績', 6);
  push('tackles',           'タックル',         fmtNum(ss.tackles),                                           '今季成績', 4);
  push('interceptions',     'インターセプト',   fmtNum(ss.interceptions),                                     '今季成績', 4);
  push('recentAvgRating',   '直近10戦平均評定', fmtFloat(d.recentAvgRating, 2),                               '今季成績', 7);

  const ps = d.positionStats || {};
  push('ps_tackles',          'タックル(P別)',     fmtNum(ps.tackles),         'ポジション別', 4);
  push('ps_interceptions',    'インターセプト(P別)', fmtNum(ps.interceptions),'ポジション別', 4);
  push('ps_clearances',       'クリア',           fmtNum(ps.clearances),      'ポジション別', 4);
  push('ps_duelsWon',         'デュエル勝',       fmtNum(ps.duelsWon),        'ポジション別', 4);
  push('ps_saves',            'セーブ(P別)',       fmtNum(ps.saves),           'ポジション別', 4);
  push('ps_cleanSheets',      '完封(P別)',         fmtNum(ps.cleanSheets),     'ポジション別', 4);
  push('ps_goalsPrevented',   'ゴール阻止',       fmtNum(ps.goalsPrevented),  'ポジション別', 4);
  push('ps_shotsOnTarget',    '枠内シュート(P別)', fmtNum(ps.shotsOnTarget),  'ポジション別', 4);
  push('ps_bigChancesMissed', '決定機外し(P別)',   fmtNum(ps.bigChancesMissed),'ポジション別', 4);
  push('ps_successfulDribbles','ドリブル成功(P別)',fmtNum(ps.successfulDribbles), 'ポジション別', 4);

  const ucl = d.uclStats || {};
  push('uclGoals',  'CL得点', fmtNum(ucl.goals),       'CL', 7);
  push('uclRating', 'CL評定', fmtFloat(ucl.rating, 2), 'CL', 7);

  // career (sofa.career = クラブ遍歴)
  if (Array.isArray(d.career)) {
    d.career.slice(0, 8).forEach((c, i) => {
      const yrs   = (c.from || '?') + '-' + (c.to || '現在');
      const stats = [c.caps != null ? c.caps + '試合' : null, c.goals != null ? c.goals + 'G' : null].filter(Boolean).join(' ');
      push(`career_${i+1}`, `経歴${i+1}`, `${yrs}: ${c.club || '?'}${stats ? ' ' + stats : ''}`, '経歴', 6 - Math.min(i, 5));
    });
  }

  // ─ シーズン履歴（シーズン × 大会ごとに個別アコーディオン）─
  // 各シーズンを独立したカテゴリとして扱うことで step4 で選びやすくする
  if (Array.isArray(d.seasonHistory) && d.seasonHistory.length) {
    d.seasonHistory.forEach((s, i) => {
      const isRecent2  = i < 2;
      const isRecent5  = i < 5;
      const isRecent10 = i < 10;
      const basePri = isRecent2 ? 9 - i : (isRecent5 ? 7 - i : (isRecent10 ? 4 : 2));
      // シーズン × 大会を独立カテゴリに（例: "25/26 Premier League"）
      const seasonLabel = `${s.seasonName || '?'} ${s.tournamentName || ''}`.trim();
      const cat = seasonLabel;
      const stats = s.stats || {};
      const summary = [
        stats.appearances != null ? stats.appearances + '試合' : null,
        stats.goals       != null ? stats.goals + 'G' : null,
        stats.assists     != null ? stats.assists + 'A' : null,
        stats.rating      != null ? '評定' + stats.rating : null,
      ].filter(Boolean).join(' ');
      push(`season_${i+1}_summary`,  seasonLabel,                summary,                       cat, basePri);
      push(`season_${i+1}_apps`,     `${seasonLabel} 試合数`,     fmtNum(stats.appearances),     cat, basePri - 1);
      push(`season_${i+1}_goals`,    `${seasonLabel} ゴール`,     fmtNum(stats.goals),           cat, basePri - 1);
      push(`season_${i+1}_assists`,  `${seasonLabel} アシスト`,   fmtNum(stats.assists),         cat, basePri - 1);
      push(`season_${i+1}_rating`,   `${seasonLabel} 評定`,       fmtFloat(stats.rating, 2),     cat, basePri - 1);
      push(`season_${i+1}_minutes`,  `${seasonLabel} 出場分`,     fmtNum(stats.minutesPlayed),   cat, basePri - 2);
      if (stats.expectedGoals  != null) push(`season_${i+1}_xG`,         `${seasonLabel} xG`,          fmtFloat(stats.expectedGoals, 2),  cat, basePri - 2);
      if (stats.shotsOnTarget  != null) push(`season_${i+1}_shots`,      `${seasonLabel} 枠内シュート`,  fmtNum(stats.shotsOnTarget),       cat, basePri - 2);
      if (stats.totalShots     != null) push(`season_${i+1}_totalshots`,  `${seasonLabel} 総シュート`,   fmtNum(stats.totalShots),          cat, basePri - 3);
      if (stats.keyPasses      != null) push(`season_${i+1}_keypasses`,   `${seasonLabel} キーパス`,     fmtNum(stats.keyPasses),           cat, basePri - 2);
      if (stats.bigChancesCreated != null) push(`season_${i+1}_chances`,  `${seasonLabel} チャンスメイク`, fmtNum(stats.bigChancesCreated),   cat, basePri - 2);
      if (stats.successfulDribbles != null) push(`season_${i+1}_dribbles`, `${seasonLabel} ドリブル成功`, fmtNum(stats.successfulDribbles),  cat, basePri - 2);
      if (stats.tackles        != null) push(`season_${i+1}_tackles`,     `${seasonLabel} タックル`,     fmtNum(stats.tackles),             cat, basePri - 2);
      if (stats.interceptions  != null) push(`season_${i+1}_intercept`,   `${seasonLabel} インターセプト`, fmtNum(stats.interceptions),      cat, basePri - 2);
      if (stats.aerialDuelsWon != null) push(`season_${i+1}_aerial`,      `${seasonLabel} 空中戦勝利`,   fmtNum(stats.aerialDuelsWon),      cat, basePri - 3);
      if (stats.saves          != null) push(`season_${i+1}_saves`,       `${seasonLabel} セーブ`,       fmtNum(stats.saves),               cat, basePri - 2);
      if (stats.cleanSheets    != null) push(`season_${i+1}_cs`,          `${seasonLabel} クリーンシート`, fmtNum(stats.cleanSheets),         cat, basePri - 2);
      if (stats.yellowCards    != null) push(`season_${i+1}_yellow`,      `${seasonLabel} 警告`,         fmtNum(stats.yellowCards),         cat, basePri - 3);
    });
  }

  // ─ 代表チーム成績 ────────────────────────────────────
  if (d.nationalTeam) {
    const nt    = d.nationalTeam;
    const tName = nt.teamName || '代表';
    push('nat_team',     '代表チーム', tName, '代表チーム', 7);
    if (nt.total) {
      push('nat_apps',    `${tName} 通算試合`, fmtNum(nt.total.appearances), '代表チーム', 8);
      push('nat_goals',   `${tName} 通算ゴール`, fmtNum(nt.total.goals),       '代表チーム', 8);
      push('nat_assists', `${tName} 通算アシスト`, fmtNum(nt.total.assists),    '代表チーム', 6);
    }
    if (Array.isArray(nt.tournaments)) {
      nt.tournaments.slice(0, 5).forEach((t, i) => {
        const ttl = t.tournamentName || '?';
        const summary = [
          t.appearances != null ? t.appearances + '試合' : null,
          t.goals != null ? t.goals + 'G' : null,
          t.assists != null ? t.assists + 'A' : null,
        ].filter(Boolean).join(' ');
        if (summary) push(`nat_tour_${i+1}`, `代表 ${ttl}`, summary, '代表チーム', 6 - Math.min(i, 4));
      });
    }
  }

  // ─ 移籍履歴 ──────────────────────────────────────────
  if (Array.isArray(d.transferHistory) && d.transferHistory.length) {
    d.transferHistory.slice(0, 8).forEach((t, i) => {
      const yrs = (t.date || '').slice(0, 4);
      const fee = t.feeStr || (t.fee?.value ? `€${(t.fee.value / 1e6).toFixed(0)}M` : '');
      const summary = `${yrs} ${t.from || '?'} → ${t.to || '?'}${fee ? ' ' + fee : ''}`.trim();
      push(`transfer_${i+1}`, `移籍${i+1}`, summary, '移籍履歴', 6 - Math.min(i, 4));
    });
  }

  if (d._wiki?.extract)     push('wikiBio',  '紹介文',    String(d._wiki.extract).slice(0, 120), 'Wikipedia', 4);
  if (d._wiki?.description) push('wikiDesc', '一行紹介',  d._wiki.description,                   'Wikipedia', 5);

  // ─ 市場価値推移（TM valueHistory）────────────────────────
  if (Array.isArray(d._tmGames?.valueHistory) && d._tmGames.valueHistory.length) {
    d._tmGames.valueHistory.slice(0, 12).forEach((v, i) => {
      const label = v.season ? `${v.season} 市場価値` : `${v.date || '?'} 市場価値`;
      const val   = v.club ? `${v.valueFmt || '?'} (${v.club})` : (v.valueFmt || '?');
      push(`mv_${i+1}`, label, val, '市場価値推移', 7 - Math.min(i, 5));
    });
  }

  // FotMob クラブごとキャリア（選手）
  _pushFotmobPlayerCareer(push, d._fotmob);

  return slots;
}

// ─── チーム ──────────────────────────────────────────────────
function walkTeam(d) {
  if (!d) return [];
  const slots = [];
  const push  = _mkPush(slots);

  push('league',      'リーグ',     fmtNum(d.leagueName),  '基本情報', 7);
  push('country',     '国',         fmtNum(d.country),     '基本情報', 5);
  push('founded',     '創設',       fmtNum(d.founded),     '基本情報', 5);
  push('manager',     '監督',       fmtNum(d.managerName), '基本情報', 8);
  push('venue',       'スタジアム', fmtNum(d.venue),       '基本情報', 5);
  push('marketValue', '総資産',     fmtNum(d.marketValue), '基本情報', 7);

  const st = d.standing || {};
  push('position',  '順位',     st.position != null ? st.position + '位' : '-', '今季順位', 10);
  push('points',    '勝点',     fmtNum(st.points),                              '今季順位', 9);
  push('played',    '試合数',   fmtNum(st.played),                              '今季順位', 6);
  push('wins',      '勝利',     fmtNum(st.wins),                                '今季順位', 8);
  push('draws',     '引分',     fmtNum(st.draws),                               '今季順位', 6);
  push('losses',    '敗戦',     fmtNum(st.losses),                              '今季順位', 7);
  push('gf',        '得点',     fmtNum(st.goalsFor),                            '今季順位', 8);
  push('ga',        '失点',     fmtNum(st.goalsAgainst),                        '今季順位', 7);
  push('gd',        '得失点差', (st.goalsFor != null && st.goalsAgainst != null) ? String(st.goalsFor - st.goalsAgainst) : '-', '今季順位', 8);
  push('wdlStr',    'W-D-L',    st.wins != null ? `${st.wins||0}-${st.draws||0}-${st.losses||0}` : '-',                       '今季順位', 7);

  const ts = d.teamStats || {};
  push('avgGoalsScored',   '平均得点',         fmtFloat(ts.avgGoalsScored, 2),   'チーム統計', 7);
  push('avgGoalsConceded', '平均失点',         fmtFloat(ts.avgGoalsConceded, 2), 'チーム統計', 7);
  push('avgPossession',    '平均ポゼッション', fmtPct(ts.avgPossession),         'チーム統計', 6);
  push('avgShots',         '平均シュート',     fmtFloat(ts.avgShots, 1),         'チーム統計', 5);
  push('avgPassAcc',       '平均パス成功率',   fmtPct(ts.avgPassAcc),            'チーム統計', 5);

  if (d.recentForm) push('recentForm', '直近フォーム', fmtNum(d.recentForm), '直近フォーム', 9);
  if (Array.isArray(d.last5)) {
    d.last5.slice(0, 5).forEach((r, i) => {
      push(`last_${i+1}`, `直近${i+1}試合${i === 0 ? '' : '前'}`, fmtLast5Row(r), '直近フォーム', 8 - i);
    });
    const w = d.last5.filter(r => r?.result === 'W').length;
    const l = d.last5.filter(r => r?.result === 'L').length;
    push('last5wins',   '直近5戦勝数',  String(w), '直近フォーム', 7);
    push('last5losses', '直近5戦敗数',  String(l), '直近フォーム', 7);
  }

  const ty = d.trophySummary || {};
  push('totalTrophies', '獲得タイトル数', fmtNum(ty.total),         'タイトル', 8);
  push('leagueTitles',  'リーグ優勝',     fmtNum(ty.leagueTitles),  'タイトル', 8);
  push('cupTitles',     'カップ優勝',     fmtNum(ty.cupTitles),     'タイトル', 7);
  push('clTitles',      'CL優勝',         fmtNum(ty.clTitles),      'タイトル', 8);
  push('uefaSuper',     'UEFAスーパー杯', fmtNum(ty.uefaSuper),     'タイトル', 5);
  push('worldClub',     'クラブW杯',      fmtNum(ty.worldClub),     'タイトル', 6);

  if (Array.isArray(d.honours)) {
    const all = d.honours.flatMap(h => h.items || []).slice(0, 15);
    all.forEach((title, i) => {
      push(`honour_${i+1}`, `獲得タイトル${i+1}`, title, 'タイトル詳細', 5 - Math.min(i, 4));
    });
  }

  if (d.topPlayers) {
    const tp = d.topPlayers;
    if (Array.isArray(tp.scorers)) tp.scorers.slice(0, 3).forEach((p, i) => push(`topScorer_${i+1}`, `チーム得点${i+1}位`, fmtTopPlayer(p, 'goals'),   '今季エース', 8 - i));
    if (Array.isArray(tp.assists)) tp.assists.slice(0, 3).forEach((p, i) => push(`topAssist_${i+1}`, `チームアシスト${i+1}位`, fmtTopPlayer(p, 'assists'), '今季エース', 7 - i));
    if (Array.isArray(tp.rated))   tp.rated.slice(0, 3).forEach((p, i)   => push(`topRated_${i+1}`,  `チーム評定${i+1}位`,    fmtTopPlayer(p, 'rating'),  '今季エース', 6 - i));
  }

  // 🆕 European 大会別 (UCL / UEL / UECL) の standings + stats を別 slot として公開
  //   d.tournaments[0] は domestic（既に上で push 済）→ skip、[1+] が European
  if (Array.isArray(d.tournaments) && d.tournaments.length > 1) {
    d.tournaments.slice(1).forEach((t) => {
      const cat = t.kind === 'UCL' ? 'CL'
                 : t.kind === 'UEL' ? 'EL'
                 : t.kind === 'UECL' ? 'カンファレンス'
                 : t.name;
      const prefix = t.kind || 'eu';
      // 順位
      if (t.standing) {
        const s = t.standing;
        push(`${prefix}_position`, `${cat} 順位`,   s.position != null ? s.position + '位' : '-',                                  cat + '順位', 9);
        push(`${prefix}_points`,   `${cat} 勝点`,   fmtNum(s.points),                                                              cat + '順位', 8);
        push(`${prefix}_played`,   `${cat} 試合数`, fmtNum(s.played),                                                              cat + '順位', 6);
        push(`${prefix}_wdl`,      `${cat} W-D-L`,  s.wins != null ? `${s.wins||0}-${s.draws||0}-${s.losses||0}` : '-',          cat + '順位', 7);
        push(`${prefix}_gf`,       `${cat} 得点`,   fmtNum(s.goalsFor),                                                            cat + '順位', 7);
        push(`${prefix}_ga`,       `${cat} 失点`,   fmtNum(s.goalsAgainst),                                                        cat + '順位', 6);
        if (s.goalsFor != null && s.goalsAgainst != null) {
          push(`${prefix}_gd`,     `${cat} 得失点差`, String(s.goalsFor - s.goalsAgainst),                                          cat + '順位', 6);
        }
      }
      // チーム平均スタッツ
      if (t.teamStats) {
        const ts = t.teamStats;
        push(`${prefix}_avgGoalsScored`,   `${cat} 平均得点`,         fmtFloat(ts.avgGoalsScored, 2),    cat + 'スタッツ', 6);
        push(`${prefix}_avgGoalsConceded`, `${cat} 平均失点`,         fmtFloat(ts.avgGoalsConceded, 2),  cat + 'スタッツ', 6);
        push(`${prefix}_avgPossession`,    `${cat} 平均ポゼッション`, fmtPct(ts.avgPossession),          cat + 'スタッツ', 5);
        push(`${prefix}_avgShots`,         `${cat} 平均シュート`,     fmtFloat(ts.avgShots, 1),          cat + 'スタッツ', 5);
        push(`${prefix}_avgxG`,            `${cat} 平均xG`,           fmtFloat(ts.avgxG, 2),             cat + 'スタッツ', 5);
        push(`${prefix}_passAcc`,          `${cat} パス成功率`,       fmtPct(ts.passAccuracy),           cat + 'スタッツ', 4);
      }
      // トップ選手
      if (t.topPlayers) {
        const tp = t.topPlayers;
        if (Array.isArray(tp.goals))   tp.goals.slice(0, 3).forEach((p, i)   => push(`${prefix}_topScorer_${i+1}`, `${cat} 得点${i+1}位`,     fmtTopPlayer(p, 'goals'),   cat + 'エース', 7 - i));
        if (Array.isArray(tp.assists)) tp.assists.slice(0, 3).forEach((p, i) => push(`${prefix}_topAssist_${i+1}`, `${cat} アシスト${i+1}位`, fmtTopPlayer(p, 'assists'), cat + 'エース', 6 - i));
        if (Array.isArray(tp.rating))  tp.rating.slice(0, 3).forEach((p, i)  => push(`${prefix}_topRated_${i+1}`,  `${cat} 評定${i+1}位`,     fmtTopPlayer(p, 'rating'),  cat + 'エース', 5 - i));
      }
    });
  }

  const cm = d.currentManagerStats || {};
  if (cm.name) {
    push('curMgrName',    '現監督',         fmtNum(cm.name),                      '現監督', 8);
    push('curMgrSince',   '就任日',         fmtNum(cm.since),                     '現監督', 5);
    push('curMgrTotal',   '監督通算試合',   fmtNum(cm.total),                     '現監督', 6);
    push('curMgrWins',    '監督勝',         fmtNum(cm.wins),                      '現監督', 6);
    push('curMgrWdl',     '監督W-D-L',      cm.total ? `${cm.wins||0}-${cm.draws||0}-${cm.losses||0}` : '-', '現監督', 7);
    push('curMgrWinRate', '監督勝率',       cm.winRate != null ? cm.winRate + '%' : '-', '現監督', 8);
  }

  const sa = d.seasonAggregate || {};
  if (sa.thisYear?.total)     { push('thisYearGoals', '今年得点',    fmtNum(sa.thisYear.goalsFor),      '期間別集計', 6); push('thisYearWins', '今年勝数', fmtNum(sa.thisYear.wins), '期間別集計', 6); }
  if (sa.lastYear?.total)     { push('lastYearGoals', '昨年得点',    fmtNum(sa.lastYear.goalsFor),      '期間別集計', 4); }
  if (sa.lastWorldCup?.total) { push('lastWcGoals',   '前回W杯得点', fmtNum(sa.lastWorldCup.goalsFor),  '期間別集計', 5); }
  if (sa.wcQual?.total)       { push('wcQualGoals',   'W杯予選得点', fmtNum(sa.wcQual.goalsFor),        '期間別集計', 5); }

  if (d._wiki?.extract)     push('wikiBio',  '紹介文',   String(d._wiki.extract).slice(0, 120), 'Wikipedia', 4);
  if (d._wiki?.description) push('wikiDesc', '一行紹介', d._wiki.description,                   'Wikipedia', 5);

  // ─ TM 歴代シーズン（順位推移・2026-05-30）────────────────────
  const tmSeasons = d._tmSeasons?.seasons;
  if (Array.isArray(tmSeasons) && tmSeasons.length) {
    tmSeasons.slice(0, 10).forEach((s, i) => {
      const wdl = (s.wins != null && s.draws != null && s.losses != null)
        ? ` ${s.wins}-${s.draws}-${s.losses}` : '';
      const pts = s.points != null ? ` 勝点${s.points}` : '';
      const pos = s.position != null ? `${s.position}位` : '?位';
      const summary = `${s.season}: ${pos}${pts}${wdl}`;
      const league  = s.league ? ` (${s.league})` : '';
      push(`pastSeason_${i+1}`,     `${s.season} 順位`,   pos,                            '歴代シーズン', 7 - Math.min(i, 5));
      push(`pastSeason_${i+1}_sum`, `${s.season} 成績`,   summary + league,               '歴代シーズン', 6 - Math.min(i, 5));
      if (s.points  != null) push(`pastSeason_${i+1}_pts`, `${s.season} 勝点`, String(s.points),  '歴代シーズン', 5 - Math.min(i, 4));
      if (s.wins    != null) push(`pastSeason_${i+1}_wdl`, `${s.season} W-D-L`, `${s.wins}-${s.draws}-${s.losses}`, '歴代シーズン', 4);
    });
  }

  return slots;
}

// ─── 監督タイトル数を honours[Manager] から自前集計 ─────────────
//   SofaScore の trophySummary は player+manager 混在 + League/Cup の誤分類があり
//   Arteta=leagueTitles 5 (実際 0)、Simeone=clTitles 1 (実際 0) 等のハルシネーション源
//   honours.items の文字列から競技名+年度を解析して自前カウント
function _computeManagerTrophies(honours) {
  const mgr = (honours || []).find(h => h.category === 'Manager');
  if (!mgr || !Array.isArray(mgr.items)) return null;
  const counts = { total: 0, leagueTitles: 0, cupTitles: 0, clTitles: 0, elTitles: 0, uefaSuper: 0, worldClub: 0 };

  for (const raw of mgr.items) {
    const s = String(raw || '').trim();
    if (!s) continue;
    const colonIdx = s.indexOf(':');
    if (colonIdx < 0) continue;
    const compName = s.slice(0, colonIdx).trim();
    let yearsRaw = s.slice(colonIdx + 1).trim();

    // 個人賞・Awards 系は除外（タイトルではない）
    if (/Manager of (the )?(Month|Year|Decade|Season)|Best (Manager|Coach|Premier League Coach)|Coach of the (Year|Decade)|\bAward(s)?\b|Trofeo|Trophy|MARCA|IFFHS|Globe Soccer|Konex|Special Award|Footballer of/i.test(compName)) continue;
    if (/(Manager|Coach) of the (Month|Year|Decade|Season)/i.test(compName)) continue;
    if (/^(La Liga|Premier League|Serie A|Ligue 1|Bundesliga|Eredivisie) Manager/i.test(compName)) continue;

    // runner-up 部分を切り捨てる（winner 部分のみ残す）
    //   "2012–13; runner-up: 2025–26" → "2012–13"
    //   "runner-up 2013–14, 2015–16"  → ""（winner なし）
    yearsRaw = yearsRaw.split(/;?\s*runner-?up/i)[0].trim();
    if (!yearsRaw) continue;

    // 年度トークン (4桁数字を含む) を数える: "2013–14, 2020–21" → 2
    const yearTokens = yearsRaw.split(/,|;/).map(t => t.trim()).filter(t => /\d{4}/.test(t));
    const n = yearTokens.length;
    if (n <= 0) continue;

    counts.total += n;
    const c = compName.toLowerCase();
    if (/champions league|european cup\b/.test(c))                    counts.clTitles  += n;
    else if (/europa league|uefa cup\b/.test(c))                      counts.elTitles  += n;
    else if (/super ?cup|supercoppa|supercopa|community shield/.test(c)) counts.uefaSuper += n;
    else if (/club world cup|fifa club world|intercontinental/.test(c)) counts.worldClub += n;
    else if (/league|liga|premier|bundesliga|serie a|ligue 1|primera divisi|primera división|eredivisie|premiership|championship|j1|j-league|mls/.test(c)) counts.leagueTitles += n;
    else if (/cup|copa|coupe|coppa|pokal|emperor|knvb/.test(c))       counts.cupTitles += n;
  }
  return counts;
}

// ─── 監督 ────────────────────────────────────────────────────
function walkManager(d) {
  if (!d) return [];
  const slots = [];
  const push  = _mkPush(slots);

  push('name',              '氏名',             fmtNum(d.name),                                  '基本情報', 5);
  push('nationality',       '国籍',             fmtNum(d.nationality),                           '基本情報', 7);
  push('age',               '年齢',             d.age != null ? d.age + '歳' : '-',             '基本情報', 7);
  push('preferredFormation','好フォーメーション', fmtNum(d.preferredFormation),                 '基本情報', 6);
  push('currentTeam',       '現所属',           fmtNum(d.currentTeam),                           '基本情報', 9);
  push('currentTeamSince',  '就任日',           fmtNum(d.currentTeamSince),                      '基本情報', 6);

  const op = d.overallPerformance || {};
  push('totalMatches',      '通算試合数',       fmtNum(op.total),                                          '通算成績', 9);
  push('totalWins',         '通算勝',           fmtNum(op.wins),                                           '通算成績', 9);
  push('totalDraws',        '通算分',           fmtNum(op.draws),                                          '通算成績', 7);
  push('totalLosses',       '通算敗',           fmtNum(op.losses),                                         '通算成績', 7);
  push('overallWinRate',    '通算勝率',         op.winRate != null ? Number(op.winRate).toFixed(1) + '%' : '-', '通算成績', 10);
  push('overallWdl',        '通算W-D-L',        op.total ? `${op.wins||0}-${op.draws||0}-${op.losses||0}` : '-', '通算成績', 8);
  push('totalGoalsScored',  '通算得点',         fmtNum(op.goalsScored),                                    '通算成績', 7);
  push('totalGoalsConceded','通算失点',         fmtNum(op.goalsConceded),                                  '通算成績', 7);
  push('goalsPerGame',      '1試合平均得点',    fmtFloat(op.goalsPerGame, 2),                              '通算成績', 7);
  push('concededPerGame',   '1試合平均失点',    fmtFloat(op.concededPerGame, 2),                           '通算成績', 6);
  push('pointsPerGame',     '勝点P/G',          fmtFloat(op.pointsPerGame, 2),                             '通算成績', 8);

  const ct = d.currentTeamStats || {};
  if (ct.club) {
    push('curTeamSample',  ct.club + ' 直近試合', ct.sample != null ? ct.sample + '試合' : '-',            '現所属成績', 8);
    push('curTeamWins',    ct.club + ' 勝利',     fmtNum(ct.wins),                                          '現所属成績', 8);
    push('curTeamDraws',   ct.club + ' 引分',     fmtNum(ct.draws),                                         '現所属成績', 6);
    push('curTeamLosses',  ct.club + ' 敗戦',     fmtNum(ct.losses),                                        '現所属成績', 6);
    push('curTeamWinRate', ct.club + ' 勝率',     ct.winRate != null ? Number(ct.winRate).toFixed(1) + '%' : '-', '現所属成績', 9);
    push('curTeamWdl',     ct.club + ' W-D-L',    ct.sample ? `${ct.wins||0}-${ct.draws||0}-${ct.losses||0}` : '-', '現所属成績', 7);
  }

  // SofaScore の d.trophySummary は player+manager 混在で誤集計がある
  //   honours[Manager] から自前計算した値を優先（無ければ SofaScore 値にフォールバック）
  const ts = _computeManagerTrophies(d.honours) || d.trophySummary || {};
  push('totalTrophies', '監督獲得タイトル数', fmtNum(ts.total),         'タイトル', 9);
  push('leagueTitles',  'リーグ優勝',         fmtNum(ts.leagueTitles),  'タイトル', 8);
  push('cupTitles',     'カップ優勝',         fmtNum(ts.cupTitles),     'タイトル', 7);
  push('clTitles',      'CL優勝',             fmtNum(ts.clTitles),      'タイトル', 8);
  push('elTitles',      'EL/UEFAカップ優勝',  fmtNum(ts.elTitles),      'タイトル', 7);
  push('uefaSuper',     'UEFAスーパー杯',     fmtNum(ts.uefaSuper),     'タイトル', 6);
  push('worldClub',     'クラブW杯',          fmtNum(ts.worldClub),     'タイトル', 6);

  if (Array.isArray(d.honours)) {
    const mgrCat = d.honours.find(h => h.category === 'Manager');
    if (mgrCat?.items?.length) {
      mgrCat.items.slice(0, 12).forEach((title, i) => {
        push(`mgrHonour_${i+1}`, `監督タイトル${i+1}`, title, 'タイトル詳細', 5 - Math.min(i, 4));
      });
    }
    const playerCat = d.honours.find(h => h.category === 'Player');
    if (playerCat?.items?.length) {
      playerCat.items.slice(0, 8).forEach((title, i) => {
        push(`plrHonour_${i+1}`, `現役時タイトル${i+1}`, title, '選手歴', 3 - Math.min(i, 2));
      });
    }
  }

  if (Array.isArray(d.last5Matches)) {
    d.last5Matches.slice(0, 5).forEach((m, i) => {
      push(`last5_${i+1}`, `直近${i+1}試合`, fmtLast5Row(m), '直近フォーム', 8 - i);
    });
    const w = d.last5Matches.filter(r => r?.result === 'W').length;
    const l = d.last5Matches.filter(r => r?.result === 'L').length;
    push('last5wins',   '直近5戦勝数', String(w), '直近フォーム', 7);
    push('last5losses', '直近5戦敗数', String(l), '直近フォーム', 7);
  }

  if (Array.isArray(d.career)) {
    d.career.slice(0, 6).forEach((c, i) => {
      const yrs   = (c.from || '?') + '-' + (c.to || '現在');
      const stats = c.total ? `${c.total}試合 ${c.wins||0}-${c.draws||0}-${c.losses||0}` : '';
      push(`career_${i+1}`, `経歴${i+1}`, `${yrs}: ${c.club || '?'}${stats ? ' ' + stats : ''}`, '経歴', 6 - Math.min(i, 5));
    });
  }

  if (d._wiki?.extract)     push('wikiBio',  '紹介文',   String(d._wiki.extract).slice(0, 120), 'Wikipedia', 4);
  if (d._wiki?.description) push('wikiDesc', '一行紹介', d._wiki.description,                   'Wikipedia', 5);

  // FotMob クラブごとキャリア（監督）+ クラブ別大会タイトル
  _pushFotmobCoachCareer(push, d._fotmob);

  return slots;
}

// ─── FotMob ヘルパー ────────────────────────────────────────
//   選手・監督の per-club キャリア slots を追加。SofaScore career[] が
//   null だった部分を補完する
function _pushFotmobPlayerCareer(push, fm) {
  if (!fm || !Array.isArray(fm.playerCareer)) return;
  fm.playerCareer.slice(0, 8).forEach((c, i) => {
    const yrs = (c.startDate || '????').slice(0, 4) + '-' + (c.endDate ? c.endDate.slice(0, 4) : '現在');
    const stats = [
      c.appearances != null ? c.appearances + '試合' : '',
      c.goals       != null ? c.goals + 'G'         : '',
      c.assists     != null ? c.assists + 'A'       : '',
    ].filter(Boolean).join(' ');
    push(`fmPlayerClub_${i+1}`, `経歴${i+1}`, `${yrs} ${c.team || '?'}${stats ? ' / ' + stats : ''}`, '所属クラブ歴', 7 - Math.min(i, 5));
  });
  const total = fm.playerCareer.reduce((acc, c) => ({
    apps:    acc.apps    + (c.appearances || 0),
    goals:   acc.goals   + (c.goals       || 0),
    assists: acc.assists + (c.assists     || 0),
  }), { apps: 0, goals: 0, assists: 0 });
  if (total.apps > 0) {
    push('fmCareerApps',    '通算出場',     total.apps + '試合', '通算成績', 8);
    push('fmCareerGoals',   '通算ゴール',   total.goals + 'G',   '通算成績', 8);
    push('fmCareerAssists', '通算アシスト', total.assists + 'A', '通算成績', 7);
  }
}

function _pushFotmobCoachCareer(push, fm) {
  if (!fm) return;
  if (Array.isArray(fm.coachCareer) && fm.coachCareer.length) {
    fm.coachCareer.slice(0, 8).forEach((c, i) => {
      const yrs = (c.startDate || '????').slice(0, 4) + '-' + (c.endDate ? c.endDate.slice(0, 4) : '現在');
      push(`fmCoachClub_${i+1}`, `指揮歴${i+1}`, `${yrs} ${c.team || '?'}`, '監督歴', 8 - Math.min(i, 6));
    });
    push('fmCoachClubCount', '指揮クラブ数', String(fm.coachCareer.length), '監督歴', 7);
  }
  if (Array.isArray(fm.coachTrophies) && fm.coachTrophies.length) {
    let trophyIdx = 0;
    fm.coachTrophies.slice(0, 4).forEach((teamBlock) => {
      (teamBlock.tournaments || []).slice(0, 6).forEach((t) => {
        const won = (t.seasonsWon || []).length;
        if (won === 0) return;
        const ru  = (t.seasonsRunnerUp || []).length;
        push(`fmTrophy_${trophyIdx+1}`, `${teamBlock.teamName} ${t.leagueName}`, `${won}回優勝${ru ? ` / 準優勝${ru}` : ''}`, '大会別タイトル', 7 - Math.min(trophyIdx, 5));
        trophyIdx++;
      });
    });
  }
}

// ─── 大会 ────────────────────────────────────────────────────
function walkTournament(d) {
  if (!d) return [];
  const slots = [];
  const push  = _mkPush(slots);

  push('name',       '大会名',   fmtNum(d.name),       '基本情報', 6);
  push('country',    '国',       fmtNum(d.country),    '基本情報', 5);
  push('seasonYear', 'シーズン', fmtNum(d.seasonYear), '基本情報', 5);

  if (Array.isArray(d.standings)) {
    d.standings.slice(0, 5).forEach((_, i) => {
      const pos = i + 1;
      push(`standing_${pos}`, `${pos}位`, fmtStandingRow(d.standings, pos), '順位表', 8 - Math.min(i, 5));
    });
    push('standings_count', '順位表行数', String(d.standings.length), '順位表', 4);
  }

  const races = [
    { k: 'titleRace',      cat: '優勝争い',  jp: '優勝争い' },
    { k: 'clRace',         cat: 'CL圏',     jp: 'CL圏' },
    { k: 'relegationRace', cat: '降格圏',    jp: '降格圏' },
  ];
  races.forEach(({ k, cat, jp }) => {
    if (Array.isArray(d[k])) {
      d[k].slice(0, 5).forEach((r, i) => {
        push(`${k}_${i+1}`, `${jp}${i+1}`, `${r.teamName || '?'} 勝点${r.points ?? '-'}`, cat, 7 - i);
      });
    }
  });

  if (Array.isArray(d.topScorers)) d.topScorers.slice(0, 5).forEach((p, i) => push(`topScorer_${i+1}`, `得点王${i+1}位`,        fmtTopPlayer(p, 'goals'),    '個人タイトル', 8 - Math.min(i, 5)));
  if (Array.isArray(d.topAssists)) d.topAssists.slice(0, 5).forEach((p, i) => push(`topAssist_${i+1}`, `アシスト王${i+1}位`,    fmtTopPlayer(p, 'assists'),  '個人タイトル', 7 - Math.min(i, 5)));
  if (Array.isArray(d.topRated))   d.topRated.slice(0, 5).forEach((p, i)   => push(`topRated_${i+1}`,  `評定${i+1}位`,         fmtTopPlayer(p, 'rating'),   '個人タイトル', 6 - Math.min(i, 5)));

  if (d._wiki?.extract) push('wikiBio', '紹介文', String(d._wiki.extract).slice(0, 120), 'Wikipedia', 4);

  return slots;
}

// ─── 試合 ────────────────────────────────────────────────────
function walkMatch(d) {
  if (!d) return [];
  const slots = [];
  const push  = _mkPush(slots);

  push('homeTeam',   'ホームチーム',   fmtNum(d.homeTeam),                                                                  '基本情報', 8);
  push('awayTeam',   'アウェイチーム', fmtNum(d.awayTeam),                                                                  '基本情報', 8);
  push('tournament', '大会',           fmtNum(d.tournament),                                                                '基本情報', 6);
  push('matchDate',  '試合日',         fmtNum(d.matchDate),                                                                 '基本情報', 7);
  push('venue',      '会場',           fmtNum(d.venue),                                                                     '基本情報', 5);
  push('scoreline',  'スコア',         d.homeScore != null ? `${d.homeScore} - ${d.awayScore}` : '-',                       '基本情報', 9);

  if (Array.isArray(d.stats)) {
    d.stats.forEach((s, i) => {
      if (!s?.name) return;
      const home = s.home != null ? s.home : '-';
      const away = s.away != null ? s.away : '-';
      push(`stat_${i+1}`, s.name, `${home} / ${away}`, 'スタッツ', 7 - Math.min(Math.floor(i / 3), 3));
    });
  }

  if (Array.isArray(d.goals)) {
    d.goals.forEach((g, i) => {
      const time = g.time || g.minute || '?';
      push(`goal_${i+1}`, `${i+1}点目`, `${time}分 ${g.scorer || '?'}${g.team ? ` (${g.team})` : ''}`, '得点者', 6 - Math.min(i, 5));
    });
  }

  if (Array.isArray(d.h2hMatches)) {
    d.h2hMatches.slice(0, 5).forEach((m, i) => {
      push(`h2h_${i+1}`, `H2H ${i+1}件目`, `${m.matchDate || '?'}: ${m.homeTeam} ${m.homeScore}-${m.awayScore} ${m.awayTeam}`, 'H2H', 5 - i);
    });
  }

  if (Array.isArray(d.topPlayers)) {
    d.topPlayers.slice(0, 3).forEach((p, i) => {
      push(`topPlayer_${i+1}`, `MOM ${i+1}位`, fmtTopPlayer(p, 'rating'), 'トッププレイヤー', 7 - i);
    });
  }

  return slots;
}

// ─── 汎用フォールバック ──────────────────────────────────────
function walkGeneric(d) {
  if (!d || typeof d !== 'object') return [];
  const slots = [];
  function _camelToJa(k) {
    return k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim();
  }
  function _walk(obj, prefix, depth) {
    if (depth > 3) return;
    if (obj == null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith('_') || k === 'fetchedAt' || k === 'ok') continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (v == null || v === '') continue;
      if (typeof v === 'object') {
        if (Array.isArray(v)) {
          if (v.length) slots.push({ key: path, label: _camelToJa(k), value: `${v.length}件`, category: 'その他', priority: 3, source: 'generic' });
        } else {
          _walk(v, path, depth + 1);
        }
      } else {
        slots.push({ key: path, label: _camelToJa(k), value: String(v), category: 'その他', priority: 3, source: 'generic' });
      }
    }
  }
  _walk(d, '', 0);
  return slots;
}

// ─── ディスパッチ ────────────────────────────────────────────
function walkEntity(entityData, role) {
  if (!entityData) return [];
  switch (role) {
    case 'player':     return walkPlayer(entityData);
    case 'team':       return walkTeam(entityData);
    case 'manager':    return walkManager(entityData);
    case 'tournament': return walkTournament(entityData);
    case 'match':      return walkMatch(entityData);
    default:           return walkGeneric(entityData);
  }
}

// ─── 比較用：左右ペア構築 ────────────────────────────────────
//   primary/secondary を同じ role で walk → key 一致でペア化
//   片側にしかない key は反対側を '-' で埋める
function buildPairsForCompare(primaryData, secondaryData, role) {
  const left  = walkEntity(primaryData,   role);
  const right = walkEntity(secondaryData, role);
  const rightMap = new Map(right.map(s => [s.key, s]));
  const seen = new Set();
  const out = [];

  left.forEach(s => {
    seen.add(s.key);
    const r = rightMap.get(s.key);
    out.push({
      key:        s.key,
      label:      s.label,
      category:   s.category,
      priority:   s.priority,
      source:     s.source,
      leftValue:  s.value,
      rightValue: r ? r.value : '-',
    });
  });
  right.forEach(s => {
    if (seen.has(s.key)) return;
    out.push({
      key:        s.key,
      label:      s.label,
      category:   s.category,
      priority:   s.priority,
      source:     s.source,
      leftValue:  '-',
      rightValue: s.value,
    });
  });

  return out;
}

module.exports = {
  walkEntity,
  buildPairsForCompare,
  // 単体エクスポート（内部テスト・他モジュールから個別呼び出し用）
  walkPlayer,
  walkTeam,
  walkManager,
  walkTournament,
  walkMatch,
  walkGeneric,
  // 共通フォーマッタ
  fmtNum,
  fmtPct,
  fmtFloat,
  fmtLast5Row,
  fmtTopPlayer,
  fmtStandingRow,
};
