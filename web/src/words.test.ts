import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HOST_WORDS, pageLocale } from "./words";
import { signInNote } from "./native-pay";

// The words strut draws around a visitor's app (plans/i18n.md).

describe("the page's locale", () => {
  it("the link's lang= when it is a tag, else the browser's, else English", () => {
    assert.equal(pageLocale("https://s.example/?app=strut/worker&solo=1&lang=es", "en-US"), "es");
    assert.equal(pageLocale("https://s.example/?app=strut/worker&lang=es-MX", "en-US"), "es-MX");
    assert.equal(pageLocale("https://s.example/?app=strut/worker", "es-AR"), "es-AR");
    assert.equal(pageLocale("https://s.example/?lang=not%20a%20tag!", "es-AR"), "es-AR");
    assert.equal(pageLocale("https://s.example/?lang=", "es-AR"), "es-AR");
    assert.equal(pageLocale(undefined, undefined), "en-US");
  });
});

describe("the host's words", () => {
  it("Spanish has every message English has", () => {
    assert.deepEqual(Object.keys(HOST_WORDS.es).sort(), Object.keys(HOST_WORDS.en).sort());
  });

  it("the sign-in sheet's note after a wallet did not sign them in, in either language", () => {
    const declined = { outcome: "refused", declined: true, code: "USER_REJECTED", message: "no" } as const;
    const tap = { outcome: "refused", declined: false, code: "RESTRICTED", message: "a fresh tap" } as const;
    assert.equal(signInNote(declined, "Peel"), "You declined in Peel.", "English by default");
    assert.equal(signInNote(declined, "Peel", HOST_WORDS.es), "Lo rechazaste en Peel.");
    assert.equal(signInNote(tap, undefined, HOST_WORDS.es), "Tu billetera no inició tu sesión (a fresh tap). Toca Iniciar sesión con tu billetera para confirmarlo allí.");
  });
});
