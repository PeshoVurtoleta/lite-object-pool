import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectPool } from '../ObjectPool.js';

/**
 * Hand-rolled call recorder -- replaces vitest's vi.fn().
 *
 * `impl` is the optional backing implementation. Every call pushes its
 * argument list onto `.calls`, so `.calls.length` is the call count and
 * `.calls[i]` is the argument array of call i. `.reset()` clears the log,
 * standing in for vi.fn()'s mockClear().
 */
function spy(impl) {
    const fn = (...args) => {
        fn.calls.push(args);
        return impl ? impl(...args) : undefined;
    };
    fn.calls = [];
    fn.reset = () => { fn.calls.length = 0; };
    return fn;
}

/** True iff `fn` was called at least once with exactly `arg` (strict identity)
 *  as its sole argument -- the node:assert stand-in for toHaveBeenCalledWith. */
function calledWith(fn, arg) {
    return fn.calls.some((a) => a.length === 1 && a[0] === arg);
}

/** Create a pool with particle-like objects. */
function createPool(overrides = {}) {
    return new ObjectPool({
        create: () => ({ x: 0, y: 0, vx: 0, vy: 0, life: 0 }),
        reset: (p) => { p.x = p.y = p.vx = p.vy = p.life = 0; },
        size: 4,
        expand: true,
        ...overrides,
    });
}

