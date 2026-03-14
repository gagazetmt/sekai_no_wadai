@echo off
cd /d "%~dp0"
echo.
echo  ====================================
echo   X投稿ランチャー 起動中...
echo  ====================================
echo.
start "" "http://localhost:3000/launcher"
node post_server.js
