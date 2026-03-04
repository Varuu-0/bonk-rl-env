
# Bonk.io Reinforcement Learning Environment

A high-performance, headless simulation engine for *Bonk.io*, designed specifically for reinforcement learning and automated agent training. This repository transforms the original multiplayer architecture into a synchronous, high-throughput environment capable of processing simulation steps at over 3,100 frames per second.

## Overview
This project decouples the core *Bonk.io* physics logic from the original multiplayer networking stack. By removing browser-based rendering and WebSocket bottlenecks, we have created a deterministic, headless simulation loop. This allows machine learning agents to train in minutes rather than days, making it an ideal environment for testing PPO, DQN, or other reinforcement learning algorithms.

## Architecture
- **Physics Engine**: Uses a direct integration of `bonk1-box2d` to provide authentic, deterministic game physics.
- **Synchronous Loop**: Replaces real-time `setInterval` clocks with a controlled, synchronous `tick()` system where the AI agent holds total authority over the simulation clock.
- **IPC Bridge**: Utilizes **ZeroMQ (ZMQ)** for high-speed, low-latency communication between the TypeScript-based physics engine and the Python-based machine learning pipeline.
- **Gymnasium API**: Implements a standard `gymnasium.Env` interface, ensuring seamless compatibility with popular RL libraries like `stable-baselines3`.

## Performance
By operating in a headless, non-networked state, the engine achieves a throughput of **>3,100 simulation steps per second** on standard consumer hardware. This is approximately 100x faster than real-time, drastically reducing the time required for agent convergence.

## Setup & Installation

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Python 3.8+](https://www.python.org/)

### Node.js Backend
1. Install dependencies:
   ```bash
   npm install
   npm install zeromq@6
   ```
2. Start the simulation engine:
   ```bash
   npx tsx src/main.ts
   ```

### Python ML Pipeline
1. Install requirements:
   ```bash
   pip install -r python/requirements.txt
   ```
   *(Ensure `stable-baselines3`, `gymnasium`, and `pyzmq` are included)*
2. Train your agent:
   ```bash
   python python/train_agent.py
   ```

## Repository Structure
- `/src`: Contains the TypeScript headless physics engine and the ZMQ bridge server.
- `/python`: Contains the `BonkEnv` Gymnasium wrapper and the training scripts.
- `/bonk1-box2d`: The source physics module reference.

## License
This project is for research and educational purposes. Please respect the original developers of *Bonk.io* and follow their policies regarding third-party software.

***

### Pro-Tip for your GitHub Repo:
Before you commit and push this:
1. **Create a `LICENSE` file**: If you aren't sure, the `MIT License` is the standard for open-source.
2. **Create a `.gitignore` file**: Make sure the following are inside to avoid cluttering your repo:
   ```text
   node_modules/
   python/__pycache__/
   models/
   tensorboard_logs/
   .env
   dist/
   ```
3. **Double-check your `requirements.txt`**: Run `pip freeze > python/requirements.txt` to ensure your training environment dependencies are locked for anyone else who wants to try your project! 
