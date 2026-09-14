import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalize, policyHash, validatePolicy, evaluate } from "../shared/policy.js";

const raw = JSON.parse(readFileSync(new URL("../policies/arc-agent.json", import.meta.url), "utf8"));
const policy = validatePolicy(raw);
const offer = { network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000", amount: "10000", payTo: "0x52DF4736C94BA91cf7d49b84b642089F85A47C77" };

describe("spend policy", () => {
  it("canonical form is key-order independent", () => {
    assert.equal(canonicalize({ b: 1, a: [ { d: 2, c: 3 } ] }), canonicalize({ a: [ { c: 3, d: 2 } ], b: 1 }));
    assert.equal(policyHash({ b: 1, a: 2 }), policyHash({ a: 2, b: 1 }));
  });

  it("hash is stable for the committed demo policy", () => {
    const h = policyHash(policy);
    assert.match(h, /^0x[0-9a-f]{64}$/);
    assert.equal(h, policyHash(validatePolicy(JSON.parse(JSON.stringify(raw)))));
  });

  it("rejects a malformed policy", () => {
    assert.throws(() => validatePolicy({ ...raw, maxPerCall: "$0.02" }), /maxPerCall/);
    assert.throws(() => validatePolicy({ ...raw, allowedPayees: ["nope"] }), /allowedPayees/);
    assert.throws(() => validatePolicy({ ...raw, version: "2" }), /version/);
  });

  it("allows an in-policy offer", () => {
    assert.deepEqual(evaluate(policy, offer, 0n), { ok: true });
  });

  it("refuses over maxPerCall", () => {
    const r = evaluate(policy, { ...offer, amount: "50000" }, 0n);
    assert.equal(r.ok, false); assert.equal(r.rule, "maxPerCall");
  });

  it("refuses when the daily cap would be exceeded", () => {
    const r = evaluate(policy, offer, 995000n);
    assert.equal(r.ok, false); assert.equal(r.rule, "dailyCap");
    assert.equal(evaluate(policy, offer, 990000n).ok, true);
  });

  it("refuses an unknown payee, wrong asset, wrong network", () => {
    assert.equal(evaluate(policy, { ...offer, payTo: "0x000000000000000000000000000000000000dEaD" }, 0n).rule, "allowedPayees");
    assert.equal(evaluate(policy, { ...offer, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }, 0n).rule, "asset");
    assert.equal(evaluate(policy, { ...offer, network: "eip155:84532" }, 0n).rule, "network");
  });

  it("empty allow-list means any payee", () => {
    assert.equal(evaluate({ ...policy, allowedPayees: [] }, { ...offer, payTo: "0x000000000000000000000000000000000000dEaD" }, 0n).ok, true);
  });
});
