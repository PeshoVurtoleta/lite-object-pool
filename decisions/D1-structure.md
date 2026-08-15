# D1 -- the structure and the object -> slot mechanism

Session P2a (v2.0.0). Recorded BEFORE implementation. Supersedes the v1 `_out`
Set. The choice here is what makes the headline sentence -- "no allocations
during gameplay" -- true or false.

## The structure: sparse set

`_items[]` flat store of every created object. A dense/sparse `Uint32Array`
index pair plus an `_activeCount` cursor (`_active`) partition the item indices
into `[active | free]`:

- `_dense[0 .. _active-1]` are the item indices currently checked out;
  `_dense[_active .. _size-1]` are free.
- `_sparse[itemIndex]` is that item's position in `_dense` (the inverse
  permutation).
- `acquire()` = `_items[_dense[_active++]]` -- an O(1) cursor advance. No hash
  insert, no iterator, no allocation.
- `release(obj)` = look up the item index, cross-check `pos < _active`, then an
  O(1) swap-remove of `_dense`/`_sparse`. No hash table anywhere.

Alternatives rejected (roadmap Decision 1):
- **B, keep the Set and pre-size it** -- a JS `Set` cannot be pre-sized, and
  `Set.add` rehashes as it grows. That rehash IS OP-01. Rejected.
- **C, parallel array + linear scan** -- O(N) release, violates the package's
  own O(1) claim. Rejected.

### Why `Uint32Array`, and why unsigned is correct

`_dense` and `_sparse` hold **item indices** into `_items` -- positions in
`0 .. _size-1`. They are **never handles** and never carry a sentinel or a
negative "empty" marker (the free/active split is the `_active` cursor, not a
sign bit). An index is unsigned by construction, so `Uint32Array` is the correct
element type: it stores the full `0 .. 2^32-1` range with no sign bit wasted and
no negative value ever written.

This is the inverse of lite-arena's **AR-01** lesson. There, a value that could
legitimately be a **negative sentinel** (a free-list link that used `-1` for
"end") was stored in a `Uint32Array` and `-1` wrapped to `4294967295`, corrupting
the free-list terminator. The lesson: match the array's signedness to the value's
domain. Here the domain is genuinely non-negative indices with no sentinel, so
unsigned is not just safe but exact. Stated explicitly so the next reader does
not re-derive it or "fix" it to `Int32Array` and reintroduce the wasted bit.

Ceiling: an index must fit in a `Uint32Array`, i.e. `_size <= 2^32`. `size`/
`maxSize` above that were already documented (llms.txt) as an unfillable-but-valid
band that fails from the allocation itself; nothing new here.

## The fork that matters: object -> slot-index map

The sparse set needs, per object, its item index. Three mechanisms, each real:

1. **Symbol stamp** -- a non-enumerable symbol-keyed property written on the
   object at create time. Fastest hot-path read (`o[SLOT]`), but MUTATES the
   caller's object and is observable via `Object.getOwnPropertySymbols`. It also
   throws at stamp time on non-extensible objects:
   `Object.freeze`, `Object.seal`, `Object.preventExtensions`, and a Proxy with a
   `defineProperty` trap all reject the write.
2. **WeakMap** -- `_slots.get(obj)` / `.set(obj, idx)`. A hash table, but the
   slot index is written ONCE per object at create time and only READ on the hot
   path. Reads do not rehash, so -- unlike the v1 Set -- it is zero-alloc on the
   hot path. Does not mutate the caller's object. Accepts frozen/sealed objects
   as keys without complaint (a frozen object is a valid WeakMap key).
3. **Handles** -- the pool hands out integer indices instead of objects. A
   different API (roadmap D1), out of scope for P2a.

### Measured (2026-08-15, node on darwin) -- the read path

From the roadmap's own probe, 20,000 objects x 40 passes:

```
symbol read              0.0000 B/op   0.13 ms / 20k-pass
WeakMap get             ~0.0000 B/op   0.30 ms / 20k-pass   (2.3x symbol)
Set has+delete+add (v1)  0.0032 B/op   0.68 ms / 20k-pass   (5.2x symbol)
```

Both symbol and WeakMap are zero-alloc on reads. The v1 Set is not (the growth
rehash). So the choice is NOT "which one allocates" -- neither does -- it is a
capability-and-risk choice.

### The capability argument (seal / freeze / preventExtensions)

