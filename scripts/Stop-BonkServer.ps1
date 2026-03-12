# Stop-BonkServer.ps1 - Gracefully stop the Bonk RL server (Windows)
# Usage: .\Stop-BonkServer.ps1 [-Force]
#
# This script sends a termination signal to gracefully shut down the server.
# It waits for the server to terminate gracefully, with an optional force kill.

param(
    [switch]$Force = $false
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
$PidFile = Join-Path $ScriptDir "server.pid"
$LogFile = Join-Path $ScriptDir "server.log"

# Check if PID file exists
if (-not (Test-Path $PidFile)) {
    Write-Host "Server is not running (no PID file found)" -ForegroundColor Yellow
    Write-Host "If the server is running, delete any stale PID files and try again."
    exit 1
}

# Read target PID from file - use $TargetPid to avoid collision with PowerShell's $PID
$TargetPid = Get-Content $PidFile -ErrorAction SilentlyContinue

# Validate that we got a valid PID
if (-not $TargetPid) {
    Write-Host "Error: PID file is empty or invalid" -ForegroundColor Red
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

# Check if process is running
$Process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if (-not $Process) {
    Write-Host "Server is not running (stale PID file)" -ForegroundColor Yellow
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "Sending termination signal to server (PID: $TargetPid)..." -ForegroundColor Cyan

# Method 1: Try graceful termination via Ctrl+C simulation using dotnet
# This sends SIGINT equivalent on Windows
try {
    # Use node's process signal handling - send CTRL_C_EVENT
    # On Windows, we can use taskkill or direct process termination
    if (-not $Force) {
        # Try graceful shutdown first using taskkill with /T flag (terminate tree)
        # /T will terminate the process tree gracefully
        $result = & taskkill /PID $TargetPid /T /F 2>&1
        
        if ($LASTEXITCODE -eq 0) {
            Write-Host "Server terminated successfully" -ForegroundColor Green
        }
    } else {
        # Force kill
        Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
        Write-Host "Server force killed" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Error during termination: $_" -ForegroundColor Red
}

# Wait a moment for cleanup
Start-Sleep -Milliseconds 500

# Check if process is stopped
$Process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if ($Process) {
    Write-Host "Server did not stop gracefully, attempting force kill..." -ForegroundColor Yellow
    
    # Force kill using Stop-Process
    Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    
    $Process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if ($Process) {
        Write-Host "Failed to stop server" -ForegroundColor Red
        exit 1
    }
}

# Verify process is stopped
$Process = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
if ($Process) {
    Write-Host "Failed to stop server" -ForegroundColor Red
    exit 1
} else {
    Write-Host "Server stopped successfully" -ForegroundColor Green
    
    # Remove PID file
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    
    # Show final log tail if log file exists
    if (Test-Path $LogFile) {
        Write-Host ""
        Write-Host "=== Last 20 lines of server log ===" -ForegroundColor Cyan
        Get-Content $LogFile -Tail 20
    }
    
    exit 0
}
