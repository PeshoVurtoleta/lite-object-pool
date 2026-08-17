# @zakkster/lite-object-pool

> Tiny, fast, zero-dependency object pool for games, particle systems, scratch effects, and any hot path where GC spikes hurt performance. Preallocate once, reuse forever: O(1) acquire and release, O(1) double-release protection, optional auto-expansion.

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
> That name is **deprecated**: the unscoped package **ends at v1.0.2**, and all
> future releases ship only as `@zakkster/lite-object-pool`. Update your install
> and your imports to the scoped name -- npm does not redirect between an
> unscoped and a scoped package, so nothing happens automatically.

Preallocate objects once and reuse them forever, instead of handing the garbage
collector a fresh object on every spawn.

## Features

- **Zero allocation on the hot path** -- a fully preallocated pool doing
  acquire / release / releaseAll / forEachActive allocates **0 bytes** (since
  2.0.0; measured, gated on every CI run)
- **O(1) acquire and release** -- cursor advance + swap-remove over a sparse set
- **O(1) double-release and foreign-object protection** -- an index cross-check,
  no hash table on the hot path
- **Preallocates objects** at creation -- the object itself is never re-created
- **Optional auto-expansion** in bounded chunks with a `maxSize` ceiling
- **`forEachActive()`** with a reverse-iteration contract -- release the current
  object mid-loop safely, no scratch array
- **User-defined `reset()`** -- ensures clean state on reuse
- **`releaseAll()`** -- batch release for scene transitions
- **Stats** -- `size`, `used`, `free` for runtime tuning
- **Generic TypeScript support** -- full type inference on acquire/release
- **Zero runtime dependencies, single file**

## Installation

```bash
npm install @zakkster/lite-object-pool
```

Zero runtime dependencies. Single ESM file. `node:test` only.

## Quick Start

```javascript
import { ObjectPool } from '@zakkster/lite-object-pool';

const particles = new ObjectPool({
    size: 200,
    maxSize: 1000,  // expansion ceiling
    create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
});

// Acquire -- O(1), no call to create()
const p = particles.acquire();
p.x = 100;
p.y = 200;
p.vx = Math.random() * 2 - 1;
p.life = 1.0;

// Release when done -- O(1), calls reset()
particles.release(p);

// Scene transition -- release everything at once
particles.releaseAll();
```

## API

### `new ObjectPool(options)`

Since 2.1.0 there are two spellings of the same three axes -- the canonical
`{capacity, prealloc, onExhausted}` triple, and the permanent legacy
`{size, expand, maxSize}` aliases:

| Option | Type | Default | Legacy alias | Description |
|--------|------|---------|--------------|-------------|
| `create` | `() => T` | *required* | -- | Factory function that returns a new object |
| `reset` | `(obj: T) => void` | no-op | -- | Called on release to clean an object for reuse |
| `capacity` | `number` | `Infinity` | `maxSize` | Upper bound on total objects. A finite integer `>= 0` or `Infinity`, and **must be `>= prealloc`** |
| `prealloc` | `number \| "eager" \| "lazy"` | `32` | `size` | How much of `capacity` to build now. `"eager"` builds all of it (needs a finite `capacity`); `"lazy"` builds none |
| `onExhausted` | `"null" \| "grow" \| "throw"` | `"grow"` | `expand` (`true`=`"grow"`, `false`=`"null"`) | What `acquire()` does when it cannot serve: return `null`, grow a bounded chunk, or throw. `"grow"` grows then returns `null` at `capacity`; `"null"` and `"throw"` do **not** grow |

> **Known limit (grow-then-throw).** `onExhausted` is a single axis, so it couples
> growth with the terminal policy: "grow up to a hard cap, **then** throw" (the
> leak-detection config) is not expressible. `{ capacity: 4096, prealloc: 32,
> onExhausted: "throw" }` throws at acquire 33 and the `capacity` is inert --
> `"exceeded capacity"` fires only when `prealloc === capacity`. This is a scope
> **choice**, not a contradiction and **not** forced by additivity: `"throw"` is
> new surface with no legacy alias (`expand` folds only to `"grow"`/`"null"`, so
> `{ size: 32, expand: false, maxSize: 4096 }` is the twin of `onExhausted: "null"`,
> not `"throw"`). grow-then-throw was implementable; it was deferred because it
> needs a second, orthogonal axis -- a future additive change. See
> [`decisions/D5-options.md`](./decisions/D5-options.md).

The two vocabularies are **mutually exclusive**: mixing any legacy alias with any
canonical name -- `{size, capacity}`, `{expand, onExhausted}` -- throws a
`TypeError` naming one key from each side. The aliases are supported **forever**
and never warned. Defaults are identical in both spellings, so
`new ObjectPool({ create })` builds the same pool either way. `{prealloc: "eager",
capacity: Infinity}` throws by name (it would allocate forever). `onExhausted:
"throw"` distinguishes a capped pool (`exceeded capacity N`) from an exhausted one;
`onExhausted: "null"` deliberately keeps returning `null` for both, for the
game-loop caller who treats "no object this frame" as one condition.

