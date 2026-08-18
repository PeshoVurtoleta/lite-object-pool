# Changelog

All notable changes to `@zakkster/lite-object-pool` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version is synced in three places from 1.0.3 forward: `package.json`, the
`VERSION` const exported from `ObjectPool.js`, and the header line of
`llms.txt`.

## [2.3.1] -- 2026-08-18

Session P5 (BRIEF4), the docs half of the 2.3.0 plan, shipped as its own patch
because 2.3.0 published early with only P4. DOCS-ONLY: no source file changed
except the lockstep `VERSION` const -- the four pinned hot-body hashes (`acquire`
55f3a646dd5e9a57, `release` 239ef75c603bf839, `releaseAll` b29b13b9996ffd34,
`forEachActive` 937941616f65fd72) did not move, and `ObjectPoolDebug.js` is
byte-identical to 2.3.0. This resolves the SCOPE NOTE in the 2.3.0 entry below.

### Changed

- **README rebuilt on the LiteSepforge blueprint** (per `../CLAUDE.md`). The old
  spine (Features / Installation / Quick Start / How It Works / Use Cases) is
  replaced with the blueprint spine in order: positioning H2 with inline install
  and a runnable quick-start; TOC; Why this exists; What you get; a `<details>`
  core deep-dive; API reference with a constants table; Composability with an
  end-to-end debug-lane pipeline; a `<details>` Zero-GC design notes with an
  allocation table and the stamped bench numbers; Design decisions worth knowing;
  Migrating; Testing (297 tests / 57 suites); What this is not; Ecosystem;
  License. The nine existing badges are kept. ASCII-only; every relative link
  resolves to a repo file.
- **The v1 -> v2 migration section now lists all TEN breaking changes**, not four,
  each with its issue id, reason, and a one-line fix. Sourced across two CHANGELOG
  entries, not one: items 9 (`{maxSize < size}` throws, OP-02) and 10 (strict
  boolean `expand`) are `1.1.0` changes; items 1-8 are `2.0.0`. Items 1, 8, and 9
  are flagged as the three that change behaviour for code that never threw. The
  2.1.0 additive option shape (`capacity` / `prealloc` / `onExhausted`) is a
  clearly separated second section so the additive half does not read as
  mandatory.
- **The version-assertion test** (`test/ObjectPool.test.js`) and the `demo/`
  header track the new version.

### Not changed (named)

- **`bench/bench-results.json` stays stamped at `objectPoolVersion` `2.3.0`.** It
  is the record of the run that produced the README's benchmark numbers; 2.3.1's
  hot paths are byte-identical, so re-stamping without re-running would
  misrepresent the artifact and re-running would drift the README table off a
  noise delta. The `package.json` / `VERSION` / `llms.txt` triple is at 2.3.1.
- **`homepage` / `repository` / `bugs` / `funding` URLs and the sponsor badge**
  (`PeshoVurtoleta`) are unchanged -- the author's real GitHub handle, matching
  ~17 sibling packages (closed task OP-13). `zakkster` is the npm handle. Both
  are correct; do not "fix" them.

### Added

- Nothing. No new surface, no new export.

### Removed

- Nothing.

## [2.3.0] -- 2026-08-18

Session P4. Every number this package advertises becomes STAMPED and re-runnable,
and the "no GC pauses in your 60fps loop" claim gets something a reader can watch.
COLD-PATH ONLY: `ObjectPool.js` and `ObjectPoolDebug.js` are BYTE-IDENTICAL to
2.2.0 apart from the `VERSION` const -- the four pinned hot-body hashes (`acquire`
55f3a646dd5e9a57, `release` 239ef75c603bf839, `releaseAll` b29b13b9996ffd34,
`forEachActive` 937941616f65fd72) did not move. This release adds `bench/`,
`demo/`, one frozen test fixture, a third T5 lane, and an `npm run bench` script.
`bench/` and `demo/` are in NEITHER `files[]` (8 entries) nor the pack (`npm pack`
reports `total files: 9` -- npm always adds `package.json`).

SCOPE NOTE: 2.3.0 was planned as two phases -- P4 (bench + demo, BRIEF3) and P5
(release train + README rebuild, BRIEF4). Only P4 shipped here. The README is
still on the pre-blueprint spine and the v1 -> v2 migration section still lists
four breaking changes rather than the ten the 2.0.0 entry actually records.
BRIEF4 is unrun and moves to the next release.

### The headline resolution -- DIRECTION: CONFIRMED

The 2.0.0 CHANGELOG claims `1,321,024 bytes -> 0` on a 20,000-object drain. The
bench reproduces BOTH halves on the SAME drain shape (node v26.3.1, darwin/arm64,
Apple M4 Pro), so the CHANGELOG stands unchanged -- no number was corrected:

