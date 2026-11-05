import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { takeTicket } from "./ticket";

describe("takeTicket", () => {
  it("takes the ticket and keeps every other param as written", () => {
    const href = "https://strut.acme.com/lab/?app=strut%2Fassistant&ticket=strut-ticket.abc.def&solo=1&wf=job&run=17&embed_origin=https%3A%2F%2Facme.com&input=session%3Devan-1%2Fa+b#top";
    assert.deepEqual(takeTicket(href), {
      ticket: "strut-ticket.abc.def",
      url: "/lab/?app=strut%2Fassistant&solo=1&wf=job&run=17&embed_origin=https%3A%2F%2Facme.com&input=session%3Devan-1%2Fa+b#top",
    });
  });

  it("leaves no `?` when the ticket was the only param", () => {
    assert.deepEqual(takeTicket("http://localhost:3000/?ticket=t"), { ticket: "t", url: "/" });
  });

  it("an empty ticket is still one, to trade and be refused", () => {
    assert.deepEqual(takeTicket("http://localhost:3000/?ticket=&wf=a"), { ticket: "", url: "/?wf=a" });
  });

  it("drops every copy, and an encoded name", () => {
    assert.deepEqual(takeTicket("http://h/?%74icket=x&ticket=y&wf=a"), { ticket: "x", url: "/?wf=a" });
  });

  it("null without one", () => {
    assert.equal(takeTicket("http://h/?wf=a&tickets=b"), null);
  });
});
