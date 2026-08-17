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
 * (structure + WeakMap selection), D2 (order), D3 (iteration), D4 (exhaustion),
 * D5 (the 2.1.0 option reshape).
 *
 * v2.1.0 adds the ADDITIVE option triple {capacity, prealloc, onExhausted} (D5).
 * The legacy {size, expand, maxSize} spelling keeps working as PERMANENT aliases;
 * the two vocabularies are mutually exclusive and mixing them throws. All of it
 * is constructor-cold -- the hot bodies are byte-identical to 2.0.0.
 *
 * v2.2.0 adds zero-allocation observability: stats(out) fills a caller-provided
 * object with {size, used, free, expansions} and allocates nothing (D6). The hot
 * bodies stay byte-identical -- `expansions` is counted only on the cold _grow
 * branch, and the acquire-site tagging / leak counters that WOULD cost the hot
 * path live in the separate `@zakkster/lite-object-pool/debug` subpath, off the
 * production path entirely (D6, measured: the counters moved rather than ship in
 * acquire/release). NOTE: lite-gc-profiler's watchPool cannot observe an
 * acquired-never-released object from this pool, because _items[] retains every
 * pooled object for the pool's whole lifetime -- see the /debug subpath and D6.9.
 *
 * Features:
 * - Preallocates objects for GC-free reuse -- zero allocation on the hot path
 * - Optional auto-expansion in bounded chunks with a capacity ceiling
 * - onExhausted policy: return null, grow, or throw (a distinct capped-vs-
 *   exhausted message) when acquire() cannot serve
 * - O(1) acquire, release, and double-release protection (no hash on the hot path)
 * - forEachActive() reverse iteration -- releasing the current object is safe
 * - User-defined create() and reset() callbacks
 * - Stats: size, used, free, expansions -- via getters and zero-alloc stats(out)
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
export const VERSION = '2.3.0';

/** The only option keys this version recognizes. Anything else is rejected at
 *  construction (fail closed on an unverified state). The 2.1.0 canonical triple
 *  (capacity/prealloc/onExhausted) and the permanent legacy aliases
 *  (size/expand/maxSize) are both listed; mixing the two vocabularies is caught
 *  separately in the constructor (D5). */
const ALLOWED_KEYS = ['create', 'reset', 'size', 'expand', 'maxSize', 'capacity', 'prealloc', 'onExhausted'];

/** The legacy alias vocabulary and the 2.1.0 canonical vocabulary. Presence of
 *  any key from each set in the same options object is a contradiction (D5). */
const LEGACY_KEYS = ['size', 'expand', 'maxSize'];
const CANONICAL_KEYS = ['capacity', 'prealloc', 'onExhausted'];

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

/**
 * Restore ONE stats slot during a failed stats() write, so `out` is left in its
 * EXACT prior shape -- not merely free of stale values. A slot that existed as an
 * own property before the write is put back to its saved value; a slot this write
 * CREATED (absent before) is DELETED, never left as a fresh `undefined` key (a
 * plain assignment makes a configurable property, so the delete cannot fail).
 * Guarded per slot so one non-writable field cannot skip another's cleanup. Cold:
 * the stats() throw path only; never runs when `out` is writable.
 * @param {Object} out
 * @param {string} key
 * @param {boolean} had  Was `key` an own property of `out` before the write?
 * @param {*} val         Its saved prior value (used only when `had`).
 */
function undoStatSlot(out, key, had, val) {
    try {
        if (had) out[key] = val;
        else delete out[key];
    } catch { /* a non-writable pre-existing slot was never changed; nothing to undo */ }
}

