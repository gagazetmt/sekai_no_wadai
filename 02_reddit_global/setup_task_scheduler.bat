@echo off
REM =====================================================================
REM  setup_task_scheduler.bat
REM  Windowsタスクスケジューラに案件取得タスクを登録する
REM  ★ 初回1回だけ「管理者として実行」してください
REM =====================================================================

set TASK_NAME=SoccerDailyFetch
set BAT_PATH=%~dp0start_daily_fetch.bat
set LOG_DIR=%~dp0logs

REM logsフォルダ作成
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM 既存タスクを削除（再登録対応）
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
echo 既存タスク削除（あれば）

REM ── タスク登録（0:00, 6:00, 9:00, 12:00, 15:00, 18:00, 21:00）──────────────
REM  Windows の schtasks は1タスクに複数時刻を設定できないため
REM  時刻ごとに別タスク名で登録する

schtasks /create /tn "%TASK_NAME%_0000" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 00:00 /f
schtasks /create /tn "%TASK_NAME%_0600" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 06:00 /f
schtasks /create /tn "%TASK_NAME%_0900" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 09:00 /f
schtasks /create /tn "%TASK_NAME%_1200" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 12:00 /f
schtasks /create /tn "%TASK_NAME%_1500" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 15:00 /f
schtasks /create /tn "%TASK_NAME%_1800" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 18:00 /f
schtasks /create /tn "%TASK_NAME%_2100" /tr "cmd /c \"%BAT_PATH%\"" /sc DAILY /st 21:00 /f

echo.
echo =====================================================
echo  登録完了！以下のタスクが作成されました:
echo    %TASK_NAME%_0000  (0:00  - ベースJSON作成)
echo    %TASK_NAME%_0600  (6:00  - マージ)
echo    %TASK_NAME%_0900  (9:00  - マージ)
echo    %TASK_NAME%_1200  (12:00 - マージ)
echo    %TASK_NAME%_1500  (15:00 - マージ)
echo    %TASK_NAME%_1800  (18:00 - マージ)
echo    %TASK_NAME%_2100  (21:00 - マージ)
echo =====================================================
echo.
echo ★ 確認: タスクスケジューラ を開いて各タスクが表示されればOK
echo ★ ログ: %LOG_DIR%\daily_fetch.log
echo.
pause
