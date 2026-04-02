@echo off
cd /d "%~dp0"
echo 起動中...
start "" "http://localhost:3003"
cmd /k "node soccer_yt_server.js"
