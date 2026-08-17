# @zakkster/lite-object-pool -- enriched v2 roadmap

Six sessions, plus a torture-suite spec. Supersedes `ObjectPool_ROADMAP.md`
(five sessions, findings B1-B6), which stays in the tree as the audit that
started this and is not edited.

**Why it changed.** The original roadmap named six findings from reading the
source. I ran the code. Two of its six are real and worse than stated, one is
essentially wrong, and the largest finding in the package is not in its list at
all. Every measured number below came from executing a probe against
`ObjectPool.js` at v1.0.2 on 2026-08-15, node on darwin, and every probe is
printed next to its finding so it can be re-run.

The headline is one line long:

```
20000 acquires from a FULLY PREALLOCATED pool: heap delta = 1,321,024 bytes
```

The README's first promise is "Preallocate objects once, reuse them forever.
No allocations during gameplay, no garbage collection pauses." That sentence is
false, and it is false in the one workload the package exists to serve.

---

## 0. Scope and metadata correction (do this before anything else)

The suite scope is `@zakkster` (one `s`). This package has not moved to it yet.
Verify `@zakkster/lite-object-pool` against the registry before session P0 --
if it is taken by anything other than this project, the naming decision in
section 5 reopens.

`package.json` at v1.0.2 is wrong in five places:

| Field | Now | Should be |
| --- | --- | --- |
| `name` | `lite-object-pool` | `@zakkster/lite-object-pool` |
| `homepage` | `github.com/PeshoVurtoleta/lite-object-pool#readme` | the real repo |
| `repository` | `git+.../PeshoVurtoleta/lite-object-pool.git` | the real repo |
| `bugs` | `.../PeshoVurtoleta/lite-object-pool/issues` | the real tracker |
| `sideEffects` | absent | `false` |

Unlike lite-arena -- whose metadata pointed at a *different package*
(`lite-scheduler`) -- these three URLs at least name lite-object-pool. The org
is still the copy-paste one. Grep the whole ecosystem for `PeshoVurtoleta` in
one pass rather than one package at a time, and settle whether that org is the
intended home or a paste artifact. This is a one-line answer that unblocks
every package's metadata at once, so get it before P0 rather than during P5.

Also: `devDependencies` is `vitest`, `files[]` has no `CHANGELOG.md`, there is
no `LICENSE` file in the tree, and `engines.node` is `>=16.0.0` -- below the
floor where `node --test` is usable without flags. All corrected in P0.

---

## 1. Shared law (holds across every session)

1. **Preallocation means preallocation.** A pool whose capacity is fully
   preallocated must allocate ZERO bytes across any sequence of acquire /
   release / releaseAll / forEachActive. Not "a small amount". Not "V8 usually
   elides it". Zero, measured under `maxArrayBuffersGrowth: 0` with
   `stabilize: 'deep'`. This is the package's entire identity and OP-01 says it
   does not hold today.
2. **Bytes in a hot body, not instructions.** `acquire`, `release` and the
   `forEachActive` loop body are the hot path. Every guard added below must be
   provably absent from it -- diff the function or gate it with `assertOps`. A
   validation layer that costs the fast path is a rejected design, not a
   tradeoff. All option validation is constructor-cold and its cost is
   irrelevant.
3. **Fail closed on unverified state. Null is not zero.** `acquire()` currently
   returns `null` for "exhausted", "capped", and "destroyed" alike (OP-04), and
   `release()` returns `false` for "foreign", "double-released", and
   "destroyed" alike (OP-05). Three failure modes behind one value is not a
   contract; it is a shrug. Each gets a decided, distinguishable answer.
4. **A behaviour users can observe is a contract, whether or not you wrote it
   down.** Insertion-order iteration (OP-06) and release-during-iteration
   (OP-07) both work today by accident. The v2 sparse-set breaks both. They
   must be pinned or explicitly revoked in the CHANGELOG -- not discovered by a
   user whose particle system starts skipping frames.
5. **The debug lane may allocate. The production lane may not.** Acquire-site
   tagging is worth having and cannot be free. It lives behind a flag that is
   off by default, its allocations are stated in `llms.txt`, and the torture
   alloc gate runs with the flag OFF and a separate tier proves the flag ON
   changes nothing about correctness.
6. **Every gate must be provably able to fail.** Every torture tier ships with
   a deliberately-broken control variant that makes it exit non-zero.
   `OBJECTPOOL_TORTURE_BREAK=1` is the switch.
7. **Three-place version sync** from P0 forward: `package.json`, the `VERSION`
   const exported from `ObjectPool.js`, and the version line in `llms.txt`.

---

## 2. Verified findings

Reproduced against `ObjectPool.js` v1.0.2 on 2026-08-15 unless the row says
otherwise. Severity: **S1** = a documented guarantee is false, or silent
corruption. **S2** = broken or ambiguous contract. **S3** = hygiene.

Rows marked **measured** were executed. Rows marked **read-verified** are read
off a specific line and are certain by construction but were not run. Rows
marked **unverified** carry the exact probe to run and must not be treated as
findings until someone runs it. Do not blur these three -- the whole value of
this table is that the reader can tell which is which.

### The allocation findings

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **OP-01** | **S1** | **A fully preallocated pool allocates on every `acquire()`.** The `_out` Set is the cost. `Set.add()` rehashes its internal hash table as it grows, and it grows on exactly the spawn spike the package exists to absorb. Measured: filling a preallocated 20,000-object pool once costs **1,321,024 bytes / 66.1 B per acquire**. Sustained, 200 cycles of (4096 acquire + releaseAll) costs **6,459,360 bytes / 7.88 B per acquire**. Steady 1:1 churn over 4,000,000 acquire+release pairs costs **1,742,080 bytes / 0.436 B per pair**. None of these are zero, and the README's headline sentence says they are. This is the package. | **measured** -- see probe P-01 below |
| **OP-08** | S3 | The `for...of` over `_out` in `forEachActive` (`ObjectPool.js:117`) and `releaseAll` (`:101`) allocates an iterator object per call *in the source*, and V8's escape analysis removes it in practice: 200,000 `forEachActive` calls over 1,000 active objects cost **10,248 bytes total, 0.051 B per call** -- noise. The original roadmap made these findings B1/B2 and led with them. They are real as source hygiene and they are **not** the allocation problem; OP-01 is, by two orders of magnitude. Fix them as a side effect of the rewrite, not as its justification. | **measured** -- see probe P-01 |
| **OP-10** | S3 | `_free` is `new Array(size)` and expansion does `_free.push()` (`:90`), regrowing the backing array mid-frame. **The fix is NOT "preallocate to a finite `maxSize`"** -- see Prior art below; lite-signal rejected that strategy and grows in bounded contiguous chunks instead. Live for every `maxSize`, `Infinity` or not. | **read-verified** -- `:39` vs `:90`; strategy corrected by prior art |

### The contract findings

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **OP-02** | **S1** | **`maxSize` is not a cap.** `_totalCreated = size` is assigned unconditionally at `:36`, before any reconciliation with `maxSize`, and the preallocation loop at `:40` runs `size` times regardless. `{size: 10, maxSize: 4}` constructs a pool reporting `size` 10 with 10 free objects, and hands out **10** before returning null -- 2.5x the documented cap. `{size: 32, maxSize: 0}` preallocates 32 objects past a cap of zero. `maxSize` is documented as "prevents runaway expansion... protecting against runaway allocation from logic bugs"; it does not protect the construction path at all, which is where the objects actually get made. | **measured** -- see probe P-02 |
| **OP-03** | S2 | No option validation. `size: -1`, `size: 2.5` and `size: NaN` all throw `RangeError: Invalid array length` -- raw, from `new Array`, naming neither the library nor the option. A caller who passes a computed size that went non-integer gets an error that sends them looking at their own array code. | **measured** -- probe P-02 |
| **OP-04** | S2 | **`acquire()` returns `null` for three different situations** -- pool exhausted with `expand: false`, expansion blocked by `maxSize`, and pool destroyed -- and the caller cannot distinguish them. The README's own game-loop example writes `if (!p) break; // pool exhausted`, which silently treats "someone destroyed this pool" as "we are busy this frame". Null is not zero. | **measured** -- probe P-03 |
| **OP-05** | S3 | **`release()` returns `false` for three different situations** -- foreign object, double release, and destroyed pool -- and silently. A foreign object reaching `release()` is a caller bug that will never surface. | **measured** -- probe P-03 |
| **OP-06** | S2 | **`forEachActive` iteration order is insertion order, and it is observable.** After acquiring 4, releasing two, and re-acquiring two, iteration yields `[2, 3, 90, 91]` -- Set insertion order, with the recycled slots at the end. Nothing documents this and nothing pins it. The v2 sparse-set swap-remove **will** change it. Any consumer relying on stable draw order (z-order by spawn time is the obvious one) silently starts flickering. | **measured** -- probe P-03 |
| **OP-07** | **S2** | **Release-during-`forEachActive` already works, by accident, and v2 will break it.** Releasing the currently-visited object mid-iteration visits all 5 of 5 objects and leaves correct counts -- `Set` iterators tolerate deletion of already-visited entries. The original roadmap's B6 states the opposite ("v1 has no safe release-during-iteration contract") and prescribes the `dead[]` workaround as a fix for a problem the Set does not have. Meanwhile the README **teaches** the allocating `const dead = []` pattern anyway. So: the safe behaviour exists and is undocumented, the docs teach an allocating workaround for it, and the planned rewrite removes it. All three need to be settled together in P2. | **measured** -- probe P-03 |
| **OP-09** | S3 | `destroy()` does not `reset()` the objects still checked out -- 0 reset calls where `releaseAll()` would make 2. For a pool of DOM elements or WebSocket messages (both README use cases) that leaves live, dirty objects in the caller's hands with no signal. Decide whether destroy is a teardown or a drain; today it is silently half of each. | **measured** -- probe P-03 |
| **OP-11** | S3 | `destroy()` nulls `_create` and `_reset` (`:147`), and every method leads with an `if (this._destroyed) return` guard, so a destroyed pool silently no-ops forever instead of throwing. Combined with OP-04 this means use-after-destroy is undetectable from the outside. | **read-verified** -- `:57`, `:84`, `:99`, `:116`, `:141` |
| **OP-15** | S3 | The README's stated invariant `used + free === size` **holds** under every sequence probed, including expansion past `maxSize` and the OP-02 construction. It is nonetheless unpinned by any test. Pin it as a T0 law rather than leaving a correct invariant undefended. | **measured** -- holds; probe P-02 |

