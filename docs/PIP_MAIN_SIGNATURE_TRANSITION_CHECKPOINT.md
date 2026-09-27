# PiP ↔ Main Signature Transition — Checkpoint (FROZEN)

Status: **frozen** at a 650ms reveal. Motion tuning reopens only if video QA finds a
specific, reproducible problem. Do not retime speculatively.

This supersedes `PIP_MAIN_SIGNATURE_TRANSITION_MILESTONE.md` for implementation
status. That document is the original design brief and is kept as history.

## What the user should feel

The PiP Core stays where it is, space opens from it, the Core travels to its Main
position, the workspace follows, content arrives last, and everything condenses back
into the PiP at the position the user last dragged it to.

## Final timings

All values are measured in a real Electron run, not asserted by reading the source.

| Stage | Duration | Notes |
|---|---|---|
| Core travel (opening) | 750ms | `CORE_MOVE_MS` |
| Workspace reveal (opening) | **650ms** | calibrated, see below |
| Content entrance | 854ms start, ~1140ms complete | begins ~200ms after the workspace settles |
| Closing prep | 240ms | Core stationary, workspace contracts |
| Closing Core move | 420ms | |
| Closing reveal | 460ms | trails the Core by ≤16px |
| PiP fade | 160ms | |

Easing is `cubic-bezier(0.22, 1, 0.36, 1)` for every moving part, in both directions.
The reveal must use the same curve as the Core: with a different curve the circle
fell 262px behind mid-flight, because the Core's curve is heavily front-loaded while
a symmetric ease is not.

## Native and visual motion are separate

`setBounds` is called **exactly once per direction** (`expandCommandCenter`,
`collapseToPip`). There is no per-frame window resize. All visual continuity is CSS:
`transform`, `clip-path`, `opacity`.

PiP bounds live in `electron/main.cjs` and are re-clamped on
`display-metrics-changed` / `display-removed`. Round-trip position and size drift is
asserted at 0.

## How the reveal travels without a JS loop

Both endpoints are known before the transition begins, written to the shell as
custom properties, and interpolated by the browser:

```
--reveal-start-x/y   PiP Core centre, measured
--reveal-end-x/y     Main Core centre, measured
```

The layout effect that inverts the Core onto the PiP position runs between the DOM
update and paint, so the Core is already on the PiP position when the Main surface
becomes visible. Acceptance reads back the **authored inline** value each frame and
fails if it changes more than once per transition — a JS tracking loop would rewrite
it every frame. Measured separation between the Core and the reveal centre peaks at
**6% of the Core's travel** in both a small window (26px over 428px) and a PiP
dragged to the far corner (77px over 1294px).

## Why 650ms

Four candidates, same measurement harness. "Reveal ends" is when the circle stops
moving; "Core settles" is when the Core is within 3px of its final position.

| Reveal | Reveal ends | Core settles | Relationship |
|---|---|---|---|
| 500ms | 511ms | 578ms | **67ms before the Core** — rejected |
| **650ms** | **654ms** | **587ms** | **67ms after the Core** |
| 800ms | 777ms | 586ms | 191ms after |
| 950ms | 897ms | 580ms | 317ms after |

The workspace trailing the Core is the effect, not an accident. A reveal that
finishes first makes the Core stop being the thing that leads, so 500ms is
disqualified regardless of how it looks in isolation. 650ms is the shortest duration
that still finishes after the Core.

## Two defects found by measuring

Neither was visible in the source or in static screenshots.

1. **The inversion offset survived the transition.** `pipOffset` was never reset, so
   the next transition measured the Main Core with the previous offset still applied
   and read back the PiP position. The FLIP inversion silently became a no-op and the
   reveal was handed two identical endpoints. Round trips after the first were not
   animating properly at all. Fix: clear the offset on `OPEN_COMPLETE` and
   `CLOSE_COMPLETE`. Acceptance caught it — sampled Core positions went 6 → 38.

2. **A percentage circle centre cannot be interpolated into a length.** The settled
   Main state used `circle(150vmax at 50% 50%)`; Chromium kept the percentage form for
   the whole `closing-prep` transition and then snapped to the measured position at
   the end, so the reveal visibly jumped sideways instead of holding on the Core.
   Fix: express the settled state in the same px custom properties, and publish the
   endpoint before `closing-prep` begins.

## What reopens this

Only a video QA pass that identifies a specific problem — a visible jump, a pacing
that reads wrong in motion, or a native resize artifact. Frame numbers and DOM
assertions are not grounds for further retiming; they are already at or near their
measured optimum. Static frames cannot show a 1–2 frame transition, and the native
swap is deliberately hidden behind `opacity: 0` for exactly that reason.

## Verification

`tests/verify_workspace_explorer_pip.cjs` covers both directions, repeat round trips,
Escape, reduced motion, drag, and hit-testing. `tests/measure_signature_motion.cjs`
is the rAF measurement harness. `tests/sweep_reveal_duration.cjs` reproduces the
calibration above and restores the stylesheet on every exit path.

## Next milestone

AI Edit V1. The mutation logic lives in the authoritative Harness, reached over the
existing JSONL bridge per `HARNESS_INTEGRATION_CONTRACT.md`. Do not copy Harness
files into this repository.