Every option is validated in the constructor. A bad value throws a `TypeError`
whose message is prefixed `ObjectPool: "<option>"`, naming both the library and
the offending option -- e.g. `ObjectPool: "prealloc" must be a finite integer >= 0,
"eager", or "lazy", received 2.5 (number)`. Validation is constructor-cold and adds
nothing to `acquire()` / `release()` -- their bodies are byte-identical to 2.0.0.

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `.acquire()` | `T \| null` | Get an object. Returns `null` if empty and `expand` is false (or at `maxSize`). **Throws** on use-after-destroy. |
| `.release(obj)` | `boolean` | Return an object. Returns `false` on a genuine double-release; **throws** on a foreign object (never issued here) and on use-after-destroy. |
| `.releaseAll()` | `void` | Release all acquired objects. Calls `reset()` on each. Throws on use-after-destroy. |
| `.forEachActive(fn, thisArg?)` | `void` | Callback for every active object, in reverse. Releasing the current object mid-loop is safe. Order is unspecified. Throws on use-after-destroy. |
| `.stats(out)` | `object` | Write `{ size, used, free, expansions }` into the caller-provided `out` and return it. Allocates nothing (since 2.2.0). `out` must be an object; a non-object -- including a no-arg call -- **throws** a `TypeError` naming `"out"` rather than silently allocating a fresh object. |
| `.destroy()` | `void` | Drain (reset everything still out) then tear down. Idempotent. |

Since 2.0.0 the pool tracks objects by identity in a `WeakMap`, so `create()`
must return a distinct object (or function) each call; a non-object or a
duplicate identity throws a `TypeError` naming `create()`.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `.size` | `number` | Total created objects (initial + expansions) |
| `.used` | `number` | Currently acquired objects |
| `.free` | `number` | Available objects in the free list |

**Invariant:** `used + free === size` after every operation.

### Observability -- `stats(out)` and the `/debug` subpath (since 2.2.0)

`stats(out)` makes the pool observable for **zero bytes**: it writes `size`,
`used`, `free`, and `expansions` (how many times the pool grew a chunk) into an
object you own, and never allocates. Call it at telemetry rate:

```javascript
const snapshot = { size: 0, used: 0, free: 0, expansions: 0 };
pool.stats(snapshot); // no allocation -- reuse the same object every tick
```

When you need to find an **acquired-never-released** object, import the separate
debug lane -- it allocates by design and never loads in production:

```javascript
import { DebugObjectPool, createPoolLeakKernel } from '@zakkster/lite-object-pool/debug';

const pool = new DebugObjectPool({ create: () => ({ x: 0 }), size: 64, captureStacks: true });
const kernel = createPoolLeakKernel(pool); // an @zakkster/lite-leak audit()+count() kernel
// ... run your workload ...
console.log(kernel.count(), 'objects still out:', pool.leaks());
```

`DebugObjectPool` tags every acquire (~102 B/acquire, or ~1.2 KB with
`captureStacks: true`) so `leaks()` and the kernel can name the acquire site.
Note: `@zakkster/lite-gc-profiler`'s `watchPool` **cannot** observe this signal,
because the pool retains every object it ever created -- so a checked-out object
is never collected. Use the leak kernel above, not `watchPool`. See
[`decisions/D6-debug-lane.md`](./decisions/D6-debug-lane.md).

## How It Works

**Preallocation:** The constructor calls `create()` N times and stores the results. Your objects are built once and reused; `acquire()` never calls `create()` while a free slot exists.

**Sparse set:** The pool keeps all objects in an `_items[]` store and partitions their indices into `[active | free]` with a dense/sparse `Uint32Array` index pair and an active cursor. `acquire()` is a cursor advance; `release()` is an O(1) swap-remove. Neither touches a hash table, and neither allocates.

**Double-release and foreign-object guard:** Each object's slot index lives in a per-instance `WeakMap`, written once when the object is created and only READ afterwards (reads never rehash, so the hot path is zero-alloc). `release()` looks up the index and cross-checks `pos < active`: a foreign object throws, a genuine double-release returns `false`.

**Expansion:** When the pool is empty and `expand` is `true`, a bounded contiguous chunk of new objects is created (256, clamped by the remaining room to `maxSize`) -- not one object per acquire with a backing-store regrow. `size` reflects the growth; with a finite `maxSize` the chunk clamps so the cap stays exact.

## Zero allocation, measured

A fully preallocated pool allocates **0 bytes** across any sequence of acquire /
release / releaseAll / forEachActive. This is gated on every run of the
package's own torture suite (`npm run torture`) with `@zakkster/lite-gc-profiler`
at `maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0`, plus a netted
bytes-per-op check against a positive control. In v1.1.0 the `_out` `Set` rehashed
as it grew and draining a preallocated 20,000-object pool retained **1,321,024
bytes**; in 2.0.0 that is **0**. Reproduce the before/after:

