// The `ln-message` vectors (kit/src/wallet/vectors.json `sign_in_signatures`,
// specs/WALLET.md §1.2 "sign_in"), made with Sphinx's REAL signer, as
// sphinx-rs's FFI calls it for Peel (`Sphinxrs.signBytes` /
// `Sphinxrs.pubkeyFromSeed`, sphinx-ffi/src/onion.rs `sign_bytes` /
// `pubkey_from_seed`): the keys manager `make_signer(seed, Some(idx), time,
// net)`, its node secret, and `sphinx::sig::sign_message` — a Lightning
// signed message: sha256d("Lightning Signed Message:" ‖ msg), recoverable
// ECDSA on secp256k1, 65 bytes `[31 + recid] ‖ r ‖ s`, hex as `sign_bytes`
// answers it. Deterministic (RFC 6979). The messages are strut visitor
// challenges (auth.ts `visitorChallenge`'s form, under a test secret).
//
// Checked equal, byte for byte, to sphinx-ffi's own `sign_bytes` and
// `pubkey_from_seed` (and `sign_base64`, the same bytes in URL-safe base64)
// by a unit test run inside sphinx-ffi at fc98ae6 on 2026-11-11: the FFI
// crate builds only a staticlib and a cdylib, so nothing outside it can call
// it from Rust.
//
// Regenerate:
//
//	cd scripts/ln-message-fixtures && cargo run -q > signatures.json
//	node -e 'const f=require("fs"),p="../../kit/src/wallet/vectors.json",v=JSON.parse(f.readFileSync(p));v.sign_in_signatures=JSON.parse(f.readFileSync("signatures.json"));f.writeFileSync(p,JSON.stringify(v,null,2)+"\n")'
use serde_json::{json, Value};
use sphinx::{make_signer, sig::sign_message, Network};
use std::str::FromStr;

const SEED: &str = "6b1e6d2f0a9c4e3b8d7f2a1c5e9b3d7f0a4c8e2b6d1f5a9c3e7b0d4f8a2c6e1b";
const NETWORK: &str = "bitcoin";
// The keys manager takes a clock; the node key does not depend on it.
const TIME: &str = "1793800000000";

const SHOP_ROOT: &str = "strut-visitor.eyJob3N0Ijoic2hvcC5leGFtcGxlLmNvbSIsInZpc2l0b3JLZXkiOiJyb290Iiwibm9uY2UiOiI2ZjBjM2E5ZDJiN2U0MWM1OGExZjBlOWQzYzJiN2E2NCIsImV4cCI6MTc5MzgwMDA2MDAwMH0.qYzkz2ZbLMhHogJxEF9YQob8BCwvg99JgWymZCESoHA";
const SHOP_DOMAIN: &str = "strut-visitor.eyJob3N0Ijoic2hvcC5leGFtcGxlLmNvbSIsInZpc2l0b3JLZXkiOiJkb21haW4iLCJub25jZSI6ImE0MWUyZjkwN2MzZDRiOGU5ZjFhMmMzZDRlNWY2MDcxIiwiZXhwIjoxNzkzODAwMDYwMDAwfQ.5Apk-oVrtZ6AdzGDmf8rmsi_BwWBNwHtp8so4IX1qK0";
const LOCAL_ROOT: &str = "strut-visitor.eyJob3N0IjoibG9jYWxob3N0IiwidmlzaXRvcktleSI6InJvb3QiLCJub25jZSI6IjJhM2I0YzVkNmU3ZjgwOTEyYTNiNGM1ZDZlN2Y4MDkxIiwiZXhwIjoxNzkzODAwMDYwMDAwfQ.oBSPrN2kJQGK5eCuIqFRDJ4NBVfhSF_9u3NbybuiGSs";

/// sphinx-ffi's `make_keys_manager(seed, Some(idx), time, network)`.
fn keys(idx: u64, time: &str) -> sphinx::MyKeysManager {
    let seed: [u8; 32] = hex::decode(SEED).unwrap().try_into().unwrap();
    make_signer(&seed, Some(idx as i64), time.parse().unwrap(), Network::from_str(NETWORK).unwrap())
}

/// sphinx-ffi's `pubkey_from_seed`: the node key, compressed, hex.
fn key(idx: u64) -> String {
    hex::encode(keys(idx, TIME).get_node_pubkey().serialize())
}

/// sphinx-ffi's `sign_bytes`: `sign_message` over the node secret, hex.
fn sign(idx: u64, message: &str) -> String {
    let sig = hex::encode(sign_message(message.as_bytes(), &keys(idx, TIME).get_node_secret()).unwrap());
    // The node key does not depend on the clock: the same bytes at another time.
    let again = hex::encode(sign_message(message.as_bytes(), &keys(idx, "1").get_node_secret()).unwrap());
    assert_eq!(sig, again, "a signature that depends on the clock");
    sig
}

fn actor(key: &str) -> String {
    format!("secp:{}", &key[2..])
}

fn signed(name: &str, idx: u64, message: &str) -> Value {
    let k = key(idx);
    json!({
        "name": name,
        "signer": { "seed": SEED, "idx": idx, "network": NETWORK },
        "message": message,
        "key": k,
        "sig": sign(idx, message),
        "actor": actor(&k),
    })
}

fn refused(name: &str, message: &str, key: &str, sig: &str) -> Value {
    json!({ "name": name, "message": message, "key": key, "sig": sig, "actor": null })
}

fn main() {
    let root = key(0);
    let other = key(1);
    let root_sig = sign(0, SHOP_ROOT);
    // The recovery id's byte changed: another key recovers.
    let header = u8::from_str_radix(&root_sig[..2], 16).unwrap();
    let flipped = format!("{:02x}{}", if header == 31 { 32 } else { 31 }, &root_sig[2..]);
    // One character of the message changed (the nonce's first).
    let tampered = SHOP_ROOT.replacen("eyJob3N0", "eyJob3N1", 1);
    assert_ne!(tampered, SHOP_ROOT);
    let out = vec![
        signed("the root key (account 0) signs a challenge", 0, SHOP_ROOT),
        signed("the root key signs a challenge that asks for a key per domain", 0, SHOP_DOMAIN),
        signed("the root key signs a challenge for localhost", 0, LOCAL_ROOT),
        signed("another key (account 1) is another actor", 1, SHOP_ROOT),
        refused("a tampered message", &tampered, &root, &root_sig),
        refused("the signature with another key named", SHOP_ROOT, &other, &root_sig),
        refused("the recovery byte changed", SHOP_ROOT, &root, &flipped),
        refused("r ‖ s without the recovery byte", SHOP_ROOT, &root, &root_sig[2..]),
        refused("a key that is not a compressed point", SHOP_ROOT, &format!("04{}", &root[2..]), &root_sig),
    ];
    println!("{}", serde_json::to_string_pretty(&Value::Array(out)).unwrap());
}
