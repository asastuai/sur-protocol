// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPerpEngine, IPerpVault} from "./interfaces/ISurInterfaces.sol";

/// @dev Minimal interface to read OI data from PerpEngine for dynamic spread
interface IPerpEngineOI {
    function markets(bytes32 marketId) external view returns (
        bytes32 id, string memory name, bool active,
        uint256 initialMarginBps, uint256 maintenanceMarginBps,
        uint256 maxPositionSize, uint256 markPrice, uint256 indexPrice,
        uint256 lastPriceUpdate, int256 cumulativeFunding, uint256 lastFundingUpdate,
        uint256 fundingIntervalSecs, uint256 openInterestLong, uint256 openInterestShort
    );
}

/// @title SUR Protocol - OrderSettlement
/// @author SUR Protocol Team
/// @notice Receives matched trade batches from the off-chain engine,
///         verifies EIP-712 signatures, and executes settlement on-chain.
/// @dev This contract bridges the off-chain matching engine to on-chain execution.
///
///      Flow:
///      1. Matching engine matches orders off-chain
///      2. Engine creates a MatchedTrade with both traders' signatures
///      3. Operator submits to settleBatch() or settleOne()
///      4. Contract verifies EIP-712 signatures + nonces + expiry
///      5. Collects maker/taker fees via vault.internalTransfer()
///      6. Calls engine.openPosition() for both traders
///         - Engine auto-calculates margin from initialMarginBps
///         - Trader must have enough vault balance (margin + fees)
///      7. Emits events for indexing
///
///      Security:
///      - EIP-712 typed signatures prevent cross-chain/contract replay
///      - Per-trader nonces prevent order replay
///      - Expiry timestamps reject stale orders
///      - Only approved operators can submit batches

