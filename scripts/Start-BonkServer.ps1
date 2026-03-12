# Start-BonkServer.ps1 - Start the Bonk RL server in background (Windows)
# Usage: .\Start-BonkServer.ps1 [-Port <port>]

param(
    [int]$Port = 5555
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $ScriptDir "server.pid"
$LogFile = Join-Path $ScriptDir "server.log"

# Check if server is already running
if (Test-Path $PidFile) {
    $Pid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($Pid -and (Get-Process -Id $Pid -ErrorAction SilentlyContinue)) {
        Write-Host "Server is already running with PID $Pid"
        exit 1
    } else {
        Write-Host "Removing stale PID file..."
        Remove-Item $PidFile -Force
    }
}

Write-Host "Starting Bonk RL server on port $Port..."
Set-Location $ProjectDir

# Start server in background using Windows Management Instrumentation
$Process = Start-Process -FilePath "npm" -ArgumentList "start" -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile

# Save PID
$Process.Id | Set-Content $PidFile

# Wait a moment for server to start
Start-Sleep -Seconds 2

# Check if server started successfully
if (!$Process.HasExited) {
    Write-Host "Server started successfully (PID: $($Process.Id))"
    Write-Host "Log file: $LogFile"
    Write-Host "To stop: .\Stop-BonkServer.ps1 or Stop-Process -Id $($Process.Id)"
} else {
    Write-Host "Server failed to start. Check log: $LogFile"
    Write-Host "Exit code: $($Process.ExitCode)"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}
