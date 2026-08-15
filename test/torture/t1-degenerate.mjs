/**
 * T1 -- degenerate constructor options.
 *
 * Crosses every ugly option value and PINS the actual v1.1.0 behaviour. As of
 * P1 the constructor validates all six options and throws a library `TypeError`
 * naming the offending option -- every message is prefixed `ObjectPool: "<opt>"`
 * so it is greppable and names both the library and the option. This tier is the
 * regression that proves that validation replaced the raw `RangeError: Invalid
 * array length` that `new Array(size)` used to throw for a bad size, and that
 * the falsy `expand` coercion hole is closed.
 *
 * Two size values remain a raw `RangeError`: `2**32` and `MAX_SAFE_INTEGER` are
 * legitimate finite integers >= 0 and PASS validation, but exceed the JS array
 * length limit (2**32 - 1), so `new Array(size)` rejects them. That is the
 * honest, measured pin -- validation does not (and per the P1 brief must not)
 * add a `<= 2**32-1` clause; it validates "finite integer >= 0".
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

/**
 * Assert `fn` throws a library `TypeError` whose message is prefixed
 * `ObjectPool: "<option>"` -- i.e. it names both the library and the option.
 */
function throwsLib(fn, option, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(err !== null, () => `T1: ${label} did not throw (expected library TypeError)`);
    check(err instanceof TypeError,
        () => `T1: ${label} threw ${err && err.constructor.name}, expected TypeError`);
    const prefix = 'ObjectPool: "' + option + '"';
    check(err !== null && err.message.slice(0, prefix.length) === prefix,
        () => `T1: ${label} message ${JSON.stringify(err && err.message)} is not prefixed ${JSON.stringify(prefix)}`);
}

const c = () => ({});

/**
 * Assert `fn` throws a library `TypeError` whose message is prefixed
 * `ObjectPool: create(` -- the fail-closed create()-return-value contract (D1).
 */
function throwsCreate(fn, label) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    check(err !== null, () => `T1: ${label} did not throw (expected library TypeError)`);
    check(err instanceof TypeError, () => `T1: ${label} threw ${err && err.constructor.name}, expected TypeError`);
    check(err !== null && err.message.slice(0, 'ObjectPool: create('.length) === 'ObjectPool: create(',
        () => `T1: ${label} message ${JSON.stringify(err && err.message)} not prefixed "ObjectPool: create("`);
}

