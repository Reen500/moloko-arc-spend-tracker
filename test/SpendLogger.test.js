import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { getAddress, zeroAddress, keccak256, toHex } from "viem";

// $0.01 USDC in base units (6 decimals) — the demo price.
const ONE_CENT = 10_000n;
const ZERO32 = `0x${"00".repeat(32)}`;
const POLICY_A = keccak256(toHex('{"maxPerCall":"20000","dailyCap":"1000000"}'));
const POLICY_B = keccak256(toHex('{"maxPerCall":"5000","dailyCap":"1000000"}'));

describe("SpendLogger", () => {
  let viem, publicClient, deployer, agent, service, other, logger;

  before(async () => {
    ({ viem } = await network.create());
    publicClient = await viem.getPublicClient();
    [deployer, agent, service, other] = await viem.getWalletClients();
    logger = await viem.deployContract("SpendLogger");
  });

  // ---------------------------------------------------------------------
  // Ledger (v1 behaviour, unchanged)
  // ---------------------------------------------------------------------
  describe("ledger", () => {
    it("starts empty", async () => {
      assert.equal(await logger.read.purchaseCount(), 0n);
      assert.equal(await logger.read.MAX_MEMO_BYTES(), 256n);
      assert.equal(await logger.read.MAX_SCORE(), 5);
    });

    it("logs a purchase, returns id 0, emits PurchaseLogged (policy 0x0) and updates totals", async () => {
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
        ZERO32,
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
      assert.equal(p.policyHash, ZERO32);
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

  // ---------------------------------------------------------------------
  // Policy attestation
  // ---------------------------------------------------------------------
  describe("policy attestation", () => {
    it("agent has no controller and no policy by default", async () => {
      assert.equal(await logger.read.controllerOf([agent.account.address]), zeroAddress);
      assert.equal(await logger.read.policyOf([agent.account.address]), ZERO32);
    });

    it("nobody can set a policy for an agent with no controller", async () => {
      await viem.assertions.revertWith(
        logger.write.setPolicy([agent.account.address, POLICY_A], { account: deployer.account }),
        "SpendLogger: agent has no controller",
      );
    });

    it("a stranger cannot bind a controller to an agent", async () => {
      await viem.assertions.revertWith(
        logger.write.setController([agent.account.address, other.account.address], { account: other.account }),
        "SpendLogger: only agent can bind first controller",
      );
    });

    it("rejects a zero controller", async () => {
      await viem.assertions.revertWith(
        logger.write.setController([agent.account.address, zeroAddress], { account: agent.account }),
        "SpendLogger: controller is zero",
      );
    });

    it("the agent binds itself to a controller once, emitting ControllerSet", async () => {
      const hash = await logger.write.setController(
        [agent.account.address, deployer.account.address],
        { account: agent.account },
      );
      await viem.assertions.emitWithArgs(hash, logger, "ControllerSet", [
        getAddress(agent.account.address),
        getAddress(deployer.account.address),
        getAddress(agent.account.address),
      ]);
      assert.equal(await logger.read.controllerOf([agent.account.address]), getAddress(deployer.account.address));
    });

    it("once bound, the agent can no longer change its own controller", async () => {
      await viem.assertions.revertWith(
        logger.write.setController([agent.account.address, other.account.address], { account: agent.account }),
        "SpendLogger: only controller can transfer",
      );
    });

    it("a non-controller cannot set the policy", async () => {
      await viem.assertions.revertWith(
        logger.write.setPolicy([agent.account.address, POLICY_A], { account: agent.account }),
        "SpendLogger: only controller can set policy",
      );
      await viem.assertions.revertWith(
        logger.write.setPolicy([agent.account.address, POLICY_A], { account: other.account }),
        "SpendLogger: only controller can set policy",
      );
    });

    it("the controller sets the policy, emitting PolicySet", async () => {
      const hash = await logger.write.setPolicy(
        [agent.account.address, POLICY_A],
        { account: deployer.account },
      );
      await viem.assertions.emitWithArgs(hash, logger, "PolicySet", [
        getAddress(agent.account.address),
        POLICY_A,
        getAddress(deployer.account.address),
      ]);
      assert.equal(await logger.read.policyOf([agent.account.address]), POLICY_A);
    });

    it("purchases logged after setPolicy carry the policy hash; earlier ones do not", async () => {
      const hash = await logger.write.logPurchase(
        [agent.account.address, service.account.address, ONE_CENT, "under policy A"],
        { account: deployer.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });
      const id = (await logger.read.purchaseCount()) - 1n;
      assert.equal((await logger.read.getPurchase([id])).policyHash, POLICY_A);
      assert.equal((await logger.read.getPurchase([0n])).policyHash, ZERO32);

      const receipt = await publicClient.getTransactionReceipt({ hash });
      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      await viem.assertions.emitWithArgs(hash, logger, "PurchaseLogged", [
        id, getAddress(agent.account.address), getAddress(service.account.address), ONE_CENT,
        "under policy A", getAddress(deployer.account.address), block.timestamp, POLICY_A,
      ]);
    });

    it("changing the policy is captured by subsequent purchases only", async () => {
      await logger.write.setPolicy([agent.account.address, POLICY_B], { account: deployer.account });
      const hash = await logger.write.logPurchase(
        [agent.account.address, service.account.address, ONE_CENT, "under policy B"],
        { account: deployer.account },
      );
      await publicClient.waitForTransactionReceipt({ hash });
      const id = (await logger.read.purchaseCount()) - 1n;
      assert.equal((await logger.read.getPurchase([id])).policyHash, POLICY_B);
      assert.equal((await logger.read.getPurchase([id - 1n])).policyHash, POLICY_A);
    });

    it("the controller can transfer control; the old controller then loses setPolicy", async () => {
      await logger.write.setController([agent.account.address, other.account.address], { account: deployer.account });
      assert.equal(await logger.read.controllerOf([agent.account.address]), getAddress(other.account.address));
      await viem.assertions.revertWith(
        logger.write.setPolicy([agent.account.address, POLICY_A], { account: deployer.account }),
        "SpendLogger: only controller can set policy",
      );
      // hand it back so later tests keep using deployer as controller
      await logger.write.setController([agent.account.address, deployer.account.address], { account: other.account });
      assert.equal(await logger.read.controllerOf([agent.account.address]), getAddress(deployer.account.address));
    });

    it("the controller can explicitly clear a policy to 0x0", async () => {
      await logger.write.setPolicy([agent.account.address, ZERO32], { account: deployer.account });
      assert.equal(await logger.read.policyOf([agent.account.address]), ZERO32);
      await logger.write.setPolicy([agent.account.address, POLICY_A], { account: deployer.account });
    });
  });

  // ---------------------------------------------------------------------
  // Outcomes
  // ---------------------------------------------------------------------
  describe("outcomes", () => {
    const REASON = keccak256(toHex("plan had 4 steps, 1 decision point; matched request"));

    it("has no outcome recorded by default", async () => {
      const o = await logger.read.getOutcome([0n]);
      assert.equal(o.recorded, false);
      assert.equal(o.score, 0);
    });

    it("a stranger cannot record an outcome", async () => {
      await viem.assertions.revertWith(
        logger.write.recordOutcome([0n, 5, REASON], { account: other.account }),
        "SpendLogger: only agent or controller can record outcome",
      );
    });

    it("the service that was paid cannot rate its own delivery", async () => {
      await viem.assertions.revertWith(
        logger.write.recordOutcome([0n, 5, REASON], { account: service.account }),
        "SpendLogger: only agent or controller can record outcome",
      );
    });

    it("rejects a score above MAX_SCORE", async () => {
      await viem.assertions.revertWith(
        logger.write.recordOutcome([0n, 6, REASON], { account: agent.account }),
        "SpendLogger: score out of range",
      );
    });

    it("rejects an out-of-range purchase id", async () => {
      const count = await logger.read.purchaseCount();
      await viem.assertions.revertWith(
        logger.write.recordOutcome([count, 3, REASON], { account: agent.account }),
        "SpendLogger: id out of range",
      );
    });

    it("the paying agent records an outcome, emitting OutcomeRecorded", async () => {
      const hash = await logger.write.recordOutcome([0n, 4, REASON], { account: agent.account });
      await viem.assertions.emitWithArgs(hash, logger, "OutcomeRecorded", [
        0n, getAddress(agent.account.address), 4, REASON, getAddress(agent.account.address),
      ]);
      const o = await logger.read.getOutcome([0n]);
      assert.equal(o.recorded, true);
      assert.equal(o.score, 4);
      assert.equal(o.reasonHash, REASON);
      assert.equal(o.recordedBy, getAddress(agent.account.address));
      assert.ok(o.timestamp > 0n);
    });

    it("an outcome is recorded once and cannot be changed", async () => {
      await viem.assertions.revertWith(
        logger.write.recordOutcome([0n, 1, REASON], { account: agent.account }),
        "SpendLogger: outcome already recorded",
      );
    });

    it("the agent's controller can record an outcome on the agent's behalf", async () => {
      const hash = await logger.write.recordOutcome([1n, 2, REASON], { account: deployer.account });
      await viem.assertions.emitWithArgs(hash, logger, "OutcomeRecorded", [
        1n, getAddress(agent.account.address), 2, REASON, getAddress(deployer.account.address),
      ]);
      assert.equal((await logger.read.getOutcome([1n])).recordedBy, getAddress(deployer.account.address));
    });

    it("a score of 0 is a valid (bad) outcome", async () => {
      await logger.write.recordOutcome([2n, 0, REASON], { account: agent.account });
      const o = await logger.read.getOutcome([2n]);
      assert.equal(o.recorded, true);
      assert.equal(o.score, 0);
    });
  });
});
