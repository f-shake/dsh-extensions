<#
告警/通知邮件发送（技能 notify-mail 的落地脚本）

配置（非机密）：%USERPROFILE%\.dsh\mail.json
  { "channel": "resend", "from": "onboarding@resend.dev", "to": "you@example.com",
    "smtp_host": "smtp.qq.com", "smtp_port": 465 }

机密：
  resend 通道 → %USERPROFILE%\.dsh\secrets\resend.key.enc（Windows DPAPI，绑本机账户）
  smtp   通道 → %USERPROFILE%\.dsh\.env 的 SMTP_USER / SMTP_PASS

用法：
  pwsh -File notify-mail.ps1 -Subject "..." -Body "..."
  pwsh -File notify-mail.ps1 -DryRun -Subject "x" -Body "x"
  pwsh -File notify-mail.ps1 -To other@x.com -Subject "..." -Body "..."

退出码：0 成功 / 1 发送失败 / 2 缺配置
#>
param(
    [string]$Subject = "通知",
    [string]$Body = "",
    [string]$To = "",
    [switch]$DryRun,
    # 配置根目录，默认 %USERPROFILE%\.dsh；只有自测会改它
    [string]$Root = ""
)

$ErrorActionPreference = "Stop"
$root    = if ($Root) { $Root } else { Join-Path $env:USERPROFILE ".dsh" }
$cfgPath = Join-Path $root "mail.json"
$keyPath = Join-Path $root "secrets\resend.key.enc"
$logPath = Join-Path $root "logs\mail.log"

function Write-Log([string]$msg) {
    $dir = Split-Path $logPath -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    "{0} {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg | Add-Content -Path $logPath -Encoding UTF8
}

function Read-Json([string]$path) {
    if (-not (Test-Path $path)) { return $null }
    return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Read-DotEnv([string]$path) {
    $map = @{}
    if (-not (Test-Path $path)) { return $map }
    foreach ($line in Get-Content $path -Encoding UTF8) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $i = $line.IndexOf('=')
        $k = $line.Substring(0, $i).Trim()
        if ($k) { $map[$k] = $line.Substring($i + 1).Trim().Trim('"').Trim("'") }
    }
    return $map
}

function Unprotect-Secret([string]$path) {
    Add-Type -AssemblyName System.Security -ErrorAction Stop
    $bytes = [IO.File]::ReadAllBytes($path)
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
    return [Text.Encoding]::UTF8.GetString($plain)
}

$cfg = Read-Json $cfgPath

