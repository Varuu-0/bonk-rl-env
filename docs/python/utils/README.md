# utils/

Utility modules for training logging and map visualization.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [training_logger.md](training_logger.md) | `python/utils/training_logger.py` | `TrainingLogger` class — lightweight CSV logger for recording episode/step data during RL training (state, action, reward, done, timing) |
| [visualize_map.md](visualize_map.md) | `python/utils/visualize_map.py` | Map visualization tools — `draw_map()` renders platforms/hazards/grapple points from JSON, `animate_trajectory()` plays back logged player paths from CSV |
