## Summary
`BonkVecEnv` does not validate that actions are within the valid range [0, 63], potentially masking bugs and causing undefined behavior.

## Severity
Minor

## Confidence
85

## Files / Locations
- python/envs/bonk_env.py:109-118 (step_async), 120-200 (step_wait)

## Root Cause
The wrapper passes actions directly to the backend without checking they are valid discrete values (0-63). While the backend ignores higher bits, invalid actions could indicate bugs in RL agent output.

## Why This Matters
- Silent failure: Invalid actions are not logged or corrected.
- Harder debugging: Errors in agent output won't be caught early.
- Potential for unexpected behavior if backend changes.

## Evidence
```python
def step_async(self, actions):
    if isinstance(actions, np.ndarray):
        actions = actions.tolist()
    self.socket.send_json({"command": "step", "actions": actions})
```

No validation that `actions` is a list of integers in [0, 63].

## Reproduction / Conditions
Sending actions like `[64, 100]` or `[-1]` will be passed to the backend without warning.

## Suggested Fix
Add validation in `step_async` or `step_wait` to ensure all actions are integers within [0, 63]. Log warnings or raise errors for invalid values.

## Related Follow-Up
- Consider adding similar validation in reset for seeds (though less critical)
- Update documentation to clarify action space expectations