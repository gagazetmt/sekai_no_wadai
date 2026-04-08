@echo off
cd /d "%~dp0"

REM LOGGING START
echo [%DATE% %TIME%] ===== START DAILY FETCH ===== >> logs\daily_fetch.log

REM STEP1: FETCH CANDIDATES (タイトル＆コメント収集のみ。脚本生成はランチャーの「自動生成」ボタンから)
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates START >> logs\daily_fetch.log
node scripts\fetch_daily_candidates.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates END (exit:%ERRORLEVEL%) >> logs\daily_fetch.log

echo [%DATE% %TIME%] ===== COMPLETED ===== >> logs\daily_fetch.log
