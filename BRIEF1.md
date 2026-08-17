# BRIEF1 -- v2.1.0 -- the option shape (P2b)

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 2.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [OP-04 (remainder)]
depends_on: [P2a / 2.0.0 -- SHIPPED 2026-08-15]
blocks: [BRIEF2]
---

# @zakkster/lite-object-pool -- make the contradiction unrepresentable

PURPOSE
  1.1.0 made `{size: 10, maxSize: 4}` throw. That was the right minimal fix and
  it is also the evidence: a contradiction you have to validate is a
  contradiction the API let the caller write. lite-signal cannot express this
  bug, because it has ONE capacity plus a SEPARATE population strategy. This
  session takes that shape. Everything here is ADDITIVE -- `size`, `maxSize` and
  `expand` keep working as aliases -- which is why it did not have to ride 2.0.0
  and why no caller is forced through a second migration.

  Carried in with it: the two pieces of harness debt 2.0.0 left behind, and the
  half of OP-04 that 2.0.0 could not close.

THE DECISION (record it in decisions/D5-options.md BEFORE any code)
  Roadmap Decision 5, recommendation B, already argued and accepted:
    `capacity`  -- the single bound. Default Infinity.
    `prealloc`  -- how much of it is built at construction: `"eager"` (all of
                   it, REQUIRES a finite capacity), `"lazy"` (none), or an
                   integer count. Default `"eager"`, since hard-real-time is
                   this package's stated audience; lite-signal ships `"lazy"`
                   for footprint-sensitive callers and documents the tradeoff
                   as deterministic latency + zero-alloc hot path against a
                   larger resident heap that every major GC traces. Offer both.
    `onExhausted` -- `"null" | "grow" | "throw"`, folding in `expand` per
                   Decision 4. Default fail-closed.
  What the decision record must ALSO settle, because 2.0.0 changed the ground
  under it and the roadmap text predates that:
  - **Alias precedence.** `{size: 8, capacity: 16}` -- throw, or does one win?
    Recommendation: THROW. Accepting both silently reintroduces exactly the
    class of bug this session exists to delete. Same for `{expand: false,
    onExhausted: "grow"}`.
  - **`prealloc: "eager"` with `capacity: Infinity`** must throw by name, not
    hang allocating. This is the new spelling of the OP-02 trap and it must not
    survive the reshape.
  - **The reserved-name errors already ship.** 2.0.0's unknown-key rejection
    throws on `capacity` / `prealloc` / `onExhausted` with a message pointing at
    "the additive 2.1.0 reshape". Those three messages must flip from "reserved,
    coming in 2.1.0" to real handling in the same diff. Grep for them; a stale
    "coming in 2.1.0" shipping IN 2.1.0 is the kind of thing that survives a
    whole release.
  - **Deprecation posture for the aliases.** Recommendation: accepted and
    documented, NOT warned. A console warning in a constructor is an allocation
    and a side effect in a library whose identity is neither. Say so in the
    record so it is not re-proposed as a kindness.

TASKS
  - `decisions/D5-options.md` first, covering the four points above.
  - Implement the shape. All of it is constructor-cold: `acquire`, `release`,
    `releaseAll` and `forEachActive` must gain ZERO instructions. This is
    checkable by diff -- see ASSERTIONS.
  - Normalise aliases to the canonical triple in ONE place at construction, so
    the rest of the class reads only `capacity` / `prealloc` / `onExhausted`.
    Do not thread both spellings through the body.
  - **OP-04's remainder.** 2.0.0 closed the destroyed-pool case (it throws now).
    Exhausted-with-`expand:false` and capped-at-`maxSize` still BOTH return
    `null` and the caller cannot tell them apart. `onExhausted: "throw"` gives
    callers a way out; decide and document whether `"null"` should keep
    conflating the two, or whether the capped case is distinguishable. Do not
    close OP-04 in the CHANGELOG without saying which of these you did.
  - `expand`/`size`/`maxSize` alias tests: every existing 2.0.0 config in the
    README, llms.txt and the test suite must still construct an identical pool.
    Assert equality of `{size, used, free}` and behaviour, not just "no throw".
  - llms.txt + ObjectPool.d.ts + README updated for the new shape, with the
    aliases documented as permanently supported.

