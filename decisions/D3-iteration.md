# D3 -- release during iteration

Session P2a (v2.0.0). Recorded BEFORE implementation.

## The situation

Release-during-`forEachActive` worked in v1 by accident (OP-07): `Set` iterators
tolerate deletion of an already-visited entry, so releasing the currently-visited
object mid-iteration left correct counts and visited all N. The README even
TEACHES an allocating `const dead = []` workaround for a problem the Set did not
have. The v2 swap-remove breaks the accident: a naive FORWARD loop that releases
the visited object would swap an unvisited tail element into the current slot and
then skip it.

## The decision: REVERSE-ITERATION CONTRACT (roadmap Decision 3, option A)

`forEachActive` walks `_dense` **backwards**, from `_active-1` down to `0`.

Why this makes release-during-iteration contractual for the first time:
releasing the current object swap-removes it, moving the LAST active element
(position `_active-1`) into the current slot. In a reverse walk the tail has
**already been visited**, and the loop is about to step to a LOWER index, so the
swapped-in element is never revisited and the current object is not re-seen.
Nothing is skipped, nothing is double-visited. It costs nothing over a forward
loop and turns an accident into a guarantee.

The loop body carries one integer guard, `if (i < this._active)`, re-read each
iteration. Its only job is bulk mutation: if the callback calls `releaseAll()`
(or otherwise shrinks `_active` below `i`), the remaining indices are skipped
rather than dereferencing now-free slots. It allocates nothing. Releasing the
CURRENT object needs no help from the guard -- `i` and `_active` decrement in
lockstep -- but releasing an arbitrary NOT-YET-visited (lower-index) object is
still unspecified: the swapped-in already-visited element would land at a
lower index and be visited a second time. The contract is precisely: **releasing
the object currently passed to your callback is safe; `releaseAll()` mid-walk
stops the walk; other structural mutation during iteration is unspecified.**

An optional `thisArg` is accepted (`cb.call(thisArg, obj)`) so a caller can pass
a method + receiver instead of allocating a bound closure per frame.

## The callback is validated once, state-independently

`forEachActive` validates `callback` a single time, at the top of the method,
before the loop -- after the destroyed check and before any element is touched.
A non-function `callback` (including `undefined` / an omitted argument) throws a
named `TypeError`: `ObjectPool: "callback" must be a function, received ...`, in
P1's option-validation style.

Decided because the naive alternative -- letting `callback.call(...)` throw from
inside the loop -- is **state-dependent**: it throws a raw `TypeError` naming
neither the library nor the parameter when the pool has active objects, and
silently no-ops when it does not. "Throws iff there is something to iterate" is
none of the three allowed degenerate-case policies (throw / documented no-op /
documented undefined); it is whichever the pool's `_active` happens to select,
and the raw throw is OP-03's defect class reappearing in the release that
advertises named errors. So an omitted or non-function callback is a **caller
bug and always throws**, regardless of `_active`. The check is cold (once, before
the loop; nothing added to the loop body) and the forEachActive lane still reads
0.000000 B/op.

## Consequences

- The README game loop drops its `dead[]` array (OP-07): dying particles are
  released inside the `forEachActive` callback directly. The documented pattern
  stops allocating every frame and stops violating the package's own premise.
- Pinned by a test that releases EVERY object from inside `forEachActive` and
  asserts all N visited exactly once, `used === 0` and `free === size` after.
- Kills the per-call iterator object of OP-08 as a side effect (plain index
  loop, no `for...of`), but the rewrite is not billed as being FOR OP-08.
