/**
 * @zakkster/lite-object-pool -- Zero-dependency Object Pool
 *
 * Formerly published unscoped as `lite-object-pool`, which is deprecated and
 * ends at v1.0.2. All releases from 1.0.3 forward are scoped.
 */

/** Package version. Kept in sync with package.json and llms.txt. */
export const VERSION: string;

export interface ObjectPoolOptions<T> {
    /** Factory function that returns a new object. Required. */
    create: () => T;
    /** Called on release to clean an object for reuse. Default: no-op */
    reset?: (obj: T) => void;

    // --- The 2.1.0 canonical vocabulary (D5) ---------------------------------
    /**
     * Upper bound on how many objects can ever exist. A finite integer >= 0 or
     * Infinity, and must be >= the resolved `prealloc` count. Default: Infinity.
     * Legacy alias: `maxSize`.
     */
    capacity?: number;
    /**
     * How much of `capacity` to build at construction: `"eager"` (all of it --
     * requires a finite `capacity`), `"lazy"` (none), or an integer count.
     * Default: 32. Legacy alias: `size`.
     */
    prealloc?: number | 'eager' | 'lazy';
    /**
     * What `acquire()` does when it cannot serve: `"null"` (return null),
     * `"grow"` (create a bounded chunk), or `"throw"` (throw with distinct
     * capped-vs-exhausted text). Default: "grow". Legacy alias: `expand`
     * (`true` = `"grow"`, `false` = `"null"`).
     */
    onExhausted?: 'null' | 'grow' | 'throw';

    // --- Permanent legacy aliases (2.0.0 spelling) ---------------------------
    // Accepted forever and never warned. The legacy and canonical vocabularies
    // are mutually exclusive: mixing any key from each set throws.
    /** Legacy alias for `prealloc` (a count). A finite integer >= 0. Default: 32 */
    size?: number;
    /** Legacy alias for `onExhausted`: `true` = `"grow"`, `false` = `"null"`. Default: true */
    expand?: boolean;
    /** Legacy alias for `capacity`. A finite integer >= 0 or Infinity, and must be >= `size`. Default: Infinity */
    maxSize?: number;
}

export class ObjectPool<T extends object = object> {
    /** Total pool size (all created objects, including expansions). */
    readonly size: number;
    /** Number of objects currently acquired (in use). */
    readonly used: number;
    /** Number of free objects available for acquire. */
    readonly free: number;

    /**
     * Create a new object pool.
     * Preallocates `size` objects immediately using the `create` callback.
     *
     * Every option is validated before any object is created. On a bad option
     * the constructor throws before calling `create`, so a rejected `maxSize`
     * or `size` never leaves half-built objects behind.
     *
     * Since 2.0.0, each pooled object is tracked by identity in a `WeakMap`, so
     * `create()` must return a distinct object (or function) each call: a
     * non-object return, or a duplicate identity, throws a `TypeError` naming
     * `create()`.
     *
     * @throws {TypeError} If `create` is not a function.
     * @throws {TypeError} If `reset` is provided and is not a function.
     * @throws {TypeError} If `size`/`prealloc` is not a finite integer >= 0 (or, for
     *   `prealloc`, one of `"eager"`/`"lazy"`).
     * @throws {TypeError} If `maxSize`/`capacity` is not a finite integer >= 0 or Infinity.
     * @throws {TypeError} If `expand` is provided and is not a boolean, or `onExhausted`
     *   is not `"null"`/`"grow"`/`"throw"`.
     * @throws {TypeError} If `capacity` is less than the resolved `prealloc` count.
     * @throws {TypeError} If `prealloc` is `"eager"` while `capacity` is Infinity.
     * @throws {TypeError} If any legacy alias (size/expand/maxSize) is mixed with any
     *   canonical name (capacity/prealloc/onExhausted) -- the two vocabularies are
     *   mutually exclusive (since 2.1.0).
     * @throws {TypeError} If `create()` returns a non-object or a duplicate identity.
     * @throws {TypeError} If `options` carries an unknown key (since 2.0.0). Keys are
     *   limited to create/reset/capacity/prealloc/onExhausted and the aliases
     *   size/expand/maxSize; anything else throws with a did-you-mean hint.
     */
    constructor(options: ObjectPoolOptions<T>);

    /**
     * Acquire an object from the pool. When the pool is empty, behaviour follows
     * `onExhausted` (the resolved policy): `"grow"` creates a bounded chunk (under
     * `capacity`), `"null"` returns null, and `"throw"` throws with distinct text
     * for the capped-at-capacity vs exhausted-below-it cases. At `capacity`,
     * `"grow"` returns null.
     *
     * @returns The acquired object, or null when exhausted/capped under "null"
     *   (or the capped case under "grow").
     * @throws {Error} If the pool has been destroyed (use-after-destroy), or under
     *   `onExhausted: "throw"` when the pool cannot serve.
     */
    acquire(): T | null;

    /**
     * Release an object back into the pool. Calls `reset()` to clean it for reuse.
     *
     * Returns `false` on a genuine double-release. Throws on a foreign object
     * (one this pool never issued, including null/undefined/primitives) and on
     * use-after-destroy -- both are caller bugs (since 2.0.0). No hash table and
     * no allocation on the hot path.
     *
     * @param obj The object to release.
     * @returns true if released, false on double-release.
     * @throws {TypeError} If `obj` was never issued by this pool.
     * @throws {Error} If the pool has been destroyed.
     */
    release(obj: T): boolean;

    /**
     * Release all currently acquired objects back into the pool.
     * Calls `reset()` on each. Useful for scene transitions or level resets.
     *
     * @throws {Error} If the pool has been destroyed.
     */
    releaseAll(): void;

    /**
     * Execute a callback for every currently acquired (active) object.
     *
     * Iterates in REVERSE (since 2.0.0): releasing the object currently passed to
     * your callback is safe and contractual. Calling `releaseAll()` mid-iteration
     * stops the walk; other structural mutation during iteration is unspecified.
     * Iteration ORDER is unspecified. Pass `thisArg` to bind the callback receiver
     * without allocating a bound closure per frame.
     *
     * @throws {Error} If the pool has been destroyed.
     */
    forEachActive(callback: (this: unknown, obj: T) => void, thisArg?: unknown): void;

    /**
     * Drain, then destroy the pool. Calls `reset()` on every object still checked
     * out (since 2.0.0), then releases references and marks the pool destroyed.
     * Idempotent -- a second call is a safe no-op. After destroy, acquire /
     * release / releaseAll / forEachActive throw.
     */
    destroy(): void;
}

export default ObjectPool;
