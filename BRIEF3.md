# BRIEF3 -- v2.3.0 -- bench and demo (P4, renumbered from 2.2.0)

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 2.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: []
depends_on: [BRIEF2 / 2.2.0]
blocks: [BRIEF4]
---

# @zakkster/lite-object-pool -- the numbers, and something to look at

PURPOSE
  2.0.0 claims a measured improvement. A claim in a CHANGELOG is a number
  someone has to trust; a stamped benchmark is a number they can re-run. And the
  package that leads with "no GC pauses in your 60fps loop" still has no way for
  a reader to see a 60fps loop.

TASKS
  - Bench protocol v3 with stamped provenance (node version, OS, CPU, date,
    package version): v2 sparse-set vs v1 Set-based vs a naive-alloc baseline.
    Report acquire and release in ns/op AND bytes/op -- the bytes number is the
    interesting one and it is the one v1 loses on.
  - **Two object shapes, unconditionally.** The roadmap wrote this as "use two
    object shapes IF the OP-17 probe showed polymorphism costs". It ran during
    P2a and it DID: the mixed-mechanism lane measured 0.0022-0.0055 B/op, which
    is what killed the symbol-with-WeakMap-fallback design and forced
    WeakMap-only. The condition is satisfied, so the conditional is gone -- bench
    two shapes, and say in the bench notes that this is why.
  - The v1 comparison needs a v1 implementation to bench against. One already
    exists in-repo: T5's differential fuzz carries a v1 Set-based oracle. Reuse
    it rather than re-deriving one or pulling 1.1.0 off npm at bench time, and
    assert it is the same oracle T5 runs -- two divergent "v1"s would make the
    headline comparison unfalsifiable.
  - Verify `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` across the FULL
    bench workload, not just the torture body.
  - Demo per suite convention: oscilloscope phosphor-green, oklch tokens with
    hex declared first, `@media (hover: hover)`, rem sizing, `$`-prefixed cached
    DOM refs, importmap routing, pre-allocated ring buffers, ~10 Hz telemetry
    throttle, multi-scene `data-scene` tabs:
      * particle burst scene (the spike shape -- the OP-01 workload, live)
      * churn stress scene (steady 1:1 at capacity)
      * live watchPool pool-escape canary scene wired to lite-gc-profiler
        (this is the 2.2.0 `stats(out)` surface earning its keep -- if the
        canary cannot be driven from the demo, `stats()` was shaped wrong and
        that is a finding for 2.2.0, not a patch here)
  - Demo is never in `files[]`.
  - **Load the `demo-audit` skill before writing demo code.** The forced-reflow
    law is invisible to the GC torture harness, and this demo reads live
    telemetry every frame -- exactly where that bug lives.

HOT PATH
  The demo's per-frame body is a hot path with its own law. Cache every DOM ref,
  batch reads before writes, throttle all text updates to the telemetry tick,
  never read layout inside the raf body.

ASSERTIONS
  - The bench reproduces the CHANGELOG's 2.0.0 numbers within noise, or the
    CHANGELOG is corrected to match the bench. They must agree, and the
    resolution direction is recorded. The specific claim under test is
    "1,321,024 bytes -> 0" on a 20,000-object drain.
  - The naive-alloc baseline is genuinely naive (allocate per acquire), asserted
    by its bytes/op being non-zero. A baseline that optimises to zero measures
    nothing -- this is the same scalar-replacement trap that made the first T6
    positive control read 0.0000 B/op during P2a. Use a retained/escaping
    allocation.
  - Both object shapes are benched and the polymorphic delta is reported, even
    if it turns out to be noise at bench scale.
  - Demo runs 60fps with zero major GCs over 60 seconds under the profiler.
  - `npm pack --dry-run` excludes demo/, bench/, test/, decisions/, probe/.
  - torture "ok"; all tier controls exit non-zero.

NON-GOALS
  No new API. No structural change. **If the bench reveals a regression, that is
  a finding for a new session, not a fix smuggled into a bench commit.** The
  whole point of a stamped number is that it is allowed to disagree with you.

DONE WHEN
  every number in the docs is stamped and re-runnable;
  the demo shows the spike workload not allocating, live
```
