# @zakkster/lite-object-pool

> Zero-GC object pool for games, particle systems, and any 60fps loop that would otherwise build and drop the same shape every frame. Preallocate once, reuse forever: O(1) acquire and release, O(1) double-release and foreign-object protection, a safe release-during-iteration contract, and a fully preallocated hot path that allocates zero bytes -- measured and gated, not asserted.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-object-pool.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-object-pool)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-object-pool?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-object-pool)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-object-pool?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-object-pool)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-object-pool?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-object-pool)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](./LICENSE)

> **Renamed.** This package was formerly published unscoped as `lite-object-pool`.
> That name is **deprecated**: the unscoped package **ends at v1.0.2**, and every
> release from `1.0.3` forward ships only as `@zakkster/lite-object-pool`. npm does
> not redirect between an unscoped and a scoped package, so nothing happens
> automatically -- update your install and your imports. See
> [Migrating](#migrating).

## The object pool the zero-GC stack was missing

`lite-object-pool` is the piece the `@zakkster` hot-path stack reaches for when a
loop churns the same shape thousands of times a second. A particle system, a
bullet hell, a WebSocket envelope decoder, a DOM recycler -- each one builds and
drops a small object per event, and each fresh object is a future GC pause. The
usual answers are a hand-rolled free-list (correct until the day it double-frees),
a growable array you `pop()` and `push()` (allocates on every regrow), or nothing
at all (and you feel it as jitter at 60fps). This is the pool for that specific
job: preallocate the objects once, hand out slots by index, and never allocate on
the hot path again.

```bash
npm install @zakkster/lite-object-pool
```

Zero runtime dependencies. Single ESM file. `node:test` only.

```javascript
import { ObjectPool } from '@zakkster/lite-object-pool';

const particles = new ObjectPool({
    capacity: 1000,                 // hard ceiling (legacy alias: maxSize)
    prealloc: 200,                  // build 200 now (legacy alias: size)
    create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
});

const p = particles.acquire();      // O(1), no call to create() while a slot is free
p.x = 100; p.y = 200; p.life = 1.0;

particles.release(p);               // O(1), calls reset(); false on a double-release
particles.releaseAll();             // batch return for a scene transition
```

Acquire, release, releaseAll, and forEachActive each allocate **0 bytes** on a
fully preallocated pool -- measured with `@zakkster/lite-gc-profiler`, gated on
every run of the package's own torture suite. That is the entire point of the
library, and it is the one claim it proves rather than asserts.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The pool, end to end](#the-pool-end-to-end)
- [API reference](#api-reference)
  - [Constructor](#constructor)
  - [Methods](#methods)
  - [Properties](#properties)
  - [Constants and exports](#constants-and-exports)
  - [Observability: stats(out) and the /debug subpath](#observability-statsout-and-the-debug-subpath)
- [Composability](#composability)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Benchmarks](#benchmarks)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Migrating](#migrating)
  - [From the unscoped package](#from-the-unscoped-package)
  - [v1 -> v2: the ten breaking changes](#v1---v2-the-ten-breaking-changes)
  - [The 2.1.0 option shape (additive)](#the-210-option-shape-additive)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)

---

## Why this exists

A 60fps loop that allocates has two problems no drop-in `new` solves at once:

1. **GC pauses land as visible jitter.** A particle system spawning and killing a
   few hundred objects a frame hands the collector a few hundred corpses a frame.
   V8's minor GC is fast, but it is not free, and a major GC at the wrong moment
   is a dropped frame you can see. A pool hands the collector *nothing*: the
   objects are built once at construction and reused forever, so a fully
   preallocated pool doing acquire / release / releaseAll / forEachActive
   allocates zero bytes. Not "few"; zero, gated.

2. **Lifecycle bugs are silent until they corrupt state.** Roll your own free-list
   and the first double-release, the first foreign object, the first
   use-after-teardown is a silent wrong answer -- an object handed to two owners,
   a count that drifts. This pool makes each of those *loud*: a foreign object or
   a use-after-destroy throws a named error, and a genuine double-release returns
   `false`. The guard is an index cross-check, not a hash table, so it costs
   nothing on the hot path.

The alternatives each miss one half: a bare array free-list is zero-alloc but
unguarded; a `Map`-backed pool is guarded but rehashes as it grows (v1 of this
package retained 1.3 MB draining a 20,000-object pool for exactly that reason);
a full ECS is neither small nor embeddable. This library is the sparse-set middle:
guarded *and* zero-alloc, in a single file with no dependencies.

---

## What you get

- **`new ObjectPool(options)`** -- one class that preallocates `create()`'d objects
  and hands them out by index. Build it once per `(create, capacity, prealloc)`;
  reuse it for the process lifetime.
  - **`acquire()`** -- O(1) cursor advance. Returns a preallocated object, or grows
    a bounded chunk, or returns `null`, or throws -- controlled by `onExhausted`.
  - **`release(obj)`** -- O(1) swap-remove. Calls your `reset()`. Returns `false`
    on a genuine double-release; throws on a foreign object.
  - **`releaseAll()`** -- batch return for scene transitions; `reset()`s each.
  - **`forEachActive(fn, thisArg?)`** -- walk the active objects with a contract
    that makes releasing the current object mid-loop safe, no scratch array.
  - **`stats(out)`** -- write `{ size, used, free, expansions }` into an object you
    own, at 0 B/op, for a per-frame HUD.
  - **`destroy()`** -- drain (reset everything still out) then tear down. Idempotent.
- **Every constructor option validated cold**, unknown keys included, so a bad
  config throws a named `TypeError` at construction instead of building a subtly
  wrong pool at runtime.
- **A separate `/debug` subpath** -- `DebugObjectPool` + `createPoolLeakKernel` --
  that trades bytes for leak diagnosis, and never loads in production.
- **Full generic TypeScript types** in [`ObjectPool.d.ts`](./ObjectPool.d.ts) and
  [`ObjectPoolDebug.d.ts`](./ObjectPoolDebug.d.ts); the element type flows from
  `create()`.

Zero runtime dependencies, single file, `sideEffects: false`.

---

## The pool, end to end

<details>
<summary>How acquire, release, and the guard actually work -- the sparse set in one read.</summary>

**Preallocation.** The constructor calls `create()` `prealloc` times and stores the
results in an `_items[]` array. Your objects are built once; `acquire()` never
calls `create()` while a free slot exists.

**Sparse set.** The pool partitions the indices of `_items[]` into `[active | free]`
with a dense/sparse `Uint32Array` index pair and an integer active cursor.
`acquire()` advances the cursor over the next free index -- one array read, one
increment. `release(obj)` is an O(1) swap-remove: it swaps the object's slot with
the last active slot and retreats the cursor. Neither touches a hash table, and
neither allocates.

**The guard.** Each object's slot index lives in a per-instance `WeakMap`, written
once when the object is created and only ever **read** afterward (a read never
rehashes, so the hot path stays zero-alloc). `release()` looks the index up and
cross-checks `pos < active`: an object this pool never issued throws a `TypeError`;
an object that was issued but is not currently checked out (a genuine
double-release) returns `false`. The `WeakMap` also lets `create()` be validated
for distinct identity -- returning the same object twice throws, rather than
silently collapsing two slots onto one object.

**Expansion.** When the pool is empty and `onExhausted` is `"grow"`, `acquire()`
builds a bounded contiguous chunk of new objects (256, clamped by the remaining
room up to `capacity`) rather than one object per call with a backing-store
regrow. `size` reflects the growth; with a finite `capacity` the chunk clamps so
the cap stays exact. This is the one cold allocation path, off the acquire hot
body.

**Reverse iteration.** `forEachActive` walks the dense array backwards. That is
what makes releasing the object you were just handed safe inside the callback:
the swap-remove moves the *last* active slot into the freed one, and you have
already passed it. Walking forward, the swap would move an unvisited object into
the current slot and you would skip it.

</details>

---

## API reference

### Constructor

```ts
new ObjectPool({ create, reset?, capacity?, prealloc?, onExhausted? })   // canonical
new ObjectPool({ create, reset?, size?,    expand?,  maxSize? })          // legacy alias
```

Since 2.1.0 the same three axes have two spellings -- the canonical
`{capacity, prealloc, onExhausted}` triple, and the permanent legacy
`{size, expand, maxSize}` aliases:

| Option | Type | Default | Legacy alias | Description |
|--------|------|---------|--------------|-------------|
| `create` | `() => T` | *required* | -- | Factory. **Must return a distinct object or function each call**; a non-object or a duplicate identity throws a `TypeError` naming `create()`. |
| `reset` | `(obj: T) => void` | no-op | -- | Called on `release()` to clean an object for reuse. |
| `capacity` | `number` | `Infinity` | `maxSize` | Upper bound on total objects. A finite integer `>= 0`, or `Infinity`, and **must be `>= prealloc`**. |
| `prealloc` | `number \| "eager" \| "lazy"` | `32` | `size` | How much of `capacity` to build now. `"eager"` builds all of it (**requires a finite `capacity`** -- with `Infinity` it throws by name, it does not hang); `"lazy"` builds none. |
| `onExhausted` | `"null" \| "grow" \| "throw"` | `"grow"` | `expand` (`true`=`"grow"`, `false`=`"null"`) | What `acquire()` does when it cannot serve: return `null`, grow a bounded chunk, or throw. `"grow"` grows then returns `null` at `capacity`; `"null"` and `"throw"` do **not** grow. |

The two vocabularies are **mutually exclusive**: mixing any legacy alias with any
canonical name -- `{size, capacity}`, `{expand, onExhausted}` -- throws a
`TypeError` naming one key from each side. The aliases are supported **forever**
and never warned. Defaults are identical in both spellings, so every 2.0.0 config
builds an identical pool. Every option is validated in the constructor; a bad
value throws a `TypeError` prefixed `ObjectPool: "<option>"`, and an **unknown key
throws too** (fail closed) with a did-you-mean hint -- `{maxsize: 4}` suggests
`maxSize`. Validation is constructor-cold: `acquire()` / `release()` /
`forEachActive()` gain zero instructions, and their bodies are byte-identical to
2.0.0, pinned by hash in the test suite.

> **Known limit (grow-then-throw).** `onExhausted` is a single axis, so growth and
> the terminal policy are coupled: "grow up to a hard cap, **then** throw" -- the
> leak-detection config -- is not expressible. `{ capacity: 4096, prealloc: 32,
> onExhausted: "throw" }` throws at acquire 33 and the `capacity` is inert
> (`exceeded capacity` fires only when `prealloc === capacity`). This is a scope
> choice, not a contradiction, and additive to fix -- see
> [`decisions/D5-options.md`](./decisions/D5-options.md).

### Methods

```ts
pool.acquire(): T | null
pool.release(obj: T): boolean
pool.releaseAll(): void
pool.forEachActive(fn: (obj: T) => void, thisArg?: any): void
pool.stats(out: object): object
pool.destroy(): void
```

| Method | Returns | Description |
|--------|---------|-------------|
| `.acquire()` | `T \| null` | Get an object, O(1). `null` when exhausted under `onExhausted:"null"` / `expand:false` or capped at `capacity`; `onExhausted:"throw"` throws instead, with distinct capped-vs-exhausted text. **Throws** after `destroy()`. |
| `.release(obj)` | `boolean` | Return an object, O(1); calls `reset()`. Returns `false` on a genuine double-release; **throws** on a foreign object (never issued here) and after `destroy()`. |
| `.releaseAll()` | `void` | Batch return, reverse loop, calls `reset()` on each. **Throws** after `destroy()`. |
| `.forEachActive(fn, thisArg?)` | `void` | Iterate active objects **in reverse**. Releasing the **current** object mid-walk is safe and contractual; `releaseAll()` mid-walk stops it; other mutation is unspecified. Order is unspecified. A non-function `fn` throws a named error. **Throws** after `destroy()`. |
| `.stats(out)` | `object` | Write `{ size, used, free, expansions }` into the caller's `out` and return it. Allocates **nothing**. `out` is required: a no-arg `stats()` **throws** a `TypeError` naming `"out"` rather than allocating one. Transactional -- a non-writable slot rolls the whole write back. |
| `.destroy()` | `void` | Drain (`reset()` everything still out) then tear down. Idempotent. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `.size` | `number` | Total created objects (initial `prealloc` + expansions). |
| `.used` | `number` | Currently acquired. |
| `.free` | `number` | Available to acquire. |

**Invariant:** `used + free === size` after every operation, and `size <= capacity`
always.

### Constants and exports

| Export | Kind | Meaning |
|--------|------|---------|
| `ObjectPool` | class | The pool. Default import surface. |
| `VERSION` | `string` | Package version, kept in lockstep with `package.json` and `llms.txt`. |
| `DebugObjectPool` | class | `@zakkster/lite-object-pool/debug` -- allocating diagnostic wrapper. |
| `createPoolLeakKernel` | function | `@zakkster/lite-object-pool/debug` -- a `@zakkster/lite-leak` `audit()`+`count()` kernel. |

### Observability: stats(out) and the /debug subpath

`stats(out)` makes the pool observable for **zero bytes** -- it writes `size`,
`used`, `free`, and `expansions` (how many times the pool grew a chunk) into an
object you own, and never allocates. Call it at telemetry rate from inside the raf
body:

```javascript
const hud = { size: 0, used: 0, free: 0, expansions: 0 };
pool.stats(hud);        // no allocation -- reuse the same object every tick
```

When you need to find an **acquired-never-released** object, import the separate
debug lane. It allocates by design and never loads in production:

```javascript
import { DebugObjectPool, createPoolLeakKernel } from '@zakkster/lite-object-pool/debug';

const pool = new DebugObjectPool({ create: () => ({ x: 0 }), size: 64, captureStacks: true });
const kernel = createPoolLeakKernel(pool);   // a lite-leak audit()+count() kernel
// ... run your workload ...
console.log(kernel.count(), 'still out:', pool.leaks());   // audit() names each acquire site
```

`DebugObjectPool` tags every acquire (measured net ~102 B/acquire with
`captureStacks` off, ~1173 B (~1.2 KB) with it on) so `leaks()` and the kernel can
name the acquire site that never released. It carries the whole core surface
(`acquire` / `release` / `releaseAll` / `forEachActive` / `used` / `free` / `size`
/ `destroy`, same contracts) plus `outstanding()`, `leaks()`, and a `stats(out)`
that adds `peakUsed` / `totalAcquires` / `totalReleases` -- three counters kept
**off** the core hot path on purpose (a measurement, D6.6, put them over the T2
threshold). See [`decisions/D6-debug-lane.md`](./decisions/D6-debug-lane.md).

> **`@zakkster/lite-gc-profiler`'s `watchPool` cannot observe this pool.**
> `watchPool` detects a pooled object that should live but *died*. `_items[]`
> retains every pooled object for the pool's whole lifetime, so nothing checked
> out is ever collected -- `watchPool` is structurally incapable of firing and
> reads clean forever, which is not the same as clean. Use `createPoolLeakKernel`
> for the leak direction that actually exists here.

---

## Composability

The `/debug` lane is the pool wired to the rest of the `@zakkster` diagnostic
stack. The end-to-end shape, from a production pool to a named leak report:

```javascript
import { ObjectPool } from '@zakkster/lite-object-pool';
import { DebugObjectPool, createPoolLeakKernel } from '@zakkster/lite-object-pool/debug';

// 1. Production: a fixed-capacity particle pool, zero-alloc on the hot path.
const particles = new ObjectPool({
    capacity: 2000, prealloc: 500, onExhausted: 'null',
    create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
});

// 2. A zero-alloc HUD: reuse one scratch object every frame.
const hud = { size: 0, used: 0, free: 0, expansions: 0 };
function drawHud() { particles.stats(hud); /* blit hud.used / hud.free */ }

function update(dt) {
    particles.forEachActive((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.life -= dt;
        if (p.life <= 0) particles.release(p);   // safe: reverse iteration
    });
    drawHud();
}

// 3. Dev only: swap the same options into DebugObjectPool to hunt a leak.
const dev = new DebugObjectPool({
    capacity: 2000, prealloc: 500, onExhausted: 'null', captureStacks: true,
    create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
});
const kernel = createPoolLeakKernel(dev);
// ... run the same update loop against `dev` ...
if (kernel.count() > 0) console.warn(kernel.audit());   // names each acquire site that never released
```

Every stage passes plain objects and preallocated buffers to the next: the
production pool is zero-GC on the hot path, `stats(out)` reads it for free, and
the debug lane is the *same option shape* with byte-for-byte the same contracts --
so a leak you reproduce under `DebugObjectPool` is a leak in the production pool,
and you pay the diagnostic bytes only in dev.

---

## Zero-GC design notes

<details>
<summary>What the hot path allocates (nothing), and how it stays that way.</summary>

One `ObjectPool` allocates everything it will ever use at construction: the
`_items[]` object store, the dense/sparse `Uint32Array` index pair, and the
per-instance `WeakMap` of slot indices. Each hot method afterward does nothing but
integer arithmetic on those preallocated structures and a `WeakMap` **read**
(never a write, so no rehash).

| Operation | Steady-state allocations |
| --------- | ------------------------ |
| `acquire()` (free slot available) | **0** |
| `release(obj)` | **0** |
| `releaseAll()` | **0** |
| `forEachActive(fn)` | **0** |
| `stats(out)` | **0** (writes into caller's `out`) |
| `acquire()` on an empty growable pool | once per chunk (256 objects), cold `_grow` |
| `new ObjectPool(...)` | once, at construction |

The four hot bodies are pinned by content hash in the test suite (`acquire`
`55f3a646dd5e9a57`, `release` `239ef75c603bf839`, `releaseAll` `b29b13b9996ffd34`,
`forEachActive` `937941616f65fd72`) -- a change that adds an instruction to any of
them fails the suite, so "byte-identical hot path" is a gate, not a promise.

The torture harness (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`) proves
**0 B/op** on each hot method under `--expose-gc`, at `maxMajor: 0,
maxPauseMs: 4, maxArrayBuffersGrowth: 0`, netted against a positive control that
*must* read non-zero -- because a gate that cannot fail is decorative. The headline
number, stamped and re-runnable via `npm run bench`: draining a never-drained
20,000-object pool, the frozen v1 fixture retains **1,321,024 bytes** (~66 B per
acquire) and v2 retains **0**. The v1 figure doubles as the drain window's
positive control at **60.368 B/op**; v2 on that identical window nets
**0.0000 B/op**. See [Benchmarks](#benchmarks).

</details>

---

## Benchmarks

`npm run bench` puts three implementations side by side -- the shipped v2
sparse-set pool, the frozen v1 `Set`-based fixture
([`test/baseline/ObjectPool-1.1.0.js`](./test/baseline/ObjectPool-1.1.0.js)), and
a genuinely-naive `new`-per-acquire into a retained sink -- and reports **ns/op**
and **bytes/op**. Every buffer is preallocated outside the timed loop, so the
measured loop is the bare kernel. Output is stamped with a node / OS / arch / CPU
fingerprint.

**Throughput** -- one acquire+release pair, lower ns/op is better:

| Path | ns/op | ops/s | Retained bytes |
| ---- | ----- | ----- | -------------- |
| naive `new` (no pool) | **4.67** | 214 M | non-zero, fed to the collector |
| v2 pool (this package) | 10.56 | 94.7 M | **0** |
| v1 pool (`Set`-based) | 41.59 | 24.0 M | grows and rehashes |

**Read that table honestly: a pool is not faster than `new` per operation.** V8's
bump allocator is superb, and adding a guarded index handoff on top of it costs
cycles -- the naive path wins the ns/op race. A pool wins a different race: it
hands the collector *nothing*. Over a sustained 60fps loop the naive path's
retained bytes become minor GCs and the occasional major-GC frame drop; the v2
pool's zero bytes become nothing. You reach for this library when the pauses
matter, not when the microbenchmark does. Against the *previous* design that also
pooled, v2 is ~4x faster per op (10.56 vs 41.59 ns) **and** drops v1's per-drain
retention to zero.

**Allocation headline** -- draining a never-drained 20,000-object pool:

| Implementation | Retained on drain | Drain-window net |
| -------------- | ----------------- | ---------------- |
| v1 fixture (`1.1.0`) | ~1,321,024 B (~66 B/acquire) | 60.368 B/op (positive control) |
| v2 (this package) | ~0 B (noise-limited) | **0.0000 B/op** |

```bash
npm run bench     # the tables above + a node/arch/v8/cpu fingerprint line
```

Numbers are from the stamped run in
[`bench/bench-results.json`](./bench/bench-results.json): **node v26.3.1,
darwin/arm64, Apple M4 Pro, 12 cores**. Throughput has real run-to-run spread (the
v2 pair's IQR is ~10%), so a given row is comparable only against the same
runtime -- reproduce on your own hardware with `npm run bench`. The allocation
numbers are stable to four decimals; the bench's verdict tests *both* halves and
flips to DISAGREES if either the v2 raw drain or the v2 drain-instrument reads
non-zero, so a regression that quietly ruins the zero fails as loudly as a leak.

---

## Design decisions worth knowing

- **Iteration order is unspecified, on purpose (D2).** The swap-remove that makes
  `release()` O(1) does not preserve insertion order, and v2 spends nothing trying
  to. If a stable draw order (z-order by spawn time) is load-bearing, keep your
  own ordered index. This is the loudest migration line -- see
  [`decisions/D2-order.md`](./decisions/D2-order.md).
- **Release-during-iteration is a contract, not luck (D3).** `forEachActive` walks
  the dense array in reverse specifically so releasing the current object mid-walk
  is safe -- no `dead[]` scratch array, no per-frame allocation. `releaseAll()`
  mid-walk stops the walk; any other mutation mid-walk is unspecified. See
  [`decisions/D3-iteration.md`](./decisions/D3-iteration.md).
- **Fail closed, name the value.** Every validator names the offending input and
  `null` is rejected as `null`, never coerced to zero. An unknown constructor key
  throws with a did-you-mean hint; a foreign object and every use-after-destroy
  throw named errors. A genuine double-release is the one non-throwing "no", and
  it returns `false`. See [`decisions/D4-exhaustion.md`](./decisions/D4-exhaustion.md).
- **The guard is an index cross-check, not a hash table (D1).** Slot indices live
  in a per-instance `WeakMap` that is written once and only read on the hot path,
  so double-release and foreign-object protection cost no allocation. That is also
  why `create()` must return a distinct identity each call. See
  [`decisions/D1-structure.md`](./decisions/D1-structure.md).
- **Expansion is chunked, so `size` jumps (D5 lineage, OP-10).** A free-list miss
  under `"grow"` builds 256 objects at once (clamped by remaining `capacity` room),
  not one per acquire, so `size` can jump by a chunk. A finite `capacity` keeps the
  chunk exact.
- **Two vocabularies, one pool (D5).** `{capacity, prealloc, onExhausted}` is the
  canonical spelling; `{size, expand, maxSize}` are permanent aliases, never
  deprecated, never warned. Mixing the two throws. See
  [`decisions/D5-options.md`](./decisions/D5-options.md).
- **Observability is free or it is a different subpath (D6).** Core `stats(out)`
  reports only the fields that cost nothing on the hot body; the three counters
  that would not (`peakUsed` / `totalAcquires` / `totalReleases`) live on
  `DebugObjectPool`, which allocates by design. See
  [`decisions/D6-debug-lane.md`](./decisions/D6-debug-lane.md).

---

## Migrating

There are two separate migration stories, and conflating them makes the additive
half look mandatory when it is not. If you are on the **unscoped** package, read
the rename note *and* the v1 -> v2 breaking changes. If you are already on a scoped
`2.x`, only the additive shape below is new, and it needs no action.

### From the unscoped package

The rename is a package-name change, nothing more. `1.0.3` is behaviourally
identical to the unscoped `1.0.2` -- same class, same methods, same semantics:

```bash
npm uninstall lite-object-pool
npm install @zakkster/lite-object-pool
```

```diff
-import { ObjectPool } from 'lite-object-pool';
+import { ObjectPool } from '@zakkster/lite-object-pool';
```

The unscoped package is deprecated, receives no further releases, and ends at
`1.0.2`. npm does not redirect between an unscoped and a scoped name, so the swap
above is manual. **The behaviour changes are not in the rename -- they are in the
`2.x` line below.** Do not treat the scoped package as a drop-in for the unscoped
one without reading them.

### v1 -> v2: the ten breaking changes

Ten behaviour changes separate the last unscoped release (`1.0.2`) from the `2.x`
line. Two landed in `1.1.0`; eight in `2.0.0`. Each is in the
[CHANGELOG](./CHANGELOG.md) with its issue id. **Items 1, 8, and 9 change behaviour
for code that never threw an error** -- they are the ones that bite silently, so
read those even if you skip the rest.

1. **Iteration order is now UNSPECIFIED** (OP-06, D2; 2.0.0). `forEachActive` and
   `releaseAll` visited objects in insertion order in v1 (a `Set`-order accident);
   swap-remove does not preserve it. *Bites silently:* a renderer keying z-index on
   spawn order starts flickering with no error. *Fix:* if draw order matters, keep
   your own ordered index.
2. **`release()` throws on a foreign object** (OP-05, D4; 2.0.0). An object this
   pool never issued -- including `null`, `undefined`, a primitive, or a sibling
   pool's object -- was a silent `false` in v1; it now throws a `TypeError`. *Fix:*
   release only objects this pool handed you; a genuine double-release still
   returns `false`, so keep branching on that.
3. **Use-after-destroy throws on every surface** (OP-11, D4; 2.0.0). `acquire()` on
   a destroyed pool returned `null` in v1 (indistinguishable from "exhausted");
   `release` / `releaseAll` / `forEachActive` silently no-op'd. All four now throw
   named errors. *Fix:* do not touch a pool after `destroy()`; exhausted `acquire()`
   still returns `null`, so that branch is unchanged.
4. **`destroy()` drains before tearing down** (OP-09; 2.0.0). It now calls `reset()`
   on every object still checked out before dropping references (v1 reset nothing).
   *Fix:* if your `reset()` frees external handles (DOM nodes, sockets), this is the
   behaviour you want; if it assumes the object is idle, make it idempotent.
5. **`create()` must return a distinct object** (D1; 2.0.0). The slot-tracking
   `WeakMap` needs object keys and distinct identities; a non-object or a duplicate
   identity now throws a `TypeError` naming `create()`. v1 pooled `null` and
   collapsed duplicates. *Fix:* return a fresh object (or function) each call.
6. **Unknown constructor keys throw** (fail closed; 2.0.0). A stray/typo'd option
   key was silently ignored in v1; it now throws a `TypeError` naming the key, with
   a did-you-mean hint. *Fix:* remove the stray key -- the throw is telling you it
   never did anything.
7. **A non-function `forEachActive` callback always throws** (2.0.0). In v1 the
   answer depended on pool state (a raw `TypeError` when non-empty, a silent no-op
   when empty); it now validates the callback once, before the loop, and throws a
   named error regardless. *Fix:* always pass a function.
8. **Expansion allocates in bounded 256-object chunks** (OP-10; 2.0.0). A free-list
   miss under `"grow"` builds 256 objects at once instead of one per acquire, so
   `size` can jump by a chunk. *Bites silently:* code asserting `size` increments by
   one per acquire, or sizing a parallel array off `size`, is now wrong. *Fix:* a
   finite `capacity` clamps the chunk so the cap stays exact; do not assume `size`
   grows by one.
9. **`{maxSize < size}` throws** (OP-02; 1.1.0). `{ size: 10, maxSize: 4 }` used to
   build a pool that reported `size` 10 and ignored `maxSize`; it now throws a
   `TypeError`: `"maxSize" (4) must be >= "size" (10)`. *Bites silently:* a
   contradictory config that "worked" in v1 (by giving you a pool you did not ask
   for) now refuses to construct. *Fix:* make `capacity`/`maxSize >= prealloc`/`size`.
10. **`expand` must be a strict boolean** (1.1.0). `expand: 'false'` was truthy in
    v1 and expanded forever; a non-boolean now throws. *Fix:* pass a real `true` /
    `false`, or use the canonical `onExhausted`.

### The 2.1.0 option shape (additive)

This is **not** a breaking change and needs **no** migration -- it is the shape to
write *new* code against. `2.1.0` added the canonical
`{capacity, prealloc, onExhausted}` triple; the v1/2.0 spelling
`{size, expand, maxSize}` stays as **permanent aliases**, and every `2.0.0` config
builds an identical pool untouched. Adopt the new spelling only if you want it:

| Legacy (still works forever) | Canonical (since 2.1.0) | Note |
| ---------------------------- | ----------------------- | ---- |
| `size: 200` | `prealloc: 200` | also `"eager"` / `"lazy"` |
| `maxSize: 1000` | `capacity: 1000` | the single upper bound |
| `expand: true` | `onExhausted: "grow"` | grow then `null` at capacity |
| `expand: false` | `onExhausted: "null"` | never grow, return `null` |
| *(no legacy alias)* | `onExhausted: "throw"` | never grow, throw on miss |

`2.2.0` is likewise additive: it added the zero-alloc `stats(out)` and the
`@zakkster/lite-object-pool/debug` subpath, with the hot bodies byte-identical to
`2.0.0`. No migration.

---

## Testing

**297 deterministic `node:test` cases across 57 suites, all pass**, plus a torture
gate that proves the zero-allocation claim and a controls suite that proves the
gate can actually fail.

```bash
npm test               # 297 node:test cases (contract + boundary + differential)
npm run torture        # @zakkster/lite-leak + lite-gc-profiler: 0 B/op, prints exactly "ok"
npm run torture:controls   # proves each gate control can fail -- a gate that cannot is decorative
npm run bench          # ns/op + bytes/op tables and a node/arch/cpu fingerprint
npm run verify         # test + torture + controls, the publish gate
```

The suites cover the option-validation surface (every named-error path, both
vocabularies, unknown-key rejection), the lifecycle contracts (foreign-object and
use-after-destroy throws, double-release `false`, drain-on-destroy), the
zero-alloc `stats(out)` writer, the `/debug` lane, a T5 differential fuzz that
drives the shipped pool, a brute-force oracle, **and the frozen `1.1.0` fixture**
through the same 100k-op stream (compared on `used`/`free`/`size` -- the accounting
cross-check the headline v1-vs-v2 bench rests on), and the four hot-body hash pins.
The torture gate prints exactly `ok` and exits 0; any other output is a failure.
No gate output is a FAIL.

---

## What this is not

- **Not an ordered collection.** Since 2.0.0 `forEachActive` walks the sparse set
  in reverse and order across releases is unspecified. If iteration order is
  load-bearing, keep your own list -- the pool will not give it back to you.
- **Not a grow-to-a-hard-cap-then-throw pool.** `onExhausted` is a single axis, so
  "grow up to `capacity`, then throw" is not expressible: `"grow"` returns `null`
  at the cap, `"throw"` never grows. A documented scope limit (D5), additive to fix.
- **Not a leak witness in the `watchPool` sense.** `_items[]` retains every pooled
  object for the pool's lifetime, so `@zakkster/lite-gc-profiler`'s `watchPool` is
  structurally incapable of firing here -- it reads clean forever, which is not the
  same as clean. Use `createPoolLeakKernel` for the acquired-never-released signal.
- **Not a production profiler.** The `/debug` subpath allocates by design -- that is
  the trade, not a defect. Core `stats(out)` is the production observability; ship
  the core class, pay the debug bytes only in dev.
- **Not safe past a heap-sized `prealloc`.** Validation accepts any finite integer;
  an unfillable `prealloc` dies in the fill loop (OOM, or a raw `RangeError` at or
  past 2^32). The valid-but-unfillable band is heap-dependent, so no bound closes
  it -- do not request a size the caller cannot hold resident.
- **Not SoA / TypedArray entity storage.** For generational handles over columnar
  storage, that is `@zakkster/lite-arena`; for Web Audio voice banks with stealing
  and ABA-safe handles, `@zakkster/lite-audio-pool`.
- **Not the unscoped `lite-object-pool`.** That package is deprecated, ends at
  `v1.0.2`, and npm does not redirect. Install the scoped name.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- **`@zakkster/lite-object-pool`** -- this package (formerly unscoped
  `lite-object-pool`, now deprecated)
- **`@zakkster/lite-gc-profiler`** -- the allocation gate this package is measured
  with (devDependency only)
- **`@zakkster/lite-leak`** -- the retention witness the `/debug` leak kernel and
  the soak tier build on (devDependency only)

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. See [LICENSE](./LICENSE).
