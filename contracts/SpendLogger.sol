// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title SpendLogger
/// @notice On-chain audit log for autonomous-agent purchases. Money moves via x402
///         (USDC transfer agent -> service); this contract records the fact.
/// @dev Deliberately permissionless and stateless w.r.t. funds:
///      - anyone can call logPurchase (either side of an x402 trade can attest),
///      - no owner / admin, nothing to upgrade, nothing to rug,
///      - the contract never holds USDC. It is a ledger, not a vault.
///      No tokens, rewards, or staking will be added — Circle asked Arc builders
///      not to ship speculative token features, and this is infrastructure.
contract SpendLogger {
    struct Purchase {
        address agent;      // wallet that paid
        address service;    // wallet that was paid
        uint256 amount;     // USDC base units (6 decimals) — 10000 = $0.01
        uint256 timestamp;  // block.timestamp at log time
        string  memo;       // free text: endpoint, request id, settlement tx, ...
        address reporter;   // msg.sender at log time (who attested)
    }

    /// @dev Memos are stored on-chain and emitted in events; cap them so a
    ///      careless reporter can't burn absurd gas or bloat state.
    uint256 public constant MAX_MEMO_BYTES = 256;

    mapping(uint256 => Purchase) public purchases;
    uint256 public purchaseCount;
    mapping(address => uint256) public totalSpentBy;
    mapping(address => uint256) public totalEarnedBy;

    event PurchaseLogged(
        uint256 indexed id,
        address indexed agent,
        address indexed service,
        uint256 amount,
        string  memo,
        address reporter,
        uint256 timestamp
    );

    /// @notice Record that `agent` paid `service` `amount` USDC base units.
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

        id = purchaseCount;
        purchases[id] = Purchase(agent, service, amount, block.timestamp, memo, msg.sender);
        unchecked {
            // Overflow of a uint256 counter or of summed USDC amounts is not
            // reachable in practice (total USDC supply << 2**256).
            purchaseCount = id + 1;
            totalSpentBy[agent]    += amount;
            totalEarnedBy[service] += amount;
        }
        emit PurchaseLogged(id, agent, service, amount, memo, msg.sender, block.timestamp);
    }

    /// @notice Read a purchase as a struct (the auto-generated `purchases(id)`
    ///         getter returns a tuple; this is friendlier for clients).
    function getPurchase(uint256 id) external view returns (Purchase memory) {
        require(id < purchaseCount, "SpendLogger: id out of range");
        return purchases[id];
    }
}
