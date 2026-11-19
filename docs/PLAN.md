# Blackout Checkout — Implementation Plan

> Event vendors take USDC payments on Arc that are **final before the goods change hands**, even when the vendor's device has no signal. The customer pays over their own connection and shows an animated receipt QR. The vendor's phone checks that receipt **offline**, against Arc's own validator signatures.

**Companion files**
- `implementation-methodology.md`: branching, commit, test and merge rules for every phase below.
- `arcCert.mjs`: the offline commit-certificate verifier (embedded in full in Appendix A).
- `golden.test.mjs`: golden-vector test for the verifier (embedded in full in Appendix B).

Sources are cited as footnotes. Arc and Malachite source permalinks are pinned to `circlefin/arc-node@6e76402` and `circlefin/malachite@a453b32`.

---

## 1. What the vendor's phone proves, offline

The receipt QR carries three pieces of evidence, checked with no network:

1. **Finality.** Arc validators holding more than 2/3 of voting power signed a precommit vote for block height H with block hash X. The phone checks each Ed25519 signature against validator keys it synced earlier.
2. **Header binding.** `keccak256(rlp(header)) == X`, so the header's `receiptsRoot` is the one the validators finalized.
3. **Inclusion.** A Merkle proof against `receiptsRoot` yields a successful receipt that contains the checkout contract's `OrderPaid(orderId, vendor, payer, amount)` event, matching the vendor's open order.

Forging a receipt requires forging signatures from validators holding more than 2/3 of Arc's voting power. Arc finality is deterministic: once a block is committed it's final, with no reorgs.[^finality]

---

## 2. Arc protocol facts this design depends on

### 2.1 Consensus and certificate facts (from source)

| Fact | Detail | Source |
|---|---|---|
| Signature scheme | **Ed25519**. Signatures are 64 bytes; public keys are 32 bytes | [^signing] [^commit_http] |
| What validators sign | The **SSZ encoding of a Precommit `Vote`**, signed raw with no domain prefix | [^vote] [^local_signer] |
| Certificate RPC | `arc_getCertificate(height)` → `{ height, round, block_hash, signatures: [{ address, signature (base64) }] }` | [^commit_http] [^rpc_cert] [^qn_cert] |
| `block_hash` meaning | `ValueId` wraps the **execution block hash** (`keccak256(rlp(header))`) reported by the execution payload | [^value] [^get_value] |
| Height | Consensus height **equals the EVM block number** | [^payload] |
| Validator address | First 20 bytes of `keccak256(ed25519_pubkey)` | [^address] [^validator_set] |
| Validator set source | On-chain **ValidatorRegistry at `0x3600000000000000000000000000000000000002`**, `getActiveValidatorSet()` returning `{ status, publicKey (bytes), votingPower (uint64) }[]` | [^registry_const] [^registry_iface] |
| Which set signs height H | The registry state **at block H−1** | [^signing_set] |
| Quorum | Strictly **more than 2/3** of total voting power: `signed × 3 > total × 2` | [^threshold] |
| Rejections | Duplicate signer → reject certificate. Signer not in set → reject certificate | [^verify_ext] |
| Block and receipt types | Reth with standard **`EthPrimitives`**, so Ethereum header hashing and receipts tries apply unchanged | [^eth_primitives] |
| Proof-building RPCs | `eth_getBlockReceipts`, `eth_getHeaderByNumber` and `eth_getProof` are all available | [^chainstack_methods] |

### 2.2 Precommit sign bytes (byte-exact)

SSZ container, 75 bytes for a precommit on a value:[^vote]

| Offset | Size | Field | Encoding |
|---|---|---|---|
| 0 | 1 | vote type | `0x01` = Precommit (`0x00` = Prevote) |
| 1 | 8 | height | u64 little-endian |
| 9 | 4 | offset of `round` | u32 LE = `37` |
| 13 | 4 | offset of `value` | u32 LE = `42` |
| 17 | 20 | validator address | raw bytes |
| 37 | 5 | round | `0x01` ‖ u32 LE (SSZ `Option::Some`) |
| 42 | 33 | value | `0x01` ‖ 32-byte block hash |

**Golden vector.** These values were produced by compiling `arc-consensus-types` at the pinned commit and calling the real `Vote::new_precommit(...).to_sign_bytes()` plus the Ed25519 signer. The inputs: private key `[7u8; 32]`, height `12345`, round `2`, block hash `0x11…11`.
```
pubkey     ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
address    0791868d8f29ea735f26a17a9aea038cd4255baa
sign_bytes 013930000000000000250000002a0000000791868d8f29ea735f26a17a9aea038cd4255baa
           0102000000011111111111111111111111111111111111111111111111111111111111111111
signature  960c8154170970ba6f57fd898a94ee4c6a25ee8f6ccfa854565dc91c4bda7bba
           6465fe504ca2de91612bfec1c154cab937955e7b3bf6df370f0fcdd5e8439305
```
`arcCert.mjs` reproduces these bytes exactly and verifies the signature. `golden.test.mjs` asserts this, plus the rejection cases (Appendix B).

### 2.3 Network and token facts

