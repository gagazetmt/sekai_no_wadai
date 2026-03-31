@echo off
REM =====================================================================
REM  start_daily_fetch.bat
REM  タスクスケジューラから呼び出される案件取得スクリプト
REM  実行モード（midnight / update）は fetch_daily_candidates.js が
REM  JST時刻から自動判定する。
REM =====================================================================

cd /d "%~dp0"

REM ログファイルに日時を追記
echo. >> logs\daily_fetch.log
echo [%DATE% %TIME%] fetch_daily_candidates 開始 >> logs\daily_fetch.log

REM Node.js スクリプト実行（stdout/stderr をログに追記）
node scripts\fetch_daily_candidates.js >> logs\daily_fetch.log 2>&1

echo [%DATE% %TIME%] fetch_daily_candidates 終了 (exit:%ERRORLEVEL%) >> logs\daily_fetch.log
