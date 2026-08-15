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

- **O(1) acquire and release** -- stack-based free list (pop/push)
- **O(1) double-release protection** -- Set-based guard, not O(N) `includes()`
- **Preallocates objects** at creation -- the object itself is never re-created
- **Optional auto-expansion** with a `maxSize` ceiling -- graceful under spikes
- **`forEachActive()`** -- iterate acquired objects in game loops without exposing internals
- **User-defined `reset()`** -- ensures clean state on reuse
- **`releaseAll()`** -- batch release for scene transitions
- **Stats** -- `size`, `used`, `free` for runtime tuning
- **Generic TypeScript support** -- full type inference on acquire/release
- **Zero runtime dependencies, < 1 KB**

Two of these do not yet hold as written in 1.0.3. See
[Known issues](#known-issues-in-103) -- they are measured, reproducible, and
fixed in 1.1.0 and 2.0.0.

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
    maxSize: 1000,  // expansion ceiling -- see Known issues
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

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `create` | `() => T` | *required* | Factory function that returns a new object |
| `reset` | `(obj: T) => void` | no-op | Called on release to clean an object for reuse |
| `size` | `number` | `32` | Initial pool size (preallocated) |
| `expand` | `boolean` | `true` | Auto-create objects when pool is exhausted |
| `maxSize` | `number` | `Infinity` | Ceiling on auto-expansion. **Not a cap on `size` in 1.0.3** -- see [Known issues](#known-issues-in-103) |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `.acquire()` | `T \| null` | Get an object. Returns `null` if empty and `expand` is false (or at `maxSize`). |
| `.release(obj)` | `boolean` | Return an object. Returns `false` on double-release or foreign object. |
| `.releaseAll()` | `void` | Release all acquired objects. Calls `reset()` on each. |
| `.forEachActive(fn)` | `void` | Execute a callback for every acquired (active) object. |
| `.destroy()` | `void` | Tear down the pool. Idempotent. |

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `.size` | `number` | Total created objects (initial + expansions) |
| `.used` | `number` | Currently acquired objects |
| `.free` | `number` | Available objects in the free list |

**Invariant:** `used + free === size` (when no expansion occurs during the check)

## How It Works

**Preallocation:** The constructor calls `create()` N times and stores the results. Your objects are built once and reused; `acquire()` never calls `create()` while the free list is non-empty.

**Free list (stack):** Acquire pops from the end of an array. Release pushes back. Both are O(1). Stacks are the fastest data structure for object pools.

**Double-release guard:** A `Set` tracks which objects are currently "checked out." `release()` checks `Set.delete(obj)` -- if it returns `false`, the object wasn't checked out (double-release or foreign), so it's silently ignored. `Set.has/add/delete` are all O(1).

**Expansion:** When the pool is empty and `expand` is `true`, a new object is created on the fly. This ensures your system degrades gracefully during spikes rather than crashing. The `size` counter increments to reflect the growth. When `maxSize` is set, *expansion* stops at that limit.

## Known issues in 1.0.3

Both are reproduced on every run of the package's own torture gate
(`npm run torture`), which prints each one with the number it measured. They
are listed here rather than discovered later, because two of the claims above
depend on them.

**`acquire()` allocates, even on a fully preallocated pool.** The pooled objects
are reused as promised, but the `_out` `Set` that guards against
double-release rehashes its internal table as it grows -- and it grows during
exactly the spawn spike this package exists to absorb. Measured on node
v26.3.1: draining a preallocated 20,000-object pool retains **66.1 bytes per
`acquire()`**. Steady 1:1 churn at capacity is far cheaper (0.44 B per
acquire/release pair) because the table has stopped growing. Reproduce:

```bash
node --expose-gc -e 'import("@zakkster/lite-object-pool").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({x:0}),size:20000});globalThis.gc();globalThis.gc();const b=process.memoryUsage().heapUsed;for(let i=0;i<20000;i++)p.acquire();console.log("bytes:",process.memoryUsage().heapUsed-b)})'
```

Fixed in 2.0.0, which replaces the `Set` with a sparse set and drops the figure
to 0 B per call. Until then, treat "no allocations during gameplay" as true of
your objects and false of the pool's bookkeeping.

**`maxSize` does not cap `size`.** It limits auto-expansion only. The
preallocation loop runs `size` times regardless, so `{size: 10, maxSize: 4}`
builds a pool that reports `size` 10 and hands out 10 objects -- 2.5x the
number you asked for -- and `{size: 32, maxSize: 0}` preallocates 32 past a cap
of zero. Reproduce:

```bash
node -e 'import("@zakkster/lite-object-pool").then(({ObjectPool})=>{const p=new ObjectPool({create:()=>({}),size:10,maxSize:4});let n=0;while(p.acquire())n++;console.log("maxSize 4 handed out",n)})'
```

Fixed in 1.1.0, where a contradictory `{maxSize < size}` throws at construction
instead of silently building the wrong pool. Until then, keep `maxSize >= size`.

## Game Loop Example

The `forEachActive()` method lets you iterate over all acquired objects without maintaining a separate array or accessing private fields:

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
        if (!p) break; // pool exhausted
        p.x = x;
        p.y = y;
        p.vx = (Math.random() - 0.5) * 4;
        p.vy = -Math.random() * 6;
        p.life = 1.0;
    }
}

function update(dt) {
    const dead = [];

    particles.forEachActive((p) => {
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1; // gravity
        p.life -= dt;

        if (p.life <= 0) dead.push(p);
    });

    for (const p of dead) particles.release(p);
}
```

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
scoped versions do introduce breaking changes -- `1.1.0` makes a contradictory
`{maxSize < size}` throw, and `2.0.0` rewrites the internals -- and each will
carry its own migration notes in [CHANGELOG.md](./CHANGELOG.md).

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