### The hygiene findings

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **OP-12** | S3 | vitest, not `node:test` (`package.json` `"test": "vitest run"`, `import { vi } from 'vitest'`). Non-ASCII emoji in `describe('<emoji> ObjectPool')` at `test/ObjectPool.test.js:15`, violating the ASCII-only law. No `CHANGELOG.md`. No `VERSION` const, so three-place sync is impossible. No `sideEffects: false`. `llms.txt` carries no version line. No `LICENSE` file. No demo. No torture gate. | **read-verified** |
| **OP-13** | S3 | Unscoped name plus the `PeshoVurtoleta` org in `homepage` / `repository` / `bugs`. `engines.node: >=16.0.0` is below the `node --test` floor the suite standardises on. | **read-verified** -- section 0 |
| **OP-14** | S3 | `reset = () => {}` default (`:26`) allocates one closure per pool. Cold, once, harmless -- listed so nobody "discovers" it later and files it as an allocation bug. A shared module-level `NOOP` is free and removes the question. | **read-verified** |
| **OP-16** | S3 | `d.ts` drift risk: `readonly size/used/free` are declared as properties but implemented as getters; `ObjectPool<T = any>` defaults to `any` rather than `unknown`. No drift guard test exists in either direction between `llms.txt` and the prototype. | **read-verified** -- `ObjectPool.d.ts:19-24` |
| **OP-17** | ? | **unverified -- probe required.** Does `acquire()` stay monomorphic when a pool is used with two different object shapes across two instances? If the megamorphic IC costs the hot path, the sparse-set rewrite should be measured with two shapes, not one. Probe: build two pools with different `create` shapes, interleave 1e6 acquires, and compare `assertOps` against a single-shape baseline. Do not act on this until it is run. | **unverified** |

### The probes

Run each from the package root. These are the exact scripts behind every
**measured** row above; re-run them before P1 to confirm nothing drifted.

**P-01 -- allocation (OP-01, OP-08)**

```bash
node --expose-gc -e 'import("./ObjectPool.js").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({x:0}),size:20000,maxSize:20000});globalThis.gc();globalThis.gc();const b=process.memoryUsage().heapUsed;for(let i=0;i<20000;i++)p.acquire();console.log("bytes:",process.memoryUsage().heapUsed-b)})'
```

**P-02 -- options and capacity (OP-02, OP-03, OP-15)**

```bash
node -e 'import("./ObjectPool.js").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({}),size:10,maxSize:4});let n=0;while(p.acquire())n++;console.log("maxSize 4 handed out",n);try{new ObjectPool({create:()=>({}),size:2.5})}catch(e){console.log(e.constructor.name+":",e.message)}})'
```

**P-03 -- contract (OP-04..OP-07, OP-09)**

```bash
node -e 'import("./ObjectPool.js").then(({ObjectPool})=>{const q=new ObjectPool({create:()=>({id:-1}),size:4,maxSize:4});const a=[];for(let i=0;i<4;i++){const o=q.acquire();o.id=i;a.push(o)}q.release(a[1]);q.release(a[0]);q.acquire().id=90;q.acquire().id=91;const ord=[];q.forEachActive(o=>ord.push(o.id));console.log("order",ord)})'
```

### Prior art: `@zakkster/lite-signal`'s pools (probed 2026-08-15)

lite-signal v1.4.3 runs two monomorphic object pools in production and is the
most heavily tested pool in the suite. It was read AND probed -- the results
below are executed, not inferred. Three of its decisions bear directly on this
roadmap and one of its non-decisions is a finding against it.

**1. Capacity and population are SEPARATE axes.** `createRegistry` takes one
capacity number (`maxNodes`, a ledger) and a separate population strategy
(`prealloc: "eager" | "lazy"`, `Signal.js:225`). Eager builds the full capacity
up front; lazy treats it as a ledger and constructs on demand. Identical
zero-GC steady state after warm-up; different heap and cold-start profile.

  **OP-02 is this shape fused wrong.** `size` and `maxSize` are those same two
  axes expressed as two quantities that can contradict each other, and OP-02 is
  that contradiction going unchecked. lite-signal cannot represent the bug
  because it has one number, not two. P1's throw is the correct minimal fix for
  1.1.0; **P2 should reshape the API so the contradiction is unrepresentable**
  -- see P2 Decision 5.

**2. The growth strategy is chunked, and preallocate-to-max was rejected.**
On a free-list miss lite-signal constructs a CONTIGUOUS run -- up to 1024 links
/ 256 nodes -- while the capacity ledger doubles separately, so `stats()`
semantics are unchanged but physical allocation is amortized
(`Signal.js:364-393`). Its stated reason: it "eliminates multi-ms pauses in hot
loops." It also carries a measured warning against the naive opposite: lazy
one-at-a-time construction "costs 10-25% on dynamic/large-graph shapes" because
it interleaves pool objects with user allocations and destroys traversal
locality. And it keeps a hard ceiling EVEN IN GROW MODE (`maxLinks * 16`,
`Signal.js:363`), throwing past it.

  **This settles OP-10.** The fix is bounded chunked refill, not a backing store
  sized to `maxSize`, and not one-at-a-time. It also removes the silent-
  truncation hazard that made the original P1 task revertable.

**3. The exhaustion policy is an enum defaulting to fail-closed.**
`onCapacityExceeded: "throw" | "grow"`, default `"throw"`, raising a named
`CapacityError` carrying `kind` and `capacity` (`Signal.js:161-168`). This
package's `expand: boolean` defaults to `true` -- grow, i.e. fail-open, against
the suite law -- and signals exhaustion with a bare `null` (OP-04). The enum
also extends without a breaking change; a boolean does not. Flipping the
default is a 2.0.0 change, not a 1.1.0 one: see P2 Decision 5.

**4. It does NO option validation, and that is a finding against lite-signal,
not a precedent for us.** The whole file has two `TypeError`s and both are
runtime handle arguments. Probed:

```
prealloc: "egaer"          -> accepted, silently lazy
onCapacityExceeded: "grwo" -> accepted, silently GREW past a capacity of 2
maxNodes: 2.5              -> accepted, capacity is literally 2.5
maxNodes: -1               -> TypeError: Cannot read properties of undefined (reading 'nextFree')
```

That last line is OP-03's exact failure mode -- a raw internal error naming
neither the library nor the option -- reached through a different constructor.
A typo'd policy string silently selecting the opposite of fail-closed is the
sharper problem. **So lite-signal offers no model for P1's validation layer**,
and the question "should `expand: 0` throw?" gets no support from it. Copy the
enum-plus-fail-closed-default shape; do not copy the absent door.

Belongs against lite-signal, not this package. NOT yet filed as of 2026-08-15.

### The one law that catches five of these at once

```
used + free === size   AND   size <= maxSize   AND   every acquired object
appears exactly once in the active set
```

OP-01, OP-02, OP-06, OP-07 and any future swap-remove bug all violate some
clause of it immediately. It is O(size) to check, so it belongs in `validate()`
and in the torture suite between phases -- never in the hot path. Make it the
centrepiece of P0's harness. Note that clause one holds today (OP-15) and
clause two does not (OP-02): a conjoined invariant where one half already fails
is exactly the shape that makes a regression test meaningful.

