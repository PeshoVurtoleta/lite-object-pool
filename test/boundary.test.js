/**
 * @zakkster/lite-object-pool -- boundary matrix for the 2.1.0 option surface (P2b QA).
 *
 * ObjectPool.test.js already covers alias equivalence, the three conflict
 * throws, and the {prealloc:"eager", capacity:Infinity} trap. This file goes
 * after what that table does NOT cover: numeric boundary values (0, 1, N-1, N,
 * N+1, empty, null, undefined, NaN, -0) crossed against every new entry point,
 * the prealloc-spelling equivalence (integer vs "eager" vs "lazy"), the
 * onExhausted:"null" vs expand:false equivalence beyond a single snapshot, the
 * canonical-spelling chunk-boundary walk (2.0.0's QA found bugs at
 * 255/256/257), duplicate dispose, dispose-during-iteration, a self re-entrant
 * double-release, and a TOCTOU probe via a lying options getter.
 *
 * node:test only. No import outside ObjectPool.js, ObjectPool-2.0.0.js (the
 * frozen fixture already vendored under test/baseline/), and node:test/assert.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectPool } from '../ObjectPool.js';
import { ObjectPool as FrozenPool } from './baseline/ObjectPool-2.0.0.js';

const cr = () => ({});

function throwsNamed(fn, option) {
    let err = null;
    try { fn(); } catch (e) { err = e; }
    assert.ok(err instanceof TypeError, `expected a TypeError, got ${err && err.constructor.name}`);
    assert.match(err.message, new RegExp('^ObjectPool: "' + option + '"'));
    return err;
}

describe('boundary: prealloc as an integer count against capacity', () => {
    // 0, 1, N-1, N, N+1 for capacity=10.
    const CAP = 10;
    for (const prealloc of [0, 1, CAP - 1, CAP, CAP + 1]) {
        test(`prealloc=${prealloc} against capacity=${CAP}`, () => {
            if (prealloc > CAP) {
                throwsNamed(() => new ObjectPool({ create: cr, capacity: CAP, prealloc, onExhausted: 'null' }), 'capacity');
                return;
            }
            const p = new ObjectPool({ create: cr, capacity: CAP, prealloc, onExhausted: 'null' });
            assert.strictEqual(p.size, prealloc);
            assert.strictEqual(p.used, 0);
            assert.strictEqual(p.free, prealloc);
        });
    }
});

describe('boundary: prealloc spelling equivalence (integer vs "eager" vs "lazy")', () => {
    test('prealloc:"eager" === prealloc:capacity (integer) at capacity=10', () => {
        const eager = new ObjectPool({ create: cr, capacity: 10, prealloc: 'eager', onExhausted: 'null' });
        const intEq = new ObjectPool({ create: cr, capacity: 10, prealloc: 10, onExhausted: 'null' });
        assert.strictEqual(eager.size, intEq.size);
        assert.strictEqual(eager.size, 10);
    });

    test('prealloc:"lazy" === prealloc:0', () => {
        const lazy = new ObjectPool({ create: cr, capacity: 10, prealloc: 'lazy', onExhausted: 'null' });
        const zero = new ObjectPool({ create: cr, capacity: 10, prealloc: 0, onExhausted: 'null' });
        assert.strictEqual(lazy.size, 0);
        assert.strictEqual(zero.size, 0);
    });

    test('prealloc:"eager" requires a finite capacity; prealloc:capacity (integer) does not', () => {
        throwsNamed(() => new ObjectPool({ create: cr, prealloc: 'eager' }), 'prealloc');
        // The integer spelling of "build everything" has no such restriction when
        // capacity is also finite; only the string form is coupled to Infinity.
        assert.doesNotThrow(() => new ObjectPool({ create: cr, capacity: 5, prealloc: 5 }));
    });
});

describe('boundary: capacity: 0', () => {
    test('capacity:0, prealloc:0 (or default-absent under legacy) builds an empty, inert pool', () => {
        const p = new ObjectPool({ create: cr, capacity: 0, prealloc: 0, onExhausted: 'null' });
        assert.strictEqual(p.size, 0);
        assert.strictEqual(p.acquire(), null);
    });

    test('capacity:0 with the default prealloc (32) throws (32 > 0)', () => {
        throwsNamed(() => new ObjectPool({ create: cr, capacity: 0 }), 'capacity');
    });

    test('legacy twin: maxSize:0, size:0 also builds an empty, inert pool', () => {
        const p = new ObjectPool({ create: cr, maxSize: 0, size: 0, expand: false });
        assert.strictEqual(p.size, 0);
        assert.strictEqual(p.acquire(), null);
    });

    test('capacity:0 under onExhausted:"grow" still never grows (0 room) and returns null', () => {
        const p = new ObjectPool({ create: cr, capacity: 0, prealloc: 0, onExhausted: 'grow' });
        assert.strictEqual(p.acquire(), null);
    });

    test('capacity:0 under onExhausted:"throw" throws the capped message immediately', () => {
        const p = new ObjectPool({ create: cr, capacity: 0, prealloc: 0, onExhausted: 'throw' });
        assert.throws(() => p.acquire(), /exceeded capacity 0/);
    });
});

describe('boundary: onExhausted:"null" vs legacy expand:false, full drain + past-drain matrix', () => {
    // Not just "both construct" -- walk N-1, N, N+1 acquires and compare the
    // OBSERVABLE {size,used,free,acquire-result} sequence, not merely equal state.
    const CAP = 6;
    function drive(pool, n) {
        const log = [];
        for (let i = 0; i < n; i++) {
            const r = pool.acquire();
            log.push((r === null ? 'null' : 'obj') + ':' + pool.size + ',' + pool.used + ',' + pool.free);
        }
        return log.join('|');
    }
    for (const n of [CAP - 1, CAP, CAP + 1]) {
        test(`${n} acquires: onExhausted:"null" trace === expand:false trace`, () => {
            const canon = new ObjectPool({ create: cr, capacity: CAP, prealloc: CAP, onExhausted: 'null' });
            const legacy = new ObjectPool({ create: cr, maxSize: CAP, size: CAP, expand: false });
            assert.strictEqual(drive(canon, n), drive(legacy, n));
        });
    }
});

describe('boundary: canonical + canonical internal contradictions', () => {
    // capacity < prealloc at the boundary (off-by-one) and equal (must NOT throw).
    test('capacity === prealloc does not throw (boundary, not a contradiction)', () => {
        assert.doesNotThrow(() => new ObjectPool({ create: cr, capacity: 4, prealloc: 4 }));
    });
    test('capacity === prealloc - 1 throws naming both', () => {
        throwsNamed(() => new ObjectPool({ create: cr, capacity: 3, prealloc: 4 }), 'capacity');
    });
    test('capacity:Infinity, prealloc:Infinity (as an integer, not "eager") throws on prealloc, not capacity', () => {
        // Infinity is not a finite integer, so this must fail the prealloc check,
        // not silently pass through as if it meant "eager".
        const err = (() => { try { new ObjectPool({ create: cr, capacity: Infinity, prealloc: Infinity }); } catch (e) { return e; } return null; })();
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /^ObjectPool: "prealloc"/);
    });
});

describe('boundary: fractional / negative / NaN / Infinity / -0 for every canonical numeric', () => {
    const BAD_CAPACITY = [2.5, -1, -2.5, NaN, -Infinity];
    for (const v of BAD_CAPACITY) {
        test(`capacity:${v} throws by name`, () => {
            throwsNamed(() => new ObjectPool({ create: cr, capacity: v, prealloc: 0 }), 'capacity');
        });
    }
    const BAD_PREALLOC = [2.5, -1, -2.5, NaN, Infinity];
    for (const v of BAD_PREALLOC) {
        test(`prealloc:${v} throws by name`, () => {
            throwsNamed(() => new ObjectPool({ create: cr, prealloc: v }), 'prealloc');
        });
    }
    test('capacity:-0 is accepted and behaves exactly like capacity:0', () => {
        const neg = new ObjectPool({ create: cr, capacity: -0, prealloc: 0, onExhausted: 'null' });
        const pos = new ObjectPool({ create: cr, capacity: 0, prealloc: 0, onExhausted: 'null' });
        assert.strictEqual(neg.size, pos.size);
        assert.strictEqual(neg.acquire(), pos.acquire());
    });
    test('prealloc:-0 is accepted and behaves exactly like prealloc:0', () => {
        const neg = new ObjectPool({ create: cr, capacity: 4, prealloc: -0, onExhausted: 'null' });
        const pos = new ObjectPool({ create: cr, capacity: 4, prealloc: 0, onExhausted: 'null' });
        assert.strictEqual(neg.size, pos.size);
    });
    test('capacity as a numeric string throws (typeof check, no coercion)', () => {
        throwsNamed(() => new ObjectPool({ create: cr, capacity: '10' }), 'capacity');
    });
    test('prealloc as a boolean throws (not treated as 0/1)', () => {
        throwsNamed(() => new ObjectPool({ create: cr, prealloc: true }), 'prealloc');
        throwsNamed(() => new ObjectPool({ create: cr, prealloc: false }), 'prealloc');
    });
});

describe('boundary: onExhausted with a bogus value', () => {
    const BAD = ['GROW', 'Null', 'THROW', '', ' grow', 1, 0, true, false, null, {}, [], Symbol('x')];
    for (const v of BAD) {
        test(`onExhausted:${String(v)} (${typeof v}) throws by name`, () => {
            throwsNamed(() => new ObjectPool({ create: cr, onExhausted: v }), 'onExhausted');
        });
    }
    test('onExhausted:undefined (explicit) is ABSENT, not a bogus value -- defaults to "grow"', () => {
        const p = new ObjectPool({ create: cr, onExhausted: undefined, capacity: 4, prealloc: 4 });
        assert.notStrictEqual(p.acquire(), null); // grows past prealloc toward capacity... but capacity===prealloc here
        assert.strictEqual(p.size, 4);
    });
});

describe('boundary: canonical-spelling chunk boundary walk (GROW_CHUNK = 256)', () => {
    // 2.0.0's QA found chunk-boundary bugs at 255/256/257 under the legacy
    // spelling. The canonical spelling normalizes to the SAME internal
    // _maxSize/_expand, so it must drain to exactly `capacity` at every one of
    // these boundaries too.
    for (const capacity of [255, 256, 257, 512, 513]) {
        test(`capacity:${capacity} drains to exactly capacity and stays conserved`, () => {
            const pool = new ObjectPool({ create: cr, prealloc: 1, onExhausted: 'grow', capacity });
            let n = 0;
            while (pool.acquire() !== null) {
                n++;
                assert.ok(pool.size <= capacity, `size ${pool.size} exceeded capacity ${capacity}`);
                assert.strictEqual(pool.used + pool.free, pool.size, 'conservation broken mid-drain');
                if (n > capacity + 1) throw new Error('runaway acquire loop');
            }
            assert.strictEqual(pool.size, capacity);
            assert.strictEqual(pool.used, capacity);
            assert.strictEqual(pool.free, 0);
        });

        test(`capacity:${capacity} canonical matches its legacy twin byte-for-byte in {size,used,free}`, () => {
            const canon = new ObjectPool({ create: cr, prealloc: 1, onExhausted: 'grow', capacity });
            const legacy = new ObjectPool({ create: cr, size: 1, expand: true, maxSize: capacity });
            let ca = 0, cb = 0;
            while (canon.acquire() !== null) ca++;
            while (legacy.acquire() !== null) cb++;
            assert.strictEqual(ca, cb);
            assert.strictEqual(canon.size, legacy.size);
        });
    }
});

describe('boundary: duplicate dispose', () => {
    test('destroy() called twice is a safe no-op the second time', () => {
        const p = new ObjectPool({ create: cr, capacity: 4, prealloc: 4 });
        p.destroy();
        assert.doesNotThrow(() => p.destroy());
        assert.doesNotThrow(() => p.destroy()); // a third time, for good measure
    });

    test('a canonical-spelled pool throws named errors on every op after duplicate dispose', () => {
        const p = new ObjectPool({ create: cr, capacity: 4, prealloc: 4, onExhausted: 'throw' });
        p.destroy();
        p.destroy();
        assert.throws(() => p.acquire(), /destroyed pool/);
        assert.throws(() => p.release({}), /destroyed pool/);
        assert.throws(() => p.releaseAll(), /destroyed pool/);
        assert.throws(() => p.forEachActive(() => {}), /destroyed pool/);
    });
});

describe('boundary: dispose-during-iteration', () => {
    test('destroy() called from inside forEachActive stops the walk without crashing', () => {
        const pool = new ObjectPool({ create: cr, capacity: 4, prealloc: 4, onExhausted: 'null' });
        for (let i = 0; i < 4; i++) pool.acquire();
        let calls = 0;
        assert.doesNotThrow(() => {
            pool.forEachActive(() => {
                calls++;
                if (calls === 2) pool.destroy();
            });
        });
        assert.strictEqual(calls, 2, 'destroy() mid-walk should stop further callback invocations');
        assert.throws(() => pool.acquire(), /destroyed pool/);
    });

    test('releaseAll() called from inside forEachActive stops the walk (documented contract)', () => {
        const pool = new ObjectPool({ create: cr, capacity: 4, prealloc: 4, onExhausted: 'null' });
        for (let i = 0; i < 4; i++) pool.acquire();
        let calls = 0;
        pool.forEachActive(() => {
            calls++;
            if (calls === 1) pool.releaseAll();
        });
        assert.strictEqual(calls, 1);
        assert.strictEqual(pool.used, 0);
        assert.strictEqual(pool.free, 4);
    });
});

describe('boundary: re-entrant write', () => {
    test('release() called again on the SAME object from within its own reset() is a genuine double-release (false), not a crash', () => {
        let reentrantResult = 'not-called';
        let pool;
        pool = new ObjectPool({
            create: cr,
            capacity: 2,
            prealloc: 2,
            onExhausted: 'null',
            reset: (o) => {
                if (reentrantResult === 'not-called') reentrantResult = pool.release(o);
            },
        });
        const x = pool.acquire();
        const firstResult = pool.release(x);
        assert.strictEqual(firstResult, true);
        assert.strictEqual(reentrantResult, false);
        assert.strictEqual(pool.used, 0);
        assert.strictEqual(pool.free, 2);
        assert.strictEqual(pool.used + pool.free, pool.size);
    });

    test('acquire() called again from inside create() during eager preallocation does not corrupt state', () => {
        // A pathological create() that reaches back into the (not-yet-fully-built)
        // pool. The pool must either serve a consistent (possibly null) answer or
        // throw -- it must never leave used+free !== size.
        let self;
        let n = 0;
        const pool = new ObjectPool({
            create: () => {
                n++;
                if (n === 2) { try { self.acquire(); } catch { /* either outcome is acceptable */ } }
                return {};
            },
            capacity: 4,
            prealloc: 'eager',
            onExhausted: 'null',
        });
        self = pool;
        assert.strictEqual(pool.used + pool.free, pool.size);
    });
});

