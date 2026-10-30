# Register dsh-auth as an NSSM-managed Windows service (needs an elevated shell).
# ASCII comments only, same reason as start-auth.ps1.
#
#   Start-Process pwsh -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<repo>\dsh-auth\install-service.ps1'
$ErrorActionPreference = 'Stop'

$Root   = $PSScriptRoot
$Nssm   = 'C:\nssm.exe'
$Python = Join-Path $Root '.venv\Scripts\python.exe'
$Name   = 'dsh-auth'
$Args   = '-m uvicorn app:app --host 127.0.0.1 --port 8099 --log-level info'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'must run elevated (Administrator)'
    exit 1
}

if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    Write-Host "[$Name] service exists, updating config only"
} else {
    & $Nssm install $Name $Python $Args | Out-Null
    Write-Host "[$Name] service created"
}

& $Nssm set $Name AppDirectory $Root | Out-Null
& $Nssm set $Name DisplayName 'dsh-auth (password + TOTP gate for DSH)' | Out-Null
& $Nssm set $Name AppStdout (Join-Path $Root 'service-out.log') | Out-Null
& $Nssm set $Name AppStderr (Join-Path $Root 'service-err.log') | Out-Null
& $Nssm set $Name AppRotateFiles 1 | Out-Null
& $Nssm set $Name AppRotateBytes 1048576 | Out-Null
& $Nssm set $Name AppStopMethodConsole 3000 | Out-Null
& $Nssm set $Name Start SERVICE_AUTO_START | Out-Null
& $Nssm set $Name AppExit Default Restart | Out-Null

Restart-Service $Name -Force
Start-Sleep -Seconds 3

$svc = Get-Service -Name $Name
Write-Host "[$Name] status = $($svc.Status)"

try {
    $r = Invoke-WebRequest 'http://127.0.0.1:8099/healthz' -UseBasicParsing -TimeoutSec 5
    Write-Host "[$Name] healthz = $($r.StatusCode) $($r.Content)"
} catch {
    Write-Warning "[$Name] healthz failed: $($_.Exception.Message)"
    if (Test-Path (Join-Path $Root 'service-err.log')) {
        Get-Content (Join-Path $Root 'service-err.log') -Tail 20
    }
}
