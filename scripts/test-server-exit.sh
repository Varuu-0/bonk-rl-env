#!/usr/bin/env bash
# test-server-exit.sh - Verify server exits automatically in TEST_MODE
# This script tests that TEST_MODE=1 causes the server to exit automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Testing server auto-exit in TEST_MODE ==="

cd "$PROJECT_DIR"

# Record start time
START_TIME=$(date +%s)

# Run server with TEST_MODE and capture output
echo "Running: TEST_MODE=1 npm start"
OUTPUT=$(TEST_MODE=1 npm start 2>&1 || true)

# Record end time
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "Output:"
echo "$OUTPUT"
echo ""

# Check that server started on port
if echo "$OUTPUT" | grep -q "Server running on port"; then
    echo "✓ Server started successfully"
else
    echo "✗ Server did not start properly"
    exit 1
fi

# Check that TEST_MODE was detected
if echo "$OUTPUT" | grep -q "TEST_MODE enabled"; then
    echo "✓ TEST_MODE detected"
else
    echo "✗ TEST_MODE not detected"
    exit 1
fi

# Check that server shut down
if echo "$OUTPUT" | grep -q "Shutting down"; then
    echo "✓ Server initiated shutdown"
else
    echo "✗ Server did not shut down"
    exit 1
fi

# Check that server stopped
if echo "$OUTPUT" | grep -q "Server stopped"; then
    echo "✓ Server stopped"
else
    echo "✗ Server did not stop properly"
    exit 1
fi

# Verify it exited within 5 seconds
if [ "$ELAPSED" -le 5 ]; then
    echo "✓ Server exited within $ELAPSED seconds (max allowed: 5)"
else
    echo "✗ Server took too long to exit: $ELAPSED seconds"
    exit 1
fi

echo ""
echo "=== All tests passed! ==="
exit 0
