/**
 * T4 -- identity and lifecycle abuse (v2.0.0, D4).
 *
 * The pool's notion of "did this object come from here" is the per-instance
 * WeakMap slot index plus the `pos < active` cross-check. This tier probes every
 * way to hand it something it never issued -- foreign objects, a same-shape
 * sibling pool's object, primitives, frozen objects, Proxies -- and asserts the
 * FAIL-CLOSED contract: a foreign object THROWS a named `ObjectPool` TypeError
 * (v1 silently returned false, OP-05). A genuine double-release still returns
 * false. Then it abuses the lifecycle: use across destroy() and post-destroy
 * calls all THROW named errors (v1 silently no-op'd, OP-11); destroy() drains
 * then tears down (OP-09) and stays idempotent.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { check } from './harness.mjs';

/** Assert `fn` throws a library `TypeError` prefixed `ObjectPool:`. */
function throwsForeign(fn, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(err !== null, () => `T4: ${label} did not throw (expected library TypeError)`);
    check(err instanceof TypeError, () => `T4: ${label} threw ${err && err.constructor.name}, expected TypeError`);
    check(err !== null && err.message.slice(0, 'ObjectPool:'.length) === 'ObjectPool:',
        () => `T4: ${label} message ${JSON.stringify(err && err.message)} not prefixed "ObjectPool:"`);
}

/** Assert `fn` throws an `ObjectPool: ...` destroyed-pool error. */
function throwsDestroyed(fn, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(err !== null, () => `T4: ${label} did not throw (expected destroyed-pool error)`);
    check(err !== null && /^ObjectPool: .*destroyed pool/.test(err.message),
        () => `T4: ${label} message ${JSON.stringify(err && err.message)} not a destroyed-pool error`);
}

export function run() {
    // --- foreign objects and non-issued handles all THROW, fail closed -----
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 4, expand: false });
        const freeBefore = pool.free;

        throwsForeign(() => pool.release({ x: 0 }), 'foreign plain object');

        // An object from a DIFFERENT pool of the same shape is foreign.
        const sibling = new ObjectPool({ create: () => ({ x: 0 }), size: 4, expand: false });
        const alien = sibling.acquire();
        throwsForeign(() => pool.release(alien), 'sibling-pool object');

        // Primitives and falsy values -- WeakMap.get returns undefined for all,
        // so they route to the foreign throw.
        throwsForeign(() => pool.release(null), 'release(null)');
        throwsForeign(() => pool.release(undefined), 'release(undefined)');
        throwsForeign(() => pool.release(0), 'release(0)');
        throwsForeign(() => pool.release(''), "release('')");
        throwsForeign(() => pool.release(NaN), 'release(NaN)');

        // Frozen object and a Proxy -- both foreign, both throw.
        throwsForeign(() => pool.release(Object.freeze({})), 'release(frozen)');
        throwsForeign(() => pool.release(new Proxy({}, {})), 'release(Proxy)');

        // A genuine double-release returns false (not a throw): the object WAS
        // issued, it is simply not currently checked out.
        const obj = pool.acquire();
        check(pool.release(obj) === true, () => `T4: first release of live object != true`);
        check(pool.release(obj) === false, () => `T4: double-release != false`);

        // None of the refused/foreign releases touched the free list beyond the
        // one legitimate acquire/release round-trip.
        check(pool.free === freeBefore,
            () => `T4: free changed ${freeBefore} -> ${pool.free} under foreign-release abuse`);
    }

    // --- sealed / preventExtensions / frozen factories all pool (D1) -------
    // WeakMap keys need not be extensible, so a non-extensible factory that v1
    // pooled fine keeps working -- this is the capability the symbol stamp would
    // have removed, preserved by the WeakMap-only mechanism.
    {
        const sealed = new ObjectPool({ create: () => Object.seal({ x: 0, y: 0 }), size: 3, reset: (o) => { o.x = 0; o.y = 0; } });
        const so = sealed.acquire();
        so.x = 9;
        check(sealed.release(so) === true, () => `T4: sealed factory release != true`);
        check(sealed.acquire().x === 0, () => `T4: sealed factory reset did not run`);

        const px = new ObjectPool({ create: () => Object.preventExtensions({ x: 0 }), size: 2, reset: () => {} });
        check(px.release(px.acquire()) === true, () => `T4: preventExtensions factory release != true`);

        const frozen = new ObjectPool({ create: () => Object.freeze({ x: 0 }), size: 2, reset: () => {} });
        check(frozen.release(frozen.acquire()) === true, () => `T4: frozen + no-op reset release != true`);
    }

    // --- use across destroy() THROWS (D4) ----------------------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2, expand: false });
        const obj = pool.acquire();
        pool.destroy();
        throwsDestroyed(() => pool.release(obj), 'release across destroy()');
        throwsDestroyed(() => pool.acquire(), 'acquire after destroy()');
    }

    // --- destroy() DRAINS then tears down (OP-09) --------------------------
    {
        let resets = 0;
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 4, reset: () => { resets++; }, expand: false });
        pool.acquire();
        pool.acquire();
        pool.destroy();
        check(resets === 2, () => `T4: destroy did not drain -- reset ran ${resets} times (expected 2)`);
        check(pool.used === 0 && pool.free === 0,
            () => `T4: after destroy used=${pool.used} free=${pool.free}`);
    }

    // --- destroy() twice is idempotent (no throw) --------------------------
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

    // --- forEachActive and releaseAll after destroy() THROW ----------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        pool.acquire();
        pool.destroy();
        throwsDestroyed(() => pool.forEachActive(() => {}), 'forEachActive after destroy');
        throwsDestroyed(() => pool.releaseAll(), 'releaseAll after destroy');
    }

    // --- forEachActive with a non-function callback (D3) -------------------
    // The callback is validated ONCE, before the loop, so the policy is the same
    // whether or not the pool holds active objects: a non-function callback is
    // always a named `ObjectPool: "callback"` TypeError, never a raw throw on a
    // non-empty pool and a silent no-op on an empty one.
    {
        for (const bad of [123, undefined, null, {}]) {
            // On an EMPTY pool.
            const empty = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
            throwsForeign(() => empty.forEachActive(bad), `forEachActive(${String(bad)}) on empty pool`);
            // And on a NON-EMPTY pool -- same answer.
            const active = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
            active.acquire();
            throwsForeign(() => active.forEachActive(bad), `forEachActive(${String(bad)}) on active pool`);
        }
        // The named message points at the "callback" parameter specifically.
        const p = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        let err = null;
        try { p.forEachActive(123); } catch (e) { err = e; }
        check(err !== null && /^ObjectPool: "callback"/.test(err.message),
            () => `T4: forEachActive(non-fn) message ${JSON.stringify(err && err.message)} does not name "callback"`);
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

    // --- thisArg is bound as the callback receiver (D3) --------------------
    {
        const pool = new ObjectPool({ create: () => ({ x: 0 }), size: 2 });
        pool.acquire();
        const receiver = { seen: 0 };
        pool.forEachActive(function () { this.seen++; }, receiver);
        check(receiver.seen === 1, () => `T4: thisArg not bound (seen=${receiver.seen})`);
    }
}