| Item | Value | Source |
|---|---|---|
| Testnet chain ID | `5042002` | [^arc_infra] |
| RPC | `https://rpc.testnet.arc.io` (WS `wss://rpc.testnet.arc.io`). Alternates: `rpc.quicknode.testnet.arc.io`, `rpc.blockdaemon.testnet.arc.io`, `rpc.drpc.testnet.arc.io` | [^arc_infra] [^arc_rpc] |
| Explorer | `https://explorer.testnet.arc.io` | [^arc_infra] |
| USDC | Native gas token, **18 decimals** (`msg.value`). The ERC-20 view at `0x3600000000000000000000000000000000000000` uses **6 decimals** over the same balance | [^arc_wallets] [^alchemy_arc] |
| Certificate errors | `-32004` = not found yet · `-32005` = upstream consensus source unreachable · `-32602` = height < 1 | [^chainstack_cert] |
| Certificate caching | Once it exists for a height, it's immutable and safe to cache forever | [^alchemy_cert] |
| Contract tooling | Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`) | [^arc_foundry] |
| Transfer-log gotcha | Native USDC movements emit system logs from a system emitter. This design reads **only** the checkout contract's own event, so they never matter | [^alchemy_arc] |

---

## 3. Stack and repository layout

| Concern | Choice |
|---|---|
| Language | TypeScript (strict) everywhere except the contract |
| Package manager | pnpm workspaces |
| Contract | Solidity ^0.8.24, Arc Foundry |
| Apps | Vite + React. The vendor app is a PWA (Workbox service worker) |
| Animation | `motion` (Framer Motion) |
| Chain client | `viem` (custom chain `5042002`, native currency USDC 18 decimals) |
| Crypto (offline) | `@noble/ed25519`, `@noble/hashes` |
| RLP / tries | `@ethereumjs/rlp`, `@ethereumjs/trie` |
| Bundle codec | `cbor-x`, `fflate` |
| Animated QR | `@ngraveio/bc-ur` (encode), camera decode via `@zxing/browser` |
| Local storage | IndexedDB via `idb` |
| Unit tests | `vitest` · Contract tests: `forge test` |
| End-to-end tests | Playwright (two browser contexts: vendor offline, customer online) |

```
/
├─ packages/
│  ├─ contracts/        # BlackoutCheckout.sol + Foundry tests
│  └─ arc-proof/        # shared, isolated, no network code:
│     ├─ cert.ts        #   port of arcCert.mjs (Appendix A)
│     ├─ header.ts      #   header RLP + hash
│     ├─ receipt.ts     #   receipts-trie proof build/verify, log decode
│     ├─ bundle.ts      #   CBOR+deflate codec, BC-UR framing
│     └─ __tests__/     #   golden.test (Appendix B) + fixtures
├─ apps/
│  ├─ customer/         # pay page (online)
│  ├─ vendor/           # offline PWA
│  └─ sync-api/         # sales sync + dashboard API
└─ fixtures/arc-testnet/  # recorded validator set, certificates, headers, receipts
```

`packages/arc-proof` is shared by both apps. The customer app uses it to **build and self-check** bundles; the vendor app uses it to **verify** them. One implementation means the two sides can't disagree.

---

## 4. Architecture

```
┌──────────────────────┐   1. Order QR (static)     ┌───────────────────────┐
│  VENDOR PHONE (PWA)  │ ─────────────────────────▶ │ CUSTOMER PHONE (web)  │
│  - creates orders    │                            │ - wallet (USDC/Arc)   │
│  - validator snapshot│                            │ - pays via contract   │
│  - offline verifier  │   4. Receipt QR (animated) │ - builds proof bundle │
│  - consumed-order DB │ ◀───────────────────────── │                       │
└─────────┬────────────┘                            └──────────┬────────────┘
          │ 0. snapshot sync (when online)                     │ 2. tx  3. cert+header+receipts
          │ 5. sales sync (when online)                        ▼
          ▼                                         ┌───────────────────────┐
┌──────────────────────┐                            │      ARC TESTNET      │
│   SYNC API           │ ──── eth_getLogs ─────────▶│ BlackoutCheckout.sol  │
│ - sales dashboard    │                            │ ValidatorRegistry     │
└──────────────────────┘                            │ arc_getCertificate    │
                                                    └───────────────────────┘
