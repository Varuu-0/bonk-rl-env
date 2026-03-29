# `visualize_map` Module

## Overview

The `visualize_map` module provides visualization tools for Bonk.io maps and training trajectories. It can render static maps with platforms, hazards, and grapple points, as well as animate player trajectories from logged CSV data.

## Module: `python.utils.visualize_map`

**Source File**: `python/utils/visualize_map.py`

---

## Function: `draw_map`

Renders a static Bonk.io map from JSON data onto a matplotlib axis.

```python
def draw_map(ax, map_data)
```

### Parameters

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `ax` | `matplotlib.axes.Axes` | The matplotlib axes to draw on. |
| `map_data` | `dict` | Map data dictionary loaded from JSON. Must contain a `bodies` key with a list of body objects. |

### Map Data Structure

The map JSON should follow this structure:

```json
{
  "name": "Map Name",
  "bodies": [
    {
      "type": "rect",
      "x": 0,
      "y": 0,
      "width": 100,
      "height": 20,
      "isLethal": false,
      "grappleMultiplier": 0
    },
    {
      "type": "circle",
      "x": 200,
      "y": -100,
      "radius": 30,
      "isLethal": true
    }
  ],
  "spawnPoints": {
    "blue": {"x": -200, "y": 200},
    "red": {"x": 200, "y": 200}
  }
}
```

### Body Types

| Type | Properties | Description |
|:-----|:-----------|:------------|
| `rect` | `x`, `y`, `width`, `height` | Rectangular platform or wall |
| `circle` | `x`, `y`, `radius` | Circular body (hazard, bumper) |

### Body Attributes

| Attribute | Type | Description |
|:----------|:-----|:------------|
| `isLethal` | `bool` | If true, the body is drawn in red (lethal hazard) |
| `grappleMultiplier` | `float` | If > 1000, drawn in cyan (grapple point) |

### Visualization Colors

| Element | Color | Description |
|:--------|:------|:------------|
| Normal platforms | Gray | Standard non-lethal terrain |
| Lethal bodies | Red | Hazards that kill players |
| Grapple points | Cyan | Surfaces that can be grappled |
| Spawn points | Yellow (X marker) | Team spawn locations |

### Example

```python
import json
import matplotlib.pyplot as plt
from visualize_map import draw_map

# Load map
with open("maps/bonk_WDB__No_Mapshake__716916.json", "r") as f:
    map_data = json.load(f)

# Create figure
fig, ax = plt.subplots(figsize=(10, 8))
ax.set_facecolor('#222222')
ax.set_xlim(-500, 500)
ax.set_ylim(-400, 400)
ax.invert_yaxis()  # Bonk.io uses Y-down

# Draw the map
draw_map(ax, map_data)

plt.savefig("map.png")
plt.show()
```

---

## Function: `main`

The main entry point for the visualization script. Provides a command-line interface for generating map and trajectory visualizations.

```python
def main()
```

### Command-Line Arguments

| Argument | Type | Default | Description |
|:---------|:-----|:--------|:------------|
| `--map` | `str` | `../../maps/bonk_WDB__No_Mapshake__716916.json` | Path to the map JSON file |
| `--log` | `str` | `logs/trajectory.csv` | Path to the CSV trajectory file |
| `--save` | `str` | `trajectory.gif` | Path to save the generated animation |

### Usage Examples

#### Display Static Map Only

```bash
python visualize_map.py --map ../../maps/bonk_WDB__No_Mapshake__716916.json
```

This will display the map without any trajectory animation.

#### Generate Trajectory Animation

```bash
python visualize_map.py \
    --map ../../maps/bonk_WDB__No_Mapshake__716916.json \
    --log logs/trajectory.csv \
    --save trajectory.gif
```

This generates an animated GIF showing player movement over time.

#### Save Animation with Custom Filename

```bash
python visualize_map.py \
    --map maps/Simple_1v1.json \
    --log logs/run_001.csv \
    --save animations/run_001.gif
```

### Output

- **Static display**: Opens a matplotlib window showing the map
- **Saved animation**: Creates a GIF file with player positions animated at ~30 FPS

### Coordinate System

The visualization uses the following coordinate conventions:

- **X-axis**: Horizontal position (negative = left, positive = right)
- **Y-axis**: Vertical position (Bonk.io uses Y-down, so the axis is inverted)
- **Origin**: Center of the arena

**Standard Arena Bounds**: Approximately -500 to +500 (X), -400 to +400 (Y)

### Player Markers

| Marker | Color | Description |
|:-------|:------|:------------|
| Player | Blue circle | The agent being trained |
| Opponent | Red circle | The opposing player (if present) |

Both markers have a radius of 15 units with white edges.

### Dependencies

- `matplotlib`
- `pandas` (for CSV reading)
- `pillow` (for GIF saving)

### Performance Notes

- Animation interval is 33ms per frame (~30 FPS)
- The `blit=True` option is used for efficient redrawing
- Large trajectory files may take time to generate

---

### Trajectory CSV Format

The visualization expects a CSV file with the following columns:

```csv
episode,tick,playerX,playerY,opX,opY,reward,done
1,0,100.0,-50.0,200.0,-50.0,0.0,False
1,1,101.5,-51.2,199.0,-50.5,0.1,False
...
```

| Column | Type | Description |
|:-------|:-----|:------------|
| `episode` | `int` | Episode number |
| `tick` | `int` | Step within the episode |
| `playerX` | `float` | Player X position |
| `playerY` | `float` | Player Y position |
| `opX` | `float` | Opponent X position |
| `opY` | `float` | Opponent Y position |
| `reward` | `float` | Reward received |
| `done` | `bool` | Episode termination flag |

---

### Error Handling

The script handles the following error cases gracefully:

1. **Missing map file**: Prints error message and exits
2. **Missing log file**: Displays static map only
3. **Empty log file**: Displays static map only
4. **Malformed CSV**: Prints error and displays static map

---

### Integration with Training

```python
# Generate visualizations after training
import subprocess

# Run training
subprocess.run(["python", "python/train_agent.py"])

# Generate visualization
subprocess.run([
    "python", "python/utils/visualize_map.py",
    "--map", "maps/bonk_WDB__No_Mapshake__716916.json",
    "--log", "logs/training.csv",
    "--save", "animations/training.gif"
])
```

---

### See Also

- [Training Logger](training_logger.md) - Generate the trajectory logs
- [BonkVecEnv](../envs/bonk_env.md) - The environment being visualized