- **v1 half** (the `1,321,024 B`): the frozen v1 fixture, gc-anchored drain of a
  never-drained 20,000 pool, retains ~1.31 MB (~66 B/acquire) -- a noisy heapUsed
  delta, so the exact bytes vary run to run (`sections.headline.v1RawDrain.median`
  / `v1PerAcquire`). Its median deviates well under 1% from the claimed figure
  (`sections.headline.claimDevPct`; ~0.7% on the stamped run), inside the 15%
  noise band (`IQR_FLAG_PCT`, the suite's one definition of noise, reused from
  `LiteRouter/bench/bench.js`).
- **v2 half** (the `-> 0`): certified by the netted `heap.allocBytes`
  discrimination instrument (NET_OPS=1000 window, min-over-8) over the SAME drain
  shape -- v2's drain-acquire nets **0.0000 B/op**, while the v1 fixture's
  drain-acquire on that identical window reads **60.368 B/op** (stamped:
  `bench-results.json` -> `sections.headline.v1DrainNetBytesPerAcquire`, stable to
  four decimals across repeated runs). That non-zero v1 figure is the POSITIVE
  CONTROL proving the drain window is not blind. The raw heapUsed drain delta for
  v2 (~240 B, IQR ~375%; `sections.headline.v2RawDrain`) is ambient-noise-limited
  and is reported as such, NOT as the certified zero.

The verdict tests both halves; forcing EITHER the v2 raw drain OR the v2
drain-instrument non-zero flips `resolution` to DISAGREES (watched to fail before
this was trusted). The bench is not tuned to agree -- a stamped number is allowed
to disagree, and if it did the correction would land here, not in the bench.

### Added

- **`bench/torture.js`** (`npm run bench`, protocol v3, stamped provenance: node /
  OS / arch / CPU / cores / memory / date / package + fixture version). Puts three
  implementations side by side -- the shipped v2 sparse-set pool, the frozen v1
  Set-based fixture, and a genuinely-naive per-acquire allocation into a RETAINED
  sink -- and reports ns/op AND bytes/op. The bytes number is the interesting one
  and the one v1 loses on. Lanes: instrument validation (a retained control that
  MUST read non-zero, next to the same allocation DROPPED, which V8
  scalar-replaces to 0.0000 -- the trap that read the first T6 positive control as
  a false zero); throughput; the headline; the naive baseline (asserted non-zero,
  because a baseline that optimises to zero measures nothing); two object shapes;
  and a full-workload `maxArrayBuffersGrowth: 0` gate with `stabilize: 'deep'`.
- **`test/baseline/ObjectPool-1.1.0.js`** -- the v1 Set-based pool frozen verbatim
  from commit `d3a13ad` (VERSION `1.1.0`, 202 lines), beside the existing
  `ObjectPool-2.0.0.js`. There is no `1.1.0` git TAG (only v2.0.0 / v2.1.0 are
  tagged); the commit is the source. This ONE fixture is driven by BOTH the bench
  and T5, and both assert they loaded it (VERSION + pinned path) -- two divergent
  "v1"s would make the headline comparison unfalsifiable.
- **T5 third lane.** `t5-fuzz.mjs` now drives the frozen v1 fixture through the
  same 100k-op stream as v2, compared on `used` / `free` / `size` ONLY. Identities
  legitimately diverge (v1's free-list LIFO order != v2's cursor order, D2), so
  identity is deliberately NOT compared across it; the COUNTS must agree op-for-op.
- **`demo/index.html`** -- oscilloscope phosphor-green, oklch tokens with hex
  declared first, `@media (hover: hover)`, rem sizing, `$`-prefixed cached DOM
  refs, importmap routing, pre-allocated `Float32Array` ring buffers, ~10 Hz
  telemetry throttle, `data-scene` tabs. Three scenes: a particle BURST (the OP-01
  spike workload, live, at 0 B/op), a CHURN firehose (steady 1:1 at capacity with
  a frame-time trace), and a LEAK-HUNT on the `/debug` subpath -- a
  `DebugObjectPool` with `captureStacks` on and `createPoolLeakKernel().audit()`
  naming each acquired-never-released object's call site live. `stats(out)` drives
  all telemetry into ONE long-lived scratch object at 0 B/op. `watchPool` is used
  NOWHERE: `_items[]` retains every pooled object, so a pool escape is impossible
  by construction and the canary would read zero forever (D6.9).

### Changed

- Version synced in the three canonical places (`package.json`, the `VERSION`
  const in `ObjectPool.js`, the `llms.txt` header) plus the two sites the suite
  law does not name: the `VERSION` assertion in `test/ObjectPool.test.js` and the
  demo's `<h1>` version badge. Historical `since 2.2.0` / `What 2.2.0 changed`
  references in `README.md`, `llms.txt`, `ObjectPool.d.ts`, `ObjectPool.js` and
  `decisions/` are provenance, not version sites, and were left alone.
- `test/torture/harness.mjs` and the T5 tier now carry the third differential
  lane; `ALL_ARMABLE_TIERS` is unchanged at ten.

### Fixed

