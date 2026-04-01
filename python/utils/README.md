# Utils

Helper utilities for training, logging, and visualization. These modules support the RL training pipeline with CSV trajectory recording and map rendering from JSON definitions.

## Files

| File | Purpose |
|------|---------|
| `training_logger.py` | CSV-based training logger for episode rewards, positions, and done states |
| `visualize_map.py` | Renders Bonk.io map JSON files to static images or animated GIFs |

## Training Logger

`TrainingLogger` records per-step trajectory data to a CSV file for post-training analysis.

### Usage

```python
from utils.training_logger import TrainingLogger

logger = TrainingLogger(log_dir="logs", filename="trajectory.csv")

# In training loop
for episode in range(num_episodes):
    obs, _ = env.reset()
    for tick in range(max_ticks):
        action = model.predict(obs)
        obs, reward, terminated, truncated, info = env.step(action)
        logger.log_step(episode, tick, obs, reward, terminated)

logger.close()
```

### CSV Columns

| Column | Description |
|--------|-------------|
| `episode` | Episode index |
| `tick` | Tick within episode |
| `playerX`, `playerY` | Player position |
| `opX`, `opY` | Opponent position |
| `reward` | Step reward |
| `done` | Episode terminated |

## Map Visualizer

`visualize_map.py` renders Bonk.io map JSON files (from the Box2D engine) to images or animated GIFs, optionally overlaying trajectory data from training logs.

### Static Map

```bash
python utils/visualize_map.py --map ../../maps/bonk_WDB__No_Mapshake__716916.json
```

### Animated Trajectory

```bash
python utils/visualize_map.py \
    --map ../../maps/bonk_WDB__No_Mapshake__716916.json \
    --log logs/trajectory.csv \
    --save trajectory.gif
```

### Arguments

| Argument | Default | Description |
|----------|---------|-------------|
| `--map` | `../../maps/bonk_WDB__No_Mapshake__716916.json` | Path to map JSON file |
| `--log` | `logs/trajectory.csv` | Path to trajectory CSV |
| `--save` | `trajectory.gif` | Output file path (GIF if provided, interactive display otherwise) |

### Features

- Renders rectangles, circles, lethal zones, and grapple zones from map JSON
- Displays spawn points with labels
- Animates player and opponent positions from CSV logs at ~30 FPS
- Uses Y-down coordinate system matching Bonk.io physics
