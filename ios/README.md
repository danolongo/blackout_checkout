# Blackout buyer for iPhone

Open `BlackoutBuyer.xcodeproj` in Xcode, choose your iPhone and personal signing team, then Run. The app defaults to `https://blackout-next.64-177-121-208.sslip.io`. Open it online once to cache the contract and validator checkpoint. The matcher runs on a separate Vultr server, so the Mac can go offline during the demo.

The wallet key lives in iOS Keychain; Settings can show or import the recovery key. Use Circle's Arc Testnet faucet to fund this wallet, then use **Add → Deposit to Arc escrow**. Keep a little test USDC in the wallet for gas. The home Balance is prepaid escrow, not the wallet's uncommitted on-chain balance.

Scan a merchant invoice QR while offline, check the signed merchant address and amount, then confirm. The return QR holds both signatures, so either device can upload the payment package when it reconnects. After Arc settles, the online device shows animated proof QR frames. The offline device checks the validator certificate, receipt inclusion, and exact payment event before showing Completed. The scanner uses the physical camera; camera QR timing still needs device testing.

If the home screen shows a balance under **previous escrow**, tap **Move** while online to withdraw and redeposit it into the new contract. Settings also has a withdrawal-only option if the second step needs to be done manually. A new contract cannot move deposits from the old contract automatically. The validator checkpoint is checked against Arc's public RPC before being cached; this demo assumes the set stays unchanged for its 1,800-block window.

`bridge.mjs` is bundled into `BlackoutBuyer/Resources/bridge.js` with the repository's `esbuild`. The bundled ethers bridge verifies the merchant's EIP-712 signature, signs buyer intents, and signs escrow deposits locally. Rebuild with `npm ci && ./node_modules/.bin/esbuild ios/bridge.mjs --bundle --platform=browser --target=safari17 --format=iife --minify --outfile=ios/BlackoutBuyer/Resources/bridge.js` after changing it.