- **The demo's `audit (kernel.count / audit)` button did nothing.** Every
  mutating handler (`spawnEnemy`, `spawnPickup`, release-all) already called
  `renderAudit()` on click, so the findings list was always current by the time
  the audit button was pressed -- it could not produce a visible change in any
  reachable state, and the scene's own copy ("...NEVER release them, then
  audit") described a two-step flow the wiring short-circuited. Spawning and
  releasing now move only the O(1) counters and leave the NAMES stale; the audit
  button performs the stack walk and populates the list. That split is also the
  point the scene teaches: counts are cheap, names cost a stack walk. Found by
  clicking the button in a browser -- every automated check passed, including a
  node-side probe that called `audit()` directly and so never exercised the
  handler wiring at all.

### Removed

- Nothing.

### Design notes

- **Two object shapes, unconditionally.** The roadmap made this conditional on
  "IF the OP-17 probe showed polymorphism costs". It ran during P2a and DID: the
  mixed symbol+WeakMap slot-reader lane measured 0.0055 B/op
  (`decisions/D1-structure.md:119`), the only lane that did not net zero, which
  killed the fallback and forced WeakMap-only. The condition is satisfied, so the
  bench benches both shapes and reports the polymorphic delta (both net zero: v2
  has one release shape).
- **The debug lane's cost is quoted from `llms.txt`, canonically:** ~102 B/acquire
  with `captureStacks` off, ~1173 B (~1.2 KB) with it on (depth-dependent). The
  leak-hunt scene shows the cost honestly next to the signal and demonstrates the
  debug lane is NOT the shipping hot path -- the burst and churn scenes use the
  plain `ObjectPool` at 0 B/op.

## [2.2.0] -- 2026-08-17

Session P3. Make the pool OBSERVABLE without making it allocate. Recorded in
`decisions/D6-debug-lane.md`. Purely additive -- the hot bodies (`acquire`,
`release`, `releaseAll`, `forEachActive`) are BYTE-IDENTICAL to 2.0.0; their four
pinned `.toString()` hashes did not move, and the T2 differential-speed tier
still gates the shipped pool against the frozen 2.0.0 copy as an identical-body
noise-floor gate.

### Added

- **`stats(out)`** -- writes `{size, used, free, expansions}` into a
  caller-provided object and returns it, allocating NOTHING (gated at `=== 0`
  B/op by torture T6 at the already-validated NET_OPS window). `expansions` is
  free to report because it is counted only on the cold `_grow` branch, off the
  acquire hot body. `out` fails closed: a non-object -- including `undefined`, so
  a no-arg `stats()` throws rather than silently allocating a fresh object -- is a
  `TypeError` naming `"out"`. A frozen / sealed-empty / getter-only `out` also
  throws naming `"out"`, and the write is TRANSACTIONAL: on any non-writable
  field `out` is rolled back to exactly what it was, never left half-written with
  fresh values in some fields and stale ones in others. There is no shared
  internal buffer to alias.
- **The `@zakkster/lite-object-pool/debug` subpath** -- a second entry point
  (`DebugObjectPool`, `createPoolLeakKernel`) that ALLOCATES BY DESIGN and never
  loads in production.
  - `DebugObjectPool` is a public-surface WRAPPER (it reads no `_items`/`_sparse`/
    `_slots`) that tags every acquire with a monotonic id, plus the acquire stack
    when constructed `{ captureStacks: true }`. `leaks()` names everything still
    out; its `stats(out)` adds the moved counters `peakUsed` / `totalAcquires` /
    `totalReleases`. Measured cost (node v26.3.1, darwin, net min-over-6):
    ~102 B/acquire with `captureStacks` off, ~1173 B/acquire (~1.2 KB) with it on.
  - `createPoolLeakKernel(debugPool)` is a `@zakkster/lite-leak` kernel with
    `audit()` + `count()` ONLY (no `install`, no `refine`): `count()` is the
    number of acquired-never-released objects. A `refine()`/FinalizationRegistry
    kernel would report clean forever here, because `_items[]` retains every
    pooled object, so a checked-out object is never collected.

### Design notes

- **The observability counters MOVED off the hot path, by measurement (D6.6).**
  The one place this session could regress 2.0.0's headline is three integer
  increments per acquire/release for `peakUsed` / `totalAcquires` /
  `totalReleases`. A frozen candidate copy with those counters landed in the hot
  bodies was measured with T2's own `compareOps` machinery against the frozen
  2.0.0 copy (min-over-9 of `max(A/B, B/A)`, OPS=50000, WARMUP=5000). Threshold:
  keep iff min-over-9 <= 1.05 on every trial AND every T6 OP-01 lane reads 0.
  Measured min-over-9 ratios across two runs of three trials each:
  **1.0016, 1.0005, 1.0644** and **1.0045, 1.0065, 1.0138**; T6 lanes all 0.
  One of six trials read **1.0644 > 1.05** -- an excursion over threshold, so by
  the fail-closed rule ("any trial over 1.05, or ambiguity, moves them") the
  counters **MOVED** to the `/debug` wrapper instead of shipping in
  `acquire`/`release`. Core `stats(out)` therefore reports only the four free
  fields. Keeping them would also have forced re-pinning all four hot-body hashes
  and rewriting T2 from a noise-floor gate into a magic-number one; MOVE keeps
  HOT_HASHES untouched and `speed-2.1.0.json` the record of record.
