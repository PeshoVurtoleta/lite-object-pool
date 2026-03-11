/**
 * lite-object-pool — Zero-dependency Object Pool
 *
 * A tiny, fast, ES6 object pool for games, particles, scratch effects,
 * and any high-frequency object churn where GC spikes hurt performance.
 *
 * Features:
 * - Preallocates objects for GC-free reuse
 * - Optional auto-expansion with maxSize safety cap
 * - O(1) acquire, release, and double-release protection
 * - forEachActive() for game loop iteration without exposing internals
 * - User-defined create() and reset() callbacks
 * - Stats: size, used, free
 * - Zero dependencies, < 1 KB
 */

export class ObjectPool {
    /**
     * @param {Object} options
     * @param {Function} options.create   Factory function that returns a new object
     * @param {Function} [options.reset]  Called on release to clean an object for reuse
     * @param {number}   [options.size]   Initial pool size (preallocated). Default: 32
     * @param {boolean}  [options.expand] Auto-expand when exhausted. Default: true
     * @param {number}   [options.maxSize] Maximum pool size (prevents runaway expansion). Default: Infinity
     */
    constructor({ create, reset = () => {}, size = 32, expand = true, maxSize = Infinity }) {
        if (typeof create !== 'function') {
            throw new TypeError('ObjectPool: "create" callback is required and must be a function');
        }

        this._create = create;
        this._reset = reset;
        this._expand = expand;
        this._maxSize = maxSize;
        this._destroyed = false;
        this._totalCreated = size;

        // Free list (stack) — acquire is pop(), release is push(), both O(1)
        this._free = new Array(size);
        for (let i = 0; i < size; i++) {
            this._free[i] = create();
        }

        // O(1) double-release and foreign-object guard.
        // Tracks objects currently "checked out" (acquired but not yet released).
        // Set.has() / .add() / .delete() are all O(1) — no performance penalty.
        this._out = new Set();
    }

    /**
     * Acquire an object from the pool.
     * Returns null if empty and expand is disabled.
     *
     * @returns {*|null}
     */
    acquire() {
        if (this._destroyed) return null;

        let obj;

        if (this._free.length > 0) {
            obj = this._free.pop();
        } else if (this._expand && this._totalCreated < this._maxSize) {
            obj = this._create();
            this._totalCreated++;
        } else {
            return null;
        }

        this._out.add(obj);
        return obj;
    }

    /**
     * Release an object back into the pool.
     * Calls reset() to ensure clean reuse.
     *
     * Silently ignores double-releases and foreign objects (O(1) check).
     *
     * @param {*} obj
     * @returns {boolean} true if released, false if ignored
     */
    release(obj) {
        if (this._destroyed) return false;

        // O(1) guard: skip if not checked out (double-release or foreign object)
        if (!this._out.delete(obj)) return false;

        this._reset(obj);
        this._free.push(obj);
        return true;
    }

    /**
     * Release all currently acquired objects back into the pool.
     * Useful for scene transitions or level resets.
     */
    releaseAll() {
        if (this._destroyed) return;

        for (const obj of this._out) {
            this._reset(obj);
            this._free.push(obj);
        }
        this._out.clear();
    }

    /**
     * Execute a callback for every currently acquired (active) object.
     * Ideal for game loops — update/draw all active particles without
     * maintaining a separate array or accessing private fields.
     *
     * @param {Function} callback Called with each active object
     */
    forEachActive(callback) {
        if (this._destroyed) return;
        for (const obj of this._out) {
            callback(obj);
        }
    }

    /** Number of objects currently in use (acquired). */
    get used() {
        return this._out.size;
    }

    /** Number of free objects available for acquire. */
    get free() {
        return this._free.length;
    }

    /** Total pool size (all created objects). */
    get size() {
        return this._totalCreated;
    }

    /**
     * Destroy the pool and release all references.
     * Idempotent — safe to call multiple times.
     */
    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;

        this._free.length = 0;
        this._out.clear();
        this._create = null;
        this._reset = null;
    }
}

export default ObjectPool;