```

No server sits in the payment path. The vendor app reads the validator set **directly from Arc RPC**. The sync API only serves bookkeeping.

---

## 5. Payment flow

0. **Snapshot (vendor online):** sync the validator snapshot (section 9).
1. **Create order (vendor offline):** generate a random 128-bit `orderId`. Store `{ orderId, amountWei, label, createdAt, status: "open" }`. Show the order QR (section 6.1).
2. **Pay (customer online):** send one transaction, `BlackoutCheckout.pay{ value: amountWei }(vendor, orderId)`. USDC is native, so there's no ERC-20 approve step.
3. **Collect proof data (customer online):**
   - `eth_getTransactionReceipt(txHash)` → `blockNumber`, `transactionIndex`, `status`
   - `arc_getCertificate(blockNumber)`: poll every 250 ms for up to 5 s while it returns `-32004`; on `-32005`, rotate to the next RPC endpoint
   - `eth_getHeaderByNumber(blockNumber)`
   - `eth_getBlockReceipts(blockNumber)` → build the receipts trie and a proof for key `rlp(transactionIndex)`
   - **Self-check:** run the full vendor verifier (section 7) on the bundle before displaying it. The bundle is never shown unless it would pass at the vendor.
4. **Show the receipt:** an animated fountain-coded QR (section 6.3).
5. **Verify (vendor offline):** section 7. On success, mark the order consumed and show a success state.
6. **Sales sync (vendor online):** upload accepted receipts. The sync API re-checks them on-chain and lists them per vendor.

---

## 6. Data formats

### 6.1 Order QR (vendor → customer), single static QR
```
https://<customer-app-host>/o#v=1&c=5042002&k=<checkoutAddress>&to=<vendorAddress>&id=<orderId hex32>&amt=<amountWei>&lbl=<url-encoded label>
```
The URL fragment keeps order data out of server logs, and the phone's camera opens the customer app directly.

### 6.2 Receipt bundle (customer → vendor)
CBOR (`cbor-x`), then deflate (`fflate`):
```ts
type ReceiptBundle = {
  v: 1;
  order:  { id: Uint8Array /*16*/; vendor: Uint8Array /*20*/; amountWei: bigint };
  tx:     { hash: Uint8Array /*32*/; index: number; payer: Uint8Array /*20*/ };
  cert:   { height: bigint; round: number; sigs: Array<[validatorIdx: number, sig: Uint8Array /*64*/]> };
  header: Uint8Array;          // RLP-encoded header; block hash = keccak256(header), not sent separately
  proof:  Uint8Array[];        // receipts-trie nodes, key = rlp(tx.index)
  logIndex: number;            // index of OrderPaid within the receipt's logs
};
```
- `validatorIdx` is the signer's index in the vendor's snapshot, **sorted ascending by address**. One byte replaces a 20-byte address, so each signer costs 65 bytes instead of 84.
- The customer includes only enough signatures to clear more than 2/3 of voting power, highest power first. The customer app reads the same registry, so it can compute indices.

### 6.3 Receipt QR transport
**Always use an animated fountain-coded QR:** `@ngraveio/bc-ur`, UR type `bytes`, ~200-byte fragments, ~8 fps. Estimated size is about 65 B × the signers needed, plus ~600 B of header and 0.5–2 KB of receipt proof, roughly 2–4 KB in total. That's beyond what a single static QR scans reliably. Fountain coding lets the scanner start at any frame and finish despite missed frames.

---

## 7. Offline verification algorithm (vendor phone)

Run every step and reject on the first failure. Each rejection has a human-readable reason shown in the UI.

**Order checks**
1. `order.id` matches an **open** order on this device. `order.vendor` == this vendor. `order.amountWei` == the stored `amountWei` (18-decimal native units only; never compare against 6-decimal ERC-20 values).

**Finality: commit certificate.** Steps 2–5 are implemented in `arcCert.mjs`.
2. `blockHash = keccak256(header)`. Decode the header; require `header.number == cert.height`.
3. Map each `validatorIdx` to a snapshot entry. Reject unknown indices and duplicates. *(arcCert.mjs L76–79)*
   ```js
   if (seen.has(addrHex)) return { ok: false, reason: `duplicate signer ${addrHex}` };
   seen.add(addrHex);
   const v = byAddr.get(addrHex);
   if (!v) return { ok: false, reason: `unknown validator ${addrHex}` };
   ```
4. For each signer, verify `ed25519.verify(sig, precommitSignBytes(height, round, blockHash, signerAddress), pubkey)`. Sign-bytes construction *(arcCert.mjs L37–51)*:
   ```js
   export function precommitSignBytes({ height, round, blockHash, validatorAddress }) {
     const roundBytes = Uint8Array.of(1, ...u32le(round));           // Some(round)
     const valueBytes = Uint8Array.of(1, ...hexToBytes(blockHash));  // Some(ValueId)
     const fixedLen = 1 + 8 + 4 + 4 + 20;
     const out = new Uint8Array(fixedLen + roundBytes.length + valueBytes.length);
     let o = 0;
     out[o++] = 1;                                      // VoteType::Precommit tag
     out.set(u64le(height), o); o += 8;
     out.set(u32le(fixedLen), o); o += 4;               // offset -> round
     out.set(u32le(fixedLen + roundBytes.length), o); o += 4; // offset -> value
     out.set(validatorAddress, o); o += 20;
     out.set(roundBytes, o); o += roundBytes.length;
     out.set(valueBytes, o);
     return out;
   }
   ```
5. Quorum, matching Malachite's `TWO_F_PLUS_ONE`[^threshold] *(arcCert.mjs L91–92)*:
   ```js
   // Malachite TWO_F_PLUS_ONE: signed * 3 > total * 2
   const ok = signed * 3n > total * 2n;
   ```
   Validator addresses are derived exactly as the node derives them[^address] *(arcCert.mjs L16–17)*:
   ```js
   /** Validator address = first 20 bytes of keccak256(ed25519 pubkey). */
   export const addressFromPubkey = (pk) => keccak_256(pk).slice(0, 20);
   ```

**Inclusion: receipt proof**
6. Take `receiptsRoot` from header RLP field index 5. Verify `proof` for key `rlp(tx.index)` against `receiptsRoot` (`@ethereumjs/trie` `verifyMerkleProof`) and get the receipt bytes.
7. Decode the typed receipt: `0x02 ‖ rlp([status, cumulativeGasUsed, logsBloom, logs])` (legacy receipts have no type prefix). Require `status == 1`.
8. Check `logs[logIndex]`:
   - address == the checkout contract
   - `topics[0] == keccak256("OrderPaid(bytes16,address,address,uint256)")`
   - `topics[1]` = `orderId` (left-aligned `bytes16` padded to 32 bytes), `topics[2]` = `vendor`, `topics[3]` = `payer`
   - `data` = `amountWei` (uint256)
   - All of these equal the order and the `tx` fields.

**Freshness and replay**
9. `order.createdAt − 60 s ≤ header.timestamp ≤ order.createdAt + 900 s` (device clock).
10. Atomically set the order status to `consumed` in IndexedDB, in a single transaction with the status read in step 1.

**Header hashing.** RLP-encode the header fields in canonical order. Include every post-London field present in the RPC response: `parentHash, sha3Uncles, miner, stateRoot, transactionsRoot, receiptsRoot, logsBloom, difficulty, number, gasLimit, gasUsed, timestamp, extraData, mixHash, nonce, baseFeePerGas, withdrawalsRoot, blobGasUsed, excessBlobGas, parentBeaconBlockRoot, requestsHash`. Arc uses standard Ethereum primitives.[^eth_primitives] The customer-side self-check proves the encoding against the live block hash on every payment.

---

## 8. Smart contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Native-USDC checkout on Arc. One transaction, no approve.
contract BlackoutCheckout {
    event OrderPaid(
        bytes16 indexed orderId,
        address indexed vendor,
        address indexed payer,
        uint256 amount          // 18-decimal native USDC
    );

    error ZeroAmount();
    error ForwardFailed();

    function pay(address payable vendor, bytes16 orderId) external payable {
        if (msg.value == 0) revert ZeroAmount();
        (bool ok, ) = vendor.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
        emit OrderPaid(orderId, vendor, msg.sender, msg.value);
    }
}
```
- Funds are forwarded in the same call, so the contract never holds a balance.
- There's no on-chain "already paid" lock keyed by `orderId`, because a third party could grief it by paying a wrong amount first. Duplicate-payment protection lives in the customer app (check `eth_getLogs` for `OrderPaid(orderId)` before paying) and in the vendor's consumed-order store.
- Arc specifics: a blocklisted vendor or payer reverts and still consumes gas, and sends to `address(0)` revert.[^alchemy_arc] Surface revert reasons in the customer UI.