- **The debug lane is a SUBPATH, not a `{debug: true}` flag.** A constructor flag
  would put a branch in `acquire()`, change its `.toString()` hash, and falsify
  T2's identical-body premise (D6.1). `{debug: true}` remains an unknown key and
  throws by name via the generic did-you-mean path deleted-and-rebuilt in 2.1.0 --
  no `debug`-specific special case was added (D6.2).
- **watchPool cannot observe this pool.** lite-gc-profiler's `watchPool` detects
  a pooled object that DIED; against this pool it is structurally incapable of
  firing (`_items[]` retention), so `escapeCount` is 0 by construction forever.
  Recorded in `llms.txt`, `ObjectPool.js`, and the debug subpath so it is not
  planned against again. T8 records watchPool as ADVISORY (asserts availability
  and the documented handle surface, deliberately NOT `escapeCount === 0` as a
  pass).

### Testing

- Torture T8 (`t8-cross.mjs`) filled: three-place version sync
  (`VERSION === package.json === llms.txt` header), both-direction docs-drift
  against two deliberately-broken in-process fixtures, the lite-leak
  `audit()`+`count()` kernel round trip (clean `count() === 0`, one deliberate
  leak `count() === 1` -- the leak half IS the positive control),
  `createCollectionGrowthKernel` against `pool.size`, and the advisory watchPool
  shape check. T8 joined `ALL_ARMABLE_TIERS`, making the control walk TEN tiers;
  it is non-owning, so arming it hits the entry-point backstop.
- T6 gained a `stats(out)` lane checked `=== 0` B/op at the validated NET_OPS
  window.

## [2.1.0] -- 2026-08-16

Session P2b. The additive option reshape 2.0.0 deferred. `{size: 10, maxSize: 4}`
became a runtime error in 1.1.0; this release makes the contradiction
UNREPRESENTABLE on the same axis by splitting the option surface into one bound,
one population strategy, and one exhaustion policy. Recorded in
`decisions/D5-options.md`.

### Added

- **The canonical option triple `{capacity, prealloc, onExhausted}`.**
  - `capacity` -- the single upper bound (finite integer >= 0 or Infinity, and
    `>= prealloc`). Default `Infinity`. Legacy alias: `maxSize`.
  - `prealloc` -- how much of `capacity` to build at construction: `"eager"` (all
    of it, requires a finite `capacity`), `"lazy"` (none), or an integer count.
    Default `32`. Legacy alias: `size`.
  - `onExhausted` -- what `acquire()` does when it cannot serve: `"null"`,
    `"grow"`, or `"throw"`. Default `"grow"`. Legacy alias: `expand`
    (`true` = `"grow"`, `false` = `"null"`).
- **`onExhausted: "throw"`** -- a fail-closed acquire policy with DISTINCT
  messages for the two cases OP-04 used to conflate: `acquire() exceeded capacity
  <N>` (hit the hard ceiling) vs `acquire() on an exhausted pool of <N> object(s)`
  (growth off, below the ceiling). Both name `onExhausted:"throw"`.

### Design notes

- **Additive, non-breaking.** The legacy `{size, expand, maxSize}` spelling keeps
  working as PERMANENT aliases -- supported forever, never deprecated, never
  warned (a constructor `console.warn` is an allocation and a side effect this
  library does not have). Defaults are 2.0.0-equal in both vocabularies, so
  `new ObjectPool({ create })` builds an identical pool either way. This is an
  explicit OVERTURN of the roadmap's D5 recommendation of an `"eager"` +
  fail-closed default, which would have been breaking; it is the second such
  overturn after the P2a WeakMap/OP-01 decision. See `decisions/D5-options.md`.
- **The two vocabularies are mutually exclusive.** Mixing any legacy alias with
  any canonical name -- `{size, capacity}`, `{expand, onExhausted}` -- throws a
  `TypeError` naming one key from each side. Accepting both and letting one win
  silently would reintroduce exactly the ambiguity class this reshape deletes.
- **`{prealloc: "eager", capacity: Infinity}` throws by name** -- "build an
  unbounded capacity now" would allocate forever; it is the 2.1.0 spelling of the
  old OP-02 trap and fails closed at construction.
- **The `capacity`/`prealloc`/`onExhausted` forward-reference errors are gone.**
  2.0.0 shipped a `FUTURE_KEYS` table whose messages pointed at a then-future
  2.1.0; the table and its branch are deleted and the three names are real options
  now. No stale forward-reference string survives in any shipped runtime or doc
  surface (ObjectPool.js, ObjectPool.d.ts, llms.txt, README.md) -- grep-asserted in
  the suite. (This CHANGELOG is exempt: it is an append-only history, and the
  2.0.0 entry below correctly records what 2.0.0 did.)