```bash
node --expose-gc -e 'import("@zakkster/lite-object-pool").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({x:0}),size:20000,expand:false});globalThis.gc();globalThis.gc();const b=process.memoryUsage().heapUsed;for(let i=0;i<20000;i++)p.acquire();globalThis.gc();globalThis.gc();console.log("retained bytes:",process.memoryUsage().heapUsed-b)})'
```

## Game Loop Example

`forEachActive()` iterates over all acquired objects without maintaining a
separate array. Because iteration runs in reverse, you can release the object you
were handed **inside the callback** -- no `dead[]` scratch array, no allocation
per frame:

```javascript
const particles = new ObjectPool({
    size: 500,
    maxSize: 2000, // safety cap
    create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
});

function spawnBurst(x, y, count) {
    for (let i = 0; i < count; i++) {
        const p = particles.acquire();
        if (!p) break; // pool exhausted this frame (not an error)
        p.x = x;
        p.y = y;
        p.vx = (Math.random() - 0.5) * 4;
        p.vy = -Math.random() * 6;
        p.life = 1.0;
    }
}

function update(dt) {
    particles.forEachActive((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1; // gravity
        p.life -= dt;

        if (p.life <= 0) particles.release(p); // safe: reverse iteration (2.0.0)
    });
}
```

Do NOT rely on iteration order: since 2.0.0 it is unspecified (swap-remove does
not preserve spawn order). If you need a stable draw order, keep your own index.

## Use Cases

**Particles:**
```javascript
const pool = new ObjectPool({
    size: 500,
    create: () => ({ x: 0, y: 0, alpha: 1, scale: 1 }),
    reset: (p) => { p.x = p.y = 0; p.alpha = 1; p.scale = 1; },
});
```

**DOM elements:**
```javascript
const pool = new ObjectPool({
    size: 20,
    create: () => document.createElement('div'),
    reset: (el) => { el.className = ''; el.textContent = ''; },
});
```

**WebSocket messages:**
```javascript
const pool = new ObjectPool({
    size: 64,
    create: () => ({ type: '', payload: null, timestamp: 0 }),
    reset: (msg) => { msg.type = ''; msg.payload = null; msg.timestamp = 0; },
});
```

**Fixed-size (no expansion):**
```javascript
const pool = new ObjectPool({
    size: 100,
    expand: false, // acquire() returns null when exhausted
    create: () => new Bullet(),
    reset: (b) => b.deactivate(),
});
```

## TypeScript

Full generic support -- the type flows from `create()`:

```typescript
import { ObjectPool } from '@zakkster/lite-object-pool';

interface Particle {
    x: number;
    y: number;
    life: number;
}

const pool = new ObjectPool<Particle>({
    create: () => ({ x: 0, y: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.life = 0; },
});

const p = pool.acquire(); // Particle | null
if (p) {
    p.x = 100; // fully typed
}
```

## Migrating from unscoped `lite-object-pool`

The rename is the entire migration. `1.0.3` is behaviourally identical to the
unscoped `1.0.2` -- same class, same methods, same semantics, no code change
required.

```bash
npm uninstall lite-object-pool
npm install @zakkster/lite-object-pool
```

```diff
-import { ObjectPool } from 'lite-object-pool';
+import { ObjectPool } from '@zakkster/lite-object-pool';
```

The unscoped package is deprecated and receives no further releases. Later
scoped versions do introduce breaking changes -- each with migration notes in
[CHANGELOG.md](./CHANGELOG.md):

- **`1.1.0`** makes a contradictory `{maxSize < size}` throw.
- **`2.0.0`** rewrites the internals to a sparse set (zero allocation on the hot
  path). Behaviour changes worth checking before you upgrade: iteration order is
  now unspecified; `release()` of a foreign object and any use-after-destroy now
  throw (a genuine double-release still returns `false`); `destroy()` now drains;
  `create()` must return a distinct object each call; and expansion grows in
  bounded chunks. The option shape `{create, reset, size, expand, maxSize}` is
  unchanged.
- **`2.1.0`** adds the canonical `{capacity, prealloc, onExhausted}` option triple.
  It is purely **additive**: `{size, expand, maxSize}` keep working as permanent
  aliases and every 2.0.0 config constructs an identical pool, so there is **no
  migration** -- adopt the new spelling only if you want it.
- **`2.2.0`** adds the zero-alloc `stats(out)` method and the
  `@zakkster/lite-object-pool/debug` subpath. Purely **additive**: the hot bodies
  are byte-identical to 2.0.0, so there is **no migration**.

## Ecosystem

- **`@zakkster/lite-object-pool`** -- this package (formerly unscoped
  `lite-object-pool`, now deprecated)
- **`@zakkster/lite-gc-profiler`** -- the allocation gate this package is
  measured with (devDependency only)
- **`@zakkster/lite-leak`** -- the retention witness used by the soak tier
  (devDependency only)

## Testing

```bash
npm run verify
```

Runs the `node:test` suite, then the torture gate, then the gate's own
controls. The gate prints exactly `ok` and exits 0; any other output is a
failure. `npm run torture:controls` proves each control can actually fail --
a gate that cannot fail is decorative.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. See [LICENSE](./LICENSE).