describe('ObjectPool', () => {

    // ---------------------------------------------------------------
    //  Constructor
    // ---------------------------------------------------------------

    describe('constructor', () => {
        test('preallocates the specified number of objects', () => {
            const pool = createPool({ size: 10 });
            assert.strictEqual(pool.size, 10);
            assert.strictEqual(pool.free, 10);
            assert.strictEqual(pool.used, 0);
        });

        test('defaults to size 32', () => {
            const pool = new ObjectPool({ create: () => ({}) });
            assert.strictEqual(pool.size, 32);
        });

        test('calls create() for each preallocated object', () => {
            const create = spy(() => ({}));
            new ObjectPool({ create, size: 5 });
            assert.strictEqual(create.calls.length, 5);
        });

        test('throws if create is not provided', () => {
            assert.throws(() => new ObjectPool({}), /create.*required/i);
        });

        test('throws if create is not a function', () => {
            assert.throws(() => new ObjectPool({ create: 'nope' }), /function/i);
        });

        test('defaults reset to no-op', () => {
            const pool = new ObjectPool({ create: () => ({ val: 42 }), size: 1 });
            const obj = pool.acquire();
            obj.val = 999;
            pool.release(obj);
            const reused = pool.acquire();
            assert.strictEqual(reused.val, 999); // no-op reset doesn't clear
        });

        test('defaults expand to true', () => {
            const pool = new ObjectPool({ create: () => ({}), size: 1 });
            pool.acquire();
            const second = pool.acquire(); // pool exhausted, should expand
            assert.notStrictEqual(second, null);
        });
    });

    // ---------------------------------------------------------------
    //  Option validation (P1, v1.1.0) -- independent unit coverage of the
    //  torture suite's T1 tier. The torture gate and the unit suite must
    //  BOTH be able to catch a validation regression on their own.
    // ---------------------------------------------------------------

    describe('option validation', () => {
        const LIB_PREFIX = /^ObjectPool: "[a-zA-Z]+"/;

        describe('size rejection set', () => {
            for (const bad of [-1, 2.5, NaN, Infinity, '32', null]) {
                test(`rejects size: ${String(bad)}`, () => {
                    assert.throws(
                        () => new ObjectPool({ create: () => ({}), size: bad }),
                        (err) => err instanceof TypeError && /^ObjectPool: "size"/.test(err.message),
                    );
                });
            }

            test('never lets a bad size reach a raw RangeError from new Array', () => {
                for (const bad of [-1, 2.5, NaN, Infinity, '32', null]) {
                    assert.throws(
                        () => new ObjectPool({ create: () => ({}), size: bad }),
                        (err) => err.constructor.name === 'TypeError',
                        `size: ${String(bad)} did not throw a library TypeError`,
                    );
                }
            });

            test('accepts size: 0 and builds an empty, valid pool', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 0 });
                assert.strictEqual(pool.size, 0);
                assert.strictEqual(pool.free, 0);
                assert.strictEqual(pool.used, 0);
                // expand defaults to true, so an empty pool still serves the
                // first acquire by expanding. null is the expand:false path.
                assert.notStrictEqual(pool.acquire(), null);
                assert.strictEqual(pool.size, 1);
            });

            test('size: 0 with expand:false is exhausted from the start', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 0, expand: false });
                assert.strictEqual(pool.size, 0);
                assert.strictEqual(pool.acquire(), null);
            });

            test('accepts size: -0 as equivalent to 0', () => {
                const pool = new ObjectPool({ create: () => ({}), size: -0 });
                assert.strictEqual(pool.size, 0);
            });

            test('accepts undefined and falls through to the size:32 default', () => {
                const pool = new ObjectPool({ create: () => ({}), size: undefined });
                assert.strictEqual(pool.size, 32);
            });
        });

        describe('maxSize rejection set', () => {
            for (const bad of [-1, NaN]) {
                test(`rejects maxSize: ${String(bad)}`, () => {
                    assert.throws(
                        () => new ObjectPool({ create: () => ({}), size: 1, maxSize: bad }),
                        (err) => err instanceof TypeError && /^ObjectPool: "maxSize"/.test(err.message),
                    );
                });
            }

            test('rejects a non-integer maxSize', () => {
                assert.throws(
                    () => new ObjectPool({ create: () => ({}), size: 1, maxSize: 2.5 }),
                    (err) => err instanceof TypeError && /^ObjectPool: "maxSize"/.test(err.message),
                );
            });

            // 50 acquires from a size:1 pool consume the one preallocated
            // object and then expand 49 times -- final size is 50, not 51.
            test('defaults maxSize to Infinity when omitted', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 1, expand: true });
                for (let i = 0; i < 50; i++) assert.notStrictEqual(pool.acquire(), null);
                assert.strictEqual(pool.size, 50);
            });

            test('accepts an explicit maxSize: Infinity as equivalent to the default', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 1, expand: true, maxSize: Infinity });
                for (let i = 0; i < 50; i++) assert.notStrictEqual(pool.acquire(), null);
                assert.strictEqual(pool.size, 50);
            });
        });

        describe('the maxSize < size contradiction', () => {
            test('{size: 10, maxSize: 4} throws naming both options', () => {
                let err = null;
                try { new ObjectPool({ create: () => ({}), size: 10, maxSize: 4 }); }
                catch (e) { err = e; }
                assert.ok(err instanceof TypeError, 'did not throw a TypeError');
                assert.match(err.message, /"maxSize"/, 'message does not name maxSize');
                assert.match(err.message, /"size"/, 'message does not name size');
                assert.match(err.message, /4/, 'message does not include the maxSize value');
                assert.match(err.message, /10/, 'message does not include the size value');
            });

            test('{size: 32, maxSize: 0} throws and create() is never invoked', () => {
                let created = 0;
                const countingCreate = () => { created++; return {}; };
                assert.throws(
                    () => new ObjectPool({ create: countingCreate, size: 32, maxSize: 0 }),
                    (err) => err instanceof TypeError && /^ObjectPool: "maxSize"/.test(err.message),
                );
                assert.strictEqual(created, 0, 'create() ran before the contradiction check threw');
            });

            test('every maxSize strictly below size throws, for size 1..5', () => {
                for (let size = 1; size <= 5; size++) {
                    for (let maxSize = 0; maxSize < size; maxSize++) {
                        assert.throws(
                            () => new ObjectPool({ create: () => ({}), size, maxSize }),
                            (err) => err instanceof TypeError && LIB_PREFIX.test(err.message),
                            `size:${size},maxSize:${maxSize} did not throw`,
                        );
                    }
                }
            });

            test('maxSize === size (the boundary) is accepted, not a contradiction', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 4, maxSize: 4 });
                assert.strictEqual(pool.size, 4);
            });

            test('maxSize === size:0 (both zero) is accepted', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 0, maxSize: 0 });
                assert.strictEqual(pool.size, 0);
                assert.strictEqual(pool.acquire(), null);
            });
        });

        describe('expand rejection set', () => {
            for (const bad of [0, '', null, 1, 'false']) {
                test(`rejects expand: ${JSON.stringify(bad)}`, () => {
                    assert.throws(
                        () => new ObjectPool({ create: () => ({}), size: 1, expand: bad }),
                        (err) => err instanceof TypeError && /^ObjectPool: "expand"/.test(err.message),
                    );
                });
            }

            test('accepts the two real booleans', () => {
                assert.doesNotThrow(() => new ObjectPool({ create: () => ({}), size: 1, expand: true }));
                assert.doesNotThrow(() => new ObjectPool({ create: () => ({}), size: 1, expand: false }));
            });

            test('expand: false exhaustion returns null, not undefined or a throw', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 1, expand: false });
                pool.acquire();
                const result = pool.acquire();
                assert.strictEqual(result, null);
                assert.notStrictEqual(result, undefined);
            });
        });

        describe('reset rejection set', () => {
            for (const bad of [5, {}, 'nope', true]) {
                test(`rejects reset: ${JSON.stringify(bad)}`, () => {
                    assert.throws(
                        () => new ObjectPool({ create: () => ({}), reset: bad }),
                        (err) => err instanceof TypeError && /^ObjectPool: "reset"/.test(err.message),
                    );
                });
            }
        });

        describe('validation order and message shape', () => {
            test('every rejection message is prefixed with the library name and the option', () => {
                const cases = [
                    [{ create: () => ({}), size: NaN }, 'size'],
                    [{ create: () => ({}), size: 1, maxSize: NaN }, 'maxSize'],
                    [{ create: () => ({}), size: 1, expand: 0 }, 'expand'],
                    [{ create: () => ({}), reset: 5 }, 'reset'],
                ];
                for (const [opts, option] of cases) {
                    let err = null;
                    try { new ObjectPool(opts); } catch (e) { err = e; }
                    assert.ok(err !== null, `${option} case did not throw`);
                    assert.strictEqual(
                        err.message.slice(0, `ObjectPool: "${option}"`.length),
                        `ObjectPool: "${option}"`,
                        `${option} message was ${JSON.stringify(err.message)}`,
                    );
                }
            });

            test('a bad size is rejected before an otherwise-contradictory maxSize is reported', () => {
                // Both size and maxSize are bad; size is checked first, so the
                // thrown message names "size", not "maxSize".
                assert.throws(
                    () => new ObjectPool({ create: () => ({}), size: NaN, maxSize: -1 }),
                    (err) => err instanceof TypeError && /^ObjectPool: "size"/.test(err.message),
                );
            });
        });
    });

    // ---------------------------------------------------------------
    //  Acquire
    // ---------------------------------------------------------------

    describe('acquire()', () => {
        test('returns an object from the pool', () => {
            const pool = createPool();
            const obj = pool.acquire();
            assert.ok('x' in obj);
            assert.ok('life' in obj);
        });

        test('decrements free count', () => {
            const pool = createPool({ size: 3 });
            assert.strictEqual(pool.free, 3);
            pool.acquire();
            assert.strictEqual(pool.free, 2);
        });

        test('increments used count', () => {
            const pool = createPool({ size: 3 });
            assert.strictEqual(pool.used, 0);
            pool.acquire();
            assert.strictEqual(pool.used, 1);
        });

        test('returns unique objects', () => {
            const pool = createPool({ size: 3 });
            const a = pool.acquire();
            const b = pool.acquire();
            assert.notStrictEqual(a, b);
        });

        test('expands when exhausted (expand=true)', () => {
            const pool = createPool({ size: 1, expand: true });
            pool.acquire(); // takes the 1 preallocated
            const extra = pool.acquire(); // should expand
            assert.notStrictEqual(extra, null);
            assert.strictEqual(pool.size, 2);
        });

        test('returns null when exhausted (expand=false)', () => {
            const pool = createPool({ size: 1, expand: false });
            pool.acquire();
            assert.strictEqual(pool.acquire(), null);
        });

        test('respects maxSize cap during expansion', () => {
            const pool = createPool({ size: 1, expand: true, maxSize: 3 });
            pool.acquire(); // 1 (preallocated)
            pool.acquire(); // 2 (expanded)
            pool.acquire(); // 3 (expanded, at cap)
            assert.strictEqual(pool.size, 3);
            assert.strictEqual(pool.acquire(), null); // at maxSize
        });

        test('defaults maxSize to Infinity', () => {
            const pool = createPool({ size: 1, expand: true });
            // Should be able to expand far beyond initial size
            for (let i = 0; i < 100; i++) pool.acquire();
            assert.strictEqual(pool.size, 100);
        });

        test('returns null after destroy', () => {
            const pool = createPool();
            pool.destroy();
            assert.strictEqual(pool.acquire(), null);
        });
    });

    // ---------------------------------------------------------------
    //  Release
    // ---------------------------------------------------------------

    describe('release()', () => {
        test('returns object to the free list', () => {
            const pool = createPool({ size: 2 });
            const obj = pool.acquire();
            assert.strictEqual(pool.free, 1);

            pool.release(obj);
            assert.strictEqual(pool.free, 2);
            assert.strictEqual(pool.used, 0);
        });

        test('calls reset() on the object', () => {
            const reset = spy();
            const pool = createPool({ reset });
            const obj = pool.acquire();
            obj.x = 100;
            obj.y = 200;

            pool.release(obj);
            assert.ok(calledWith(reset, obj));
        });

        test('resets object state for reuse', () => {
            const pool = createPool();
            const obj = pool.acquire();
            obj.x = 999;
            obj.y = 888;
            obj.life = 42;

            pool.release(obj);
            assert.strictEqual(obj.x, 0);
            assert.strictEqual(obj.y, 0);
            assert.strictEqual(obj.life, 0);
        });

        test('returns true on successful release', () => {
            const pool = createPool();
            const obj = pool.acquire();
            assert.strictEqual(pool.release(obj), true);
        });

        test('released object can be re-acquired', () => {
            const pool = createPool({ size: 1 });
            const obj = pool.acquire();
            pool.release(obj);
            const reused = pool.acquire();
            assert.strictEqual(reused, obj); // same reference
        });
    });

    // ---------------------------------------------------------------
    //  Double-Release Protection
    // ---------------------------------------------------------------

    describe('double-release protection', () => {
        test('ignores double-release (returns false)', () => {
            const pool = createPool({ size: 2 });
            const obj = pool.acquire();
            assert.strictEqual(pool.release(obj), true);
            assert.strictEqual(pool.release(obj), false); // ignored
        });

        test('does not corrupt free list on double-release', () => {
            const pool = createPool({ size: 2 });
            const obj = pool.acquire();
            pool.release(obj);
            pool.release(obj); // should be ignored

            assert.strictEqual(pool.free, 2); // not 3
        });

        test('does not call reset() on double-release', () => {
            const reset = spy();
            const pool = createPool({ reset });
            const obj = pool.acquire();
            pool.release(obj);
            reset.reset(); // mockClear equivalent

            pool.release(obj);
            assert.strictEqual(reset.calls.length, 0);
        });

        test('two acquires after double-release return different objects', () => {
            const pool = createPool({ size: 2 });
            const a = pool.acquire();
            pool.release(a);
            pool.release(a); // ignored

            const b = pool.acquire();
            const c = pool.acquire();
            assert.notStrictEqual(b, c);
        });
    });

    // ---------------------------------------------------------------
    //  Foreign Object Protection
    // ---------------------------------------------------------------

    describe('foreign object protection', () => {
        test('ignores objects not from this pool', () => {
            const pool = createPool();
            const foreign = { x: 0, y: 0 };
            assert.strictEqual(pool.release(foreign), false);
        });

        test('does not add foreign objects to free list', () => {
            const pool = createPool({ size: 2 });
            const freeBefore = pool.free;
            pool.release({ rogue: true });
            assert.strictEqual(pool.free, freeBefore);
        });
    });

    // ---------------------------------------------------------------
    //  releaseAll()
    // ---------------------------------------------------------------

    describe('releaseAll()', () => {
        test('releases all acquired objects', () => {
            const pool = createPool({ size: 4 });
            pool.acquire();
            pool.acquire();
            pool.acquire();
            assert.strictEqual(pool.used, 3);

            pool.releaseAll();
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, 4);
        });

        test('calls reset() on each released object', () => {
            const reset = spy();
            const pool = createPool({ reset, size: 3 });
            pool.acquire();
            pool.acquire();

            pool.releaseAll();
            assert.strictEqual(reset.calls.length, 2);
        });

        test('is safe to call when nothing is acquired', () => {
            const pool = createPool();
            assert.doesNotThrow(() => pool.releaseAll());
            assert.strictEqual(pool.free, 4);
        });

        test('is no-op after destroy', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            assert.doesNotThrow(() => pool.releaseAll());
        });
    });

    // ---------------------------------------------------------------
    //  forEachActive()
    // ---------------------------------------------------------------

    describe('forEachActive()', () => {
        test('iterates over all acquired objects', () => {
            const pool = createPool({ size: 4 });
            const a = pool.acquire();
            const b = pool.acquire();
            a.x = 10;
            b.x = 20;

            const visited = [];
            pool.forEachActive((obj) => visited.push(obj.x));

            assert.ok(visited.includes(10));
            assert.ok(visited.includes(20));
            assert.strictEqual(visited.length, 2);
        });

        test('skips released objects', () => {
            const pool = createPool({ size: 3 });
            const a = pool.acquire();
            const b = pool.acquire();
            pool.release(a);

            const visited = [];
            pool.forEachActive((obj) => visited.push(obj));

            assert.strictEqual(visited.length, 1);
            assert.strictEqual(visited[0], b);
        });

        test('does nothing when no objects are acquired', () => {
            const pool = createPool({ size: 3 });
            const callback = spy();
            pool.forEachActive(callback);
            assert.strictEqual(callback.calls.length, 0);
        });

        test('is no-op after destroy', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            const callback = spy();
            pool.forEachActive(callback);
            assert.strictEqual(callback.calls.length, 0);
        });

        test('works in a game loop update pattern', () => {
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
            assert.strictEqual(lives.every((l) => Math.abs(l - 0.9) < 0.001), true);
        });
    });

    // ---------------------------------------------------------------
    //  Stats
    // ---------------------------------------------------------------

    describe('stats', () => {
        test('size reflects total created objects', () => {
            const pool = createPool({ size: 4 });
            assert.strictEqual(pool.size, 4);
        });

        test('size grows on expansion', () => {
            const pool = createPool({ size: 1, expand: true });
            pool.acquire();
            pool.acquire(); // expands
            assert.strictEqual(pool.size, 2);
        });

        test('used + free = size (invariant)', () => {
            const pool = createPool({ size: 5 });
            pool.acquire();
            pool.acquire();
            assert.strictEqual(pool.used + pool.free, pool.size);
        });

        test('stats are correct through full lifecycle', () => {
            const pool = createPool({ size: 3 });
            assert.strictEqual(pool.size, 3);
            assert.strictEqual(pool.free, 3);
            assert.strictEqual(pool.used, 0);

            const a = pool.acquire();
            const b = pool.acquire();
            assert.strictEqual(pool.free, 1);
            assert.strictEqual(pool.used, 2);

            pool.release(a);
            assert.strictEqual(pool.free, 2);
            assert.strictEqual(pool.used, 1);

            pool.release(b);
            assert.strictEqual(pool.free, 3);
            assert.strictEqual(pool.used, 0);
        });
    });

    // ---------------------------------------------------------------
    //  Destroy
    // ---------------------------------------------------------------

    describe('destroy()', () => {
        test('clears the pool', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            assert.strictEqual(pool.free, 0);
            assert.strictEqual(pool.used, 0);
        });

        test('is idempotent', () => {
            const pool = createPool();
            pool.destroy();
            assert.doesNotThrow(() => pool.destroy());
        });

        test('acquire returns null after destroy', () => {
            const pool = createPool();
            pool.destroy();
            assert.strictEqual(pool.acquire(), null);
        });

        test('release returns false after destroy', () => {
            const pool = createPool();
            const obj = pool.acquire();
            pool.destroy();
            assert.strictEqual(pool.release(obj), false);
        });
    });

    // ---------------------------------------------------------------
    //  Real-World Usage Pattern
    // ---------------------------------------------------------------

    describe('usage: particle burst', () => {
        test('handles acquire -> mutate -> release -> reacquire cycle', () => {
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
            assert.strictEqual(pool.used, 50);
            assert.strictEqual(pool.free, 50);

            // Kill all particles
            for (const p of active) {
                pool.release(p);
            }
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, 100);

            // Reacquire -- objects are reused (no GC)
            const reused = pool.acquire();
            assert.strictEqual(reused.x, 0); // reset was called
            assert.strictEqual(reused.life, 0);
        });
    });
});
