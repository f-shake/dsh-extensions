<#
notify-mail 自测（不依赖 Pester，不联网）

  pwsh -File scripts\tests\test_notify_mail.ps1            # 离线用例
  pwsh -File scripts\tests\test_notify_mail.ps1 -Online    # 额外真发一封（用真实配置）

全部通过时退出 0，有失败退出 1。每个用例用独立的临时配置根，不碰 ~\.dsh 的真实配置。
#>
param([switch]$Online)

$ErrorActionPreference = "Stop"
$script = Join-Path (Split-Path $PSScriptRoot -Parent) "notify-mail.ps1"
if (-not (Test-Path $script)) { "FATAL: 找不到 notify-mail.ps1" ; exit 1 }

$tmpRoots = @()
$failed = 0
$total = 0

function New-TempRoot {
    $p = Join-Path ([IO.Path]::GetTempPath()) ("nm-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Path $p -Force | Out-Null
    $script:tmpRoots += $p
    return $p
}

function Invoke-Script([string[]]$argv) {
    $out = & pwsh -NoProfile -File $script @argv 2>&1 | Out-String
    return @{ output = $out.Trim(); code = $LASTEXITCODE }
}

function Assert-That([string]$name, [scriptblock]$check) {
    $script:total++
    try {
        $ok = & $check
        if ($ok) { "  PASS  $name" } else { $script:failed++; "  FAIL  $name" }
    } catch {
        $script:failed++; "  FAIL  $name -> $($_.Exception.Message)"
    }
}

function Write-ResendKey([string]$root) {
    New-Item -ItemType Directory -Force -Path (Join-Path $root "secrets") | Out-Null
    Add-Type -AssemblyName System.Security
    $blob = [Security.Cryptography.ProtectedData]::Protect(
        [Text.Encoding]::UTF8.GetBytes("re_test_only_not_a_real_key"), $null, 'CurrentUser')
    [IO.File]::WriteAllBytes((Join-Path $root "secrets\resend.key.enc"), $blob)
}

"notify-mail 自测：$script"
""

# ---- 用例 1：resend 通道 dry-run ----
"用例 1：resend 通道 dry-run 能解析出通道与收件人"
$r1 = New-TempRoot
@{ channel = "resend"; from = "onboarding@resend.dev"; to = "probe@example.com" } |
    ConvertTo-Json | Set-Content -Path (Join-Path $r1 "mail.json") -Encoding UTF8
Write-ResendKey $r1
$res1 = Invoke-Script @("-Root", $r1, "-DryRun", "-Subject", "标题", "-Body", "正文")
Assert-That "退出码 0" { $res1.code -eq 0 }
Assert-That "输出 WOULD_SEND resend" { $res1.output -match '^WOULD_SEND resend ' }
Assert-That "收件人取自 mail.json" { $res1.output -match 'to=probe@example\.com' }
Assert-That "中文标题原样带过" { $res1.output -match 'subject=标题' }

# ---- 用例 2：-To 覆盖 ----
"用例 2：-To 覆盖配置里的收件人"
$res2 = Invoke-Script @("-Root", $r1, "-DryRun", "-To", "other@example.com", "-Subject", "x", "-Body", "x")
Assert-That "退出码 0" { $res2.code -eq 0 }
Assert-That "收件人被覆盖" { $res2.output -match 'to=other@example\.com' }

# ---- 用例 3：空配置根 → 缺配置 exit 2 ----
"用例 3：没有配置和密钥时干净失败（exit 2，不误发）"
$r3 = New-TempRoot
$res3 = Invoke-Script @("-Root", $r3, "-DryRun", "-Subject", "x", "-Body", "x")
Assert-That "退出码 2" { $res3.code -eq 2 }
Assert-That "报 MISSING_CONFIG" { $res3.output -match 'MISSING_CONFIG' }
Assert-That "未宣称发送成功" { $res3.output -notmatch 'SENT:' }

# ---- 用例 4：smtp 通道 dry-run ----
"用例 4：smtp 通道 dry-run 不依赖网络"
$r4 = New-TempRoot
@{ channel = "smtp"; smtp_host = "smtp.example.com"; smtp_port = 465; to = "probe@example.com" } |
    ConvertTo-Json | Set-Content -Path (Join-Path $r4 "mail.json") -Encoding UTF8
"SMTP_USER=u@example.com`nSMTP_PASS=not-a-real-pass" | Set-Content -Path (Join-Path $r4 ".env") -Encoding UTF8
$res4 = Invoke-Script @("-Root", $r4, "-DryRun", "-Subject", "x", "-Body", "x")
Assert-That "退出码 0" { $res4.code -eq 0 }
Assert-That "输出 WOULD_SEND smtp 且带端口" { $res4.output -match '^WOULD_SEND smtp host=smtp\.example\.com port=465' }
Assert-That "密码不出现在输出里" { $res4.output -notmatch 'not-a-real-pass' }

# ---- 用例 5：密钥不出现在任何输出 ----
"用例 5：dry-run 输出不泄漏密钥"
$res5 = $res1
Assert-That "输出不含测试 key 明文" { $res5.output -notmatch 're_test_only_not_a_real_key' }

# ---- 可选：真发一封 ----
if ($Online) {
    ""
    "用例 6（-Online）：用真实配置真发一封"
    $res6 = Invoke-Script @("-DryRun")
    "  当前通道：$($res6.output)"
    $res6b = Invoke-Script @("-Subject", "notify-mail 自测", "-Body", "由 test_notify_mail.ps1 -Online 发出。")
    Assert-That "退出码 0" { $res6b.code -eq 0 }
    Assert-That "返回 SENT 且带 id" { $res6b.output -match '^SENT: .* id=' }
    "  $($res6b.output)"
}

foreach ($p in $tmpRoots) {
    Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
}

""
if ($failed -eq 0) { "全部通过（$total 项断言）" ; exit 0 }
else { "失败 $failed / $total 项断言" ; exit 1 }