---

## 3. The torture suite (`test/torture.mjs`) -- spec

One harness, tiers run **strictly sequentially**, entry prints exactly `ok` and
exits 0. Modeled on `../LiteBvh/test/torture.mjs` and its `test/torture/` tree,
which is the reference implementation in this suite -- read it before writing
this one.

### Layout

```
test/
  ObjectPool.test.js    # ported to node:test
  torture.mjs           # entry: runs tiers in order, prints exactly "ok", exit 0/1
  torture/
    harness.mjs         # scratch, zero-alloc asserts, seeded PRNG, gate wrapper
    t0-laws.mjs         # metamorphic laws + the conjoined invariant
    t1-degenerate.mjs   # every option value that is not a sane integer
    t3-adversarial.mjs  # churn sequences crafted to break the structure
    t4-identity.mjs     # abuse of object identity and pool lifecycle
    t5-fuzz.mjs         # differential fuzz against a brute-force oracle
    t6-alloc.mjs        # the zero-alloc gate -- this is the package's gate
    t7-soak.mjs         # leak_cycles churn + lite-leak witness
    t8-cross.mjs        # lite-gc-profiler pool-escape canary conformance
    t9-controls.mjs     # every gate above, deliberately broken, must fail
```

**T2 is deliberately absent.** In lite-aabb and lite-bvh, T2 is the `out`-buffer
aliasing matrix. This package has no `out` buffers and no caller-supplied
typed-array surface, so there is nothing to cross. The one place a T2-shaped
question appears is `stats(out)` in P3, and its single case is registered under
T0 rather than reviving an empty tier. Numbering stays aligned with the sibling
packages so a reader who knows one knows both.

`test/` never enters `package.json` `files[]`. `npm pack --dry-run` proves it.

### Harness rules

- All scratch -- pools, held-object arrays, oracle state -- allocated **once**,
  outside every loop. No pool construction inside a measured body, no closure
  per iteration.
- Assertions in hot loops compare into pre-allocated scratch and build a
  message string **only on failure**. Pass a thunk, not a string. A template
  literal per iteration is an allocation and will fail your own gate. Copy
  `check(cond, msgThunk)` from the lite-bvh harness verbatim.
- Seeded xorshift32 PRNG, seeded from `TORTURE_SEED` with a non-zero fallback.
  On any failure print the seed and the op index so the case replays with
  `TORTURE_SEED=... npm run torture`.
- **lite-gc-profiler is one measurement at a time.** `measureOps`,
  `measureFrames` and `measureOpsAsync` share one heap and throw "already in
  flight" if nested. Tiers run sequentially, never nested.
- **Unknown rule keys throw** (`TypeError`) on every lane including `checkNoGc`
  as of profiler v1.10.0. Do not pass a lane a key it does not implement. There
  is no `maxExternalGrowth`; `summary.external` is diagnostic only.
- `maxArrayBuffersGrowth` is node / `source: 'gc'` only and **requires**
  `stabilize: 'deep'` on `measureOps`, otherwise `summary.arrayBuffers.settled`
  is false and the rule returns inconclusive.
- Never resolve an unexpected `inconclusive` with `allowInconclusive`. That is
  the escape hatch, not the fix; triage via the profiler's `INCONCLUSIVE.md`.
- lite-leak's `track()` **allocates by design** (one object per owner-tree hop
  plus a snapshot array). Call it at cycle boundaries in T7, never inside a
  measured T6 body.

Base rules object, matching the sibling packages:

```js
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };
```

### T0 -- metamorphic laws

Properties that must hold for any sequence, checked over the fuzz corpus:

- `used + free === size` after every operation.
- `size <= maxSize` after every operation (fails today -- OP-02).
- `acquire()` then `release(o)` returns the pool to its exact prior counts.
- `release()` of the same object twice changes nothing the second time.
- `releaseAll()` is idempotent and leaves `used === 0`.
- Every object handed out by `acquire()` is distinct from every other currently
  acquired object (no double-issue).
- `forEachActive` visits exactly `used` objects, each exactly once.
- After `releaseAll()`, the multiset of objects in the pool equals the multiset
  before the acquires -- the pool neither gains nor loses identities.

### T1 -- degenerate options

Cross the constructor with: `size` of `0`, `-1`, `2.5`, `NaN`, `Infinity`,
`-0`, `2**32`, `Number.MAX_SAFE_INTEGER`, `null`, `undefined`, `'32'`;
`maxSize` of `0`, `-1`, `NaN`, `Infinity`, and every value below `size`;
`expand` of `0`, `''`, `'false'`, `null`; `create` returning `null`,
`undefined`, a primitive, and the *same object every call*; `reset` that
throws, that returns a value, and that releases another object re-entrantly.

Pin the actual answer for each, including the ugly ones. Pinning "this throws a
`RangeError` naming the option" is a valid contract. Leaving it unpinned is not.
`create` returning the same object every call is the sharpest one: the pool
then hands the same identity to two callers, and the active-set guard is the
only thing that can notice.

### T3 -- adversarial churn sequences

- Full-drain spike: acquire to capacity, `releaseAll()`, repeat. The OP-01 case.
- 1:1 steady churn at capacity for 1e6 pairs.
- LIFO release order, FIFO release order, random order, and release-every-other.
- Acquire past `maxSize` repeatedly, each time consuming the null.
- Release during `forEachActive`: the visited object, an already-visited object,
  a not-yet-visited object, and every object.
- `releaseAll()` called from inside `forEachActive`.
- Re-entrant `acquire()` from inside a `reset()` callback.
- Fill to exactly `maxSize - 1`, then `maxSize`, then one past.
- Continue using the pool **after** an exhaustion null -- assert it is still valid.

### T4 -- identity and lifecycle abuse

Release a foreign object; release an object from a *different pool of the same
shape*; release `null`, `undefined`, `0`, `''`, `NaN`, a frozen object, a Proxy,
and an object that was already released; acquire and release across `destroy()`;
`destroy()` twice; `forEachActive` and `releaseAll` after `destroy()`;
`forEachActive` with a callback that is not a function, that throws, and that
destroys the pool mid-iteration.

Each case gets a decided policy: **throw**, **documented no-op**, or
**documented undefined**. "Silently returns false" is not one of the three --
that is OP-05, and this tier is where it gets resolved.

### T5 -- differential fuzz against an oracle

Brute-force ground truth: a plain `Set` of acquired objects plus an array free
list -- deliberately the v1 design, which is correct and slow. Run 100k mixed
ops (acquire / release / releaseAll / forEachActive) against both. After each
op compare `used`, `free`, `size`, and the **sorted set of active object
identities**, not iteration order. Any divergence prints the seed, the op
index, and a minimal replay. This is the tier that proves the sparse-set
rewrite did not change any answer -- only the order, which P2 decides
explicitly.

### T6 -- the zero-alloc gate

This is the package's gate. Everything else supports it.

```js
// shape only -- read node_modules/@zakkster/lite-gc-profiler/llms.txt
// for the exact current surface before writing this.
const res = measureOps(hot, { ops: OPS, warmup: WARMUP, stabilize: 'deep' });
const report = checkNoGc(res.summary, RULES);
```

Hot body: a fully preallocated pool at capacity, running acquire-to-full,
`forEachActive`, then release-to-empty. Plus the spike shape separately, since
OP-01 is 18x worse on the spike than on steady churn and a steady-churn-only
gate would under-report it by that factor.

Plus direct structural assertions no heap gate can substitute for:

```js
assert.equal(pool.size, SIZE_BEFORE, 'pool grew');
assert.equal(pool.free + pool.used, SIZE_BEFORE, 'invariant broken');
```

Run the gate with the P3 debug/tagging lane **off**. A separate, ungated tier
runs it on and asserts only correctness.

### T7 -- soak and conservation

`leak_cycles: 4096` cycles of build-up / tear-down. After each cycle assert
`used === 0`, `free === size`, and the conjoined invariant from section 2.
Sample heap **across** cycles, not within one. Carry an independent
`lite-leak` witness -- `createLeakTracker({ name: 'pool-soak' })`, one tracked
resource per cycle, `tracker.size() === 0` at the end -- so a pool-internal
leak and a JS-object leak cannot hide behind each other.

### T8 -- cross-package conformance

- Feed `stats(out)` (P3) to lite-gc-profiler's pool-escape canary and assert
  the shape it expects. Read the profiler's `llms.txt` for the exact surface;
  do not write it from memory.
- Assert `VERSION` matches `package.json` and the `llms.txt` version line --
  the three-place sync, enforced by a test rather than by discipline.
- Docs-drift guard: every public method on `ObjectPool.prototype` appears in
  `llms.txt`, and every method named in `llms.txt` exists. Both directions.

### T9 -- controls (the gate must be able to fail)

