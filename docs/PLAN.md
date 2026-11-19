# Blackout Checkout — Implementation Plan

**Track:** Consumer Applications · **Chain award:** Best use of Arc · **Network:** Arc Testnet

> A vendor with no signal can take a USDC payment that is already final before the goods change hands. The customer pays over their own connection, then shows a receipt QR code. The vendor's phone checks that receipt offline.

---

## 1. Goal and the one claim that must hold

The headline claim is: **"the vendor's phone verifies the payment in airplane mode."** The whole build is arranged to protect that claim. There are two ways to check a receipt, and they are built in this order:

| Mode | What the vendor phone checks offline | Trust assumption | Status |
|---|---|---|---|
| **Tier B: attested receipt** | One signature from the Blackout relay over `(orderId, vendor, amount, txHash, block)` | The relay checked the chain honestly | Guaranteed fallback, built first |
| **Tier A: finality proof** | Arc validator quorum signatures on the block, then a Merkle proof that the `OrderPaid` event is in that block | Only Arc's validator set (keys synced before the event) | Target, built second |

The demo and pitch claim Tier A only if the spike in Phase 0 confirms it works end to end. Otherwise, the pitch says "signed receipt, fully re-verified on-chain when the vendor reconnects." Be honest about which one you're demoing; judges will ask.

---

## 2. Arc facts this plan relies on

| Item | Value |
|---|---|
| Testnet chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` (WS: `wss://rpc.testnet.arc.io`) |
| Explorer | `https://explorer.testnet.arc.io` |
| USDC | Native gas token, **18 decimals** natively (`msg.value`). The ERC-20 view at `0x3600000000000000000000000000000000000000` uses **6 decimals**, and both views share one balance |
| Finality | Deterministic, sub-second, no reorgs. A transaction is either unconfirmed or final |
| Finality proof RPC | `arc_getCertificate(height)` → `{ height, round, block_hash, signatures: [{ address, signature(base64) }] }`. It's in the custom `arc_*` namespace, not listed by `rpc_modules`, but it still works |
| Contract tooling | Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`) is recommended for Arc's protocol differences |
| Gotchas | 20 Gwei `maxFeePerGas` floor · blocklisted-address reverts still consume gas · sends to `address(0)` revert · native USDC transfers emit system logs from a system emitter (don't double-count) |

**Unknowns the spike must answer (Phase 0):**
1. What signature scheme do the certificate signatures use (Ed25519 vs secp256k1)?
2. What exact bytes does each validator sign (the canonical vote/commit encoding: height, round, value ID)?
3. Where do validator **public keys** and voting power come from? The certificate only lists addresses.
4. Does the certificate's `block_hash` equal the EVM block header hash (`keccak(rlp(header))`), or is it a Malachite value ID that has to be linked to the header separately?
5. Does `eth_getBlockReceipts` work on the public RPC, so a receipt-trie proof can be built client-side?

If questions 1–4 can't all be answered from the Malachite/Arc source code within the spike's timebox, ship Tier B as the demo and present Tier A as the next step.

---

## 3. Architecture

```
┌──────────────────────┐   1. Order QR (offline)    ┌───────────────────────┐
│  VENDOR PHONE (PWA)  │ ─────────────────────────▶ │ CUSTOMER PHONE (web)  │
│  - creates orders    │                            │ - wallet (USDC/Arc)   │
│  - stores validator  │                            │ - pays via contract   │
│    set + relay key   │   4. Receipt QR (offline)  │ - builds proof bundle │
│  - verifies offline  │ ◀───────────────────────── │                       │
│  - consumed-order DB │                            └──────────┬────────────┘
└─────────┬────────────┘                                       │ 2. tx + 3. proof data
          │ 5. later sync (when online)                        ▼
          ▼                                         ┌───────────────────────┐
