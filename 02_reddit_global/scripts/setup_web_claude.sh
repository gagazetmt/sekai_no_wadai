#!/bin/bash
# scripts/setup_web_claude.sh
# Web Claude（claude.ai/code）クラウド VM の初期化スクリプト本体。
# WEB_CLAUDE_MIGRATION.md の Setup Script と同内容。
#
# 使い方:
#   - claude.ai/code の Settings → Setup Script に貼り付け
#   - もしくは VM 内で直接: bash scripts/setup_web_claude.sh

set -e

echo "[setup] Web Claude environment init..."

# ─── Python + curl-cffi（SofaScore 突破に必要） ──
pip3 install --break-system-packages curl-cffi 2>/dev/null || true

# ─── VPS SSH 鍵を ~/.ssh/ に展開 ──
# Web Claude の環境変数 UI は KEY=VALUE 1行ずつしか登録できないため、
# 鍵は base64 で1行化して VPS_SSH_KEY_B64 に入れる（旧 VPS_SSH_KEY も互換維持）
if [ -n "$VPS_SSH_KEY_B64" ] || [ -n "$VPS_SSH_KEY" ]; then
  mkdir -p ~/.ssh
  if [ -n "$VPS_SSH_KEY_B64" ]; then
    echo "$VPS_SSH_KEY_B64" | base64 -d > ~/.ssh/web_claude_vps
  else
    echo "$VPS_SSH_KEY" > ~/.ssh/web_claude_vps
  fi
  chmod 600 ~/.ssh/web_claude_vps

  # ssh config: 'ssh vps' で繋がるエイリアス
  cat > ~/.ssh/config <<EOF
Host vps
  HostName ${VPS_HOST:-37.60.224.54}
  User ${VPS_USER:-root}
  IdentityFile ~/.ssh/web_claude_vps
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
EOF
  chmod 600 ~/.ssh/config

  echo "[setup] ✓ VPS ssh configured (use 'ssh vps' to connect)"
else
  echo "[setup] ⚠ VPS_SSH_KEY env var not set — VPS ssh will not work"
fi

# ─── .env を VPS から同期（マスター = VPS） ──
if ssh -o BatchMode=yes vps "echo ok" >/dev/null 2>&1; then
  scp vps:/root/sekai_no_wadai/02_reddit_global/.env 02_reddit_global/.env
  echo "[setup] ✓ .env synced from VPS"
else
  echo "[setup] ⚠ VPS ssh not reachable — env vars from Anthropic Settings will be used"
fi

# ─── Node 依存（02_reddit_global 配下） ──
if [ -d 02_reddit_global ]; then
  cd 02_reddit_global
  npm install --no-audit --no-fund 2>&1 | tail -5
  cd ..
fi

echo "[setup] Complete!"
