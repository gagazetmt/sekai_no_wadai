# register_tasks.ps1
# Windowsタスクスケジューラに案件取得タスクを登録する
# PowerShellで実行: powershell -ExecutionPolicy Bypass -File register_tasks.ps1

$bat = 'C:\Users\USER\Documents\side_biz\02_reddit_global\start_daily_fetch.bat'

$schedule = @(
  @{ name = 'SoccerDailyFetch_0000'; time = '00:00' },
  @{ name = 'SoccerDailyFetch_0600'; time = '06:00' },
  @{ name = 'SoccerDailyFetch_0900'; time = '09:00' },
  @{ name = 'SoccerDailyFetch_1200'; time = '12:00' },
  @{ name = 'SoccerDailyFetch_1500'; time = '15:00' },
  @{ name = 'SoccerDailyFetch_1800'; time = '18:00' },
  @{ name = 'SoccerDailyFetch_2100'; time = '21:00' }
)

foreach ($s in $schedule) {
  $trigger  = New-ScheduledTaskTrigger -Daily -At $s.time
  $action   = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`""
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -StartWhenAvailable
  Register-ScheduledTask -TaskName $s.name -Trigger $trigger -Action $action -Settings $settings -Force | Out-Null
  Write-Host "Registered: $($s.name) at $($s.time)"
}

Write-Host ""
Write-Host "=== 登録完了 ===" -ForegroundColor Green
Write-Host "0:00  → midnight (本日ベースJSON作成)"
Write-Host "6:00〜21:00 → update (マージ)"
Write-Host "ログ: $((Split-Path $bat))\\logs\\daily_fetch.log"
