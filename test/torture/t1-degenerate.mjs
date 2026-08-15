/**
 * T1 -- degenerate constructor options.
 *
 * Crosses every ugly option value and PINS the actual v1.0.2 behaviour, warts
 * and all. This tier documents the current truth so P1 can change the pins on
 * purpose rather than by accident. The raw `RangeError: Invalid array length`
 * is the CORRECT pin today -- it is what `new Array(size)` throws for a bad
 * size, and pinning it proves P1's validation actually replaced it.
 *
 * Nothing here is "expected" in the sense of desirable. It is expected in the
 * sense of measured. Do not fix; pin.
 */

import { ObjectPool } from '../../ObjectPool.js';
import { check } from './harness.mjs';

/** Assert `fn` throws an error whose constructor name is `name`. */
function throws(fn, name, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(err !== null, () => `T1: ${label} did not throw (expected ${name})`);
    check(err.constructor.name === name,
        () => `T1: ${label} threw ${err.constructor.name}, expected ${name}`);
}

const c = () => ({});

export function run() {
    // --- size ---------------------------------------------------------------
    // 0 and -0 build an empty pool.
    check(new ObjectPool({ create: c, size: 0 }).size === 0, () => `T1: size:0 -> size != 0`);
    check(new ObjectPool({ create: c, size: 0 }).free === 0, () => `T1: size:0 -> free != 0`);
    check(new ObjectPool({ create: c, size: -0 }).size === 0, () => `T1: size:-0 -> size != 0`);

    // Negative, fractional, NaN and Infinity all reach `new Array(size)` and
    // throw a raw RangeError -- the honest v1.0.2 pin.
    throws(() => new ObjectPool({ create: c, size: -1 }), 'RangeError', 'size:-1');
    throws(() => new ObjectPool({ create: c, size: 2.5 }), 'RangeError', 'size:2.5');
    throws(() => new ObjectPool({ create: c, size: NaN }), 'RangeError', 'size:NaN');
    throws(() => new ObjectPool({ create: c, size: Infinity }), 'RangeError', 'size:Infinity');

    // '32' is never coerced: `_totalCreated` keeps the STRING, but the prealloc
    // loop's `i < '32'` coerces per-iteration and fills 32 slots.
    const s32 = new ObjectPool({ create: c, size: '32' });
    check(s32.size === '32', () => `T1: size:'32' -> size ${String(s32.size)} (expected string '32')`);
    check(s32.free === 32, () => `T1: size:'32' -> free ${s32.free} (expected 32)`);

    // null: `new Array(null)` is `[null]` (length 1) and the loop `i < null`
    // never runs, so `size` reports the raw null and `free` is 1.
    const sNull = new ObjectPool({ create: c, size: null });
    check(sNull.size === null, () => `T1: size:null -> size ${String(sNull.size)} (expected null)`);
    check(sNull.free === 1, () => `T1: size:null -> free ${sNull.free} (expected 1)`);

    // --- maxSize ------------------------------------------------------------
    // maxSize:0 does NOT stop prealloc (OP-02) and does NOT stop acquire while
    // the free list is non-empty -- the first acquire pops a preallocated slot.
    const m0 = new ObjectPool({ create: c, size: 32, maxSize: 0 });
    check(m0.size === 32, () => `T1: maxSize:0 -> size ${m0.size} (expected 32; not a cap)`);
    check(m0.acquire() !== null, () => `T1: maxSize:0 -> first acquire returned null`);

    // maxSize:-1 -- the single preallocated slot is handed out, then expansion
    // is refused (`_totalCreated < -1` is false).
    const mNeg = new ObjectPool({ create: c, size: 1, maxSize: -1 });
    check(mNeg.acquire() !== null, () => `T1: maxSize:-1 -> first acquire null`);
    check(mNeg.acquire() === null, () => `T1: maxSize:-1 -> expansion not refused`);

    // maxSize:NaN -- any `< NaN` comparison is false, so expansion is refused.
    const mNaN = new ObjectPool({ create: c, size: 1, maxSize: NaN });
    check(mNaN.acquire() !== null, () => `T1: maxSize:NaN -> first acquire null`);
    check(mNaN.acquire() === null, () => `T1: maxSize:NaN -> expanded past NaN`);

    // maxSize:Infinity (the default) -- expansion always allowed.
    const mInf = new ObjectPool({ create: c, size: 1, maxSize: Infinity });
    check(mInf.acquire() !== null, () => `T1: maxSize:Infinity -> first acquire null`);
    check(mInf.acquire() !== null, () => `T1: maxSize:Infinity -> expansion refused`);
    check(mInf.size === 2, () => `T1: maxSize:Infinity -> size ${mInf.size} (expected 2)`);

    // maxSize below size: OP-02 again -- prealloc ignores the cap entirely.
    const mBelow = new ObjectPool({ create: c, size: 10, maxSize: 4 });
    check(mBelow.size === 10, () => `T1: maxSize<size -> size ${mBelow.size} (expected 10; OP-02)`);
    check(mBelow.free === 10, () => `T1: maxSize<size -> free ${mBelow.free} (expected 10)`);

    // --- expand -------------------------------------------------------------
    // Falsy expand values all disable expansion: acquire past capacity is null.
    for (const [label, val] of [['0', 0], ["''", ''], ['null', null]]) {
        const p = new ObjectPool({ create: c, size: 1, expand: val });
        p.acquire();
        check(p.acquire() === null, () => `T1: expand:${label} -> did not disable expansion`);
    }

    // --- create return values -----------------------------------------------
    // create -> null: the pool cheerfully pools `null`; acquire hands it back
    // and used still increments (it is a real Set member).
    const cNull = new ObjectPool({ create: () => null, size: 2 });
    check(cNull.size === 2, () => `T1: create->null -> size ${cNull.size}`);
    check(cNull.acquire() === null, () => `T1: create->null -> acquire not null`);
    check(cNull.used === 1, () => `T1: create->null -> used ${cNull.used} (expected 1)`);

    // create -> undefined: acquire returns undefined, used increments.
    const cUndef = new ObjectPool({ create: () => undefined, size: 2 });
    check(cUndef.acquire() === undefined, () => `T1: create->undefined -> acquire not undefined`);
    check(cUndef.used === 1, () => `T1: create->undefined -> used ${cUndef.used}`);

    // create -> primitive: acquire returns the primitive; release via the Set
    // guard still works (Set membership is by value for primitives).
    const cPrim = new ObjectPool({ create: () => 5, size: 2 });
    const prim = cPrim.acquire();
    check(prim === 5, () => `T1: create->primitive -> acquire ${String(prim)} (expected 5)`);
    check(cPrim.used === 1, () => `T1: create->primitive -> used ${cPrim.used}`);
    // Capture the result BEFORE asserting: calling release() again inside the
    // message thunk would report the value of a SECOND, double-release call,
    // i.e. the failure message would print `false` for a `true` that failed.
    const primReleased = cPrim.release(prim);
    check(primReleased === true, () => `T1: create->primitive -> release ${primReleased}`);

    // create -> THE SAME OBJECT every call: the free list holds N refs to one
    // object, but the `_out` Set collapses them to a single member, so `used`
    // can never exceed 1 no matter how many are acquired.
    const same = {};
    const cSame = new ObjectPool({ create: () => same, size: 3 });
    check(cSame.size === 3, () => `T1: create->same -> size ${cSame.size}`);
    check(cSame.free === 3, () => `T1: create->same -> free ${cSame.free}`);
    check(cSame.acquire() === same, () => `T1: create->same -> acquire not the shared object`);
    check(cSame.used === 1, () => `T1: create->same -> used ${cSame.used} (expected 1)`);
    cSame.acquire(); // second acquire re-adds the same Set member -- no-op
    check(cSame.used === 1, () => `T1: create->same -> used grew past 1 to ${cSame.used}`);

    // --- reset that throws --------------------------------------------------
    // release() deletes from `_out` BEFORE calling reset(); when reset throws,
    // the object is neither in `_out` nor pushed to `_free` -- it is LOST.
    // used=0 and free=0 is the honest (buggy) pin. P1 owns this.
    const cThrow = new ObjectPool({
        create: c,
        reset: () => { throw new Error('boom'); },
        size: 1,
    });
    const t = cThrow.acquire();
    throws(() => cThrow.release(t), 'Error', 'reset-throws release');
    check(cThrow.used === 0, () => `T1: reset-throws -> used ${cThrow.used} (expected 0; object dropped from _out)`);
    check(cThrow.free === 0, () => `T1: reset-throws -> free ${cThrow.free} (expected 0; object lost, not re-pooled)`);
}
