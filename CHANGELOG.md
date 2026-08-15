# Changelog

All notable changes to `@zakkster/lite-object-pool` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version is synced in three places from 1.0.3 forward: `package.json`, the
`VERSION` const exported from `ObjectPool.js`, and the header line of
`llms.txt`.

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
