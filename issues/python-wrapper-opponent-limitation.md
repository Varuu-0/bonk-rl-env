## Summary
Python `BonkVecEnv` only uses the first opponent in observations, ignoring additional opponents supported by the TypeScript backend.

## Severity
Minor

## Confidence
90

## Files / Locations
- python/envs/bonk_env.py:71-78

## Root Cause
The `_convert_obs` method only extracts data for the first opponent (index 0), discarding data for any additional opponents.

## Why This Matters
- Underutilized capability: TypeScript backend supports multiple opponents, but Python wrapper cannot use them.
- Inconsistent API: The observation space is defined as 14-dimensional regardless of number of opponents, but the backend can provide more data.
- Limits research into multi-agent scenarios.

## Evidence
```python
def _convert_obs(self, data):
    obs = np.zeros(14, dtype=np.float32)
    # ... player data ...
    if len(data["opponents"]) > 0:
        op = data["opponents"][0]  # Only uses first opponent
        obs[7] = op["x"]
        obs[8] = op["y"]
        obs[9] = op["velX"]
        obs[10] = op["velY"]
        obs[11] = 1.0 if op["isHeavy"] else 0.0
        obs[12] = 1.0 if op["alive"] else 0.0
    obs[13] = data["tick"]
    return obs
```

## Reproduction / Conditions
Any environment with `numOpponents > 1` will only provide data for one opponent in the Python wrapper.

## Suggested Fix
Extend the observation space to accommodate multiple opponents. The TypeScript backend already provides opponent data in an array; the Python wrapper should flatten this into the observation vector or use a more sophisticated structure (e.g., shape `(num_opponents, 5)`). This would require updating the observation space definition and conversion logic.

## Related Follow-Up
- Update Gymnasium observation space to be dynamic based on `num_opponents`
- Add configuration option to control opponent observation format
- Update documentation to reflect multi-opponent support in Python