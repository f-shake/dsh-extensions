<#
.SYNOPSIS
    看这台机器落后远端几条、涉及哪些部件、每个部件要怎么做才能生效。

.DESCRIPTION
    在几台电脑之间同步本仓库时，每次拉取前跑一遍，回答三件事：
      1. 我落后几个提交（以及有没有本地未推送、未提交的东西挡路）；
      2. 这些改动落在哪些部件上；
      3. 每个部件怎么才能生效 —— 技能要不要重新同步、插件要不要重启 dsh、
         子模块要不要 update、APK 要不要重新出包。

    再往下拉，是远端 CHANGELOG.md 的最新几条标题，和本文件、git log 三边对得上。

    只读脚本：除了 git fetch（更新远端引用）以外不动任何东西——不改工作区、
    不装包、不 rebase、不 pull。拉取动作留给人自己决定。

.PARAMETER Remote
    远端名，默认 origin。

.PARAMETER Branch
    要比较的分支，默认当前分支。

.PARAMETER NoFetch
    不联网，用本地已有的远端引用比较。离线时用，代价是结果可能过时。

.PARAMETER MaxEntries
    落后的提交列表、远端 CHANGELOG 标题各最多列几条，默认 10（两者共用这一个值）。

.EXAMPLE
    .\scripts\check-updates.ps1

.EXAMPLE
    .\scripts\check-updates.ps1 -NoFetch

    # 离线：用上次 fetch 的结果比较。

.NOTES
    退出码：0 = 已是最新（或只是本地领先），1 = 落后，2 = 出错——找不到仓库、
    detached HEAD、远端分支不存在、参数不合法、fetch 失败。fetch 失败时结论基于
    陈旧的远端引用，一律按 2 报，不冒充「已最新」。
#>
[CmdletBinding()]
param(
    [string] $Remote = 'origin',
    [string] $Branch,
    [switch] $NoFetch,
    [string] $MaxEntries = '10'
)

$ErrorActionPreference = 'Stop'
# git 往 stderr 写的进度条不是错误，别让 EAP=Stop 把它当成异常
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) { $PSNativeCommandUseErrorActionPreference = $false }
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$repo = Split-Path -Parent $PSScriptRoot
$pushed = $false
$subPaths = @()

# ---------- 差异路径 -> 部件 ----------

function Get-Component([string] $Path) {
    $p = $Path -replace '\\', '/'
    if ($p -eq '.gitmodules') { return '.gitmodules' }
    # 先认登记过的子模块：整个目录归一个部件
    foreach ($sp in $subPaths) {
        if ($p -eq $sp -or $p.StartsWith("$sp/", [StringComparison]::Ordinal)) { return $sp }
    }
    if ($p -match '^skills/([^/]+)') { return "skills/$($Matches[1])" }
    # 子模块之外的说明文件（plugins/external/README.md 这类），不属于子模块内容
    if ($p -match '^plugins/external/') { return 'plugins/external' }
    if ($p -match '^plugins/([^/]+)') { return "plugins/$($Matches[1])" }
    if ($p -match '^(dsh-host|dsh-auth|dsh-remote-android|scripts)(/|$)') { return $Matches[1] }
    return '仓库根'
}

function Get-Kind([string] $Component) {
    if ($Component -eq '.gitmodules' -or $subPaths -contains $Component) { return 'submodule' }
    switch -Regex ($Component) {
        '^skills' { return 'skill' }
        '^plugins/external$' { return 'external-docs' }
        '^plugins/' { return 'plugin' }
        '^dsh-host$' { return 'host' }
        '^dsh-auth$' { return 'auth' }
        '^dsh-remote-android$' { return 'android' }
        default { return 'repo' }
    }
}

# 部件类型 -> 拉取后怎么才算生效
$hints = [ordered]@{
    skill         = '本机是 junction：已即时生效，重开会话即可。是副本：跑 .\scripts\sync-skills.ps1。新技能还要建 junction 或同步一次。'
    plugin        = '重启 dsh 才生效；改的是客户端插件时前端产物要重新构建，重启最省事。'
    submodule     = '子模块指针变了：git submodule update --init --recursive。子模块里是上游源码，不在这里改。'
    'external-docs' = 'plugins/external 下的说明文件，不属于子模块内容：照常改就行，不用 update 子模块。'
    host          = '仓库只留底，不会自动生效：要套用就去 %LOCALAPPDATA%\DeepSeekHarness 和 ~/.dsh/profiles/web 手工比对，改完重启 dsh。'
    auth          = '部署在 nas-host：重新部署并重启网关服务。'
    android       = '要重新出包：cd dsh-remote-android; .\gradlew.bat assembleRelease（签名文件本机单独准备）。'
    repo          = '文档、约定、同步脚本：一般不用动工；改脚本时注意别和 junction 安装方式冲突。'
}

