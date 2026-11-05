<#
.SYNOPSIS
    把本仓库 skills\ 下的技能同步到 DSH 的全局 skill 目录（默认 ~/.dsh/skills）。

.DESCRIPTION
    本仓库是「源」，~/.dsh/skills 是「副本」。改仓库里的文件不会自动生效，
    必须跑一遍本脚本。

    四个坑，脚本已经处理：
      1. 先删后拷 —— 直接覆盖会把上一版残留的、这次已删除的文件留在副本里；
      2. 拷完逐个校验哈希，不信「应该拷过去了」；
      3. 副本里多出来的旧技能 —— 只删本脚本自己装过、现已从仓库移除的，
         靠 <Target>\.sync-skills-owned.json 记录，绝不碰别人放的技能；
      4. 覆盖前先备份 —— 副本若比仓库新（改在了 ~\.dsh 侧、没回流仓库），
         先删后拷会把它抹掉。所以每次覆盖前把旧目录拷到 <Target>\..\skills.bak\<时间戳>\，
         只留最近 MaxBackups 份。备份目录在 skills\ 外面，不会被当成技能。

.PARAMETER Target
    副本目录。默认取 $env:DSH_HOME\skills，没有就用 ~\.dsh\skills。

.PARAMETER Prune
    删掉本脚本曾安装、但仓库里已经没有的技能（按记录文件判断，不会误删外部技能）。

.PARAMETER NoBackup
    不做覆盖前备份。只有确认「副本一定不比仓库新」时才用。

.PARAMETER MaxBackups
    保留最近几份备份，默认 5。

.EXAMPLE
    .\scripts\sync-skills.ps1
    .\scripts\sync-skills.ps1 -Prune
    .\scripts\sync-skills.ps1 -NoBackup
#>
[CmdletBinding()]
param(
    [string] $Target,
    [switch] $Prune,
    [switch] $NoBackup,
    [int] $MaxBackups = 5
)

$ErrorActionPreference = 'Stop'

$repoSkills = Join-Path (Split-Path -Parent $PSScriptRoot) 'skills'
if (-not (Test-Path $repoSkills)) { throw "找不到源目录：$repoSkills" }

if (-not $Target) {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
    $Target = Join-Path $dshHome 'skills'
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null

# 覆盖前的备份：<Target>\..\skills.bak\<时间戳>\<技能名>
# 放 skills\ 外面，DSH 才不会把它当成技能扫到
$backupRoot = Join-Path (Split-Path -Parent $Target) 'skills.bak'
$backupDir = Join-Path $backupRoot (Get-Date -Format 'yyyyMMdd-HHmmss')

function Backup-Skill([string] $Path, [string] $Name) {
    if ($NoBackup) { return }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $dest = Join-Path $backupDir $Name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dest) | Out-Null
    Copy-Item -LiteralPath $Path -Destination $dest -Recurse -Force
    Write-Host "备份 $Name → $backupDir" -ForegroundColor DarkGray
}

# 谁装过、装的是什么 —— 只用来判断「哪些是本脚本的」，不参与技能发现
$marker = Join-Path $Target '.sync-skills-owned.json'
$owned = @()
if (Test-Path $marker) {
    $owned = @(Get-Content $marker -Raw | ConvertFrom-Json)
}

function Get-TreeHash([string] $root) {
    Get-ChildItem $root -Recurse -File | Sort-Object FullName | ForEach-Object {
        $rel = $_.FullName.Substring($root.Length).TrimStart('\', '/')
        "$rel=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)"
    }
}

# 技能 = skills\ 下「直接」含 SKILL.md 的目录（DSH 的发现深度只有一层）
$skills = @(Get-ChildItem $repoSkills -Directory |
    Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') })
if (-not $skills) { throw "源目录下没有任何 <name>\SKILL.md：$repoSkills" }

$names = @($skills.Name)
$failed = @()

foreach ($s in $skills) {
    $dest = Join-Path $Target $s.Name
    Backup-Skill $dest $s.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $s.FullName $dest -Recurse -Force

    if (((Get-TreeHash $s.FullName) -join "`n") -eq ((Get-TreeHash $dest) -join "`n")) {
        Write-Host "OK   $($s.Name)" -ForegroundColor Green
    } else {
        Write-Host "FAIL $($s.Name)（副本与源不一致）" -ForegroundColor Red
        $failed += $s.Name
    }
}

# 只清理「自己装过、现在仓库里没了」的技能
$dropped = @($owned | Where-Object { $_ -notin $names })
foreach ($name in $dropped) {
    $path = Join-Path $Target $name
    if (-not (Test-Path $path)) { continue }
    if ($Prune) {
        Backup-Skill $path $name
        Remove-Item $path -Recurse -Force
        Write-Host "删掉 $name（仓库里已移除）" -ForegroundColor Yellow
    } else {
        Write-Warning "$name 已从仓库移除，但副本还在（会作为幽灵 skill 继续挂着）；加 -Prune 清掉"
    }
}

# 别人放的技能：只报告，永不改动
$others = @(Get-ChildItem $Target -Directory |
    Where-Object { $_.Name -notin $names -and $_.Name -notin $owned -and (Test-Path (Join-Path $_.FullName 'SKILL.md')) })
if ($others) {
    Write-Host "未改动（不属于本仓库）：$($others.Name -join ', ')" -ForegroundColor DarkGray
}

if ($failed) { throw "校验失败：$($failed -join ', ')" }

if (-not $Prune) { $names = @($names + ($dropped | Where-Object { Test-Path (Join-Path $Target $_) })) }
ConvertTo-Json -InputObject @($names) -Compress | Set-Content $marker -Encoding utf8

# 备份只留最近 MaxBackups 份；这次没覆盖到东西（全是新装）就别留空目录
if (-not $NoBackup) {
    if (Test-Path -LiteralPath $backupDir) {
        $old = @()
        if ($MaxBackups -gt 0) {
            $old = @(Get-ChildItem -LiteralPath $backupRoot -Directory |
                Sort-Object Name -Descending | Select-Object -Skip $MaxBackups)
        }
        foreach ($d in $old) {
            Remove-Item -LiteralPath $d.FullName -Recurse -Force
            Write-Host "清掉旧备份 $($d.Name)" -ForegroundColor DarkGray
        }
        Write-Host "备份 → $backupDir" -ForegroundColor DarkGray
    } else {
        Write-Host "本次没有覆盖任何已有技能，未产生备份" -ForegroundColor DarkGray
    }
}

Write-Host "`n同步完成 → $Target" -ForegroundColor Cyan
Write-Host "DSH 监视该目录，新会话直接生效；已开的会话里正文也是每次加载重读的。" -ForegroundColor DarkGray
