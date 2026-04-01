# envs/

Gymnasium-compatible environment wrappers for the Bonk.io physics engine.

## Files

| Document | Source | Description |
|:---------|:-------|:------------|
| [bonk_env.md](bonk_env.md) | `python/envs/bonk_env.py` | `BonkVecEnv` class — vectorized Gymnasium VecEnv wrapper communicating with the Node.js engine via ZeroMQ. Supports N parallel environments, 6-bit action space (left/right/up/down/heavy/grapple), 14-dimensional observation vector, configurable frame skip and opponents |
