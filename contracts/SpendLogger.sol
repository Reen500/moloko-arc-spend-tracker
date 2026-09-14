// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SpendLogger (v2)
/// @notice On-chain audit log for autonomous-agent purchases. Money moves via x402
///         (USDC transfer agent -> service); this contract records the fact, the
///         spending policy the agent was operating under, and the buyer's own
///         assessment of what it got.
/// @dev Deliberately permissionless and stateless w.r.t. funds:
///      - anyone can call logPurchase (either side of an x402 trade can attest),
///      - no contract owner, nothing to upgrade, nothing to rug,
///      - the contract never holds USDC. It is a ledger, not a vault.
///
///      v2 adds two things an operations team needs around a ledger:
///      1. Policy attestation. An agent binds itself to a *controller* (the
///         organisation's wallet). Only the controller can set the agent's policy
///         hash — the fingerprint of an off-chain rulebook (caps, allow-lists).
///         Every purchase records the policy hash in force at log time, so an
///         auditor can check each entry against the exact rules that applied.
///         This is attestation, not enforcement: the agent's client refuses to
///         sign out-of-policy payments; the chain records what policy it claimed.
///      2. Outcomes. The paying agent (or its controller) can record, once, a
///         0-5 score and a reason hash against a purchase: did we get what we
///         paid for? This is the buyer's private procurement record, not a
///         public reputation market.
///
///      No tokens, rewards, or staking will be added — Circle asked Arc builders
///      not to ship speculative token features, and this is infrastructure.
contract SpendLogger {
    struct Purchase {
        address agent;       // wallet that paid
        address service;     // wallet that was paid
        uint256 amount;      // USDC base units (6 decimals) — 10000 = $0.01
        uint256 timestamp;   // block.timestamp at log time
        string  memo;        // free text: endpoint, request id, settlement tx, ...
        address reporter;    // msg.sender at log time (who attested)
        bytes32 policyHash;  // policyOf[agent] at log time (0x0 = no policy set)
    }

    struct Outcome {
        uint8   score;       // 0..5, buyer's assessment of value received
        bytes32 reasonHash;  // hash of an off-chain reason / evidence blob
        address recordedBy;  // agent or its controller
        uint256 timestamp;
        bool    recorded;
    }

    /// @dev Memos are stored on-chain and emitted in events; cap them so a
    ///      careless reporter can't burn absurd gas or bloat state.
    uint256 public constant MAX_MEMO_BYTES = 256;
    uint8   public constant MAX_SCORE = 5;

    // ---- ledger -----------------------------------------------------------
    mapping(uint256 => Purchase) public purchases;
    uint256 public purchaseCount;
    mapping(address => uint256) public totalSpentBy;
    mapping(address => uint256) public totalEarnedBy;

    // ---- policy attestation ----------------------------------------------
    mapping(address => address) public controllerOf; // agent -> controller
    mapping(address => bytes32) public policyOf;     // agent -> policy hash

    // ---- outcomes ---------------------------------------------------------
    mapping(uint256 => Outcome) public outcomes;     // purchase id -> outcome

    event PurchaseLogged(
        uint256 indexed id,
        address indexed agent,
        address indexed service,
        uint256 amount,
        string  memo,
        address reporter,
        uint256 timestamp,
        bytes32 policyHash
    );
    event ControllerSet(address indexed agent, address indexed controller, address indexed setBy);
    event PolicySet(address indexed agent, bytes32 indexed policyHash, address indexed controller);
    event OutcomeRecorded(uint256 indexed id, address indexed agent, uint8 score, bytes32 reasonHash, address recordedBy);

    // =======================================================================
    // Ledger
    // =======================================================================

    /// @notice Record that `agent` paid `service` `amount` USDC base units.
    ///         Captures the agent's current policy hash.
    /// @return id Sequential purchase id, starting at 0.
    function logPurchase(
        address agent,
        address service,
        uint256 amount,
        string calldata memo
    ) external returns (uint256 id) {
        require(agent != address(0),   "SpendLogger: agent is zero");
        require(service != address(0), "SpendLogger: service is zero");
        require(amount > 0,            "SpendLogger: amount must be > 0");
        require(bytes(memo).length <= MAX_MEMO_BYTES, "SpendLogger: memo too long");

        bytes32 policy = policyOf[agent];
        id = purchaseCount;
        purchases[id] = Purchase(agent, service, amount, block.timestamp, memo, msg.sender, policy);
        unchecked {
            // Overflow of a uint256 counter or of summed USDC amounts is not
            // reachable in practice (total USDC supply << 2**256).
            purchaseCount = id + 1;
            totalSpentBy[agent]    += amount;
            totalEarnedBy[service] += amount;
        }
        emit PurchaseLogged(id, agent, service, amount, memo, msg.sender, block.timestamp, policy);
    }

    /// @notice Read a purchase as a struct (the auto-generated `purchases(id)`
    ///         getter returns a tuple; this is friendlier for clients).
    function getPurchase(uint256 id) external view returns (Purchase memory) {
        require(id < purchaseCount, "SpendLogger: id out of range");
        return purchases[id];
    }

    // =======================================================================
    // Policy attestation
    // =======================================================================

    /// @notice Bind an agent to a controller. The agent itself may do this once
    ///         (consenting to be governed); afterwards only the current
    ///         controller may transfer control. Cannot be cleared.
    function setController(address agent, address controller) external {
        require(agent != address(0),      "SpendLogger: agent is zero");
        require(controller != address(0), "SpendLogger: controller is zero");
        address current = controllerOf[agent];
        if (current == address(0)) {
            require(msg.sender == agent, "SpendLogger: only agent can bind first controller");
        } else {
            require(msg.sender == current, "SpendLogger: only controller can transfer");
        }
        controllerOf[agent] = controller;
        emit ControllerSet(agent, controller, msg.sender);
    }

    /// @notice Set the policy hash an agent operates under. Controller only.
    ///         Setting 0x0 records "no policy" explicitly.
    function setPolicy(address agent, bytes32 policyHash) external {
        require(controllerOf[agent] != address(0), "SpendLogger: agent has no controller");
        require(msg.sender == controllerOf[agent], "SpendLogger: only controller can set policy");
        policyOf[agent] = policyHash;
        emit PolicySet(agent, policyHash, msg.sender);
    }

    // =======================================================================
    // Outcomes
    // =======================================================================

    /// @notice Record, once, the buyer's assessment of a purchase.
    ///         Callable by the purchase's agent or that agent's controller.
    function recordOutcome(uint256 id, uint8 score, bytes32 reasonHash) external {
        require(id < purchaseCount,       "SpendLogger: id out of range");
        require(score <= MAX_SCORE,       "SpendLogger: score out of range");
        require(!outcomes[id].recorded,   "SpendLogger: outcome already recorded");
        address agent = purchases[id].agent;
        require(
            msg.sender == agent || msg.sender == controllerOf[agent],
            "SpendLogger: only agent or controller can record outcome"
        );
        outcomes[id] = Outcome(score, reasonHash, msg.sender, block.timestamp, true);
        emit OutcomeRecorded(id, agent, score, reasonHash, msg.sender);
    }

    function getOutcome(uint256 id) external view returns (Outcome memory) {
        require(id < purchaseCount, "SpendLogger: id out of range");
        return outcomes[id];
    }
}
