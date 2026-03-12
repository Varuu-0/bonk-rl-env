import json
import os
import argparse
import time
import pandas as pd
import matplotlib
matplotlib.use('Agg') # Headless backend for saving
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.animation import FuncAnimation

def draw_map(ax, map_data):
    """
    Draws the static map from the Box2D engine.
    Bonk.io physics uses Y-down (gravity Y=10), so we invert Y axis later.
    x, y in wdb.json represent the CENTER of the bodies.
    """
    for body in map_data.get("bodies", []):
        color = 'gray'
        if body.get('isLethal'):
            color = 'red'
        elif body.get('grappleMultiplier', 0) > 1000:
            color = 'cyan'
            
        btype = body.get('type')
        x, y = body.get('x', 0), body.get('y', 0)
        
        if btype == 'rect':
            w, h = body.get('width', 0), body.get('height', 0)
            # Matplotlib rectangle anchor is standard bottom-left (or top-left if inverted)
            anchor_x = x - (w / 2.0)
            anchor_y = y - (h / 2.0)
            
            rect = patches.Rectangle(
                (anchor_x, anchor_y), width=w, height=h,
                linewidth=1, edgecolor='black', facecolor=color, alpha=0.8
            )
            ax.add_patch(rect)
            
        elif btype == 'circle':
            r = body.get('radius', 10)
            circ = patches.Circle(
                (x, y), radius=r,
                linewidth=1, edgecolor='black', facecolor=color, alpha=0.8
            )
            ax.add_patch(circ)
            
    # Draw spawn points
    spawns = map_data.get("spawnPoints", {})
    for team, pos in spawns.items():
        sc = ax.scatter(pos['x'], pos['y'], marker='x', color='yellow', s=100, zorder=5)
        ax.annotate(team, (pos['x']+10, pos['y']-10), color='white')

def main():
    parser = argparse.ArgumentParser(description="Bonk.io Headless RL Visualizer")
    parser.add_argument("--map", type=str, default="../../maps/wdb.json", help="Path to map JSON")
    parser.add_argument("--log", type=str, default="logs/trajectory.csv", help="Path to csv trajectory containing playerX, playerY")
    parser.add_argument("--save", type=str, default="trajectory.gif", help="Path to save the generated animation")
    args = parser.parse_args()
    
    map_path = os.path.abspath(os.path.join(os.path.dirname(__file__), args.map))
    if not os.path.exists(map_path):
        print(f"Map file not found: {map_path}")
        return
        
    with open(map_path, 'r') as f:
        map_data = json.load(f)
        
    fig, ax = plt.subplots(figsize=(10, 8))
    ax.set_facecolor('#222222')  # Dark background
    
    # Setup rendering bounds
    # Bonk.io standard arena is typically 800x600 centered at 0,0
    ax.set_xlim(-500, 500)
    ax.set_ylim(-400, 400)
    
    # Invert Y axis because Bonk sets Gravity Y=10 (downward)
    ax.invert_yaxis()
    ax.set_title(map_data.get("name", "Bonk.io Map"))
    
    # Draw the map
    draw_map(ax, map_data)
    
    # Player marker
    player_marker = patches.Circle((0, 0), radius=15, facecolor='blue', edgecolor='white', zorder=10)
    ax.add_patch(player_marker)
    
    op_marker = patches.Circle((0, 0), radius=15, facecolor='red', edgecolor='white', zorder=9)
    ax.add_patch(op_marker)
    
    # Check if we have logs to playback
    log_path = os.path.abspath(os.path.join(os.path.dirname(__file__), args.log))
    if not os.path.exists(log_path):
        print(f"No trajectory log found at {log_path}. Displaying static map only.")
        plt.show()
        return
        
    try:
        df = pd.read_csv(log_path)
    except Exception as e:
        print(f"Error reading log: {e}. Displaying static map.")
        plt.show()
        return
        
    if len(df) == 0:
        print("Log is empty. Displaying static map.")
        plt.show()
        return
        
    print(f"Loaded trajectory with {len(df)} frames. Playing animation...")

    def update(frame_idx):
        row = df.iloc[frame_idx]
        player_marker.set_center((row['playerX'], row['playerY']))
        if 'opX' in row and 'opY' in row:
            op_marker.set_center((row['opX'], row['opY']))
        ax.set_title(f"Episode {row.get('episode', 0)} - Tick {row.get('tick', frame_idx)}")
        return player_marker, op_marker
        
    # Animation: interval=33ms for ~30 FPS
    anim = FuncAnimation(fig, update, frames=len(df), interval=33, blit=True, repeat=False)
    
    if args.save:
        print(f"Saving animation to {args.save}...")
        anim.save(args.save, writer='pillow', fps=30)
    else:
        plt.show()

if __name__ == "__main__":
    main()
