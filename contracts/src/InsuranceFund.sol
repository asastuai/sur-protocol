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

    /// @notice Cumulative bad debt absorbed by the fund
    uint256 public totalBadDebt;

    /// @notice Cumulative keeper rewards paid from the fund
    uint256 public totalKeeperRewardsPaid;

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

    /// @notice Record bad debt from a liquidation
    /// @param marketId The market where bad debt occurred
    /// @param trader The liquidated trader
    /// @param amount Bad debt amount in USDC (6 decimals)
    function recordBadDebt(
        bytes32 marketId,
        address trader,
        uint256 amount
    ) external onlyOperator {
        if (amount == 0) return;

        totalBadDebt += amount;
        marketBadDebt[marketId] += amount;
        totalLiquidations++;

        emit BadDebtRecorded(marketId, trader, amount, totalBadDebt);
    }

    /// @notice Pay keeper reward from insurance fund balance
    /// @param keeper The keeper to reward
    /// @param amount Reward amount in USDC (6 decimals)
    /// @dev Used when a liquidation is underwater and the keeper reward
    ///      must come from the fund instead of the trader's margin.
    function payKeeperReward(address keeper, uint256 amount) external onlyOperator {
        if (amount == 0) return;
        if (keeper == address(0)) revert ZeroAddress();

        uint256 fundBal = vault.balances(address(this));
        if (fundBal < amount) revert InsufficientFundBalance(amount, fundBal);

        vault.internalTransfer(address(this), keeper, amount);
        totalKeeperRewardsPaid += amount;

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

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        owner = newOwner;
    }
}
