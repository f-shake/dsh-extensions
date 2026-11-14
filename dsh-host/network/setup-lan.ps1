<#
.SYNOPSIS
  幂等地配置（或撤销）本机 DSH web 的局域网接入：防火墙规则 + 127.0.0.1 的 portproxy。

.DESCRIPTION
  dsh 只接受单个具体本地地址，拒绝通配符，所以对外可达性由两件系统级配置承担：
    1) 入站放行 TCP 端口（仅 Domain/Private + 本地子网）；
    2) portproxy 在 127.0.0.1 上开一个转发，指向 dsh 实际绑定的 LAN 地址。
  走 portproxy 的请求 Host 是 loopback，/api 的信任栅栏对 loopback 主机放行
  （仍校验 Origin 与 sec-fetch-site），因此不需要 --trusted-host。

  注意：不要把 portproxy 的监听改成 0.0.0.0。它会占住端口导致 dsh 绑定失败（EADDRINUSE），
  而转发到 127.0.0.1 又会落回自己，形成请求自环。

  原生命令（netsh）的失败不会变成终止错误，$ErrorActionPreference 管不到它们，
  所以每次调用都显式检查 $LASTEXITCODE；转发配置采用「先删后加 + 失败回滚」，
  避免 add 失败时把原本可用的 loopback 入口删没了还报成功。

.PARAMETER Remove
  撤销防火墙规则与本端口的 portproxy 转发。

.PARAMETER Port
  dsh 监听的端口，默认 8791。

.PARAMETER RuleName
  防火墙规则名，默认按端口生成 "DSH Web <port> (LAN)"。显式指定时可复用已有规则名。

.EXAMPLE
  .\setup-lan.ps1            # 配置
  .\setup-lan.ps1 -Remove    # 撤销
#>
[CmdletBinding()]
param(
    [switch]$Remove,
    [int]$Port = 8791,
    [string]$RuleName
)

$ErrorActionPreference = 'Stop'

if (-not $PSBoundParameters.ContainsKey('RuleName')) { $RuleName = "DSH Web $Port (LAN)" }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw '需要管理员权限：请以管理员身份运行本脚本。' }

function Invoke-Netsh {
    param([string[]]$Arguments)
    $out = (& netsh @Arguments 2>&1 | Out-String)
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw ("netsh {0} 失败（exit {1}）：{2}" -f ($Arguments -join ' '), $code, $out.Trim()) }
    return $out
}

function Get-PortProxyRules {
    # netsh 的输出是本地化的，但四列数字/地址的形态稳定，按形态解析比按表头解析可靠
    $text = Invoke-Netsh -Arguments @('interface', 'portproxy', 'show', 'v4tov4')
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+(\d+)\s+(\S+)\s+(\d+)\s*$') {
            [pscustomobject]@{
                ListenAddress  = $Matches[1]
                ListenPort     = [int]$Matches[2]
                ConnectAddress = $Matches[3]
                ConnectPort    = [int]$Matches[4]
            }
        }
    }
}

function Get-LanAddress {
    # 与 launcher.py 用同一算法（UDP connect 取出口网卡），否则两处可能选中不同接口，
    # 表现是 127.0.0.1 入口连不通而不是报错
    $sock = New-Object System.Net.Sockets.UdpClient
    try {
        $sock.Connect('8.8.8.8', 80)
        $ip = $sock.Client.LocalEndPoint.Address.IPAddressToString
        if ($ip) { return $ip }
    } catch {
        # 离线时没有出口路由，落到下面的接口枚举
    } finally {
        $sock.Close()
    }
    $ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } |
        ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1)
    if (-not $ip) { throw '找不到默认路由网卡的 IPv4 地址；离线时请先联网再运行。' }
    return $ip
}

function Remove-Forward {
    $existing = Get-PortProxyRules | Where-Object { $_.ListenAddress -eq '127.0.0.1' -and $_.ListenPort -eq $Port }
    if ($existing) {
        Invoke-Netsh -Arguments @('interface', 'portproxy', 'delete', 'v4tov4',
            'listenaddress=127.0.0.1', "listenport=$Port") | Out-Null
    }
    return [bool]$existing
}

