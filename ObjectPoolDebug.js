/**
 * @zakkster/lite-object-pool/debug -- the debug lane (D6).
 *
 * A SEPARATE ENTRY POINT that never loads in production. It exists so the
 * production `ObjectPool.js` hot path can stay 0 B/op while callers who WANT
 * observability -- acquire-site tags, a leak report, an acquired-never-released
 * kernel for @zakkster/lite-leak -- can pay real bytes for it in a lane the
 * torture alloc gate never runs against.
 *
 * THIS LANE ALLOCATES, BY DESIGN. It is NOT for production. `acquire()` mints a
 * tag record per checkout; `leaks()` builds a fresh report per call. Measured
 * per-acquire cost (node v26.3.1, darwin, 2026-08-17, net min-over-6):
 *   - captureStacks off (default): ~102 B/acquire  (one { id, at } + Map entry)
 *   - captureStacks on:            ~1173 B/acquire  (the above + a stack string)
 *
 * DebugObjectPool is a public-surface WRAPPER (D6.3): it composes an ObjectPool
 * and speaks only its public methods. It reads no `_items` / `_sparse` /
 * `_slots`, so a future structural change to the sparse set cannot break it
 * silently.
 *
 * The observability counters `totalAcquires` / `totalReleases` / `peakUsed`
 * live HERE, not in `ObjectPool`: a measurement (D6.6) showed adding them to the
 * shipped acquire/release hot bodies pushed the T2 differential over threshold,
 * so they moved to this lane. `stats(out)` here reports them plus everything the
 * core `stats(out)` reports.
 *
 * NOTE (D6.9): lite-gc-profiler's watchPool CANNOT observe an
 * acquired-never-released object from this pool, because `ObjectPool._items[]`
 * retains every pooled object for the pool's whole lifetime -- so no checked-out
 * object is ever collected and `escapeCount` is 0 by construction. The
 * acquired-never-released signal comes from `createPoolLeakKernel` below, an
 * `audit()` + `count()` kernel over this wrapper's OWN outstanding tags -- never
 * from watchPool and never from a `refine()`/FinalizationRegistry kernel (which
 * would report clean forever here, by the same retention).
 *
 * @license MIT
 */

import { ObjectPool } from './ObjectPool.js';

/** Render a rejected value for an error message. Cold: throw path only. */
function received(v) {
    return (typeof v === 'symbol' ? v.toString() : String(v)) + ' (' + typeof v + ')';
}

/** Restore one stats slot during a failed stats() write: put a pre-existing OWN
 *  value back, or DELETE a slot this write created (a plain-assigned prop is
 *  configurable, so delete cannot fail) -- so `out` is left in its exact prior
 *  shape, never with a leftover `undefined` key. Guarded per slot. Cold: the
 *  stats() throw path only. */
function undoStatSlot(out, key, had, val) {
    try {
        if (had) out[key] = val;
        else delete out[key];
    } catch { /* a non-writable pre-existing slot was never changed; nothing to undo */ }
}

/**
 * A debug wrapper around an ObjectPool. Same construction options as ObjectPool,
 * plus one debug-only key:
 *   - `captureStacks?: boolean` -- capture `new Error().stack` per acquire so
 *     `leaks()` can name the acquire site. Default false. Expensive; see the
 *     byte figures above.
 *
 * `captureStacks` is stripped before the options reach ObjectPool, which throws
 * on unknown keys -- the production constructor's option shape is untouched (D6.2).
 */
export class DebugObjectPool {
    /**
     * @param {Object} options ObjectPool options, plus optional `captureStacks`.
     */
    constructor(options) {
        const opts = options || {};
        this._captureStacks = opts.captureStacks === true;

        // Strip the debug-only key so ObjectPool's unknown-key guard does not
        // reject it. Constructor-cold; allocation here is irrelevant.
        let poolOpts = opts;
        if ('captureStacks' in opts) {
            poolOpts = {};
            const keys = Object.keys(opts);
            for (let i = 0; i < keys.length; i++) {
                if (keys[i] !== 'captureStacks') poolOpts[keys[i]] = opts[keys[i]];
            }
        }

        this._pool = new ObjectPool(poolOpts);
        this._tags = new Map();      // pooled object -> { id, at } (no target capture)
        this._nextId = 1;
        this._totalAcquires = 0;
        this._totalReleases = 0;
        this._peakUsed = 0;
        this._scratch = {};          // owned, always-writable buffer for core stats
    }

    /**
     * Acquire an object and TAG the acquire site. Returns whatever the underlying
     * pool returns (an object, or null under onExhausted:"null"/"grow" at cap).
     * Allocates a tag record on a successful acquire -- this is the debug lane.
     * @returns {*|null}
     */
    acquire() {
        const o = this._pool.acquire();
        if (o !== null) {
            // The tag is a monotonic id plus an optional stack STRING; neither
            // closes over `o`, honouring lite-leak's held-value contract.
            this._tags.set(o, { id: this._nextId++, at: this._captureStacks ? new Error().stack : null });
            this._totalAcquires++;
            const u = this._pool.used;
            if (u > this._peakUsed) this._peakUsed = u;
        }
        return o;
    }

    /**
     * Release an object and drop its tag. Delegates the actual bookkeeping (and
     * every guard: foreign object throws, use-after-destroy throws, genuine
     * double-release returns false) to the underlying pool.
     * @param {*} obj
     * @returns {boolean}
     */
    release(obj) {
        const released = this._pool.release(obj);
        if (released) {
            this._tags.delete(obj);
            this._totalReleases++;
        }
        return released;
    }

