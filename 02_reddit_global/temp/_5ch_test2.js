const axios = require('axios');
const https = require('https');
const iconv = require('iconv-lite');

const agent = new https.Agent({ rejectUnauthorized: false });
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'ja-JP,ja;q=0.9',
};

async function get(url) {
  const r = await axios.get(url, { httpsAgent: agent, headers: HEADERS, timeout: 10000, responseType: 'arraybuffer' });
  return iconv.decode(Buffer.from(r.data), 'cp932');
}

function parseSubject(text, filterFn) {
  return text.trim().split('\n').map(line => {
    const sep = line.indexOf('<>');
    const file = line.slice(0, sep);
    const rest = line.slice(sep + 2);
    const m = rest.match(/^(.*)\s\((\d+)\)$/);
    return {
      id: file.replace('.dat', ''),
      title: m ? m[1].trim() : rest.trim(),
      count: parseInt((m && m[2]) || '0'),
    };
  }).filter(t =>
    t.id && t.id !== '9990000001' && t.count >= 50 &&
    !/レイプ|殺|刺し|死体|ドーピング|謎の|羽山|あんかけ|餌后|口ｄ|スポーツである/i.test(t.title) &&
    (!filterFn || filterFn(t.title))
  ).sort((a, b) => b.count - a.count);
}

function parseDat(text) {
  return text.trim().split('\n').map((line, i) => {
    const p = line.split('<>');
    const body = (p[3] || '').replace(/<br>/gi, '\n').replace(/<[^>]+>/g, '').replace(/https?:\/\/\S+/g, '[URL]').trim();
    return { no: i + 1, body };
  });
}

async function fetchBoard(baseUrl, boardName, filterFn, count) {
  console.log('\n' + '='.repeat(62));
  console.log('【板】' + boardName);
  console.log('='.repeat(62));

  const subj = await get(baseUrl + 'subject.txt');
  const threads = parseSubject(subj, filterFn).slice(0, count);

  if (!threads.length) { console.log('対象スレなし'); return; }

  for (const t of threads) {
    console.log('\n【スレタイ】' + t.title + '  (' + t.count + 'res)');
    await new Promise(r => setTimeout(r, 1200));
    try {
      const dat = await get(baseUrl + 'dat/' + t.id + '.dat');
      const posts = parseDat(dat);
      console.log('【>>1 本文（先頭250字）】');
      const body1 = (posts[0] && posts[0].body || '').replace(/!extend:[^\n]+\n/g, '').trim();
      console.log(body1.slice(0, 250));
      console.log('【コメント抜粋（2〜15番から有意なもの）】');
      let shown = 0;
      posts.slice(1, 20).forEach(p => {
        if (shown >= 7) return;
        const clean = p.body.replace(/\n/g, ' ').trim();
        if (clean.length > 10 && !/^\[URL\]$/.test(clean))  {
          console.log('  >>' + p.no + ' ' + clean.slice(0, 110));
          shown++;
        }
      });
    } catch (e) {
      console.log('dat取得失敗:', e.message);
    }
  }
}

const soccerKeyword = t => /サッカー|代表|リーグ|CL|欧州|プレミア|移籍|W杯|ワールドカップ|ゴール|選手|監督|クラブ|チャンピオン|バロン|南野|久保|三笘|堂安|前田|古橋|鎌田|板倉|遠藤|伊東|上田|町田/i.test(t);

(async () => {
  // ① 海外サッカー板（football）
  await fetchBoard('https://qb5.2ch.sc/football/', '海外サッカー板（qb5/football）', null, 2);
  await new Promise(r => setTimeout(r, 1500));

  // ② 日本代表板（eleven）からサッカー関連
  await fetchBoard('https://lavender.2ch.sc/eleven/', '日本代表板（eleven）', null, 2);
  await new Promise(r => setTimeout(r, 1500));

  // ③ スポーツニュース板からサッカー記事だけフィルタ
  await fetchBoard('https://hayabusa9.2ch.sc/mnewsplus/', 'スポーツニュース板（サッカー関連のみ）', soccerKeyword, 2);
})().catch(e => console.error('ERROR:', e.message));