### Fixed / known-failure status

- **OP-04 is NARROWED, not closed.** `onExhausted: "throw"` gives callers a way to
  tell a capped pool from an exhausted one. But `onExhausted: "null"` (and the
  capped case under `"grow"`) STILL return `null` and STILL conflate the two --
  deliberately, for the game-loop caller who treats "no object this frame" as a
  single condition. So OP-04 remains open for the `"null"` policy; only the
  `"throw"` policy disambiguates.
- **P2a's `assertOps` speed assertion went unmet in 2.0.0** -- no absolute
  acquire/release ns/op baseline was recorded then. 2.1.0 records a fresh
  DIFFERENTIAL baseline instead: the T2 speed tier gates the shipped
  `acquire`/`release` against a frozen byte-identical 2.0.0 copy
  (`test/baseline/ObjectPool-2.0.0.js`) via `compareOps`, asserting neither side
  is more than the measured-and-justified threshold slower than the other, both
  directions, with a proven positive control. The four hot-body `.toString()`
  hashes are also pinned against the 2.0.0 fixture, so any byte change to
  `acquire`/`release`/`releaseAll`/`forEachActive` fails a named test.

## [2.0.0] -- 2026-08-15

Session P2a. The headline sentence -- "no allocations during gameplay" -- is now
true and measured: draining a fully preallocated 20,000-object pool went from
retaining **1,321,024 bytes to 0**. The v1 `_out` Set is replaced by a sparse
set (an `_items[]` object store, a dense/sparse `Uint32Array` index pair, and an
active cursor), with each object's slot index kept in a per-instance `WeakMap`
that is written once at create time and only READ on the hot path -- reads never
rehash, so `acquire` / `release` / `releaseAll` / `forEachActive` allocate zero
bytes on a preallocated pool. The design is recorded in `decisions/` (D1
structure + the WeakMap-vs-symbol measurement, D2 order, D3 iteration, D4
exhaustion) and `probe/poly.mjs`.

The option shape `{create, reset, size, expand, maxSize}` is UNCHANGED. The
capacity/prealloc/onExhausted reshape is deferred to **2.1.0** and is ADDITIVE --
it adds option names and removes none, so existing config keeps working and no
second migration is forced. This split keeps the headline allocation fix
separately provable from the option reshape.

### Breaking changes

- **Iteration order is now UNSPECIFIED (OP-06, D2).** `forEachActive` and
  `releaseAll` visited objects in insertion order in v1 (a Set-insertion-order
  accident, nothing documented it). Swap-remove does not preserve it, and v2
  spends nothing trying to. Anyone relying on a stable draw order -- z-order by
  spawn time is the obvious one -- must keep their own ordered index or they will
  see draw order change. This is the loudest line of the migration.
- **`release()` THROWS on a foreign object (OP-05, D4).** An object this pool
  never issued -- including `null`, `undefined`, primitives, and a sibling pool's
  object -- was a silent `false` in v1. It now throws a `TypeError`:
  `ObjectPool: release() called with an object this pool did not issue`. A genuine
  double-release (an object that WAS issued but is not currently checked out)
  still returns `false`.
