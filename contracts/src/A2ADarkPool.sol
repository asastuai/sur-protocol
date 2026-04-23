// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPerpVault, IPerpEngine} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - A2A Dark Pool
/// @author SUR Protocol Team
/// @notice Agent-to-Agent OTC trading. Agents negotiate privately and settle atomically.
///
/// @dev The dark pool operates outside the public orderbook:
///
///      1. Agent A posts an INTENT: "Buy 50 BTC between $49,800-$50,200"
///      2. Agent B sees the intent and posts a RESPONSE: "Sell 50 BTC at $50,050"
///      3. Agent A ACCEPTs the response → atomic settlement on-chain
///      4. The trade NEVER appears on the public orderbook → zero market impact
///
///      Why agents need this:
///      - Large orders on the orderbook get front-run
///      - Hidden orders help but still reveal size when filled
///      - A2A allows true bilateral negotiation at agreed prices
///      - Reputation system ensures reliable counterparties
///
///      Settlement:
///      - Uses PerpEngine.openPosition() for both sides atomically
///      - If either side can't fulfill (insufficient margin), the whole tx reverts
///      - No partial fills — all or nothing
///
///      Reputation:
///      - Each agent builds an on-chain reputation score
///      - Score = completedTrades / (completedTrades + expiredIntents + cancelledResponses)
///      - Higher reputation → access to larger trade sizes and better counterparties
///      - Minimum reputation required to post intents above certain size thresholds

