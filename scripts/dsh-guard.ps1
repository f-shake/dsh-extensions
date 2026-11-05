# dsh-guard.ps1 -- 重启窗口的看护脚本。
#
# 背景：DSH 由计划任务 "DSH Serve" 的 supervisor 拉起，node 退出后 15 秒自动重起。
# 所以插件把 profile 弄坏时，表现不是"起不来"，而是**每 15 秒崩一次的循环**——
# supervisor 只会重启，永远不会回滚；watchdog 也只在端口连续 3 分钟不通时才动，
# 而它重启的仍是同一个坏 profile。这个脚本补的就是这一段：等重启、验端口、
# 超时就回滚指定 bundle，还不行再叫 Claude。
#
# 用法（在重启 DSH 之前用 Start-Process 脱离当前会话启动，自己不会被重启杀掉）：
#   Start-Process pwsh -ArgumentList '-NoProfile','-File','scripts\dsh-guard.ps1',
#     '-RemoveBundle','dsh-live-compact' -WindowStyle Hidden
#
# 退出码：0 = 正常起来；2 = 回滚后起来了；3 = 回滚也没起来，已交给 Claude；4 = 没等到重启。

param(
    [string]$Profile           = 'aa',
    [int]   $Port              = 8791,
    [string]$RemoveBundle      = '',
    [int]   $WaitForDownSeconds = 600,
    [int]   $UpTimeoutSeconds   = 150,
    [string]$TaskName          = 'DSH Serve',
    [string]$LogPath           = 'C:\Users\autod\Documents\Apps\DSH\logs\guard.log',
    [switch]$EscalateToClaude,
    [switch]$SkipTaskRestart,
    [switch]$DryRun,
    [int]   $RestartAfterSeconds = 0
)

$ErrorActionPreference = 'Continue'
$ProfileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"

# 日志可能被并发写，用带重试的追加，避免整个看护因为 IO 抖动而中断。
function Write-GuardLog([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    for ($i = 0; $i -lt 5; $i++) {
        try { Add-Content -Path $LogPath -Value $line -Encoding utf8; break } catch { Start-Sleep -Milliseconds 200 }
    }
    Write-Host $line
}

function Test-PortUp {
    $c = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    return ($c.Count -gt 0)
}

# 端口在听但仍可能是半启动，顺手打一下首页确认 HTTP 层也活了。
# 注意：DSH 的首页对未认证请求返回 401，那是"活着"的正常表现，不能当成失败。
function Test-HttpUp {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        # 4xx/5xx 也会抛异常，但拿到了响应就说明 HTTP 层在跑。
        if ($_.Exception.Response) { return $true }
        return $false
    }
}

function Wait-Until([scriptblock]$Condition, [int]$Seconds, [string]$PhaseLabel) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ((Get-Date) -lt $deadline) {
        if (& $Condition) { return $true, $sw.Elapsed.TotalSeconds }
        Start-Sleep -Seconds 2
    }
    return $false, $sw.Elapsed.TotalSeconds
}

# 从 profile 清单里摘掉一个 bundle：依赖和 dsh.profile.bundles 都要删，
# 只删一个仍会在启动时被解析到。改动前先备份成 .bak-<时间戳>。
function Remove-BundleFromProfile([string]$Name) {
    if (-not (Test-Path $ProfileDir)) { Write-GuardLog "profile 目录不存在：$ProfileDir"; return $false }
    $pkgPath = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path $pkgPath)) { Write-GuardLog "profile 没有 package.json：$pkgPath"; return $false }

    if ($DryRun) { Write-GuardLog "[DryRun] 本应回滚 bundle '$Name'"; return $true }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $pkgPath "$pkgPath.bak-$stamp"
    foreach ($f in @('cordis.patch.yml','pnpm-lock.yaml')) {
        $p = Join-Path $ProfileDir $f
        if (Test-Path $p) { Copy-Item $p "$p.bak-$stamp" }
    }

    $js = @'
const fs = require('fs');
const [file, name] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const deps = j.dependencies || {};
const hadDep = Object.prototype.hasOwnProperty.call(deps, name);
delete deps[name];
const list = j.dsh?.profile?.bundles || [];
const kept = list.filter((x) => x !== name);
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = kept;
fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ hadDep, removedFromBundles: list.length - kept.length }));
'@
    $tmp = Join-Path $env:TEMP ("guard-remove-{0}.cjs" -f ([guid]::NewGuid().ToString('N')))
    Set-Content -Path $tmp -Value $js -Encoding utf8
    $out = & node $tmp $pkgPath $Name 2>&1
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-GuardLog ("回滚结果：" + ($out -join ' '))
    return $true
}