# ---------- 通道一：Resend API ----------
if ((Test-Path $keyPath) -and ($cfg -eq $null -or $cfg.channel -eq "resend")) {
    if (-not $To) { $To = if ($cfg -and $cfg.to) { $cfg.to } else { "" } }
    if (-not $To) {
        Write-Log "FAIL resend: 缺少收件人"
        "MISSING_CONFIG: to"
        exit 2
    }
    $from = if ($cfg -and $cfg.from) { $cfg.from } else { "onboarding@resend.dev" }

    if ($DryRun) {
        "WOULD_SEND resend from=$from to=$To subject=$Subject"
        exit 0
    }

    $key = Unprotect-Secret $keyPath
    $payload = @{ from = $from; to = @($To); subject = $Subject; text = $Body } | ConvertTo-Json -Compress

    for ($i = 1; $i -le 3; $i++) {
        try {
            $r = Invoke-RestMethod -Uri "https://api.resend.com/emails" `
                -Headers @{ Authorization = "Bearer $key" } -Method Post `
                -ContentType "application/json; charset=utf-8" `
                -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 25
            Write-Log "SENT resend -> $To id=$($r.id) subject=$Subject"
            "SENT: $To id=$($r.id)"
            exit 0
        } catch {
            $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
            $detail = $_.ErrorDetails.Message
            Write-Log "FAIL resend attempt=$i http=$code $detail"
            if ($i -lt 3 -and ($code -eq 0 -or $code -ge 500 -or $code -eq 429)) { Start-Sleep -Seconds (2 * $i); continue }
            "FAILED: HTTP $code $detail"
            exit 1
        }
    }
}

# ---------- 通道二：SMTP ----------
$envMap = Read-DotEnv (Join-Path $root ".env")
$smtpHost_ = if ($cfg -and $cfg.smtp_host) { $cfg.smtp_host } elseif ($envMap['SMTP_HOST']) { $envMap['SMTP_HOST'] } else { $env:SMTP_HOST }
$smtpPort  = if ($cfg -and $cfg.smtp_port) { [int]$cfg.smtp_port } elseif ($envMap['SMTP_PORT']) { [int]$envMap['SMTP_PORT'] } else { 587 }
$smtpUser  = if ($envMap['SMTP_USER']) { $envMap['SMTP_USER'] } else { $env:SMTP_USER }
$smtpPass  = if ($envMap['SMTP_PASS']) { $envMap['SMTP_PASS'] } else { $env:SMTP_PASS }
if (-not $To) { $To = if ($cfg -and $cfg.to) { $cfg.to } elseif ($envMap['MAIL_TO']) { $envMap['MAIL_TO'] } else { $env:MAIL_TO } }

$missing = @()
if (-not $smtpHost_) { $missing += 'SMTP_HOST' }
if (-not $smtpUser)  { $missing += 'SMTP_USER' }
if (-not $smtpPass)  { $missing += 'SMTP_PASS' }
if (-not $To)        { $missing += 'MAIL_TO' }
if ($missing.Count -gt 0) {
    Write-Log "FAIL config: 缺 $($missing -join ', ')"
    "MISSING_CONFIG: " + ($missing -join ', ')
    exit 2
}

if ($DryRun) {
    "WOULD_SEND smtp host=$smtpHost_ port=$smtpPort from=$smtpUser to=$To subject=$Subject"
    exit 0
}

$utext = [Text.Encoding]::UTF8

if ($smtpPort -eq 465) {
    # 465：连接即 TLS（SmtpClient 不支持，手写会话）
    $msg = "From: $smtpUser`r`nTo: $To`r`nSubject: =?UTF-8?B?$([Convert]::ToBase64String($utext.GetBytes($Subject)))?=`r`n" +
           "MIME-Version: 1.0`r`nContent-Type: text/plain; charset=UTF-8`r`nContent-Transfer-Encoding: base64`r`n`r`n" +
           ([Convert]::ToBase64String($utext.GetBytes($Body)) -replace '(.{76})', "`$1`r`n")
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient($smtpHost_, $smtpPort)
        $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream())
        $ssl.AuthenticateAsClient($smtpHost_)
        $sr = New-Object System.IO.StreamReader($ssl, $utext)
        $sw = New-Object System.IO.StreamWriter($ssl, $utext); $sw.NewLine = "`r`n"; $sw.AutoFlush = $true
        $sr.ReadLine | Out-Null
        $step = {
            param($cmd)
            $sw.WriteLine($cmd)
            while ($true) { $l = $sr.ReadLine(); if ($l -match '^\d{3} ') { return $l } }
        }
        & $step "EHLO $env:COMPUTERNAME" | Out-Null
        & $step "AUTH LOGIN" | Out-Null
        & $step ([Convert]::ToBase64String($utext.GetBytes($smtpUser))) | Out-Null
        & $step ([Convert]::ToBase64String($utext.GetBytes($smtpPass))) | Out-Null
        & $step "MAIL FROM:<$smtpUser>" | Out-Null
        & $step "RCPT TO:<$To>" | Out-Null
        & $step "DATA" | Out-Null
        $sw.WriteLine($msg.TrimEnd("`r`n")); $sw.WriteLine(".")
        $l = $sr.ReadLine()
        if ($l -notmatch '^2\d\d') { throw "DATA rejected: $l" }
        & $step "QUIT" | Out-Null
        $ssl.Dispose(); $tcp.Close()
        Write-Log "SENT smtp465 -> $To subject=$Subject"
        "SENT: $To"
        exit 0
    } catch {
        Write-Log "FAIL smtp465: $($_.Exception.Message)"
        "FAILED: $($_.Exception.Message)"
        exit 1
    }
}

try {
    $client = New-Object System.Net.Mail.SmtpClient($smtpHost_, $smtpPort)
    $client.EnableSsl = $true; $client.Timeout = 25000
    $client.Credentials = New-Object System.Net.NetworkCredential($smtpUser, $smtpPass)
    $mail = New-Object System.Net.Mail.MailMessage
    $mail.From = New-Object System.Net.Mail.MailAddress($smtpUser)
    $mail.To.Add($To)
    $mail.Subject = $Subject; $mail.SubjectEncoding = $utext
    $mail.Body = $Body; $mail.BodyEncoding = $utext; $mail.IsBodyHtml = $false
    $client.Send($mail)
    $mail.Dispose()
    Write-Log "SENT smtp${smtpPort} -> $To subject=$Subject"
    "SENT: $To"
    exit 0
} catch {
    Write-Log "FAIL smtp${smtpPort}: $($_.Exception.Message)"
    "FAILED: $($_.Exception.Message)"
    exit 1
}
