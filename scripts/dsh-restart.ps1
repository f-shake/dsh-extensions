# dsh-restart.ps1 -- 延迟杀掉 DSH 宿主，交给计划任务 "DSH Serve" 的 supervisor 重起。
#
# 为什么要延迟：当前会话就活在那个 node 进程里，立刻杀会把正在生成的回复一起掐掉。
# 延迟窗口留给调用方把消息发完。supervisor 会在 node 退出后 15 秒重新拉起。
#
# 只杀 `bin.js ... --profile <名>` 那一个 node，不碰工具子进程、不碰 supervisor。

param(
    [int]   $DelaySeconds = 60,
    [string]$Profile = 'aa'
)

$ErrorActionPreference = 'Continue'

Write-Host ("{0} 秒后重启 profile {1} 的宿主" -f $DelaySeconds, $Profile)
Start-Sleep -Seconds $DelaySeconds

$targets = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*bin.js*--profile $Profile*" })

if ($targets.Count -eq 0) {
    Write-Host '没有找到目标 node 进程；可能已经退出'
    exit 0
}

foreach ($t in $targets) {
    Write-Host ("停止 pid {0}" -f $t.ProcessId)
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host '已请求重启；supervisor 约 15 秒后拉起'
