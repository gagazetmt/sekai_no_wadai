@echo off
cd /d "%~dp0"

REM LOGGING START
echo [%DATE% %TIME%] ===== START DAILY FETCH ===== >> logs\daily_fetch.log

REM STEP1: FETCH CANDIDATES
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates START >> logs\daily_fetch.log
node scripts\fetch_daily_candidates.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates END (exit:%ERRORLEVEL%) >> logs\daily_fetch.log

REM STEP2: GENERATE CONTENT
echo [%DATE% %TIME%] STEP2: generate_text_content START >> logs\daily_fetch.log
node scripts\generate_text_content.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP2: generate_text_content END (exit:%ERRORLEVEL%) >> logs\daily_fetch.log

echo [%DATE% %TIME%] ===== COMPLETED ===== >> logs\daily_fetch.log
