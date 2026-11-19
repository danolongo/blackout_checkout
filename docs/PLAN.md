# Blackout Checkout — Implementation Plan

**Track:** Consumer Applications · **Chain award:** Best use of Arc · **Network:** Arc Testnet

> A vendor with no signal can take a USDC payment that is already final before the goods change hands. The customer pays over their own connection, then shows a receipt QR code. The vendor's phone checks that receipt offline.

---

## 1. Goal and the one claim that must hold

The headline claim is: **"the vendor's phone verifies the payment in airplane mode."** The whole build is arranged to protect that claim. There are two ways to check a receipt, and they are built in this order:

| Mode | What the vendor phone checks offline | Trust assumption | Status |
|---|---|---|---|
| **Tier B: attested receipt** | One signature from the Blackout relay over `(orderId, vendor, amount, txHash, block)` | The relay checked the chain honestly | Explicit fallback after the proof spike |
| **Tier A: finality proof** | Arc validator quorum signatures on the block, then a Merkle proof that the `OrderPaid` event is in that block | Trusted Arc checkpoint and the validator keys valid at the certified height | Target, built second |

The demo and pitch claim Tier A only if the spike in Phase 0 confirms it works end to end. Otherwise, the pitch says "signed receipt, checked against Arc again when the vendor reconnects." Be honest about which one you're demoing; judges will ask.

---

## 2. Arc facts this plan relies on

| Item | Value |
|---|---|
| Testnet chain ID | `5042002` |
| RPC | `https://rpc.testnet.arc.io` (WS: `wss://rpc.testnet.arc.io`) |
| Explorer | `https://explorer.testnet.arc.io` |
| USDC | Native gas token, **18 decimals** natively (`msg.value`). The ERC-20 view at `0x3600000000000000000000000000000000000000` uses **6 decimals**, and both views share one balance |
| Finality | Deterministic, sub-second, no reorgs. A transaction is either unconfirmed or final |
| Finality proof RPC | `arc_getCertificate(height)` → `{ height, round, block_hash, signatures: [{ address, signature(base64) }] }`. It's in the custom `arc_*` namespace, not listed by `rpc_modules`, check availability on the selected endpoint |
| Contract tooling | Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`) is recommended for Arc's protocol differences |
| Gotchas | 20 Gwei `maxFeePerGas` floor · blocklisted-address reverts still consume gas · sends to `address(0)` revert · native USDC transfers emit system logs from a system emitter (don't double-count) |

**Unknowns the spike must answer (Phase 0):**
1. Confirm the documented Ed25519 format against the deployed Arc node version and real fixtures.
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

1. **The vendor creates an order (offline).** The phone generates a random 128-bit `orderId`, stores `{chain, contract, vendor, orderId, amount, createdAt, status: open}` and shows the **order QR**.
2. **The customer scans and pays (online).** The customer app decodes the QR and shows "Pay $12.00 to Taco Stand #4." It sends a single transaction: `BlackoutCheckout.pay{value: amount}(vendor, orderId)`.
   - Because USDC is Arc's native token, this takes **one transaction with no ERC-20 approve step**. This is a concrete "best use of Arc" point.
3. **The chain finalizes in under a second.** The customer app waits for the receipt, then fetches `arc_getCertificate(blockNumber)`.
4. **The customer app builds the receipt bundle** (Tier A, Tier B or both) and shows the **receipt QR** (animated over several frames if it's too big for one).
5. **The vendor scans the receipt (offline).** The phone checks it (section 6). If valid, it marks the order `paid`, shows a big green check and the goods go out.
6. **Later sync (online).** The vendor phone uploads accepted receipts. The reconciliation service rechecks each transaction against Arc and flags anything that doesn't match.

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
  contract, orderId, vendor, payer, amount, // authenticate contract and amount
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
7. Verify the receipt version, chain, contract, order, vendor, payer, amount, block number, block hash, timestamp, log position and transaction hash under the preloaded relay key. Label this mode “Relay confirmed.”

**Tier A**
7. Validator quorum: for each `sig` in `cert.sigs`, look up the validator in the stored snapshot, verify the signature over the canonical vote bytes and add up voting power. Require **more than 2/3** of total power, with no duplicate signers.
8. Link the certificate to the header: require that the header hash matches the certified value under the verified Arc encoding. Read height and timestamp from that authenticated header. A receipt inclusion proof alone does not authenticate a transaction hash.
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

    mapping(bytes32 => bool) private settled;
    error AlreadyPaid();
    error ZeroAmount();
    error ForwardFailed();

    function pay(address payable vendor, bytes16 orderId) external payable {
        if (msg.value == 0 || vendor == address(0)) revert ZeroAmount();
        bytes32 terms = keccak256(abi.encode(vendor, orderId, msg.value));
        if (settled[terms]) revert AlreadyPaid();
        settled[terms] = true;
        (bool ok, ) = vendor.call{value: msg.value}("");
        if (!ok) revert ForwardFailed();
        emit OrderPaid(orderId, vendor, msg.sender, msg.value);
    }
}
```
**Design notes**
- Funds go straight to the vendor, so the contract never holds a balance and has nothing to drain.
- The event comes from **our contract**, so verifiers never parse Arc's system-emitter transfer logs (no double-counting).
- Reject a repeat payment for the same vendor, order ID and amount before forwarding. A failed transfer reverts the mark. A different amount cannot lock the intended terms. The vendor separately consumes its open order atomically.
- Tests (Foundry): pays and forwards the exact value · emits the correct event · reverts on zero · reverts when the vendor rejects ETH-style transfers · gas snapshot.