---

## 9. Validator snapshot sync

Run when the vendor app is online: at setup, and on every reconnect.
1. `eth_blockNumber` → `N`.
2. `eth_call { to: 0x3600000000000000000000000000000000000002, data: getActiveValidatorSet() }` at block `N`.[^registry_iface]
3. Keep entries whose `publicKey` is 32 bytes and whose `votingPower > 0`. Derive addresses (`addressFromPubkey`), sort ascending by address and store `{ chainId, fromBlock: N, validators[], totalPower, syncedAt }`.
4. Show snapshot age in the vendor UI.

**Validator rotation fails closed.** A signer missing from the snapshot causes a reject. A validator removed after the snapshot leaves the stored total larger, which makes quorum harder to reach. So a stale snapshot can only cause a false rejection, never a false acceptance. A rejection whose reason is "unknown validator" prompts a resync when signal returns.

---

## 10. Phases

Each phase is developed on its own **feature-named branch**, with progressive tested commits, and merged to `main` only when everything is green. See `implementation-methodology.md`.

### Phase 1 — Arc fixtures and verifier confirmation
**Branch:** `arc-fixtures` · *Requires network access to Arc testnet RPC.*
- [ ] Faucet-fund three wallets (vendor, customer, deployer).
- [ ] Record into `fixtures/arc-testnet/`: the `getActiveValidatorSet()` result at block N, plus `arc_getCertificate`, `eth_getHeaderByNumber` and `eth_getBlockReceipts` for three recent heights after N.
- [ ] Port `arcCert.mjs` → `packages/arc-proof/cert.ts` with identical behavior. Port `golden.test.mjs` → vitest.
- [ ] Tests: golden vector passes; each recorded certificate verifies `ok: true` against the recorded validator set; `keccak256(rlp(header)) == cert.block_hash` for each fixture.

**Done when:** golden tests and live-fixture tests are green.

### Phase 2 — Checkout contract
**Branch:** `checkout-contract`
- [ ] `BlackoutCheckout.sol` (section 8).
- [ ] Foundry tests: forwards the exact value; emits the correct `OrderPaid`; reverts on zero value; reverts when the recipient rejects the transfer; gas snapshot.
- [ ] Deploy to testnet with `arc-forge`; verify on the explorer; record the address in `packages/contracts/deployments.json`.

**Done when:** `forge test` is green and the contract is deployed and verified.

### Phase 3 — Receipt proof builder
**Branch:** `receipt-proof-builder`
- [ ] `header.ts`: canonical header RLP and hash.
- [ ] `receipt.ts`: build the receipts trie from `eth_getBlockReceipts`, produce and verify the proof, decode the receipt and logs.
- [ ] `bundle.ts`: `ReceiptBundle` CBOR+deflate codec; BC-UR fragment encode/decode; minimum-signer-subset selection.
- [ ] `verifyBundle(bundle, snapshot, openOrder, now)`: the full section 7 pipeline, returning `{ ok, reason }`.
- [ ] Tests: round-trip codec; fixture-based proof verification; every rejection reason in section 7 has a dedicated failing-input test (tampered header, proof node, log topic, amount, wrong vendor, stale timestamp, unknown or duplicate signer, insufficient power).

