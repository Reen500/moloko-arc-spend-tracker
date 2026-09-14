import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";

// $0.01 USDC in base units (6 decimals) — the demo price.
const ONE_CENT = 10_000n;

describe("SpendLogger", () => {
  let viem, publicClient, deployer, agent, service, other, logger;

  before(async () => {
    ({ viem } = await network.create());
    publicClient = await viem.getPublicClient();
    [deployer, agent, service, other] = await viem.getWalletClients();
    logger = await viem.deployContract("SpendLogger");
  });

  it("starts empty", async () => {
    assert.equal(await logger.read.purchaseCount(), 0n);
    assert.equal(await logger.read.MAX_MEMO_BYTES(), 256n);
  });

  it("logs a purchase, returns id 0, emits PurchaseLogged and updates totals", async () => {
    const memo = "POST /api/process-description";
    const hash = await logger.write.logPurchase(
      [agent.account.address, service.account.address, ONE_CENT, memo],
      { account: deployer.account },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

    await viem.assertions.emitWithArgs(hash, logger, "PurchaseLogged", [
      0n,
      getAddress(agent.account.address),
      getAddress(service.account.address),
      ONE_CENT,
      memo,
      getAddress(deployer.account.address),
      block.timestamp,
    ]);

    assert.equal(await logger.read.purchaseCount(), 1n);
    assert.equal(await logger.read.totalSpentBy([agent.account.address]), ONE_CENT);
    assert.equal(await logger.read.totalEarnedBy([service.account.address]), ONE_CENT);
    assert.equal(await logger.read.totalSpentBy([service.account.address]), 0n);
  });

  it("reads the purchase back via getPurchase with reporter = msg.sender", async () => {
    const p = await logger.read.getPurchase([0n]);
    assert.equal(p.agent, getAddress(agent.account.address));
    assert.equal(p.service, getAddress(service.account.address));
    assert.equal(p.amount, ONE_CENT);
    assert.equal(p.memo, "POST /api/process-description");
    assert.equal(p.reporter, getAddress(deployer.account.address));
    assert.ok(p.timestamp > 0n);
  });

  it("increments ids and accumulates totals across multiple purchases", async () => {
    await logger.write.logPurchase(
      [agent.account.address, service.account.address, ONE_CENT, "call 2"],
      { account: deployer.account },
    );
    await logger.write.logPurchase(
      [agent.account.address, service.account.address, 3n * ONE_CENT, "call 3"],
      { account: deployer.account },
    );
    assert.equal(await logger.read.purchaseCount(), 3n);
    assert.equal(await logger.read.totalSpentBy([agent.account.address]), 5n * ONE_CENT);
    assert.equal(await logger.read.totalEarnedBy([service.account.address]), 5n * ONE_CENT);
    assert.equal((await logger.read.getPurchase([2n])).amount, 3n * ONE_CENT);
  });

  it("is permissionless: any wallet can report (agent attesting its own spend)", async () => {
    const hash = await logger.write.logPurchase(
      [agent.account.address, service.account.address, ONE_CENT, "self-reported"],
      { account: agent.account },
    );
    await publicClient.waitForTransactionReceipt({ hash });
    const p = await logger.read.getPurchase([3n]);
    assert.equal(p.reporter, getAddress(agent.account.address));
  });

  it("accepts an empty memo and a memo of exactly MAX_MEMO_BYTES", async () => {
    await logger.write.logPurchase(
      [agent.account.address, service.account.address, 1n, ""],
      { account: other.account },
    );
    const max = "x".repeat(256);
    await logger.write.logPurchase(
      [agent.account.address, service.account.address, 1n, max],
      { account: other.account },
    );
    assert.equal((await logger.read.getPurchase([5n])).memo, max);
  });

  it("rejects a zero agent address", async () => {
    await viem.assertions.revertWith(
      logger.write.logPurchase([zeroAddress, service.account.address, ONE_CENT, "x"]),
      "SpendLogger: agent is zero",
    );
  });

  it("rejects a zero service address", async () => {
    await viem.assertions.revertWith(
      logger.write.logPurchase([agent.account.address, zeroAddress, ONE_CENT, "x"]),
      "SpendLogger: service is zero",
    );
  });

  it("rejects a zero amount", async () => {
    await viem.assertions.revertWith(
      logger.write.logPurchase([agent.account.address, service.account.address, 0n, "x"]),
      "SpendLogger: amount must be > 0",
    );
  });

  it("rejects a memo longer than MAX_MEMO_BYTES", async () => {
    await viem.assertions.revertWith(
      logger.write.logPurchase([agent.account.address, service.account.address, 1n, "x".repeat(257)]),
      "SpendLogger: memo too long",
    );
  });

  it("rejects getPurchase for an out-of-range id", async () => {
    const count = await logger.read.purchaseCount();
    await viem.assertions.revertWith(
      logger.read.getPurchase([count]),
      "SpendLogger: id out of range",
    );
  });

  it("holds no funds and has no owner (pure ledger)", async () => {
    assert.equal(await publicClient.getBalance({ address: logger.address }), 0n);
    assert.ok(!logger.abi.some((f) => f.name === "owner" || f.name === "withdraw"));
  });
});
