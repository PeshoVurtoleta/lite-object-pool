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
    /** Initial pool size (preallocated). A finite integer >= 0. Default: 32 */
    size?: number;
    /** Auto-expand when exhausted. A strict boolean. Default: true */
    expand?: boolean;
    /** Ceiling on expansion. A finite integer >= 0 or Infinity, and must be >= `size`. Default: Infinity */
    maxSize?: number;
}

export class ObjectPool<T = any> {
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
     * @throws {TypeError} If `create` is not a function.
     * @throws {TypeError} If `reset` is provided and is not a function.
     * @throws {TypeError} If `size` is not a finite integer >= 0.
     * @throws {TypeError} If `maxSize` is not a finite integer >= 0 or Infinity.
     * @throws {TypeError} If `expand` is provided and is not a boolean.
     * @throws {TypeError} If `maxSize` is less than `size`.
     */
    constructor(options: ObjectPoolOptions<T>);

    /**
     * Acquire an object from the pool.
     * If the pool is empty and `expand` is true (and under `maxSize`), a new object is created.
     * If the pool is empty and `expand` is false (or at `maxSize`), returns null.
     *
     * @returns The acquired object, or null if unavailable.
     */
    acquire(): T | null;

    /**
     * Release an object back into the pool.
     * Calls `reset()` to clean the object for reuse.
     *
     * Silently ignores double-releases and foreign objects (O(1) guard).
     *
     * @param obj The object to release.
     * @returns true if released, false if ignored.
     */
    release(obj: T): boolean;

    /**
     * Release all currently acquired objects back into the pool.
     * Calls `reset()` on each. Useful for scene transitions or level resets.
     */
    releaseAll(): void;

    /**
     * Execute a callback for every currently acquired (active) object.
     * Ideal for game loops -- update/draw all active objects without
     * maintaining a separate array or accessing private fields.
     */
    forEachActive(callback: (obj: T) => void): void;

    /**
     * Destroy the pool and release all references.
     * Idempotent -- safe to call multiple times.
     */
    destroy(): void;
}

export default ObjectPool;
