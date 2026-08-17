# BRIEF2 -- v2.2.0 -- ecosystem lanes (P3, renumbered)

> REVISED 2026-08-17, after 2.1.0 shipped. The first draft of this brief was
> written before P2b and planned against a sibling API that does not exist. The
> revision is recorded in full at the bottom under "What this brief used to say",
> because the way it was wrong is the reusable lesson, not the fact that it was.

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 2.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [OP-16 (drift guard only)]
depends_on: [BRIEF1 / 2.1.0 -- SHIPPED 2026-08-17]
blocks: [BRIEF3]
---

# @zakkster/lite-object-pool -- make the pool observable without making it allocate

PURPOSE
  A pool is a thing that goes wrong quietly: objects acquired and never released
  look exactly like a busy frame until the pool is exhausted, and by then the
  acquire site is long gone. This session gives the pool a way to say what it is
  doing -- for zero bytes in production, and for real bytes in a lane that never
  loads in production.

  It also pays the last of the harness debt: T8 has been an 8-line stub since P0.

THE SIBLING-SURFACE FINDING (read this before anything else)
  The first draft of this brief planned `stats(out)` around lite-gc-profiler's
  `watchPool` canary. **That plan was wrong four independent ways**, verified
  against `node_modules/@zakkster/lite-gc-profiler/llms.txt:197-216` (v1.15.0;
  watchPool introduced 1.14.0), which matches `../LiteGCProfiler` at the same
  version -- so the installed copy the gate links against is the current surface.

    1. It never consumes a stats object. It takes `register(obj, slotId)` /
       `release(obj, slotId)` pairs. `stats(out)` therefore has NO external
       consumer, and its field set must be justified on our own contract.
    2. The semantics are INVERTED. watchPool detects a pooled object that
       should live and DIED. This brief wanted acquired-never-released.
    3. Against THIS pool it is structurally incapable of firing. `_items[]`
       holds a strong reference to every pooled object for the pool's whole
       lifetime, so no checked-out object can be collected. `escapeCount` is 0
       by construction, forever.
    4. It can never BE a gate. Law (2) in its own docs: absence is advisory,
       `assertNoEscapes` never throws on an empty list, and there is
       deliberately no `assertPoolClean`. It is also async, and does not
       compose with `stabilize:'deep'`, which `harness.mjs` always passes.

  A T8 built on watchPool would be a tier that passes unconditionally: a green
  light over a hole, which is the exact failure the roadmap's closing section
  exists to prevent.

  lite-leak (v1.8.1 installed, matching `../LiteLeak`) DOES have the kernel shape
  this brief assumed -- but only in one of the two forms it could have meant.
  `refine()` is the FinalizationRegistry path, firing when the tracked target is
  COLLECTED. By the same `_items[]` retention, an acquired-never-released pool
  object is never collected, so a refine-based sink reports clean forever.
  **The sink must be `audit()` + `count()` only** -- no `install()`, no
  `refine()`, no patch surfaces. lite-leak's own docs name this failure mode.

  Two further constraints, neither previously written down:
  - The HELD-VALUE CONTRACT: neither `cleanup` nor `tag` may close over the
    target. That bounds the acquire-site tag design directly.
  - `createCollectionGrowthKernel({ collections })` accepts anything exposing a
    numeric `size`. `ObjectPool` exposes `.size`, so unbounded-growth detection
    is available TODAY with zero new product code.
  And `lite-leak/sinks/EcosystemSinks.js` contains no pool sink, so the sink is
  new code in OUR tree, not a wiring job.