**Done when:** all `arc-proof` tests are green, with 100% branch coverage on `verifyBundle`.

### Phase 4 — Customer checkout
**Branch:** `customer-checkout`
- [ ] Parse the order URL fragment; show the vendor label and dollar amount (display-only conversion from 18 decimals).
- [ ] Embedded wallet (local key in IndexedDB) with balance display.
- [ ] Duplicate-payment guard (`eth_getLogs` for an existing `OrderPaid(orderId)`).
- [ ] `pay()` → receipt → certificate/header/receipts with the retry and endpoint rotation from section 5 → build bundle → **self-check with `verifyBundle`** → animated QR.
- [ ] Tests: unit tests for URL parsing, amount formatting and the retry policy; an integration test against fixtures; a testnet smoke test that produces a bundle passing `verifyBundle`.

**Done when:** a real testnet payment yields a self-checked bundle and the tests are green.

### Phase 5 — Vendor offline app
**Branch:** `vendor-offline-app`
- [ ] PWA shell with a service worker; loads and runs fully offline after first visit.
- [ ] Validator snapshot sync (section 9) with an age indicator.
- [ ] Order creation, order list, static order QR.
- [ ] IndexedDB stores: `orders`, `snapshot`, `acceptedReceipts`.
- [ ] Tests: Playwright, offline mode — the app reloads and creates orders with the network disabled; snapshot sync is parsed and sorted correctly from fixtures.

**Done when:** the vendor app works end to end offline for order creation and the tests are green.

### Phase 6 — Offline receipt verification
**Branch:** `offline-receipt-verification`
- [ ] Animated-QR scanner (camera → BC-UR decoder → `ReceiptBundle`) with a progress indicator.
- [ ] Run `verifyBundle`. On success, atomically mark the order consumed and show the success state. On failure, show the reason.
- [ ] Tests: a Playwright two-context end-to-end test (vendor offline, customer online) covering the scenarios in section 11.

**Done when:** every scenario in section 11 passes in CI.

### Phase 7 — Sales sync
**Branch:** `sales-sync`
- [ ] When online, the vendor uploads accepted receipts to `sync-api`.
- [ ] `sync-api` re-verifies each one on-chain (`eth_getLogs` for `OrderPaid`) and flags mismatches.
- [ ] Per-vendor sales list with explorer links and totals in dollars.
- [ ] Tests: API unit tests; a mismatch-flagging test; an end-to-end sync after reconnect.

**Done when:** synced sales match on-chain events and the tests are green.

### Phase 8 — Motion and interface polish
**Branch:** `motion-polish`

Every rule below is applied app-wide through **one shared motion module** (`packages/ui/motion.ts`) and **shared components**. No component defines its own durations or easings.

| # | Rule | Implementation spec |
|---|---|---|
| 1 | **Ease-out for entrances** | `ease: [0.23, 1, 0.32, 1]` for everything entering the screen |
| 2 | **Dropdowns run 150–250 ms** | Dropdown open = 200 ms; close = 160 ms (see rule 14) |
| 3 | **Stagger list rows by 30 ms** | `staggerChildren: 0.03` on order lists and sales lists |
| 4 | **Scale pressed items to 0.97** | `whileTap={{ scale: 0.97 }}` on every button, row and card |
| 5 | **Stretch moving knobs 12%** | Toggle and slider knobs: `scaleX: 1.12` while travelling, back to 1 on arrival |
| 6 | **Stagger details as they settle** | After a primary element lands, its secondary details (amount, label, timestamp) fade in with a 30 ms stagger |
| 7 | **Use arcs for object movement** | Elements moving between positions (e.g., an order card flying into the "paid" list) follow a curved path via x/y keyframes with a mid-point offset, not a straight line |
| 8 | **Pulse to confirm success** | Verified receipt: the check icon pulses once, `scale: [1, 1.08, 1]` over 300 ms |
| 9 | **Ease-in-out for moves** | On-screen repositioning (not entering or exiting) uses `ease: [0.65, 0, 0.35, 1]` |
| 10 | **Start popovers at 0.95** | Popovers animate from `scale: 0.95, opacity: 0` |
| 11 | **Enter from the trigger** | `transform-origin` is set to the trigger's position (top-left/top-right/bottom per placement) |
| 12 | **Exit toward the trigger** | Exits reverse into the same origin |
| 13 | **Don't tween while held** | During drag or press-and-hold, position follows the pointer 1:1 with no transition; animation resumes only on release |
| 14 | **Exits are 20% shorter than entrances** | `exitDuration = enterDuration × 0.8`, derived in `motion.ts`, never hand-written |
| 15 | **Overlap old and new states** | State swaps (e.g., scanning → verified) crossfade with overlap (`AnimatePresence mode="popLayout"`), never sequential blank frames |
| 16 | **Use masks for reveals and color changes** | Reveals and success/error color changes use an animated `clip-path` (circle or inset) |
| 17 | **Crossfade icons with blur** | Icon swaps: outgoing `opacity 1→0, blur 0→4px`; incoming `opacity 0→1, blur 4px→0` |
| 18 | **Rubber-band past bounds** | Draggable sheets and lists resist past their bounds (`dragElastic: 0.2`) and spring back on release |
| 19 | **Reuse layout IDs and components** | The same `layoutId` follows an entity everywhere (e.g., `order-${id}` from the order list → order QR → verified state). Buttons, rows, popovers, dropdowns and sheets come from one shared component set |

