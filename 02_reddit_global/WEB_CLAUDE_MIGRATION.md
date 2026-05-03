# Claude Code on the Web 移行手順書

このドキュメントは、ローカル PC 上の Claude Code セッションから claude.ai/code（クラウド VM）への移行手順をまとめたもの。

**最終目的**: ローカル PC が落ちようがネットが切れようが、ミア（Claude Code）とのセッションが継続するようにする。

---

## 概要

```
[ Before ] スマホ ─リモート→ ローカル PC (Claude Code) ─ssh→ VPS
[ After  ] スマホ ─direct→ claude.ai/code (Anthropic VM) ─ssh→ VPS
                            └── GitHub repo (gagazetmt/sekai_no_wadai)
```

ローカル PC は完全不要に。

---

## 事前準備

### 1. GitHub Personal Access Token

claude.ai/code が GitHub 操作するために必要。

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
2. **Generate new token**
3. 設定:
   - Token name: `claude-code-web`
   - Expiration: `1 year`（or 任意）
   - Repository access: `Only select repositories` → `gagazetmt/sekai_no_wadai`
   - Repository permissions:
     - Contents: **Read and write**
     - Pull requests: **Read and write**
     - Workflows: **Read and write**（Actions 使うなら）
     - Issues: **Read and write**
4. Generate token → トークン文字列をコピーして安全な場所に保存

### 2. VPS 専用 SSH 鍵を発行

ローカル PC の `~/.ssh/id_ed25519` をそのまま使うのではなく、**Web Claude 専用の鍵を別途発行**。

理由:
- クラウド VM への預け入れリスクを限定
- 万一漏れても VPS 側で当該鍵だけ revoke できる

**ローカル PC で実行:**

```bash
# Web Claude 専用鍵を発行（パスフレーズなし、Web Claude が ssh コマンドで使うため）
ssh-keygen -t ed25519 -C "web-claude-vps@gagazetmt" -f ~/.ssh/web_claude_vps -N ""

# 公開鍵を VPS に追加
ssh root@37.60.224.54 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < ~/.ssh/web_claude_vps.pub

# 動作確認
ssh -i ~/.ssh/web_claude_vps root@37.60.224.54 "echo 'web-claude key OK'"
```

**秘密鍵の中身を確認**（claude.ai/code に貼り付ける用）:

```bash
cat ~/.ssh/web_claude_vps
```

`-----BEGIN OPENSSH PRIVATE KEY-----` から `-----END OPENSSH PRIVATE KEY-----` までを丸ごとコピー。

---

## claude.ai/code セットアップ

### 1. プロジェクト作成

1. https://claude.ai/code にログイン（Pro/Max プラン必須）
2. **New Project** → GitHub 連携 → リポジトリ `gagazetmt/sekai_no_wadai` を選択
3. Branch: `main`
4. Working directory: `02_reddit_global`（V2 ランチャーが本体のため）

### 2. 環境変数登録

**Settings → Environment Variables** に以下を全部登録（VPS の `.env` から完全コピー）:

| Key | 用途 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API |
| `OPENAI_API_KEY` | OpenAI（V1で使用、V2で残ってる場合あり） |
| `DEEPSEEK_API_KEY` | DeepSeek（V2 ai_client） |
| `AI_PROVIDER` | `anthropic` 等 |
| `SERPER_API_KEY` | Serper.dev（ニュース検索） |
| `TWITTER_API_IO_KEY` | twitterAPI.io（X 画像取得） |
| `WEBSHARE_PROXY_URL` | Webshare 住宅プロキシ |
| `MINIMAX_API_KEY` | MiniMax TTS |
| `MINIMAX_GROUP_ID` | MiniMax TTS |
| `WEBHOOK_SECRET` | webhook server |
| `X_API_KEY` / `X_API_SECRET` | X API（V1 投稿） |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | X API |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REDIRECT_URI` | YouTube 投稿 |
| `API_FOOTBALL_KEY` | API Football（使ってる場合） |
| `FOOTBALL_DATA_API_KEY` | football-data.org |
| `REDDIT_PROXY_URL` | Reddit プロキシ |
| `LOCAL_AGENT_IP` | Gateway モード用（VPS で使用） |
| **`VPS_SSH_KEY`** | **上で発行した web_claude_vps の秘密鍵（中身全部）** |
| **`VPS_HOST`** | `37.60.224.54` |
| **`VPS_USER`** | `root` |

最後の3つ（VPS_*）が新規追加項目。

### 3. Network Access

クラウド VM が外部に通信できるように許可:

**Settings → Network Access** で以下を Trusted に追加（or `Full` 設定）:

```
www.premierleague.com
resources.premierleague.com
www.laliga.com
assets.laliga.com
api.sofascore.com
en.wikipedia.org
commons.wikimedia.org
api-uw.minimax.io
api.deepseek.com
api.anthropic.com
api.openai.com
google.serper.dev
api.twitterapi.io
www.reddit.com
oauth.reddit.com
github.com
api.github.com
37.60.224.54
```

迷ったら `Full` 設定（全外部通信許可）でも実用上 OK。

### 4. Setup Script 設定

**Settings → Setup Script** に以下を貼り付け:

```bash
#!/bin/bash
set -e

