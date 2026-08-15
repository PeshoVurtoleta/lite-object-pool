/**
 * T4 -- identity and lifecycle abuse.
 *
 * The `_out` Set is the pool's sole notion of "did this object come from here".
 * This tier probes every way to hand it something it never issued -- foreign
 * objects, objects from a same-shape sibling pool, primitives, frozen objects,
 * Proxies, already-released handles -- and asserts the O(1) guard fails closed
 * (release returns false, nothing enters the free list). Then it abuses the
 * lifecycle: use across destroy(), double destroy(), and post-destroy
 * forEachActive / releaseAll, plus forEachActive with a non-function and a
 * throwing callback.
 *
 * Every outcome here is a PIN of v1.0.2 truth, not a wish.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { check } from './harness.mjs';

export function run() {
    // --- foreign objects and non-issued handles all fail closed ------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 4, expand: false });
        const freeBefore = pool.free;

        // A plain foreign object.
        check(pool.release({ x: 0 }) === false, () => `T4: foreign object release != false`);

        // An object from a DIFFERENT pool of the same shape.
        const sibling = new ObjectPool({ create: () => ({ x: 0 }), size: 4, expand: false });
        const alien = sibling.acquire();
        check(pool.release(alien) === false, () => `T4: sibling-pool object release != false`);

        // Primitives and falsy values.
        check(pool.release(null) === false, () => `T4: release(null) != false`);
        check(pool.release(undefined) === false, () => `T4: release(undefined) != false`);
        check(pool.release(0) === false, () => `T4: release(0) != false`);
        check(pool.release('') === false, () => `T4: release('') != false`);
        check(pool.release(NaN) === false, () => `T4: release(NaN) != false`);

        // Frozen object and a Proxy -- both foreign, both refused.
        check(pool.release(Object.freeze({})) === false, () => `T4: release(frozen) != false`);
        check(pool.release(new Proxy({}, {})) === false, () => `T4: release(Proxy) != false`);

        // Already-released: acquire, release once (true), release again (false).
        const obj = pool.acquire();
        check(pool.release(obj) === true, () => `T4: first release of live object != true`);
        check(pool.release(obj) === false, () => `T4: already-released object release != false`);

        // None of the refused releases touched the free list beyond the one
        // legitimate acquire/release round-trip.
        check(pool.free === freeBefore,
            () => `T4: free changed ${freeBefore} -> ${pool.free} under foreign-release abuse`);
    }

    // --- acquire + release across destroy() --------------------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2, expand: false });
        const obj = pool.acquire();
        pool.destroy();
        check(pool.release(obj) === false, () => `T4: release across destroy() != false`);
        check(pool.acquire() === null, () => `T4: acquire after destroy() != null`);
    }

    // --- destroy() twice is idempotent -------------------------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        pool.acquire();
        pool.destroy();
        let threw = false;
        try { pool.destroy(); } catch { threw = true; }
        check(!threw, () => `T4: second destroy() threw`);
        check(pool.used === 0 && pool.free === 0,
            () => `T4: after double destroy used=${pool.used} free=${pool.free}`);
    }

    // --- forEachActive and releaseAll after destroy() ----------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        pool.acquire();
        pool.destroy();
        let visits = 0;
        pool.forEachActive(() => { visits++; });
        check(visits === 0, () => `T4: forEachActive after destroy made ${visits} visits`);
        let threw = false;
        try { pool.releaseAll(); } catch { threw = true; }
        check(!threw, () => `T4: releaseAll after destroy threw`);
    }

    // --- WHICH post-destroy guard is actually load-bearing ------------------
    //
    // Mutation-tested, not assumed. `destroy()` clears `_out` and `_free`
    // BEFORE any later call can observe them, so the `if (this._destroyed)`
    // guards in release / releaseAll / forEachActive are unreachable as
    // behaviour: strip all three and every case above still passes, along with
    // the whole unit suite. Verified by deleting them and re-running -- 60/60
    // green. Those three guards are defensive redundancy, not tested logic,
    // and the cases above pin the post-destroy CONTRACT rather than the guard.
    //
    // `acquire()`'s guard is different and IS load-bearing: `destroy()` nulls
    // `_create`, so without the guard an acquire on a destroyed pool calls
    // `null()` and throws TypeError instead of returning null. Verified the
    // same way. That is the one this case defends, and it is written to fail
    // if the guard is removed rather than to restate the case above it.
    //
    // Recorded because "we have a test for post-destroy" would otherwise read
    // as "the guards are covered". Three of the four are not, and the honest
    // version of that sentence belongs next to the tests, not in a review
    // comment nobody reads again.
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        pool.acquire();
        pool.destroy();
        // The distinguishing assertion: a RETURN of null, not a throw. Removing
        // acquire's guard turns this from null into a TypeError.
        let threw = null;
        let result;
        try { result = pool.acquire(); } catch (e) { threw = e; }
        check(threw === null,
            () => `T4: acquire after destroy threw ${threw && threw.constructor.name} ` +
                `instead of returning null -- the _destroyed guard in acquire() is gone`);
        check(result === null,
            () => `T4: acquire after destroy returned ${String(result)} (expected null)`);
    }

    // --- forEachActive with a non-function callback ------------------------
    {
        // With NO active objects the loop never runs, so a bad callback is
        // never invoked and nothing throws -- pin that.
        const empty = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        let threwEmpty = false;
        try { empty.forEachActive(123); } catch { threwEmpty = true; }
        check(!threwEmpty, () => `T4: forEachActive(non-fn) on empty pool threw`);

        // With an active object the invocation is attempted and TypeError
        // escapes -- v1.0.2 does not guard the callback type.
        const active = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        active.acquire();
        let err = null;
        try { active.forEachActive(123); } catch (e) { err = e; }
        check(err !== null, () => `T4: forEachActive(non-fn) with active object did not throw`);
        check(err.constructor.name === 'TypeError',
            () => `T4: forEachActive(non-fn) threw ${err.constructor.name}, expected TypeError`);
    }

    // --- forEachActive with a callback that throws -------------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        pool.acquire();
        let err = null;
        try { pool.forEachActive(() => { throw new Error('cb boom'); }); } catch (e) { err = e; }
        check(err !== null, () => `T4: throwing forEachActive callback was swallowed`);
        check(err.message === 'cb boom', () => `T4: unexpected error from throwing callback: ${err.message}`);
    }
}