function Test-FirewallRule {
    param([string]$Name)
    $rule = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
    if (-not $rule) { return $null }
    $port_ = $rule | Get-NetFirewallPortFilter
    $addr = $rule | Get-NetFirewallAddressFilter
    $ok = ([string]$rule.Enabled -eq 'True') -and
        ([string]$rule.Direction -eq 'Inbound') -and
        ([string]$rule.Action -eq 'Allow') -and
        (@($port_.Protocol) -contains 'TCP') -and
        (@($port_.LocalPort) -contains "$Port") -and
        ([string]$rule.Profile -match 'Domain') -and
        ([string]$rule.Profile -match 'Private') -and
        (@($addr.RemoteAddress) -contains 'LocalSubnet')
    return [pscustomobject]@{ Rule = $rule; Match = $ok }
}

if ($Remove) {
    $state = Test-FirewallRule -Name $RuleName
    if ($state) {
        Remove-NetFirewallRule -DisplayName $RuleName
        Write-Host "防火墙规则 '$RuleName' 已删除"
    }
    if (Remove-Forward) {
        Write-Host "portproxy 127.0.0.1:$Port 已删除"
    }
    Write-Host '局域网接入已撤销：127.0.0.1 将不再连通，LAN 地址的直连不受影响。'
    exit 0
}

$lanIp = Get-LanAddress

# 同端口的 0.0.0.0 规则只可能来自把监听改成通配的误配，它会让 dsh 绑不上、转发自环，先清掉
$wildcard = Get-PortProxyRules | Where-Object { $_.ListenAddress -eq '0.0.0.0' -and $_.ListenPort -eq $Port }
if ($wildcard) {
    Invoke-Netsh -Arguments @('interface', 'portproxy', 'delete', 'v4tov4',
        'listenaddress=0.0.0.0', "listenport=$Port") | Out-Null
    Write-Host "已清理冲突规则 0.0.0.0:$Port（通配监听会与 dsh 抢端口并形成自环）"
}

$state = Test-FirewallRule -Name $RuleName
if ($state -and $state.Match) {
    Write-Host "防火墙规则已存在且属性正确：'$RuleName'"
} else {
    if ($state) {
        Write-Host "防火墙规则 '$RuleName' 属性不符（端口/配置/远端范围），重建"
        Remove-NetFirewallRule -DisplayName $RuleName
    }
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $Port -Profile Domain,Private -RemoteAddress LocalSubnet | Out-Null
    Write-Host "防火墙规则已创建：'$RuleName'（Domain/Private，仅本地子网）"
}

# 先记下旧目标：add 失败时把原规则补回去，否则 loopback 入口就这么断了
$previous = Get-PortProxyRules | Where-Object { $_.ListenAddress -eq '127.0.0.1' -and $_.ListenPort -eq $Port }
$previousTarget = if ($previous) { $previous.ConnectAddress } else { $null }

Remove-Forward | Out-Null
try {
    Invoke-Netsh -Arguments @('interface', 'portproxy', 'add', 'v4tov4',
        'listenaddress=127.0.0.1', "listenport=$Port", "connectaddress=$lanIp", "connectport=$Port") | Out-Null
} catch {
    if ($previousTarget) {
        try {
            Invoke-Netsh -Arguments @('interface', 'portproxy', 'add', 'v4tov4',
                'listenaddress=127.0.0.1', "listenport=$Port",
                "connectaddress=$previousTarget", "connectport=$Port") | Out-Null
            Write-Host "添加失败，已回滚到原转发目标 ${previousTarget}:$Port"
        } catch {
            Write-Host "回滚也失败了，请手工检查：netsh interface portproxy show v4tov4"
        }
    }
    throw
}

# netsh 可能只记规则不落地监听，回读一次确认生效
$applied = Get-PortProxyRules | Where-Object { $_.ListenAddress -eq '127.0.0.1' -and $_.ListenPort -eq $Port }
if (-not $applied -or $applied.ConnectAddress -ne $lanIp) {
    throw "portproxy 配置未生效：期望 127.0.0.1:$Port -> ${lanIp}:$Port，实际见 netsh interface portproxy show v4tov4"
}
Write-Host "portproxy 127.0.0.1:$Port -> ${lanIp}:$Port 已配置"

Write-Host ''
Write-Host '当前规则：'
Invoke-Netsh -Arguments @('interface', 'portproxy', 'show', 'v4tov4') | Write-Host
Write-Host ''
Write-Host "提示：换网络后 LAN 地址会变，重新跑一次本脚本即可让 127.0.0.1 的转发跟上。"
