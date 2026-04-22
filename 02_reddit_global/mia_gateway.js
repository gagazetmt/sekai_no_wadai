// mia_gateway.js
// Windows側で実行し、スマホ(Tailscale)からのアクセスをWSLのttydに中継する
// 管理者権限不要のTCPプロキシ

const net = require('net');
const { execSync } = require('child_process');

const LISTEN_PORT = 7681;
const LISTEN_ADDR = '0.0.0.0';
const TARGET_PORT = 7681;

// WSLのIPを動的に取得（起動のたびに変わるので毎回解決）
let TARGET_ADDR;
try {
  TARGET_ADDR = execSync('wsl hostname -I', { encoding: 'utf8' }).trim().split(' ')[0];
  console.log(`[gateway] WSL IP: ${TARGET_ADDR}`);
} catch (e) {
  TARGET_ADDR = '172.19.96.244'; // フォールバック
  console.log(`[gateway] WSL IP取得失敗、フォールバック使用: ${TARGET_ADDR}`);
}

const server = net.createServer((socket) => {
    console.log(`[gateway] スマホから接続がありました: ${socket.remoteAddress}`);
    
    // WSL側のttydに繋ぐ
    const target = net.connect(TARGET_PORT, TARGET_ADDR, () => {
        console.log(`[gateway] WSLのミアに接続成功`);
    });

    // 通信を双方向に流す（パイプ）
    socket.pipe(target);
    target.pipe(socket);

    socket.on('error', (err) => console.error('[gateway] Socket Error:', err.message));
    target.on('error', (err) => console.error('[gateway] Target Error:', err.message));
});

server.listen(LISTEN_PORT, LISTEN_ADDR, () => {
    console.log(`\n🚀 Mia Gateway が起動したよ！`);
    console.log(`📱 スマホでここを開いて： http://100.115.192.114:${LISTEN_PORT}`);
    console.log(`🔒 ID: enke / PASS: viran を入れてね！\n`);
});
