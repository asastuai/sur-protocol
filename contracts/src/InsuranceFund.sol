// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPerpVault} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - InsuranceFund
/// @author SUR Protocol Team
/// @notice Accumulates funds to cover bad debt from liquidations.
/// @dev The insurance fund's balance lives in PerpVault (as a vault account).
///      This contract provides governance over those funds:
///      - Tracks cumulative bad debt
///      - Allows the Liquidator to request keeper rewards from the fund
///      - Allows the owner to deposit additional capital
///      - Reports fund health (balance vs outstanding bad debt)
///
///      Revenue sources:
///      - Portion of remaining margin from healthy liquidations
///      - Protocol fee allocation (configured externally)
///      - Manual deposits from treasury
///
///      The fund address is set as `insuranceFund` in PerpEngine.
///      When a liquidation produces bad debt, PerpEngine sends the
///      remaining margin to this address in the vault.

contract InsuranceFund {
    // ============================================================
    //                          ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientFundBalance(uint256 requested, uint256 available);

    // ============================================================
    //                          EVENTS
    // ============================================================

    event BadDebtRecorded(
        bytes32 indexed marketId,
        address indexed trader,
        uint256 amount,
        uint256 totalBadDebt
    );

    event KeeperRewardPaid(
        address indexed keeper,
        uint256 amount
    );

    event FundDeposit(
        address indexed depositor,
        uint256 amount,
        uint256 newBalance
    );

    event OperatorUpdated(address indexed operator, bool status);

    // ============================================================
    //                          STATE
    // ============================================================

    /// @notice PerpVault for balance queries and transfers
    IPerpVault public immutable vault;

    /// @notice Contract owner
    address public owner;

    /// @notice Approved operators (Liquidator contract)
    mapping(address => bool) public operators;

    /// @notice M-16 fix: Pause mechanism
    bool public paused;

    /// @notice Cumulative bad debt absorbed by the fund
    uint256 public totalBadDebt;

    /// @notice Cumulative keeper rewards paid from the fund
    uint256 public totalKeeperRewardsPaid;

    /// @notice H-9 fix: Max keeper reward per call (0 = unlimited)
    uint256 public maxKeeperRewardPerCall = 1000 * 1e6; // $1,000 USDC default

    /// @notice H-9 fix: Daily cumulative keeper reward tracking
    uint256 public maxDailyKeeperRewards = 10_000 * 1e6; // $10,000 USDC/day default
    uint256 public dailyKeeperRewardsPaid;
    uint256 public dailyRewardResetTimestamp;

    /// @notice Bad debt by market for analytics
    mapping(bytes32 => uint256) public marketBadDebt;

    /// @notice Total liquidations processed
    uint256 public totalLiquidations;

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    error InsuranceFundPaused();
    modifier whenNotPaused() {
        if (paused) revert InsuranceFundPaused();
        _;
    }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    /// @param _vault PerpVault contract
    /// @param _owner Contract owner
    constructor(address _vault, address _owner) {
        if (_vault == address(0) || _owner == address(0)) revert ZeroAddress();
        vault = IPerpVault(_vault);
        owner = _owner;
    }

    // ============================================================
    //                   OPERATOR FUNCTIONS
    // ============================================================

    /// @notice M-15 fix: Bad debt deduplication
    mapping(bytes32 => bool) public recordedBadDebtHashes;

    /// @notice Record bad debt from a liquidation
    /// @param marketId The market where bad debt occurred
    /// @param trader The liquidated trader
    /// @param amount Bad debt amount in USDC (6 decimals)
    function recordBadDebt(
        bytes32 marketId,
        address trader,
        uint256 amount
    ) external onlyOperator whenNotPaused {
        if (amount == 0) return;

        // M-15 fix: Prevent duplicate bad debt recording
        bytes32 debtHash = keccak256(abi.encodePacked(marketId, trader, amount, block.number));
        require(!recordedBadDebtHashes[debtHash], "Duplicate bad debt");
        recordedBadDebtHashes[debtHash] = true;

        totalBadDebt += amount;
        marketBadDebt[marketId] += amount;
        totalLiquidations++;

        emit BadDebtRecorded(marketId, trader, amount, totalBadDebt);
    }

    error KeeperRewardExceedsPerCallCap(uint256 amount, uint256 cap);
    error DailyKeeperRewardCapExceeded(uint256 dailyTotal, uint256 cap);

    /// @notice Pay keeper reward from insurance fund balance
    /// @param keeper The keeper to reward
    /// @param amount Reward amount in USDC (6 decimals)
    function payKeeperReward(address keeper, uint256 amount) external onlyOperator whenNotPaused {
        if (amount == 0) return;
        if (keeper == address(0)) revert ZeroAddress();

        // H-9 fix: Per-call cap
        if (maxKeeperRewardPerCall > 0 && amount > maxKeeperRewardPerCall) {
            revert KeeperRewardExceedsPerCallCap(amount, maxKeeperRewardPerCall);
        }

        // H-9 fix: Daily cumulative cap (resets every 24h)
        if (block.timestamp >= dailyRewardResetTimestamp + 1 days) {
            dailyKeeperRewardsPaid = 0;
            dailyRewardResetTimestamp = block.timestamp;
        }
        if (maxDailyKeeperRewards > 0 && dailyKeeperRewardsPaid + amount > maxDailyKeeperRewards) {
            revert DailyKeeperRewardCapExceeded(dailyKeeperRewardsPaid + amount, maxDailyKeeperRewards);
        }

        uint256 fundBal = vault.balances(address(this));
        if (fundBal < amount) revert InsufficientFundBalance(amount, fundBal);

        vault.internalTransfer(address(this), keeper, amount);
        totalKeeperRewardsPaid += amount;
        dailyKeeperRewardsPaid += amount;

        emit KeeperRewardPaid(keeper, amount);
    }

    // ============================================================
    //                     VIEW FUNCTIONS
    // ============================================================

    /// @notice Current USDC balance of the fund in the vault
    function balance() external view returns (uint256) {
        return vault.balances(address(this));
    }

    /// @notice Health check: is the fund solvent?
    /// @return fundBalance Current USDC balance
    /// @return cumulativeBadDebt Total bad debt ever absorbed
    /// @return liquidationCount Total liquidations processed
    function healthCheck()
        external
        view
        returns (
            uint256 fundBalance,
            uint256 cumulativeBadDebt,
            uint256 liquidationCount
        )
    {
        fundBalance = vault.balances(address(this));
        cumulativeBadDebt = totalBadDebt;
        liquidationCount = totalLiquidations;
    }

    // ============================================================
    //                    ADMIN FUNCTIONS
    // ============================================================

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
        emit OperatorUpdated(op, status);
    }

    event PauseStatusChanged(bool isPaused);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event MaxKeeperRewardUpdated(uint256 perCall, uint256 daily);

    address public pendingOwner;

    function pause() external onlyOwner {
        paused = true;
        emit PauseStatusChanged(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PauseStatusChanged(false);
    }

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

    function setMaxKeeperRewardPerCall(uint256 newCap) external onlyOwner {
        maxKeeperRewardPerCall = newCap;
        emit MaxKeeperRewardUpdated(newCap, maxDailyKeeperRewards);
    }

    function setMaxDailyKeeperRewards(uint256 newCap) external onlyOwner {
        maxDailyKeeperRewards = newCap;
        emit MaxKeeperRewardUpdated(maxKeeperRewardPerCall, newCap);
    }
}
