// v3_launcher/v3_story_architect.js
// V3 "editor in chief" prototype.
//
// This module does not call external AI yet. It defines the contract that
// Sonnet / DeepSeek / GPT can later fill:
// topic -> argumentPlan -> evidencePlan -> slidePlan.

const DEFAULT_TOPIC_PATTERNS = [
  {
    test: /(?=.*(マドリー|レアル|Real Madrid))(?=.*(スペイン代表|代表))(?=.*(0|ゼロ|いない|不在))/i,
    build: buildMadridSpainZeroPlan,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildTopicInput({ title = '', memo = '', sourceComments = [] } = {}) {
  const notes = normalizeLines(memo);
  const comments = Array.isArray(sourceComments)
    ? sourceComments.map((c) => String(c?.body || c?.text || c || '').trim()).filter(Boolean)
    : [];
  return {
    title: String(title || '').trim(),
    memo: String(memo || '').trim(),
    notes,
    sourceComments: comments.slice(0, 20),
  };
}

function parseEditableBrief(brief = {}) {
  if (!brief || typeof brief !== 'object') return null;
  const core = String(brief.core || '').trim();
  const answer = String(brief.answer || '').trim();
  const pointsText = String(brief.points || brief.structure || '').trim();
  const cautionsText = String(brief.cautions || '').trim();
  if (!core && !answer && !pointsText && !cautionsText) return null;

  const points = normalizeLines(pointsText)
    .map((line) => line.replace(/^論点\s*\d+[:：.\s]*/i, '').trim())
    .filter(Boolean);
  const cautions = normalizeLines(cautionsText)
    .map((line) => line.replace(/^[-・*]\s*/, '').trim())
    .filter(Boolean);
  return { core, answer, points, cautions };
}

function makeResearchTask({ id, beatId, question, sourceType, queries, required = true, successCriteria }) {
  return {
    id,
    beatId,
    question,
    sourceType,
    queries,
    required,
    status: 'planned',
    successCriteria,
    resultSummary: '',
    evidenceItems: [],
  };
}

function makeBeat({
  id,
  role,
  claim,
  slideIntent,
  evidenceNeeded,
  riskChecks = [],
  voiceStyle,
  thumbnailUse = false,
}) {
  return {
    id,
    role,
    claim,
    slideIntent,
    evidenceNeeded,
    riskChecks,
    voiceStyle,
    thumbnailUse,
    evidenceStatus: 'not_checked',
  };
}

function buildGenericPlan(input) {
  const editable = parseEditableBrief(input.brief);
  if (editable) return buildPlanFromEditableBrief(input, editable);

  const topic = input.title || input.notes[0] || '未設定トピック';
  const centralQuestion = topic.endsWith('？') || topic.endsWith('?')
    ? topic
    : `${topic}で、本当に見るべきポイントは何か？`;

  const beats = [
    makeBeat({
      id: 'beat_01_hook',
      role: 'hook',
      claim: '視聴者が最初に引っかかる異常値・違和感を提示する',
      slideIntent: '冒頭15秒で「なぜ？」を作る',
      evidenceNeeded: ['話題の事実確認', '異常値として見せられる数字または比較対象'],
      riskChecks: ['煽りだけで事実確認が弱くなっていないか'],
      voiceStyle: 'fast_urgent',
      thumbnailUse: true,
    }),
    makeBeat({
      id: 'beat_02_context',
      role: 'context',
      claim: 'この話題がなぜ今重要なのかを整理する',
      slideIntent: 'ニュース概要ではなく、問いへの前提を作る',
      evidenceNeeded: ['直近ニュース', '関係者コメント', '時系列'],
      riskChecks: ['関連情報を並べるだけになっていないか'],
      voiceStyle: 'clear_context',
    }),
    makeBeat({
      id: 'beat_03_evidence',
      role: 'evidence',
      claim: '問いへの答えを支える主要データを提示する',
      slideIntent: '主張を数字・比較・出典で支える',
      evidenceNeeded: ['定量データ', '比較対象', '一次または信頼できる二次ソース'],
      riskChecks: ['このデータで言える範囲を超えて断定していないか'],
      voiceStyle: 'calm_precise',
    }),
    makeBeat({
      id: 'beat_04_counterpoint',
      role: 'counterpoint',
      claim: '反論されそうな点を先に処理する',
      slideIntent: 'フェアさを担保して説得力を上げる',
      evidenceNeeded: ['例外', '別解釈', '誤解されやすい事実'],
      riskChecks: ['片方のクラブ・選手に寄りすぎていないか'],
      voiceStyle: 'balanced',
    }),
    makeBeat({
      id: 'beat_05_answer',
      role: 'answer',
      claim: '冒頭の問いに対して明確な答えを返す',
      slideIntent: '視聴後に一文で説明できる結論にする',
      evidenceNeeded: ['前段の証拠と矛盾しない結論'],
      riskChecks: ['結論がぼやけていないか', '言い切りすぎていないか'],
      voiceStyle: 'confident_close',
    }),
  ];

  return buildPlanFromBeats({
    topic,
    centralQuestion,
    thesis: '事実確認後に確定。現段階では、話題の違和感をデータで分解して答える。',
    viewerPromise: 'この動画を見れば、表面的なニュースではなく「なぜそう見えるのか」がわかる。',
    angle: 'question_to_answer',
    beats,
    globalRiskChecks: [
      '中心問いに関係しない小話を入れすぎていないか',
      '出典が弱い情報を断定していないか',
      'サムネと本編の約束がズレていないか',
    ],
    editorialNotes: input.notes,
  });
}

function buildPlanFromEditableBrief(input, editable) {
  const topic = input.title || editable.core || '未設定トピック';
  const points = editable.points.length ? editable.points : ['まず事実を確認する', '背景を整理する', '答えを出す'];
  const chapters = groupPointsIntoChapters(points);
  const beats = [];

  beats.push(makeBeat({
    id: 'beat_01_hook',
    role: 'hook',
    claim: editable.core || `${topic}の核心を提示する`,
    slideIntent: '冒頭で視聴者が見る理由を作る',
    evidenceNeeded: ['話題の事実確認', '最新ニュース'],
    riskChecks: ['事実確認前に断定しない'],
    voiceStyle: 'fast_urgent',
    thumbnailUse: true,
  }));

  chapters.forEach((chapter, idx) => {
    const claim = chapter.points.join(' / ');
    beats.push(makeBeat({
      id: `beat_${String(idx + 2).padStart(2, '0')}_point`,
      role: idx === chapters.length - 1 ? 'evidence' : 'context',
      claim,
      slideIntent: 'ブリーフの論点を章の材料としてまとめ、必要なら複数スライドへ分ける',
      evidenceNeeded: chapter.points.flatMap((point) => [
        `${point}を支えるニュース/データ`,
        `${point}の反証または補足`,
      ]),
      riskChecks: editable.cautions,
      voiceStyle: idx === chapters.length - 1 ? 'calm_precise' : 'clear_context',
    }));
  });

  beats.push(makeBeat({
    id: `beat_${String(chapters.length + 2).padStart(2, '0')}_answer`,
    role: 'answer',
    claim: editable.answer || '冒頭の問いに答える',
    slideIntent: 'ブリーフの答えを、前段の論点から回収する',
    evidenceNeeded: ['前段論点の要約', '答えを安全に言える根拠'],
    riskChecks: editable.cautions,
    voiceStyle: 'confident_close',
    thumbnailUse: true,
  }));

  return buildPlanFromBeats({
    topic,
    centralQuestion: editable.core || `${topic}で何を見るべきか？`,
    thesis: editable.answer || 'ブリーフ編集後に確定。',
    viewerPromise: 'ブリーフの論点に沿って、話題の核心から答えまで整理する。',
    angle: 'editable_brief',
    beats,
    globalRiskChecks: editable.cautions,
    editorialNotes: input.notes,
    humanBrief: buildHumanBriefFromEditable({ editable, centralQuestion: editable.core || `${topic}で何を見るべきか？`, thesis: editable.answer || 'ブリーフ編集後に確定。', chapters }),
  });
}

function groupPointsIntoChapters(points) {
  if (points.length <= 4) return points.map((point) => ({ points: [point] }));

  const chapterCount = Math.min(4, Math.ceil(points.length / 2));
  const chapters = Array.from({ length: chapterCount }, () => ({ points: [] }));
  points.forEach((point, index) => {
    chapters[Math.floor(index * chapterCount / points.length)].points.push(point);
  });
  return chapters.filter((chapter) => chapter.points.length);
}

function buildHumanBriefFromEditable({ editable, centralQuestion, thesis, chapters }) {
  return {
    core: centralQuestion,
    answer: thesis,
    structure: chapters.map((chapter, index) => ({
      no: index + 1,
      label: chapter.points.length > 1 ? `論点${index + 1}: ${chapter.points[0]} ほか` : `論点${index + 1}`,
      role: 'chapter_seed',
      point: chapter.points.join(' / '),
    })),
    cautions: editable.cautions,
  };
}

function buildMadridSpainZeroPlan(input) {
  const beats = [
    makeBeat({
      id: 'beat_01_hook_zero',
      role: 'hook',
      claim: 'スペイン代表からレアル・マドリー所属選手が0人になった',
      slideIntent: '異常値として提示し、視聴者に「なぜ？」を作る',
      evidenceNeeded: ['最新スペイン代表リスト', 'レアル・マドリー所属選手数'],
      riskChecks: ['どの大会・どの招集リストかを明記する', '過去の別招集と混同しない'],
      voiceStyle: 'fast_urgent',
      thumbnailUse: true,
    }),
    makeBeat({
      id: 'beat_02_2010_contrast',
      role: 'contrast',
      claim: '2010年のスペイン黄金期は、バルサとマドリーが代表の中核だった',
      slideIntent: '現在との落差を作る。半々と断定せず「二大クラブが背骨」と表現する',
      evidenceNeeded: ['2010年W杯スペイン代表の所属クラブ一覧', 'バルサ・マドリー所属人数'],
      riskChecks: ['「半々」と雑に言わない', 'カシージャス、ラモス、アロンソ等の当時所属を確認'],
      voiceStyle: 'dramatic_contrast',
    }),
    makeBeat({
      id: 'beat_03_barca_pipeline',
      role: 'evidence',
      claim: 'バルサは若いスペイン代表の顔を抱えている',
      slideIntent: '現代表の人材供給ルートとしてバルサ側を説明する',
      evidenceNeeded: ['現スペイン代表のバルサ所属/バルサ経由選手', 'ヤマル、ガビ、クバルシ、ペドリの経歴'],
      riskChecks: ['ペドリをカンテラ産と誤認しない', 'メッシはスペイン代表文脈では補助的に扱う'],
      voiceStyle: 'clear_context',
    }),
    makeBeat({
      id: 'beat_04_madrid_market',
      role: 'evidence',
      claim: 'マドリーは世界最高級の完成済みタレントを外部から獲得する比重が高い',
      slideIntent: '育成失敗ではなくクラブ戦略の違いとして見せる',
      evidenceNeeded: ['現マドリー主力の国籍・獲得元', 'ベリンガム、ヴィニシウス、ロドリゴ、エムバペ等の移籍経緯'],
      riskChecks: ['ラウールを「買った宝石」に分類しない', 'スペイン人軽視と断定しない'],
      voiceStyle: 'calm_precise',
    }),
    makeBeat({
      id: 'beat_05_counterpoint',
      role: 'counterpoint',
      claim: 'これはマドリーが弱くなった話ではなく、代表との接続が薄く見える話',
      slideIntent: '反論を先回りし、マドリー批判だけに見えないようにする',
      evidenceNeeded: ['マドリーの競技成績', 'スペイン人所属選手・有望株の存在', '代表監督の選考基準コメント'],
      riskChecks: ['バルサ礼賛だけに寄らない', 'クラブ成功と代表供給を混同しない'],
      voiceStyle: 'balanced',
    }),
    makeBeat({
      id: 'beat_06_answer',
      role: 'answer',
      claim: '結論は、クラブ戦略とスペイン代表の人材供給ルートがズレたということ',
      slideIntent: '冒頭の問いを回収し、視聴者が持ち帰れる一文にする',
      evidenceNeeded: ['前段5beatの要約', '代表とクラブ戦略の関係を示す整理'],
      riskChecks: ['「国内タレントが育たなかった」と断定しない', '強い一文だがフェアに締める'],
      voiceStyle: 'confident_close',
      thumbnailUse: true,
    }),
  ];

  return buildPlanFromBeats({
    topic: input.title || 'スペイン代表、レアル・マドリー所属選手0人',
    centralQuestion: 'なぜスペイン代表からレアル・マドリー所属選手が消えたのか？',
    thesis: 'マドリーが弱くなったのではなく、クラブ戦略とスペイン代表の人材供給ルートがズレた。',
    viewerPromise: '2010年との比較から、スペイン代表と二大クラブの関係変化がわかる。',
    angle: 'club_strategy_vs_national_pipeline',
    beats,
    globalRiskChecks: [
      'ペドリをカンテラ産と誤認しない',
      'ラウールを外部から買ったスター扱いしない',
      '2010年を「マドリーとバルサ半々」と雑に言わない',
      'マドリー育成失敗と断定しない',
      'バルサ礼賛だけに寄せない',
    ],
    editorialNotes: [
      ...input.notes,
      'サムネ候補: 「マドリー0人」「なぜ消えた？」「2010年は中核」',
    ],
  });
}

function buildPlanFromBeats({
  topic,
  centralQuestion,
  thesis,
  viewerPromise,
  angle,
  beats,
  globalRiskChecks = [],
  editorialNotes = [],
  humanBrief = null,
}) {
  const researchTasks = [];
  beats.forEach((beat, i) => {
    beat.evidenceNeeded.forEach((need, j) => {
      researchTasks.push(makeResearchTask({
        id: `rt_${String(i + 1).padStart(2, '0')}_${String(j + 1).padStart(2, '0')}`,
        beatId: beat.id,
        question: need,
        sourceType: inferSourceType(need),
        queries: suggestQueries(topic, need),
        required: beat.role !== 'counterpoint' || j === 0,
        successCriteria: `「${beat.claim}」を安全に言える範囲が判断できること`,
      }));
    });
  });

  const toc = beats.map((beat) => ({
    beatId: beat.id,
    label: tocLabelForBeat(beat),
  }));

  const slidePlan = buildSlidePlanFromBeats(beats);

  return {
    version: 'v3-argument-plan-prototype',
    createdAt: nowIso(),
    topic,
    centralQuestion,
    thesis,
    viewerPromise,
    angle,
    toc,
    beats,
    evidencePlan: {
      researchTasks,
      gateRules: [
        'required=true の証拠が未確認なら断定表現を禁止する',
        'claim と evidence の対応が弱い場合は safeClaim に落とす',
        '小話は centralQuestion に貢献する場合だけ採用する',
      ],
    },
    humanBrief: humanBrief || buildHumanBrief({ centralQuestion, thesis, beats, globalRiskChecks }),
    slidePlan,
    thumbnailPlan: buildThumbnailPlan({ centralQuestion, thesis, beats }),
    voicePlan: buildVoicePlan(beats),
    globalRiskChecks,
    editorialNotes,
  };
}

function buildSlidePlanFromBeats(beats) {
  const slides = [];

  beats.forEach((beat) => {
    const evidence = [...new Set(beat.evidenceNeeded || [])];
    const chunks = evidence.length > 4
      ? [evidence.slice(0, Math.ceil(evidence.length / 2)), evidence.slice(Math.ceil(evidence.length / 2))]
      : [evidence];

    chunks.forEach((chunk, chunkIndex) => {
      const split = chunks.length > 1;
      slides.push({
        id: `slide_${String(slides.length + 1).padStart(2, '0')}`,
        beatId: beat.id,
        role: beat.role,
        slideType: split ? `${slideTypeForRole(beat.role)}_part${chunkIndex + 1}` : slideTypeForRole(beat.role),
        headline: split ? `${tocLabelForBeat(beat)} ${chunkIndex + 1}` : tocLabelForBeat(beat),
        claim: beat.claim,
        visualIntent: split
          ? `${beat.slideIntent}。このスライドでは材料${chunkIndex + 1}だけを見る`
          : beat.slideIntent,
        dataSlots: chunk.map((need) => ({
          label: need,
          binding: '',
          required: true,
        })),
        ttsStyle: beat.voiceStyle,
        parentBeatRole: beat.role,
      });
    });
  });

  return slides;
}

function buildHumanBrief({ centralQuestion, thesis, beats, globalRiskChecks }) {
  return {
    core: centralQuestion,
    answer: thesis,
    structure: beats.map((beat, index) => ({
      no: index + 1,
      label: tocLabelForBeat(beat),
      role: beat.role,
      point: beat.claim,
    })),
    cautions: globalRiskChecks,
  };
}

function inferSourceType(need) {
  const s = String(need);
  if (/リスト|所属|人数|国籍|経歴|移籍|成績|有望株/.test(s)) return 'web_or_wiki';
  if (/コメント|発言|監督/.test(s)) return 'news';
  if (/反応|Reddit|海外/.test(s)) return 'reddit';
  return 'web';
}

function suggestQueries(topic, need) {
  const base = String(topic || '').replace(/[「」]/g, '');
  const n = String(need || '');
  const queries = [
    `${base} ${n}`,
  ];
  if (/2010/.test(n)) queries.push('Spain 2010 World Cup squad club Barcelona Real Madrid');
  if (/代表リスト|所属選手数/.test(n)) queries.push('Spain squad no Real Madrid players');
  if (/ヤマル|ガビ|クバルシ|ペドリ/.test(n)) queries.push('Spain squad Barcelona players Yamal Gavi Cubarsi Pedri background');
  if (/ベリンガム|ヴィニシウス|ロドリゴ|エムバペ/.test(n)) queries.push('Real Madrid squad key players nationality transfer history Bellingham Vinicius Rodrygo Mbappe');
  return [...new Set(queries)].slice(0, 3);
}

function tocLabelForBeat(beat) {
  const map = {
    hook: 'まず何が異常なのか',
    contrast: '昔と何が変わったのか',
    context: 'なぜ今重要なのか',
    evidence: shortClaim(beat.claim),
    counterpoint: 'それでも断定できない点',
    answer: '結論',
  };
  return map[beat.role] || shortClaim(beat.claim);
}

function shortClaim(claim) {
  const s = String(claim || '');
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
}

function slideTypeForRole(role) {
  return {
    hook: 'opening_shock',
    contrast: 'before_after',
    context: 'context_map',
    evidence: 'evidence_card',
    counterpoint: 'balanced_note',
    answer: 'answer_card',
  }[role] || 'evidence_card';
}

function buildThumbnailPlan({ centralQuestion, beats }) {
  const hook = beats.find((b) => b.thumbnailUse) || beats[0];
  return {
    templateFamily: 'question_or_shift',
    mainText: centralQuestion.replace(/^なぜ/, 'なぜ').replace(/？$/, '?'),
    subText: hook?.claim || '',
    preferredTemplates: ['WHY型', 'SHIFT型', 'VS型'],
    avoid: ['説明文を詰め込みすぎる', '本編で答えない煽りにする'],
  };
}

function buildVoicePlan(beats) {
  return {
    defaultNarrator: '解説者',
    heatLayer: 'リネカ',
    styles: beats.map((beat) => ({
      beatId: beat.id,
      style: beat.voiceStyle,
      instruction: voiceInstruction(beat.voiceStyle),
    })),
  };
}

function voiceInstruction(style) {
  return {
    fast_urgent: '冒頭用。短く、強く、テンポを上げて異常値を叩く。',
    dramatic_contrast: '過去との落差をドラマとして見せる。大げさにしすぎない。',
    clear_context: '前提整理。情報を詰めすぎず明快に読む。',
    calm_precise: 'データ解説。落ち着いて、数字と意味をはっきり分ける。',
    balanced: '反論処理。フェアで慎重な言い方にする。',
    confident_close: '結論。熱量を戻して、一文で締める。',
  }[style] || '自然なサッカー解説として読む。';
}

function createArgumentPlan(rawInput = {}) {
  const input = buildTopicInput(rawInput);
  input.brief = rawInput.brief || null;
  if (parseEditableBrief(input.brief)) return buildPlanFromEditableBrief(input, parseEditableBrief(input.brief));
  const haystack = `${input.title}\n${input.memo}\n${input.sourceComments.join('\n')}`;
  const matched = DEFAULT_TOPIC_PATTERNS.find((p) => p.test.test(haystack));
  return matched ? matched.build(input) : buildGenericPlan(input);
}

module.exports = {
  createArgumentPlan,
  buildTopicInput,
};