┌──────────────────────┐                            │      ARC TESTNET      │
│  RELAY / SYNC API    │ ◀──── reads certs, ───────▶│  BlackoutCheckout.sol │
│  - Tier B attestor   │       receipts, logs       │  arc_getCertificate   │
│  - re-verifies sales │                            └───────────────────────┘
│  - vendor dashboard  │
└──────────────────────┘
```

**Components**
- **Vendor app:** a PWA with a service worker, so it loads and runs with no network. It has a camera QR scanner, order creation, an offline verifier and local storage (IndexedDB).
- **Customer app:** a mobile web page that opens from the order QR. It includes a simple wallet (an embedded key or passkey-backed account), the payment flow and the proof builder.
- **Contract:** `BlackoutCheckout.sol` on Arc Testnet.
- **Relay/sync API:** small and stateless. It provides Tier B attestations, publishes the validator-set snapshot and does post-event re-verification.

---

## 4. Payment flow, step by step

1. **The vendor creates an order (offline).** The phone generates a random 128-bit `orderId`, stores `{orderId, amount, createdAt, status: open}` and shows the **order QR**.
2. **The customer scans and pays (online).** The customer app decodes the QR and shows "Pay $12.00 to Taco Stand #4." It sends a single transaction: `BlackoutCheckout.pay{value: amount}(vendor, orderId)`.
   - Because USDC is Arc's native token, this takes **one transaction with no ERC-20 approve step**. This is a concrete "best use of Arc" point.
3. **The chain finalizes in under a second.** The customer app waits for the receipt, then fetches `arc_getCertificate(blockNumber)`.
4. **The customer app builds the receipt bundle** (Tier A, Tier B or both) and shows the **receipt QR** (animated over several frames if it's too big for one).
5. **The vendor scans the receipt (offline).** The phone checks it (section 6). If valid, it marks the order `paid`, shows a big green check and the goods go out.
6. **Later sync (online).** The vendor phone uploads accepted receipts. The relay re-checks each one on-chain and flags anything that doesn't match.

---

## 5. Data formats

### 5.1 Order QR (vendor → customer)
Kept small for fast scanning. Encode as a URL so the phone's camera opens the customer app directly:
```
https://pay.blackout.app/o#v=1&c=5042002&k=<checkoutContract>&to=<vendorAddr>&id=<orderId hex16>&amt=<amount wei, 18-dec>&lbl=<url-encoded label>
```
Using the URL **fragment** (`#`) keeps order data out of server logs.

### 5.2 Receipt bundle (customer → vendor)
CBOR-encoded, then deflate-compressed, then base45 for an alphanumeric QR.
```
{
  v: 1,
  chain: 5042002,
  orderId, vendor, payer, amount,          // must match the open order
  txHash, blockNumber, blockTimestamp,
  tierB?: { relaySig },                    // signature over the tuple above
  tierA?: {
    cert: { height, round, blockHash, sigs: [{ addr, sig }] },
    header: <RLP block header>,            // to link blockHash → receiptsRoot
    receiptIndex, receiptProof: [<MPT nodes>],
    logIndex
  }
}
```
**QR size budget:** A single scannable QR code realistically holds about 1–1.5 KB. A Tier A bundle (certificate + header + receipt proof) will probably be bigger. Plan for an **animated multi-frame QR** (fountain-coded, e.g. the BC-UR approach) and measure real bundle sizes in Phase 0. Tier B alone (about 200 bytes) fits in one frame.

---

## 6. Offline verification algorithm (vendor phone)

Run every check below and reject on the first failure. Show the reason on screen; it helps both the vendor and the demo.

**Common checks (both tiers)**
1. `chain == 5042002` and `contract == stored checkout address`.
2. `orderId` matches an **open** order on this device. This blocks receipts for other vendors' orders.
3. `vendor == this device's vendor address`.
4. `amount == order.amount`, compared in **18-decimal native units**. Never mix this with 6-decimal ERC-20 values.
5. `blockTimestamp` falls between `order.createdAt − 1 min` and `+ 15 min` (by the device clock).
6. The order isn't already `paid`/consumed, which stops screenshot replay. Mark it consumed **atomically** on success.

