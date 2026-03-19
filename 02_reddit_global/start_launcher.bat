@echo off
cd /d "%~dp0"
echo Killing existing node processes...
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:3000/launcher"
cmd /k "node post_server.js"
