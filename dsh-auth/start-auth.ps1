# dsh-auth launcher (ASCII comments on purpose: this file may be run by powershell.exe 5.1,
# which mis-parses UTF-8 without BOM when the text contains non-ASCII comments).
$ErrorActionPreference = 'Stop'

$Root   = $PSScriptRoot
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Port   = 8099

if (-not (Test-Path -LiteralPath $Python)) {
    Write-Error "python venv missing: $Python"
    exit 1
}

# Port guard: if something already listens on 8099, exit quietly.
# Needed because both the NSSM service and the logon task may try to start this.
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

Write-Host "[dsh-auth] listening on 127.0.0.1:$Port"
& $Python -m uvicorn app:app --host 127.0.0.1 --port $Port --log-level info
