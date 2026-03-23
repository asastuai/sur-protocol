// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPerpEngine, IPerpVault, IInsuranceFund} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - Auto-Deleveraging (ADL)
/// @author SUR Protocol Team
/// @notice Last-resort mechanism when insurance fund is depleted.
///         Forcibly reduces profitable positions on the opposite side
///         to cover bad debt from liquidations.
/// @dev ADL is extremely rare and indicates a serious market event.
///
///      Flow:
///      1. Liquidation occurs → insurance fund can't cover bad debt
///      2. ADL keeper identifies most profitable opposite-side positions
///      3. ADL contract closes portions of those positions at mark price
///      4. The "missing" PnL is absorbed (profitable trader gets reduced profit)
///
///      Safeguards:
///      - Only triggers when insurance fund balance < threshold
///      - Minimum bad debt threshold before ADL activates
///      - Cooldown between ADL events
///      - Owner can pause/disable ADL entirely

contract AutoDeleveraging {
    // ============================================================
    //                          ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error Paused();
    error ZeroAddress();
    error InsuranceFundSufficient(uint256 fundBalance, uint256 badDebtThreshold);
    error CooldownActive(uint256 nextAllowedTime);
    error NoPosition(bytes32 marketId, address trader);
    error PositionNotProfitable(bytes32 marketId, address trader);
    error ADLDisabled();
    error BadDebtBelowThreshold(uint256 badDebt, uint256 threshold);

    // ============================================================
    //                          EVENTS
    // ============================================================

    event ADLExecuted(
        bytes32 indexed marketId,
        address indexed deleveragedTrader,
        int256 reducedSize,
        uint256 closePrice,
        int256 unrealizedPnlBefore,
        uint256 badDebtCovered,
        uint256 timestamp
    );

    event ADLTriggered(
        bytes32 indexed marketId,
        uint256 totalBadDebt,
        uint256 insuranceFundBalance,
        uint256 timestamp
    );

    event ADLParamsUpdated(uint256 minBadDebtThreshold, uint256 cooldownSecs);

    // ============================================================
    //                          STATE
    // ============================================================

    IPerpEngine public immutable engine;
    IPerpVault public immutable vault;
    IInsuranceFund public immutable insuranceFund;

    address public owner;
    bool public paused;
    bool public adlEnabled = true;

    mapping(address => bool) public operators;

    /// @notice Minimum bad debt (USDC 6 decimals) before ADL can activate
    uint256 public minBadDebtThreshold = 1000 * 1e6; // $1,000

    /// @notice Cooldown between ADL events (seconds)
    uint256 public adlCooldownSecs = 300; // 5 minutes

    /// @notice Last ADL execution timestamp
    uint256 public lastADLTime;

    /// @notice Total ADL events executed
    uint256 public totalADLEvents;

    /// @notice Total bad debt covered via ADL
    uint256 public totalBadDebtCovered;

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (!operators[msg.sender]) revert NotOperator(); _; }
    modifier whenNotPaused() { if (paused) revert Paused(); _; }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    constructor(
        address _engine,
        address _vault,
        address _insuranceFund,
        address _owner
    ) {
        if (_engine == address(0) || _vault == address(0) ||
            _insuranceFund == address(0) || _owner == address(0)) revert ZeroAddress();

        engine = IPerpEngine(_engine);
        vault = IPerpVault(_vault);
        insuranceFund = IInsuranceFund(_insuranceFund);
        owner = _owner;
    }

    // ============================================================
    //                    ADL EXECUTION
    // ============================================================

    /// @notice Execute ADL on a profitable position to cover bad debt
    /// @param marketId The market where bad debt exists
    /// @param trader The profitable trader to deleverage
    /// @param reduceSize Size to reduce (SIZE_PRECISION, always positive)
    /// @param markPrice Current mark price for settlement (6 decimals)
    /// @param badDebtAmount The bad debt to cover (USDC 6 decimals)
    function executeADL(
        bytes32 marketId,
        address trader,
        uint256 reduceSize,
        uint256 markPrice,
        uint256 badDebtAmount
    ) external onlyOperator whenNotPaused {
        if (!adlEnabled) revert ADLDisabled();

        // Check cooldown
        if (block.timestamp < lastADLTime + adlCooldownSecs) {
            revert CooldownActive(lastADLTime + adlCooldownSecs);
        }

        // Verify insurance fund is actually depleted
        uint256 fundBal = insuranceFund.balance();
        if (fundBal >= minBadDebtThreshold) {
            revert InsuranceFundSufficient(fundBal, minBadDebtThreshold);
        }

        // Verify bad debt exceeds threshold
        if (badDebtAmount < minBadDebtThreshold) {
            revert BadDebtBelowThreshold(badDebtAmount, minBadDebtThreshold);
        }

        // Get position — must exist and be profitable
        (int256 size,,,,) = engine.positions(marketId, trader);
        if (size == 0) revert NoPosition(marketId, trader);

        int256 unrealizedPnl = engine.getUnrealizedPnl(marketId, trader);
        if (unrealizedPnl <= 0) revert PositionNotProfitable(marketId, trader);

        // Calculate the size delta (close portion of profitable position)
        int256 sizeDelta;
        if (size > 0) {
            uint256 actualReduce = reduceSize > uint256(size) ? uint256(size) : reduceSize;
            sizeDelta = -int256(actualReduce);
        } else {
            uint256 absSize = uint256(-size);
            uint256 actualReduce = reduceSize > absSize ? absSize : reduceSize;
            sizeDelta = int256(actualReduce);
        }

        // Close via engine at mark price
        engine.openPosition(marketId, trader, sizeDelta, markPrice);

        lastADLTime = block.timestamp;
        totalADLEvents++;
        totalBadDebtCovered += badDebtAmount;

        emit ADLExecuted(marketId, trader, sizeDelta, markPrice, unrealizedPnl, badDebtAmount, block.timestamp);
        emit ADLTriggered(marketId, badDebtAmount, fundBal, block.timestamp);
    }

    /// @notice Batch ADL: deleverage multiple profitable positions
    function executeADLBatch(
        bytes32 marketId,
        address[] calldata traders,
        uint256[] calldata reduceSizes,
        uint256 markPrice,
        uint256 totalBadDebt
    ) external onlyOperator whenNotPaused {
        require(traders.length == reduceSizes.length, "Length mismatch");
        if (!adlEnabled) revert ADLDisabled();

        if (block.timestamp < lastADLTime + adlCooldownSecs) {
            revert CooldownActive(lastADLTime + adlCooldownSecs);
        }

        uint256 fundBal = insuranceFund.balance();
        if (fundBal >= minBadDebtThreshold) {
            revert InsuranceFundSufficient(fundBal, minBadDebtThreshold);
        }

        uint256 badDebtPerTrader = totalBadDebt / traders.length;

        for (uint256 i = 0; i < traders.length;) {
            (int256 size,,,,) = engine.positions(marketId, traders[i]);
            if (size != 0) {
                int256 pnl = engine.getUnrealizedPnl(marketId, traders[i]);
                if (pnl > 0) {
                    int256 sizeDelta;
                    if (size > 0) {
                        uint256 actualReduce = reduceSizes[i] > uint256(size) ? uint256(size) : reduceSizes[i];
                        sizeDelta = -int256(actualReduce);
                    } else {
                        uint256 absSize = uint256(-size);
                        uint256 actualReduce = reduceSizes[i] > absSize ? absSize : reduceSizes[i];
                        sizeDelta = int256(actualReduce);
                    }

                    try engine.openPosition(marketId, traders[i], sizeDelta, markPrice) {
                        totalBadDebtCovered += badDebtPerTrader;
                        emit ADLExecuted(marketId, traders[i], sizeDelta, markPrice, pnl, badDebtPerTrader, block.timestamp);
                    } catch {}
                }
            }
            unchecked { ++i; }
        }

        lastADLTime = block.timestamp;
        totalADLEvents++;
        emit ADLTriggered(marketId, totalBadDebt, fundBal, block.timestamp);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /// @notice Check if ADL conditions are met
    function isADLRequired() external view returns (bool required, uint256 fundBalance) {
        fundBalance = insuranceFund.balance();
        required = adlEnabled && fundBalance < minBadDebtThreshold
            && block.timestamp >= lastADLTime + adlCooldownSecs;
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
    }

    function setADLEnabled(bool enabled) external onlyOwner {
        adlEnabled = enabled;
    }

    function setADLParams(uint256 _minBadDebtThreshold, uint256 _cooldownSecs) external onlyOwner {
        minBadDebtThreshold = _minBadDebtThreshold;
        adlCooldownSecs = _cooldownSecs;
        emit ADLParamsUpdated(_minBadDebtThreshold, _cooldownSecs);
    }

    function pause() external onlyOwner { paused = true; }
    function unpause() external onlyOwner { paused = false; }

    address public pendingOwner;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

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
}