**Tier B**
7. Verify `relaySig` over the canonical tuple against the relay public key stored on the device.

**Tier A**
7. Validator quorum: for each `sig` in `cert.sigs`, look up the validator in the stored snapshot, verify the signature over the canonical vote bytes and add up voting power. Require **more than 2/3** of total power, with no duplicate signers.
8. Link the certificate to the header: `cert.blockHash == hash(header)`, or whatever link Phase 0 finds.
9. Get `receiptsRoot` from the header. Verify `receiptProof` against `receiptsRoot` at key `rlp(receiptIndex)`.
10. Decode the receipt: `status == 1`, and log `logIndex` comes from the checkout contract with topic0 = `OrderPaid` and matching `orderId`, `vendor`, `payer`, `amount`.

Use `@noble/curves` (ed25519/secp256k1), `@noble/hashes` (keccak, sha256) and `@ethereumjs/trie` + `@ethereumjs/rlp` (proof verification). All of them are pure JS and work offline.

---

## 7. Smart contract

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Native-USDC checkout on Arc. One tx, no approve.
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
**Design notes**
- Funds go straight to the vendor, so the contract never holds a balance and has nothing to drain.
- The event comes from **our contract**, so verifiers never parse Arc's system-emitter transfer logs (no double-counting).
- There is deliberately **no on-chain "already paid" lock** keyed by `orderId`. A third party could grief that by paying a wrong amount first. Duplicate-payment protection lives in the customer app (check for an existing `OrderPaid` before paying) and in the vendor's consumed-order store.
- Tests (Foundry): pays and forwards the exact value · emits the correct event · reverts on zero · reverts when the vendor rejects ETH-style transfers · gas snapshot.

---

## 8. Validator-set and key sync (before the event)

- When online, the vendor app downloads a **signed snapshot**: `{ chainId, validatorSet: [{address, pubKey, power}], fromHeight, relayPubKey, checkoutAddress }`.
- Show snapshot age in the vendor UI ("Keys synced 2h ago"). If a certificate signer isn't in the snapshot (the validator set rotated), Tier A fails cleanly and falls back to Tier B or "accept and verify later" (the vendor chooses; the default is to reject).
- How to source the validator set is a Phase 0 question. Options: an Arc RPC/registry contract if one exists, or keys collected from historical certificates (only works if signatures allow public-key recovery, as secp256k1 does).

---

## 9. Build phases

Priorities: **P0** = needed for the demo, **P1** = strongly wanted, **P2** = nice to have.

### Phase 0 — Spike and de-risk (timebox: ~4 hours) · P0
- [ ] Call `arc_getCertificate` on testnet. Save 3 real certificates as fixtures.
- [ ] Answer unknowns 1–5 from section 2 using the Malachite/Arc source and fixtures.
- [ ] Prove one signature verifies offline in JS. **Decide whether Tier A is a go or no-go.**
- [ ] Build one receipt-trie proof for a real tx and measure the Tier A bundle size.
- [ ] Faucet-fund 3 test wallets (vendor, customer, relay).

### Phase 1 — Contract (~2 hours) · P0
- [ ] Deploy `BlackoutCheckout` with `arc-forge`. Verify it on the explorer and record the address for the README.
- [ ] Foundry tests passing.

### Phase 2 — Customer pay flow (~4 hours) · P0
- [ ] Mobile web page that parses the order URL fragment.
- [ ] Wallet: embedded key with a balance display in dollars (convert 18-decimal values for display only).
- [ ] `pay()` with a clear success state and the tx hash.
- [ ] Duplicate-payment guard (query for an existing `OrderPaid` first).

### Phase 3 — Vendor PWA, Tier B end to end (~6 hours) · P0
- [ ] Service worker + offline shell; works with the phone in airplane mode after the first load.
- [ ] Order creation, order QR, IndexedDB store.
- [ ] Relay endpoint: given a `txHash`, it checks the receipt and certificate on-chain and signs the receipt tuple.
- [ ] Customer app shows the Tier B receipt QR; the vendor scans and verifies offline; green check / red X with reasons.
- [ ] Replay and wrong-vendor rejection.

