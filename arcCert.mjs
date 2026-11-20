// Offline verifier for Arc commit certificates (arc_getCertificate).
// Mirrors arc-node's Vote::to_sign_bytes (SSZ) + Malachite verify_commit_certificate.
import { ed25519 } from '@noble/curves/ed25519';
import { keccak256 } from 'ethers';

export const hexToBytes = (h) => {
  const s = h.startsWith('0x') ? h.slice(2) : h;
  if (s.length % 2) throw new Error('odd hex');
  return Uint8Array.from(s.match(/.{2}/g) ?? [], (b) => parseInt(b, 16));
};
export const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** Validator address = first 20 bytes of keccak256(ed25519 pubkey). */
export const addressFromPubkey = (pk) => hexToBytes(keccak256(pk).slice(2, 42));

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
    if (!ed25519.verify(sig, msg, v.pk, { zip215: false })) return { ok: false, reason: `invalid signature from ${addrHex}` };
    signed += v.power;
  }
  // Malachite TWO_F_PLUS_ONE: signed * 3 > total * 2
  const ok = signed * 3n > total * 2n;
  return { ok, signedPower: signed, totalPower: total, reason: ok ? undefined : 'no 2/3+ quorum' };
}