contract A2ADarkPool {
    // ============================================================
    //                    ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error IntentNotFound(uint256 intentId);
    error IntentExpired(uint256 intentId);
    error IntentNotOpen(uint256 intentId);
    error ResponseNotFound(uint256 responseId);
    error NotIntentCreator(uint256 intentId);
    error NotResponseCreator(uint256 responseId);
    error PriceOutOfRange(uint256 price, uint256 minPrice, uint256 maxPrice);
    error SizeMismatch(uint256 offered, uint256 requested);
    error SelfTrade();
    error InsufficientReputation(uint256 current, uint256 required);
    error CooldownActive(uint256 availableAt);

    // ============================================================
    //                    EVENTS
    // ============================================================

    event IntentPosted(uint256 indexed intentId, address indexed agent, bytes32 marketId, bool isBuy, uint256 size, uint256 minPrice, uint256 maxPrice, uint256 expiresAt);
    event IntentCancelled(uint256 indexed intentId);
    event ResponsePosted(uint256 indexed responseId, uint256 indexed intentId, address indexed responder, uint256 price);
    event ResponseCancelled(uint256 indexed responseId);
    event A2ATradeSettled(uint256 indexed intentId, uint256 indexed responseId, address buyer, address seller, bytes32 marketId, uint256 size, uint256 price, uint256 timestamp);
    event ReputationUpdated(address indexed agent, uint256 newScore, uint256 completedTrades);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OperatorUpdated(address indexed operator, bool status);
    event FeeBpsUpdated(uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed newRecipient);
    event LargeTradeThresholdUpdated(uint256 newThreshold);
    event LargeTradeMinReputationUpdated(uint256 newMinReputation);
    event PauseStatusChanged(bool isPaused);

    /// @notice Emitted whenever a position-economics parameter changes prospectively.
    /// @dev See docs/MAPPING_3_prospective_params.md for the convention and
    ///      docs/MAPPING_4_freshness_event_schema.md for the cross-contract schema.
    /// @param paramId        keccak256 of the canonical parameter name
    ///                       (e.g. keccak256("A2ADarkPool.feeBps")).
    /// @param oldValue       Previous value ABI-encoded.
    /// @param newValue       New value ABI-encoded.
    /// @param effectiveBlock Block at which the new value begins applying to
    ///                       new positions. Equal to block.number for direct
    ///                       onlyOwner setters; increased by timelock.delay()
    ///                       when gated through SurTimelock.
    /// @param admin          Address that triggered the update.
    event ParameterBump(
        bytes32 indexed paramId,
        bytes oldValue,
        bytes newValue,
        uint256 effectiveBlock,
        address indexed admin
    );

    // ============================================================
    //                    STRUCTS
    // ============================================================

    enum IntentStatus { Open, Filled, Cancelled, Expired }
    enum ResponseStatus { Pending, Accepted, Cancelled, Expired }

    struct Intent {
        uint256 id;
        address agent;              // creator
        bytes32 marketId;           // which market (BTC-USD, etc.)
        bool isBuy;                 // true = wants to buy, false = wants to sell
        uint256 size;               // in SIZE_PRECISION (8 decimals)
        uint256 minPrice;           // minimum acceptable price (6 decimals)
        uint256 maxPrice;           // maximum acceptable price (6 decimals)
        uint256 createdAt;
        uint256 expiresAt;          // unix timestamp
        IntentStatus status;
        uint256 filledResponseId;   // which response filled this intent
        /// @notice Fee in bps snapshotted at intent post time.
        /// @dev Prospective-only: settlement uses this value, NOT the current
        ///      contract-level feeBps. Admin bumps to feeBps do not retroactively
        ///      alter fees on intents already posted. See docs/MAPPING_3_prospective_params.md.
        uint256 feeBpsAtPost;
    }

    struct Response {
        uint256 id;
        uint256 intentId;           // which intent this responds to
        address agent;              // responder
        uint256 price;              // proposed execution price (6 decimals)
        uint256 createdAt;
        uint256 expiresAt;
        ResponseStatus status;
    }

    struct AgentReputation {
        uint256 completedTrades;    // successful A2A settlements
        uint256 totalVolume;        // total USDC volume traded (6 decimals)
        uint256 expiredIntents;     // intents that expired without fill
        uint256 cancelledResponses; // responses cancelled after posting
        uint256 firstTradeAt;       // timestamp of first trade
        uint256 lastTradeAt;        // timestamp of most recent trade
    }

    // ============================================================
    //                    STATE
    // ============================================================

    address public owner;
    address public pendingOwner;
    bool public paused;
    IPerpVault public vault;
    IPerpEngine public engine;

    uint256 public constant PRICE_PRECISION = 1e6;
    uint256 public constant SIZE_PRECISION = 1e8;
    uint256 public constant BPS = 10_000;
    uint256 public constant REPUTATION_PRECISION = 1000; // 1000 = 100%

    // Intents
    uint256 public nextIntentId = 1;
    mapping(uint256 => Intent) public intents;
    uint256[] public activeIntentIds;

    // Responses
    uint256 public nextResponseId = 1;
    mapping(uint256 => Response) public responses;
    mapping(uint256 => uint256[]) public intentResponses; // intentId → responseIds

    // Reputation
    mapping(address => AgentReputation) public reputations;

    // Config
    uint256 public minIntentDuration = 60;      // min 1 minute
    uint256 public maxIntentDuration = 86400;    // max 24 hours
    uint256 public responseCooldown = 5;         // 5 seconds between responses
    mapping(address => uint256) public lastResponseTime;

    // Size thresholds requiring reputation
    uint256 public largeTradeThreshold = 10_000 * PRICE_PRECISION; // $10K notional
    uint256 public largeTradeMinReputation = 500; // 50% reputation required

    uint256 public feeBps = 3; // 0.03% per side (lower than orderbook)
    address public feeRecipient;

    mapping(address => bool) public operators;

    // ============================================================
    //                    MODIFIERS
    // ============================================================

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (!operators[msg.sender]) revert NotOperator(); _; }
    modifier whenNotPaused() { if (paused) revert Paused(); _; }

    /// @notice H-10 fix: Reentrancy guard (G-19: transient storage for gas efficiency)
    modifier nonReentrant() {
        assembly {
            if tload(0) { revert(0, 0) }
            tstore(0, 1)
        }
        _;
        assembly { tstore(0, 0) }
    }

    // ============================================================
    //                    CONSTRUCTOR
    // ============================================================

    constructor(
        address _vault,
        address _engine,
        address _feeRecipient,
        address _owner
    ) {
        if (_vault == address(0) || _engine == address(0) || _feeRecipient == address(0) || _owner == address(0)) revert ZeroAddress();
        vault = IPerpVault(_vault);
        engine = IPerpEngine(_engine);
        feeRecipient = _feeRecipient;
        owner = _owner;
    }

    // ============================================================
    //                    POST INTENT
    // ============================================================

    /// @notice Post an intent to buy or sell in the dark pool
    /// @param marketId The market to trade (e.g., keccak256("BTC-USD"))
    /// @param isBuy True if agent wants to BUY, false if SELL
    /// @param size Position size in SIZE_PRECISION (8 decimals)
    /// @param minPrice Minimum acceptable price (6 decimals)
    /// @param maxPrice Maximum acceptable price (6 decimals)
    /// @param duration How long the intent is valid (seconds)
    /// @return intentId The unique intent identifier
    function postIntent(
        bytes32 marketId,
        bool isBuy,
        uint256 size,
        uint256 minPrice,
        uint256 maxPrice,
        uint256 duration
    ) external whenNotPaused returns (uint256 intentId) {
        if (size == 0) revert ZeroAmount();
        require(minPrice <= maxPrice, "min > max price");
        require(duration >= minIntentDuration && duration <= maxIntentDuration, "Invalid duration");

        // Check reputation for large trades
        uint256 notional = (maxPrice * size) / SIZE_PRECISION;
        if (notional > largeTradeThreshold) {
            uint256 rep = getReputationScore(msg.sender);
            if (rep < largeTradeMinReputation) {
                revert InsufficientReputation(rep, largeTradeMinReputation);
            }
        }

        intentId = nextIntentId++;
        intents[intentId] = Intent({
            id: intentId,
            agent: msg.sender,
            marketId: marketId,
            isBuy: isBuy,
            size: size,
            minPrice: minPrice,
            maxPrice: maxPrice,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + duration,
            status: IntentStatus.Open,
            filledResponseId: 0,
            feeBpsAtPost: feeBps
        });

        activeIntentIds.push(intentId);
        emit IntentPosted(intentId, msg.sender, marketId, isBuy, size, minPrice, maxPrice, block.timestamp + duration);
    }

    /// @notice Cancel an open intent
    function cancelIntent(uint256 intentId) external {
        Intent storage intent = intents[intentId];
        if (intent.id == 0) revert IntentNotFound(intentId);
        if (intent.agent != msg.sender) revert NotIntentCreator(intentId);
        if (intent.status != IntentStatus.Open) revert IntentNotOpen(intentId);

        intent.status = IntentStatus.Cancelled;

        // Penalize reputation slightly for cancellation
        reputations[msg.sender].expiredIntents++;

        emit IntentCancelled(intentId);
    }

    // ============================================================
    //                    RESPOND TO INTENT
    // ============================================================

    /// @notice Respond to an intent with a proposed price
    /// @param intentId The intent to respond to
    /// @param price Proposed execution price (must be within intent's range)
    /// @param duration How long the response is valid (seconds)
    /// @return responseId The unique response identifier
    function postResponse(
        uint256 intentId,
        uint256 price,
        uint256 duration
    ) external whenNotPaused returns (uint256 responseId) {
        Intent storage intent = intents[intentId];
        if (intent.id == 0) revert IntentNotFound(intentId);
        if (intent.status != IntentStatus.Open) revert IntentNotOpen(intentId);
        if (block.timestamp > intent.expiresAt) revert IntentExpired(intentId);
        if (intent.agent == msg.sender) revert SelfTrade();

        // Price must be within intent's range
        if (price < intent.minPrice || price > intent.maxPrice) {
            revert PriceOutOfRange(price, intent.minPrice, intent.maxPrice);
        }

        // Cooldown to prevent spam
        if (block.timestamp < lastResponseTime[msg.sender] + responseCooldown) {
            revert CooldownActive(lastResponseTime[msg.sender] + responseCooldown);
        }
        lastResponseTime[msg.sender] = block.timestamp;

        responseId = nextResponseId++;
        responses[responseId] = Response({
            id: responseId,
            intentId: intentId,
            agent: msg.sender,
            price: price,
            createdAt: block.timestamp,
            expiresAt: block.timestamp + duration,
            status: ResponseStatus.Pending
        });

        intentResponses[intentId].push(responseId);
        emit ResponsePosted(responseId, intentId, msg.sender, price);
    }

    /// @notice Cancel a pending response
    function cancelResponse(uint256 responseId) external {
        Response storage resp = responses[responseId];
        if (resp.id == 0) revert ResponseNotFound(responseId);
        if (resp.agent != msg.sender) revert NotResponseCreator(responseId);
        require(resp.status == ResponseStatus.Pending, "Response not pending");

        resp.status = ResponseStatus.Cancelled;
        reputations[msg.sender].cancelledResponses++;

        emit ResponseCancelled(responseId);
    }

    // ============================================================
    //                    ACCEPT + SETTLE
    // ============================================================

    /// @notice Intent creator accepts a response → atomic settlement
    /// @dev Opens positions for BOTH agents via PerpEngine in a single tx.
    ///      If either side can't fulfill (insufficient margin), entire tx reverts.
    /// @dev H-10 fix: nonReentrant guard. H-11 fix: fees collected AFTER positions opened.
    function acceptAndSettle(uint256 intentId, uint256 responseId)
        external whenNotPaused nonReentrant
    {
        Intent storage intent = intents[intentId];
        if (intent.id == 0) revert IntentNotFound(intentId);
        if (intent.agent != msg.sender) revert NotIntentCreator(intentId);
        if (intent.status != IntentStatus.Open) revert IntentNotOpen(intentId);
        if (block.timestamp > intent.expiresAt) revert IntentExpired(intentId);

        Response storage resp = responses[responseId];
        if (resp.id == 0) revert ResponseNotFound(responseId);
        require(resp.intentId == intentId, "Response not for this intent");
        require(resp.status == ResponseStatus.Pending, "Response not pending");
        require(block.timestamp <= resp.expiresAt, "Response expired");

        address buyer = intent.isBuy ? intent.agent : resp.agent;
        address seller = intent.isBuy ? resp.agent : intent.agent;
        uint256 price = resp.price;
        uint256 size = intent.size;

        // Update statuses BEFORE external calls (CEI pattern)
        intent.status = IntentStatus.Filled;
        intent.filledResponseId = responseId;
        resp.status = ResponseStatus.Accepted;

        // Open positions atomically via PerpEngine
        engine.openPosition(intent.marketId, buyer, int256(size), price);
        engine.openPosition(intent.marketId, seller, -int256(size), price);

        // H-11 fix: Collect fees AFTER position opening confirmed.
        // Prospective-only (Mapping 3): settlement uses intent.feeBpsAtPost, not
        // the current feeBps. An admin bump of feeBps between postIntent and
        // acceptAndSettle does not retroactively alter the fee on this trade.
        uint256 notional = (price * size) / SIZE_PRECISION;
        uint256 feePerSide = (notional * intent.feeBpsAtPost) / BPS;
        if (feePerSide > 0) {
            vault.internalTransfer(buyer, feeRecipient, feePerSide);
            vault.internalTransfer(seller, feeRecipient, feePerSide);
        }

        // Update reputation for both agents
        _updateReputation(intent.agent, notional, true);
        _updateReputation(resp.agent, notional, true);

        emit A2ATradeSettled(intentId, responseId, buyer, seller, intent.marketId, size, price, block.timestamp);
    }

    // ============================================================
    //                    REPUTATION
    // ============================================================

    /// @notice Get reputation score (0-1000, where 1000 = perfect)
    function getReputationScore(address agent) public view returns (uint256) {
        AgentReputation storage rep = reputations[agent];
        uint256 total = rep.completedTrades + rep.expiredIntents + rep.cancelledResponses;
        if (total == 0) return 500; // default for new agents
        return (rep.completedTrades * REPUTATION_PRECISION) / total;
    }

    function _updateReputation(address agent, uint256 volumeUsdc, bool completed) internal {
        AgentReputation storage rep = reputations[agent];
        if (completed) {
            rep.completedTrades++;
            rep.totalVolume += volumeUsdc;
        }
        if (rep.firstTradeAt == 0) rep.firstTradeAt = block.timestamp;
        rep.lastTradeAt = block.timestamp;

        emit ReputationUpdated(agent, getReputationScore(agent), rep.completedTrades);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /// @notice Get all open intents for a market
    function getOpenIntents(bytes32 marketId) external view returns (uint256[] memory) {
        uint256 count = 0;
        for (uint256 i = 0; i < activeIntentIds.length; i++) {
            Intent storage intent = intents[activeIntentIds[i]];
            if (intent.status == IntentStatus.Open &&
                intent.marketId == marketId &&
                block.timestamp <= intent.expiresAt) {
                count++;
            }
        }

        uint256[] memory result = new uint256[](count);
        uint256 idx = 0;
        for (uint256 i = 0; i < activeIntentIds.length; i++) {
            Intent storage intent = intents[activeIntentIds[i]];
            if (intent.status == IntentStatus.Open &&
                intent.marketId == marketId &&
                block.timestamp <= intent.expiresAt) {
                result[idx++] = activeIntentIds[i];
            }
        }
        return result;
    }

    /// @notice Get all responses to an intent
    function getResponses(uint256 intentId) external view returns (uint256[] memory) {
        return intentResponses[intentId];
    }

    /// @notice Get agent's full reputation profile
    function getAgentProfile(address agent) external view returns (
        uint256 score,
        uint256 completedTrades,
        uint256 totalVolume,
        uint256 expiredIntents,
        uint256 cancelledResponses,
        uint256 firstTradeAt,
        uint256 lastTradeAt
    ) {
        AgentReputation storage rep = reputations[agent];
        score = getReputationScore(agent);
        completedTrades = rep.completedTrades;
        totalVolume = rep.totalVolume;
        expiredIntents = rep.expiredIntents;
        cancelledResponses = rep.cancelledResponses;
        firstTradeAt = rep.firstTradeAt;
        lastTradeAt = rep.lastTradeAt;
    }

    /// @notice Total number of intents ever posted
    function totalIntents() external view returns (uint256) {
        return nextIntentId - 1;
    }

    // ============================================================
    //                    ADMIN
    // ============================================================

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address old = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
        emit OperatorUpdated(op, status);
    }

    /// @notice Update the per-side fee in bps. Prospective-only (Mapping 3):
    ///         intents already posted continue to settle at their snapshotted
    ///         feeBpsAtPost; only new intents use `newFee`.
    function setFeeBps(uint256 newFee) external onlyOwner {
        require(newFee <= 50, "Max 0.5%");
        uint256 old = feeBps;
        feeBps = newFee;
        emit FeeBpsUpdated(newFee);
        emit ParameterBump(
            keccak256("A2ADarkPool.feeBps"),
            abi.encode(old),
            abi.encode(newFee),
            block.number,
            msg.sender
        );
    }

    function setFeeRecipient(address newRecip) external onlyOwner {
        if (newRecip == address(0)) revert ZeroAddress();
        feeRecipient = newRecip;
        emit FeeRecipientUpdated(newRecip);
    }

    /// @notice Update the notional threshold above which reputation is required.
    /// @dev Prospective-by-construction: read only at postIntent, so intents
    ///      already posted are unaffected by bumps here. Emits ParameterBump
    ///      for schema consistency with other prospective-only parameters.
    function setLargeTradeThreshold(uint256 threshold) external onlyOwner {
        uint256 old = largeTradeThreshold;
        largeTradeThreshold = threshold;
        emit LargeTradeThresholdUpdated(threshold);
        emit ParameterBump(
            keccak256("A2ADarkPool.largeTradeThreshold"),
            abi.encode(old),
            abi.encode(threshold),
            block.number,
            msg.sender
        );
    }

    /// @notice Update the minimum reputation required for large trades.
    /// @dev Prospective-by-construction: read only at postIntent. Emits
    ///      ParameterBump for schema consistency.
    function setLargeTradeMinReputation(uint256 minRep) external onlyOwner {
        uint256 old = largeTradeMinReputation;
        largeTradeMinReputation = minRep;
        emit LargeTradeMinReputationUpdated(minRep);
        emit ParameterBump(
            keccak256("A2ADarkPool.largeTradeMinReputation"),
            abi.encode(old),
            abi.encode(minRep),
            block.number,
            msg.sender
        );
    }

    function pause() external onlyOwner {
        paused = true;
        emit PauseStatusChanged(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PauseStatusChanged(false);
    }
}
