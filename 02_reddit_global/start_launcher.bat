@echo off
cd /d "%~dp0"
echo.
echo  ====================================
echo   投稿管理センター 起動中...
echo  ====================================
echo.
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:3000/app"
node post_server.js
