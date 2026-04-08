@echo off
cd /d "%~dp0"

REM LOGGING START
echo [%DATE% %TIME%] ===== START DAILY FETCH (LOCAL MODE) ===== >> logs\daily_fetch_local.log

REM STEP1: FETCH CANDIDATES (--local: SCPなし、temp/にコピー)
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates START >> logs\daily_fetch_local.log
node scripts\fetch_daily_candidates.js --local >> logs\daily_fetch_local.log 2>&1
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates END (exit:%ERRORLEVEL%) >> logs\daily_fetch_local.log

echo [%DATE% %TIME%] ===== COMPLETED ===== >> logs\daily_fetch_local.log