---

## 8. Validator-set and key sync (before the event)

- When online, the vendor app downloads a **signed snapshot**: `{ chainId, validatorSet: [{address, pubKey, power}], fromHeight, relayPubKey, checkoutAddress }`.
- Pin an independently sourced snapshot to its valid block range. Reject certificates outside that range. A relay or customer must never supply their own trust root inside a receipt. Use only the mode explicitly selected for the sale.

---

## 9. Build phases

### Phase 1. Test the proof first

Use a real Arc Testnet block and successful receipt. Save the certificate, block header, receipt proof, and an independently trusted validator snapshot valid for that height. Reproduce Arc’s exact final vote encoding. Require signatures from distinct validators representing more than two thirds of voting power. Authenticate the header, then verify receipt inclusion against its receipts root. Measure the complete proof in bytes. If the bulk receipts method is unavailable, try fetching the individual receipts for that block. [Certificate fields](https://www.quicknode.com/docs/arc/arc_getCertificate) · [Arc consensus](https://docs.arc.io/arc/concepts/consensus-layer)

**Pass when** a verifier with networking disabled accepts the genuine receipt and rejects altered data, duplicate voting power, and exactly two thirds of voting power. Record the network, height, block hash, node version and passing command. If independent verification is blocked after 90 minutes, record what failed. Continue on the existing relay path only if it can check a finalized payment and sign it. Label that result “Relay confirmed.” Never silently downgrade a sale.

### Phase 2. Wire one exact sale into the web app

Test the contract already sketched in section 7. Deploy it on Arc Testnet and save the address and deployment block. The buyer pays native USDC once, and the contract forwards the exact amount and emits its event only after success. The verifier checks the approved contract and compares its event with an open order created on that register. Store the network, contract, vendor, order ID and amount in the order record. Use 18 decimal native units throughout.

Connect a simple Customer payment screen and Merchant verification screen to this flow. Bundle public test fixtures for repeatable offline checks. Use a dedicated testnet wallet for the demo. An atomic local update prevents a second handoff. A customer app lookup alone cannot prevent simultaneous charges. Make the contract reject a second successful payment for the same vendor, order ID and exact amount. A payment for a different amount must leave the intended order payable. For relay receipts, sign the version, network, contract, order, vendor, payer, amount and exact block and transaction reference. For Arc proofs, derive the height and timestamp from authenticated data and match the event in the verified receipt. Treat a supplied transaction hash as a display reference unless independently proven.

**Pass when** a real payment reaches the vendor, the verifier accepts the exact order, a different order at the same price fails, and retrying payment cannot charge twice for the same terms.

### Phase 3. Run the live QR checkout on two iPhones

Open the HTTPS site on both phones. Precache the merchant app and trusted validator data. Put the merchant phone in airplane mode with WiFi off, then quit and reopen the app. Create a fresh order. The buyer scans it, pays, and stays connected until the proof is ready. The buyer can now disconnect too. Hand the proof back by QR and mark the sale paid in a single IndexedDB transaction. Start with a single QR and use animated frames if the measured proof needs them.

**Pass when** the two actual demo phones complete three sales, a replay after restart is refused, and another vendor’s receipt is refused. Record scan time and show the verification mode that actually passed. Use this checkout for Consumer Applications and Best use of Arc. Include the public repo, demo, architecture, contract address, test transactions and video. Aim for November 20 at 10 am Central ahead of the noon deadline. [Submission requirements](https://ubc-hackathon-2026.devpost.com/)

### Phase 4. Reconcile sales and finish the submission

Reconnect the merchant phone. Check each locally accepted receipt against Arc, show its transaction reference and flag any discrepancy. Measure scan time on the two devices, record the demo and submit the working browser version. A QR receipt can be kept in the web app. Apple Wallet receipt signing and contactless pass certification make Wallet and tap a separate future decision. [Wallet pass signing](https://developer.apple.com/wallet/get-started/) · [Contactless pass requirements](https://developer.apple.com/wallet/loyalty-passes/)

**Pass when** the cashier can reopen a completed sale, see its reconciliation result, and give the judges a working demo link.

---

## 10. Demo script (2–3 minutes)

1. **Problem (20s):** COTA crowd, card reader spinning, "offline mode" means the vendor takes the risk.
2. **Setup (10s):** turn the vendor phone to **airplane mode on camera.**
3. **Happy path (45s):** create a $12 order, customer scans and pays, receipt QR, vendor scans, green check. Cut to the explorer showing the real tx hash.
4. **Attack 1 (20s):** the same receipt is shown again and rejected as "already used."
5. **Attack 2 (20s):** a receipt for a different stand's order is rejected as "not this vendor's order."
6. **Attack 3 (15s, Tier A only):** a tampered amount or forged certificate is rejected as "invalid validator quorum."
7. **Why Arc (20s):** distinguish measured checkout time from Arc finality; one-tx native USDC payment, dollar-denominated fees.
8. **Close (10s):** vendor reconnects, sales sync and reconcile.

---

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Certificate signatures can't be verified offline (unknown scheme/encoding/keys) | Tier A not possible | Explicit relay mode after the proof gate; label its trust assumption |
| Tier A bundle too large for QR | Slow or failed scans | Measure early; animated QR; compress; or Tier B for the demo |
| Customer also has no signal | Payment can't start | Out of scope for the demo; say so; venue Wi-Fi/other carrier is the real-world answer |
| Validator set rotates mid-event | Tier A rejects valid receipts | Reject certificates outside the trusted height range |
| 6- vs 18-decimal mix-up | Wrong amount accepted/rejected | One unit (18-dec native) end to end; display conversion only; unit tests |
| Blocklisted vendor/payer | Tx reverts, gas consumed | Surface the revert reason clearly in the customer app |
| Testnet changes (event formats have changed before) | Verifier breaks | Pin fixtures; re-run tests before recording the demo |
| Relay key compromise (Tier B) | Forged receipts accepted | Post-event re-verification flags fraud; keep the relay key off the vendor device |

---

## 12. Submission checklist

- [ ] Working deployed demo (customer page + vendor PWA)
- [ ] Contract address on Arc Testnet + verified source
- [ ] At least 3 real testnet tx hashes in the README
- [x] README: architecture, verification algorithm, trust model per tier, setup steps
- [ ] 2–3 minute demo video (YouTube / Drive)
- [ ] Written answers: problem, how it works, what's unique, next steps
- [ ] Tech/sponsor list: Arc, native USDC, `arc_getCertificate`, (Circle wallets if used)
- [ ] Track: Consumer Applications · Chain award: Best use of Arc
