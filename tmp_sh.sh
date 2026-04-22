#!/bin/bash
# Miaターミナル起動スクリプト
# ユーザー名とパスワードで認証をかけ、0.0.0.0 で開放する

SESSION="mia"
USER="enke"
PASS="viran"

# tmuxセッションがなければ作成
if ! tmux has-session -t $SESSION 2>/dev/null; then
  tmux new-session -d -s $SESSION
  tmux send-keys -t $SESSION 'cd /mnt/c/Users/USER/Documents/side_biz' Enter
  tmux send-keys -t $SESSION 'gemini' Enter
fi

echo "tmuxセッション起動済み: $SESSION"
echo "ttyd 認証モード起動中: http://0.0.0.0:7681 (User: $USER)"

# -c オプションでユーザー名:パスワードの認証を追加！
ttyd --port 7681 --interface 0.0.0.0 --credential $USER:$PASS --writable tmux attach-session -t $SESSION
