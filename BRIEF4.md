# BRIEF4 -- v2.3.0 -- release train (P5, renumbered from 2.2.0)

```markdown
---
package: "@zakkster/lite-object-pool"
version_target: 2.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [OP-13 (remainder)]
depends_on: [BRIEF3 / 2.3.0 bench + demo]
---

# @zakkster/lite-object-pool -- ship it, and retire the old one honestly

PURPOSE
  Publish the finished v2 line, confirm the unscoped package is properly
  retired, and write a migration note that names everything that will actually
  bite. This is a docs-and-publish release: the diff should contain no logic.

TASKS
  - Lockstep triple version bump: `package.json`, the `VERSION` const in
    `ObjectPool.js`, and the `llms.txt` header line.
  - **README rebuilt on the LiteSepforge blueprint per CLAUDE.md.** This is
    genuinely outstanding -- the current README is on the old spine (Features /
    Installation / Quick Start / API / How It Works / ...) with no badges, no
    TOC, no positioning H2 and no "Why this exists". The blueprint order is:
    title + one-line blockquote tagline; badges; a positioning H2 ("The X the
    ecosystem was missing") with inline install and runnable quick-start; TOC;
    Why this exists; What you get; a `<details>` deep-dive on the core surface;
    API reference with signatures and a constants table; Composability with a
    full end-to-end pipeline in code; a `<details>` Zero-GC design notes with an
    allocation table and the gated quality numbers from BRIEF3; Design decisions
    worth knowing; Testing (test count + npm scripts); What this is not;
    Ecosystem; License. ASCII-only (`->`, `<=`, `x`, "degrees"). Keep it in
    `files[]`.
  - **OP-13's remainder.** `engines.node` is already `>=18`, so that half is
    done. Still open: `homepage`, `repository.url`, `bugs.url` and
    `funding.url` in `package.json` all still point at the `PeshoVurtoleta` org
    (lines 50-61). Fix all four.
  - **The migration section, v1 -> v2. It is TEN breaking changes, not four.**
    The roadmap's P5 brief lists four and says "do not round this to drop-in" --
    correct instinct, stale count. Take the list from the 2.0.0 CHANGELOG's
    `### Breaking changes` block and check it line by line; as shipped it reads:
      1. Iteration order is UNSPECIFIED (OP-06, D2) -- the loudest line;
         a renderer relying on spawn-order z-index silently starts flickering.
      2. `release()` throws on a foreign object (OP-05, D4).
      3. Use-after-destroy throws on every surface (OP-11, D4).
      4. `destroy()` drains before tearing down (OP-09).
      5. `create()` must return a distinct object (D1).
      6. Unknown constructor keys throw (fail closed).
      7. A non-function `forEachActive` callback always throws a named error.
      8. Expansion allocates in bounded 256-object chunks (OP-10), so `size`
         can jump by a chunk.
      9. `{maxSize < size}` throws (OP-02) -- and the pool you were getting was
         not the pool you asked for.
     10. `expand` must be a strict boolean.
    Each needs its reason and a one-line fix. Do not compress them into a
    summary sentence: 1, 8 and 9 are the three that change behaviour for code
    that never errors.
  - **Also document the 2.1.0 additive shape here**, since a v1 caller migrating
    at 2.3.0 meets both at once: the ten breaking changes are the v1 -> v2 story,
    and `capacity` / `prealloc` / `onExhausted` are the shape they should write
    NEW code against, with `size` / `maxSize` / `expand` permanently supported
    as aliases. Two sections, clearly separated -- conflating them makes the
    additive half look mandatory.
  - Confirm the unscoped deprecation notice is still live on npm and that no doc
    has reacquired the unscoped name. **The deprecation was done in 1.0.3 and is
    not re-run here.** There is no final unscoped release; 1.0.2 is the last one.
    For reference only, the notice reads:
    `Moved to @zakkster/lite-object-pool. The unscoped package ends at v1.0.2; all future releases are scoped.`
  - Grep every new file for stray tool-call tags before trusting it.
  - Copyright: MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>. Never
    "Karadjov". Grep for it.
  - Re-run `/sync-card lite-object-pool` AFTER publish, not before -- the card
    indexes what is installable, and 2.0.0's sync was held back for exactly this
    reason until the version was live on npm.

ASSERTIONS
  - `/release 2.3.0` clean, twice in a row.
  - `npm pack --dry-run` includes README, CHANGELOG, LICENSE, llms.txt,
    ObjectPool.js, ObjectPool.d.ts -- and excludes test/, demo/, bench/,
    decisions/, probe/.
  - Three-place version sync asserted by the T8 test, not by eye.
  - Every relative link in README and llms.txt resolves to a file in the repo.
  - Every public method appears in llms.txt and vice versa (the BRIEF2 guard).
  - The migration section lists all ten breaking changes; a reviewer checks it
    against the 1.1.0 and 2.0.0 CHANGELOG entries line by line, and the count is
    asserted rather than eyeballed.
  - No `PeshoVurtoleta` string survives anywhere in the shipped files.
  - `node --test` green; `npm run torture` prints "ok"; every control fails.

NON-GOALS
  No behaviour change of any kind. If the README rebuild surfaces a doc claim
  the code does not honour, that is a finding for a new session -- fixing code
  in a docs release is how a release train derails.

DONE WHEN
  published under scope;
  the unscoped deprecation confirmed live;
  the migration note names all ten breaking changes with their reasons;
  the card is re-synced against the published version
```

## Standing constraints for whoever runs these

- **Publishing is yours.** `npm publish` and `npm deprecate` are never run by
  me -- BRIEF4 prepares the release and stops at the gate.
- **Pipeline law**: planner -> coder -> reviewer -> qa, and a reviewer REJECTED
  goes back to the coder, not forward. During P2a the reviewer returned APPROVED
  and a defect was still found afterwards, so APPROVED is not the end of the
  audit.
- **One package at a time.** The unfiled lite-signal finding (see BRIEF1) needs
  its own session in its own repo.
