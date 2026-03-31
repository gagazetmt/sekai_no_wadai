@echo off
REM =====================================================================
REM  start_daily_fetch.bat
REM  タスクスケジューラから呼び出される定刻処理
REM
REM  STEP1: fetch_daily_candidates.js
REM         Reddit/RSS からネタ収集・dedup・SCP送信
REM
REM  STEP2: generate_text_content.js
REM         タイトル・ナレーション・ハッシュタグ生成→SCP→VPS画像取得をトリガー
REM =====================================================================

cd /d "%~dp0"

echo. >> logs\daily_fetch.log
echo [%DATE% %TIME%] ===== 定刻処理 開始 ===== >> logs\daily_fetch.log

REM ─── STEP1: ネタ収集 ───────────────────────────────────────────────────
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates 開始 >> logs\daily_fetch.log
node scripts\fetch_daily_candidates.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP1: fetch_daily_candidates 終了 (exit:%ERRORLEVEL%) >> logs\daily_fetch.log

REM STEP1 が失敗しても STEP2 は実行（既存データがあれば生成できる）

REM ─── STEP2: テキストコンテンツ生成 → VPS送信 → VPS画像取得トリガー ──────
echo [%DATE% %TIME%] STEP2: generate_text_content 開始 >> logs\daily_fetch.log
node scripts\generate_text_content.js >> logs\daily_fetch.log 2>&1
echo [%DATE% %TIME%] STEP2: generate_text_content 終了 (exit:%ERRORLEVEL%) >> logs\daily_fetch.log

echo [%DATE% %TIME%] ===== 定刻処理 完了 ===== >> logs\daily_fetch.log
