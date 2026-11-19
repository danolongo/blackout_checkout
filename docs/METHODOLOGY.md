# Implementation Methodology

How every phase in `blackout-checkout-plan.md` gets built, tested and merged. These rules apply to every phase without exception.

---

## 1. One phase = one feature branch

Each phase is built on its own branch cut from the latest `main`. When the phase is complete and green, the branch merges back into `main`. Then the next phase starts on a new branch from the updated `main`.

```
main ──●────────────●──────────────●──────────────●── …
        \          /  \            /  \            /
         arc-fixtures   checkout-contract   receipt-proof-builder
```

### Branch names are the feature, never the phase

> **A branch is named for what it builds. It is never named after the phase number or the word "phase".**

| ❌ Never | ✅ Always |
|---|---|
| `phase-1` | `arc-fixtures` |
| `phase-2-contract` | `checkout-contract` |
| `p3` | `receipt-proof-builder` |
| `phase4/customer` | `customer-checkout` |
| `phase-5` | `vendor-offline-app` |
| `phase-6-verify` | `offline-receipt-verification` |
| `phase7` | `sales-sync` |
| `phase-8-ui` | `motion-polish` |

Rules for names:
- lowercase kebab-case, describing the feature in 2–4 words
- no `phase`, no numbers that refer to phases, no personal names, no dates
- the name should still make sense to someone who has never seen the plan

### Branch for each phase

| Plan phase | Branch |
|---|---|
| Arc fixtures and verifier confirmation | `arc-fixtures` |
| Checkout contract | `checkout-contract` |
| Receipt proof builder | `receipt-proof-builder` |
| Customer checkout | `customer-checkout` |
| Vendor offline app | `vendor-offline-app` |
| Offline receipt verification | `offline-receipt-verification` |
| Sales sync | `sales-sync` |
| Motion and interface polish | `motion-polish` |

Phases run **in order**. A branch starts only after the previous one is merged, because each phase builds on the code before it.

---

## 2. Progressive commits, each with tests

A feature branch is built through many small commits, not one large commit at the end.

**Every commit:**
1. Implements one coherent step (one function, one component, one endpoint, one contract behavior).
2. Adds or updates the **tests for that step in the same commit**. Code without a test isn't committed.
3. Leaves the branch in a state where the full test suite passes.
4. Has a message describing what changed and why, in the imperative:
   ```
   Add precommit sign-bytes encoder matching Arc SSZ layout

   Ports precommitSignBytes from arcCert.mjs to TypeScript. Covered by
   the golden vector test (byte-exact against arc-node Vote::to_sign_bytes).
   ```

**Typical commit sequence (example: `receipt-proof-builder`):**
1. `Add canonical header RLP encoder with fixture hash test`
2. `Add receipts trie builder from eth_getBlockReceipts with proof test`
3. `Add receipt and log decoder with OrderPaid topic test`
4. `Add ReceiptBundle CBOR+deflate codec with round-trip test`
5. `Add BC-UR fragment encode/decode with lossy-frame test`
6. `Add minimum signer subset selection with quorum edge-case tests`
7. `Add verifyBundle pipeline with one failing-input test per rejection reason`

**Test-first is preferred.** For the verifier especially, write the failing test for a rejection case, then the code that makes it pass.

Never:
- commit with failing or skipped tests (`.skip`, `.only`, `xit`, commented-out assertions)
- weaken an existing assertion to make a new change pass
- commit generated secrets, private keys or `.env` files; testnet keys stay in an untracked `.env.local`

---

## 3. What "green" means

A branch is **green** only when every item passes:

| Gate | Command |
|---|---|
| Install is clean | `pnpm install --frozen-lockfile` |
| Type check | `pnpm -r typecheck` |
| Lint | `pnpm -r lint` (zero warnings) |
| Unit tests | `pnpm -r test` (vitest) |
| Contract tests | `forge test` in `packages/contracts` |
| Golden vector | `packages/arc-proof` golden test passes (must never regress) |
| Fixture tests | Live-fixture certificate and header tests pass |
| End-to-end | `pnpm e2e` (Playwright) for every phase that touches an app |
| Build | `pnpm -r build` |
| Phase checklist | Every checkbox in the phase's section of the plan is done, and its **Done when** condition holds |

CI runs all gates on every push to a feature branch and on every merge to `main`.

---

## 4. Merging to main

Merge a feature branch into `main` only when:
1. All gates in section 3 are green on the branch's latest commit.
2. The branch is up to date with `main` (rebase onto `main` and re-run the gates if `main` moved).
3. The phase's **Done when** condition in the plan is met.

How:
- Open a pull request from the feature branch to `main`. Title it with the feature, not the phase (e.g. *"Receipt proof builder"*). The body lists what was built, the tests added and how to verify.
- Use a **merge commit** (no squash), so the progressive commit history of each feature stays visible on `main`.
- After merging, delete the feature branch and cut the next phase's branch from the updated `main`.

`main` is always releasable: every commit on `main` passes every gate.

---

## 5. If something breaks

- **A test fails mid-branch:** fix it in the next commit before doing anything else. Don't stack new work on a red branch.
- **A gate fails after rebasing onto `main`:** fix it on the feature branch. Never merge red and "fix it on main".
- **A bug is found in already-merged work:** create a new feature-named branch for the fix (e.g. `header-rlp-osaka-fields`), with a regression test first, then the fix, then merge when green.
- **The plan turns out to be wrong about something:** stop. Record the evidence (fixture, error output, source link) in the pull request, update `blackout-checkout-plan.md` in the same branch, and continue only once the plan and the code agree.

---

## 6. Phase completion checklist (copy into each pull request)

```
- [ ] Branch named for the feature (no "phase", no phase numbers)
- [ ] Every commit includes tests for what it adds
- [ ] typecheck · lint · unit · contract · golden · fixtures · e2e · build all green
- [ ] Branch rebased on latest main and re-verified
- [ ] Every checklist item for this phase in the plan is done
- [ ] "Done when" condition met
- [ ] No secrets, no skipped tests, no weakened assertions
```
