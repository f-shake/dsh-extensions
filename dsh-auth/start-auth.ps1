# dsh-auth launcher (ASCII comments on purpose: this file may be run by powershell.exe 5.1,
# which mis-parses UTF-8 without BOM when the text contains non-ASCII comments).
#
# Starts uvicorn with BOTH streams redirected and then waits for it, so:
#   * no console output exists that Windows Terminal could show in a window (see below), and
#   * the scheduled task still sees a running action: uvicorn dying -> non-zero exit ->
#     the task's RestartOnFailure kicks in (3 x 1 min).
#
# Why not keep `& $Python -m uvicorn ...` in the foreground: Windows Terminal is the default
# terminal on this machine and opens a window for a console handed to it EVEN when that
# console was requested hidden (-WindowStyle Hidden). A foreground uvicorn therefore left a
# persistent WT window streaming "GET /check-cookie 200 OK" on the desktop (2026-11-08 logon).
# The same trap is documented in C:\Running\dsh\run-hidden.vbs; the task action is now
# wscript.exe -> start-auth-hidden.vbs for the same reason.
$ErrorActionPreference = 'Stop'

$Root   = $PSScriptRoot
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Port   = 8099
$OutLog = Join-Path $Root 'auth.out.log'
$ErrLog = Join-Path $Root 'auth.err.log'

if (-not (Test-Path -LiteralPath $Python)) {
    Write-Error "python venv missing: $Python"
    exit 1
}

# Port guard: if something already listens on 8099, exit quietly.
# Needed because both the logon task and a manual start may try to start this.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "[dsh-auth] port $Port already in use, nothing to do"
    exit 0
}

Set-Location $Root

# Fail fast when the config is incomplete instead of serving a broken login page.
if (-not (Test-Path -LiteralPath (Join-Path $Root '.env'))) {
    Write-Error "missing .env: run setup_totp.py then set-password.py first"
    exit 1
}

# Keep the previous stderr: a crash right after start leaves its evidence only there.
# Same pattern as C:\Running\dsh\restart-dsh.ps1.
if ((Test-Path -LiteralPath $ErrLog) -and ((Get-Item -LiteralPath $ErrLog).Length -gt 0)) {
    Copy-Item -LiteralPath $ErrLog -Destination "$ErrLog.prev" -Force -ErrorAction SilentlyContinue
}

$argList = @('-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', "$Port", '--log-level', 'info')
$p = Start-Process -FilePath $Python -ArgumentList $argList -WorkingDirectory $Root `
    -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru

Write-Host "[dsh-auth] pid $($p.Id) -> 127.0.0.1:$Port (access log: $OutLog)"
$p.WaitForExit()
exit $p.ExitCode