function Restart-DshTask {
    if ($DryRun) { Write-GuardLog '[DryRun] 本应重启计划任务'; return }
    if ($SkipTaskRestart) { Write-GuardLog "[SkipTaskRestart] 不改动计划任务 '$TaskName'，等你手动重启"; return }
    try {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        # supervisor 树可能还活着；按 pid 文件精确杀掉，不要误伤别的 pwsh。
        $pidFile = 'C:\Users\autod\Documents\Apps\DSH\logs\dsh.pid'
        if (Test-Path $pidFile) {
            $v = (Get-Content $pidFile -Raw).Trim()
            if ($v -match '^\d+$') {
                $p = Get-CimInstance Win32_Process -Filter "ProcessId=$v" -ErrorAction SilentlyContinue
                if ($p -and $p.Name -eq 'pwsh.exe' -and $p.CommandLine -match 'dsh-serve\.ps1') {
                    taskkill /T /F /PID $v 2>&1 | Out-Null
                    Write-GuardLog "已杀掉 supervisor 树（pid $v）"
                }
            }
        }
        Start-Sleep -Seconds 2
        Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
        Write-GuardLog "已请求重启计划任务 '$TaskName'"
    } catch {
        Write-GuardLog ("重启计划任务失败：" + $_.Exception.Message)
    }
}

# ---- 主流程 ----
Write-GuardLog ("看护开始：profile=$Profile port=$Port 回滚对象='$RemoveBundle' 等下线=$WaitForDownSeconds 秒 等上线=$UpTimeoutSeconds 秒")

# 自己当扳机：延迟若干秒后杀掉宿主，supervisor 负责拉起。这样看护和重启在同一个
# 进程里，不会出现"扳机跑了、看护没跑"的错位。
if ($RestartAfterSeconds -gt 0) {
    Write-GuardLog ("$RestartAfterSeconds 秒后触发重启")
    Start-Sleep -Seconds $RestartAfterSeconds
    $killed = 0
    foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
        if ($p.CommandLine -like "*bin.js*--profile $Profile*") {
            Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
            $killed++
        }
    }
    Write-GuardLog ("已停止 {0} 个宿主进程，等它下线" -f $killed)
}

if (Test-PortUp) {
    Write-GuardLog "端口已在监听，先等它下线（说明重启真的发生了）"
    $down, $t = Wait-Until { -not (Test-PortUp) } $WaitForDownSeconds 'down'
    if (-not $down) {
        Write-GuardLog "等不到下线，可能根本没重启；退出，不做任何改动"
        exit 4
    }
    Write-GuardLog ("已下线，用了 {0:N0} 秒" -f $t)
}

$up, $elapsed = Wait-Until { Test-PortUp } $UpTimeoutSeconds 'up'
if ($up) {
    if (Test-HttpUp) { Write-GuardLog ("起来了：{0:N0} 秒，HTTP 正常" -f $elapsed); exit 0 }
    Write-GuardLog ("端口在听，但 HTTP 不通（{0:N0} 秒）；继续观察 30 秒" -f $elapsed)
    $up2, $e2 = Wait-Until { Test-HttpUp } 30 'http'
    if ($up2) { Write-GuardLog ("HTTP 恢复，进程正常（{0:N0} 秒）" -f $elapsed); exit 0 }
    Write-GuardLog "端口在听但 HTTP 一直不通用，按失败处理"
}

Write-GuardLog ("{0} 秒内没起来，判定失败" -f $elapsed)

if ($RemoveBundle) {
    Write-GuardLog "先回滚 '$RemoveBundle'，再重启"
    if (Remove-BundleFromProfile $RemoveBundle) {
        Restart-DshTask
        $up3, $e3 = Wait-Until { Test-PortUp } $UpTimeoutSeconds 'up-after-rollback'
        if ($up3) { Write-GuardLog ("回滚后起来了：{0:N0} 秒" -f $e3); exit 2 }
        Write-GuardLog ("回滚后仍未起来（等了 {0:N0} 秒）" -f $e3)
    }
} else {
    Write-GuardLog "没有指定 -RemoveBundle，不回滚"
}

if ($EscalateToClaude) {
    Write-GuardLog "把现场交给 Claude"
    $prompt = @"
DSH 网页服务（profile $Profile，端口 $Port）重启后没有起来，看护脚本已经尝试过回滚 '$RemoveBundle' 并重启计划任务 '$TaskName'，仍然失败。

现场信息：
- 看护日志：$LogPath
- profile 目录：$ProfileDir（package.json 已备份为 package.json.bak-*）
- supervisor 日志：C:\Users\autod\Documents\Apps\DSH\logs\dsh.log
- 启动日志：$env:USERPROFILE\.dsh\logs\startup-*.log（取最新的）
- 计划任务：DSH Serve

请只做这几件事，按顺序：
1. 读上面两个日志的最新尾部，判断起不来的真实原因。
2. 如果坏在 profile 的某个插件上，把该插件从 $ProfileDir\package.json 的 dependencies 和 dsh.profile.bundles 里移除（改前备份），然后重启计划任务 DSH Serve，再等端口 $Port 起来。
3. 如果原因与插件无关，不要乱改配置，把结论写清楚。
4. 最后用一句话报告：根因 / 你做了什么 / 现在端口是否通了。
不要改仓库里的源码，不要动其他计划任务。
"@
    if ($DryRun) { Write-GuardLog "[DryRun] 本应调用 claude -p" }
    else {
        $out = & claude -p $prompt --allowedTools "PowerShell" --output-format text 2>&1
        Write-GuardLog ("Claude 回复：" + (($out | Out-String).Trim()))
    }
    exit 3
}

Write-GuardLog "结束：服务未恢复（未启用 Claude 兜底）"
exit 3