`OBJECTPOOL_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` must exit
non-zero. For every gate above, a deliberately broken variant: a retained
allocation injected into the T6 hot loop; a corrupted oracle in T5; a
double-issue injected into T0's distinctness law; an object leaked past
`releaseAll()` in T7; a `stats()` field removed in T8. If a control passes, the
gate is decorative.

---

## 4. Session order

```
P0 --> P1 --> P2 --> P3 --> P4 --> P5
       (cap)  (core)  (eco)  (bench) (release)
```

Strictly linear, and each edge is load-bearing rather than conventional:

- **P0 blocks everything.** No fix lands without a gate that can observe it.
- **P1 blocks P2** because P2's central design move is "when `maxSize` is
  finite, preallocate all capacity up front and never allocate again". That is
  incoherent while `maxSize` is not a cap (OP-02). You cannot preallocate to a
  bound that the constructor ignores.
- **P2 blocks P3** because `stats(out)` and the leak sink report on a structure
  P2 replaces.
- **P4 after P3** because the bench compares v2 against v1 and the demo wires
  the P3 canary; benching a structure that is still moving produces an
  uninterpretable number.

The original roadmap's S1-S5 map on as: S1 -> P0 + section 0; S2 -> P1 + P2
(split because the capacity fix and the core rewrite are separately provable
and separately revertable); S3 -> P3; S4 -> P4; S5 -> P5.

### Amendment (2026-08-15, after P1 shipped): split P2 the same way

P2 grew twice during P1 -- it absorbed OP-10 and gained Decision 5 -- and it is
now two sessions wearing one heading. Split it on the release boundary:

```
P2a -- 2.0.0 -- the sparse-set core + semantics   [D1, D2, D3, D4, OP-09, OP-10]
P2b -- 2.1.0 -- the option shape                  [D5]
P3  -- 2.2.0 -- ecosystem lanes (renumbered)
```

**Amendment (2026-08-17, after P2b/2.1.0 shipped, at the start of P3/BRIEF2).**
The block above renumbered P3 to 2.2.0 but stopped there, leaving P4 and P5 still
claiming 2.2.0 -- which is now P3's. Corrected train, verified against the
frontmatter above:

```
P3  -- 2.2.0 -- ecosystem lanes (stats + /debug subpath)  [BRIEF2, D6]  SHIPPING
P4  -- 2.3.0 -- bench and demo                             [BRIEF3]
P5  -- 2.3.0 -- release train (same release as P4)         [BRIEF4]
```

P4 and P5 sharing one version (2.3.0) is intentional and preserved: P4 builds the
bench and demo, P5 publishes them as one release; neither adds API.

The split line is **breaking vs additive**, and it falls out of the release
semantics rather than taste:

- Breaking, so it must ride 2.0.0: iteration order becomes unspecified (D2),
  foreign-object release and use-after-destroy start throwing (D4), `destroy()`
  starts draining (OP-09). D1 and OP-10 are internal but are what D2 and D4 are
  consequences of, so they cannot be separated from them.
- Additive, so it does not need the major: D5 (see the note in its brief).

Why split at all, given both halves are ready to plan:

1. **It is the exact precedent that produced P1.** S2 was split "because the
   capacity fix and the core rewrite are separately provable and separately
   revertable". D5 and the core rewrite are separately provable and separately
   revertable by the same test. That reasoning was right once already.
2. **Stacked, a failure in either half reverts both.** The core rewrite is the
   package's headline claim and the option reshape is "the largest single API
   change in the roadmap" -- by the roadmap's own words. Coupling the riskiest
   implementation to the riskiest API change buys nothing.
3. **The gate cannot attribute a regression across both.** P2a's defining
   assertion is "1,321,024 bytes -> 0" on the acquire/release path. If the option
   layer lands in the same diff and the number misses, nothing in the harness
   says which half did it.

Honest cost of the split, stated so it is not discovered later: 2.0.0 is the
natural moment for callers to revisit their config, and P2a's migration note will
have to say "the option shape is also changing, in 2.1.0, additively" rather than
presenting one migration. That is a documentation cost, not a caller cost -- see
the D5 note for why no second migration is forced.

Also stale, minor: the "P1 blocks P2" rationale above quotes P2's central design
move as "when `maxSize` is finite, preallocate all capacity up front and never
allocate again". OP-10 has since rejected sizing the backing store to the bound,
and the population strategy is now a caller choice. The dependency itself still
holds -- you cannot preallocate to a bound the constructor ignores -- but it is a
weaker edge than written.

---

## 5. The briefs

===============================================================================
# P0 -- v1.0.3 -- node:test, the torture skeleton, and the naming decision
===============================================================================

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 1.0.3
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [OP-08, OP-12, OP-13, OP-14, OP-16, OP-17]
blocks: [P1]
---

# @zakkster/lite-object-pool -- make the bugs visible before fixing any of them

PURPOSE
  The package has 45 vitest cases and no gate. Every finding in section 2 was
  found by running a probe, not by reading, and none of them is currently
  observable from `npm test`. Build the instrument first. Change no behaviour.

THE DECISION (record it before coding)
  Naming. The original roadmap left this as "owner call" and it blocks the
  scope move, so settle it here.
  A. **@zakkster/lite-object-pool** -- keeps lineage and searchability; the
     unscoped package's downloads and inbound links keep pointing somewhere
     that resolves. Longest name in the suite.
  B. **@zakkster/lite-pool** -- cleaner, but collides conceptually with the
     typed / SAB pools deferred as D1 and D2. If those ever ship, `lite-pool`
     is the name they want, and it will be taken by the object pool.
  Recommendation: **A.** B trades a permanent naming collision with a package
  you have already written down as planned for a shorter name. Lineage is the
  smaller cost.

TASKS
  - Port test/ObjectPool.test.js to node:test. Keep all 45 cases and every
    group. `import { test } from 'node:test'`, `import assert from
    'node:assert/strict'`. Replace `vi.fn()` with a hand-rolled counter -- the
    suite has no test-double dependency and does not need one. Strip the emoji
    from the describe title (OP-12, ASCII-only law). Set `"test": "node --test"`.
  - Bump `engines.node` to `>=18`. The current `>=16` floor predates usable
    `node --test`.
  - Add `CHANGELOG.md` and a `VERSION` const exported from ObjectPool.js. Add
    both to `files[]`. Add `sideEffects: false`. Add a `LICENSE` file: MIT (c)
    Zahary Shinikchiev <shinikchiev@yahoo.com>. Three-place sync from here on.
  - Fix package.json metadata per section 0, contingent on the org answer.
  - Add a version line to llms.txt.
  - Replace the `reset = () => {}` default with a module-level `NOOP` (OP-14).
  - Build test/torture.mjs + test/torture/harness.mjs per section 3. Wire T0,
    T1, T3, T4, T6, T7, T9 now. Register T5 and T8 as empty tiers that P2 and
    P3 fill -- registered and empty, not absent, so the numbering is visible.
  - devDep `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak`. Drop vitest.
  - **T6 is non-negotiable**: gate `maxArrayBuffersGrowth: 0` with
    `stabilize: 'deep'`, and record the CURRENT measured bytes-per-acquire in
    CHANGELOG as a known issue. The gate is expected to FAIL on OP-01 at this
    version -- register it as `todo`, with the number, so P1/P2 have a
    falsifiable before-figure rather than a memory of one.
  - Run probe P-01/P-02/P-03 and paste the outputs into CHANGELOG under known
    issues, with the node version and date.
  - Run the OP-17 polymorphism probe and record the answer. If it costs, P2's
    benchmark uses two shapes.

ASSERTIONS
  - `node --test` green, 45+ passing, 0 failing. Grep proves no `vitest` import
    and no non-ASCII byte remains in test/ or source.
  - `node --expose-gc test/torture.mjs` prints exactly "ok", exit 0, with the
    OP-01 T6 case registered todo and every other tier live.
  - `OBJECTPOOL_TORTURE_BREAK=1 ...` exits non-zero.
  - T0's conjoined invariant holds for clause one and FAILS for clause two
    (`size <= maxSize`) -- registered as the OP-02 reproduction, todo.
  - `npm pack --dry-run` excludes test/ and includes CHANGELOG.md and LICENSE.
  - VERSION === package.json version === llms.txt version line.

NON-GOALS
  No behaviour change. No new API. No fixes -- every finding gets recorded in
  CHANGELOG as a known issue with its measured number, and is fixed in P1/P2.

DONE WHEN
  node --test green under node:test; torture prints "ok"; the control fails;
  OP-01 and OP-02 are registered as reproducible failing cases with numbers