describe('boundary: empty / null / undefined constructor input', () => {
    test('new ObjectPool({}) throws naming "create" (empty options)', () => {
        throwsNamed(() => new ObjectPool({}), 'create');
    });

    test('new ObjectPool() and new ObjectPool(null) throw a TypeError (pre-existing since 2.0.0, unchanged by P2b)', () => {
        // Not library-branded (`ObjectPool: ...`) because the destructuring of
        // `options` itself fails before the library's own validation runs. Pinned
        // here as a boundary fact, not a regression -- the frozen 2.0.0 fixture
        // exhibits the identical raw message (checked below), so this is not
        // something P2b introduced or is obligated to fix.
        assert.throws(() => new ObjectPool(), TypeError);
        assert.throws(() => new ObjectPool(null), TypeError);
    });

    test('the raw destructure-of-null/undefined failure is identical to the frozen 2.0.0 fixture', () => {
        const shipped = (() => { try { new ObjectPool(undefined); } catch (e) { return e.message; } return null; })();
        const frozen = (() => { try { new FrozenPool(undefined); } catch (e) { return e.message; } return null; })();
        assert.strictEqual(shipped, frozen);
    });
});

describe('boundary: TOCTOU -- options read exactly once, snapshotted values are not re-read', () => {
    test('a lying capacity getter cannot change behaviour after construction', () => {
        let reads = 0;
        const opts = {
            create: () => ({}),
            get capacity() { reads++; return reads === 1 ? 10 : 999999; },
            prealloc: 5,
            onExhausted: 'grow',
        };
        const pool = new ObjectPool(opts);
        assert.strictEqual(reads, 1, 'capacity must be read exactly once, at construction');
        assert.strictEqual(pool.size, 5);
        for (let i = 0; i < 5; i++) pool.acquire();
        // Grows into the snapshotted capacity (10), never re-consulting the
        // getter (which would otherwise have lied and returned 999999).
        for (let i = 0; i < 5; i++) assert.notStrictEqual(pool.acquire(), null);
        assert.strictEqual(pool.size, 10);
        assert.strictEqual(reads, 1, 'the getter must never be read again after construction');
        assert.strictEqual(pool.acquire(), null); // capped at the SNAPSHOTTED 10, not 999999
    });
});

