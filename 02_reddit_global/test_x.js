// X画像取得デバッグ用（確認後削除）
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');
const API_KEY = process.env.TWITTER_API_IO_KEY;
console.log('APIキー設定:', !!API_KEY);

async function test() {
  const res = await axios.get('https://api.twitterapi.io/twitter/tweet/advanced_search', {
    headers: { 'X-API-Key': API_KEY },
    params: { query: 'from:DFB_Team filter:images -filter:retweets', queryType: 'Top' },
    timeout: 12000
  });
  const tweets = res.data?.tweets || res.data?.data?.tweets || res.data?.data || [];
  console.log('tweets数:', tweets.length);
  for (const t of tweets.slice(0, 2)) {
    const media = t.extendedEntities?.media || [];
    console.log('media件数:', media.length);
    for (const m of media) {
      const type = (m.type || '').toLowerCase();
      const url  = m.media_url_https;
      console.log('  type:', type, '/ url:', url?.slice(0, 60));
      if (type === 'photo' && url) {
        try {
          const r = await axios.get(url + '?name=large', { responseType: 'arraybuffer', timeout: 12000 });
          console.log('  ダウンロードOK:', r.data.byteLength, 'bytes');
        } catch(e) {
          console.log('  ダウンロードFAIL:', e.message);
        }
      }
    }
  }
}
test().catch(console.error);