export function run() {
    // --- size ---------------------------------------------------------------
    // 0 and -0 build an empty pool; _totalCreated reflects 0 objects created.
    check(new ObjectPool({ create: c, size: 0 }).size === 0, () => `T1: size:0 -> size != 0`);
    check(new ObjectPool({ create: c, size: 0 }).free === 0, () => `T1: size:0 -> free != 0`);
    check(new ObjectPool({ create: c, size: -0 }).size === 0, () => `T1: size:-0 -> size != 0`);

    // undefined falls through to the `size = 32` default and builds 32.
    const sUndef = new ObjectPool({ create: c, size: undefined });
    check(sUndef.size === 32, () => `T1: size:undefined -> size ${sUndef.size} (expected default 32)`);
    check(sUndef.free === 32, () => `T1: size:undefined -> free ${sUndef.free} (expected 32)`);

    // Negative, fractional, NaN, Infinity, the string '32' and null are all
    // rejected by validation with a library TypeError naming "size" -- never the
    // raw `RangeError: Invalid array length` that reached here in <= 1.0.3.
    throwsLib(() => new ObjectPool({ create: c, size: -1 }), 'size', 'size:-1');
    throwsLib(() => new ObjectPool({ create: c, size: 2.5 }), 'size', 'size:2.5');
    throwsLib(() => new ObjectPool({ create: c, size: NaN }), 'size', 'size:NaN');
    throwsLib(() => new ObjectPool({ create: c, size: Infinity }), 'size', 'size:Infinity');
    throwsLib(() => new ObjectPool({ create: c, size: '32' }), 'size', "size:'32'");
    throwsLib(() => new ObjectPool({ create: c, size: null }), 'size', 'size:null');

    // 2**32 and MAX_SAFE_INTEGER pass validation (legitimate finite integers)
    // but exceed the JS array-length limit, so `new Array(size)` throws a raw
    // RangeError. Validation deliberately does not police the array limit.
    throws(() => new ObjectPool({ create: c, size: 2 ** 32 }), 'RangeError', 'size:2**32');
    throws(() => new ObjectPool({ create: c, size: Number.MAX_SAFE_INTEGER }), 'RangeError', 'size:MAX_SAFE_INTEGER');

    // --- maxSize ------------------------------------------------------------
    // maxSize:0 is a valid integer, but with the default size 32 it contradicts
    // size and is rejected by the contradiction check naming "maxSize". A throw
    // after preallocating 32 objects would not be a fix, so also assert the
    // create callback never ran.
    let created = 0;
    const countingCreate = () => { created++; return {}; };
    throwsLib(() => new ObjectPool({ create: countingCreate, size: 32, maxSize: 0 }), 'maxSize', 'size:32,maxSize:0');
    check(created === 0, () => `T1: size:32,maxSize:0 threw AFTER creating ${created} objects (expected 0)`);

    // maxSize:0 paired with size:0 is consistent and builds an empty pool that
    // refuses to expand.
    const m00 = new ObjectPool({ create: c, size: 0, maxSize: 0 });
    check(m00.size === 0, () => `T1: size:0,maxSize:0 -> size ${m00.size} (expected 0)`);
    check(m00.acquire() === null, () => `T1: size:0,maxSize:0 -> acquire not null`);

    // maxSize:-1 is a negative integer -> rejected by maxSize validation before
    // the contradiction check even runs.
    throwsLib(() => new ObjectPool({ create: c, size: 1, maxSize: -1 }), 'maxSize', 'maxSize:-1');

    // maxSize:NaN is not an integer and not Infinity -> rejected naming maxSize.
    throwsLib(() => new ObjectPool({ create: c, size: 1, maxSize: NaN }), 'maxSize', 'maxSize:NaN');

    // maxSize:Infinity (the default) is accepted; expansion is unbounded and,
    // in v2, chunked -- the first miss grows a bounded contiguous run, so size
    // jumps past 2 but the pool keeps serving.
    const mInf = new ObjectPool({ create: c, size: 1, maxSize: Infinity });
    check(mInf.acquire() !== null, () => `T1: maxSize:Infinity -> first acquire null`);
    check(mInf.acquire() !== null, () => `T1: maxSize:Infinity -> expansion refused`);
    check(mInf.size > 1, () => `T1: maxSize:Infinity -> size ${mInf.size} did not grow`);

    // Every maxSize strictly below size is a contradiction and throws naming
    // maxSize -- the OP-02 fix. Nothing is preallocated first.
    for (let below = 0; below < 5; below++) {
        let n = 0;
        const cc = () => { n++; return {}; };
        throwsLib(() => new ObjectPool({ create: cc, size: 5, maxSize: below }), 'maxSize', `size:5,maxSize:${below}`);
        check(n === 0, () => `T1: size:5,maxSize:${below} created ${n} objects before throwing (expected 0)`);
    }

    // maxSize >= size is accepted; size <= maxSize holds.
    const mOk = new ObjectPool({ create: c, size: 4, maxSize: 10 });
    check(mOk.size === 4, () => `T1: size:4,maxSize:10 -> size ${mOk.size} (expected 4)`);
    check(mOk.free === 4, () => `T1: size:4,maxSize:10 -> free ${mOk.free} (expected 4)`);

    // --- expand -------------------------------------------------------------
    // As of P1 `expand` is a STRICT boolean. The falsy coercions that quietly
    // disabled expansion in <= 1.0.3 (0, '', null) now throw naming "expand",
    // and so do the truthy non-booleans (1, 'false') -- the latter is the sharp
    // one: `expand: 'false'` is truthy and used to expand forever silently.
    throwsLib(() => new ObjectPool({ create: c, size: 1, expand: 0 }), 'expand', 'expand:0');
    throwsLib(() => new ObjectPool({ create: c, size: 1, expand: '' }), 'expand', "expand:''");
    throwsLib(() => new ObjectPool({ create: c, size: 1, expand: null }), 'expand', 'expand:null');
    throwsLib(() => new ObjectPool({ create: c, size: 1, expand: 1 }), 'expand', 'expand:1');
    throwsLib(() => new ObjectPool({ create: c, size: 1, expand: 'false' }), 'expand', "expand:'false'");

    // The two real booleans, and the undefined default, are accepted.
    const eFalse = new ObjectPool({ create: c, size: 1, expand: false });
    eFalse.acquire();
    check(eFalse.acquire() === null, () => `T1: expand:false -> did not disable expansion`);
    const eTrue = new ObjectPool({ create: c, size: 1, expand: true });
    eTrue.acquire();
    check(eTrue.acquire() !== null, () => `T1: expand:true -> did not expand`);

    // --- reset --------------------------------------------------------------
    // reset must be a function if provided; a non-function is rejected naming
    // "reset".
    throwsLib(() => new ObjectPool({ create: c, reset: 5 }), 'reset', 'reset:5');
    throwsLib(() => new ObjectPool({ create: c, reset: {} }), 'reset', 'reset:{}');

    // --- create return values (v2.0.0, D1) ----------------------------------
    // The sparse set tracks each object by identity in a WeakMap, whose keys
    // must be distinct objects. A create() that returns a non-object or a
    // duplicate identity is a fail-closed error at the point of creation
    // (naming the library), not silent pooling of null/duplicates as in v1.

    // create -> null / undefined / primitive: rejected at construction with a
    // library `TypeError` naming create(), never pooled.
    throwsCreate(() => new ObjectPool({ create: () => null, size: 2 }), 'create->null');
    throwsCreate(() => new ObjectPool({ create: () => undefined, size: 2 }), 'create->undefined');
    throwsCreate(() => new ObjectPool({ create: () => 5, size: 2 }), 'create->primitive');

    // create -> a function is a valid object identity (WeakMap accepts it).
    const cFn = new ObjectPool({ create: () => () => {}, size: 2 });
    check(cFn.size === 2, () => `T1: create->function -> size ${cFn.size}`);
    check(typeof cFn.acquire() === 'function', () => `T1: create->function -> acquire not a function`);

    // create -> THE SAME OBJECT every call: the second creation is a duplicate
    // identity and is rejected at construction (each pooled object must be
    // distinct), rather than v1's silent collapse to a single Set member.
    const same = {};
    throwsCreate(() => new ObjectPool({ create: () => same, size: 3 }), 'create->same');
    // size:1 needs only one creation, so the same-object pool is legal there.
    const cSame1 = new ObjectPool({ create: () => same, size: 1 });
    check(cSame1.acquire() === same, () => `T1: create->same size:1 -> acquire not the shared object`);

    // --- reset behaviour ----------------------------------------------------
    // reset that throws: release() swap-removes the object BEFORE calling reset,
    // so when reset throws the object is already back in the free region -- it
    // is re-poolable, NOT lost. used=0, free=1 is the v2 pin (v1 lost it: free=0).
    const cThrow = new ObjectPool({
        create: c,
        reset: () => { throw new Error('boom'); },
        size: 1,
    });
    const t = cThrow.acquire();
    throws(() => cThrow.release(t), 'Error', 'reset-throws release');
    check(cThrow.used === 0, () => `T1: reset-throws -> used ${cThrow.used} (expected 0)`);
    check(cThrow.free === 1, () => `T1: reset-throws -> free ${cThrow.free} (expected 1; swap-removed before reset, re-poolable)`);

    // reset that RETURNS a value: the return value is ignored; release() still
    // reports true and re-pools the object.
    const cRet = new ObjectPool({ create: c, reset: () => 42, size: 1 });
    const r = cRet.acquire();
    const retReleased = cRet.release(r);
    check(retReleased === true, () => `T1: reset-returns-value -> release ${retReleased} (expected true)`);
    check(cRet.free === 1, () => `T1: reset-returns-value -> free ${cRet.free} (expected 1)`);

    // reset that RE-ENTRANTLY releases another live object: Set.delete is
    // immediate, so a nested release() sees a consistent `_out` and both objects
    // return to the free list. used=0, free=2 is the honest pin.
    let sibling = null;
    let reentered = false;
    const cReentrant = new ObjectPool({
        create: c,
        size: 2,
        reset: () => {
            if (sibling !== null && !reentered) {
                reentered = true;
                cReentrant.release(sibling);
            }
        },
    });
    const ra = cReentrant.acquire();
    const rb = cReentrant.acquire();
    sibling = rb;
    check(cReentrant.release(ra) === true, () => `T1: reentrant-reset -> outer release not true`);
    check(cReentrant.used === 0, () => `T1: reentrant-reset -> used ${cReentrant.used} (expected 0)`);
    check(cReentrant.free === 2, () => `T1: reentrant-reset -> free ${cReentrant.free} (expected 2)`);
}
