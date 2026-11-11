/**
 * The BOLT11 reader against BOLT11's own test vectors
 * (lightning/bolts, 11-payment-encoding.md, "Examples").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Bolt11Error, decodeBolt11, encodeBolt11 } from "./bolt11.js";

const COFFEE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";
const DONATION =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
const PICO =
  "lnbc9678785340p1pwmna7lpp5gc3xfm08u9qy06djf8dfflhugl6p7lgza6dsjxq454gxhj9t7a0sd8dgfkx7cmtwd68yetpd5s9xar0wfjn5gpc8qhrsdfq24f5ggrxdaezqsnvda3kkum5wfjkzmfqf3jkgem9wgsyuctwdus9xgrcyqcjcgpzgfskx6eqf9hzqnteypzxz7fzypfhg6trddjhygrcyqezcgpzfysywmm5ypxxjemgw3hxjmn8yptk7untd9hxwg3q2d6xjcmtv4ezq7pqxgsxzmnyyqcjqmt0wfjjq6t5v4khxsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsxqyjw5qcqp2rzjq0gxwkzc8w6323m55m4jyxcjwmy7stt9hwkwe2qxmy8zpsgg7jcuwz87fcqqeuqqqyqqqqlgqqqqn3qq9q9qrsgqrvgkpnmps664wgkp43l22qsgdw4ve24aca4nymnxddlnp8vh9v2sdxlu5ywdxefsfvm0fq3sesf08uf6q9a2ke0hc9j6z6wlxg5z5kqpu2v9wz";
const TESTNET =
  "lntb20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqfpp3x9et2e20v6pu37c5d9vax37wxq72un989qrsgqdj545axuxtnfemtpwkc45hx9d2ft7x04mt8q7y6t0k2dge9e7h8kpy9p34ytyslj3yu569aalz2xdk8xkd7ltxqld94u8h2esmsmacgpghe9k8";
const HASH = "0001020304050607080900010203040506070809000102030405060708090102";

describe("decodeBolt11", () => {
  it("reads BOLT11's examples: amount, payment hash, description, expiry", () => {
    const coffee = decodeBolt11(COFFEE);
    assert.equal(coffee.network, "bc");
    assert.equal(coffee.msat, 250_000_000, "2500u is 250,000 sats");
    assert.equal(coffee.paymentHash, HASH);
    assert.equal(coffee.description, "1 cup coffee");
    assert.equal(coffee.timestamp, 1496314658);
    assert.equal(coffee.expirySecs, 60);
    assert.equal(coffee.expiresAt, 1496314658 + 60);

    const donation = decodeBolt11(DONATION);
    assert.equal(donation.msat, undefined, "no amount");
    assert.equal(donation.description, "Please consider supporting this project");
    assert.equal(donation.expirySecs, 3600, "an hour when it names none");

    const pico = decodeBolt11(PICO);
    assert.equal(pico.msat, 967_878_534);
    assert.equal(pico.paymentHash, "462264ede7e14047e9b249da94fefc47f41f7d02ee9b091815a5506bc8abf75f");
    assert.equal(pico.expirySecs, 604_800);
    assert.match(pico.description!, /^Blockstream Store: 88\.85 USD/);

    const testnet = decodeBolt11(TESTNET);
    assert.equal(testnet.network, "tb");
    assert.equal(testnet.msat, 2_000_000_000);
    assert.equal(testnet.descriptionHash, "3925b6f67e2c340036ed12093dd44e0368df1b6ea26c53dbe4811f58fd5db8c1");
  });

  it("takes upper case, a lightning: prefix and space around it", () => {
    assert.equal(decodeBolt11(`  lightning:${COFFEE.toUpperCase()}\n`).msat, 250_000_000);
  });

  it("refuses what BOLT11 says a reader must", () => {
    const refuses = (s: string, why: RegExp) => assert.throws(() => decodeBolt11(s), (e: unknown) => e instanceof Bolt11Error && why.test((e as Error).message), s.slice(0, 30));
    // Bech32 checksum is invalid.
    refuses(
      "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrnt",
      /checksum/,
    );
    // Mixed case.
    refuses(
      "LNBC2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpquwpc4curk03c9wlrswe78q4eyqc7d8d0xqzpuyk0sg5g70me25alkluzd2x62aysf2pyy8edtjeevuv4p2d5p76r4zkmneet7uvyakky2zr4cusd45tftc9c5fh0nnqpnl2jfll544esqchsrny",
      /case/,
    );
    // No 1.
    refuses("pvjluezpp5qqqsyqcyq5rqwzqfqqq", /bech32/);
    // Invalid multiplier.
    refuses(
      "lnbc2500x1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgqrrzc4cvfue4zp3hggxp47ag7xnrlr8vgcmkjxk3j5jqethnumgkpqp23z9jclu3v0a7e0aruz366e9wqdykw6dxhdzcjjhldxq0w6wgqcnu43j",
      /amount/,
    );
    // Sub-millisatoshi precision.
    refuses(
      "lnbc2500000001p1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpusp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq0lzc236j96a95uv0m3umg28gclm5lqxtqqwk32uuk4k6673k6n5kfvx3d2h8s295fad45fdhmusm8sjudfhlf6dcsxmfvkeywmjdkxcp99202x",
      /fraction/,
    );
    // Missing p field.
    refuses(
      "lnbc25m1pvjluezdq5vdhkven9v5sxyetpdeessp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9q5sqqqqqqqqqqqqqqqqsgqjy08jd52dtj25pefkh0enc54lxtjtr8wnum2msrq2d8uztp9vhhpccq93ljpff0kkjgzkzcp2czlyenjphf6upazjlc8uxw7za0ynusqrfhg8u",
      /no payment hash/,
    );
    // Two distinct p fields.
    refuses(
      "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqpp5lllllllllllllllllllllllllllllllllllllllllllllllllllsdpyv36hqmrfvdshgefqwpshjmt9de6zq6rpwd5qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9g3f93cqturay6zk2fyfcmeflphlzew9wfq0n5nf9hqnlwxthtzqcljcuurljyd2vngkya5hndakf33ghly97qm5nc3umj7jep22nfsq3nr0w8",
      /two payment hashes/,
    );
    refuses("", /no invoice/);
    refuses("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", /not a Lightning invoice/);
  });

  it("reads back what encodeBolt11 writes, through every amount form", () => {
    for (const msat of [1, 150, 1_000, 21_000, 250_000_000, 123_456_789]) {
      const s = encodeBolt11({ msat, paymentHash: HASH, description: "a withdrawal", timestamp: 1_800_000_000, expirySecs: 600 });
      const d = decodeBolt11(s);
      assert.equal(d.msat, msat, s);
      assert.equal(d.paymentHash, HASH);
      assert.equal(d.description, "a withdrawal");
      assert.equal(d.expiresAt, 1_800_000_600);
    }
    assert.equal(decodeBolt11(encodeBolt11({ paymentHash: HASH })).msat, undefined);
  });
});
