# Blackout Checkout

A register can accept a settled Arc Testnet USDC payment while disconnected. The buyer needs connectivity until the payment proof is downloaded. Use the plan in [docs/PLAN.md](docs/PLAN.md) for the four phases.

## Run a complete rehearsal

Use Node 22. Run `npm install`, `npm run build`, then `npm run rehearse`. Open http://localhost:4173. This starts a local EVM, deploys the checkout and runs a relay. The banner says **Local rehearsal**. Balances and orders on this chain have no value. Restarting the rehearsal creates a fresh contract and relay key. Use a fresh browser profile or reset site data between sessions.

In Merchant mode enter your vendor wallet address and the amount. Use Customer mode in a second browser profile to fund the generated test wallet with **Fund rehearsal wallet**. Scan the order, pay and wait for the proof. Scan the receipt on the merchant screen. The register stores the completed sale even if it restarts. Under **Sales**, reconnect and choose **Check against Arc** to compare the saved receipt to the chain. A temporary connection failure leaves the sale retryable.

For two iPhones, put the site behind trusted HTTPS, including when it runs on your home network. Both phones need the same origin. The rehearsal RPC is proxied through the site. Only expose rehearsal funding to your own devices. Turn WiFi off on the merchant phone after the app is cached. Confirm the site can quit, reopen, create a new order, and reject a reused receipt without network access.

## Use Arc Testnet

Run `npm run compile`. Use a dedicated faucet funded test wallet and set `ARC_TESTNET_KEY` in your shell. Run `npm run deploy` and save its deployment hash and address. Set `CHECKOUT_ADDRESS` to that address. Run `npm run keygen` once to create a private relay signing key. Keep this file and all signing secrets outside Git. Run `npm run build && npm start`. For a hosted relay, store the private JWK as a secret named `RELAY_PRIVATE_JWK`. Keep the same public key for the life of each open sale. A private upstream RPC URL belongs in `ARC_RPC`; `PUBLIC_ARC_RPC` must be safe for the browser.

The default register explicitly displays **Relay confirmed**. This proves that the pinned relay signed an exact finalized checkout event. It trusts the relay, which checks runtime bytecode, successful execution and canonical block finality. Reconciliation can detect a dishonest relay only with an independently trusted chain reader. Never advertise a relay receipt as independent Arc verification.

Set `ARC_SNAPSHOT_FILE` before onboarding a fresh register to enable Arc proof QR. The file contains chain ID 5042002, inclusive authorized heights `from` and `to`, and `validators` entries with hexadecimal Ed25519 key and decimal voting power. Provision an independently authenticated, height bounded validator set. A customer supplied set is never trusted. A configured range must be backed by actual knowledge of who can sign at those heights. Never extend a range merely for convenience. Orders retain the snapshot selected when issued. If no verified current set is available, use the explicitly labeled relay mode. Clear a register's site data only after closing and exporting outstanding sales; clearing it removes replay history.

## Evidence and checks

Run `npm test`, `npm run build`, and `npm run spike`. For browser checks install Chromium with `npx playwright install chromium` and run `npm run test:browser`. GitHub Actions runs on the stack branches. Public testnet availability is reported separately in the downloadable evidence artifact. A red live probe should be investigated even if deterministic checks pass.

The committed fixture is an observed Arc testnet receipt from block **73090654**, tx `0x321e2376e51675d063c92b89d67f243d376e3afc5a2b1074906e5655fdd53be6`. Its validator set was read from historical RPC for that block. It demonstrates real receipt verification, not a purchase at this checkout. Record a separately funded checkout deployment, a real purchase hash, and the two phone results before making that claim.

Track: Consumer Applications. Chain goal: Best use of Arc. Scope: browser checkout and QR. Save the video, repository link and deployed contract details for submission. The owner handles the event submission.
