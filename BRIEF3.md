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
    P2a and it DID: the mixed-mechanism lane measured 0.0055 B/op, which
    is what killed the symbol-with-WeakMap-fallback design and forced
    WeakMap-only. The condition is satisfied, so the conditional is gone -- bench
    two shapes, and say in the bench notes that this is why.
    [CORRECTED 2026-08-17: this brief read "0.0022-0.0055 B/op" and told the
    bench author to cite `probe/poly.mjs`. The measured figure is 0.0055 and it
    lives at `decisions/D1-structure.md:119`; the string "0.0022" appears
    nowhere in the repo. Cite the decision record, not the probe.]
  - The v1 comparison needs a v1 implementation to bench against, and there is
    NO reusable one in the repo. Recover it: `git show d3a13ad:ObjectPool.js`
    (VERSION '1.1.0', Set-based, verified) and freeze it verbatim as
    `test/baseline/ObjectPool-1.1.0.js`, alongside the ObjectPool-2.0.0.js
    baseline that already lives there. Then drive that ONE fixture from BOTH
    the bench and T5, and assert both use it -- two divergent "v1"s would make
    the headline comparison unfalsifiable.
    [CORRECTED 2026-08-17. This brief said "One already exists in-repo: T5's
    differential fuzz carries a v1 Set-based oracle. Reuse it rather than
    re-deriving one." That is FALSE and the task built on it was unrunnable.
    T5's "oracle" is `const active = new Set()` at `test/torture/t5-fuzz.mjs:43`
    -- shadow bookkeeping that mirrors what the pool did so used/free/identity
    can be cross-checked. It is not an ObjectPool, has no acquire/release, and
    cannot be benchmarked. Its own comment says "Oracle: v1-style", which is
    what this brief misread as "is v1". Also struck: "pulling 1.1.0 off npm" --
    recover from the local commit, not the network, so the fixture is pinned.
    And note there is no `1.1.0` git TAG; only v2.0.0 and v2.1.0 are tagged.
    The commit `d3a13ad` is the source.]
  - Verify `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` across the FULL
    bench workload, not just the torture body.
  - Demo per suite convention: oscilloscope phosphor-green, oklch tokens with
    hex declared first, `@media (hover: hover)`, rem sizing, `$`-prefixed cached
    DOM refs, importmap routing, pre-allocated ring buffers, ~10 Hz telemetry
    throttle, multi-scene `data-scene` tabs:
      * particle burst scene (the spike shape -- the OP-01 workload, live)
      * churn stress scene (steady 1:1 at capacity)
      * leak-hunt scene on the 2.2.0 `/debug` subpath: a `DebugObjectPool` with
        acquire-site tagging, a deliberate never-released cohort, and
        `createPoolLeakKernel().audit()` naming the offending call site live.
        This is the debug lane earning its keep. Show the cost honestly next to
        it. Cite the SHIPPED figures -- `llms.txt:87-89`, ~102 B/acquire with
        `captureStacks` off and ~1173 B (~1.2 KB) with it on -- so the demo,
        the docs and the package agree. The scene must also demonstrate that
        the debug lane is NOT the shipping hot path.
        [An independent QA re-measure during the 2.2.0 session read net 97 B
        off and net 1385 B on. The 97-vs-102 gap is noise; the 1385-vs-1173 gap
        is real and expected, because stack capture cost scales with call
        depth and the re-measure ran from a deeper site. Quote llms.txt as
        canonical and say the on-figure is depth-dependent. Do NOT quote the
        one-off 97/1.4 KB pair -- an earlier revision of this brief did, which
        would have put the demo in conflict with the shipped llms.txt.]
        [CORRECTED 2026-08-17. This brief asked for a "live watchPool
        pool-escape canary scene wired to lite-gc-profiler", and said that if
        the canary could not be driven from the demo then `stats()` was shaped
        wrong and that was a finding against 2.2.0. That task was unbuildable
        and the finding it threatened would have been false. Four reasons,
        all verified against `lite-gc-profiler/llms.txt:195-218` during the
        2.2.0 session: `watchPool` takes `(obj, slotId)` pairs, not a stats
        object; it detects the INVERSE condition (a pooled object that died);
        it is async and does not compose with `stabilize:'deep'`; and it has
        no pass verdict, so it can never be a gate. On top of that, `_items[]`
        holds a strong ref to every pooled object for the pool's lifetime, so
        a pool escape is impossible by construction and the canary would read
        zero forever. `stats(out)` still earns its keep in this demo -- it is
        what feeds the per-frame telemetry readout at 0 B/op -- but it is not
        wired to `watchPool`, because nothing can be.]
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
    State the count UNAMBIGUOUSLY, both numbers, because these two disagree by
    design and conflating them already cost this package once: `files[]` holds
    8 ENTRIES, and `npm pack` reports `total files: 9` -- npm always adds
    `package.json`, which is not listed in `files[]`. 8 and 9 are both correct
    for their own question. Assert the pack total is 9 and that `files[]` has
    8 entries; never assert one number against the other measurement.
    [The 2.2.0 session shipped an untyped `./debug` export because a brief
    asserted "exactly 8 files" and the coder dropped `ObjectPoolDebug.d.ts` to
    hit it, causing TS7016 for consumers. Nothing in the suite tested the
    count -- it existed only as brief prose. If a count and a correct product
    ever collide again, flag the collision; do not degrade the product to
    satisfy a number in a brief.]
  - torture "ok"; all tier controls exit non-zero.

NON-GOALS
  No new API. No structural change. **If the bench reveals a regression, that is
  a finding for a new session, not a fix smuggled into a bench commit.** The
  whole point of a stamped number is that it is allowed to disagree with you.

DONE WHEN
  every number in the docs is stamped and re-runnable;
  the demo shows the spike workload not allocating, live
```
