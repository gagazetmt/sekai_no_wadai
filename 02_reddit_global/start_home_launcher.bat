@echo off
cd /d "%~dp0"
echo ⚽ ホームランチャー起動中...
echo Tailscale接続中...
tailscale up 2>nul
echo スマホからのアクセス: http://100.115.192.114:3005
start /b cmd /c "timeout /t 2 /nobreak >nul && start http://100.115.192.114:3005"
node home_launcher.js
pause