```

===============================================================================
# P1 -- v1.1.0 -- make maxSize mean something
===============================================================================

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 1.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [OP-02, OP-03]
depends_on: [P0]
blocks: [P2]
---

# @zakkster/lite-object-pool -- the cap that does not cap

PURPOSE
  `{size: 10, maxSize: 4}` builds a pool that hands out ten objects. `maxSize`
  is documented as the protection against runaway allocation from logic bugs,
  and it does not constrain the construction path -- which is the path that
  allocates. Separately, `size: 2.5` throws `RangeError: Invalid array length`
  from `new Array`, naming neither this library nor the offending option.

WHY THIS COMES BEFORE THE REWRITE
  P2's central move is "when `maxSize` is finite, preallocate all capacity up
  front and never allocate again". That sentence has no meaning while the
  constructor ignores `maxSize`. Fix the bound before building on it.

THE DECISION (record it before coding)
  What does `{size: 10, maxSize: 4}` do?
  A. **THROW** -- `maxSize < size` is a caller bug; fail closed at the door.
  B. **CLAMP** -- silently preallocate `min(size, maxSize)`.
  C. **CLAMP AND WARN** -- clamp, and expose it via a `clamped` flag on stats.
  Recommendation: **A.** The two numbers contradict each other and only the
  caller knows which one they meant; clamping picks one silently and the
  package's whole value is that it does not silently allocate differently than
  you asked. This is a breaking change for anyone currently passing a
  contradiction -- which is why it is a minor bump with a CHANGELOG entry, and
  why it lands before the rewrite rather than buried inside it.

THE SECOND DECISION (record it before coding)
  Does `expand: 0` / `''` / `null` throw, or keep coercing?
  Today they coerce falsy and the pool correctly does not expand -- the caller
  gets exactly what they meant. Making them throw is a SECOND breaking change
  in this release, on an option the roadmap originally only said "boolean if
  provided" about.
  Decision: **THROW.** Three reasons, in order of weight:
   1. A validation layer with one coercing hole is worse than no validation
      layer, because it teaches the caller that options are checked and then
      isn't. All six options land in the same release; they must agree.
   2. lite-signal is the counter-example, not the precedent (section 2, item
      4): its unvalidated `prealloc` / `onCapacityExceeded` strings silently
      select the OPPOSITE of the intended policy on a typo. `expand: 'flase'`
      is truthy and would silently expand forever. Strictness on the boolean
      is what makes the typo case reachable.
   3. `expand: 0` was never a documented input. One clear error now beats
      silent behaviour that changes under them again in 2.0.0.
  **Obligation this creates on P2:** Decision 5 turns `expand` into an enum.
  P2 MUST keep `expand: true|false` accepted as an alias for the enum values,
  or someone passing a legitimate boolean eats a second break in two releases.
  Write that into the P2 brief when the enum lands, not after.

TASKS
  - Validate every option in the constructor and throw a library error naming
    the option and the value received:
      * `create` -- required, must be a function (already throws; keep, and
        align the message format with the rest).
      * `reset` -- must be a function if provided.
      * `size` -- integer, `>= 0`, finite. Rejects -1, 2.5, NaN, Infinity, '32'.
      * `maxSize` -- integer `>= 0` or `Infinity`. Rejects NaN, negatives.
      * `maxSize >= size` -- per the decision above.
      * `expand` -- strict boolean if provided; `0`, `''`, `null`, `1` throw.
  - Set `_totalCreated` from the number of objects actually created, not from
    the `size` argument (`ObjectPool.js:36`).
  - **OP-10 is DEFERRED out of P1.** The original task here read "preallocate
    `_free` at final capacity when `maxSize` is finite". The lite-signal prior
    art (section 2) rejects that strategy: it grows in bounded contiguous
    chunks and keeps a hard ceiling even in grow mode, because a backing store
    sized to the bound trades a mid-frame regrow for a construction-time burst
    and a silently truncating `length` assignment. Doing it right means picking
    a chunk size and proving the pause bound -- that is a measured change to
    the growth path, and it belongs next to the structural rewrite in P2, not
    bolted onto a validation session. P1 leaves `:90` alone.
  - Fill torture T1 completely per section 3.
  - Flip T0's `size <= maxSize` clause from todo to live.

HOT PATH
  All of this is constructor-cold and runs once. `acquire` and `release` gain
  ZERO instructions -- diff them to prove it, and keep the P0 `assertOps`
  baseline green. A validation layer that reaches the hot body is a rejected
  design. The one thing that touches the hot path is the removal of the
  `push()` regrow, which can only make it faster; measure and record.

ASSERTIONS
  - `{size: 10, maxSize: 4}` throws a library error naming both options.
  - `{size: 32, maxSize: 0}` throws; nothing is preallocated first (assert the
    `create` callback was never invoked -- a throw after 32 allocations is not
    a fix).
  - `size: -1 | 2.5 | NaN | Infinity | '32' | null` each throw a library error
    naming `size`, never a raw `RangeError` from `new Array`. Grep the messages.
  - Every T1 case has a pinned expected result.
  - `size <= maxSize` holds after every operation in T0, T3 and T5.
  - `acquire`/`release` `assertOps` within noise of the P0 baseline.
  - torture "ok"; T9 controls exit non-zero.

NON-GOALS
  No structural change -- the Set stays until P2. No API additions. Do not fix
  OP-01 here; keeping the allocation fix and the capacity fix in separate
  commits is what makes the P2 benchmark interpretable.

DONE WHEN
  maxSize is a real bound, proven by a test that failed at v1.0.3;
  every bad option throws a library error naming it; hot path measured unchanged
```

===============================================================================
# P2 -- v2.0.0 -- the sparse-set core (the headline session)
===============================================================================

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 2.0.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [OP-01, OP-04, OP-05, OP-06, OP-07, OP-08, OP-09, OP-10, OP-11]
depends_on: [P1]
blocks: [P3]
---

# @zakkster/lite-object-pool -- make the headline sentence true

PURPOSE
  "Preallocate objects once, reuse them forever. No allocations during
  gameplay." Measured, a fully preallocated 20,000-object pool allocates
  1,321,024 bytes filling itself once, and 6.4 MB across 200 spike cycles. The
  `_out` Set is the whole cost: `Set.add` rehashes as it grows, and it grows on
  exactly the spawn spike the package exists to absorb.

WHY THIS IS THE HEADLINE SESSION
  Everything else in this package is a contract bug a careful caller could work
  around. This one breaks the reason the package exists, in the workload the
  README leads with, and it is invisible to anyone who does not run a heap
  probe -- which is why it survived to v1.0.2 with 45 passing tests.

