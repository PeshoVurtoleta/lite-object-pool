# lite-object-pool

[![npm version](https://img.shields.io/npm/v/lite-object-pool.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/lite-object-pool)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/lite-object-pool?style=for-the-badge)](https://bundlephobia.com/result?p=lite-object-pool)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

A tiny, fast, zero-dependency object pool for games, particle systems, scratch effects, and any hot path where GC spikes hurt performance.

Preallocate objects once, reuse them forever. No allocations during gameplay, no garbage collection pauses.

## Features

- **O(1) acquire and release** — stack-based free list (pop/push)
- **O(1) double-release protection** — Set-based guard, not O(N) `includes()`
- **Preallocates objects** at creation — zero allocations during gameplay
- **Optional auto-expansion** with `maxSize` safety cap — graceful under spikes, safe from runaway bugs
- **`forEachActive()`** — iterate acquired objects in game loops without exposing internals
- **User-defined `reset()`** — ensures clean state on reuse
- **`releaseAll()`** — batch release for scene transitions
- **Stats** — `size`, `used`, `free` for runtime tuning
- **Generic TypeScript support** — full type inference on acquire/release
- **Zero dependencies, < 1 KB**

## Installation

```bash
npm install lite-object-pool
```

## Quick Start

```javascript
import { ObjectPool } from 'lite-object-pool';

const particles = new ObjectPool({
    size: 200,
    maxSize: 1000,  // safety cap — prevents runaway expansion
    create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
    reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
});

// Acquire — O(1), no allocation
const p = particles.acquire();
p.x = 100;
p.y = 200;
p.vx = Math.random() * 2 - 1;
p.life = 1.0;

// Release when done — O(1), calls reset()
particles.release(p);

// Scene transition — release everything at once
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
| `maxSize` | `number` | `Infinity` | Maximum pool size — prevents runaway expansion |

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

**Preallocation:** The constructor calls `create()` N times and stores the results. No allocations happen during gameplay.

**Free list (stack):** Acquire pops from the end of an array. Release pushes back. Both are O(1). Stacks are the fastest data structure for object pools.

**Double-release guard:** A `Set` tracks which objects are currently "checked out." `release()` checks `Set.delete(obj)` — if it returns `false`, the object wasn't checked out (double-release or foreign), so it's silently ignored. `Set.has/add/delete` are all O(1).

**Expansion:** When the pool is empty and `expand` is `true`, a new object is created on the fly. This ensures your system degrades gracefully during spikes rather than crashing. The `size` counter increments to reflect the growth. If `maxSize` is set, expansion stops at that limit — protecting against runaway allocation from logic bugs.

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

Full generic support — the type flows from `create()`:

```typescript
import { ObjectPool } from 'lite-object-pool';

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

## License

MIT
