# Start-BonkServer.ps1 - Start the Bonk RL server in background (Windows)
# Usage: .\Start-BonkServer.ps1 [-Port <port>]
#
# Environment Variables:
#   PORT - Alternative to -Port parameter

param(
    [int]$Port = 0  # Default to 0, will use env var or 5555
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $ScriptDir "server.pid"
$LogFile = Join-Path $ScriptDir "server.log"

# Check if server is already running
if (Test-Path $PidFile) {
    $ExistingPid = Get-Content $PidFile -ErrorAction SilentlyContinue
    if ($ExistingPid -and (Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue)) {
        Write-Host "Server is already running with PID $ExistingPid"
        exit 1
    } else {
        Write-Host "Removing stale PID file..."
        Remove-Item $PidFile -Force
    }
}

# Determine the port: use -Port argument, or PORT env var, or default 5555
$ServerPort = $Port
if ($ServerPort -eq 0) {
    $ServerPort = [int]$env:PORT
    if ($ServerPort -eq 0) {
        $ServerPort = 5555
    }
}

Write-Host "Starting Bonk RL server on port $ServerPort..."
Set-Location $ProjectDir

# Set PORT environment variable for the npm process
$Env:PORT = $ServerPort

# Start server in background using Windows Management Instrumentation
# Pass port via environment variable (npm start will read $PORT)
$Process = Start-Process -FilePath "npm" -ArgumentList "start" -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile -EnvironmentVariables @{PORT=$ServerPort}

# Save PID
$Process.Id | Set-Content $PidFile

# Wait a moment for server to start
Start-Sleep -Seconds 2

# Check if server started successfully
if (!$Process.HasExited) {
    Write-Host "Server started successfully (PID: $($Process.Id))" -ForegroundColor Green
    Write-Host "Server running on port: $ServerPort" -ForegroundColor Cyan
    Write-Host "Log file: $LogFile"
    Write-Host "To stop: .\Stop-BonkServer.ps1 or Stop-Process -Id $($Process.Id)"
} else {
    Write-Host "Server failed to start. Check log: $LogFile" -ForegroundColor Red
    Write-Host "Exit code: $($Process.ExitCode)"
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}