THE DECISION 1 (record it before coding): the structure
  A. **SPARSE SET** -- `_items[]` store, dense/sparse index pair, `_activeCount`
     cursor. Acquire is an O(1) cursor advance, release is an O(1) swap-remove.
     The double-release guard becomes an index cross-check with no hash table
     anywhere. Requires a slot index per object: either a `WeakMap` (which
     reintroduces a hash table), a hidden property on the object (which mutates
     the caller's object), or the pool handing out indices instead of objects
     (which is D1, a different API). **This is the fork that matters -- resolve
     it before committing to A.** The honest version is: the objects are
     created by the pool, so stamping a non-enumerable symbol-keyed slot index
     on them at construction is legitimate and free at runtime; document it
     loudly, because it is observable via `Object.getOwnPropertySymbols`.
  B. **KEEP THE SET, PRE-SIZE IT** -- there is no way to pre-size a JS `Set`.
     Rejected; recorded so nobody proposes it again.
  C. **PARALLEL ARRAY + LINEAR SCAN** -- O(N) release. Rejected on the package's
     own O(1) claim.
  Recommendation: **A, via a symbol-keyed slot index stamped at create time.**
  Write the symbol-vs-WeakMap measurement into the decision record; a WeakMap
  is a hash table wearing a different hat and would reproduce OP-01.

  **MEASURED 2026-08-15 -- the sentence above is wrong, and A has a hazard.**

  *The WeakMap rejection does not survive measurement.* OP-01 is a **growth**
  cost: `Set.add` rehashes, and v1 calls it on every `acquire`. In the sparse-set
  design the slot index is written **once per object at create time** and only
  **read** thereafter. Reads do not rehash. Hot path, 20,000 objects x 40 passes:

  ```
  symbol read              0.0000 B/op     0.13 ms / 20k-pass
  WeakMap get             ~0.0000 B/op     0.30 ms / 20k-pass   (2.3x symbol)
  Set has+delete+add (v1)  0.0032 B/op     0.68 ms / 20k-pass   (5.2x symbol)
  ```

  So WeakMap is **zero-alloc on the hot path too** -- it is 2.3x slower than a
  symbol read, not disqualified. (Construction-time write costs were measured and
  are NOT quoted here: the settle-baseline drifted negative on two of three lanes,
  so the numbers are noise. Re-measure with lite-gc-profiler `measureOps`, not a
  hand-rolled `heapUsed` delta, before putting a construction figure in a record.)

  *And a symbol stamp is not universally applicable.* Probed:

  ```
  plain / null-proto / class instance / bare Proxy  -> stamps fine
  Object.freeze({})            -> TypeError: object is not extensible
  Object.seal({})              -> TypeError: object is not extensible
  Object.preventExtensions({}) -> TypeError: object is not extensible
  Proxy w/ defineProperty trap -> TypeError: trap returned falsish
  ```

  A caller whose `create` returns a frozen object -- defensive coding, or a class
  that freezes in its own constructor -- breaks design A outright. The failure is
  at least loud and at construction, not silent at runtime, but a raw
  `defineProperty` TypeError naming neither library nor option is OP-03's exact
  shape in a new place, so this needs a **decided, named policy**, not a leak.

  Also probed, and useful: the stamp is invisible to `JSON.stringify`,
  `Object.keys`, and spread (non-enumerable), and `structuredClone` **drops** it
  -- so a cloned or worker-round-tripped object correctly fails the guard rather
  than aliasing a live slot. That is the fail-closed answer, and it is free.

  **Revised recommendation: A, mechanism selected ONCE at construction.** Try to
  stamp the first created object; on refusal fall back to a WeakMap for that pool
  instance and say so in a named error or a documented flag. Because the choice is
  per-instance and made cold, the hot path keeps zero branches. **Risk to measure
  before committing:** two mechanisms means two `release` shapes, and a caller
  using both pool kinds may push `release` polymorphic -- this is OP-17's question
  in a new place, and it is the one thing that could sink the fallback.

THE DECISION 2 (record it before coding): iteration order
  v1 gives insertion order (OP-06, measured). Swap-remove does not.
  A. **DECLARE UNSPECIFIED** -- take the free performance, CHANGELOG it as
     breaking, and pin "unspecified" with a test that asserts the set of
     visited objects and deliberately does NOT assert order.
  B. **PRESERVE INSERTION ORDER** -- costs a compaction or a linked list;
     gives back most of what the rewrite buys.
  Recommendation: **A**, and this is the single loudest line in the v1 -> v2
  migration note. Anyone drawing sprites in spawn order gets flicker, and they
  will not connect it to a pool upgrade unless the CHANGELOG says so in those
  words.

THE DECISION 3 (record it before coding): release during iteration
  It works today by accident (OP-07) and swap-remove breaks it: releasing the
  visited object swaps an unvisited object into the current slot, which a
  forward loop then skips.
  A. **REVERSE-ITERATION CONTRACT** -- `forEachActive` walks the dense array
     backwards. Releasing the current object swaps in an element from the tail,
     which a reverse loop has already visited, so nothing is skipped and
     nothing is visited twice. Costs nothing and makes the safe behaviour
     *contractual* for the first time. It also kills the README's `dead[]`
     array, which is an allocation per frame in the package's own documented
     game loop.
  B. **FORBID IT** -- document release-during-iteration as undefined.
  Recommendation: **A.** It is free, it turns an accident into a guarantee, and
  it lets the README stop teaching an allocating workaround. Pin it with a test
  that releases every object mid-iteration and asserts all N were visited.

THE DECISION 4 (record it before coding): exhaustion
  `acquire()` returns null for exhausted / capped / destroyed alike (OP-04).
  A. **KEEP NULL, ADD A REASON** -- null stays; a `lastError` or a `stats()`
     field says which. Non-breaking, but a side-channel on a hot call.
  B. **NULL FOR EXHAUSTED, THROW FOR DESTROYED** -- exhaustion is an expected
     runtime condition a game loop handles every frame; use-after-destroy is a
     caller bug. Different classes, different signals.
  C. **THROW FOR BOTH** -- breaks the documented `if (!p) break` pattern and
     puts a try/catch in a 60fps loop.
  Recommendation: **B.** It is the fail-closed law applied with a straight
  face: the expected condition returns a value, the bug throws. Same split for
  `release()` (OP-05): `false` for a genuine double-release, throw for a
  foreign object and for use-after-destroy (OP-11).

THE DECISION 5 (record it before coding): the option shape itself
  Added after probing lite-signal (section 2). P1 makes `{size: 10, maxSize: 4}`
  throw, which is the right minimal fix -- but a contradiction you have to
  validate is a contradiction the API let the caller write. lite-signal cannot
  express this bug: it has ONE capacity plus a SEPARATE population strategy.
  A. **KEEP `size` + `maxSize`** -- P1's throw is permanent. Two numbers, one
     of which is a trap, defended by an error message forever.
  B. **CAPACITY + POPULATION** -- `capacity` is the single bound (default
     `Infinity`), `prealloc` is how much of it is built at construction:
     `"eager"` (all of it, requires finite capacity), `"lazy"` (none), or an
     integer count. The contradiction becomes unrepresentable rather than
     rejected. `size` stays accepted as a deprecated alias for
     `{capacity: n, prealloc: "eager"}` so the common call still works.
  Recommendation: **B.** 2.0.0 is the only release that can change this shape,
  and P1's validation is the evidence it needs changing -- an error message
  defending an API against itself is a design smell with a measured origin.
  Also fold `expand` in here per Decision 4: `onExhausted: "null" | "grow" |
  "throw"`, defaulting to fail-closed, with `expand: true|false` kept as an
  alias (P1's second decision obliges this -- do not skip it).
  Cost: this is the largest single API change in the roadmap. If it is cut,
  say so explicitly in the CHANGELOG, because P1's throw then becomes
  permanent rather than transitional.

  **NOTE (2026-08-15): Decision 5 is ADDITIVE, not breaking.** Recommendation B
  keeps `size`, `maxSize` and `expand` working as aliases, so it adds option
  names and removes none. It therefore does **not** need the major, and does not
  have to ride in the same release as the breaking work. That matters, because it
  is what makes the P2 split below cost nothing: deferring D5 past 2.0.0 does not
  force callers through a second migration, since their existing config keeps
  working untouched. The only thing lost is that the 2.0.0 migration note cannot
  advertise the nicer shape yet.

TASKS
  - Implement the structure per Decision 1. `_items[]` flat store, dense and
    sparse index arrays (`Uint32Array` when capacity is finite and known --
    check the signedness lesson from lite-arena AR-01 before picking the type;
    these are indices, never handles, so unsigned is correct here, but SAY so
    in the decision record so the next reader does not have to re-derive it).
  - `acquire` -- cursor advance, no hash insert, no iterator.
  - `release` -- swap-remove via the slot index. The double-release and
    foreign-object guard becomes the index cross-check
    `slot < activeCount && dense[slot] === obj`, zero-alloc, no Set anywhere.
  - `forEachActive` -- plain reverse for-loop over the dense array. Optional
    `thisArg` so callers can avoid a closure per frame. Kills OP-08 as a side
    effect; do not bill the rewrite as being *for* OP-08.
  - `releaseAll` -- reverse for-loop, no iterator.
  - `destroy` -- decide and document whether it drains (calls `reset` on
    everything still out) or tears down (does not). Today it does neither
    visibly (OP-09). Recommendation: drain, then tear down, so the DOM-element
    and WebSocket use cases in the README get their cleanup.
  - Population strategy per Decision 5. Eager-to-capacity gives zero
    allocations post-construction, period -- but it is a CHOICE, not the only
    answer: lite-signal documents the tradeoff as deterministic latency and a
    zero-alloc hot path against a larger resident heap that every major GC
    traces, and it ships `"lazy"` for footprint-sensitive callers. Offer both;
    default to eager, since hard-real-time is this package's stated audience.
  - Growth path (OP-10), now that it lives here. Bounded contiguous chunks on a
    free-list miss, not a `push()` regrow and not a backing store sized to the
    bound. Pick the chunk size and PROVE the pause bound -- lite-signal uses
    256 nodes / 1024 links and measured that one-at-a-time lazy construction
    costs 10-25% on large graphs through lost heap locality, so both extremes
    are known-bad and the chunk size is the whole decision. Keep a hard ceiling
    even in grow mode.
  - Rewrite the README game-loop example to use the reverse-iteration contract
    and delete the `dead[]` array (OP-07). The documented pattern must stop
    violating the package's own premise.
  - Fill torture T5 (differential fuzz vs the v1 Set-based oracle) completely.
  - Grow the ported suite: 45 -> 90+ cases under node:test.

HOT PATH
  `acquire`, `release`, and the `forEachActive` loop body are the hot path and
  the whole session is about what they cost. No hash operations, no iterators,
  no closures per call, no per-op objects. The exhaustion and destroyed checks
  from Decision 4 are ONE branch each on a cold outcome -- measure them; if a
  branch shows on `assertOps`, move the destroyed check behind the same
  predicate as the exhaustion check rather than adding a second.

ASSERTIONS
  - **The gate that defines this session**: a fully preallocated pool running
    acquire-to-capacity + forEachActive + release-to-empty passes T6 at
    `maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0` with
    `stabilize: 'deep'`. The spike shape passes it too, separately.
  - The P0-recorded before-figures are beaten to zero, and the CHANGELOG
    states both numbers. "1,321,024 bytes -> 0" is the claim; write it as a
    measurement, not an adjective.
  - T5: 100k mixed ops against the v1 oracle agree on `used`, `free`, `size`
    and the sorted set of active identities at every step. Order is explicitly
    NOT compared -- and there is a comment saying that is Decision 2, not an
    oversight.
  - Release every object from inside `forEachActive`: all N visited exactly
    once, `used === 0` after, `free === size`.
  - Double release returns false; foreign object throws; acquire/release after
    destroy throws.
  - A test asserting iteration order is unspecified: two pools driven through
    different churn to the same active set may iterate differently, and the
    suite asserts only set equality.
  - `assertOps` on acquire/release shows a measured improvement over the P1
    baseline; the number goes in the CHANGELOG.
  - T7 soak: 4096 cycles, `used === 0` and `free === size` after each,
    lite-leak `tracker.size() === 0`, heap growth across cycles under budget.
  - torture "ok"; every T9 control exits non-zero.

NON-GOALS
  No handle API (D1). No SAB (D2). No shrink/TTL (D3). No stats() -- that is
  P3. No demo. Do not fold the P3 debug lane in here; the alloc gate must pass
  on a build with no debug surface at all before a debug surface is added.

DONE WHEN
  the headline sentence is true and measured;
  all four decisions recorded in decisions/ before any code;
  T5 fuzz-identical to the v1 oracle on every answer except order;
  the README's own game loop no longer allocates
```

===============================================================================
# P3 -- v2.2.0 -- ecosystem lanes
===============================================================================

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
findings: [OP-16]
depends_on: [P2]
blocks: [P4]
---

# @zakkster/lite-object-pool -- make the pool observable without making it allocate

PURPOSE
  A pool is a thing that goes wrong quietly: objects acquired and never
  released look exactly like a busy frame until the pool is exhausted, and by
  then the acquire site is long gone. The ecosystem already has the two
  instruments -- lite-gc-profiler's pool-escape canary and lite-leak's
  tracker -- and this package has nothing to hand them.

THE DECISION (record it before coding): the debug lane
  Acquire-site tagging means capturing a stack (or at minimum an id) per
  acquire. That allocates, in the hot path, in the package whose identity is
  that the hot path does not allocate.
  A. **CONSTRUCTOR FLAG** -- `new ObjectPool({ debug: true })`, off by default,
     checked once and branched per acquire.
  B. **SEPARATE SUBPATH BUILD** -- `@zakkster/lite-object-pool/debug` exporting
     a subclass. Zero bytes and zero branches in the production file; costs a
     second file and a second test matrix.
  C. **BUILD-TIME FLAG** -- dead-code-eliminated by the consumer's bundler.
     Zero cost, but only for consumers who bundle, and this package ships
     unbundled ESM.
  Recommendation: **B.** A is one branch in the hottest function in the package
  and the law says a branch that never fires still costs its bytes in the hot
  body. B keeps `ObjectPool.js` byte-identical to P2's gated version, which is
  also what makes the T6 gate meaningful -- the file it gates is the file that
  ships. C does not work for this package's distribution shape; record the
  rejection so it is not re-proposed.

TASKS
  - `stats(out)` -- fill a caller-provided object, zero allocation, returning
    it. Fields at minimum: `size`, `used`, `free`, `peakUsed`, `totalAcquires`,
    `totalReleases`, `expansions`. Shape it for lite-gc-profiler's `watchPool`
    pool-escape canary -- **read the profiler's llms.txt for the exact expected
    surface; do not write it from memory.** `out` is the only caller buffer in
    this package, so its aliasing question (can `out` be the pool's own
    internal counters object? no -- there isn't one) gets one named T0 case.
  - The lite-leak sink: an acquired-never-released kernel. A pool object that
    is acquired and still out after N cycles is the leak signal. Wire it as a
    kernel per lite-leak's documented kernel shape, and note that lite-leak's
    `track()` allocates by design -- so the sink lives in the debug build (B),
    not the production one.
  - The debug subpath per the decision: acquire-site tagging, a `leaks()`
    report naming the tag of everything still out, and a documented statement
    in llms.txt that this lane allocates and is not for production.
  - SPP probe for lite-hud / lite-scope pool telemetry.
  - Playwright browser lane wired into the shared portfolio harness.
  - Docs-drift guard test (OP-16), both directions, per T8.
  - Fill torture T8 completely.

HOT PATH
  `stats(out)` is not hot -- it is called at telemetry rate (~10 Hz), writes
  into a caller object, and allocates nothing. The counters it reports
  (`totalAcquires`, `peakUsed`) ARE incremented on the hot path: that is three
  integer increments per acquire, and it is the one place this session can
  regress P2. Measure it. If `assertOps` moves outside noise, the counters go
  behind the debug build too and `stats()` reports only what is derivable for
  free (`size`, `used`, `free`).

ASSERTIONS
  - `stats(out)` over 1e6 calls: zero allocation under the T6 gate.
  - The counters' hot-path cost is measured against the P2 baseline and the
    number is in the CHANGELOG -- kept or moved to the debug build on the
    evidence, not on preference.
  - `ObjectPool.js` is byte-identical to its P2 form except for the counter
    increments, if kept. Diff it.
  - The profiler canary consumes `stats(out)` and fires on a deliberately
    leaked acquire; the T9 control removes a stats field and the conformance
    test fails.
  - lite-leak `tracker.size() === 0` after a clean cycle, non-zero after a
    deliberate escape.
  - Docs-drift guard fails if a method is added to the prototype without an
    llms.txt line, and vice versa. Prove both directions.
  - torture "ok" with T8 live; the alloc gate still runs against the
    production build with no debug surface loaded.

NON-GOALS
  No shrink (D3). No handle API (D1). No demo -- P4.

DONE WHEN
  the pool is observable at 10 Hz for zero bytes;
  the debug lane's allocations are real, documented, and unreachable
  from the production entry point
```

===============================================================================
# P4 -- v2.3.0 -- bench and demo
===============================================================================

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
depends_on: [P3]
blocks: [P5]
---

# @zakkster/lite-object-pool -- the numbers, and something to look at

PURPOSE
  P2 claims a measured improvement. A claim in a CHANGELOG is a number someone
  has to trust; a stamped benchmark is a number they can re-run. And the
  package that leads with "no GC pauses in your 60fps loop" has no way for a
  reader to see a 60fps loop.

TASKS
  - Bench protocol v3 with stamped provenance (node version, OS, CPU, date,
    package version): v2 sparse-set vs v1 Set-based vs naive-alloc baseline.
    Report acquire and release in ns/op AND bytes/op -- the bytes number is
    the interesting one and it is the one v1 loses on.
  - Use two object shapes if the OP-17 probe from P0 showed polymorphism costs.
  - Verify `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` under
    lite-gc-profiler across the full bench workload, not just the torture body.
  - Demo per suite convention: oscilloscope phosphor-green, oklch tokens with
    hex declared first, `@media (hover: hover)`, rem sizing, `$`-prefixed
    cached DOM refs, importmap routing, pre-allocated ring buffers, ~10 Hz
    telemetry throttle, multi-scene `data-scene` tabs:
      * particle burst scene (the spike shape -- the OP-01 workload, live)
      * churn stress scene (steady 1:1 at capacity)
      * live watchPool pool-escape canary scene wired to lite-gc-profiler
  - Demo is never in `files[]`.
  - Load the `demo-audit` skill before writing demo code -- the forced-reflow
    law is not visible to the GC torture harness and this demo reads live
    telemetry every frame, which is exactly where that bug lives.

HOT PATH
  The demo's per-frame body is a hot path with its own law. Cache every DOM
  ref, batch reads before writes, throttle all text updates to the telemetry
  tick, never read layout inside the raf body.

ASSERTIONS
  - Bench reproduces the CHANGELOG's P2 numbers within noise, or the CHANGELOG
    is corrected to match the bench. They must agree.
  - The naive-alloc baseline is genuinely naive (allocate per acquire) so the
    comparison means something; assert its bytes/op is non-zero.
  - Demo runs 60fps with zero major GCs over 60 seconds under the profiler.
  - `npm pack --dry-run` excludes demo/ and test/.
  - torture "ok".

NON-GOALS
  No new API. No structural change. If the bench reveals a regression, that is
  a finding for a new session, not a fix smuggled into a bench commit.

DONE WHEN
  every number in the docs is stamped and re-runnable;
  the demo shows the spike workload not allocating, live
```

===============================================================================
# P5 -- v2.3.0 release train
===============================================================================

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 2.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [OP-13]
depends_on: [P4]
---

# @zakkster/lite-object-pool -- ship it, and retire the old one honestly

PURPOSE
  Publish under scope, deprecate the unscoped package, and write a migration
  note that names the two things that will actually bite: iteration order and
  the `maxSize` throw.

TASKS
  - Lockstep triple version bump: package.json + VERSION + llms.txt.
  - README rebuilt on the LiteSepforge blueprint per CLAUDE.md: title +
    one-line blockquote tagline; badges; a positioning H2 with inline install
    and runnable quick-start; TOC; Why this exists; What you get; a `<details>`
    deep-dive on the core surface; API reference with signatures and a
    constants table; Composability with a full end-to-end pipeline;
    a `<details>` Zero-GC design notes with an allocation table and the gated
    quality numbers from P4; Design decisions worth knowing; Testing; What this
    is not; Ecosystem; License. ASCII-only. Add it to `files[]`.
  - **Migration section, v1 -> v2.** Drop-in EXCEPT:
      * iteration order is no longer insertion order (P2 Decision 2);
      * `{maxSize < size}` now throws instead of silently over-allocating
        (P1) -- and the pool you were getting was not the pool you asked for;
      * foreign-object release and use-after-destroy now throw instead of
        returning false / null (P2 Decision 4);
      * `destroy()` now drains (P2), so `reset` runs on objects still out.
    Four breaking changes, each with the reason and a one-line fix. Do not
    round this to "drop-in" -- the original roadmap did, and the iteration
    change alone can silently break a renderer.
  - Grep every new file for stray tool-call tags before trusting it.
  - DONE IN 1.0.3, not deferred to here. The rename landed with the scoped
    1.0.3 docs pass, and the deprecation notice is fixed by decision:

      npm deprecate lite-object-pool "Moved to @zakkster/lite-object-pool. The unscoped package ends at v1.0.2; all future releases are scoped."

    There is NO final unscoped release. 1.0.2 is the last one -- the earlier
    "optional final unscoped v1.0.3, README banner only" is withdrawn, because
    it would contradict the notice's own sentence. P5 only re-checks that the
    notice is live on npm and that no doc has reacquired the unscoped name.
  - Copyright: MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. Never
    "Karadjov". Grep for it.

ASSERTIONS
  - `/release 2.3.0` clean, twice in a row.
  - `npm pack --dry-run` includes README, CHANGELOG, LICENSE, llms.txt,
    ObjectPool.js, ObjectPool.d.ts -- and excludes test/, demo/, decisions/.
  - Three-place version sync asserted by the T8 test, not by eye.
  - Every relative link in README and llms.txt resolves to a file in the repo.
  - Every public method appears in llms.txt and vice versa (the P3 guard).
  - The migration section lists all four breaking changes; a reviewer checks it
    against the P1 and P2 CHANGELOG entries line by line.
  - `node --test` green; `npm run torture` prints "ok"; controls fail.

NON-GOALS
  No behaviour change of any kind. This is a docs-and-publish release and the
  diff should contain no logic.

DONE WHEN
  published under scope; unscoped deprecated;
  the migration note names all four breaking changes with their reasons
```

---

## 6. How to run it

In order. `status: planned -> shipped` after each `/release`. Author the brief
in the package, then run the planner subagent on it, then coder, reviewer, qa,
then `/release`. Reviewer REJECTED goes back to coder, not forward.

Every session is proven by one command:

```bash
node --expose-gc test/torture.mjs
```

It prints exactly `ok` and exits 0. No gate output is a FAIL. Its control:

```bash
OBJECTPOOL_TORTURE_BREAK=1 node --expose-gc test/torture.mjs
```

must exit non-zero. The budget frontmatter is identical in every brief.
`alloc_bytes_per_op: 0` is the package's entire identity and that number never
moves.

**A note on the planner subagent for this package.** The `planner` agent
definition scopes it to reading the main file, `llms.txt`, `CHANGELOG.md` and
`test/`, and caps its output at 220 tokens. That is correct for a single-session
spec and it cannot produce or consume a document like this one. Hand it one
brief at a time from section 5; do not ask it to read the roadmap.

### If you only do a subset

1. **P0 first, regardless.** Every finding in section 2 came from a probe that
   is not in the test suite. Until the gate exists, every later fix is a claim.
   It is also the cheapest session here.
2. **P2 is the package.** OP-01 means the sentence on the front page of the
   README is false in the workload the README leads with. 1.3 MB of garbage
   filling a preallocated pool once is not a tuning issue; it is the product
   not working. Nothing else in this document has that ratio.
3. **P1 before P2, always.** "Preallocate all capacity when `maxSize` is
   finite" is P2's central move and it is meaningless while `maxSize` is not a
   bound. Building the rewrite on OP-02 bakes a silent over-allocation into the
   new structure's constructor.
4. **Decision 2 and Decision 3 in P2 are the migration.** The code change is
   the easy half. Iteration order and release-during-iteration are both
   behaviours users can already observe and neither is documented; a v2 that
   changes them without a migration note is a silent renderer bug in someone
   else's project.
5. **P3's counters are the one place P3 can undo P2.** Three integer increments
   per acquire is probably free and "probably free" is not a measurement.
6. **D1 is closer than it looks.** P2 Decision 1 needs a per-object slot index.
   If the symbol-stamp answer is rejected, the handle API is no longer deferred
   work -- it is the design. Settle Decision 1 with that in view.

### The habit this roadmap is built around

The original audit of this package listed six findings, all from reading. Two
of them -- the `for...of` iterator allocations -- were promoted to B1 and B2,
the top of the list. They cost **0.051 bytes per call**; V8 elides them. The
finding that actually matters, the Set rehash, was B3, described as a risk
("triggers internal hash-table rehash allocations") rather than as a measured
1.3 MB. And B6 asserted that release-during-iteration is unsafe in v1; it is
safe, it just isn't documented, and the rewrite is what will make it unsafe.

Reading found the right neighbourhood and ranked it wrong in both directions.
One `--expose-gc` probe, three lines long, reordered the entire roadmap and
turned the headline session from a hygiene rewrite into a correctness fix with
a number attached.

The lesson to keep in front of the reviewer subagent is the lite-arena one from
the sibling roadmap, and this package is about to be exposed to it: the v1
suite has 45 passing tests, including a group named `stats` that asserts
`used + free === size`, and a group named `usage: particle burst` that runs the
exact acquire/mutate/release cycle where OP-01 lives. Both are green. Neither
can see 1.3 MB of garbage, because neither one measures. A test that exercises
the hazardous path and asserts the wrong thing is a green light over a hole.

When the reviewer reads a test here, the question is not "does this test the
feature". It is: **would this test fail if the pool started allocating?**

---

## 7. Deferred (written trigger conditions required)

- **D1 -- u32 gen-guarded handle API.** The lite-signal / lite-arena
  recycled-slot lesson applied here: raw indices crash on recycled slots;
  generation bits catch stale handles. If handles are used, take lite-arena's
  AR-01 finding with them -- the handle must be stored in a container of the
  same signedness, or half the generation range silently corrupts.
  **Trigger:** a consumer needs serializable or cross-worker pool refs, OR P2's
  Decision 1 rejects the symbol-stamped slot index, which makes this the
  structure rather than an addition.
  **STATUS (2026-08-17, recorded at BRIEF2/P3): the second clause FIRED, and is
  DISCHARGED -- not outstanding.** P2a's Decision 1 DID reject the symbol stamp:
  it went WeakMap-only, because the mixed symbol+WeakMap lane did not net zero
  (0.0055 B/op -- the only lane that does NOT net zero, `decisions/D1-structure.md:119`).
  The second clause exists because rejecting the symbol stamp was ASSUMED to
  leave nothing mapping object -> slot, making handles the only remaining
  structure. WeakMap-only supplies that mapping at 0 B/op with zero capability
  regression, so the need the trigger anticipated never materialised. Only the
  FIRST clause -- serializable / cross-worker refs -- can still fire. Written down
  so a future reader does not conclude the roadmap was violated.
- **D2 -- SAB shared pool via a lite-worker subpath.**
  **Trigger:** lite-ambient-fx or lite-worker demands cross-thread pooling.
- **D3 -- `shrink()` / TTL decay.**
  **Trigger:** the lite-gc-profiler evidence lane shows sustained oversized
  pools in a real consumer. Not before -- a pool that shrinks is a pool that
  reallocates, which reopens OP-01 through the back door.
- **D4 -- typed-array / SoA pool.** A pool of struct-of-arrays rows rather than
  objects, which is what a particle system actually wants and is what
  `lite-soa-particle-engine` exists for. **Trigger:** a consumer needs pooled
  rows and lite-arena's component storage is the wrong shape for it. Note that
  this is the package `@zakkster/lite-pool` would naturally name, which is why
  P0's naming decision recommends against taking that name now.
- **D5 -- async / promise-returning acquire for pools that can wait.**
  **Trigger:** never, unless a consumer asks. Recorded so it is rejected once
  rather than re-argued; an awaiting acquire is a queue, not a pool, and it
  allocates a promise per call.

MIT (c) Zahary Shinikchiev