- **Use-after-destroy THROWS (OP-11, D4).** `acquire()` on a destroyed pool
  returned `null` in v1 (indistinguishable from "exhausted"); it now throws
  `ObjectPool: acquire() called on a destroyed pool`. `release()`, `releaseAll()`
  and `forEachActive()` on a destroyed pool likewise throw named errors (v1
  silently no-op'd). Exhausted/capped `acquire()` still returns `null` -- an
  expected runtime condition, not a bug.
- **`destroy()` now DRAINS then tears down (OP-09).** It calls `reset()` on every
  object still checked out before releasing references, so pooled DOM elements or
  WebSocket messages get their cleanup. Still idempotent. v1 reset nothing on
  destroy.
- **`create()` must return a distinct object (D1).** The WeakMap that tracks slot
  indices needs object keys and distinct identities. `create()` returning a
  non-object (`null`, `undefined`, a primitive) now throws a `TypeError` naming
  `create()`; returning an object the pool already holds (the "same object every
  call" case) throws `each pooled object must be a distinct identity`. v1 pooled
  `null` and silently collapsed duplicates via the Set. This is a behaviour change
  in its own right, not folded into the rewrite: it is fail-closed where v1 was
  silent.
- **Unknown constructor keys now throw (fail closed).** In 1.1.0 a stray option
  key was silently ignored: `new ObjectPool({ create, capacity: 99, typoo: 1 })`
  constructed a pool and did nothing with either extra key. That is the
  fail-open-on-typo shape the suite law forbids, and it is a live footgun now
  that this CHANGELOG advertises `capacity`/`prealloc` for 2.1.0. As of 2.0.0 any
  key outside `create` / `reset` / `size` / `expand` / `maxSize` throws a
  `TypeError` naming the key, with a did-you-mean hint over the five known names
  (`{maxsize: 4}` -> `did you mean "maxSize"?`). The three reserved future names
  `capacity`, `prealloc`, `onExhausted` throw a message pointing at the additive
  2.1.0 reshape instead of a generic error. A config that silently did nothing in
  1.1.0 now throws. Ordered after the per-option validation, so a bad `size` plus
  a typo'd key still reports the `size` error first.
- **A non-function `forEachActive` callback always throws a named error.** In v1
  (and the v2.0.0 release candidate) the answer depended on pool state: a raw
  `TypeError` when the pool held active objects, a silent no-op when it did not.
  It now validates the callback once, before the loop, and throws
  `ObjectPool: "callback" must be a function, received ...` regardless of state.
  An omitted/`undefined` callback is a caller bug and throws.
- **Expansion allocates in bounded chunks (OP-10).** On a free-list miss v2
  constructs a bounded contiguous run (256 objects, clamped by the remaining room
  to `maxSize`) instead of one object per `acquire` with a `push()` regrow of the
  backing store. Consequence: with an unbounded `maxSize`, `size` can jump by a
  chunk on the first miss rather than incrementing by one. With a finite
  `maxSize` the chunk clamps to the remaining room, so the cap stays exact.

### Added

- `forEachActive(callback, thisArg?)` -- an optional `thisArg` binds the callback
  receiver so callers can pass a method without allocating a bound closure per
  frame.
- The **reverse-iteration contract (OP-07, D3)**: `forEachActive` walks the dense
  array backwards, which makes releasing the object currently passed to your
  callback safe and contractual for the first time. `releaseAll()` mid-iteration
  stops the walk; other structural mutation during iteration is unspecified.
- Torture T5 (`t5-fuzz.mjs`) filled: 100k mixed ops against a v1-style Set+free-list
  oracle, comparing `used`, `free`, `size` and the sorted set of active identities
  after every op. Order is deliberately not compared (that is D2).

### Fixed

- **OP-01 (S1) -- a fully preallocated pool no longer allocates on `acquire()`.**
  The T6 gate's two ratchets (v1.1.0: 66.78 and 42.10 B/acquire) are now live
  `check(=== 0)` gates, measured as netted `heap.allocBytes` over a discrimination
  window with a mandatory positive control (a lane that must read non-zero, or the
  instrument is blind).
- **OP-08 (S3)** -- the per-call iterator objects of `releaseAll` / `forEachActive`
  are gone (plain reverse index loops), a side effect of the rewrite.

### Changed

- README game-loop example rewritten to use the reverse-iteration contract and to
  DELETE the `dead[]` array (OP-07). The documented pattern no longer allocates a
  scratch array every frame.
- `ObjectPool.d.ts`, `llms.txt` document the v2 contract; `ObjectPool<T>` now
  constrains `T extends object`.

## [1.1.0] -- 2026-08-15

Session P1. `maxSize` becomes a real bound and the constructor validates every
option. No structural change -- the `_out` Set stays until 2.0.0, and OP-01 (the
per-`acquire` allocation) is deliberately untouched so its fix lands as a
separately provable commit. The hot path is byte-identical: `acquire`,
`release` and `forEachActive` gain zero instructions; all validation is
constructor-cold and runs once.

### Breaking changes

Two, both at construction only. A pool that constructed at 1.0.3 and passed
neither a contradiction nor a coerced `expand` is unaffected.

- **A contradictory `{maxSize < size}` now throws (OP-02).** `{size: 10,
  maxSize: 4}` used to build a pool that reported `size` 10 and handed out 10
  objects -- 2.5x the documented cap -- because `_totalCreated` was set from
  `size` and the preallocation loop ignored `maxSize`. It now throws a
  `TypeError`: `ObjectPool: "maxSize" (4) must be >= "size" (10)`. The two
  numbers contradict each other and only the caller knows which they meant, so
  the pool fails closed at the door rather than silently allocating a shape you
  did not ask for. `{size: 32, maxSize: 0}` likewise throws, and now creates
  **zero** objects before doing so.
- **`expand` must be a strict boolean.** `expand: 0`, `''`, `null`, `1` and
  `'false'` used to coerce -- the falsy ones quietly disabled expansion, and
  `expand: 'false'` was truthy and expanded forever. All now throw
  `ObjectPool: "expand" must be a boolean if provided, received ...`. A
  validation layer with one coercing hole teaches the caller that options are
  checked and then is not; all six options land in the same release and agree.

### Fixed

- **OP-02 (S1) -- `maxSize` is now a cap.** Fixed by the contradiction check
  above plus setting `_totalCreated` from the number of objects actually
  created (the filled free list) rather than from the `size` argument. It is no
  longer possible to construct a pool whose `size` exceeds its `maxSize`, so the
  torture suite's conjoined `size <= maxSize` law is now a live `check` instead
  of a recorded `todo`.
- **OP-03 (S2) -- options are validated with a library error.** `size: -1`,
  `2.5`, `NaN`, `Infinity`, `'32'` and `null` used to reach `new Array(size)`
  and throw a raw `RangeError: Invalid array length` naming neither the library
  nor the option. Every option is now validated in the constructor, in order
  `create -> reset -> size -> maxSize -> expand -> (maxSize >= size)`, and each
  bad value throws a `TypeError` whose message is prefixed `ObjectPool: "<opt>"`
  so it is greppable. `2**32` and `Number.MAX_SAFE_INTEGER` remain a raw
  `RangeError` from `new Array` on purpose: they are legitimate finite integers
  >= 0 that pass validation but exceed the JS array-length limit, and validation
  does not police that limit.

### Changed

- Torture T1 (`t1-degenerate.mjs`) rewritten to pin the validated behaviour:
  every rejected option asserts a `TypeError` prefixed `ObjectPool: "<opt>"`,
  the `{size: 32, maxSize: 0}` case asserts the `create` callback ran zero
  times, and the `create`/`reset` return-value and re-entrant-release cases are
  pinned.
- Torture T0's `size <= maxSize` clause flipped from `todo('OP-02')` to a live
  `check`, plus a throws-case asserting the contradiction is rejected at the
  door.
- `ObjectPool.d.ts` drops the 1.0.3 "not a cap" caveat on `maxSize` and
  documents the constructor's `@throws` cases.
- `llms.txt` documents the validation contract and the two breaking changes.

### Still open

- **OP-01 (S1)** -- a fully preallocated pool still allocates on every
  `acquire()` via the `_out` Set rehash (66.1 B/acquire on the drain shape).
  Untouched here by design; fixed in 2.0.0 by the sparse-set rewrite. The gate
  still reports it as a ratcheted `todo`.

## [1.0.3] -- 2026-08-15

Session P0. This release changes **no runtime behaviour**. It builds the
instrument that makes the package's real defects observable, so that the fixes
in 1.1.0 and 2.0.0 are provable rather than asserted. Every defect listed under
Known issues was found by executing a probe, not by reading the source, and
none of them is fixed here.

### Added

- `test/torture.mjs` -- the gate. `node --expose-gc test/torture.mjs` prints
  exactly `ok` and exits 0. Also available as `npm run torture`, and
  `npm run verify` runs the unit suite and the gate together.
- `test/torture/` -- seven live tiers and two registered-empty ones:
  - `t0-laws.mjs` -- metamorphic laws and the conjoined pool invariant
  - `t1-degenerate.mjs` -- every option value that is not a sane integer
  - `t3-adversarial.mjs` -- churn sequences crafted to break the structure
  - `t4-identity.mjs` -- object-identity and lifecycle abuse
  - `t5-fuzz.mjs` -- registered empty; filled in 2.0.0 (differential fuzz)
  - `t6-alloc.mjs` -- the zero-allocation gate
  - `t7-soak.mjs` -- 4096-cycle soak with a `lite-leak` witness
  - `t8-cross.mjs` -- registered empty; filled in 2.1.0 (profiler canary)
  - `t9-controls.mjs` -- deliberately broken variants that must fail
- A control switch: `OBJECTPOOL_TORTURE_BREAK=1 node --expose-gc
  test/torture.mjs` must exit non-zero. A gate that cannot fail is decorative.
  The value may also name one tier (`t0`, `t6`, `t7`) to arm that control
  alone -- arming all of them proves only that the FIRST one trips, since it
  exits before the others run. `npm run torture:controls` walks each tier in
  turn, requires each to exit non-zero on its own AND to be the tier that
  reported the failure, and requires the clean run to exit 0.
- Known-failing cases are **ratcheted**, not merely recorded. Each carries an
  upper bound, so a bug that is known and unfixed still fails the gate if it
  gets worse. A bare note would have let a regression from 66 to 500 B/acquire
  print a new number and still exit 0.
- Replay: `TORTURE_SEED=<n>` reseeds the suite's xorshift32 PRNG; any failure
  prints the seed and op index.
- `VERSION` export from `ObjectPool.js`.
- `CHANGELOG.md` and `LICENSE` (MIT, (c) Zahary Shinikchiev), both in `files[]`.
- `sideEffects: false`.

### Changed

- **Package renamed to `@zakkster/lite-object-pool`.** The unscoped
  `lite-object-pool` is **deprecated on npm** and **ends at v1.0.2**; every
  release from 1.0.3 forward is scoped only. npm does not redirect between an
  unscoped and a scoped package, so existing users must change both their
  install and their import string by hand. The deprecation notice reads:

  > Moved to @zakkster/lite-object-pool. The unscoped package ends at v1.0.2;
  > all future releases are scoped.

  Applied with:

  ```bash
  npm deprecate lite-object-pool "Moved to @zakkster/lite-object-pool. The unscoped package ends at v1.0.2; all future releases are scoped."
  ```

  1.0.3 is behaviourally identical to the unscoped 1.0.2, so the rename is the
  entire migration. There is no final unscoped release: 1.0.2 is the last one,
  and the deprecation notice is the only thing that changes on that name.
- `publishConfig.access: "public"` added. A scoped package defaults to
  restricted; without this the first scoped publish either fails or ships
  private.
- `ObjectPool.d.ts` now declares the `VERSION` export, which existed at runtime
  from 1.0.3 but was missing from the type surface. Also brought to ASCII and
  corrected on `maxSize` (see Known issues).
- README rewritten for the scoped name: rename banner, migration section,
  Ecosystem, Testing, and a **Known issues** section that documents OP-01 and
  OP-02 with their measured numbers and reproductions. The claims those two
  defects contradict -- "no allocations during gameplay" and `maxSize` as a
  "safety cap" -- are corrected in place rather than left standing.
- Test runner is now `node:test` (`npm test`), not vitest. All 45 cases and all
  11 groups ported with their assertions intact; `vi.fn()` replaced by a
  hand-rolled call recorder. vitest is no longer a dependency.
- `engines.node` raised from `>=16.0.0` to `>=18`. The old floor predated
  usable `node --test`.
- The default `reset` is now a shared module-level no-op instead of a fresh
  closure allocated per constructor call.
- Source, tests and `llms.txt` are ASCII-only, per the suite law. This removed
  an emoji from a test group title and 19 em-dashes from `ObjectPool.js` and
  `llms.txt`.

### Known issues

Both are reproduced by the gate on every run and reported as `TODO` lines with
their measured numbers. They are recorded here so the sessions that fix them
have a falsifiable before-figure rather than a remembered one.

**OP-01 (severity S1) -- a fully preallocated pool allocates on every
`acquire()`.** The `_out` Set is the cost: `Set.add` rehashes its internal hash
table as it grows, and it grows during exactly the spawn spike this package
exists to absorb. Measured on node v26.3.1, darwin:

| Workload | Retained | Per op |
| --- | --- | --- |
| 20,000 acquires, preallocated 20,000 pool | 1,321,024 B | 66.1 B/acquire |
| 200 x (4096 acquire + `releaseAll`) | 6,459,360 B | 7.88 B/acquire |
| 4,000,000 acquire+release pairs | 1,742,080 B | 0.436 B/pair |

The README's claim that there are "no allocations during gameplay" is false
today.

Note on how this is measured: OP-01 is a hash-table *rehash* cost, so it only
fires while `_out` is growing. A gated window over steady churn -- or over a
spike whose Set was already grown by the first iteration -- runs on a pool
where the rehash has finished and cannot observe it. The before-figure
therefore comes from a gc-anchored drain of a pool that has never been drained,
which is the only shape in which the cost occurs. A gate that measures a
configuration where the hazard cannot fire is the failure mode this suite
exists to avoid. Reproduce:

```bash
node --expose-gc -e 'import("./ObjectPool.js").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({x:0}),size:20000,maxSize:20000});globalThis.gc();globalThis.gc();const b=process.memoryUsage().heapUsed;for(let i=0;i<20000;i++)p.acquire();console.log("bytes:",process.memoryUsage().heapUsed-b)})'
```

Fixed in 2.0.0 by replacing the Set with a sparse set.

**OP-02 (severity S1) -- `maxSize` is not a cap.** `_totalCreated = size` is
assigned unconditionally and the preallocation loop runs `size` times
regardless of `maxSize`. `{size: 10, maxSize: 4}` builds a pool that reports
`size` 10 and hands out 10 objects -- 2.5x the documented cap.
`{size: 32, maxSize: 0}` preallocates 32 objects past a cap of zero. Reproduce:

```bash
node -e 'import("./ObjectPool.js").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({}),size:10,maxSize:4});let n=0;while(p.acquire())n++;console.log("maxSize 4 handed out",n)})'
```

Fixed in 1.1.0, where a contradictory `{maxSize < size}` throws.

### Notes

- The `for...of` iterators in `releaseAll` and `forEachActive` allocate an
  iterator object in the source, but V8's escape analysis removes them in
  practice: 200,000 `forEachActive` calls over 1,000 active objects cost 10,248
  bytes total, or 0.051 B/call. They are source hygiene, not the allocation
  problem, and they are left alone here. They disappear as a side effect of the
  2.0.0 rewrite.
- `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` are devDependencies
  used only by the gate. `ObjectPool.js` still has zero runtime dependencies.
- `npm pack` excludes `test/`.

## [1.0.2] and earlier -- unscoped, deprecated

Published as unscoped `lite-object-pool`. No changelog was kept. 1.0.2 is the
final release under that name; it is deprecated on npm and superseded by
`@zakkster/lite-object-pool` 1.0.3, which is behaviourally identical to it.
