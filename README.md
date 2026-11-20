# Blackout Checkout

Blackout Checkout is an Arc Testnet checkout where neither phone needs a connection **during the handoff**. The customer prepays native test USDC into an Arc escrow while online. Later, the merchant and customer exchange signed receive and send intents by QR while both are offline. Each phone uploads its own intent when it reconnects. The matcher waits for the same order ID and exact terms, then submits the two signatures to the contract. The contract transfers the prepaid USDC to the merchant once and records the payment on chain.

A signed QR means **pending**, not paid. The merchant sees **Paid on Arc** only after the settlement transaction succeeds. A buyer can have insufficient escrow at settlement, and an offline device cannot know the latest chain balance. This is a delayed settlement testnet demo, not an offline guarantee of payment. The QR signatures authenticate the terms; they do not provide Apple Pay's NFC or Secure Element protections.

## Run the Arc Testnet app

Use Node 22 or newer. Run `npm ci`, `npm run compile`, and `npm run build`. Set `CHECKOUT_ADDRESS` and a funded `MATCHER_PRIVATE_KEY`, then run `npm start`. Keep the matcher key in a secret manager or an ignored local file. Keep `runtime/matches.json` on persistent storage; the matcher resumes queued intents after a restart. The customer wallet is generated in that browser's IndexedDB. Back up its testnet recovery key before depositing funds.

The deployed escrow contract is [`0x38929cCE8c5914755587d41Bf78B9ccC401AAc4d`](https://explorer.testnet.arc.io/address/0x38929cCE8c5914755587d41Bf78B9ccC401AAc4d). Deployment: [`0x2734ab…7cfda1`](https://explorer.testnet.arc.io/tx/0x2734ab005c2d6aad4f3adb608b47ce39b89834ec8ab23f361f5af9b94b7cfda1). A scripted matcher run deposited 0.02 test USDC and [settled 0.01 test USDC](https://explorer.testnet.arc.io/tx/0xe10e6f3f550d4b8099839464ed7ad7a0c6ed978027d6f3422fb9ad08d78dcb12) to a separate merchant wallet. Both signatures and the contract transfer were verified on Arc Testnet. That run did not use two physical phones.

For phones, serve the app on one trusted HTTPS origin both can open. Each device must open it online once to cache the app. The browser camera needs permission to scan the QR codes. The default public Arc RPC is used by the customer for deposit and withdrawal; `ARC_RPC` can set the matcher's upstream RPC and `PUBLIC_ARC_RPC` can set the browser RPC.

## Demo sequence

1. On the customer phone, get free Arc Testnet USDC from the Circle faucet and deposit some into **Prepay test USDC** while online.
2. Open the app on both phones, then disconnect both. The merchant enters an amount and shows a signed receive QR.
3. The customer scans it, checks the amount and merchant address, signs offline, and shows a send QR. The merchant scans that QR and sees **Matched locally · pending settlement**.
4. Reconnect the merchant phone first. Its receive intent uploads and waits. Reconnect the customer phone later. Its send intent uploads; the matcher submits them to Arc.
5. Both phones show **Paid on Arc** after settlement. The sale links to the Arc transaction. Reusing the same order ID cannot pay twice.

The current browser transport is QR, not NFC. Web NFC has [limited browser availability](https://developer.mozilla.org/en-US/docs/Web/API/Web_NFC_API), so the two phone flow still needs a physical camera and offline cache rehearsal before presenting it as a verified phone demo.

## Checks

Run `npm test`, `forge test`, `npm run compile`, and `npm run build`. The Node checks cover signed intent matching and matcher persistence; the Solidity checks cover payment, withdrawal, replay, tampering, expiry, and insufficient funds.