Baseline: honor `prefers-reduced-motion` by collapsing transforms to opacity-only, with durations ≤ 120 ms.

- [ ] Create `packages/ui` with `motion.ts` (tokens: easings, durations, staggers, press scale, knob stretch, popover start scale, elastic) and the shared components.
- [ ] Migrate both apps to the shared components and tokens.
- [ ] Tests:
  - unit tests asserting each token value, including `exit = enter × 0.8` and dropdown durations within 150–250 ms
  - a lint rule or test that fails on literal durations or easings outside `motion.ts`
  - a Playwright check that `prefers-reduced-motion` removes transforms
  - visual-regression snapshots of key states

**Done when:** every rule is applied through shared tokens and components, and all tests are green.

---

## 11. End-to-end acceptance scenarios

All run in Playwright with the vendor context offline.

| # | Scenario | Expected result |
|---|---|---|
| 1 | Create a $12.00 order → customer pays → vendor scans the receipt | Verified; shows "Finalized by N/M Arc validators"; order consumed |
| 2 | Scan the same receipt again | Rejected: "already used" |
| 3 | Scan a receipt for a different vendor's order | Rejected: "not this vendor's order" |
| 4 | Receipt with a tampered amount | Rejected: "receipt proof mismatch" |
| 5 | Receipt with one signature byte flipped | Rejected: "invalid validator signature" |
| 6 | Receipt with signers below 2/3 of power | Rejected: "no 2/3+ quorum" |
| 7 | Snapshot missing a signer (rotated set) | Rejected: "unknown validator"; prompts resync when online |
| 8 | Receipt older than 15 minutes relative to the order | Rejected: "stale receipt" |

---

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| `arc_getCertificate` returns `-32005` | Rotate across Circle / QuickNode / Blockdaemon / dRPC endpoints |
| Certificate not yet available (`-32004`) | Poll every 250 ms for up to 5 s; finality is sub-second |
| Header RLP field mismatch | Customer-side self-check against the live block hash on every payment; fixture test in Phase 1 |
| Bundle too large for one static QR | Animated fountain QR; minimum signer subset; 1-byte validator indices |
| Customer has no connectivity | Payment can't start; the UI says so clearly. Venue Wi-Fi or a different carrier is the operational answer |
| Validator set rotates | Fails closed (false reject only); resync on reconnect |
| 6- vs 18-decimal confusion | 18-decimal native units end to end; conversion only at display; unit tests |
| Testnet behavior changes | Pinned fixtures; re-run the fixture suite before each release |

---

## Appendix A — `arcCert.mjs` (complete)

```js
// Offline verifier for Arc commit certificates (arc_getCertificate).
// Mirrors arc-node's Vote::to_sign_bytes (SSZ) + Malachite verify_commit_certificate.
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { keccak_256 } from '@noble/hashes/sha3';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

export const hexToBytes = (h) => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2) throw new Error('odd hex');
  return Uint8Array.from(s.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));
};
export const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Validator address = first 20 bytes of keccak256(ed25519 pubkey). */
export const addressFromPubkey = (pk) => keccak_256(pk).slice(0, 20);

const u64le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};
const u32le = (n) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, Number(n), true);
  return b;
};

/**
 * SSZ bytes of a Precommit vote, exactly as signed by Arc validators.
 * Container fields: typ(u8 tag) | height(u64) | round(Option<u32>, var) |
 *                   value(Option<B256>, var) | validator_address([u8;20])
 * Fixed part = 1 + 8 + 4(off) + 4(off) + 20 = 37 bytes; then round, then value.
 * SSZ Option<T> = union: selector 0x00 (None) or 0x01 ++ T.
 */
export function precommitSignBytes({ height, round, blockHash, validatorAddress }) {
  const roundBytes = Uint8Array.of(1, ...u32le(round));           // Some(round)
  const valueBytes = Uint8Array.of(1, ...hexToBytes(blockHash));  // Some(ValueId)
  const fixedLen = 1 + 8 + 4 + 4 + 20;
  const out = new Uint8Array(fixedLen + roundBytes.length + valueBytes.length);
  let o = 0;
  out[o++] = 1;                                      // VoteType::Precommit tag
  out.set(u64le(height), o); o += 8;
  out.set(u32le(fixedLen), o); o += 4;               // offset -> round
  out.set(u32le(fixedLen + roundBytes.length), o); o += 4; // offset -> value
  out.set(validatorAddress, o); o += 20;
  out.set(roundBytes, o); o += roundBytes.length;
  out.set(valueBytes, o);
  return out;
}

/**
 * Verify a certificate against a validator set snapshot.
 * cert: { height, round, block_hash, signatures: [{ address, signature(base64) }] }
 * validators: [{ publicKey: hex32, votingPower: bigint|number }]  (active set read at height-1)
 * Returns { ok, signedPower, totalPower, reason? }.
 */
export function verifyCommitCertificate(cert, validators) {
  const byAddr = new Map();
  let total = 0n;
  for (const v of validators) {
    const pk = hexToBytes(v.publicKey);
    if (pk.length !== 32) continue;                  // node skips malformed keys too
    const power = BigInt(v.votingPower);
    if (power === 0n) continue;
    byAddr.set(bytesToHex(addressFromPubkey(pk)), { pk, power });
    total += power;
  }
  if (total === 0n) return { ok: false, reason: 'empty validator set' };

  const seen = new Set();
  let signed = 0n;
  for (const s of cert.signatures) {
    const addrHex = s.address.toLowerCase().replace(/^0x/, '');
    if (seen.has(addrHex)) return { ok: false, reason: `duplicate signer ${addrHex}` };
    seen.add(addrHex);
    const v = byAddr.get(addrHex);
    if (!v) return { ok: false, reason: `unknown validator ${addrHex}` };
    const sig = Uint8Array.from(atob(s.signature), (c) => c.charCodeAt(0));
    if (sig.length !== 64) return { ok: false, reason: 'bad signature length' };
    const msg = precommitSignBytes({
      height: cert.height,
      round: cert.round,
      blockHash: cert.block_hash,
      validatorAddress: hexToBytes(addrHex),
    });
    if (!ed.verify(sig, msg, v.pk)) return { ok: false, reason: `invalid signature from ${addrHex}` };
    signed += v.power;
  }
  // Malachite TWO_F_PLUS_ONE: signed * 3 > total * 2
  const ok = signed * 3n > total * 2n;
  return { ok, signedPower: signed, totalPower: total, reason: ok ? undefined : 'no 2/3+ quorum' };
}
```

