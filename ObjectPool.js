/**
 * @zakkster/lite-object-pool -- Zero-dependency Object Pool
 *
 * A tiny, fast, ES6 object pool for games, particles, scratch effects,
 * and any high-frequency object churn where GC spikes hurt performance.
 *
 * Formerly published unscoped as `lite-object-pool`. That name is deprecated
 * and ends at v1.0.2; every release from 1.0.3 forward is scoped.
 *
 * v2.0.0 replaces the v1 `_out` Set with a SPARSE SET: an `_items[]` object
 * store, a dense/sparse `Uint32Array` index pair, and an `_active` cursor.
 * `acquire()` is a cursor advance; `release()` is an O(1) swap-remove via a
 * per-object slot index kept in a per-instance `WeakMap`. Nothing on the hot
 * path allocates: a fully preallocated pool doing acquire / release /
 * releaseAll / forEachActive allocates ZERO bytes. See decisions/ for D1
 * (structure + WeakMap selection), D2 (order), D3 (iteration), D4 (exhaustion).
 *
 * Features:
 * - Preallocates objects for GC-free reuse -- zero allocation on the hot path
 * - Optional auto-expansion in bounded chunks with a maxSize ceiling
 * - O(1) acquire, release, and double-release protection (no hash on the hot path)
 * - forEachActive() reverse iteration -- releasing the current object is safe
 * - User-defined create() and reset() callbacks
 * - Stats: size, used, free
 * - Zero dependencies, single file
 */

/** Shared no-op used as the default reset so every pool without a reset
 *  callback references one function instance instead of allocating a fresh
 *  closure per constructor call. */
const NOOP = () => {};

/** Shared empty index array for a size:0 pool, so the zero case allocates no
 *  backing store until it actually grows. */
const EMPTY_U32 = new Uint32Array(0);

/** Object-creation chunk size for the growth path (OP-10). On a free-list miss
 *  a bounded, contiguous run of this many objects is constructed at once --
 *  never one-at-a-time (loses heap locality) and never a backing store sized to
 *  `maxSize` (a construction-time burst). Clamped by the remaining room to
 *  `maxSize`, so a finite cap still yields an exact `size`. */
const GROW_CHUNK = 256;

/** Package version. Kept in sync with package.json and llms.txt. */
export const VERSION = '2.0.0';

/** The only option keys this version recognizes. Anything else is rejected at
 *  construction (fail closed on an unverified state). */
const ALLOWED_KEYS = ['create', 'reset', 'size', 'expand', 'maxSize'];

/** Names reserved for the additive 2.1.0 capacity/prealloc reshape. A caller who
 *  reads the CHANGELOG and reaches for one today gets a version-specific answer
 *  instead of a generic "unknown option", so they are not left guessing whether
 *  they mistyped a name or picked the wrong version. */
const FUTURE_KEYS = {
    capacity: 'is not an option in 2.0.0; the capacity/prealloc reshape lands additively in 2.1.0. Use "size" and "maxSize".',
    prealloc: 'is not an option in 2.0.0; the capacity/prealloc reshape lands additively in 2.1.0. Use "size" (eager) or "expand".',
    onExhausted: 'is not an option in 2.0.0; the exhaustion-policy reshape lands additively in 2.1.0. Use "expand" and "maxSize".',
};

/**
 * Levenshtein edit distance between two short strings. Cold: called only on the
 * constructor error path, over the five known option names, so its per-call
 * array allocation never touches any hot path.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function editDistance(a, b) {
    const m = a.length;
    const n = b.length;
    const prev = new Array(n + 1);
    const cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        cur[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            let min = prev[j] + 1;
            if (cur[j - 1] + 1 < min) min = cur[j - 1] + 1;
            if (prev[j - 1] + cost < min) min = prev[j - 1] + cost;
            cur[j] = min;
        }
        for (let j = 0; j <= n; j++) prev[j] = cur[j];
    }
    return prev[n];
}

/**
 * The closest known option name to `key` within edit distance 2 (case-folded so
 * `Size`/`maxsize` resolve), or null when nothing is close. Cold path only.
 * @param {string} key
 * @returns {string|null}
 */