describe('boundary: legacy expand:false has an inert maxSize, and the canonical "null" twin matches', () => {
    // This block proves exactly two things and no more: (1) on the FROZEN 2.0.0
    // module, {size:k, expand:false, maxSize:N} has ALWAYS capped at k with an
    // inert maxSize; (2) the canonical twin of that config -- onExhausted:"null",
    // NOT "throw" -- matches it. `expand` folds to grow/null only, so "null" (not
    // "throw") is the legacy twin. This does NOT justify the "throw" scope limit;
    // "throw" is new surface with no legacy alias and is unconstrained by
    // additivity (see decisions/D5-options.md, and the "throw" pin in
    // ObjectPool.test.js). Verified against the frozen fixture itself, so a future
    // edit to ObjectPool.js cannot silently make it vacuous.
    test('frozen 2.0.0: {size:32, expand:false, maxSize:4096} caps at 32, never reaches 4096', () => {
        const p = new FrozenPool({ create: cr, size: 32, expand: false, maxSize: 4096 });
        assert.strictEqual(p.size, 32);
        let n = 0;
        while (p.acquire() !== null) { n++; if (n > 40) throw new Error('runaway'); }
        assert.strictEqual(n, 32);
        assert.strictEqual(p.size, 32, 'maxSize:4096 must stay inert under expand:false in 2.0.0');
    });

    test('canonical "null" twin {capacity:4096, prealloc:32, onExhausted:"null"} matches the frozen behaviour byte-for-byte', () => {
        const canon = new ObjectPool({ create: cr, capacity: 4096, prealloc: 32, onExhausted: 'null' });
        const frozen = new FrozenPool({ create: cr, size: 32, expand: false, maxSize: 4096 });
        function drive(pool) {
            const log = [];
            for (let i = 0; i < 40; i++) {
                const r = pool.acquire();
                log.push((r === null ? 'null' : 'obj') + ':' + pool.size + ',' + pool.used + ',' + pool.free);
            }
            return log.join('|');
        }
        assert.strictEqual(drive(canon), drive(frozen)); // both cap at 32, then return null forever
        assert.strictEqual(canon.size, 32, 'capacity:4096 stays inert under onExhausted:"null", matching the twin');
    });
});
