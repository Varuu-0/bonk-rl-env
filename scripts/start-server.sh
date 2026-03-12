#!/bin/bash
# start-server.sh - Start the Bonk RL server in background
# Usage: ./start-server.sh [port]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$SCRIPT_DIR/server.pid"
LOG_FILE="$SCRIPT_DIR/server.log"

# Default port
PORT=${1:-5555}

# Check if server is already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
        echo "Server is already running with PID $PID"
        exit 1
    else
        echo "Removing stale PID file..."
        rm -f "$PID_FILE"
    fi
fi

echo "Starting Bonk RL server on port $PORT..."
cd "$PROJECT_DIR"

# Start server in background with nohup
nohup npm start > "$LOG_FILE" 2>&1 &
PID=$!

# Save PID
echo $PID > "$PID_FILE"

# Wait a moment for server to start
sleep 2

# Check if server started successfully
if kill -0 "$PID" 2>/dev/null; then
    echo "Server started successfully (PID: $PID)"
    echo "Log file: $LOG_FILE"
    echo "To stop: ./stop-server.sh or kill $PID"
else
    echo "Server failed to start. Check log: $LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
fi
