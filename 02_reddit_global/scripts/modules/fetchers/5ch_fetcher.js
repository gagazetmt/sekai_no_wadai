// 5ch.sc スクレイパー（2ch.sc ミラー経由）
// CP932エンコーディング + TLS rejectUnauthorized:false で接続

const axios  = require('axios');
const https  = require('https');
const iconv  = require('iconv-lite');

const agent = new https.Agent({ rejectUnauthorized: false });
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ja-JP,ja;q=0.9',
};

const MIN_COUNT   = 30;   // 最低レス数
const MAX_THREADS = 15;   // 板ごとの最大取得スレ数（dedup後の選定母数を増やすため拡張: 6→15）
const MAX_COMMENTS = 12;  // 取得するコメント数

// 除外タイトルパターン（カテゴリ別に配列化、可読性優先）
//   タイトルがいずれかにマッチしたら NG。動画化に向かない継続スレ・議論スレ・応援スレを弾く。
const NG_PATTERNS = [
  // ── センシティブ
  /レイプ|殺|刺し|死体/,
  /謎の|羽山|あんかけ|餌后|口ｄ|スポーツである/,

  // ── スレッド番号系（パート・Vol・No・★・☆）
  /(part|vol)\s*\.?\s*\d+/i,
  /パート\s*\d+/,
  /No\.?\s*\d+/,
  /[★☆]\s*\d+/,

  // ── 末尾が「数字」または「数字+装飾記号」スレ番号慣習
  //    "1000ゴール" など数字+単位のコンテンツは弾かないよう、必ず末尾$ベース判定
  /\s\d+\s*$/,                                            // 末尾「 1267」
  /\d+\s*[†◇◆★☆【】♪♫\?\!\(\)〓■□╋\+＋]+\s*[【】♪♫\(\)\+＋\s]*$/, // 「1267╋＋」「1267◇◆」
  /[\.！\!]\d+\s*$/,                                      // 「.17」「！2」
  /代表\s*\d+\s*$/,                                        // 「代表1」（応援スレ命名）
  /\d+\s*【[^】]*】\s*$/,                                   // 「☆2【ワッチョイ無】」末尾装飾

  // ── 継続スレ・冗長スレ系（日本語）
  /応援|ファンスレ|推しスレ|雑談スレ|質問スレ|総合スレ|総合雑談|チラ裏|ネタスレ|実況スレ|TV実況|放送実況|なんJ|なんG/,

  // ── 海外応援スレ用語（クラブ・代表サポーター用）
  /The Blues|Forza|Vamos|Avanti|Albicelestes|Selec[aã]o|Furia|Hala\s|Gunners|Reds\b|Wir\sSind/i,
];

function isNgTitle(title) {
  if (!title) return true;
  return NG_PATTERNS.some(re => re.test(title));
}

// 板設定
const BOARDS = [
  {
    id:   'football',
    name: '海外サッカー板',
    url:  'https://qb5.2ch.sc/football/',
    filter: null,  // 板自体がサッカー専用なのでフィルターなし
  },
  {
    id:   'eleven',
    name: '日本代表板',
    url:  'https://lavender.2ch.sc/eleven/',
    // なでしこ/女子/WEリーグを除外し、男子代表関連を優先
    filter: t => !/なでしこ|女子|ＷＥ|WE|レディース|くのいち/i.test(t),
  },
  {
    id:   'mnewsplus',
    name: 'スポーツニュース板',
    url:  'https://hayabusa9.2ch.sc/mnewsplus/',
    filter: t => /サッカー|代表|リーグ|CL|欧州|プレミア|移籍|W杯|ワールドカップ|ゴール|久保|三笘|堂安|前田|古橋|鎌田|板倉|遠藤|伊東|上田|南野/i.test(t),
  },
];

async function get(url) {
  const r = await axios.get(url, {
    httpsAgent: agent, headers: HEADERS, timeout: 12000, responseType: 'arraybuffer',
  });
  return iconv.decode(Buffer.from(r.data), 'cp932');
}

function parseSubject(text, filterFn) {
  return text.trim().split('\n').map(line => {
    const sep  = line.indexOf('<>');
    const file = line.slice(0, sep);
    const rest = line.slice(sep + 2);
    const m    = rest.match(/^(.*)\s\((\d+)\)$/);
    return {
      threadId: file.replace('.dat', ''),
      title:    m ? m[1].trim() : rest.trim(),
      count:    parseInt((m && m[2]) || '0'),
    };
  }).filter(t =>
    t.threadId && t.threadId !== '9990000001' &&
    t.count >= MIN_COUNT &&
    !isNgTitle(t.title) &&
    (!filterFn || filterFn(t.title))
  ).sort((a, b) => b.count - a.count);
}

function parseDat(text) {
  return text.trim().split('\n').map((line, i) => {
    const p    = line.split('<>');
    const body = (p[3] || '')
      .replace(/<br>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/https?:\/\/\S+/g, '[URL]')
      .replace(/!extend:[^\n]+\n?/g, '')
      .trim();
    return { no: i + 1, body };
  });
}

async function fetchBoard(board) {
  const results = [];
  try {
    const subj    = await get(board.url + 'subject.txt');
    const threads = parseSubject(subj, board.filter).slice(0, MAX_THREADS);

    for (const t of threads) {
      await new Promise(r => setTimeout(r, 1200));
      try {
        const dat   = await get(board.url + 'dat/' + t.threadId + '.dat');
        const posts = parseDat(dat);

        const selftext = (posts[0]?.body || '').slice(0, 400);

        const comments = posts.slice(1).reduce((acc, p) => {
          if (acc.length >= MAX_COMMENTS) return acc;
          const clean = p.body.replace(/\n/g, ' ').trim();
          if (clean.length > 10 && !/^\[URL\]$/.test(clean)) {
            acc.push({ body: clean.slice(0, 200), score: MAX_COMMENTS - acc.length });
          }
          return acc;
        }, []);

        results.push({
          threadId: t.threadId,
          boardId:  board.id,
          boardName: board.name,
          title:    t.title,
          count:    t.count,
          url:      board.url + 'read.cgi/' + t.threadId,
          selftext,
          comments,
        });
      } catch (e) {
        console.warn(`[5ch] dat取得失敗 (${t.title}): ${e.message}`);
      }
    }
  } catch (e) {
    console.warn(`[5ch] board取得失敗 (${board.name}): ${e.message}`);
  }
  return results;
}

// candidates_YYYY-MM-DD.json 形式に変換
function toCandidate(thread, iso) {
  const id = `5ch_${thread.boardId}_${thread.threadId}`;
  return {
    id,
    source:      '5ch',
    boardId:     thread.boardId,
    boardName:   thread.boardName,
    title:       thread.title,
    titleJa:     thread.title,
    url:         thread.url,
    permalink:   null,
    score:       thread.count,      // レス数をスコアとして扱う
    numComments: thread.comments.length,
    created_utc: Math.floor(Date.now() / 1000),
    selftext:    thread.selftext,
    comments:    thread.comments,
    added_at:    iso,
  };
}

async function fetch5chCandidates(iso) {
  console.log('📡 5ch スクレイピング開始...');
  const all = [];
  for (const board of BOARDS) {
    console.log(`  板: ${board.name}`);
    const threads = await fetchBoard(board);
    all.push(...threads);
    await new Promise(r => setTimeout(r, 1500));
  }
  const candidates = all.map(t => toCandidate(t, iso));
  console.log(`✅ 5ch: ${candidates.length}件取得`);
  return candidates;
}

module.exports = { fetch5chCandidates };
