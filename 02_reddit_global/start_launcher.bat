@echo off
cd /d "%~dp0"
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" "http://localhost:3000/launcher"
cmd /k "node post_server.js"
