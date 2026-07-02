const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadAccounts, getActiveAccount } = require('./accounts');
const { launchBrowser, prepPage, ensureLoggedIn } = require('./session_manager');
const { runCheck } = require('./ana_checker');
const { pushLineMessage } = require('./line_notifier');
const { loadState, saveState } = require('./state_store');
const { randomInt, sleep } = require('./human_delay');

const TARGETS_PATH = path.join(__dirname, '..', 'config', 'watch_targets.json');
const LOG_FILE = path.join(__dirname, '..', 'logs', 'watcher.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function loadTargets() {
  if (!fs.existsSync(TARGETS_PATH)) {
    throw new Error(
      `${TARGETS_PATH} が見つかりません。config/watch_targets.example.json をコピーして作成してください。`
    );
  }
  return JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf-8'));
}

async function runOnce() {
  const accounts = loadAccounts();
  const { account } = getActiveAccount(accounts);
  const targets = loadTargets();
  const state = loadState();

  log(`チェック開始 (account=${account.id}, targets=${targets.length})`);

  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await prepPage(page);
    const loginResult = await ensureLoggedIn(page, account);
    log(`ログイン確認OK (freshLogin=${loginResult.freshLogin})`);

    for (const target of targets) {
      await sleep(randomInt(800, 2500));
      let result;
      try {
        result = await runCheck(page, target);
      } catch (err) {
        log(`チェック失敗 target=${target.id}: ${err.message}`);
        continue;
      }

      if (result.mode === 'capture') {
        log(`キャリブレーションモード target=${target.id} -> ${result.captureDir}`);
        continue;
      }

      const prevAvailable = state[target.id] ? state[target.id].available : false;
      state[target.id] = { available: result.available, checkedAt: result.checkedAt };

      log(`target=${target.id} available=${result.available}`);

      if (result.available && !prevAvailable) {
        const text = `【特典航空券に空きが出たよ！】\n${target.label}\n${target.departureAirport}→${target.arrivalAirport} ${target.date}\n急いでANAサイトで確認・予約してね！`;
        try {
          await pushLineMessage(text);
          log(`LINE通知送信 target=${target.id}`);
        } catch (err) {
          log(`LINE通知失敗 target=${target.id}: ${err.message}`);
        }
      }
    }

    saveState(state);
  } finally {
    await browser.close();
  }
}

async function mainLoop() {
  const minSec = Number(process.env.CHECK_INTERVAL_MIN_SEC || 900);
  const maxSec = Number(process.env.CHECK_INTERVAL_MAX_SEC || 1800);

  for (;;) {
    try {
      await runOnce();
    } catch (err) {
      log(`実行エラー: ${err.stack || err.message}`);
    }
    const waitSec = randomInt(minSec, maxSec);
    log(`次回チェックまで ${waitSec} 秒待機`);
    await sleep(waitSec * 1000);
  }
}

async function main() {
  const once = process.argv.includes('--once');
  if (once) {
    await runOnce();
    return;
  }
  await mainLoop();
}

main().catch((err) => {
  log(`致命的エラー: ${err.stack || err.message}`);
  process.exit(1);
});
