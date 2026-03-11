import { describe, it, expect, vi } from 'vitest';
import { ObjectPool } from './ObjectPool.js';

/** Helper: create a pool with particle-like objects */
function createPool(overrides = {}) {
    return new ObjectPool({
        create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
        reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
        size: 4,
        expand: true,
        ...overrides,
    });
}

describe('🎱 ObjectPool', () => {

    // ═══════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════

    describe('constructor', () => {
        it('preallocates the specified number of objects', () => {
            const pool = createPool({ size: 10 });
            expect(pool.size).toBe(10);
            expect(pool.free).toBe(10);
            expect(pool.used).toBe(0);
        });

        it('defaults to size 32', () => {
            const pool = new ObjectPool({ create: () => ({}) });
            expect(pool.size).toBe(32);
        });

        it('calls create() for each preallocated object', () => {
            const create = vi.fn(() => ({}));
            new ObjectPool({ create, size: 5 });
            expect(create).toHaveBeenCalledTimes(5);
        });

        it('throws if create is not provided', () => {
            expect(() => new ObjectPool({})).toThrow(/create.*required/i);
        });

        it('throws if create is not a function', () => {
            expect(() => new ObjectPool({ create: 'nope' })).toThrow(/function/i);
        });

        it('defaults reset to no-op', () => {
            const pool = new ObjectPool({ create: () => ({ val: 42 }), size: 1 });
            const obj = pool.acquire();
            obj.val = 999;
            pool.release(obj);
            const reused = pool.acquire();
            expect(reused.val).toBe(999); // no-op reset doesn't clear
        });

        it('defaults expand to true', () => {
            const pool = new ObjectPool({ create: () => ({}), size: 1 });
            pool.acquire();
            const second = pool.acquire(); // pool exhausted, should expand
            expect(second).not.toBeNull();
        });
    });

    // ═══════════════════════════════════════════════
    //  Acquire
    // ═══════════════════════════════════════════════

    describe('acquire()', () => {
        it('returns an object from the pool', () => {
            const pool = createPool();
            const obj = pool.acquire();
            expect(obj).toHaveProperty('x');
            expect(obj).toHaveProperty('life');
        });

        it('decrements free count', () => {
            const pool = createPool({ size: 3 });
            expect(pool.free).toBe(3);
            pool.acquire();
            expect(pool.free).toBe(2);
        });

        it('increments used count', () => {
            const pool = createPool({ size: 3 });
            expect(pool.used).toBe(0);
            pool.acquire();
            expect(pool.used).toBe(1);
        });

        it('returns unique objects', () => {
            const pool = createPool({ size: 3 });
            const a = pool.acquire();
            const b = pool.acquire();
            expect(a).not.toBe(b);
        });

        it('expands when exhausted (expand=true)', () => {
            const pool = createPool({ size: 1, expand: true });
            pool.acquire(); // takes the 1 preallocated
            const extra = pool.acquire(); // should expand
            expect(extra).not.toBeNull();
            expect(pool.size).toBe(2);
        });

        it('returns null when exhausted (expand=false)', () => {
            const pool = createPool({ size: 1, expand: false });
            pool.acquire();
            expect(pool.acquire()).toBeNull();
        });

        it('respects maxSize cap during expansion', () => {
            const pool = createPool({ size: 1, expand: true, maxSize: 3 });
            pool.acquire(); // 1 (preallocated)
            pool.acquire(); // 2 (expanded)
            pool.acquire(); // 3 (expanded, at cap)
            expect(pool.size).toBe(3);
            expect(pool.acquire()).toBeNull(); // at maxSize
        });

        it('defaults maxSize to Infinity', () => {
            const pool = createPool({ size: 1, expand: true });
            // Should be able to expand far beyond initial size
            for (let i = 0; i < 100; i++) pool.acquire();
            expect(pool.size).toBe(100);
        });

        it('returns null after destroy', () => {
            const pool = createPool();
            pool.destroy();
            expect(pool.acquire()).toBeNull();
        });
    });

    // ═══════════════════════════════════════════════
    //  Release
    // ═══════════════════════════════════════════════

    describe('release()', () => {
        it('returns object to the free list', () => {
            const pool = createPool({ size: 2 });
            const obj = pool.acquire();
            expect(pool.free).toBe(1);

            pool.release(obj);
            expect(pool.free).toBe(2);
            expect(pool.used).toBe(0);
        });

        it('calls reset() on the object', () => {
            const reset = vi.fn();
            const pool = createPool({ reset });
            const obj = pool.acquire();
            obj.x = 100;
            obj.y = 200;

            pool.release(obj);
            expect(reset).toHaveBeenCalledWith(obj);
        });

        it('resets object state for reuse', () => {
            const pool = createPool();
            const obj = pool.acquire();
            obj.x = 999;
            obj.y = 888;
            obj.life = 42;

            pool.release(obj);
            expect(obj.x).toBe(0);
            expect(obj.y).toBe(0);
            expect(obj.life).toBe(0);
        });

        it('returns true on successful release', () => {
            const pool = createPool();
            const obj = pool.acquire();
            expect(pool.release(obj)).toBe(true);
        });

        it('released object can be re-acquired', () => {
            const pool = createPool({ size: 1 });
            const obj = pool.acquire();
            pool.release(obj);
            const reused = pool.acquire();
            expect(reused).toBe(obj); // same reference
        });
    });

    // ═══════════════════════════════════════════════
    //  Double-Release Protection
    // ═══════════════════════════════════════════════

    describe('double-release protection', () => {
        it('ignores double-release (returns false)', () => {
            const pool = createPool({ size: 2 });
            const obj = pool.acquire();
            expect(pool.release(obj)).toBe(true);
            expect(pool.release(obj)).toBe(false); // ignored
        });

        it('does not corrupt free list on double-release', () => {
            const pool = createPool({ size: 2 });
            const obj = pool.acquire();
            pool.release(obj);
            pool.release(obj); // should be ignored

            expect(pool.free).toBe(2); // not 3
        });

        it('does not call reset() on double-release', () => {
            const reset = vi.fn();
            const pool = createPool({ reset });
            const obj = pool.acquire();
            pool.release(obj);
            reset.mockClear();

            pool.release(obj);
            expect(reset).not.toHaveBeenCalled();
        });

        it('two acquires after double-release return different objects', () => {
            const pool = createPool({ size: 2 });
            const a = pool.acquire();
            pool.release(a);
            pool.release(a); // ignored

            const b = pool.acquire();
            const c = pool.acquire();
            expect(b).not.toBe(c);
        });
    });

    // ═══════════════════════════════════════════════
    //  Foreign Object Protection
    // ═══════════════════════════════════════════════

    describe('foreign object protection', () => {
        it('ignores objects not from this pool', () => {
            const pool = createPool();
            const foreign = { x: 0, y: 0 };
            expect(pool.release(foreign)).toBe(false);
        });

        it('does not add foreign objects to free list', () => {
            const pool = createPool({ size: 2 });
            const freeBefore = pool.free;
            pool.release({ rogue: true });
            expect(pool.free).toBe(freeBefore);
        });
    });

    // ═══════════════════════════════════════════════
    //  releaseAll()
    // ═══════════════════════════════════════════════

    describe('releaseAll()', () => {
        it('releases all acquired objects', () => {
            const pool = createPool({ size: 4 });
            pool.acquire();
            pool.acquire();
            pool.acquire();
            expect(pool.used).toBe(3);

            pool.releaseAll();
            expect(pool.used).toBe(0);
            expect(pool.free).toBe(4);
        });

        it('calls reset() on each released object', () => {
            const reset = vi.fn();
            const pool = createPool({ reset, size: 3 });
            pool.acquire();
            pool.acquire();

            pool.releaseAll();
            expect(reset).toHaveBeenCalledTimes(2);
        });

        it('is safe to call when nothing is acquired', () => {
            const pool = createPool();
            expect(() => pool.releaseAll()).not.toThrow();
            expect(pool.free).toBe(4);
        });

        it('is no-op after destroy', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            expect(() => pool.releaseAll()).not.toThrow();
        });
    });

    // ═══════════════════════════════════════════════
    //  forEachActive()
    // ═══════════════════════════════════════════════

    describe('forEachActive()', () => {
        it('iterates over all acquired objects', () => {
            const pool = createPool({ size: 4 });
            const a = pool.acquire();
            const b = pool.acquire();
            a.x = 10;
            b.x = 20;

            const visited = [];
            pool.forEachActive((obj) => visited.push(obj.x));

            expect(visited).toContain(10);
            expect(visited).toContain(20);
            expect(visited.length).toBe(2);
        });

        it('skips released objects', () => {
            const pool = createPool({ size: 3 });
            const a = pool.acquire();
            const b = pool.acquire();
            pool.release(a);

            const visited = [];
            pool.forEachActive((obj) => visited.push(obj));

            expect(visited.length).toBe(1);
            expect(visited[0]).toBe(b);
        });

        it('does nothing when no objects are acquired', () => {
            const pool = createPool({ size: 3 });
            const callback = vi.fn();
            pool.forEachActive(callback);
            expect(callback).not.toHaveBeenCalled();
        });

        it('is no-op after destroy', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            const callback = vi.fn();
            pool.forEachActive(callback);
            expect(callback).not.toHaveBeenCalled();
        });

        it('works in a game loop update pattern', () => {
            const pool = createPool({ size: 10 });

            // Spawn 5 particles
            for (let i = 0; i < 5; i++) {
                const p = pool.acquire();
                p.x = i * 10;
                p.life = 1.0;
            }

            // Update loop: age all particles
            pool.forEachActive((p) => {
                p.life -= 0.1;
            });

            // Verify all were updated
            const lives = [];
            pool.forEachActive((p) => lives.push(p.life));
            expect(lives.every(l => Math.abs(l - 0.9) < 0.001)).toBe(true);
        });
    });

    // ═══════════════════════════════════════════════
    //  Stats
    // ═══════════════════════════════════════════════

    describe('stats', () => {
        it('size reflects total created objects', () => {
            const pool = createPool({ size: 4 });
            expect(pool.size).toBe(4);
        });

        it('size grows on expansion', () => {
            const pool = createPool({ size: 1, expand: true });
            pool.acquire();
            pool.acquire(); // expands
            expect(pool.size).toBe(2);
        });

        it('used + free = size (invariant)', () => {
            const pool = createPool({ size: 5 });
            pool.acquire();
            pool.acquire();
            expect(pool.used + pool.free).toBe(pool.size);
        });

        it('stats are correct through full lifecycle', () => {
            const pool = createPool({ size: 3 });
            expect(pool.size).toBe(3);
            expect(pool.free).toBe(3);
            expect(pool.used).toBe(0);

            const a = pool.acquire();
            const b = pool.acquire();
            expect(pool.free).toBe(1);
            expect(pool.used).toBe(2);

            pool.release(a);
            expect(pool.free).toBe(2);
            expect(pool.used).toBe(1);

            pool.release(b);
            expect(pool.free).toBe(3);
            expect(pool.used).toBe(0);
        });
    });

    // ═══════════════════════════════════════════════
    //  Destroy
    // ═══════════════════════════════════════════════

    describe('destroy()', () => {
        it('clears the pool', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            expect(pool.free).toBe(0);
            expect(pool.used).toBe(0);
        });

        it('is idempotent', () => {
            const pool = createPool();
            pool.destroy();
            expect(() => pool.destroy()).not.toThrow();
        });

        it('acquire returns null after destroy', () => {
            const pool = createPool();
            pool.destroy();
            expect(pool.acquire()).toBeNull();
        });

        it('release returns false after destroy', () => {
            const pool = createPool();
            const obj = pool.acquire();
            pool.destroy();
            expect(pool.release(obj)).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════
    //  Real-World Usage Pattern
    // ═══════════════════════════════════════════════

    describe('usage: particle burst', () => {
        it('handles acquire → mutate → release → reacquire cycle', () => {
            const pool = createPool({ size: 100 });

            // Simulate a burst of 50 particles
            const active = [];
            for (let i = 0; i < 50; i++) {
                const p = pool.acquire();
                p.x = Math.random() * 800;
                p.y = Math.random() * 600;
                p.life = 1.0;
                active.push(p);
            }
            expect(pool.used).toBe(50);
            expect(pool.free).toBe(50);

            // Kill all particles
            for (const p of active) {
                pool.release(p);
            }
            expect(pool.used).toBe(0);
            expect(pool.free).toBe(100);

            // Reacquire — objects are reused (no GC)
            const reused = pool.acquire();
            expect(reused.x).toBe(0); // reset was called
            expect(reused.life).toBe(0);
        });
    });
});