HARNESS DEBT FROM 2.0.0 (do these here; they are not product changes)
  - **The composite lane has no positive control.** `t6-alloc.mjs` validates its
    netting instrument at `NET_OPS=1000, perUnit=1` only. The OP-01c lane -- the
    session-defining composite shape -- runs at `SPIKE_OPS=400` x `CAP=4096`
    acquires per step, a completely different window, and window size is
    load-bearing: the swept table in the t6 header shows the control reading
    exact zero (i.e. going BLIND) at ops=5000 and ops=20000. So OP-01c's zero is
    currently an unvalidated zero. It was measured once and does discriminate --
    clean `0.000000` B/acquire vs `0.009756` B/acquire against a body with ONE
    retained object per step -- but that measurement now exists nowhere in the
    repo. Add a second positive control at the composite lane's exact
    parameters, failing with the same BLIND message as the existing one.
  - **`compositeSink` is write-only.** `t6-alloc.mjs:78` declares it, the visit
    closure adds `o.x` to it, and nothing ever reads it. It is the only thing
    stopping V8 from eliminating the `forEachActive` body, and it also cannot
    distinguish "visited 4096 objects" from "visited 0" because `x` is always 0.
    Make it observable (assert a non-vacuous visit count inside the measured
    window, or seed `x` non-zero and assert the expected sum).
  - Both are T6 changes, so both must be re-proven by the full control sweep,
    not just by a green run.

HOT PATH
  Nothing in this session belongs on it. The whole point of recommendation B is
  that it moves a runtime contradiction into the type of the constructor
  argument. If `assertOps` moves at all on acquire/release, something leaked out
  of the constructor and the diff is wrong.

ASSERTIONS
  - **The zero-instruction claim, proven by diff**: the bodies of `acquire`,
    `release`, `releaseAll` and `forEachActive` are byte-identical to their
    2.0.0 form. Diff them explicitly; do not infer it from the gate passing.
  - `alloc=0.000 B/op` unchanged, and `assertOps` on acquire/release within
    noise of the 2.0.0 baseline.
  - Every 2.0.0 config still constructs an identical pool (alias equivalence
    table, both directions).
  - `{size: n, capacity: m}` throws by name. `{expand, onExhausted}` throws by
    name. `{prealloc: "eager", capacity: Infinity}` throws by name.
  - No string "coming in 2.1.0" or "reserved" survives anywhere in the shipped
    files. Grep asserted in a test, not by eye.
  - The composite positive control fails the tier when the instrument is blinded
    (arm it deliberately once and watch it fail), and `OBJECTPOOL_TORTURE_BREAK=t6`
    still exits 1.
  - torture "ok"; all NINE tier controls exit non-zero (this brief originally
    said eight -- it predated t2 joining the walk; QA flagged the undercount
    rather than rounding it to "met"); `npm pack --dry-run`
    still ships exactly 7 files.

NON-GOALS
  No stats() -- BRIEF2. No handle API. No shrink/TTL. No structural change to
  the sparse set: if this diff touches `_dense`, `_sparse` or `_slots`, stop,
  because the option layer has no business there.

DONE WHEN
  the contradiction is unrepresentable rather than rejected;
  every 2.0.0 config still works untouched and a test proves it;
  the composite lane's zero is a validated zero
```

## Note carried out of 2.0.0, not scheduled here

**The lite-signal finding is still unfiled.** `createRegistry` options are
unvalidated and fail open on typos; `maxNodes: -1` reaches
`TypeError: Cannot read properties of undefined (reading 'nextFree')`. It is a
different package, so it does not belong in these briefs -- but it is the prior
art that produced Decision 5, and the roadmap records it as "NOT yet filed as of
2026-08-15". It needs its own session under the one-package-at-a-time law.
