const fs = require('fs');
const path = require('path');
const { randomInt } = require('./human_delay');

const ROTATION_STATE_PATH = path.join(__dirname, '..', 'data', 'rotation_state.json');

function loadAccounts() {
  const accounts = [];
  let i = 1;
  while (process.env[`ANA_ACCOUNT_${i}_CUSNUM`]) {
    accounts.push({
      id: `account_${i}`,
      cusnum: process.env[`ANA_ACCOUNT_${i}_CUSNUM`],
      password: process.env[`ANA_ACCOUNT_${i}_PASSWORD`],
    });
    i += 1;
  }
  if (accounts.length === 0) {
    throw new Error('ANA_ACCOUNT_1_CUSNUM が未設定です（.env を確認してください）');
  }
  return accounts;
}

function loadRotationState() {
  if (!fs.existsSync(ROTATION_STATE_PATH)) return null;
  return JSON.parse(fs.readFileSync(ROTATION_STATE_PATH, 'utf-8'));
}

function saveRotationState(state) {
  fs.mkdirSync(path.dirname(ROTATION_STATE_PATH), { recursive: true });
  fs.writeFileSync(ROTATION_STATE_PATH, JSON.stringify(state, null, 2));
}

function pickNextAccountIndex(accountsLength, currentIndex) {
  if (accountsLength === 1) return 0;
  let next = currentIndex;
  while (next === currentIndex) {
    next = randomInt(0, accountsLength - 1);
  }
  return next;
}

// 現在アクティブなアカウントを返す。セッション有効期限(3〜6時間でランダム決定)を
// 過ぎていたら、別アカウントへローテーションする。
function getActiveAccount(accounts) {
  const minH = Number(process.env.SESSION_MIN_HOURS || 3);
  const maxH = Number(process.env.SESSION_MAX_HOURS || 6);
  const now = Date.now();

  let state = loadRotationState();

  if (!state || now >= state.sessionExpiresAt) {
    const prevIndex = state ? state.accountIndex : -1;
    const nextIndex = pickNextAccountIndex(accounts.length, prevIndex);
    const sessionHours = randomInt(minH * 60, maxH * 60) / 60;
    state = {
      accountIndex: nextIndex,
      sessionStartedAt: now,
      sessionExpiresAt: now + sessionHours * 60 * 60 * 1000,
      sessionHours,
    };
    saveRotationState(state);
  }

  return { account: accounts[state.accountIndex], state };
}

module.exports = { loadAccounts, getActiveAccount };