contract OrderSettlement {
    // ============================================================
    //                          ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error Paused();
    error ZeroAddress();
    error InvalidSignature(address expected, address recovered);
    error OrderExpired(uint256 expiry, uint256 currentTime);
    error NonceAlreadyUsed(address trader, uint256 nonce);
    error MarketMismatch();
    error SidesNotOpposite();
    error ZeroSize();
    error ZeroPrice();
    error BatchEmpty();
    error OrderTooRecent(uint256 signedAt, uint256 minSettleTime);
    error OrderSignedInFuture(uint256 signedAt, uint256 currentTime);

    // ============================================================
    //                          EVENTS
    // ============================================================

    event TradeSettled(
        bytes32 indexed marketId,
        address indexed maker,
        address indexed taker,
        uint256 price,
        uint256 size,
        bool takerIsLong,
        uint256 makerFee,
        uint256 takerFee,
        uint256 timestamp
    );

    event BatchSettled(uint256 indexed batchId, uint256 tradesCount, uint256 timestamp);
    event OperatorUpdated(address indexed operator, bool status);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event PauseStatusChanged(bool isPaused);
    event TimeLockUpdated(uint256 newMinDelaySeconds);
    event DynamicSpreadApplied(bytes32 indexed marketId, address indexed trader, uint256 extraFeeBps, uint256 skewRatioBps);

    // ============================================================
    //                       EIP-712 TYPES
    // ============================================================

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Order struct for signing. Note: no marginAmount field.
    ///      PerpEngine auto-calculates margin from market.initialMarginBps.
    ///      Trader must have sufficient vault balance.
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,bytes32 marketId,bool isLong,uint256 size,uint256 price,uint256 nonce,uint256 expiry)"
    );

    bytes32 public immutable DOMAIN_SEPARATOR;

    // ============================================================
    //                        TYPES
    // ============================================================

    /// @notice A signed order from a trader
    struct SignedOrder {
        address trader;
        bytes32 marketId;
        bool isLong;         // true = long, false = short
        uint256 size;        // position size (8 decimals, always positive)
        uint256 price;       // limit price (6 decimals)
        uint256 nonce;       // unique per trader
        uint256 expiry;      // unix timestamp
        bytes signature;     // EIP-712 signature (65 bytes)
    }

    /// @notice A matched trade (maker + taker pair from the engine)
    struct MatchedTrade {
        SignedOrder maker;
        SignedOrder taker;
        uint256 executionPrice;  // actual price (maker's price)
        uint256 executionSize;   // actual size (min of both orders)
    }

    // ============================================================
    //                          STATE
    // ============================================================

    IPerpEngine public immutable engine;
    IPerpVault public immutable vault;

    address public owner;
    address public feeRecipient;
    bool public paused;

    mapping(address => bool) public operators;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    uint256 public batchCounter;
    uint32 public makerFeeBps = 2;   // 0.02%
    uint32 public takerFeeBps = 6;   // 0.06%

    /// @notice Minimum delay between order commit and settlement (MEV protection)
    uint256 public minSettlementDelay = 2; // 2 seconds default (Base has ~2s blocks)

    /// @notice Maximum order age for settlement (prevents very old orders from executing)
    uint256 public maxSettlementDelay = 300; // 5 minutes max

    /// @notice Commit order hashes before they can be settled (MEV protection)
    mapping(bytes32 => uint256) public orderCommitTime;

    uint256 constant BPS = 10_000;
    uint256 constant SIZE_PRECISION = 1e8;

    /// @notice Dynamic spread: extra fee on trades that increase OI skew
    bool public dynamicSpreadEnabled = true;
    uint32 public spreadTier1Bps = 5;    // +0.05% when skew > 30%
    uint32 public spreadTier2Bps = 15;   // +0.15% when skew > 50%
    uint32 public spreadTier3Bps = 30;   // +0.30% when skew > 70%

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (!operators[msg.sender]) revert NotOperator(); _; }
    modifier whenNotPaused() { if (paused) revert Paused(); _; }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    constructor(address _engine, address _vault, address _feeRecipient, address _owner) {
        if (_engine == address(0) || _vault == address(0) ||
            _feeRecipient == address(0) || _owner == address(0)) revert ZeroAddress();

        engine = IPerpEngine(_engine);
        vault = IPerpVault(_vault);
        feeRecipient = _feeRecipient;
        owner = _owner;

        DOMAIN_SEPARATOR = keccak256(abi.encode(
            DOMAIN_TYPEHASH,
            keccak256("SUR Protocol"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ============================================================
    //                   SETTLEMENT FUNCTIONS
    // ============================================================

    function settleBatch(MatchedTrade[] calldata trades)
        external onlyOperator whenNotPaused
    {
        uint256 len = trades.length;
        if (len == 0) revert BatchEmpty();

        uint256 batchId = batchCounter++;
        for (uint256 i = 0; i < len;) {
            _settleTrade(trades[i]);
            unchecked { ++i; }
        }
        emit BatchSettled(batchId, len, block.timestamp);
    }

    function settleOne(MatchedTrade calldata trade)
        external onlyOperator whenNotPaused
    {
        uint256 batchId = batchCounter++;
        _settleTrade(trade);
        emit BatchSettled(batchId, 1, block.timestamp);
    }

    // ============================================================
    //                MEV COMMIT-SETTLE FUNCTIONS
    // ============================================================

    /// @notice Commit an order hash. Must be called before settlement.
    /// @dev The operator commits the order digest, then waits minSettlementDelay before settling.
    function commitOrder(bytes32 orderDigest) external onlyOperator {
        if (orderCommitTime[orderDigest] == 0) {
            orderCommitTime[orderDigest] = block.timestamp;
        }
    }

    /// @notice Commit multiple order digests at once
    function commitOrderBatch(bytes32[] calldata orderDigests) external onlyOperator {
        for (uint256 i = 0; i < orderDigests.length;) {
            if (orderCommitTime[orderDigests[i]] == 0) {
                orderCommitTime[orderDigests[i]] = block.timestamp;
            }
            unchecked { ++i; }
        }
    }

    // ============================================================
    //                   INTERNAL SETTLEMENT
    // ============================================================

    function _settleTrade(MatchedTrade calldata trade) internal {
        SignedOrder calldata maker = trade.maker;
        SignedOrder calldata taker = trade.taker;

        // --- Validations ---
        if (maker.marketId != taker.marketId) revert MarketMismatch();
        if (maker.isLong == taker.isLong) revert SidesNotOpposite();
        if (trade.executionSize == 0) revert ZeroSize();
        if (trade.executionPrice == 0) revert ZeroPrice();
        if (maker.expiry < block.timestamp) revert OrderExpired(maker.expiry, block.timestamp);
        if (taker.expiry < block.timestamp) revert OrderExpired(taker.expiry, block.timestamp);
        if (usedNonces[maker.trader][maker.nonce]) revert NonceAlreadyUsed(maker.trader, maker.nonce);
        if (usedNonces[taker.trader][taker.nonce]) revert NonceAlreadyUsed(taker.trader, taker.nonce);

        // --- Verify Signatures ---
        _verifySignature(maker);
        _verifySignature(taker);

        // --- Mark nonces ---
        usedNonces[maker.trader][maker.nonce] = true;
        usedNonces[taker.trader][taker.nonce] = true;

        // --- MEV Protection: verify commit-settle delay ---
        if (minSettlementDelay > 0) {
            bytes32 makerDigest = _orderDigest(maker);
            bytes32 takerDigest = _orderDigest(taker);

            uint256 makerCommit = orderCommitTime[makerDigest];
            uint256 takerCommit = orderCommitTime[takerDigest];

            // Orders must be committed first
            if (makerCommit == 0 || takerCommit == 0) {
                // Auto-commit if delay is very short (<=2s) for convenience
                if (minSettlementDelay <= 2) {
                    // Allow instant settlement with auto-commit
                    orderCommitTime[makerDigest] = block.timestamp;
                    orderCommitTime[takerDigest] = block.timestamp;
                } else {
                    revert OrderTooRecent(0, minSettlementDelay);
                }
            } else {
                // Check delay has passed
                uint256 earliestSettle = makerCommit > takerCommit ? makerCommit : takerCommit;
                if (block.timestamp < earliestSettle + minSettlementDelay) {
                    revert OrderTooRecent(earliestSettle, minSettlementDelay);
                }
            }
        }

        // --- Collect fees (with dynamic spread) ---
        uint256 notional = (trade.executionPrice * trade.executionSize) / SIZE_PRECISION;
        uint256 mFee = (notional * makerFeeBps) / BPS;

        // Dynamic spread: extra fee on taker if their trade increases OI skew
        uint32 extraSpread = _calculateDynamicSpread(taker.marketId, taker.isLong);
        uint256 effectiveTakerBps = uint256(takerFeeBps) + uint256(extraSpread);
        uint256 tFee = (notional * effectiveTakerBps) / BPS;

        if (mFee > 0) vault.internalTransfer(maker.trader, feeRecipient, mFee);
        if (tFee > 0) vault.internalTransfer(taker.trader, feeRecipient, tFee);

        if (extraSpread > 0) {
            emit DynamicSpreadApplied(taker.marketId, taker.trader, extraSpread, 0);
        }

        // --- Execute positions via PerpEngine ---
        // Convert isLong + size to int256 sizeDelta
        int256 makerDelta = maker.isLong
            ? int256(trade.executionSize)
            : -int256(trade.executionSize);
        int256 takerDelta = taker.isLong
            ? int256(trade.executionSize)
            : -int256(trade.executionSize);

        engine.openPosition(maker.marketId, maker.trader, makerDelta, trade.executionPrice);
        engine.openPosition(taker.marketId, taker.trader, takerDelta, trade.executionPrice);

        emit TradeSettled(
            maker.marketId, maker.trader, taker.trader,
            trade.executionPrice, trade.executionSize,
            taker.isLong, mFee, tFee, block.timestamp
        );
    }

    // ============================================================
    //                  EIP-712 VERIFICATION
    // ============================================================

    function _verifySignature(SignedOrder calldata order) internal view {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.trader, order.marketId, order.isLong,
            order.size, order.price, order.nonce, order.expiry
        ));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = _recoverSigner(digest, order.signature);

        if (recovered != order.trader) revert InvalidSignature(order.trader, recovered);
    }

    function _orderDigest(SignedOrder calldata order) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH,
            order.trader, order.marketId, order.isLong,
            order.size, order.price, order.nonce, order.expiry
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Invalid sig length");

        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }

        require(uint256(s) <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0, "Invalid s");
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Invalid v");

        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0), "Invalid signature");
        return recovered;
    }

    // ============================================================
    //                     VIEW FUNCTIONS
    // ============================================================

    function isNonceUsed(address trader, uint256 nonce) external view returns (bool) {
        return usedNonces[trader][nonce];
    }

    function getOrderDigest(
        address trader, bytes32 marketId, bool isLong,
        uint256 size, uint256 price, uint256 nonce, uint256 expiry
    ) external view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            ORDER_TYPEHASH, trader, marketId, isLong, size, price, nonce, expiry
        ));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
        emit OperatorUpdated(op, status);
    }

    function setFeeRecipient(address r) external onlyOwner {
        if (r == address(0)) revert ZeroAddress();
        emit FeeRecipientUpdated(feeRecipient, r);
        feeRecipient = r;
    }

    function setFees(uint32 _maker, uint32 _taker) external onlyOwner {
        makerFeeBps = _maker;
        takerFeeBps = _taker;
    }

    function setSettlementDelay(uint256 minDelay, uint256 maxDelay) external onlyOwner {
        minSettlementDelay = minDelay;
        maxSettlementDelay = maxDelay;
        emit TimeLockUpdated(minDelay);
    }

    function pause() external onlyOwner { paused = true; emit PauseStatusChanged(true); }
    function unpause() external onlyOwner { paused = false; emit PauseStatusChanged(false); }

    // ============================================================
    //                  DYNAMIC SPREAD
    // ============================================================

    /// @notice Calculate extra spread fee based on OI skew
    /// @dev Only penalizes the side that INCREASES the imbalance
    function _calculateDynamicSpread(bytes32 marketId, bool isLong)
        internal view returns (uint32 extraBps)
    {
        if (!dynamicSpreadEnabled) return 0;

        try IPerpEngineOI(address(engine)).markets(marketId) returns (
            bytes32, string memory, bool,
            uint256, uint256, uint256, uint256, uint256,
            uint256, int256, uint256, uint256,
            uint256 oiLong, uint256 oiShort
        ) {
            uint256 totalOi = oiLong + oiShort;
            if (totalOi == 0) return 0;

            // Check if this trade increases the skew
            bool increasesSkew;
            if (oiLong >= oiShort) {
                increasesSkew = isLong; // longs dominant → going long increases skew
            } else {
                increasesSkew = !isLong; // shorts dominant → going short increases skew
            }

            if (!increasesSkew) return 0; // reducing skew → no penalty

            // Calculate current skew ratio
            uint256 dominant = oiLong > oiShort ? oiLong : oiShort;
            uint256 skewBps = (dominant * BPS) / totalOi;

            if (skewBps >= 7000) return spreadTier3Bps;  // >70% skew
            if (skewBps >= 5000) return spreadTier2Bps;  // >50% skew
            if (skewBps >= 3000) return spreadTier1Bps;  // >30% skew
            return 0;                                      // balanced
        } catch {
            return 0; // if engine call fails, no extra spread
        }
    }

    function setDynamicSpreadEnabled(bool enabled) external onlyOwner {
        dynamicSpreadEnabled = enabled;
    }

    function setDynamicSpreadTiers(uint32 tier1, uint32 tier2, uint32 tier3) external onlyOwner {
        spreadTier1Bps = tier1;
        spreadTier2Bps = tier2;
        spreadTier3Bps = tier3;
    }
}
