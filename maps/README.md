# maps

Bonk.io map files in JSON format, exported from the game editor. Each file contains the complete physics geometry, spawn points, and collision configuration for a single arena.

## Files

| File | Description |
|------|-------------|
| `bonk_Simple_1v1_123.json` | Basic 1v1 arena with minimal geometry — a single flat platform |
| `bonk_Ball_Pit_524616.json` | Ball pit map with multiple dynamic bodies and high restitution surfaces |
| `bonk_WDB__No_Mapshake__716916.json` | WDB (World Domination Battle) map with capture zones, barriers, and full feature set |

## Map Format

Each map JSON file contains the following structure:

### Metadata
- `name` — display name of the map
- `author` — creator username
- `dbid` — Bonk.io database ID
- `exportedAt` — ISO 8601 export timestamp

### Spawn Points
Object keyed by team name (`team_red`, `team_blue`, etc.), each with `x` and `y` coordinates.

### Capture Zones (`capZones`)
Array of capture zone objects used in WDB and other objective-based game modes. Each zone has an `index`, `owner`, `type`, and `fixture`.

### Bodies
The core geometry of the map. Each body defines a physics shape with the following properties:

#### Shape Types
| `type` | Description |
|--------|-------------|
| `rect` | Rectangle (defined by `width` and `height`) |
| `circle` | Circle (defined by `radius`) |
| `polygon` | Custom polygon (defined by vertex array) |

#### Transform
- `x`, `y` — world position
- `angle` — rotation in radians
- `static` — if `true`, body is immovable

#### Collision Rules (`collides`)
Controls which collision groups the body interacts with:
- `g1` — Group 1 (default player group)
- `g2` — Group 2
- `g3` — Group 3
- `g4` — Group 4

#### Physics Properties
| Property | Description |
|----------|-------------|
| `friction` | Surface friction coefficient (0 = ice, 1+ = high grip) |
| `restitution` | Bounciness (-1 = dead stop, 0 = no bounce, 0.8+ = very bouncy) |
| `density` | Mass per unit area (affects how bodies push each other) |
| `noPhysics` | If `true`, body exists visually but has no collision physics |
| `linearDamping` | Velocity decay rate |
| `angularDamping` | Rotation decay rate |

#### Grapple Rules
| Property | Description |
|----------|-------------|
| `noGrapple` | If `true`, grapple/hook cannot attach to this body |
| `innerGrapple` | If `true`, grapple attaches to the interior of the shape |
| `grappleMultiplier` | Custom grapple pull strength multiplier (if present) |

#### Other
- `isLethal` — kills player on contact
- `collidesWithPlayers` — special player collision override
- `color` — integer color value (RGB packed)
- `name` — optional body label
- `surfaceName` — optional surface group name

## Adding Maps

1. Export from [bonk.io](https://bonk.io) map editor
2. Place the JSON file in this directory with the naming convention `bonk_<MapName>_<dbid>.json`
3. Validate the JSON parses correctly: `python -c "import json; json.load(open('maps/your_map.json'))"`
4. Test loading with `npm test`
