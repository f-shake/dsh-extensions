<#
存 Resend API key（DPAPI 加密）并写 mail.json 配置。

用法：
  pwsh -File setup-resend.ps1 -Key "re_xxx" -To "you@outlook.com"
  pwsh -File setup-resend.ps1 -Key "re_xxx" -To "you@outlook.com" -Test    # 存完立即发一封自检信

注意：未验证发信域名时，Resend 只允许发给「注册账号的邮箱」，-To 必须与之一致。
#>
param(
    [Parameter(Mandatory = $true)][string]$Key,
    [Parameter(Mandatory = $true)][string]$To,
    [string]$From = "onboarding@resend.dev",
    [switch]$Test
)

$ErrorActionPreference = "Stop"
$root = Join-Path $env:USERPROFILE ".dsh"
$secretDir = Join-Path $root "secrets"
$keyPath = Join-Path $secretDir "resend.key.enc"
$cfgPath = Join-Path $root "mail.json"

if ($Key -notmatch '^re_[A-Za-z0-9_\-]+$') {
    "ERROR: key 形状不对（应以 re_ 开头）：$($Key.Substring(0, [Math]::Min(6, $Key.Length)))…"
    exit 2
}

New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
Add-Type -AssemblyName System.Security
$blob = [Security.Cryptography.ProtectedData]::Protect(
    [Text.Encoding]::UTF8.GetBytes($Key), $null, 'CurrentUser')
[IO.File]::WriteAllBytes($keyPath, $blob)
"OK key stored: $keyPath ($($blob.Length) bytes, DPAPI/CurrentUser)"

$cfg = @{ channel = "resend"; from = $From; to = $To }
$cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding UTF8
"OK config: $cfgPath"
Get-Content $cfgPath

if ($Test) {
    $script = Join-Path $PSScriptRoot "notify-mail.ps1"
    & pwsh -NoProfile -File $script -Subject "通道自检" -Body "setup-resend 写入配置后的自检邮件。`n$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    exit $LASTEXITCODE
}
