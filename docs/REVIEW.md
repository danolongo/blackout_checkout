# Blackout Checkout review

## What passed

[Cloud test run](https://github.com/lakshkumar06/blackout_checkout/actions/runs/44635236714) on commit `6e9c3d75f3c64edddbf751fcf83e672bcd14c362`.

Four automated tests passed. In Chromium, a customer paid on the rehearsal chain. The merchant browser restarted offline, scanned the receipt from a simulated camera, accepted it once, refused the second scan and reconciled the sale after reconnecting. This run exercised the relay receipt mode.

A separate live Arc probe verified a receipt in block 73093712. The proof measured 7779 bytes before QR encoding. The validator set for that block came from historical RPC. The transaction was observed on the network. It was separate from the rehearsal sale. [Arc transaction](https://explorer.testnet.arc.io/tx/0x7a2950b930fbe5e6e3b3338138ec19a254130475afc0f3efec4c17c31c735f87)

## What to verify before the demo

1. Record the deployed checkout address and a finalized purchase hash on Arc Testnet. Compare the vendor, order ID and amount to the order created by the merchant.
2. Record which proof the register accepted. A relay receipt authenticates the relay. An Arc validator proof needs a trusted validator set for the payment height.
3. Open the same HTTPS origin on two iPhones. Prepare the merchant online once. Disable WiFi and cellular on the merchant, reopen the app and create a fresh order. Keep the customer online to pay.
4. Scan the receipt on the merchant phone. Confirm the amount, try the same receipt again, then reconnect and confirm the sale in the register.

The chain purchase and physical device checks are open until their evidence is recorded here.

[Instructions to run the app](../README.md) · [Four phase plan](PLAN.md)