    /** Release everything and clear all tags. */
    releaseAll() {
        this._totalReleases += this._pool.used;
        this._pool.releaseAll();
        this._tags.clear();
    }

    /** Iterate active objects (delegated). See ObjectPool.forEachActive. */
    forEachActive(callback, thisArg) {
        this._pool.forEachActive(callback, thisArg);
    }

    /** Drain, destroy, and drop all tags (delegated). Idempotent. */
    destroy() {
        this._pool.destroy();
        this._tags.clear();
    }

    /** Number of objects currently acquired (in use). */
    get used() { return this._pool.used; }
    /** Number of free objects available for acquire. */
    get free() { return this._pool.free; }
    /** Total pool size (all created objects). */
    get size() { return this._pool.size; }

    /** How many objects are currently acquired-but-not-released (tagged). */
    outstanding() { return this._tags.size; }

    /**
     * A fresh report naming every currently-acquired object by its tag. ALLOCATES
     * per call, by design -- a diagnostic read at human/telemetry rate, never a
     * frame loop. Each entry is `{ id, at }` where `at` is the captured acquire
     * stack (a string) or null when `captureStacks` is off.
     * @returns {Array<{id:number, at:(string|null)}>}
     */
    leaks() {
        const out = [];
        for (const rec of this._tags.values()) out.push({ id: rec.id, at: rec.at });
        return out;
    }

    /**
     * Zero-argument-safe? NO -- like the core, `out` must be an object. Writes the
     * four core fields plus the three moved counters (peakUsed / totalAcquires /
     * totalReleases) and returns `out`. The core write is delegated so this stays
     * in lockstep with ObjectPool.stats.
     * @param {Object} out
     * @returns {Object}
     */
    stats(out) {
        if (out === null || (typeof out !== 'object' && typeof out !== 'function')) {
            throw new TypeError('DebugObjectPool: "out" must be an object to receive stats, received ' + received(out));
        }
        // Same transactional fail-closed contract as ObjectPool.stats, over all
        // SEVEN fields: snapshot each field's prior OWN value and existence, write,
        // and on any non-writable slot roll `out` back to EXACTLY its prior shape
        // (present keys to their value, keys we created deleted) and throw naming
        // "out" -- never a half-written buffer, never a leftover key. Core values
        // come through an owned scratch (always writable), so a hostile `out`
        // cannot corrupt the read.
        const c = this._pool.stats(this._scratch);
        const hadSize = Object.hasOwn(out, 'size'), s0 = out.size;
        const hadUsed = Object.hasOwn(out, 'used'), u0 = out.used;
        const hadFree = Object.hasOwn(out, 'free'), f0 = out.free;
        const hadExp = Object.hasOwn(out, 'expansions'), e0 = out.expansions;
        const hadPeak = Object.hasOwn(out, 'peakUsed'), p0 = out.peakUsed;
        const hadAcq = Object.hasOwn(out, 'totalAcquires'), a0 = out.totalAcquires;
        const hadRel = Object.hasOwn(out, 'totalReleases'), r0 = out.totalReleases;
        try {
            out.size = c.size;
            out.used = c.used;
            out.free = c.free;
            out.expansions = c.expansions;
            out.peakUsed = this._peakUsed;
            out.totalAcquires = this._totalAcquires;
            out.totalReleases = this._totalReleases;
        } catch {
            undoStatSlot(out, 'size', hadSize, s0);
            undoStatSlot(out, 'used', hadUsed, u0);
            undoStatSlot(out, 'free', hadFree, f0);
            undoStatSlot(out, 'expansions', hadExp, e0);
            undoStatSlot(out, 'peakUsed', hadPeak, p0);
            undoStatSlot(out, 'totalAcquires', hadAcq, a0);
            undoStatSlot(out, 'totalReleases', hadRel, r0);
            throw new TypeError('DebugObjectPool: "out" is not writable for the stats fields (a frozen, sealed, or getter-only target)');
        }
        return out;
    }
}

/**
 * A @zakkster/lite-leak kernel that reports this pool's
 * ACQUIRED-NEVER-RELEASED objects. `audit()` + `count()` ONLY -- no `install()`,
 * no `patchSurfaces`, no `refine()`. A refine()/FinalizationRegistry kernel would
 * report clean forever here (D6.9): `ObjectPool._items[]` retains every pooled
 * object, so a checked-out object is never collected and the FR never fires. This
 * kernel instead reads the wrapper's OWN outstanding tags, which is where the
 * signal actually is.
 *
 * @param {DebugObjectPool} debugPool The wrapper to observe.
 * @param {{name?:string}} [options]
 * @returns {{name:string, count:()=>number, audit:()=>Array}}
 */
export function createPoolLeakKernel(debugPool, options) {
    if (!debugPool || typeof debugPool.outstanding !== 'function' || typeof debugPool.leaks !== 'function') {
        throw new TypeError('createPoolLeakKernel: first argument must be a DebugObjectPool');
    }
    const opts = options || {};
    const name = typeof opts.name === 'string' && opts.name ? opts.name : 'object-pool-leak';
    return {
        name,
        // No install/patchSurfaces: a kernel with only count()/audit() is legal
        // (lite-leak llms.txt: "Kernels with only refine()/audit() and no
        // install() are legal").
        count() {
            return debugPool.outstanding();
        },
        audit() {
            const leaks = debugPool.leaks();
            const findings = new Array(leaks.length);
            for (let i = 0; i < leaks.length; i++) {
                findings[i] = {
                    kind: 'object-pool-leak',
                    reason: 'acquired-not-released',
                    tag: leaks[i].id,
                    origin: leaks[i].at,
                };
            }
            return findings;
        },
    };
}

export default DebugObjectPool;
