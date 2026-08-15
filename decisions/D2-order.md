# D2 -- iteration order

Session P2a (v2.0.0). Recorded BEFORE implementation.

## The change

v1 iterated `forEachActive` / `releaseAll` in **insertion order** -- Set
insertion order, measured as OP-06: after acquiring 4, releasing two, and
re-acquiring two, iteration yielded `[2, 3, 90, 91]`, the recycled slots at the
end. Nothing documented it and nothing pinned it, but it was observable.

The v2 sparse set uses **swap-remove**: releasing an object moves the last active
element into the freed slot. Iteration order is therefore whatever the swaps left
behind -- not insertion order, not any order.

## The decision: DECLARE UNSPECIFIED (roadmap Decision 2, option A)

Iteration order over active objects is **unspecified** as of 2.0.0. We spend
nothing preserving it -- no compaction, no linked list, no insertion timestamp.
Option B (preserve insertion order) would cost a compaction or a parallel list
and give back most of what the rewrite buys; rejected.

This is a **breaking change** and the single loudest line in the v1 -> v2
migration note. A consumer drawing sprites in spawn order (z-order by spawn time
is the obvious one) will see draw order change and, unless the CHANGELOG says so
in those words, will not connect the flicker to a pool upgrade.

## How it is pinned

A test asserts the CONTRACT that order is unspecified, not a particular order:
two pools driven through **different** churn to the **same** active set are
compared by SET EQUALITY only (sorted identities), never by sequence. The
differential fuzz (T5) does the same at every step -- it compares `used`, `free`,
`size`, and the sorted set of active identities, and a comment there states that
NOT comparing order is Decision 2, not an oversight.

Callers who need a stable order must keep their own ordered index; the pool does
not promise one.
