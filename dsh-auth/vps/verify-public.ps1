# 公网入口自检：VPS nginx 配好之后，在本机或任意机器上跑。
#   pwsh -File <repo>\dsh-auth\vps\verify-public.ps1
# 每一项都打 PASS/FAIL；FAIL 不终止，最后汇总。
param(
    [string]$Domain = 'dsn.example.com'
)

$ErrorActionPreference = 'Continue'
$results = [System.Collections.Generic.List[object]]::new()

function Check([string]$Name, [scriptblock]$Test) {
    try {
        $detail = & $Test
        $results.Add([pscustomobject]@{ Item = $Name; Ok = $true; Detail = $detail })
    } catch {
        $msg = $_.Exception.Message
        if ($_.Exception.Response) { $msg = "HTTP $([int]$_.Exception.Response.StatusCode)" }
        $results.Add([pscustomobject]@{ Item = $Name; Ok = $false; Detail = $msg })
    }
}

function Web([string]$Url, [hashtable]$Headers = @{}) {
    Invoke-WebRequest -Uri $Url -Headers $Headers -UseBasicParsing -MaximumRedirection 0 `
        -SkipHttpErrorCheck -TimeoutSec 20
}

# 1) 未登录访问 / 必须被挡到登录页（302 到 /login.html）
Check '未登录 / -> 302 登录页' {
    $r = Web "https://$Domain/"
    if ($r.StatusCode -ne 302) { throw "期望 302，实际 $($r.StatusCode)" }
    if ("$($r.Headers.Location)" -notmatch 'login\.html') { throw "Location=$($r.Headers.Location)" }
    "$($r.StatusCode) -> $($r.Headers.Location)"
}

# 2) 登录页必须 200 且带密码框
Check '登录页 200' {
    $r = Web "https://$Domain/login.html"
    if ($r.StatusCode -ne 200) { throw "实际 $($r.StatusCode)" }
    if ($r.Content -notmatch 'name="password"') { throw '页面里没有密码输入框——可能不是 dsh-auth 在响应' }
    "200, $(($r.Content.Length)) bytes"
}

# 3) 错误密码必须回登录页且不泄露细节
Check '错误密码 -> 登录页(带错误)' {
    $r = Invoke-WebRequest -Uri "https://$Domain/_app_login" -Method POST `
        -Body @{ password = 'definitely-wrong'; code = '000000' } -UseBasicParsing `
        -MaximumRedirection 0 -SkipHttpErrorCheck -TimeoutSec 20
    if ($r.StatusCode -ne 302) { throw "期望 302，实际 $($r.StatusCode)" }
    "$($r.StatusCode) -> $($r.Headers.Location)"
}

# 4) 未认证访问 /api/ 不能是 403（403 说明 --trusted-host 没生效）
Check '/api/ 未被 403（trusted-host 生效）' {
    $r = Web "https://$Domain/api/"
    if ($r.StatusCode -eq 403) { throw '403：dsh 的 --trusted-host 没生效或 Host 被改写' }
    "$($r.StatusCode)"
}

# 5) 证书必须覆盖本域名
Check 'TLS 证书覆盖域名' {
    $tcp = New-Object System.Net.Sockets.TcpClient($Domain, 443)
    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($Domain)
    $cert = $ssl.RemoteCertificate
    $name = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::DnsName, $false)
    $exp = [datetime]$cert.GetExpirationDateString()
    $ssl.Dispose(); $tcp.Dispose()
    if ($name -ne $Domain) { throw "证书主体是 $name" }
    "$name, 到期 $($exp.ToString('yyyy-MM-dd'))"
}

# 6) 限流：连续 9 次错误密码，第 6 次起应是 429
Check '登录限流生效（应出现 429）' {
    $codes = 1..9 | ForEach-Object {
        (Web "https://$Domain/_app_login?password=x&code=000000").StatusCode
    }
    if ($codes -notcontains 429) { throw "9 次都没有 429，实际：$($codes -join ',')" }
    ($codes -join ',')
}

$results | Format-Table -AutoSize

$failed = @($results | Where-Object { -not $_.Ok }).Count
if ($failed -gt 0) {
    Write-Host "`n$failed 项未通过" -ForegroundColor Red
    exit 1
}
Write-Host "`n全部通过" -ForegroundColor Green
