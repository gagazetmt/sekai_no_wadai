@echo off
cd /d "%~dp0"
echo 起動中... TTS Previewer (port 4003)
timeout /t 1 /nobreak >nul
start "" "http://localhost:4003"
cmd /k "node minimax_tester_server.js"
