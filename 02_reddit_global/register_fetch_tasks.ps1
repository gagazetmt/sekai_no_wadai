# register_fetch_tasks.ps1
# 案件収集スクリプトを定刻に実行するためのタスクスケジューラ登録スクリプト

$scriptPath = "C:\Users\USER\Documents\side_biz\02_reddit_global\scripts\fetch_daily_candidates.js"
$nodePath = "node.exe" # 環境変数パスが通っている前提
$workingDir = "C:\Users\USER\Documents\side_biz\02_reddit_global"

# 実行時刻リスト
$times = @("00:00", "04:00", "06:30", "11:00", "15:00", "19:00", "22:00")

foreach ($time in $times) {
    $taskName = "SoccerLeads_Fetch_$($time.Replace(':', ''))"
    $action = New-ScheduledTaskAction -Execute $nodePath -Argument "scripts/fetch_daily_candidates.js" -WorkingDirectory $workingDir
    $trigger = New-ScheduledTaskTrigger -Daily -At $time
    
    # すでに登録済みの場合は一旦削除して再登録
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -Action $action -Trigger $trigger -TaskName $taskName -Description "定刻の案件収集 ($time)" -Force
    
    Write-Host "✅ タスク登録完了: $taskName ($time)"
}

Write-Host "`n🚀 すべての定刻タスクが登録されました！"