function suggestKey(key) {
    const lk = key.toLowerCase();
    let best = null;
    let bestD = 3;
    for (let i = 0; i < ALLOWED_KEYS.length; i++) {
        const d = editDistance(lk, ALLOWED_KEYS[i].toLowerCase());
        if (d < bestD) { bestD = d; best = ALLOWED_KEYS[i]; }
    }
    return bestD <= 2 ? best : null;
}

/**
 * Render a rejected value for an error message, e.g. `2.5 (number)`.
 * Cold: this runs only on a throw path, never on any hot path. `String(symbol)`
 * throws, so symbols are stringified defensively.
 * @param {*} v
 * @returns {string}
 */
function received(v) {
    return (typeof v === 'symbol' ? v.toString() : String(v)) + ' (' + typeof v + ')';
}

export class ObjectPool {
    /**
     * @param {Object} options
     * @param {Function} options.create   Factory function that returns a new object
     * @param {Function} [options.reset]  Called on release to clean an object for reuse
     * @param {number}   [options.size]   Initial pool size (preallocated). Default: 32
     * @param {boolean}  [options.expand] Auto-expand when exhausted. Default: true
     * @param {number}   [options.maxSize] Maximum pool size (prevents runaway expansion). Default: Infinity
     */
    constructor(options) {
        const { create, reset = NOOP, size = 32, expand = true, maxSize = Infinity } = options;

        // --- Option validation (P1, v1.1.0 -- unchanged) ----------------------
        // Every check here is constructor-cold: it runs once, at construction,
        // and never on acquire()/release()/forEachActive(). One TypeError per
        // bad option, every message prefixed `ObjectPool: "<option>"` so the
        // library and the offending option are both greppable. Ordered
        // create -> reset -> size -> maxSize -> expand -> the maxSize>=size
        // contradiction, so the contradiction is only reported once both
        // numbers are known-clean.
        if (typeof create !== 'function') {
            throw new TypeError('ObjectPool: "create" is required and must be a function, received ' + received(create));
        }
        if (typeof reset !== 'function') {
            throw new TypeError('ObjectPool: "reset" must be a function if provided, received ' + received(reset));
        }
        if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
            throw new TypeError('ObjectPool: "size" must be a finite integer >= 0, received ' + received(size));
        }
        if (maxSize !== Infinity && (typeof maxSize !== 'number' || !Number.isInteger(maxSize) || maxSize < 0)) {
            throw new TypeError('ObjectPool: "maxSize" must be a finite integer >= 0 or Infinity, received ' + received(maxSize));
        }
        if (typeof expand !== 'boolean') {
            throw new TypeError('ObjectPool: "expand" must be a boolean if provided, received ' + received(expand));
        }
        if (maxSize < size) {
            throw new TypeError('ObjectPool: "maxSize" (' + maxSize + ') must be >= "size" (' + size + ')');
        }

        // Unknown-key rejection (fail closed on an unverified state). Ordered
        // AFTER the P1 per-option checks so a caller passing both a bad `size`
        // and a typo'd key still gets the `size` error first -- P1's messages and
        // their order stay byte-identical. Constructor-cold: the hot path gains
        // nothing. A key reserved for 2.1.0 gets a version-specific message; any
        // other unknown key gets a did-you-mean hint over the five known names.
        for (const key of Object.keys(options)) {
            if (ALLOWED_KEYS.indexOf(key) !== -1) continue;
            if (Object.prototype.hasOwnProperty.call(FUTURE_KEYS, key)) {
                throw new TypeError('ObjectPool: "' + key + '" ' + FUTURE_KEYS[key]);
            }
            const hint = suggestKey(key);
            throw new TypeError(
                'ObjectPool: "' + key + '" is not a recognized option' +
                (hint ? '; did you mean "' + hint + '"?' : '.') +
                ' Known options: create, reset, size, expand, maxSize');
        }

        this._create = create;
        this._reset = reset;
        this._expand = expand;
        this._maxSize = maxSize;
        this._destroyed = false;

