import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ObjectPool, VERSION } from '../ObjectPool.js';
import { ObjectPool as FrozenPool } from './baseline/ObjectPool-2.0.0.js';

/** Absolute path to a repo file, resolved from this test's URL (no cwd, no git). */
const repoPath = (rel) => fileURLToPath(new URL('../' + rel, import.meta.url));
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

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

/** Collect the ids of the active objects (unordered), sorted for set-equality. */
function activeIds(pool) {
    const ids = [];
    pool.forEachActive((o) => ids.push(o.id));
    ids.sort((a, b) => a - b);
    return ids;
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

        test('VERSION is exported and is 2.1.0', () => {
            assert.strictEqual(VERSION, '2.1.0');
        });
    });

    // ---------------------------------------------------------------
    //  create() return-value policy (v2.0.0, D1) -- fail closed
    // ---------------------------------------------------------------

    describe('create() return-value policy', () => {
        for (const [label, factory] of [
            ['null', () => null],
            ['undefined', () => undefined],
            ['a number', () => 5],
            ['a string', () => 'x'],
            ['a boolean', () => true],
        ]) {
            test(`rejects create() returning ${label}`, () => {
                assert.throws(
                    () => new ObjectPool({ create: factory, size: 1 }),
                    (err) => err instanceof TypeError && /ObjectPool: create\(/.test(err.message),
                );
            });
        }

        test('accepts create() returning a function (a valid identity)', () => {
            const pool = new ObjectPool({ create: () => () => {}, size: 2 });
            assert.strictEqual(pool.size, 2);
            assert.strictEqual(typeof pool.acquire(), 'function');
        });

        test('rejects create() returning a duplicate identity', () => {
            const same = {};
            assert.throws(
                () => new ObjectPool({ create: () => same, size: 2 }),
                (err) => err instanceof TypeError && /distinct identity/.test(err.message),
            );
        });

        test('a single-object pool of one shared identity is legal (one creation)', () => {
            const same = { tag: 1 };
            const pool = new ObjectPool({ create: () => same, size: 1 });
            assert.strictEqual(pool.acquire(), same);
        });

        test('a bad create() return never leaves a half-built pool -- create ran once', () => {
            let created = 0;
            const create = () => { created++; return null; };
            assert.throws(() => new ObjectPool({ create, size: 8 }), /ObjectPool: create\(/);
            assert.strictEqual(created, 1); // stops at the first bad object
        });
    });

    // ---------------------------------------------------------------
    //  Unknown option keys (v2.0.0) -- fail closed with did-you-mean
    // ---------------------------------------------------------------

    describe('unknown option keys', () => {
        test('an unknown key throws a named TypeError', () => {
            assert.throws(
                () => new ObjectPool({ create: () => ({}), typoo: 1 }),
                (err) => err instanceof TypeError && /^ObjectPool: "typoo" is not a recognized option/.test(err.message),
            );
        });

        test('did-you-mean fires for near-miss keys', () => {
            const cases = [['maxsize', 'maxSize'], ['Size', 'size'], ['expaned', 'expand'], ['rest', 'reset']];
            for (const [bad, meant] of cases) {
                let err = null;
                try { new ObjectPool({ create: () => ({}), [bad]: 1 }); } catch (e) { err = e; }
                assert.ok(err instanceof TypeError, `${bad} did not throw`);
                assert.match(err.message, new RegExp(`"${bad}"`), `${bad} not named`);
                assert.match(err.message, new RegExp(`did you mean "${meant}"`), `${bad} did not suggest ${meant}: ${err.message}`);
            }
        });

        test('the three canonical names are real options now, not reserved (2.1.0)', () => {
            // In 2.0.0 these threw a "coming in 2.1.0" message. In 2.1.0 they are
            // the canonical vocabulary and must construct a valid pool.
            assert.doesNotThrow(() => new ObjectPool({ create: () => ({}), capacity: 8, prealloc: 4, onExhausted: 'grow' }));
            const p = new ObjectPool({ create: () => ({}), capacity: 8, prealloc: 4, onExhausted: 'grow' });
            assert.strictEqual(p.size, 4);
        });

        test('a full valid options object with all five legacy keys constructs', () => {
            assert.doesNotThrow(() => new ObjectPool({
                create: () => ({}), reset: () => {}, size: 4, expand: true, maxSize: 10,
            }));
        });

        test('a full valid options object with the canonical triple constructs', () => {
            assert.doesNotThrow(() => new ObjectPool({
                create: () => ({}), reset: () => {}, capacity: 10, prealloc: 4, onExhausted: 'grow',
            }));
        });

        test('explicit undefined for an optional key is NOT an unknown key', () => {
            assert.doesNotThrow(() => new ObjectPool({
                create: () => ({}), reset: undefined, size: undefined, expand: undefined, maxSize: undefined,
            }));
        });

        test('a bad size is reported before an unknown key', () => {
            assert.throws(
                () => new ObjectPool({ create: () => ({}), size: NaN, typoo: 1 }),
                (err) => err instanceof TypeError && /^ObjectPool: "size"/.test(err.message),
            );
        });
    });

    // ---------------------------------------------------------------
    //  Option validation (P1, v1.1.0) -- unchanged in v2.
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
                // first acquire by growing a bounded chunk.
                assert.notStrictEqual(pool.acquire(), null);
                assert.ok(pool.size > 0);
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

            test('accepts an explicit maxSize: Infinity as equivalent to the default', () => {
                const pool = new ObjectPool({ create: () => ({}), size: 1, expand: true, maxSize: Infinity });
                for (let i = 0; i < 50; i++) assert.notStrictEqual(pool.acquire(), null);
                assert.ok(pool.size >= 50);
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
                assert.throws(
                    () => new ObjectPool({ create: () => ({}), size: NaN, maxSize: -1 }),
                    (err) => err instanceof TypeError && /^ObjectPool: "size"/.test(err.message),
                );
            });
        });
    });

    // ---------------------------------------------------------------
    //  The 2.1.0 option reshape (D5) -- capacity / prealloc / onExhausted
    // ---------------------------------------------------------------

    describe('2.1.0 option reshape (D5)', () => {
        const cr = () => ({});

        /** Drive a deterministic 100-op acquire/release program and record the
         *  {size, used, free} triple after every op, so two pools built from
         *  different vocabularies can be proven observationally identical -- not
         *  merely "both constructed". */
        function trace(pool) {
            const held = [];
            const log = [];
            for (let i = 0; i < 100; i++) {
                if (i % 3 === 2 && held.length) {
                    pool.release(held.pop());
                } else {
                    const o = pool.acquire();
                    if (o) held.push(o);
                }
                log.push(pool.size + ',' + pool.used + ',' + pool.free);
            }
            return log.join('|');
        }

        describe('alias equivalence -- every legacy config equals its canonical twin', () => {
            // Both directions: legacy spelling and canonical spelling must build a
            // pool that is IDENTICAL over 100 acquire/release ops (size/used/free).
            const pairs = [
                ['defaults', { create: cr }, { create: cr }],
                ['fixed, no expand',
                    { create: cr, size: 4, expand: false },
                    { create: cr, prealloc: 4, onExhausted: 'null' }],
                ['bounded growth',
                    { create: cr, size: 4, expand: true, maxSize: 50 },
                    { create: cr, prealloc: 4, onExhausted: 'grow', capacity: 50 }],
                ['eager to capacity',
                    { create: cr, size: 8, expand: false, maxSize: 8 },
                    { create: cr, prealloc: 'eager', capacity: 8, onExhausted: 'null' }],
                ['lazy start, grows',
                    { create: cr, size: 0, expand: true },
                    { create: cr, prealloc: 'lazy', onExhausted: 'grow' }],
            ];
            for (const [label, legacy, canon] of pairs) {
                test(`${label}: legacy and canonical produce identical {size,used,free} over 100 ops`, () => {
                    const a = trace(new ObjectPool(legacy));
                    const b = trace(new ObjectPool(canon));
                    assert.strictEqual(a, b, `${label}: traces diverged\nlegacy=${a}\ncanon =${b}`);
                });
            }

            test('the README/llms default equals new ObjectPool({create}) both ways', () => {
                const legacy = new ObjectPool({ create: cr, size: 32, expand: true, maxSize: Infinity });
                const canon = new ObjectPool({ create: cr, prealloc: 32, onExhausted: 'grow', capacity: Infinity });
                const bare = new ObjectPool({ create: cr });
                assert.strictEqual(legacy.size, 32);
                assert.strictEqual(canon.size, 32);
                assert.strictEqual(bare.size, 32);
            });
        });

        describe('the two vocabularies are mutually exclusive -- three conflict throws', () => {
            const conflicts = [
                ['{size, capacity}', { create: cr, size: 8, capacity: 16 }, ['size', 'capacity']],
                ['{expand, onExhausted}', { create: cr, expand: false, onExhausted: 'grow' }, ['expand', 'onExhausted']],
                ['{maxSize, prealloc}', { create: cr, maxSize: 10, prealloc: 4 }, ['maxSize', 'prealloc']],
            ];
            for (const [label, opts, [legacyKey, canonKey]] of conflicts) {
                test(`${label} throws by name (both keys)`, () => {
                    let err = null;
                    try { new ObjectPool(opts); } catch (e) { err = e; }
                    assert.ok(err instanceof TypeError, `${label} did not throw a TypeError`);
                    assert.match(err.message, new RegExp(`"${legacyKey}"`), `${label} did not name ${legacyKey}`);
                    assert.match(err.message, new RegExp(`"${canonKey}"`), `${label} did not name ${canonKey}`);
                });
            }

            test('an explicit undefined canonical key is not a conflict with a legacy key', () => {
                assert.doesNotThrow(() => new ObjectPool({ create: cr, size: 8, capacity: undefined }));
            });
        });

        describe('prealloc: "eager" requires a finite capacity', () => {
            test('{prealloc:"eager", capacity:Infinity} throws by name', () => {
                let err = null;
                try { new ObjectPool({ create: cr, prealloc: 'eager', capacity: Infinity }); } catch (e) { err = e; }
                assert.ok(err instanceof TypeError, 'did not throw');
                assert.match(err.message, /^ObjectPool: "prealloc"/);
                assert.match(err.message, /capacity/);
            });

            test('{prealloc:"eager"} with the default (Infinity) capacity throws by name', () => {
                assert.throws(
                    () => new ObjectPool({ create: cr, prealloc: 'eager' }),
                    (err) => err instanceof TypeError && /^ObjectPool: "prealloc"/.test(err.message),
                );
            });

            test('{prealloc:"eager", capacity:N} builds exactly N', () => {
                const p = new ObjectPool({ create: cr, prealloc: 'eager', capacity: 12 });
                assert.strictEqual(p.size, 12);
                assert.strictEqual(p.free, 12);
            });
        });

        describe('canonical validation', () => {
            test('onExhausted must be one of the three strings', () => {
                for (const bad of ['nope', 'GROW', true, 1, null]) {
                    assert.throws(
                        () => new ObjectPool({ create: cr, onExhausted: bad }),
                        (err) => err instanceof TypeError && /^ObjectPool: "onExhausted"/.test(err.message),
                        `onExhausted:${String(bad)} did not throw`,
                    );
                }
            });

            test('prealloc must be a finite integer >= 0, "eager", or "lazy"', () => {
                for (const bad of [-1, 2.5, NaN, '4', 'huge']) {
                    assert.throws(
                        () => new ObjectPool({ create: cr, prealloc: bad }),
                        (err) => err instanceof TypeError && /^ObjectPool: "prealloc"/.test(err.message),
                        `prealloc:${String(bad)} did not throw`,
                    );
                }
            });

            test('capacity must be a finite integer >= 0 or Infinity', () => {
                for (const bad of [-1, 2.5, NaN, '4']) {
                    assert.throws(
                        () => new ObjectPool({ create: cr, capacity: bad, prealloc: 0 }),
                        (err) => err instanceof TypeError && /^ObjectPool: "capacity"/.test(err.message),
                        `capacity:${String(bad)} did not throw`,
                    );
                }
            });

            test('{capacity < prealloc} throws naming both', () => {
                let err = null;
                try { new ObjectPool({ create: cr, capacity: 2, prealloc: 5 }); } catch (e) { err = e; }
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /"capacity"/);
                assert.match(err.message, /"prealloc"/);
            });

            test('a typo near a canonical name gets a did-you-mean hint', () => {
                let err = null;
                try { new ObjectPool({ create: cr, capasity: 4 }); } catch (e) { err = e; }
                assert.ok(err instanceof TypeError);
                assert.match(err.message, /did you mean "capacity"/);
            });
        });

        describe('onExhausted: "throw" disambiguates OP-04, "null" still conflates', () => {
            test('"throw" capped case names the capacity', () => {
                const p = new ObjectPool({ create: cr, capacity: 2, prealloc: 'eager', onExhausted: 'throw' });
                p.acquire(); p.acquire();
                assert.throws(() => p.acquire(), /exceeded capacity 2/);
            });

            test('"throw" exhausted-below-capacity case is a distinct message', () => {
                const p = new ObjectPool({ create: cr, capacity: 10, prealloc: 3, onExhausted: 'throw' });
                p.acquire(); p.acquire(); p.acquire();
                assert.throws(() => p.acquire(), /exhausted pool of 3/);
            });

            test('"null" still returns null for both capped and exhausted (OP-04 remainder)', () => {
                const capped = new ObjectPool({ create: cr, capacity: 2, prealloc: 'eager', onExhausted: 'null' });
                capped.acquire(); capped.acquire();
                assert.strictEqual(capped.acquire(), null);
                const exhausted = new ObjectPool({ create: cr, capacity: 10, prealloc: 3, onExhausted: 'null' });
                exhausted.acquire(); exhausted.acquire(); exhausted.acquire();
                assert.strictEqual(exhausted.acquire(), null);
            });

            test('KNOWN LIMIT (D5): "throw" does not grow, so capacity>prealloc is inert', () => {
                // Documented in D5 / llms.txt / README: "grow to a hard cap then
                // throw" is not expressible; "throw" throws at prealloc, not at
                // capacity. This is a scope CHOICE (onExhausted is one axis), NOT
                // forced by additivity -- "throw" has no legacy alias (expand folds
                // only to grow/null). "throw" has NO legacy twin; do not compare it
                // to expand:false (that is "null"'s twin). Pinned so the documented
                // limit cannot silently change.
                const p = new ObjectPool({ create: cr, capacity: 4096, prealloc: 32, onExhausted: 'throw' });
                for (let i = 0; i < 32; i++) assert.notStrictEqual(p.acquire(), null);
                assert.strictEqual(p.size, 32); // never grew toward 4096
                assert.throws(() => p.acquire(), /exhausted pool of 32/); // NOT "exceeded capacity"
            });
        });
    });

    // ---------------------------------------------------------------
    //  Hot-body byte-identity and shipped-file hygiene (P2b)
    // ---------------------------------------------------------------

    describe('hot bodies are byte-identical to the 2.0.0 fixture', () => {
        // Captured from HEAD (git c5a3dd9 = 2.0.0) before any P2b edit and
        // re-verified against HEAD. Any change to a hot body -- whitespace
        // included -- changes its .toString() hash and fails a named test here.
        const HOT_HASHES = {
            acquire: '55f3a646dd5e9a5700609d82fedc88077dffabb434749776790f4ccc48800de0',
            release: '239ef75c603bf839d2f0df7089651955f8342e5df7bbc89a05e2b23eeeeb8e7a',
            releaseAll: 'b29b13b9996ffd342a3e45bf42b370c83ede18676e19a08d91d882715d7905b9',
            forEachActive: '937941616f65fd728957e65031092991fe34ed3fbfe2990567c994cbffc5550c',
        };

        for (const method of Object.keys(HOT_HASHES)) {
            test(`shipped ${method}() matches the 2.0.0 hash`, () => {
                assert.strictEqual(sha256(ObjectPool.prototype[method].toString()), HOT_HASHES[method]);
            });
            test(`frozen baseline ${method}() matches the 2.0.0 hash`, () => {
                assert.strictEqual(sha256(FrozenPool.prototype[method].toString()), HOT_HASHES[method]);
            });
        }

        test('the frozen baseline file has not drifted (own-integrity hash)', () => {
            // Guards the frozen copy itself: a well-meaning "fix" to
            // test/baseline/ObjectPool-2.0.0.js changes this hash and fails loudly.
            const raw = readFileSync(repoPath('test/baseline/ObjectPool-2.0.0.js'));
            assert.strictEqual(sha256(raw), '727d51967a6ce5be1e260fbc516e31107d1ed8e884036bc5256f21cc7aed5707');
        });
    });

    describe('no stale forward-reference survives in shipped files', () => {
        // The 2.0.0 FUTURE_KEYS messages said capacity/prealloc/onExhausted were
        // "coming in 2.1.0" / "reserved". Shipping either string IN 2.1.0 is the
        // exact rot this test forbids. Grep the files package.json actually ships.
        const SHIPPED = ['ObjectPool.js', 'ObjectPool.d.ts', 'llms.txt', 'README.md'];
        const FORBIDDEN = [/coming in 2\.1\.0/i, /\breserved\b/i];
        for (const file of SHIPPED) {
            test(`${file} carries no "coming in 2.1.0" / "reserved" string`, () => {
                const text = readFileSync(repoPath(file), 'utf8');
                for (const pat of FORBIDDEN) {
                    assert.ok(!pat.test(text), `${file} still matches ${pat}`);
                }
            });
        }
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

        test('every object drained from a full pool is distinct', () => {
            const N = 32;
            const pool = createPool({ size: N, expand: false });
            const seen = new Set();
            for (let i = 0; i < N; i++) seen.add(pool.acquire());
            assert.strictEqual(seen.size, N);
        });

        test('expands when exhausted (expand=true)', () => {
            const pool = createPool({ size: 1, expand: true });
            pool.acquire();            // takes the 1 preallocated
            const extra = pool.acquire(); // should expand
            assert.notStrictEqual(extra, null);
            assert.ok(pool.size > 1);
        });

        test('returns null when exhausted (expand=false)', () => {
            const pool = createPool({ size: 1, expand: false });
            pool.acquire();
            assert.strictEqual(pool.acquire(), null);
        });

        test('respects maxSize cap during expansion (chunk clamps to room)', () => {
            const pool = createPool({ size: 1, expand: true, maxSize: 3 });
            assert.notStrictEqual(pool.acquire(), null); // 1 (preallocated)
            assert.notStrictEqual(pool.acquire(), null); // grow, room clamps chunk
            assert.notStrictEqual(pool.acquire(), null);
            assert.strictEqual(pool.size, 3);
            assert.strictEqual(pool.acquire(), null);    // at maxSize
        });

        test('a chunked grow never exceeds maxSize', () => {
            const pool = createPool({ size: 1, expand: true, maxSize: 500 });
            for (let i = 0; i < 600; i++) pool.acquire();
            assert.ok(pool.size <= 500);
            assert.strictEqual(pool.acquire(), null);
        });

        // GROW_CHUNK is 256 (OP-10). Pin the boundary matrix around it -- one
        // chunk short, exactly one chunk, one over, two chunks, two chunks plus
        // one, and unbounded -- so a future change to the chunk size or its
        // clamp math is caught here instead of only in a throwaway probe.
        describe('_grow chunk boundaries (GROW_CHUNK = 256)', () => {
            for (const maxSize of [255, 256, 257, 512, 513]) {
                test(`maxSize: ${maxSize} drains to exactly maxSize and stays conserved`, () => {
                    const pool = createPool({ size: 1, expand: true, maxSize });
                    let n = 0;
                    while (pool.acquire() !== null) {
                        n++;
                        assert.ok(pool.size <= maxSize, `size ${pool.size} exceeded maxSize ${maxSize}`);
                        assert.strictEqual(pool.used + pool.free, pool.size, 'conservation broken mid-drain');
                        if (n > maxSize + 1) throw new Error('runaway acquire loop');
                    }
                    assert.strictEqual(pool.size, maxSize, 'final chunk did not clamp exactly to maxSize');
                    assert.strictEqual(pool.used, maxSize);
                    assert.strictEqual(pool.free, 0);
                });
            }

            test('maxSize: Infinity grows past several chunk boundaries with no cap', () => {
                const pool = createPool({ size: 1, expand: true, maxSize: Infinity });
                for (let i = 0; i < 600; i++) {
                    assert.notStrictEqual(pool.acquire(), null);
                }
                assert.ok(pool.size >= 600);
                assert.strictEqual(pool.used + pool.free, pool.size);
                assert.notStrictEqual(pool.acquire(), null); // still never exhausted
            });
        });

        test('keeps serving past the initial size when unbounded', () => {
            const pool = createPool({ size: 1, expand: true });
            for (let i = 0; i < 300; i++) assert.notStrictEqual(pool.acquire(), null);
            assert.ok(pool.size >= 300);
        });

        test('throws after destroy (use-after-destroy is a caller bug)', () => {
            const pool = createPool();
            pool.destroy();
            assert.throws(() => pool.acquire(), /ObjectPool: acquire\(\) called on a destroyed pool/);
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

        test('swap-remove keeps every remaining object acquirable (any release order)', () => {
            const N = 8;
            const pool = createPool({ size: N, expand: false });
            const held = [];
            for (let i = 0; i < N; i++) held.push(pool.acquire());
            // release the middle few in a scattered order
            pool.release(held[3]);
            pool.release(held[0]);
            pool.release(held[6]);
            assert.strictEqual(pool.used, N - 3);
            assert.strictEqual(pool.free, 3);
            // re-acquire 3 -- all distinct, none of the still-held survivors
            const stillHeld = new Set([held[1], held[2], held[4], held[5], held[7]]);
            const re = [pool.acquire(), pool.acquire(), pool.acquire()];
            assert.strictEqual(new Set(re).size, 3);
            for (const r of re) assert.ok(!stillHeld.has(r));
            assert.strictEqual(pool.free, 0);
        });

        test('throws after destroy', () => {
            const pool = createPool();
            const obj = pool.acquire();
            pool.destroy();
            assert.throws(() => pool.release(obj), /ObjectPool: release\(\) called on a destroyed pool/);
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
    //  Foreign Object Protection (v2.0.0, D4) -- now THROWS
    // ---------------------------------------------------------------

    describe('foreign object protection', () => {
        test('throws on an object not from this pool', () => {
            const pool = createPool();
            const foreign = { x: 0, y: 0 };
            assert.throws(() => pool.release(foreign),
                /ObjectPool: release\(\) called with an object this pool did not issue/);
        });

        test('throws on an object from a same-shape sibling pool', () => {
            const pool = createPool({ size: 2 });
            const sibling = createPool({ size: 2 });
            const alien = sibling.acquire();
            assert.throws(() => pool.release(alien), TypeError);
        });

        for (const [label, value] of [
            ['null', null], ['undefined', undefined], ['0', 0], ["''", ''], ['NaN', NaN],
        ]) {
            test(`throws on release(${label})`, () => {
                const pool = createPool();
                assert.throws(() => pool.release(value), TypeError);
            });
        }

        test('throws on a frozen foreign object and a Proxy', () => {
            const pool = createPool();
            assert.throws(() => pool.release(Object.freeze({})), TypeError);
            assert.throws(() => pool.release(new Proxy({}, {})), TypeError);
        });

        test('a rejected foreign release does not touch the free list', () => {
            const pool = createPool({ size: 2 });
            const freeBefore = pool.free;
            try { pool.release({ rogue: true }); } catch { /* expected */ }
            assert.strictEqual(pool.free, freeBefore);
        });
    });

    // ---------------------------------------------------------------
    //  Non-extensible factories (v2.0.0, D1) -- WeakMap keys need not extend
    // ---------------------------------------------------------------

    describe('non-extensible factories pool live', () => {
        test('sealed objects pool and reset', () => {
            const pool = new ObjectPool({
                create: () => Object.seal({ x: 0, y: 0 }),
                reset: (o) => { o.x = 0; o.y = 0; },
                size: 3,
            });
            const o = pool.acquire();
            o.x = 7;
            assert.strictEqual(pool.release(o), true);
            assert.strictEqual(pool.acquire().x, 0); // reset ran
        });

        test('preventExtensions objects pool', () => {
            const pool = new ObjectPool({
                create: () => Object.preventExtensions({ x: 0 }),
                reset: () => {},
                size: 2,
            });
            assert.strictEqual(pool.release(pool.acquire()), true);
        });

        test('frozen objects pool with a no-op reset', () => {
            const pool = new ObjectPool({
                create: () => Object.freeze({ x: 0 }),
                reset: () => {},
                size: 2,
            });
            const o = pool.acquire();
            assert.strictEqual(pool.release(o), true);
            assert.strictEqual(pool.acquire(), o);
        });

        test('frozen object with a WRITING reset surfaces the caller error unmodified', () => {
            const pool = new ObjectPool({
                create: () => Object.freeze({ x: 0 }),
                reset: (o) => { o.x = 0; }, // writes to a frozen prop -> native TypeError
                size: 1,
            });
            const o = pool.acquire();
            // This error comes from the CALLER's own reset (assigning to a frozen
            // property), surfaced UNMODIFIED. It is deliberately NOT wrapped into
            // an `ObjectPool:` message: wrapping would hide which line failed. Do
            // not "fix" this into a library error.
            assert.throws(() => pool.release(o), (err) =>
                err instanceof TypeError
                && /read only property|not extensible|Cannot assign/.test(err.message)
                && !/^ObjectPool:/.test(err.message));
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

        test('is idempotent and leaves used === 0', () => {
            const pool = createPool({ size: 4 });
            pool.acquire();
            pool.releaseAll();
            const freeAfter = pool.free;
            pool.releaseAll();
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, freeAfter);
        });

        test('is safe to call when nothing is acquired', () => {
            const pool = createPool();
            assert.doesNotThrow(() => pool.releaseAll());
            assert.strictEqual(pool.free, 4);
        });

        test('throws after destroy', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            assert.throws(() => pool.releaseAll(), /ObjectPool: releaseAll\(\) called on a destroyed pool/);
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

        test('visits exactly `used` objects, each exactly once', () => {
            const pool = createPool({ size: 6 });
            for (let i = 0; i < 4; i++) pool.acquire();
            const seen = new Set();
            let count = 0;
            pool.forEachActive((o) => { count++; seen.add(o); });
            assert.strictEqual(count, 4);
            assert.strictEqual(seen.size, 4);
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

        test('releasing the CURRENT object mid-iteration visits all N once (D3)', () => {
            const N = 10;
            const pool = createPool({ size: N, expand: false });
            for (let i = 0; i < N; i++) pool.acquire();
            const seen = new Set();
            let count = 0;
            pool.forEachActive((o) => { count++; seen.add(o); pool.release(o); });
            assert.strictEqual(count, N, 'every active object was visited once');
            assert.strictEqual(seen.size, N, 'no object visited twice');
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, pool.size);
        });

        // The next two pin the DOCUMENTED-UNSPECIFIED region of D3. Reverse
        // iteration is contractual ONLY for releasing the CURRENT object; these
        // record what actually happens when you release some OTHER object
        // mid-walk. They exist to catch a silent change, NOT to bless the
        // outcome -- do not "fix" the double-visit; widening the guarantee is out
        // of P2a scope. The part that IS guaranteed is conservation.
        test('releasing a NOT-YET-visited object mid-iteration: unspecified visits, conservation holds', () => {
            const N = 5;
            let id = 0;
            const pool = new ObjectPool({ create: () => ({ id: id++ }), size: N, expand: false });
            const held = [];
            for (let i = 0; i < N; i++) held.push(pool.acquire()); // ids 0..4
            const visited = [];
            pool.forEachActive((o) => {
                visited.push(o.id);
                if (visited.length === 1) pool.release(held[0]); // a lower-index, not-yet-reached slot
            });
            // ACTUAL v2 behaviour: the tail element swapped into the freed low
            // slot is seen twice and one object is skipped -- unspecified, pinned.
            assert.ok(new Set(visited).size < N, 'expected a skipped/double-visited object (documented unspecified)');
            // GUARANTEED: the structure never corrupts.
            assert.strictEqual(pool.used + pool.free, pool.size);
            assert.strictEqual(pool.used, N - 1);
        });

        test('releasing an ALREADY-visited object mid-iteration: no revisit, conservation holds', () => {
            const N = 5;
            let id = 0;
            const pool = new ObjectPool({ create: () => ({ id: id++ }), size: N, expand: false });
            const held = [];
            for (let i = 0; i < N; i++) held.push(pool.acquire());
            const visited = [];
            pool.forEachActive((o) => {
                visited.push(o.id);
                if (visited.length === 1) pool.release(held[N - 1]); // the highest-index slot, visited first
            });
            // ACTUAL v2 behaviour: releasing an already-visited (higher-index)
            // object leaves the remaining walk clean -- pinned, not guaranteed.
            assert.strictEqual(new Set(visited).size, N);
            assert.strictEqual(pool.used + pool.free, pool.size);
            assert.strictEqual(pool.used, N - 1);
        });

        test('releaseAll() mid-iteration stops the walk', () => {
            const pool = createPool({ size: 4, expand: false });
            for (let i = 0; i < 4; i++) pool.acquire();
            let count = 0;
            pool.forEachActive(() => { count++; pool.releaseAll(); });
            assert.strictEqual(count, 1);
            assert.strictEqual(pool.used, 0);
        });

        test('binds thisArg as the callback receiver', () => {
            const pool = createPool({ size: 3 });
            pool.acquire();
            pool.acquire();
            const receiver = { n: 0 };
            pool.forEachActive(function () { this.n++; }, receiver);
            assert.strictEqual(receiver.n, 2);
        });

        test('propagates a throwing callback', () => {
            const pool = createPool({ size: 2 });
            pool.acquire();
            assert.throws(() => pool.forEachActive(() => { throw new Error('cb boom'); }), /cb boom/);
        });

        test('throws after destroy', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            assert.throws(() => pool.forEachActive(() => {}),
                /ObjectPool: forEachActive\(\) called on a destroyed pool/);
        });

        test('works in a game loop update pattern', () => {
            const pool = createPool({ size: 10 });
            for (let i = 0; i < 5; i++) {
                const p = pool.acquire();
                p.x = i * 10;
                p.life = 1.0;
            }
            pool.forEachActive((p) => { p.life -= 0.1; });
            const lives = [];
            pool.forEachActive((p) => lives.push(p.life));
            assert.strictEqual(lives.every((l) => Math.abs(l - 0.9) < 0.001), true);
        });
    });

    // ---------------------------------------------------------------
    //  Iteration order is unspecified (v2.0.0, D2)
    // ---------------------------------------------------------------

    describe('iteration order is unspecified', () => {
        test('two pools driven to the same active set are equal as SETS, order not asserted', () => {
            // Pool A: acquire 0..5, release 1 and 4, re-acquire two.
            let idA = 0;
            const a = new ObjectPool({ create: () => ({ id: idA++ }), size: 6, expand: false });
            const ha = [];
            for (let i = 0; i < 6; i++) ha.push(a.acquire());
            a.release(ha[1]);
            a.release(ha[4]);
            a.acquire();
            a.acquire();

            // Pool B: same objects-by-id, driven through DIFFERENT churn.
            let idB = 0;
            const b = new ObjectPool({ create: () => ({ id: idB++ }), size: 6, expand: false });
            const hb = [];
            for (let i = 0; i < 6; i++) hb.push(b.acquire());
            b.release(hb[4]);
            b.release(hb[1]);
            b.release(hb[0]);
            b.acquire();
            b.acquire();
            b.acquire();

            // Both hold {0,2,3,5} plus the recycled ids -- assert SET equality.
            assert.deepStrictEqual(activeIds(a), [0, 1, 2, 3, 4, 5]);
            assert.deepStrictEqual(activeIds(b), [0, 1, 2, 3, 4, 5]);
            assert.deepStrictEqual(activeIds(a), activeIds(b)); // sets equal
            // Order is deliberately NOT compared -- that is Decision 2.
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
            assert.ok(pool.size > 1);
        });

        test('used + free = size (invariant)', () => {
            const pool = createPool({ size: 5 });
            pool.acquire();
            pool.acquire();
            assert.strictEqual(pool.used + pool.free, pool.size);
        });

        test('conservation holds across a chunked expansion', () => {
            const pool = createPool({ size: 2, expand: true, maxSize: 1000 });
            for (let i = 0; i < 400; i++) {
                pool.acquire();
                assert.strictEqual(pool.used + pool.free, pool.size);
            }
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
    //  Destroy (v2.0.0, D4 + OP-09) -- drains, then throws on reuse
    // ---------------------------------------------------------------

    describe('destroy()', () => {
        test('clears the pool', () => {
            const pool = createPool();
            pool.acquire();
            pool.destroy();
            assert.strictEqual(pool.free, 0);
            assert.strictEqual(pool.used, 0);
        });

        test('drains -- calls reset() on every object still checked out (OP-09)', () => {
            const reset = spy();
            const pool = createPool({ reset, size: 4 });
            pool.acquire();
            pool.acquire();
            pool.acquire();
            pool.destroy();
            assert.strictEqual(reset.calls.length, 3);
        });

        test('does not reset objects that were already released before destroy', () => {
            const reset = spy();
            const pool = createPool({ reset, size: 4 });
            const a = pool.acquire();
            pool.acquire();
            pool.release(a);    // one reset here
            reset.reset();
            pool.destroy();     // only the one still-checked-out object drains
            assert.strictEqual(reset.calls.length, 1);
        });

        test('is idempotent (a second destroy is a safe no-op)', () => {
            const pool = createPool();
            pool.destroy();
            assert.doesNotThrow(() => pool.destroy());
        });

        test('acquire throws after destroy', () => {
            const pool = createPool();
            pool.destroy();
            assert.throws(() => pool.acquire(), /destroyed pool/);
        });

        test('release throws after destroy', () => {
            const pool = createPool();
            const obj = pool.acquire();
            pool.destroy();
            assert.throws(() => pool.release(obj), /destroyed pool/);
        });
    });

    // ---------------------------------------------------------------
    //  Additional v2 coverage -- release orders, re-entrancy, growth edges
    // ---------------------------------------------------------------

    describe('release orders round-trip to empty', () => {
        for (const order of ['lifo', 'fifo', 'random', 'every-other']) {
            test(`${order} release order leaves used=0, free=size`, () => {
                const N = 16;
                const pool = createPool({ size: N, expand: false });
                const held = [];
                for (let i = 0; i < N; i++) held.push(pool.acquire());
                const idx = [];
                for (let i = 0; i < N; i++) idx.push(i);
                if (order === 'lifo') idx.reverse();
                else if (order === 'random') {
                    let seed = 12345;
                    for (let i = idx.length - 1; i > 0; i--) {
                        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                        const j = seed % (i + 1);
                        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
                    }
                } else if (order === 'every-other') {
                    const evens = idx.filter((n) => (n & 1) === 0);
                    const odds = idx.filter((n) => (n & 1) === 1);
                    idx.length = 0;
                    idx.push(...evens, ...odds);
                }
                for (const k of idx) assert.strictEqual(pool.release(held[k]), true);
                assert.strictEqual(pool.used, 0);
                assert.strictEqual(pool.free, N);
                assert.strictEqual(pool.used + pool.free, pool.size);
            });
        }

        test('conservation holds after every op in a churn loop', () => {
            const N = 32;
            const pool = createPool({ size: N, expand: false });
            const held = new Array(N);
            for (let i = 0; i < N; i++) held[i] = pool.acquire();
            let seed = 7;
            for (let i = 0; i < 5000; i++) {
                seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                const k = seed & (N - 1);
                assert.strictEqual(pool.release(held[k]), true);
                held[k] = pool.acquire();
                assert.strictEqual(pool.used + pool.free, pool.size);
            }
            assert.strictEqual(pool.used, N);
        });
    });

    describe('re-entrancy', () => {
        test('reset() may release a sibling re-entrantly; both return to free', () => {
            let sibling = null;
            let reentered = false;
            const pool = new ObjectPool({
                create: () => ({}),
                size: 2,
                reset: () => {
                    if (sibling !== null && !reentered) { reentered = true; pool.release(sibling); }
                },
            });
            const ra = pool.acquire();
            const rb = pool.acquire();
            sibling = rb;
            assert.strictEqual(pool.release(ra), true);
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, 2);
        });

        test('reset() may re-acquire re-entrantly', () => {
            let self = null;
            let guard = false;
            const pool = new ObjectPool({
                create: () => ({ v: 0 }),
                size: 2,
                expand: true,
                reset: () => { if (!guard) { guard = true; self.acquire(); } },
            });
            self = pool;
            const x = pool.acquire();
            pool.release(x);
            assert.strictEqual(pool.used, 1);
            assert.strictEqual(pool.used + pool.free, pool.size);
        });

        test('a throwing reset leaves the object re-poolable (swap-removed first)', () => {
            const pool = new ObjectPool({
                create: () => ({}),
                reset: () => { throw new Error('boom'); },
                size: 1,
            });
            const t = pool.acquire();
            assert.throws(() => pool.release(t), /boom/);
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, 1); // not lost -- v1 dropped it to free=0
        });
    });

    describe('growth edges', () => {
        test('size:0 with expand grows a bounded chunk on first acquire', () => {
            const pool = new ObjectPool({ create: () => ({}), size: 0, expand: true });
            assert.strictEqual(pool.size, 0);
            assert.notStrictEqual(pool.acquire(), null);
            assert.ok(pool.size > 0);
            assert.strictEqual(pool.used, 1);
        });

        test('at maxSize, acquire returns null repeatedly and the pool stays usable', () => {
            const pool = new ObjectPool({ create: () => ({ v: 0 }), size: 2, expand: true, maxSize: 2 });
            const a = pool.acquire();
            pool.acquire();
            for (let i = 0; i < 5; i++) assert.strictEqual(pool.acquire(), null);
            assert.strictEqual(pool.release(a), true);
            assert.notStrictEqual(pool.acquire(), null); // reuses the freed slot
        });

        test('sealed factory keeps working across a chunked expansion', () => {
            const pool = new ObjectPool({
                create: () => Object.seal({ x: 0 }),
                reset: (o) => { o.x = 0; },
                size: 1,
                expand: true,
                maxSize: 300,
            });
            for (let i = 0; i < 250; i++) assert.notStrictEqual(pool.acquire(), null);
            assert.ok(pool.size <= 300);
        });

        test('create() throwing mid-growth-chunk propagates, stays conserved, remains usable', () => {
            let count = 0;
            let boom = true;
            const LIMIT = 34; // fewer than one GROW_CHUNK (256) -- throw partway
            const pool = new ObjectPool({
                create: () => { if (boom && count >= LIMIT) throw new Error('create boom'); count++; return { n: count }; },
                size: 0,
                expand: true,
            });
            // First acquire triggers a grow chunk; create throws partway through it.
            assert.throws(() => pool.acquire(), /create boom/);
            // The partial chunk is retained and the structure is conserved.
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.size, LIMIT);
            assert.strictEqual(pool.free, LIMIT);
            assert.strictEqual(pool.used + pool.free, pool.size);
            // Still usable: it serves the partially-built chunk before growing a
            // fresh one.
            boom = false;
            for (let i = 0; i < LIMIT; i++) assert.notStrictEqual(pool.acquire(), null);
            assert.strictEqual(pool.used, LIMIT);
            assert.notStrictEqual(pool.acquire(), null); // grows a fresh full chunk
            assert.ok(pool.size > LIMIT);
            assert.strictEqual(pool.used + pool.free, pool.size);
        });

        test('acquire after releaseAll reuses the same object identities', () => {
            const N = 8;
            const pool = createPool({ size: N, expand: false });
            const first = new Set();
            for (let i = 0; i < N; i++) first.add(pool.acquire());
            pool.releaseAll();
            const second = new Set();
            for (let i = 0; i < N; i++) second.add(pool.acquire());
            assert.strictEqual(second.size, N);
            for (const o of second) assert.ok(first.has(o)); // no new objects created
        });
    });

    describe('lifecycle edges', () => {
        test('destroy on a never-used pool is safe and marks it destroyed', () => {
            const pool = createPool();
            assert.doesNotThrow(() => pool.destroy());
            assert.throws(() => pool.acquire(), /destroyed pool/);
        });

        test('double destroy after a drain stays a no-op', () => {
            const pool = createPool({ size: 2 });
            pool.acquire();
            pool.destroy();
            assert.doesNotThrow(() => pool.destroy());
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, 0);
        });

        test('a released-then-reacquired-then-released object cycles cleanly', () => {
            const pool = createPool({ size: 1 });
            const a = pool.acquire();
            assert.strictEqual(pool.release(a), true);
            const b = pool.acquire();
            assert.strictEqual(b, a);
            assert.strictEqual(pool.release(b), true);
            assert.strictEqual(pool.release(b), false); // now a genuine double-release
        });

        test('forEachActive throws a named error for a non-function callback, regardless of pool state', () => {
            // The policy must NOT depend on whether the pool holds active objects
            // (that state-dependence was the v2.0.0-rc defect). Same answer both ways.
            for (const bad of [123, undefined, null, {}, 'nope']) {
                const empty = createPool({ size: 2 });
                assert.throws(() => empty.forEachActive(bad),
                    (err) => err instanceof TypeError && /^ObjectPool: "callback"/.test(err.message),
                    `empty pool did not throw a named error for ${String(bad)}`);

                const active = createPool({ size: 2 });
                active.acquire();
                assert.throws(() => active.forEachActive(bad),
                    (err) => err instanceof TypeError && /^ObjectPool: "callback"/.test(err.message),
                    `active pool did not throw a named error for ${String(bad)}`);
            }
        });

        test('forEachActive without a thisArg calls the callback plainly', () => {
            const pool = createPool({ size: 2 });
            pool.acquire();
            let n = 0;
            pool.forEachActive(() => { n++; });
            assert.strictEqual(n, 1);
        });
    });

    // ---------------------------------------------------------------
    //  Real-World Usage Pattern
    // ---------------------------------------------------------------

    describe('usage: particle burst', () => {
        test('handles acquire -> mutate -> release -> reacquire cycle', () => {
            const pool = createPool({ size: 100 });

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

            for (const p of active) pool.release(p);
            assert.strictEqual(pool.used, 0);
            assert.strictEqual(pool.free, 100);

            const reused = pool.acquire();
            assert.strictEqual(reused.x, 0); // reset was called
            assert.strictEqual(reused.life, 0);
        });

        test('kills dying particles from inside forEachActive without a scratch array', () => {
            const pool = createPool({ size: 20, expand: false });
            for (let i = 0; i < 20; i++) {
                const p = pool.acquire();
                p.life = (i % 2 === 0) ? 0 : 1; // half are dead
            }
            pool.forEachActive((p) => {
                p.life -= 1;
                if (p.life < 0) pool.release(p); // release the current object -- D3
            });
            assert.strictEqual(pool.used, 10);   // the 10 that started at life 1
            assert.strictEqual(pool.free, 10);
            pool.forEachActive((p) => assert.ok(p.life >= 0));
        });
    });
});