**Milestone:** a full airplane-mode demo works with Tier B. **From here on, the project is demoable.**

### Phase 4 — Tier A finality proof (~8 hours) · P1 (only if Phase 0 = go)
- [ ] Proof builder in the customer app (certificate + header + receipt proof).
- [ ] Offline quorum and Merkle-proof verifier in the vendor PWA, with unit tests against the Phase 0 fixtures.
- [ ] Animated multi-frame QR if the bundle is over budget.
- [ ] Validator snapshot sync + staleness UI.

### Phase 5 — Sync and dashboard (~3 hours) · P1
- [ ] Vendor uploads accepted receipts when back online; the relay re-verifies and flags mismatches.
- [ ] Simple sales list per vendor (order, amount, tx link) for reconciliation.

### Phase 6 — Polish and submission (~4 hours) · P0
- [ ] UX polish: amounts in dollars, no crypto jargon on the vendor screen, big scan targets, haptics/sound on success.
- [ ] README: architecture diagram, verification algorithm, contract address, **real testnet tx hashes**, trust model by tier.
- [ ] 2–3 minute demo video (script below).
- [ ] Devpost written answers.

### P2 stretch
- Refund flow when the vendor is back online (vendor sends USDC back, linked to `orderId`).
- Tip line on the order QR.
- Multiple staff devices per vendor sharing one consumed-order set after sync.

---

## 10. Demo script (2–3 minutes)

1. **Problem (20s):** COTA crowd, card reader spinning, "offline mode" means the vendor takes the risk.
2. **Setup (10s):** turn the vendor phone to **airplane mode on camera.**
3. **Happy path (45s):** create a $12 order, customer scans and pays, receipt QR, vendor scans, green check. Cut to the explorer showing the real tx hash.
4. **Attack 1 (20s):** the same receipt is shown again and rejected as "already used."
5. **Attack 2 (20s):** a receipt for a different stand's order is rejected as "not this vendor's order."
6. **Attack 3 (15s, Tier A only):** a tampered amount or forged certificate is rejected as "invalid validator quorum."
7. **Why Arc (20s):** sub-second deterministic finality means nothing to "decline later," one-tx native USDC payment, dollar-denominated fees.
8. **Close (10s):** vendor reconnects, sales sync and reconcile.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Certificate signatures can't be verified offline (unknown scheme/encoding/keys) | Tier A not possible | Tier B built first; claim matches what's shipped |
| Tier A bundle too large for QR | Slow or failed scans | Measure early; animated QR; compress; or Tier B for the demo |
| Customer also has no signal | Payment can't start | Out of scope for the demo; say so; venue Wi-Fi/other carrier is the real-world answer |
| Validator set rotates mid-event | Tier A rejects valid receipts | Snapshot staleness check; fallback policy |
| 6- vs 18-decimal mix-up | Wrong amount accepted/rejected | One unit (18-dec native) end to end; display conversion only; unit tests |
| Blocklisted vendor/payer | Tx reverts, gas consumed | Surface the revert reason clearly in the customer app |
| Testnet changes (event formats have changed before) | Verifier breaks | Pin fixtures; re-run tests before recording the demo |
| Relay key compromise (Tier B) | Forged receipts accepted | Post-event re-verification flags fraud; keep the relay key off the vendor device |

---

## 12. Submission checklist

- [ ] Working deployed demo (customer page + vendor PWA)
- [ ] Contract address on Arc Testnet + verified source
- [ ] At least 3 real testnet tx hashes in the README
- [ ] README: architecture, verification algorithm, trust model per tier, setup steps
- [ ] 2–3 minute demo video (YouTube / Drive)
- [ ] Written answers: problem, how it works, what's unique, next steps
- [ ] Tech/sponsor list: Arc, native USDC, `arc_getCertificate`, (Circle wallets if used)
- [ ] Track: Consumer Applications · Chain award: Best use of Arc
