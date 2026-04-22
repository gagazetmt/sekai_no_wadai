const fs = require('fs');
const src = fs.readFileSync('soccer_yt_server_v2.js', 'utf8');
const lines = src.split('\n');
for (let i = 871; i < lines.length; i++) {
  const line = lines[i];
  // エスケープ済み \` を除去してから生のバッククォートを数える
  const stripped = line.replace(/\\`/g, '');
  const cnt = (stripped.match(/`/g) || []).length;
  if (cnt > 0 && cnt % 2 !== 0) {
    console.log('LINE ' + (i+1) + ' [bt=' + cnt + ']: ' + line.trim().slice(0, 100));
  }
}
console.log('scan done');
