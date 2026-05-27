# ROAST Rollout Policy Model (Phase C)

Date: 2026-03-03  
Status: Implemented  
Owner: Threshold Labs

## Objective

Encode staged rollout and rollback policy constraints from
`docs/frost-migration/roast-phase-5-security-rollout-gates.md` as executable
TLA+ properties.

## Model Artifacts

- `docs/frost-migration/formal-verification/models/RoastRolloutPolicy.tla`
- `docs/frost-migration/formal-verification/models/RoastRolloutPolicy.cfg`

## State Machine

Finite stages:

- `bootstrap`
- `canary`
- `broad`
- `rollback`
- `halted`

Control signals:

- `holdTrigger`
- `rollbackTrigger`
- `manualOverride`
- `emergencyStop`

## Checked Properties

Invariants:

1. `TypeOK`: all state variables remain in bounded domains.
2. `BroadRequiresCanaryHistory`: broad rollout requires prior canary
   completion.

Temporal properties:

1. `RollbackTransitionRequiresTrigger`: entering `rollback` requires an active
   rollback trigger and only from `canary` or `broad`.
2. `CanaryHoldBlocksPromotion`: hold/rollback triggers prevent canary promotion
   to broad rollout.
3. `BootstrapCannotJumpToBroad`: bootstrap cannot skip directly to broad
   rollout.
4. `EmergencyStopBlocksForwardProgress`: emergency stop blocks bootstrap canary
   start and canary promotion to broad.
5. `HaltedModeIsTerminal`: once halted, the model cannot leave `halted`.

## Execution

The model is included in the existing formal CI gate via:

```bash
scripts/formal/run_tla_models.sh
```

That script enumerates all `*.cfg` files in
`docs/frost-migration/formal-verification/models` and runs TLC for each model.
