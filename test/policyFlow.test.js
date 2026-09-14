// End-to-end on the local chain: bind controller -> set policy -> log purchases
// carrying the hash -> record outcomes. Mirrors what scripts/policy.js and the
// agent do on Arc Testnet, minus x402 (covered by the live run).
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { getAddress, keccak256, toHex } from "viem";
import { validatePolicy, policyHash, evaluate } from "../shared/policy.js";

describe("policy flow (local chain)", () => {
  let viem, controller, agent, service, logger, policy, hash;

  before(async () => {
    ({ viem } = await network.create());
    [controller, agent, service] = await viem.getWalletClients();
    logger = await viem.deployContract("SpendLogger");
    // Same shape as policies/arc-agent.json but with local addresses.
    const raw = JSON.parse(readFileSync(new URL("../policies/arc-agent.json", import.meta.url), "utf8"));
    policy = validatePolicy({ ...raw, agent: agent.account.address, controller: controller.account.address, allowedPayees: [service.account.address] });
    hash = policyHash(policy);
  });

  it("agent binds, controller commits the file's hash, chain reads back the same hash", async () => {
    await logger.write.setController([agent.account.address, controller.account.address], { account: agent.account });
    await logger.write.setPolicy([agent.account.address, hash], { account: controller.account });
    assert.equal(await logger.read.policyOf([agent.account.address]), hash);
  });

  it("an in-policy offer is allowed and the logged purchase carries the hash", async () => {
    const offer = { network: policy.network, asset: policy.asset, amount: "10000", payTo: service.account.address };
    assert.equal(evaluate(policy, offer, 0n).ok, true);
    await logger.write.logPurchase([agent.account.address, service.account.address, 10000n, "x402:0xabc"], { account: service.account });
    const p = await logger.read.getPurchase([0n]);
    assert.equal(p.policyHash, hash);
  });

  it("an over-cap offer is refused before anything is signed", async () => {
    const offer = { network: policy.network, asset: policy.asset, amount: "50000", payTo: service.account.address };
    const v = evaluate(policy, offer, 0n);
    assert.equal(v.ok, false);
    assert.equal(v.rule, "maxPerCall");
    assert.equal(await logger.read.purchaseCount(), 1n, "no purchase was logged for the refused offer");
  });

  it("an unknown payee is refused", async () => {
    const offer = { network: policy.network, asset: policy.asset, amount: "10000", payTo: controller.account.address };
    assert.equal(evaluate(policy, offer, 0n).rule, "allowedPayees");
  });

  it("the agent records an outcome on its purchase", async () => {
    const reason = keccak256(toHex("4 steps, matched request"));
    await logger.write.recordOutcome([0n, 5, reason], { account: agent.account });
    const o = await logger.read.getOutcome([0n]);
    assert.equal(o.recorded, true);
    assert.equal(o.score, 5);
    assert.equal(o.recordedBy, getAddress(agent.account.address));
  });

  it("if the controller rotates the policy, the local file no longer matches — the agent must refuse to run", async () => {
    const rotated = policyHash({ ...policy, maxPerCall: "5000" });
    await logger.write.setPolicy([agent.account.address, rotated], { account: controller.account });
    assert.notEqual(await logger.read.policyOf([agent.account.address]), hash);
  });
});