# 出错一律走到 catch，按 2 报，不和「落后」的 1 撞车
try {
    # 声明成字符串再解析：非法值也落到统一的 exit 2，而不是 PowerShell 绑定期就报错返回 1
    $limit = 0
    if (-not [int]::TryParse($MaxEntries, [ref] $limit) -or $limit -lt 1) {
        throw "-MaxEntries 必须是正整数，收到「$MaxEntries」。"
    }
    if (-not (Test-Path (Join-Path $repo '.git'))) { throw "找不到仓库：$repo" }

    Push-Location $repo
    $pushed = $true

    # 只认 .gitmodules 里登记过的路径。plugins/external 下还有父仓库自己的说明文件，
    # 按前缀一律当子模块会给出「别在这里改」的错误指引。
    $gitmodules = Join-Path $repo '.gitmodules'
    if (Test-Path $gitmodules) {
        $subPaths = @(& git config -f $gitmodules --get-regexp '^submodule\..*\.path$' |
            ForEach-Object { ($_ -split '\s+', 2)[1] } | Where-Object { $_ })
    }

    $current = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($current -eq 'HEAD') { throw '当前是 detached HEAD，没有跟踪分支可比。先 checkout 一个分支。' }
    if (-not $Branch) { $Branch = $current }
    $upstream = "$Remote/$Branch"

    $stale = $false
    if (-not $NoFetch) {
        Write-Host "== 拉远端引用：git fetch $Remote ==" -ForegroundColor Cyan
        & git fetch $Remote --prune
        if ($LASTEXITCODE -ne 0) {
            $stale = $true
            Write-Host '  fetch 失败：下面比的是上次 fetch 留下的远端引用，不代表远端真实状态。' -ForegroundColor Yellow
        }
    }

    & git rev-parse --verify --quiet "$upstream^{commit}" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $why = if ($stale) { '刚才 fetch 失败，本地没有这个远端分支的引用。' }
        elseif ($NoFetch) { '用了 -NoFetch，本地没有这个远端分支的引用。' }
        else { "远端上没有这个分支：$Branch。" }
        throw "${why}检查 -Remote / -Branch，或先把分支推到远端。"
    }

    $localHead = (& git rev-parse HEAD).Trim()
    $remoteHead = (& git rev-parse "$upstream^{commit}").Trim()
    $behind = [int](& git rev-list --count "HEAD..$upstream")
    $ahead = [int](& git rev-list --count "$upstream..HEAD")

    Write-Host ''
    Write-Host "本地 $Branch  $($localHead.Substring(0,7))" -ForegroundColor Gray
    Write-Host "远端 $upstream  $($remoteHead.Substring(0,7))" -ForegroundColor Gray

    $paths = @()
    if ($behind -eq 0) {
        Write-Host ''
        if ($stale) {
            Write-Host '本地与已知的远端引用一致——但 fetch 失败，这不代表真的最新。' -ForegroundColor Yellow
        }
        else {
            Write-Host '已是最新。' -ForegroundColor Green
        }
        if ($ahead -gt 0) { Write-Host "（本地还有 $ahead 个提交没推到远端。）" -ForegroundColor Yellow }
    }
    else {
        Write-Host ''
        Write-Host "落后 $behind 个提交。" -ForegroundColor Yellow
        if ($ahead -gt 0) {
            Write-Host "本地另有 $ahead 个未推送的提交——pull 前先想清楚 merge 还是 rebase。" -ForegroundColor Yellow
        }

        Write-Host ''
        Write-Host '落后的提交：' -ForegroundColor Cyan
        $commits = @(& git log --no-decorate --date=short --pretty=format:'  %h %ad %s' "HEAD..$upstream")
        $commits | Select-Object -First $limit | ForEach-Object { Write-Host $_ }
        if ($commits.Count -gt $limit) { Write-Host "  ……还有 $($commits.Count - $limit) 条" -ForegroundColor Gray }

        # ---------- 按部件归类 ----------
        # --no-renames：改名按「删一个、加一个」两条路径报，别让部件归类碰到 a => b 这种写法。
        # core.quotePath=false：中文文件名原样输出，否则两侧都是八进制转义，下面比对必不中。
        $paths = @(& git -c core.quotePath=false diff --name-only --no-renames "HEAD..$upstream")
        $groups = @{}
        foreach ($p in $paths) {
            if (-not $p) { continue }
            $c = Get-Component $p
            if (-not $groups.ContainsKey($c)) { $groups[$c] = @() }
            $groups[$c] += $p
        }

        Write-Host ''
        Write-Host "涉及 $($groups.Count) 个部件：" -ForegroundColor Cyan
        foreach ($c in ($groups.Keys | Sort-Object)) {
            $files = $groups[$c]
            Write-Host ''
            Write-Host "  $c" -ForegroundColor White -NoNewline
            Write-Host "  ($($files.Count) 个文件)" -ForegroundColor Gray
            Write-Host "    怎么办：$($hints[(Get-Kind $c)])" -ForegroundColor DarkGray
        }
    }

    # ---------- 拉取前挡路的东西（与落后无关，任何时候都要看）----------
    Write-Host ''
    $status = @(& git -c core.quotePath=false status --porcelain)
    $tracked = @($status | Where-Object { $_ -and $_ -notmatch '^\?\?' })
    $untracked = @($status | Where-Object { $_ -match '^\?\?' } | ForEach-Object {
            ($_.Substring(3).Trim().Trim('"') -replace '/$', '')
        })

    if ($tracked.Count -gt 0) {
        Write-Host "注意：$($tracked.Count) 个已跟踪文件有未提交改动，撞车时 pull 会直接失败。" -ForegroundColor Yellow
    }

    # 未跟踪文件与这次要进来的文件同名时，git 会拒绝整个 pull，不能笼统说「不影响」
    $clash = @()
    foreach ($u in $untracked) {
        if (@($paths | Where-Object { $_ -eq $u -or $_.StartsWith("$u/", [StringComparison]::Ordinal) }).Count -gt 0) {
            $clash += $u
        }
    }
    if ($clash.Count -gt 0) {
        Write-Host "注意：这些未跟踪文件与远端这次带进来的文件同名，pull 会被拒绝（untracked working tree files would be overwritten）：" -ForegroundColor Yellow
        $clash | ForEach-Object { Write-Host "  $_" }
    }
    elseif ($untracked.Count -gt 0) {
        Write-Host "（另有 $($untracked.Count) 个未跟踪文件，与远端改动不重合，不影响拉取。）" -ForegroundColor DarkGray
    }

    $stash = @(& git stash list)
    if ($stash.Count -gt 0) { Write-Host "（有 $($stash.Count) 份 stash，不着急就先别动。）" -ForegroundColor Gray }

    # ---------- 子模块 ----------
    $sub = @(& git submodule status --recursive)
    if ($sub.Count -gt 0) {
        $bad = @($sub | Where-Object { $_.TrimStart() -match '^[-+U]' })
        if ($bad.Count -gt 0) {
            Write-Host '子模块状态不对（- 未初始化 / + 指向别的提交 / U 冲突）：' -ForegroundColor Yellow
            $bad | ForEach-Object { Write-Host "  $_" }
            Write-Host '  处理：git submodule update --init --recursive' -ForegroundColor DarkGray
        }
    }

    # ---------- 远端 CHANGELOG ----------
    if ($behind -gt 0) {
        Write-Host ''
        Write-Host "远端的更新记录（$($upstream):CHANGELOG.md 开头几条）：" -ForegroundColor Cyan
        & git rev-parse --verify --quiet "$($upstream):CHANGELOG.md" | Out-Null
        $hasLog = ($LASTEXITCODE -eq 0)
        if ($hasLog) { $logText = @(& git show "$($upstream):CHANGELOG.md") }
        if (-not $hasLog -or $logText.Count -eq 0) {
            Write-Host '  读不到 CHANGELOG.md（这个远端分支上还没有？）' -ForegroundColor DarkGray
        }
        else {
            # 只认带日期的条目，别把文档自己的 `## 怎么用` 之类的小节当成更新记录。
            # \uFE0F 可有可无：⚠ 的变体选择符不是每个输入法/编辑器都会写上。
            $heads = @($logText | Where-Object { $_ -match '^##\s+(\u26A0\uFE0F?\s*)?\d{4}-\d{2}-\d{2}' } |
                Select-Object -First $limit)
            if ($heads.Count -eq 0) { Write-Host '  CHANGELOG.md 里没有带日期的条目。' -ForegroundColor DarkGray }
            $heads | ForEach-Object { Write-Host "  $($_ -replace '^##\s+','')" }
            Write-Host ('  正文：git show "{0}:CHANGELOG.md"' -f $upstream) -ForegroundColor DarkGray
        }
    }

    Write-Host ''
    if ($stale) {
        Write-Host '结论不可靠：fetch 失败，比的是旧引用。按出错处理（退出码 2），不当作「已最新」。' -ForegroundColor Yellow
        exit 2
    }
    if ($behind -gt 0) {
        Write-Host '下一步：git pull --recurse-submodules，再按上面「怎么办」逐条处理。' -ForegroundColor Cyan
        exit 1
    }
    exit 0
}
catch {
    Write-Host ''
    Write-Host "出错：$($_.Exception.Message)" -ForegroundColor Red
    exit 2
}
finally {
    if ($pushed) { Pop-Location }
}
