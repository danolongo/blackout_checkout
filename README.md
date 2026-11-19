# Blackout Checkout

**Track:** Consumer Applications · **Chain award:** Best use of Arc · **Network:** Arc Testnet (chain `5042002`)

A vendor with no signal can take a USDC payment that is already final before the goods change hands. The customer pays over their own connection, then shows a receipt QR code. The vendor's phone checks that receipt in airplane mode, and rechecks every accepted sale against Arc once it reconnects.

The full plan, demo script and risk register are in [docs/PLAN.md](docs/PLAN.md).

## How a sale works

1. **Vendor creates an order (offline).** The register generates a random 128-bit order ID and stores `{chain, contract, vendor, id, amount, created, expires, status: open}` in IndexedDB. It shows the order as a QR link (the order sits in the URL fragment, so it never reaches server logs).
2. **Customer scans and pays (online).** The customer page sends one transaction: `BlackoutCheckout.pay{value: amount}(vendor, orderId)`. USDC is Arc's native gas token, so there is no ERC-20 approve step.
3. **Arc finalizes it.** The relay signs a receipt only once the payment's block is at or below Arc's `finalized` block, the contract bytecode matches, and exactly one `OrderPaid` event comes from the checkout contract.
4. **Customer shows the receipt QR.** It holds a single frame of about 600 bytes.
5. **Vendor scans it (offline).** The register checks it and marks the order paid in one IndexedDB transaction, so a second scan of the same receipt is refused. It records scan time and check time.
6. **Vendor reconnects.** The register rechecks each accepted sale directly against Arc and flags any disagreement (see [Reconciliation](#reconciliation)).

## Architecture

```
┌──────────────────────┐   1. Order QR (offline)    ┌───────────────────────┐
│  VENDOR REGISTER     │ ─────────────────────────▶ │ CUSTOMER PAGE         │
│  (PWA, works offline)│                            │ - testnet wallet      │
│  - creates orders    │   4. Receipt QR (offline)  │ - pay() in one tx     │
│  - verifies receipts │ ◀───────────────────────── │                       │
│  - IndexedDB sales   │                            └──────────┬────────────┘
└─────────┬────────────┘                                       │ 2. tx  3. signed receipt
          │ 6. reconcile when online (direct to Arc RPC)       ▼
          ▼                                         ┌───────────────────────┐
┌──────────────────────┐                            │  ARC TESTNET          │
│  ARC TESTNET RPC     │                            │  BlackoutCheckout.sol │
└──────────────────────┘                            └──────────▲────────────┘
                                                               │ reads finalized receipt
                                                    ┌──────────┴────────────┐
                                                    │ RELAY (server/)       │
                                                    │ - serves the PWA      │
                                                    │ - signs final receipts│
                                                    └───────────────────────┘
```

| Path | Role |
|---|---|
| `contracts/BlackoutCheckout.sol` | Forwards native USDC to the vendor once per `(vendor, orderId, amount)`, then emits `OrderPaid` |
| `src/payment.mjs` | Order terms and `OrderPaid` parsing in 18-decimal native units |
| `src/settlement.mjs` | Reads a finalized payment from Arc (shared by the relay and the register) |
| `src/attestation.mjs` | Canonical relay receipt bytes and offline P-256 signature check |
| `src/reconcile.mjs` | Compares an accepted receipt with what Arc says now |
| `src/proof.mjs` | Arc finality proof: Ed25519 precommit quorum and receipt-trie inclusion |
| `server/start.mjs` | Relay: `/api/config`, `/api/receipt/<tx>`, static PWA |
| `web/` | Register and customer UI, IndexedDB store, service worker build |

## Verification modes and trust model

| Mode | What the register checks offline | Trust assumption | State in this build |
|---|---|---|---|
| **Relay confirmed** (Tier B) | A P-256 signature from the pinned relay key over version, mode, chain, contract, vendor, order, amount, payer, tx hash, block hash, height, timestamp and log index | The relay read Arc honestly. Reconciliation catches a relay that did not. | **Used by the register UI.** Every sale is labelled "Relay confirmed". |
| **Arc finality proof** (Tier A) | More than ⅔ of the voting power across distinct validators signing Arc precommits, the header hash equal to the certified block hash, then the receipt in that header's receipts trie | A pinned validator snapshot valid for the certified height | Verified offline in tests against a real Arc Testnet block. Not yet offered in the register UI. |

The Tier A check replays Arc Testnet block `73090654` (tx `0x321e2376e51675d063c92b89d67f243d376e3afc5a2b1074906e5655fdd53be6`; 14 of 20 validators signed). The proof is about 4.8 KB of JSON, which is too big for a single QR, so the demo uses Relay confirmed. Its validator snapshot was read from Arc's RPC for that test; production needs an independently sourced checkpoint.

### Offline checks on the register

1. The receipt's order ID belongs to an order this register created, and that order is still `open` (blocks other vendors' receipts and replays).
2. Chain, contract, vendor, order ID and amount equal the stored order exactly (18-decimal native units).
3. Block timestamp falls between `created − 60 s` and `expires` (15 minutes).
4. The relay signature verifies under the relay key that was pinned when the register was set up.
5. Order `open → paid` happens in one IndexedDB read-write transaction.

## Reconciliation

When the register comes back online, it rechecks every paid sale. It does this on the `online` event, at app start and after each accepted sale, and the cashier can also tap **Check against Arc** on any sale. It queries Arc's RPC directly rather than asking the relay, so a compromised relay key shows up here.

For each sale it re-reads the transaction from Arc and requires:

- the RPC reports chain `5042002`
- the transaction exists and succeeded, and its block hash is unchanged
- the checkout contract's bytecode hash matches the pinned `codeHash`
- exactly one `OrderPaid` event comes from the checkout contract
- Arc's chain, contract, vendor, order ID and amount equal the stored order
- each signed receipt field (chain, contract, vendor, order ID, amount, payer, tx hash, block hash, height, time, log index) equals Arc's value
- no other accepted sale uses the same transaction

| Result | Meaning |
|---|---|
| Confirmed on Arc | Everything above matched |
| Awaiting Arc finality | The payment is valid but its block is not yet final. Check again. |
| Discrepancy | Shows each failed check. Do not rely on this sale. |
| Not yet checked | The register has not reached Arc since accepting the sale |

A sale is never marked as discrepant just because the network is down. It stays unchecked until Arc answers. The sale detail view shows the order, the transaction (linked to the Arc explorer), payer, block, verification mode, scan and check times, and when it was last checked.

## Setup

Requires Node 22.

```bash
npm install
```

```bash
npm test
```

Create the relay signing key (written to `.env.relay`, which is git-ignored):

```bash
npm run keygen
```

Deploy the contract with a dedicated, funded Arc Testnet key ([faucet](https://faucet.circle.com)). This writes `artifacts/deployment.json`:

```bash
ARC_TESTNET_KEY=0x... npm run deploy
```

If you'd rather not hand a key to the script, `node scripts/deploy.mjs --prepare` writes a pre-signed contract creation for a fresh throwaway address to `artifacts/deployment-request.json`.

Build the PWA and start the relay:

```bash
npm run build
```

```bash
CHECKOUT_ADDRESS=0x... npm start
```

Serve it over HTTPS (e.g. a reverse proxy or tunnel to port `4173`). iPhones need a secure context for the camera and the service worker. Open the site once online on the vendor phone so the register and its trust settings are cached. After that it works in airplane mode.

Optional settings: `ARC_RPC` (RPC the relay reads), `PUBLIC_ARC_RPC` (RPC the browser uses), `PORT`, and `RELAY_PRIVATE_JWK` (in place of `.env.relay`).

## Testnet evidence

To fill in from the demo run (Phase 3 and Phase 4 device runs):

| Item | Value |
|---|---|
| Checkout contract | _pending deployment_ |
| Deployment transaction / block | _pending_ |
| Sale 1 transaction | _pending_ |
| Sale 2 transaction | _pending_ |
| Sale 3 transaction | _pending_ |
| Measured scan time (two demo iPhones) | _pending_ |
| Demo link / video | _pending_ |

## Submission answers

- **Problem.** At crowded venues, card readers lose signal. In "offline mode" the vendor carries the risk of every sale.
- **How it works.** The customer pays one native USDC transaction on Arc. The vendor's phone checks a signed receipt with no network, then reconciles with Arc after reconnecting.
- **What's unique.** Arc's deterministic finality means a receipt is final when it's shown. There are no reorgs to wait out. Native USDC makes payment one transaction with no approval step, and fees are in dollars. Replays and other vendors' receipts are refused on the device.
- **Next steps.** Ship the Tier A finality proof to the register over an animated multi-frame QR, with an independently sourced validator checkpoint. Add an optional Apple Wallet receipt. Both are listed in the plan.
- **Built with.** Arc Testnet, native USDC, `arc_getCertificate`, ethers, @noble/curves, @ethereumjs/trie, qrcode, jsQR.
