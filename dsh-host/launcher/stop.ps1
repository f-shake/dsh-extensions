$ErrorActionPreference = 'SilentlyContinue'
$port = 8791
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Kill only our node process. Never resolve the port: the portproxy rule makes
# 127.0.0.1:8791 look owned by svchost.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' -and
    $_.CommandLine -match '(^|\s)web(\s|$)' -and
    $_.CommandLine -match ('--port\s+' + $port + '(\s|$)')
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

# Then the hidden wrapper that owns the console for it.
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like "*$dir\launch.ps1*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
