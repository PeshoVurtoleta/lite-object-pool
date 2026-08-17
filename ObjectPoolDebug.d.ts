/**
 * @zakkster/lite-object-pool/debug -- types for the debug lane (D6).
 *
 * This subpath ALLOCATES BY DESIGN and never loads in production. See
 * ObjectPoolDebug.js and decisions/D6-debug-lane.md.
 */

import type { ObjectPoolOptions, ObjectPoolStats } from './ObjectPool.js';

/** DebugObjectPool options: ObjectPool's options plus a debug-only key. */
export interface DebugObjectPoolOptions<T extends object = object> extends ObjectPoolOptions<T> {
    /**
     * Capture `new Error().stack` per acquire so `leaks()` can name the acquire
     * site. Default false. Expensive (~1.2 KB/acquire); stripped before the
     * options reach ObjectPool, whose constructor rejects unknown keys.
     */
    captureStacks?: boolean;
}

/**
 * What `DebugObjectPool.stats(out)` writes: the four core fields plus the three
 * observability counters that a measurement moved off the production hot path
 * into this lane (D6.6).
 */
export interface DebugObjectPoolStats extends ObjectPoolStats {
    /** Highest `used` ever reached over the wrapper's lifetime. */
    peakUsed: number;
    /** Total successful acquires over the wrapper's lifetime. */
    totalAcquires: number;
    /** Total successful releases over the wrapper's lifetime. */
    totalReleases: number;
}

/** One tag record surfaced by `DebugObjectPool.leaks()`. */
export interface PoolLeakReport {
    /** Monotonic id minted at the acquire that is still outstanding. */
    id: number;
    /** The captured acquire stack, or null when `captureStacks` is off. */
    at: string | null;
}

/**
 * A public-surface WRAPPER around ObjectPool that tags every acquire so callers
 * can find acquired-never-released objects. It speaks only ObjectPool's public
 * surface (reads no privates). ALLOCATES BY DESIGN -- not for production.
 */
export class DebugObjectPool<T extends object = object> {
    constructor(options: DebugObjectPoolOptions<T>);

    /** Acquire and tag. Returns null under onExhausted "null"/"grow" at capacity. */
    acquire(): T | null;
    /** Release and drop the tag. Delegates every guard to the underlying pool. */
    release(obj: T): boolean;
    /** Release everything and clear all tags. */
    releaseAll(): void;
    /** Iterate active objects (delegated). */
    forEachActive(callback: (this: unknown, obj: T) => void, thisArg?: unknown): void;
    /** Drain, destroy, and drop all tags (delegated). Idempotent. */
    destroy(): void;

    /** Objects currently acquired (in use). */
    readonly used: number;
    /** Objects available for acquire. */
    readonly free: number;
    /** Total created objects. */
    readonly size: number;

    /** How many objects are currently acquired-but-not-released (tagged). */
    outstanding(): number;
    /** A fresh report naming every currently-acquired object. Allocates per call. */
    leaks(): PoolLeakReport[];

    /**
     * Write the seven debug stats into `out` and return it. Fails closed: a
     * non-object, or a frozen / sealed / getter-only target, throws a `TypeError`
     * naming `"out"`. The write is transactional -- on any non-writable field
     * `out` is rolled back to its EXACT prior shape (keys this call created are
     * deleted, not left `undefined`), never half-written.
     */
    stats<O extends Partial<DebugObjectPoolStats>>(out: O): O & DebugObjectPoolStats;
}

/** A finding surfaced by the leak kernel's `audit()`. */
export interface PoolLeakFinding {
    kind: 'object-pool-leak';
    reason: 'acquired-not-released';
    tag: number;
    origin: string | null;
}

/** The lite-leak kernel returned by `createPoolLeakKernel`. audit()+count() only. */
export interface PoolLeakKernel {
    name: string;
    count(): number;
    audit(): PoolLeakFinding[];
}

/**
 * Build a @zakkster/lite-leak kernel that reports a DebugObjectPool's
 * acquired-never-released objects. `audit()` + `count()` only -- no `install`,
 * no `refine`. (A refine()/FinalizationRegistry kernel reports clean forever
 * here, because the pool retains every object it created; see D6.9.)
 */
export function createPoolLeakKernel(
    debugPool: DebugObjectPool,
    options?: { name?: string },
): PoolLeakKernel;

export default DebugObjectPool;
