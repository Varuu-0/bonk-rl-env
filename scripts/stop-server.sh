#!/bin/bash
# stop-server.sh - Gracefully stop the Bonk RL server
# Usage: ./stop-server.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"

# Check if PID file exists
if [ ! -f "$PID_FILE" ]; then
    echo "Server is not running (no PID file found)"
    exit 1
fi

PID=$(cat "$PID_FILE")

# Check if process is running
if ! kill -0 "$PID" 2>/dev/null; then
    echo "Server is not running (stale PID file)"
    rm -f "$PID_FILE"
    exit 1
fi

echo "Sending SIGTERM to server (PID: $PID)..."

# Send SIGTERM for graceful shutdown
kill -TERM "$PID" 2>/dev/null || true

# Wait for process to terminate (max 10 seconds)
COUNT=0
while kill -0 "$PID" 2>/dev/null; do
    sleep 1
    COUNT=$((COUNT + 1))
    if [ $COUNT -ge 10 ]; then
        echo "Server did not stop gracefully, sending SIGKILL..."
        kill -9 "$PID" 2>/dev/null || true
        break
    fi
done

# Verify process is stopped
if kill -0 "$PID" 2>/dev/null; then
    echo "Failed to stop server"
    exit 1
else
    echo "Server stopped successfully"
    rm -f "$PID_FILE"
    
    # Show final log tail
    if [ -f "$LOG_FILE" ]; then
        echo ""
        echo "=== Last 20 lines of server log ==="
        tail -n 20 "$LOG_FILE"
    fi
fi
