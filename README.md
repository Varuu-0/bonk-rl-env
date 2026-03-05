
# Bonk.io Reinforcement Learning Environment

A high-performance, headless simulation engine for *Bonk.io*, designed specifically for reinforcement learning and automated agent training. This repository transforms the original multiplayer architecture into a synchronous, high-throughput environment capable of processing simulation steps at over 3,100 frames per second.

## Overview
This project decouples the core *Bonk.io* physics logic from the original multiplayer networking stack. By removing browser-based rendering and WebSocket bottlenecks, we have created a deterministic, headless simulation loop. This allows machine learning agents to train in minutes rather than days, making it an ideal environment for testing PPO, DQN, or other reinforcement learning algorithms.

## Architecture
- **Worker Pool**: Now operates as a Massively Parallel Vectorized Environment, dynamically scaling to use all available CPU cores via Node.js `worker_threads`.
- **Synchronous Loop**: Replaces real-time clocks with a synchronous `tick()` system equipped with a deterministic PRNG for perfectly reproducible rollouts.
- **Batch IPC Bridge**: Utilizes **ZeroMQ (ZMQ) ROUTER/DEALER** patterns for high-speed, batch communication between the TypeScript worker pool and the Python ML pipeline.
- **Vectorized Gymnasium API**: Implements the `stable_baselines3.common.vec_env.VecEnv` interface natively, allowing the Python agent to dispatch actions and aggregate observations across 64+ parallel environments simultaneously.

## Performance
By dispersing batched simulation steps across multiple worker threads, the engine achieves massive horizontal scaling. 

### Benchmark Results (Sustained Performance)
Ran 10,000 steps across varying instance counts to measure sustained throughput:

| Concurrent Envs (N) | Aggregate FPS | Total Time (10,000 steps) |
|:--------------------|:--------------|:--------------------------|
| 1                   | 3,120.19      | 3.2049s                   |
| 2                   | 5,171.39      | 3.8674s                   |
| 4                   | 8,533.98      | 4.6871s                   |
| 8                   | 12,829.85     | 6.2355s                   |
| 16                  | 17,969.23     | 8.9041s                   |
| 32                  | 21,917.79     | 14.6000s                  |
| 64                  | 23,460.06     | 27.2804s                  |

*Total physics throughput peaks at **>23,400 simulation steps per second** with 64 parallel environments.*

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