THE DECISION (record it in decisions/D6-debug-lane.md BEFORE any code)
  **Option B -- a `@zakkster/lite-object-pool/debug` subpath -- CONFIRMED.**
  Rejected: A (constructor flag) and C (build-time flag, dead on unbundled ESM).

  The first draft argued B from the law ("a branch that never fires still costs
  its bytes"). True, but unmeasured. The argument that now exists is mechanical:
  `t2-speed.mjs` pins four hot-body sha256 hashes and REFUSES TO RUN if either
  side drifts. Option A puts `if (this._debug)` inside `acquire()`, which changes
  `acquire.toString()`, which fails a named test in two files and falsifies T2's
  stated premise ("the true ns/op ratio is exactly 1.0"). Record B on that.

  **The single-file law question is RESOLVED -- do not treat it as blocking.**
  Suite law says "single PascalCase main file", and it means one main ENTRY, not
  one file. Evidence: 17 sibling packages ship subpath exports, including both
  peers this package gates against -- `@zakkster/lite-gc-profiler` ships
  `./register ./test-helpers ./explain`, and LiteLeakforge ships `./harness
  ./formatters ./scenarios ./panels`. B is legal. `files[]` grows 7 -> 8.

  Every point D6 must settle:
  1. B confirmed, with the hash/T2 evidence. A and C rejected, with reasons, so
     neither is re-proposed. Note the resolved law question and its evidence.
  2. `{debug: true}` handling. **There is no reserved-name list to add to** --
     `FUTURE_KEYS` and its constructor branch were DELETED in 2.1.0 (D5 point 3);
     what remains is `ALLOWED_KEYS` plus a generic unknown-key throw with a
     did-you-mean. `{debug:true}` ALREADY throws by name today, verified live:
       TypeError: ObjectPool: "debug" is not a recognized option. Known options:
       create, reset, capacity, prealloc, onExhausted (or the aliases size,
       expand, maxSize)
     Recommendation: leave it to the generic throw and PIN it with a test. A
     `debug`-specific message pointing at the subpath would re-create the exact
     special-case shape D5 deleted two days ago.
  3. Whether the debug lane may read privates (`_items`/`_slots`/`_active`).
     Recommendation: public-surface WRAPPER, not a subclass-with-privates, which
     would couple the debug lane to the sparse set and break silently on a future
     structural change. Same NON-GOAL as BRIEF1's option layer: if the diff
     touches `_dense` / `_sparse` / `_slots`, stop.
  4. What an acquire-site tag IS, bounded by lite-leak's HELD-VALUE CONTRACT: the
     tag must not close over the pooled object, or finalization is defeated.
     Decide the representation (monotonic id, optional `new Error().stack`) and
     state its per-acquire byte cost in llms.txt AS A NUMBER.
  5. That `leaks()` allocates a report per call, by design, documented
     not-for-production.
  6. Where `peakUsed` / `totalAcquires` / `totalReleases` live. A D6 point, not a
     coding one, because the answer decides whether the hot bodies change. The
     METHOD is fixed below; the record carries the method, the CHANGELOG the
     number.
  7. The `stats(out)` field set, decided per-field on cost now that there is no
     external consumer to satisfy: `size` / `used` / `free` are free (existing
     getters); `expansions` is free because `_grow` is cold AND NOT HASH-PINNED,
     so it ships regardless; the other three are the contested set.
  8. `out` aliasing -- the one named T0 case. It cannot be the pool's own
     counters object because there isn't one; say so. Decide `undefined` / `null`
     / frozen / Proxy: fail closed, throw naming `"out"`. **`stats()` with no
     argument must not silently allocate a fresh object** -- that is a hidden
     allocation in a package whose identity is the absence of one. Record the
     rejection of a shared module-level object (aliasing hazard).
  9. An explicit statement, for llms.txt and for the next reader: **watchPool
     cannot observe an acquired-never-released object from this pool, because
     `_items[]` retains it.** Written down once so nobody plans against that
     canary a third time.

TASKS
  1. `decisions/D6-debug-lane.md` -- all nine points. BEFORE any code.
  2. Roadmap renumbering: P3 frontmatter -> 2.2.0, P4 -> 2.3.0, P5 -> 2.3.0, and
     amend the 2026-08-15 split note that renumbered P3 without touching P4/P5.
  3. Roadmap section 7 / D1: record that the deferred handle-API trigger fired
     and is DISCHARGED. Cite `decisions/D1-structure.md:119` for the mixed-lane
     figure (0.0055 B/op) -- NOT the roadmap, which records 0.0000/~0.0000, and
     not the "0.0022" half of the old citation, which exists nowhere in the repo.
  4. `stats(out)`: writes into `out`, returns it, allocates nothing, throws
     naming `"out"` on a non-object. Ships `size` / `used` / `free` / `expansions`.
  5. `_grow`: `this._expansions++` on the growth branch only. Cold, not pinned,
     unconditional.
  6. `acquire` / `release` counters -- CONDITIONAL on the measurement below.
     Prepare both diffs; ship the one the number chooses.
  7. `ObjectPool.d.ts` (`ObjectPoolStats` + `stats`), llms.txt (stats section,
     the debug-lane allocation statement, and the watchPool statement from D6.9),
     README API row.
  8. The debug module + `exports["./debug"]` + `files[]`.
  9. `leaks()` + acquire-site tagging per D6.4.
  10. The lite-leak sink: an `audit()` + `count()` kernel. No `install()`, no
      `refine()`.
  11. Fill `test/torture/t8-cross.mjs`: three-place version sync; docs-drift both
      directions; the lite-leak audit-kernel round trip (clean -> `count() === 0`,
      deliberate leak -> `count() === 1`); `createCollectionGrowthKernel` against
      `pool.size`; a watchPool availability/shape check recorded as ADVISORY.
  12. `ALL_ARMABLE_TIERS`: add `'t8'`. It currently lists NINE (t0 t1 t2 t3 t4 t5
      t6 t7 t9) and t8 is absent -- which is why BRIEF1 said nine. The walk
      becomes TEN. Decide `CONTROL_OWNING_TIERS` membership and update the
      class-list prose in `controls.mjs`'s header and in `torture.mjs`.
  13. `test/baseline/ObjectPool-2.2.0-counters.js` -- the candidate copy for the
      measurement. Deleted or promoted at session end; never shipped.
  14. `t6-alloc.mjs`: a `stats(out)` lane at the existing validated `NET_OPS` /
      `perUnit=1` window, checked `=== 0`.
  15. `ObjectPool.test.js`: stats cases, the `out` fail-closed matrix, the
      `{debug:true}` throw, and the hash pins if and only if they moved.
  16. `t2-speed.mjs` HOT_HASHES + `test/baseline/speed-2.2.0.json` -- ONLY if the
      counters land in the hot body. `speed-2.1.0.json` is appended to, never
      edited.
  17. CHANGELOG 2.2.0 entry carrying the measured ratio and the kept-or-moved
      outcome as a number.

HOT PATH -- the counter question, METHOD DECIDED NOW
  `stats(out)` is not hot (telemetry rate, ~10 Hz). But `peakUsed` /
  `totalAcquires` would increment IN `acquire`/`release`, and that is the one
  place this session can regress 2.0.0's headline.

  Step 1. The hash pin is the TRIPWIRE, not the measurement. Adding `this._acq++`
    makes the shipped hash diverge and T2 dies BEFORE it measures anything. That
    hard failure is the signal that the decision is live. Do not work around it.
  Step 2. Measure with a THIRD file, never by editing the shipped one. Freeze the
    candidate copy and run T2's own machinery against the frozen 2.0.0 copy:
    `compareOps`, min-over-9 of `max(A/B, B/A)`, OPS=50000, WARMUP=5000. The
    shipped hash pin stays green and `torture.mjs` keeps printing `ok` while the
    question is open.
  Step 3. THRESHOLD: keep the counters iff min-over-9 <= 1.05 on three
    independent trials. Not a new number -- T2's own sweep puts the clean
    identical-body floor at <= 1.014 over six trials and single-run noise at up
    to 1.11. So 1.05 is ~3.5x the clean floor and well under the shipped
    THRESHOLD of 1.15: a reading <= 1.05 is indistinguishable from identical
    bodies under the tier's own statistic. Any trial > 1.05 -> move to debug.
    Ambiguity -> move to debug. Fail closed.
  Step 4. T6 is a VETO, not a tiebreak. Whatever T2 says, the candidate must read
    exactly 0 through `netBytesPerOp` on all three OP-01 lanes. If any lane reads
    non-zero the counters move regardless of speed.
  Step 5. The hash fixture, both ways:
    MOVED (the default): HOT_HASHES unchanged, the 2.0.0 fixture unchanged,
      `speed-2.1.0.json` stays the record of record -- and the byte-identical
      claim is then proven by a test that ALREADY RUNS rather than by a manual
      diff, which is strictly better than what this brief originally asked for.
    KEPT: all four hashes re-pinned in BOTH places, a new 2.2.0 fixture frozen,
      and -- the cost nobody priced -- T2 stops being an identical-body
      comparison, so its premise becomes false and its rationale must be
      REWRITTEN, not retuned. T2 degrades from a noise-floor gate to a
      magic-number gate, which its own header argues against. That cost is high
      enough to tip any borderline reading toward moving.

ASSERTIONS
  - `node --expose-gc test/torture.mjs` -> exactly `ok`, exit 0, with T8 live.
  - `node test/controls.mjs` -> exactly `ok`, and `ALL_ARMABLE_TIERS.length === 10`
    asserted in a test. t8 armed alone must exit non-zero with either a `T8:` tag
    or the backstop message, and must NEVER emit CONTROL-DEFEATED.
  - `stats(out)` nets 0 B/op through `netBytesPerOp` at the ALREADY-VALIDATED
    `NET_OPS`/`perUnit=1` window. The check is `=== 0`, never `<= epsilon`;
    widening it is the blinding mode, caught by arming t6. If anyone changes the
    stats lane's window, the composite-control precedent applies and a matching
    positive control at the new window is MANDATORY.
  - GATE line still reads `alloc=0.000 B/op` and `leak=size 0/0`.
  - The lite-leak sink: `count() === 0` after a clean cycle AND `count() === 1`
    after a deliberate leak, in the same run. The deliberate-leak half IS the
    positive control -- a kernel that reports clean on a real leak is the exact
    failure lite-leak's docs name.
  - Docs drift fails BOTH directions, against two deliberately broken fixtures
    exercised in-process: a prototype method with no llms.txt line, and an
    llms.txt line with no prototype method. A one-direction guard is the standard
    way this passes forever while drifting.
  - `{debug: true}` throws by name. This test PINS behaviour that already exists
    at 2.1.0; it does not create it.
  - Three-place version sync (VERSION === package.json === llms.txt header).
  - `npm pack --dry-run` ships exactly 9 files; still excludes `test/`,
    `decisions/`, `probe/`, `BRIEF*.md`, the roadmap. [CORRECTED 2026-08-17 from
    "8": this brief's 7+1 count omitted that a new public export
    (`./debug`) needs its own `ObjectPoolDebug.d.ts`, or a consumer under
    moduleResolution:nodenext + strict hits TS7016. The debug subpath ships a
    `.js` AND a `.d.ts`, so 7 -> 9.]
  - Hot bodies byte-identical if the counters moved (proven by the existing T2
    precondition, HOT_HASHES untouched); if kept, the assertion inverts and the
    CHANGELOG carries the ratio.
  - watchPool is recorded as ADVISORY: T8 asserts `available` and the documented
    report keys, and deliberately does NOT treat `escapeCount === 0` as a pass.
    The absence of a pass assertion IS the assertion.

NON-GOALS
  No shrink/TTL (D3). No handle API (D1 -- record the discharge instead). No
  bench, no demo (BRIEF3, now 2.3.0). **No option-shape change: the constructor
  should be touched ZERO times, because there is no reserved-name list to add
  to.** No touching `_dense` / `_sparse` / `_slots`. No SPP probe and no
  Playwright lane -- both name infrastructure with no presence in this package
  and no gate, and neither is provable in one session; they move to BRIEF3.
  Do NOT "fix" the `readonly size/used/free` declarations in `ObjectPool.d.ts`:
  in TypeScript a getter SATISFIES a readonly property declaration, so that half
  of OP-16 is a non-bug. The `T = any` half was already fixed in 2.0.0 -- the
  d.ts reads `ObjectPool<T extends object = object>`. OP-16's only remaining real
  content is the two-direction drift guard.
  Do NOT build a watchPool-driven leak gate.

DONE WHEN
  D6 is written before any code;
  `stats(out)` reads 0.000 B/op on a window whose positive control is already
  validated;
  the counter question is answered by a NUMBER produced by T2's own statistic
  against a candidate copy -- never by editing the shipped file to find out --
  and the CHANGELOG carries that number and the kept-or-moved outcome;
  T8 is live and the control walk is TEN tiers with no CONTROL-DEFEATED token
  anywhere;
  the drift guard fails in both directions against deliberately broken fixtures;
  llms.txt says, in the package's own voice, that watchPool cannot observe an
  acquired-never-released object here, because `_items[]` retains it
```

## Roadmap corrections this brief depends on -- both VERIFIED

**1. Renumbering. The P3/P4/P5 frontmatter in `OBJECTPOOL_ROADMAP_V2.md` is
stale.** Confirmed against the file: P3 still says `version_target: 2.1.0`, P4
says `2.2.0`, P5 says `2.2.0`. The 2026-08-15 amendment split P2 into P2a/P2b and
renumbered P3 to 2.2.0 -- but stopped there, leaving P4 and P5 both claiming a
version that is now P3's. The corrected train:

| Session | Roadmap says | Actually | Brief |
| --- | --- | --- | --- |
| P2a | 2.0.0 | 2.0.0 -- **shipped 2026-08-15** | -- |
| P2b | 2.1.0 | 2.1.0 -- **shipped 2026-08-17** | BRIEF1 |
| P3 | 2.1.0 (amended to 2.2.0) | 2.2.0 | BRIEF2 |
| P4 | 2.2.0 | **2.3.0** | BRIEF3 |
| P5 | 2.2.0 | **2.3.0** (same release as P4) | BRIEF4 |

P4 and P5 sharing one version is intentional and preserved: P4 builds the bench
and demo, P5 publishes them as one release. Neither adds API.

**2. The deferred D1 trigger has fired, and is discharged -- write this down.**
Section 7 defers the u32 gen-guarded handle API with the trigger: *"a consumer
needs serializable or cross-worker pool refs, OR P2's Decision 1 rejects the
symbol-stamped slot index, which makes this the structure rather than an
addition."* Decision 1 **did** reject the symbol stamp -- it went WeakMap-only,
because the mixed symbol+WeakMap lane did not net zero. So the second clause
fired.

It is nonetheless **discharged, not outstanding**: that clause exists because
rejecting the symbol stamp was assumed to leave nothing to map object -> slot,
making handles the only remaining structure. WeakMap-only supplies that mapping
at 0 B/op with zero capability regression, so the need the trigger anticipated
never materialised. Only the first clause -- serializable or cross-worker refs --
can still fire. Amend section 7 to say so, or a future reader will correctly
conclude the roadmap was violated.

**Citation correction.** The first draft of this brief cited "0.0022-0.0055 B/op"
for the mixed lane and attributed it to the roadmap. The roadmap's own table
records `0.0000` and `~0.0000`. The real figure is **0.0055 B/op**, and it lives
in `decisions/D1-structure.md:119` ("the only lane that does NOT net zero"). The
"0.0022" half appears nowhere in the repo. Cite D1, not the roadmap, and drop the
number that has no source.

## What this brief used to say, and why it was wrong

Kept deliberately. The failure is reusable; the fact of it is not.

The first draft planned `stats(out)`'s field set, and a T8 conformance test, and
a T9 control that "removes a stats field", all around lite-gc-profiler's
`watchPool`. None of it was checked against the profiler's actual llms.txt. The
API it described does not exist, detects the opposite condition, cannot fire
against this pool at all, and by its own documented law can never be a gate.

Three of those four are things a careful reader of the profiler's docs finds in
about a minute. The fourth -- that `_items[]` retention makes escapes impossible
by construction -- takes knowing both files at once. Any of them alone would have
sunk the plan; the brief shipped with all four because it was written from memory
of what a sibling package ought to expose rather than from the file.

The same draft also instructed the coder to "add `debug` to the reserved-name
list" in a release that had already deleted that list, and to fix a `T = any`
generic that was fixed two versions earlier. Both are the same error in a
smaller register: describing code from a mental model of it instead of reading
it.
