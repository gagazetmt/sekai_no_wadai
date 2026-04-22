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

function parseSubject(text) {
  return text.trim().split('\n').map(line => {
    const [file, rest] = line.split('<>');
    const m = rest && rest.match(/^(.*)\s\((\d+)\)$/);
    return {
      id: file && file.replace('.dat', ''),
      title: m ? m[1].trim() : (rest || '').trim(),
      count: parseInt((m && m[2]) || '0'),
    };
  }).filter(t =>
    t.id && t.id !== '9990000001' && t.count >= 10 &&
    !/レイプ|殺|刺し|死体|ドーピング|謎の|羽山|あんかけ|餌后|口ｄ/i.test(t.title)
  ).sort((a, b) => b.count - a.count);
}

function parseDat(text) {
  return text.trim().split('\n').map((line, i) => {
    const p = line.split('<>');
    const body = (p[3] || '').replace(/<br>/gi, '\n').replace(/<[^>]+>/g, '').trim();
    return { no: i + 1, body };
  });
}

async function fetchBoard(boardUrl, boardName, count) {
  console.log('\n' + '='.repeat(60));
  console.log('【板】' + boardName);
  console.log('='.repeat(60));

  const subj = await get(boardUrl + 'subject.txt');
  const threads = parseSubject(subj).slice(0, count);

  if (!threads.length) { console.log('対象スレなし'); return; }

  for (const t of threads) {
    console.log('\n【スレタイ】' + t.title + '  (' + t.count + 'res)');
    await new Promise(r => setTimeout(r, 1200));
    try {
      const dat = await get(boardUrl + 'dat/' + t.id + '.dat');
      const posts = parseDat(dat);
      console.log('【>>1 本文】');
      console.log((posts[0] && posts[0].body || '').slice(0, 300));
      console.log('【コメント抜粋】');
      posts.slice(1, 10).forEach(p => {
        if (p.body && p.body.length > 8)
          console.log('  >>' + p.no + ' ' + p.body.replace(/\n/g, ' ').slice(0, 100));
      });
    } catch (e) {
      console.log('dat取得失敗:', e.message);
    }
  }
}

(async () => {
  await fetchBoard('https://lavender.2ch.sc/oversea/', '海外サッカー板', 2);
  await new Promise(r => setTimeout(r, 1500));
  await fetchBoard('https://lavender.2ch.sc/eleven/', '日本代表板', 2);
})().catch(e => console.error('ERROR:', e.message));
