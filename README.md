# Blackout Checkout

Blackout Checkout lets a merchant create an Arc Testnet USDC order without a connection. The customer stays online to pay and obtain a receipt QR. The merchant scans it offline, records the sale once, and reconciles it when back online.

## Run

Use Node 22 or newer. Run `npm install`, `npm run compile`, and `npm run build`. Set `CHECKOUT_ADDRESS` to the deployed contract address, then run `npm start`. If `.env.relay` does not exist, run `npm run keygen` once before starting. Keep that file and all wallet keys private. The site starts at `http://localhost:4173`; phones need a trusted HTTPS origin they can both reach.

The existing Arc Testnet contract is `0x3bd12A4Cba4771F3B5c82375c19f53618b6b5418`. A scripted 0.01 test USDC purchase succeeded in [transaction `0xba818f8a…34bf0c`](https://explorer.testnet.arc.io/tx/0xba818f8a8a4a14dcfc3680b76f71116a40f85c51eb24a104640086cc4e34bf0c). This was not a two phone purchase.

To deploy your own contract, fund a dedicated Arc Testnet wallet, set `ARC_TESTNET_KEY` in your shell, and run `npm run deploy`. Use the returned contract address as `CHECKOUT_ADDRESS`. `ARC_RPC` may point to a private upstream endpoint; `PUBLIC_ARC_RPC` must be safe for the customer's browser.

## Receipt trust

The default merchant screen says **Relay confirmed**. It verifies a signature from the pinned relay, which checks the finalized Arc transaction, exact order terms, and deployed bytecode. Reconciliation checks the saved sale again after the merchant reconnects.

Arc validator proof QR is available only when `ARC_SNAPSHOT_FILE` points to an independently authenticated, height bounded validator set for the payment block. A historical set cannot authorize future blocks. Without a current trusted set, keep the relay label.

The merchant must open the site online once to cache the app. The customer's phone needs internet through payment and receipt creation. A physical two phone offline checkout has not yet been verified.
