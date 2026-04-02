import time
import numpy as np
import zmq
import json
import sys
import os

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'envs')))

NUM_ENVS = 2
PORT = 5555
STEPS = 200

# Connect
context = zmq.Context()
socket = context.socket(zmq.DEALER)
socket.connect(f"tcp://127.0.0.1:{PORT}")
time.sleep(0.2)

# Init
socket.send_json({"command": "init", "numEnvs": NUM_ENVS, "config": {}, "useSharedMemory": True})
msg = socket.recv_json()
print(f"Init status: {msg.get('status')}")

# Reset
socket.send_json({"command": "reset", "seeds": [0] * NUM_ENVS, "options": {}})
msg = socket.recv_json()
print(f"Reset status: {msg.get('status')}")

actions = np.random.randint(0, 64, size=NUM_ENVS).tolist()

# === Profile each phase ===

# Phase 1: Just send
print(f"\n=== Phase 1: send_json only ({STEPS} iterations) ===")
start = time.time()
for _ in range(STEPS):
    socket.send_json({"command": "step", "actions": actions})
    socket.recv_json()  # need to recv to not overwhelm
elapsed = time.time() - start
print(f"  send+recv total: {elapsed:.3f}s = {STEPS/elapsed:.0f} SPS")

# Phase 2: Detailed breakdown of ONE step
print(f"\n=== Phase 2: Detailed single step breakdown ===")

# 2a: send_json
t0 = time.time()
socket.send_json({"command": "step", "actions": actions})
t1 = time.time()
send_ms = (t1 - t0) * 1000

# 2b: recv_json
msg = socket.recv_json()
t2 = time.time()
recv_ms = (t2 - t1) * 1000

# 2c: parse response
data = msg["data"]
t3 = time.time()
parse_ms = (t3 - t2) * 1000

# 2d: convert observations
for d in data:
    obs = np.zeros(14, dtype=np.float32)
    obs[0] = d["observation"]["playerX"]
    obs[1] = d["observation"]["playerY"]
    obs[2] = d["observation"]["playerVelX"]
    obs[3] = d["observation"]["playerVelY"]
    obs[4] = d["observation"]["playerAngle"]
    obs[5] = d["observation"]["playerAngularVel"]
    obs[6] = 1.0 if d["observation"]["playerIsHeavy"] else 0.0
    if len(d["observation"]["opponents"]) > 0:
        op = d["observation"]["opponents"][0]
        obs[7] = op["x"]
        obs[8] = op["y"]
        obs[9] = op["velX"]
        obs[10] = op["velY"]
        obs[11] = 1.0 if op["isHeavy"] else 0.0
        obs[12] = 1.0 if op["alive"] else 0.0
    obs[13] = d["observation"]["tick"]
t4 = time.time()
convert_ms = (t4 - t3) * 1000

# 2e: build result arrays
obs_list = [np.zeros(14, dtype=np.float32) for _ in data]
rewards = [float(d["reward"]) for d in data]
terminated = [bool(d["done"]) for d in data]
truncated = [False] * len(data)
t5 = time.time()
arrays_ms = (t5 - t4) * 1000

total_ms = (t5 - t0) * 1000
print(f"  send_json:       {send_ms:.2f} ms")
print(f"  recv_json:       {recv_ms:.2f} ms  <-- NETWORK + TS PROCESSING")
print(f"  JSON access:     {parse_ms:.2f} ms")
print(f"  obs conversion:  {convert_ms:.2f} ms")
print(f"  array building:  {arrays_ms:.2f} ms")
print(f"  TOTAL:           {total_ms:.2f} ms ({1000/total_ms:.0f} SPS)")

# Phase 3: Run 100 steps with timing
print(f"\n=== Phase 3: 100 steps with per-step timing ===")
step_times = []
for i in range(100):
    t0 = time.time()
    socket.send_json({"command": "step", "actions": actions})
    msg = socket.recv_json()
    data = msg["data"]
    obs_list = []
    for d in data:
        obs = np.zeros(14, dtype=np.float32)
        obs[0] = d["observation"]["playerX"]
        obs[1] = d["observation"]["playerY"]
        obs[2] = d["observation"]["playerVelX"]
        obs[3] = d["observation"]["playerVelY"]
        obs[4] = d["observation"]["playerAngle"]
        obs[5] = d["observation"]["playerAngularVel"]
        obs[6] = 1.0 if d["observation"]["playerIsHeavy"] else 0.0
        if len(d["observation"]["opponents"]) > 0:
            op = d["observation"]["opponents"][0]
            obs[7] = op["x"]
            obs[8] = op["y"]
            obs[9] = op["velX"]
            obs[10] = op["velY"]
            obs[11] = 1.0 if op["isHeavy"] else 0.0
            obs[12] = 1.0 if op["alive"] else 0.0
        obs[13] = d["observation"]["tick"]
        obs_list.append(obs)
    t1 = time.time()
    step_times.append((t1 - t0) * 1000)

step_times = np.array(step_times)
print(f"  Mean: {step_times.mean():.2f} ms")
print(f"  Median: {np.median(step_times):.2f} ms")
print(f"  P5: {np.percentile(step_times, 5):.2f} ms")
print(f"  P95: {np.percentile(step_times, 95):.2f} ms")
print(f"  Min: {step_times.min():.2f} ms")
print(f"  Max: {step_times.max():.2f} ms")
print(f"  SPS: {1000/step_times.mean():.0f}")

# Phase 4: recv_json timing only (no processing)
print(f"\n=== Phase 4: Raw send/recv timing (no response processing) ===")
recv_times = []
for i in range(100):
    t0 = time.time()
    socket.send_json({"command": "step", "actions": actions})
    msg = socket.recv_json()
    t1 = time.time()
    recv_times.append((t1 - t0) * 1000)

recv_times = np.array(recv_times)
print(f"  Mean: {recv_times.mean():.2f} ms")
print(f"  Median: {np.median(recv_times):.2f} ms")
print(f"  Min: {recv_times.min():.2f} ms")
print(f"  Max: {recv_times.max():.2f} ms")
print(f"  SPS: {1000/recv_times.mean():.0f}")

# Cleanup
socket.close()
context.term()
print("\n=== Done ===")
