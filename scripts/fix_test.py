import os

fpath = r"C:\Users\varun\Desktop\Projects\bonk-rl-env\tests\unit\ipc-bridge-constructor.test.ts"

with open(fpath, "r") as f:
    content = f.read()

content = content.replace("mocks.globalProfiler", "mocks.profilerMethods")
content = content.replace("bridge.pool.getTelemetrySnapshots", "getMockPool(bridge).getTelemetrySnapshots")
content = content.replace("mocks.isTelemetryEnabled.mockReturnValueOnce(false)", "mocks.telemetryState.enabled = false")

with open(fpath, "w") as f:
    f.write(content)

print("Fixed")