export class ObjectPool {
    /**
     * @param {Object} options
     * @param {Function} options.create        Factory function that returns a new object
     * @param {Function} [options.reset]       Called on release to clean an object for reuse
     * @param {number|"eager"|"lazy"} [options.prealloc]  How many of `capacity` to build now. Default: 32
     * @param {number}   [options.capacity]    Upper bound on total objects. Default: Infinity
     * @param {"null"|"grow"|"throw"} [options.onExhausted]  What acquire() does when it cannot serve. Default: "grow"
     * @param {number}   [options.size]        Legacy alias for `prealloc` (a count). Default: 32
     * @param {boolean}  [options.expand]      Legacy alias for `onExhausted` (true="grow", false="null"). Default: true
     * @param {number}   [options.maxSize]     Legacy alias for `capacity`. Default: Infinity
     */
    constructor(options) {
        const { create, reset = NOOP } = options;

        // --- create / reset validation (P1, v1.1.0 -- unchanged) --------------
        // Constructor-cold: runs once at construction, never on the hot path.
        // Every message is prefixed `ObjectPool: "<option>"` so the library and
        // the offending option are both greppable.
        if (typeof create !== 'function') {
            throw new TypeError('ObjectPool: "create" is required and must be a function, received ' + received(create));
        }
        if (typeof reset !== 'function') {
            throw new TypeError('ObjectPool: "reset" must be a function if provided, received ' + received(reset));
        }

        // --- Option vocabulary: legacy aliases vs the 2.1.0 canonical triple ---
        // ONE alias-fold site (D5). The legacy {size, expand, maxSize} and the
        // canonical {capacity, prealloc, onExhausted} vocabularies are MUTUALLY
        // EXCLUSIVE: mixing any key from each throws, because letting one win
        // silently reintroduces the contradiction class this reshape deletes.
        // `undefined` counts as ABSENT (an explicit `key: undefined` is not
        // "provided"), matching 2.0.0's optional-key rule. Aliases are permanent
        // and never warned -- a constructor warn is an allocation and a side
        // effect this library does not have. Everything below normalizes to the
        // internal triple `_expand` / `_maxSize` / `_onExh` so the rest of the
        // class reads only the canonical shape.
        const { size, expand, maxSize, capacity, prealloc, onExhausted } = options;
        const legacyKey = size !== undefined ? 'size' : expand !== undefined ? 'expand' : maxSize !== undefined ? 'maxSize' : null;
        const canonKey = capacity !== undefined ? 'capacity' : prealloc !== undefined ? 'prealloc' : onExhausted !== undefined ? 'onExhausted' : null;
        if (legacyKey !== null && canonKey !== null) {
            throw new TypeError('ObjectPool: "' + legacyKey + '" (a legacy alias) and "' + canonKey +
                '" (the 2.1.0 spelling) set the same pool from two vocabularies -- use one, not both. ' +
                'The aliases size/expand/maxSize map to prealloc/onExhausted/capacity.');
        }

        // Normalize BOTH spellings to (preallocSpec, cap, onExh). The legacy path
        // keeps its 2.0.0 validation messages byte-identical (tests pin them);
        // the canonical path names capacity/prealloc/onExhausted. Defaults are
        // 2.0.0-equal in either vocabulary: prealloc 32, capacity Infinity,
        // onExhausted "grow" (D5 records this as a deliberate overturn of the
        // roadmap's eager + fail-closed default, which would have been breaking).
        let preallocSpec;
        let cap;
        let onExh;
        if (canonKey !== null) {
            cap = capacity === undefined ? Infinity : capacity;
            preallocSpec = prealloc === undefined ? 32 : prealloc;
            onExh = onExhausted === undefined ? 'grow' : onExhausted;

            if (cap !== Infinity && (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0)) {
                throw new TypeError('ObjectPool: "capacity" must be a finite integer >= 0 or Infinity, received ' + received(cap));
            }
            if (onExh !== 'null' && onExh !== 'grow' && onExh !== 'throw') {
                throw new TypeError('ObjectPool: "onExhausted" must be "null", "grow", or "throw", received ' + received(onExhausted));
            }
            if (preallocSpec === 'eager') {
                if (cap === Infinity) {
                    throw new TypeError('ObjectPool: "prealloc" is "eager" but "capacity" is Infinity -- an eager pool needs a finite capacity to build, or it would allocate forever');
                }
                preallocSpec = cap;
            } else if (preallocSpec === 'lazy') {
                preallocSpec = 0;
            } else if (typeof preallocSpec !== 'number' || !Number.isInteger(preallocSpec) || preallocSpec < 0) {
                throw new TypeError('ObjectPool: "prealloc" must be a finite integer >= 0, "eager", or "lazy", received ' + received(prealloc));
            }
            if (cap < preallocSpec) {
                throw new TypeError('ObjectPool: "capacity" (' + cap + ') must be >= "prealloc" (' + preallocSpec + ')');
            }
        } else {
            // Legacy vocabulary (or nothing at all -> 2.0.0 defaults). Validation
            // order and messages are byte-identical to 2.0.0: size -> maxSize ->
            // expand -> the maxSize >= size contradiction.
            const sz = size === undefined ? 32 : size;
            const mx = maxSize === undefined ? Infinity : maxSize;
            const ex = expand === undefined ? true : expand;
            if (typeof sz !== 'number' || !Number.isInteger(sz) || sz < 0) {
                throw new TypeError('ObjectPool: "size" must be a finite integer >= 0, received ' + received(sz));
            }
            if (mx !== Infinity && (typeof mx !== 'number' || !Number.isInteger(mx) || mx < 0)) {
                throw new TypeError('ObjectPool: "maxSize" must be a finite integer >= 0 or Infinity, received ' + received(mx));
            }
            if (typeof ex !== 'boolean') {
                throw new TypeError('ObjectPool: "expand" must be a boolean if provided, received ' + received(ex));
            }
            if (mx < sz) {
                throw new TypeError('ObjectPool: "maxSize" (' + mx + ') must be >= "size" (' + sz + ')');
            }
            preallocSpec = sz;
            cap = mx;
            onExh = ex ? 'grow' : 'null';
        }

        // Unknown-key rejection (fail closed). Ordered AFTER the per-option
        // checks so a caller passing both a bad `size` and a typo'd key still
        // gets the `size` error first. Constructor-cold. Any unknown key gets a
        // did-you-mean hint over the eight known names.
        for (const key of Object.keys(options)) {
            if (ALLOWED_KEYS.indexOf(key) !== -1) continue;
            const hint = suggestKey(key);
            throw new TypeError(
                'ObjectPool: "' + key + '" is not a recognized option' +
                (hint ? '; did you mean "' + hint + '"?' : '.') +
                ' Known options: create, reset, capacity, prealloc, onExhausted (or the aliases size, expand, maxSize)');
        }

        this._create = create;
        this._reset = reset;
        // Internal exhaustion triple, pre-normalized from either vocabulary.
        // `_expand` (grow policy) and `_onExh` (how a non-growing miss is
        // reported) are the only things the cold `_grow` reads.
        this._onExh = onExh;
        this._expand = onExh === 'grow';
        this._maxSize = cap;
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
        this._expansions = 0; // times _grow built a chunk (cold; reported by stats)

        // Preallocation of `preallocSpec` objects. Validation guarantees it is a
        // clean integer and `capacity >= preallocSpec`. `prealloc:"eager"` has
        // already been resolved to the (finite) capacity above.
        if (preallocSpec > 0) {
            this._reserve(preallocSpec);
            for (let i = 0; i < preallocSpec; i++) this._append(create());
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
        if (!this._expand || this._size >= this._maxSize) {
            // Cannot serve: growth is off, or the pool is grown to capacity. The
            // ONE onExhausted branch (D5). "throw" reports the miss as a caller
            // bug with DISTINCT text -- capped-at-capacity vs exhausted-below-it.
            // "null" (and the capped case under "grow") return null and still
            // conflate the two: OP-04's remainder, kept on purpose for the
            // game-loop caller who treats "no object this frame" as one thing.
            if (this._onExh === 'throw') {
                throw new Error(this._size >= this._maxSize
                    ? 'ObjectPool: acquire() exceeded capacity ' + this._maxSize + ' (onExhausted:"throw")'
                    : 'ObjectPool: acquire() on an exhausted pool of ' + this._size + ' object(s) (onExhausted:"throw")');
            }
            return null;
        }

        const room = this._maxSize - this._size;         // Infinity - n stays Infinity
        const n = room < GROW_CHUNK ? room : GROW_CHUNK;
        this._reserve(this._size + n);
        const create = this._create;
        for (let k = 0; k < n; k++) this._append(create());
        this._expansions++;                              // cold: never on the hot body

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
     * Write the pool's stats into a caller-provided object and return it,
     * allocating nothing (D6). Telemetry-rate (~10 Hz), not a hot path.
     *
     * Fields: `size` / `used` / `free` (the getters) and `expansions` (how many
     * times _grow built a chunk -- counted on the cold growth branch, so
     * reporting it costs the acquire hot body nothing). The observability
     * counters `peakUsed` / `totalAcquires` / `totalReleases` are NOT here: a
     * measurement moved them off the hot path into the `/debug` subpath (D6.6),
     * so this method reports only what is free.
     *
     * Fails closed: `out` MUST be an object (or function) to receive the fields.
     * A non-object -- including `undefined` (so a no-arg `stats()` throws rather
     * than silently allocating a fresh object in a package whose identity is the
     * absence of one), `null`, or a primitive -- throws a `TypeError` naming
     * `"out"`. There is no shared module-level buffer to alias, by design.
     *
     * @param {Object} out Caller object mutated in place and returned.
     * @returns {Object} the same `out`.
     */
    stats(out) {
        if (out === null || (typeof out !== 'object' && typeof out !== 'function')) {
            throw new TypeError('ObjectPool: "out" must be an object to receive stats, received ' + received(out));
        }
        // Fail closed WITHOUT half-writing, and WITHOUT leaving behind keys we
        // created. A frozen / sealed-empty / getter-only `out` cannot take every
        // field; a naive four-line write would set the writable ones and then
        // throw a native error on the first non-writable one, leaving the caller a
        // buffer that is three-quarters fresh and one-quarter stale -- silently
        // wrong telemetry. So this is TRANSACTIONAL: snapshot each field's prior
        // OWN value and whether it existed, write all four, and on ANY
        // non-writable slot roll `out` back to EXACTLY its prior shape (present
        // keys to their value, keys we created deleted), then throw a TypeError
        // naming "out". Rollback, not descriptor pre-validation, because
        // Object.getOwnPropertyDescriptor allocates a descriptor object per key --
        // that would break the T6 `stats(out) === 0` gate. Object.hasOwn and
        // primitive reads/writes do not allocate, so the writable common path
        // stays zero-alloc.
        const hadSize = Object.hasOwn(out, 'size'), s0 = out.size;
        const hadUsed = Object.hasOwn(out, 'used'), u0 = out.used;
        const hadFree = Object.hasOwn(out, 'free'), f0 = out.free;
        const hadExp = Object.hasOwn(out, 'expansions'), e0 = out.expansions;
        try {
            out.size = this._size;
            out.used = this._active;
            out.free = this._size - this._active;
            out.expansions = this._expansions;
        } catch {
            undoStatSlot(out, 'size', hadSize, s0);
            undoStatSlot(out, 'used', hadUsed, u0);
            undoStatSlot(out, 'free', hadFree, f0);
            undoStatSlot(out, 'expansions', hadExp, e0);
            throw new TypeError('ObjectPool: "out" is not writable for the stats fields (a frozen, sealed, or getter-only target)');
        }
        return out;
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
