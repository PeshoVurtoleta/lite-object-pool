# Changelog

All notable changes to `@zakkster/lite-object-pool` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Version is synced in three places from 1.0.3 forward: `package.json`, the
`VERSION` const exported from `ObjectPool.js`, and the header line of
`llms.txt`.

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
