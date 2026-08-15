# D4 -- exhaustion, foreign objects, and use-after-destroy

Session P2a (v2.0.0). Recorded BEFORE implementation.

## The v1 problem

`acquire()` returned `null` for three different situations -- exhausted with
`expand:false`, capped by `maxSize`, and destroyed -- and the caller could not
tell them apart (OP-04). `release()` returned `false` for three -- foreign
object, double release, and destroyed -- silently (OP-05, OP-11). Three failure
modes behind one value is not a contract.

## The decision (roadmap Decision 4, option B): split by class

An **expected runtime condition** returns a value; a **caller bug** throws.

### acquire()

- **Exhausted or capped** -> returns **null**. A game loop handles this every
  frame (`if (!p) break`); it is not an error. Unchanged from v1 for this case.
- **Destroyed** -> **throws** a named `ObjectPool: acquire() called on a
  destroyed pool` error. Use-after-destroy is a caller bug, not "we are busy this
  frame". v1 silently returned null here, which let "someone destroyed this pool"
  read as "exhausted".

### release()

- **Genuine double release** (the object was issued but is not currently checked
  out) -> returns **false**. Idempotent, expected, unchanged.
- **Foreign object** (never issued by this pool -- including `null`, `undefined`,
  primitives, a sibling pool's object, a plain foreign object) -> **throws** a
  named `ObjectPool: release() called with an object this pool did not issue`
  TypeError. A foreign object reaching `release()` is a caller bug that in v1
  vanished as a silent `false`.
- **Destroyed** -> **throws** a named `ObjectPool: release() called on a
  destroyed pool` error.

### releaseAll() / forEachActive()

- **Destroyed** -> **throw** the corresponding named error. Consistent
  fail-closed treatment of use-after-destroy across every operational method.
  (v1 silently no-op'd both.)

### destroy()

- **Drains, then tears down** (OP-09). It calls `reset()` on every object still
  checked out -- so a pool of DOM elements or WebSocket messages gets its cleanup
  -- then releases references and marks the pool destroyed. v1 did neither
  visibly. `destroy()` remains **idempotent**: a second `destroy()` is a no-op,
  not a throw (destroy is teardown; repeating teardown is not a use-after-destroy
  bug).

Every throw is a named error naming the library in P1's `ObjectPool: ...` style.

## Hot-path cost -- one branch each, on a cold outcome

The destroyed and exhaustion checks must not tax the fast path.

- **acquire**: the fast path is a single branch, `_active < _size`. When it
  fails, control goes to the cold `_grow()`, which handles destroyed / capped /
  grow together. `destroy()` sets `_size = 0` and `_active = 0`, so a destroyed
  pool's fast branch fails and routes to `_grow`, where the destroyed check
  lives. The destroyed check is thus behind the SAME predicate as exhaustion --
  no second hot branch -- exactly as the task directs if a branch shows on
  `assertOps`.
- **release**: the fast path branches are the two the logic already needs --
  `idx === undefined` (miss/foreign) and `pos >= _active` (double/destroyed).
  Both destroyed throws live inside those cold branches; `destroy()` sets
  `_active = 0` so a former member's `pos >= 0` routes into the cold branch. No
  destroyed branch is added to the checked-out fast path.

Verified by the T6 alloc gate (zero allocation on the preallocated hot path) and
by the drain probe reading 0.00 B/acquire.
