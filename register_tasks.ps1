# register_tasks.ps1
# Windowsタスクスケジューラに案件取得タスクを登録する
# PowerShellで実行: powershell -ExecutionPolicy Bypass -File register_tasks.ps1

$bat = 'C:\Users\USER\Documents\side_biz\02_reddit_global\start_daily_fetch.bat'

# 旧タスクを削除
$oldNames = @(
  'SoccerDailyFetch_0000',
  'SoccerDailyFetch_0600',
  'SoccerDailyFetch_0900',
  'SoccerDailyFetch_1200',
  'SoccerDailyFetch_1500',
  'SoccerDailyFetch_1800',
  'SoccerDailyFetch_2100'
)
foreach ($n in $oldNames) {
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Host "旧タスクを削除しました" -ForegroundColor Yellow

$schedule = @(
  @{ name = 'SoccerDailyFetch_0000'; time = '00:00' },
  @{ name = 'SoccerDailyFetch_0400'; time = '04:00' },
  @{ name = 'SoccerDailyFetch_0730'; time = '07:30' },
  @{ name = 'SoccerDailyFetch_1130'; time = '11:30' },
  @{ name = 'SoccerDailyFetch_1600'; time = '16:00' },
  @{ name = 'SoccerDailyFetch_2000'; time = '20:00' },
  @{ name = 'SoccerDailyFetch_2230'; time = '22:30' }
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
Write-Host "スケジュール: 0:00 / 4:00 / 7:30 / 11:30 / 16:00 / 20:00 / 22:30 JST"
Write-Host "各回: Reddit4件 + RSS4件（36h以内・168h dedup）"
$logPath = (Split-Path $bat) + "\logs\daily_fetch.log"
Write-Host "ログ: $logPath"