        // --- Sparse-set core (D1) ---------------------------------------------
        // _items[i]         : the i-th created object.
        // _dense[0.._active-1] : item indices currently checked out.
        // _dense[_active.._size-1] : item indices free for acquire.
        // _sparse[itemIndex] : that item's position in _dense (inverse permutation).
        // _slots.get(obj)    : the item index of obj -- written ONCE at create
        //                      time, only READ on the hot path (reads never
        //                      rehash, so the hot path is zero-alloc).
        this._items = [];
        this._dense = EMPTY_U32;
        this._sparse = EMPTY_U32;
        this._slots = new WeakMap();
        this._capacity = 0; // length of the typed-array backing store
        this._size = 0;     // number of objects actually created
        this._active = 0;   // cursor: how many are checked out

        // Eager preallocation of `size` objects. Validation guarantees `size`
        // is a clean integer and `maxSize >= size`.
        if (size > 0) {
            this._reserve(size);
            for (let i = 0; i < size; i++) this._append(create());
        }
    }

    /**
     * Ensure the typed-array backing store holds at least `n` slots. On the
     * first reserve (construction) capacity is set EXACTLY to `n` so a
     * preallocated pool carries no slack; on later growth capacity doubles, so
     * the growth path reallocates the index arrays amortized O(1) rather than on
     * every acquire (OP-10: not a per-frame regrow, not sized to `maxSize`).
     * Cold: never called on the steady-state hot path.
     * @param {number} n
     */
    _reserve(n) {
        let cap = this._capacity;
        if (cap >= n) return;
        if (cap === 0) cap = n;
        else while (cap < n) cap *= 2;
        const dense = new Uint32Array(cap);
        const sparse = new Uint32Array(cap);
        dense.set(this._dense);
        sparse.set(this._sparse);
        this._dense = dense;
        this._sparse = sparse;
        this._items.length = cap;
        this._capacity = cap;
    }

    /**
     * Register one freshly-created object at the next item index. Enforces the
     * D1 fail-closed contract on create() return values: an object (or function)
     * that this pool does not already track. Cold: create-time only.
     * @param {*} o
     */
    _append(o) {
        if ((typeof o !== 'object' && typeof o !== 'function') || o === null) {
            throw new TypeError('ObjectPool: create() must return a non-null object, received ' + received(o));
        }
        if (this._slots.has(o)) {
            throw new TypeError('ObjectPool: create() returned an object this pool already holds; each pooled object must be a distinct identity');
        }
        const idx = this._size;
        this._slots.set(o, idx);
        this._items[idx] = o;
        this._dense[idx] = idx;
        this._sparse[idx] = idx;
        this._size = idx + 1;
    }

    /**
     * Acquire an object from the pool.
     * Returns null when exhausted (expand:false) or capped (at maxSize).
     * Throws when the pool has been destroyed (a caller bug -- D4).
     *
     * @returns {*|null}
     */
    acquire() {
        const a = this._active;
        if (a < this._size) {
            this._active = a + 1;
            return this._items[this._dense[a]];
        }
        return this._grow();
    }

    /**
     * Cold path for acquire: destroyed / capped / grow-then-serve. Kept out of
     * the fast body so acquire carries a single hot branch (D4).
     * @returns {*|null}
     */
    _grow() {
        if (this._destroyed) {
            throw new Error('ObjectPool: acquire() called on a destroyed pool');
        }
        if (!this._expand || this._size >= this._maxSize) return null;

        const room = this._maxSize - this._size;         // Infinity - n stays Infinity
        const n = room < GROW_CHUNK ? room : GROW_CHUNK;
        this._reserve(this._size + n);
        const create = this._create;
        for (let k = 0; k < n; k++) this._append(create());

        const a = this._active;
        this._active = a + 1;
        return this._items[this._dense[a]];
    }

    /**
     * Release an object back into the pool. Calls reset() to clean it for reuse.
     *
     * Returns false on a genuine double-release. Throws on a foreign object (one
     * this pool never issued) and on use-after-destroy (D4). No hash table and
     * no allocation on the checked-out fast path.
     *
     * @param {*} obj
     * @returns {boolean} true if released, false on double-release
     */
    release(obj) {
        const idx = this._slots.get(obj);
        if (idx === undefined) return this._releaseMiss(true);
        const pos = this._sparse[idx];
        if (pos >= this._active) return this._releaseMiss(false);

        const a = this._active - 1;
        this._active = a;
        if (pos !== a) {
            const lastIdx = this._dense[a];
            this._dense[pos] = lastIdx;
            this._sparse[lastIdx] = pos;
            this._dense[a] = idx;
            this._sparse[idx] = a;
        }
        this._reset(obj);
        return true;
    }

    /**
     * Cold path for release: distinguish foreign / double / destroyed (D4).
     * @param {boolean} foreign true when the object was never issued by this pool
     * @returns {false}
     */
    _releaseMiss(foreign) {
        if (this._destroyed) {
            throw new Error('ObjectPool: release() called on a destroyed pool');
        }
        if (foreign) {
            throw new TypeError('ObjectPool: release() called with an object this pool did not issue');
        }
        return false; // genuine double-release
    }

    /**
     * Release all currently acquired objects back into the pool.
     * Reverse for-loop, no iterator. Throws on use-after-destroy (D4).
     */
    releaseAll() {
        if (this._destroyed) {
            throw new Error('ObjectPool: releaseAll() called on a destroyed pool');
        }
        const items = this._items;
        const dense = this._dense;
        const reset = this._reset;
        for (let i = this._active - 1; i >= 0; i--) reset(items[dense[i]]);
        this._active = 0;
    }

    /**
     * Execute a callback for every currently acquired (active) object.
     *
     * Iterates the dense array in REVERSE (D3): releasing the object currently
     * passed to your callback is safe and contractual -- the swap-remove moves an
     * already-visited tail element into the slot you just left, so nothing is
     * skipped or double-visited. Calling releaseAll() mid-iteration stops the
     * walk. Other structural mutation during iteration is unspecified. Iteration
     * ORDER is unspecified (D2). An optional thisArg avoids a bound closure per
     * frame. Throws on use-after-destroy (D4).
     *
     * @param {Function} callback Called with each active object
     * @param {*} [thisArg] Receiver bound as `this` inside the callback
     */
    forEachActive(callback, thisArg) {
        if (this._destroyed) {
            throw new Error('ObjectPool: forEachActive() called on a destroyed pool');
        }
        // Validate the callback ONCE, before the loop, so the answer does not
        // depend on whether the pool happens to hold active objects: a bad
        // callback is always a named error, never a raw `callback.call is not a
        // function` on a non-empty pool and a silent no-op on an empty one. Cold:
        // one check, nothing added to the loop body.
        if (typeof callback !== 'function') {
            throw new TypeError('ObjectPool: "callback" must be a function, received ' + received(callback));
        }
        for (let i = this._active - 1; i >= 0; i--) {
            if (i < this._active) callback.call(thisArg, this._items[this._dense[i]]);
        }
    }

    /** Number of objects currently in use (acquired). */
    get used() {
        return this._active;
    }

    /** Number of free objects available for acquire. */
    get free() {
        return this._size - this._active;
    }

    /** Total pool size (all created objects). */
    get size() {
        return this._size;
    }

    /**
     * Drain, then destroy the pool (D4, OP-09). Calls reset() on every object
     * still checked out, then releases object references and marks the pool
     * destroyed. Idempotent -- a second call is a safe no-op. After destroy,
     * acquire / release / releaseAll / forEachActive throw.
     */
    destroy() {
        if (this._destroyed) return;

        // Drain: reset everything still out so the caller's cleanup runs.
        const items = this._items;
        const dense = this._dense;
        const reset = this._reset;
        for (let i = this._active - 1; i >= 0; i--) reset(items[dense[i]]);

        this._destroyed = true;
        this._active = 0;
        this._size = 0;
        this._items = null; // release object references
        this._create = null;
        this._reset = null;
        // _dense / _sparse (index-only, no object refs) and _slots (weak) are
        // kept so a post-destroy release() routes to the cold destroyed throw
        // instead of dereferencing null.
    }
}

export default ObjectPool;