## Appendix B — `golden.test.mjs` (complete)

Run: `npm i @noble/ed25519@2 @noble/hashes@1 && node golden.test.mjs` → prints `ALL GOLDEN TESTS PASSED`.

```js
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { precommitSignBytes, verifyCommitCertificate, addressFromPubkey, hexToBytes, bytesToHex } from './arcCert.mjs';

// Golden vector produced by arc-node's real Rust Vote::to_sign_bytes + Ed25519 signer
const G = {
  pubkey: 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c',
  address: '0791868d8f29ea735f26a17a9aea038cd4255baa',
  signBytes: '013930000000000000250000002a0000000791868d8f29ea735f26a17a9aea038cd4255baa0102000000011111111111111111111111111111111111111111111111111111111111111111',
  signature: '960c8154170970ba6f57fd898a94ee4c6a25ee8f6ccfa854565dc91c4bda7bba6465fe504ca2de91612bfec1c154cab937955e7b3bf6df370f0fcdd5e8439305',
};
const blockHash = '0x' + '11'.repeat(32);
const b64 = (h) => Buffer.from(hexToBytes(h)).toString('base64');

// 1. address derivation
assert.equal(bytesToHex(addressFromPubkey(hexToBytes(G.pubkey))), G.address);
// 2. byte-exact sign bytes
const sb = precommitSignBytes({ height: 12345, round: 2, blockHash, validatorAddress: hexToBytes(G.address) });
assert.equal(bytesToHex(sb), G.signBytes);
// 3. signature verifies in JS
assert.ok(ed.verify(hexToBytes(G.signature), sb, hexToBytes(G.pubkey)));

const vset = [{ publicKey: G.pubkey, votingPower: 100 }];
const cert = { height: 12345, round: 2, block_hash: blockHash, signatures: [{ address: '0x' + G.address, signature: b64(G.signature) }] };
// 4. full certificate verification (1/1 power => quorum)
assert.equal(verifyCommitCertificate(cert, vset).ok, true);
// 5. negatives
assert.equal(verifyCommitCertificate({ ...cert, block_hash: '0x' + '22'.repeat(32) }, vset).ok, false); // wrong block
assert.equal(verifyCommitCertificate({ ...cert, height: 12346 }, vset).ok, false);                      // wrong height
assert.equal(verifyCommitCertificate({ ...cert, round: 3 }, vset).ok, false);                            // wrong round
assert.match(verifyCommitCertificate({ ...cert, signatures: [...cert.signatures, ...cert.signatures] }, vset).reason, /duplicate/);
// 6. quorum: signer has 2/3 exactly of power -> NOT enough (needs >2/3)
const sk2 = ed.utils.randomPrivateKey(); const pk2 = bytesToHex(ed.getPublicKey(sk2));
assert.equal(verifyCommitCertificate(cert, [{ publicKey: G.pubkey, votingPower: 2 }, { publicKey: pk2, votingPower: 1 }]).ok, false);
assert.equal(verifyCommitCertificate(cert, [{ publicKey: G.pubkey, votingPower: 3 }, { publicKey: pk2, votingPower: 1 }]).ok, true);
console.log('ALL GOLDEN TESTS PASSED');
```

---

## Sources

