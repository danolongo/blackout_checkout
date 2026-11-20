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
