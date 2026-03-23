// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IPerpEngine, IInsuranceFund} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - Liquidator
/// @author SUR Protocol Team
/// @notice Permissionless liquidation. ANYONE can call liquidate() to close
///         undercollateralized positions and earn a keeper reward.

contract Liquidator {
    error NotOwner();
    error Paused();
    error ZeroAddress();
    error PositionNotLiquidatable(bytes32 marketId, address trader);
    error NoPosition(bytes32 marketId, address trader);

    event LiquidationExecuted(bytes32 indexed marketId, address indexed trader, address indexed keeper, uint256 timestamp);
    event LiquidationFailed(bytes32 indexed marketId, address indexed trader, string reason);
    event PauseStatusChanged(bool isPaused);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

    IPerpEngine public immutable engine;
    IInsuranceFund public immutable insuranceFund;
    address public owner;
    address public pendingOwner;
    bool public paused;

    uint256 public totalLiquidations;
    mapping(address => uint256) public keeperLiquidations;

    modifier whenNotPaused() { if (paused) revert Paused(); _; }
    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(address _engine, address _insuranceFund, address _owner) {
        if (_engine == address(0) || _insuranceFund == address(0) || _owner == address(0))
            revert ZeroAddress();
        engine = IPerpEngine(_engine);
        insuranceFund = IInsuranceFund(_insuranceFund);
        owner = _owner;
    }

    /// @notice Liquidate an undercollateralized position. Anyone can call.
    function liquidate(bytes32 marketId, address trader) external whenNotPaused {
        if (trader == address(0)) revert ZeroAddress();

        (int256 size,,,,) = engine.positions(marketId, trader);
        if (size == 0) revert NoPosition(marketId, trader);
        if (!engine.isLiquidatable(marketId, trader))
            revert PositionNotLiquidatable(marketId, trader);

        engine.liquidatePosition(marketId, trader, msg.sender);

        unchecked {
            totalLiquidations++;
            keeperLiquidations[msg.sender]++;
        }
        emit LiquidationExecuted(marketId, trader, msg.sender, block.timestamp);
    }

    /// @notice Batch liquidation - skips non-liquidatable positions silently
    function liquidateBatch(bytes32[] calldata marketIds, address[] calldata traders)
        external whenNotPaused
    {
        require(marketIds.length == traders.length, "Length mismatch");
        for (uint256 i = 0; i < marketIds.length;) {
            (int256 size,,,,) = engine.positions(marketIds[i], traders[i]);
            if (size != 0 && engine.isLiquidatable(marketIds[i], traders[i])) {
                try engine.liquidatePosition(marketIds[i], traders[i], msg.sender) {
                    unchecked {
                        totalLiquidations++;
                        keeperLiquidations[msg.sender]++;
                    }
                    emit LiquidationExecuted(marketIds[i], traders[i], msg.sender, block.timestamp);
                } catch Error(string memory reason) {
                    emit LiquidationFailed(marketIds[i], traders[i], reason);
                } catch {
                    emit LiquidationFailed(marketIds[i], traders[i], "Unknown");
                }
            }
            unchecked { ++i; }
        }
    }

    /// @notice Scan positions for liquidation opportunities
    function scanLiquidatable(bytes32[] calldata marketIds, address[] calldata traders)
        external view returns (bool[] memory liquidatable)
    {
        require(marketIds.length == traders.length, "Length mismatch");
        liquidatable = new bool[](marketIds.length);
        for (uint256 i = 0; i < marketIds.length;) {
            (int256 size,,,,) = engine.positions(marketIds[i], traders[i]);
            if (size != 0) liquidatable[i] = engine.isLiquidatable(marketIds[i], traders[i]);
            unchecked { ++i; }
        }
    }

    function canLiquidate(bytes32 marketId, address trader)
        external view returns (bool can, int256 posSize)
    {
        (posSize,,,,) = engine.positions(marketId, trader);
        if (posSize != 0) can = engine.isLiquidatable(marketId, trader);
    }

    /// @notice Liquidate a cross-margin account. Anyone can call.
    /// @dev Closes ALL positions when total account equity < maintenance requirement.
    function liquidateAccount(address trader) external whenNotPaused {
        if (trader == address(0)) revert ZeroAddress();
        if (!engine.isAccountLiquidatable(trader)) revert PositionNotLiquidatable(bytes32(0), trader);

        engine.liquidateAccount(trader, msg.sender);

        unchecked {
            totalLiquidations++;
            keeperLiquidations[msg.sender]++;
        }
        emit LiquidationExecuted(bytes32(0), trader, msg.sender, block.timestamp);
    }

    function pause() external onlyOwner { paused = true; emit PauseStatusChanged(true); }
    function unpause() external onlyOwner { paused = false; emit PauseStatusChanged(false); }
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
