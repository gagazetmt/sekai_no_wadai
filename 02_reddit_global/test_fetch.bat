@echo off
cd /d "%~dp0"
echo [%DATE% %TIME%] STEP1 START >> logs\daily_fetch.log
node scripts\fetch_daily_candidates.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP1 END >> logs\daily_fetch.log

echo [%DATE% %TIME%] STEP2 START >> logs\daily_fetch.log
node scripts\generate_text_content.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP2 END >> logs\daily_fetch.log