# Web Claude クラウド VM 起動時の初期化スクリプト
echo "[setup] Web Claude environment init..."

# Python + curl-cffi（SofaScore 突破に必要）
pip3 install --break-system-packages curl-cffi 2>/dev/null || true

# VPS SSH 鍵を ~/.ssh/ に展開
if [ -n "$VPS_SSH_KEY" ]; then
  mkdir -p ~/.ssh
  echo "$VPS_SSH_KEY" > ~/.ssh/web_claude_vps
  chmod 600 ~/.ssh/web_claude_vps
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
fi

# .env を VPS から同期（マスター = VPS）
if ssh -o BatchMode=yes vps "echo ok" >/dev/null 2>&1; then
  scp vps:/root/sekai_no_wadai/02_reddit_global/.env 02_reddit_global/.env
  echo "[setup] ✓ .env synced from VPS"
else
  echo "[setup] ⚠ VPS ssh failed — env vars from Anthropic Settings will be used"
fi

# Node 依存（02_reddit_global 配下）
if [ -d 02_reddit_global ]; then
  cd 02_reddit_global
  npm install --no-audit --no-fund 2>&1 | tail -5
  cd ..
fi

echo "[setup] Complete!"
```

---

## 動作確認

claude.ai/code でセッション開始したら、ミア（私）に以下を叩いてもらう:

```
1. ssh vps "echo connected"
2. ssh vps "cd /root/sekai_no_wadai/02_reddit_global && git log --oneline -3"
3. ssh vps "pm2 list | grep soccer-yt-v2"
4. cat 02_reddit_global/.env | grep ANTHROPIC_API_KEY | head -1
```

全部成功すれば移行完了。

---

## 移行後の運用変更点

### 変わらない
- VPS が本番稼働の主役（pm2 で常駐）
- 画像・動画・index は全て VPS に蓄積
- 定期 cron は VPS で動作

### 変わる
- ミアとの会話は claude.ai/code（Web/スマホ）から
- ローカル PC は不要（電源 OFF でも OK）
- ローカル試行錯誤フォルダ（`_inspect_*.py` 等）は使わない

### 緊急時
- claude.ai/code が落ちたら、ローカル田舎ミアに戻す（既存環境は残す）
- VPS への ssh は鍵さえあればローカルからもいつでも可

---

## トラブルシューティング

### `ssh vps` が失敗する
- `~/.ssh/web_claude_vps` のパーミッションが 600 か確認
- VPS の `~/.ssh/authorized_keys` に公開鍵が入ってるか確認
- Setup Script が実行されたか確認（再実行: `bash setup.sh`）

### Network 通信が拒否される
- Trusted リストに追加忘れがないか
- Anthropic 側のレート制限（短時間連続アクセス）

### `.env` が同期されない
- VPS ssh が通ってない可能性 → 鍵を確認
- 手動: `scp vps:/root/sekai_no_wadai/02_reddit_global/.env 02_reddit_global/.env`

### npm install が失敗する
- node_modules が大きい（puppeteer 含む）→ Cloud VM の容量確認
- `puppeteer` の Chromium ダウンロードで失敗 → `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` で回避（実行は VPS 上でやる前提）

---

## 関連ファイル

- `scripts/setup_web_claude.sh` — Setup Script の本体（このドキュメントと同期）
- `memory/session_handover.md` — Web Claude 引き継ぎ用の状態