Measured against v1.1.0: `Object.seal({x,y})` and `Object.preventExtensions({x,y})`
pool fine today WITH a working `reset`; frozen + a no-op `reset` also works;
frozen + a writing `reset` already throws on release today. A **symbol-only**
mechanism would remove those three working configurations, because the stamp
write throws on a non-extensible object at construction. That is a regression of
three shapes that ship green today, and a raw `defineProperty` TypeError naming
neither the library nor the option -- OP-03's exact shape in a new place. So
symbol-only is not shippable as the sole mechanism.

The roadmap's revised recommendation was a **symbol + per-instance WeakMap
fallback**: try to stamp the first created object, and if it refuses, use a
WeakMap for that pool -- mechanism chosen once, cold, so the hot path carries
zero mechanism branches. The named risk: two mechanisms means two `release`
shapes, and a caller driving both pool kinds may push `release` polymorphic
(OP-17 in a new place). "the one thing that could sink the fallback."

## Task 2 thresholds and the SELECTED mechanism

`probe/poly.mjs` was written and run to decide this, not to confirm it. Four
lanes of acquire+release churn, ns/op timed warm outside the gc window, B/op via
lite-gc-profiler `measureOps` `heap.allocBytes` netted against a no-op baseline
(a hand-rolled `heapUsed` delta drifts negative -- roadmap D1 note).

Decision rule, as set in the task:
- **ADOPT symbol+WeakMap fallback** iff mixed-kind is within 5% of single-kind
  AND every lane is 0.0000 B/op.
- **REJECT -> WeakMap-only** if mixed-kind is >5% slower OR any lane is non-zero
  B/op.
- Symbol-only ships only if WeakMap-only also misses a T6 budget.

Measured (representative run; stable across repeats):

```
lane                ns/op      B/op
single symbol       ~2.0       0.0000
single weakmap      ~8.5       0.0000
mixed  sym+wm       ~4.8       0.0055   <-- the only lane that does NOT net zero
weakmap-only        ~6.5       0.0000
```

The mixed symbol+WeakMap lane repeatably fails 0.0000 B/op: interleaving the two
slot-reader shapes at one call site allocates a small but non-zero, repeatable
amount that survives baseline subtraction, while both uniform lanes (single-kind
and WeakMap-only two-pool) net a clean zero. This is precisely the polymorphism
hazard the roadmap flagged as the thing that could sink the fallback -- and it
sank it. Per the rule: **any lane non-zero B/op -> REJECT the fallback.**

**SELECTED: WeakMap-only, for every pool.**

- One `release` shape. No two-mechanism polymorphism, so no OP-17 regression.
- No capability regression: frozen / sealed / preventExtensions factories all
  pool, because a non-extensible object is still a valid WeakMap key.
- Does not mutate the caller's object (no observable symbol stamp).
- Still 0 B/op on the hot path (reads never rehash), and ~2.3x faster than v1's
  Set -- comfortably inside T6, which gates allocation, not latency.

Symbol-only was NOT chosen as a fallback-of-the-fallback because WeakMap-only
passes T6 (see the gate); the "symbol-only if WeakMap-only misses a budget"
branch never fires.

Note for the next reader: because **no fallback shipped** -- there is no symbol
path and no per-instance mechanism switch, every pool is WeakMap -- the
"mixed-kind within X% of single-kind" adoption threshold is MOOT. It was the gate
for ADOPTING the two-mechanism fallback; the fallback was rejected on the B/op
clause before the percentage clause mattered. Do not go looking for a
mixed-mechanism benchmark in the shipped code: there is only one mechanism, so
there is nothing to keep monomorphic. `probe/poly.mjs` remains as the record of
why.

### Consequence: create() must return a distinct, trackable object

WeakMap keys must be objects (or functions); `null`, `undefined`, and primitives
are rejected by `WeakMap.set`. And two identical identities cannot both be
tracked. So P2a decides a named, fail-closed policy for `create()` return values
(this is new territory forced by D1, not part of P1's option validation, which is
kept exactly):

- `create()` returning a non-object / null / primitive throws a library
  `TypeError` at the point of creation.
- `create()` returning an object this pool already tracks (the "same object every
  call" T1 case) throws a library `TypeError` -- each pooled object must be a
  distinct identity.

Both are fail-closed and named `ObjectPool: ...`. This replaces v1's silent
behaviour (v1 pooled `null` and collapsed duplicates via the Set).