[^finality]: Arc docs, *Deterministic finality*: once a block is committed, its transactions are final; no reorg handling. https://docs.arc.network/arc/concepts/deterministic-finality
[^signing]: `crates/types/src/signing.rs` L21 — re-exports `malachitebft_signing_ed25519::{Ed25519, PrivateKey, PublicKey, Signature}`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/types/src/signing.rs#L21
[^commit_http]: `crates/types/src/commit_http.rs` L49–52 (certificate fields `height, round, block_hash, signatures`), L63 (signatures must be `[u8; 64]`). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/types/src/commit_http.rs#L49-L63
[^vote]: `crates/types/src/vote.rs` L34 (`Vote` SSZ container), L83–94 (`to_sign_bytes` = SSZ bytes, extension stripped). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/types/src/vote.rs#L34-L94
[^local_signer]: `crates/signer/src/local.rs` L98 (`self.sign(&vote.to_sign_bytes())`), L140 (verification over the same bytes). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/signer/src/local.rs#L98-L140
[^rpc_cert]: `crates/evm-node/src/rpc/get_certificate.rs` L35 (`rpc_get_certificate`), L119 (upstream `/commit?height=`). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/evm-node/src/rpc/get_certificate.rs#L35-L119
[^qn_cert]: QuickNode, *arc_getCertificate*: the certificate serves as the finality proof; fields `height, round, block_hash, signatures`. https://www.quicknode.com/docs/arc/arc_getCertificate
[^value]: `crates/types/src/value.rs` L31 — `pub struct ValueId(BlockHash)`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/types/src/value.rs#L31
[^get_value]: `crates/malachite-app/src/handlers/get_value.rs` L207 — value is the block's `self_reported_block_hash()` (execution payload hash). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/malachite-app/src/handlers/get_value.rs#L207
[^payload]: `crates/malachite-app/src/payload.rs` L409 — payload rejected if `block_number != height`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/malachite-app/src/payload.rs#L409
[^address]: `crates/types/src/address.rs` L51 (`from_public_key`), L73–75 (Keccak256 of the public key, first 20 bytes). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/types/src/address.rs#L51-L75
[^validator_set]: `crates/types/src/validator_set.rs` L38 — validator address derived via `Address::from_public_key`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/types/src/validator_set.rs#L38
[^registry_const]: `crates/eth-engine/src/constants.rs` L128–129 — `VALIDATOR_REGISTRY_ADDRESS = 0x3600…0002`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/eth-engine/src/constants.rs#L128-L129
[^registry_iface]: `contracts/src/validator-manager/interfaces/IValidatorRegistry.sol` L33 (`Validator { status, publicKey, votingPower }`), L75 (`getActiveValidatorSet()`). https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/contracts/src/validator-manager/interfaces/IValidatorRegistry.sol#L33-L75
[^signing_set]: `crates/eth-engine/src/ipc/ethereum_ipc.rs` L148–155 — the signing set for height H is queried at `H − 1`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/eth-engine/src/ipc/ethereum_ipc.rs#L148-L155
[^threshold]: Malachite `code/crates/core-types/src/threshold.rs` L54 (`TWO_F_PLUS_ONE = 2/3`), L68–77 (`weight × 3 > total × 2`). https://github.com/circlefin/malachite/blob/a453b32155f4ba9f959724279b52f601bae92e09/code/crates/core-types/src/threshold.rs#L54-L77
[^verify_ext]: Malachite `code/crates/signing/src/ext.rs` L289 (`DuplicateVote`), L295 (`UnknownValidator`), L420 (`verify_commit_certificate`). https://github.com/circlefin/malachite/blob/a453b32155f4ba9f959724279b52f601bae92e09/code/crates/signing/src/ext.rs#L283-L295
[^eth_primitives]: `crates/evm-node/src/node.rs` L247 — `type Primitives = EthPrimitives`. https://github.com/circlefin/arc-node/blob/6e764023ee6515fe70573e123ed2db912a7207b4/crates/evm-node/src/node.rs#L247
[^chainstack_methods]: Chainstack, *Arc methods*: `eth_getBlockReceipts`, `eth_getProof` and header methods available. https://docs.chainstack.com/docs/arc-methods
[^chainstack_cert]: Chainstack, *arc_getCertificate*: response fields and error codes `-32602`, `-32004`, `-32005`. https://docs.chainstack.com/reference/arc-getcertificate
[^alchemy_cert]: Alchemy, *arc_getCertificate*: only available for finalized blocks; immutable once it exists; safe to cache indefinitely. https://www.alchemy.com/docs/chains/arc/arc-api-endpoints/arc-get-certificate
[^arc_infra]: Arc docs, *Infrastructure*: chain IDs, RPC, explorer, USDC ERC-20 address. https://docs.arc.io/integrate/infrastructure
[^arc_rpc]: Arc docs, *RPC endpoints*: Circle, Blockdaemon, dRPC, QuickNode testnet endpoints. https://docs.arc.io/arc/references/rpc-endpoints
[^arc_wallets]: Arc docs, *Wallets*: testnet RPC, chain ID, USDC ERC-20 contract `0x3600…0000`. https://docs.arc.io/integrate/wallets
[^alchemy_arc]: Alchemy, *What is Arc*: native 18-decimal view vs 6-decimal ERC-20 view; indexers must match on emitter address; Arc-specific gotchas. https://www.alchemy.com/overviews/what-is-arc
[^arc_foundry]: Arc Foundry, a fork of Foundry with Arc support. https://github.com/circlefin/arc-foundry
