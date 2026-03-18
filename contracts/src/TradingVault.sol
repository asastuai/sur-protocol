// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPerpVault, IPerpEngine} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - TradingVault
/// @author SUR Protocol Team
/// @notice Pooled trading vaults. Depositors share profits/losses of a vault manager's trades.
///
/// @dev Similar to Hyperliquid's HLP vaults or copy-trading.
///
///      Flow:
///      1. Anyone creates a vault, becoming the vault manager
///      2. Depositors deposit USDC → receive vault shares proportional to vault equity
///      3. Manager trades using the vault's USDC as margin (via PerpEngine)
///      4. Profits/losses distribute to all shareholders proportionally
///      5. Depositors can withdraw at any time (subject to lockup period)
///      6. Manager earns a performance fee (% of profits) and management fee (% of AUM/year)
///
///      Share model:
///      - shares = deposit * totalShares / totalEquity
///      - equity = vault's USDC balance + unrealized PnL from all open positions
///      - First depositor gets 1:1 shares (no dilution)
///
///      Fees:
///      - Performance fee: 10-30% of profits (set at creation, immutable)
///      - Management fee: 0-2% of AUM per year (accrued per second)
///
///      Safety:
///      - Manager can only trade, not withdraw vault funds directly
///      - Max drawdown limit: if equity drops below threshold, vault auto-pauses
///      - Lockup period: depositors must wait N seconds after deposit to withdraw
///      - Deposit cap per vault

contract TradingVault {
    // ============================================================
    //                    ERRORS
    // ============================================================

    error NotManager();
    error NotOwner();
    error VaultPaused();
    error ZeroAmount();
    error ZeroAddress();
    error InsufficientShares(uint256 requested, uint256 available);
    error LockupNotExpired(uint256 unlockTime);
    error DepositCapExceeded(uint256 newTotal, uint256 cap);
    error MaxDrawdownBreached(uint256 currentEquity, uint256 highWaterMark);
    error VaultAlreadyExists(bytes32 vaultId);
    error VaultNotFound(bytes32 vaultId);
    error InvalidFees();

    // ============================================================
    //                    EVENTS
    // ============================================================

    event VaultCreated(bytes32 indexed vaultId, address indexed manager, string name, uint256 performanceFeeBps, uint256 managementFeeBps);
    event VaultDeposit(bytes32 indexed vaultId, address indexed depositor, uint256 usdcAmount, uint256 sharesIssued, uint256 equityAtTime);
    event VaultWithdraw(bytes32 indexed vaultId, address indexed depositor, uint256 sharesBurned, uint256 usdcReturned, uint256 equityAtTime);
    event VaultTradeExecuted(bytes32 indexed vaultId, bytes32 indexed marketId, int256 sizeDelta, uint256 price);
    event PerformanceFeeCollected(bytes32 indexed vaultId, uint256 amount);
    event ManagementFeeCollected(bytes32 indexed vaultId, uint256 amount);
    event VaultPauseChanged(bytes32 indexed vaultId, bool isPaused);

    // ============================================================
    //                    STRUCTS
    // ============================================================

    struct Vault {
        bytes32 id;
        string name;
        string description;
        address manager;              // the trader who controls the vault
        bool paused;

        // Share accounting
        uint256 totalShares;          // total outstanding shares (18 decimals for precision)
        uint256 totalDeposited;       // total USDC ever deposited (for analytics)
        uint256 totalWithdrawn;       // total USDC ever withdrawn

        // Fee structure (immutable after creation)
        uint256 performanceFeeBps;    // 2000 = 20% of profits
        uint256 managementFeeBps;     // 200 = 2% per year of AUM

        // High water mark for performance fee
        uint256 highWaterMark;        // highest equity per share (6 decimals)
        uint256 lastFeeAccrual;       // timestamp of last management fee accrual

        // Safety limits
        uint256 depositCap;           // max total USDC in vault (0 = unlimited)
        uint256 lockupPeriodSecs;     // seconds depositor must wait before withdrawing
        uint256 maxDrawdownBps;       // 3000 = 30% max drawdown from HWM before auto-pause

        // Stats
        uint256 createdAt;
    }

    struct Depositor {
        uint256 shares;               // vault shares held
        uint256 depositTimestamp;      // when last deposited (for lockup)
        uint256 totalDeposited;       // total USDC deposited lifetime
        uint256 totalWithdrawn;       // total USDC withdrawn lifetime
    }

    // ============================================================
    //                    STATE
    // ============================================================

    address public owner;
    IPerpVault public perpVault;
    IPerpEngine public perpEngine;

    uint256 public constant SHARE_DECIMALS = 18;
    uint256 public constant SHARE_PRECISION = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant PRICE_PRECISION = 1e6;
    uint256 public constant SECONDS_PER_YEAR = 365.25 days;

    // Vault registry
    mapping(bytes32 => Vault) public vaults;
    bytes32[] public vaultIds;

    // Depositor tracking: vaultId => depositor => Depositor
    mapping(bytes32 => mapping(address => Depositor)) public depositors;

    // Vault's address in PerpVault (each vault gets a unique internal account)
    // We use address(uint160(uint256(vaultId))) as the vault's account in PerpVault
    // This avoids creating actual contracts per vault

    mapping(address => bool) public operators;

    // ============================================================
    //                    MODIFIERS
    // ============================================================

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyManager(bytes32 vaultId) {
        if (msg.sender != vaults[vaultId].manager) revert NotManager();
        _;
    }
    modifier vaultExists(bytes32 vaultId) {
        if (vaults[vaultId].createdAt == 0) revert VaultNotFound(vaultId);
        _;
    }
    modifier vaultNotPaused(bytes32 vaultId) {
        if (vaults[vaultId].paused) revert VaultPaused();
        _;
    }

    // ============================================================
    //                    CONSTRUCTOR
    // ============================================================

    constructor(address _perpVault, address _perpEngine, address _owner) {
        if (_perpVault == address(0) || _perpEngine == address(0) || _owner == address(0)) revert ZeroAddress();
        perpVault = IPerpVault(_perpVault);
        perpEngine = IPerpEngine(_perpEngine);
        owner = _owner;
    }

    // ============================================================
    //                    VAULT CREATION
    // ============================================================

    /// @notice Create a new trading vault
    /// @param name Vault display name
    /// @param description Vault strategy description
    /// @param performanceFeeBps Performance fee (max 3000 = 30%)
    /// @param managementFeeBps Management fee per year (max 500 = 5%)
    /// @param depositCap Max USDC in vault (0 = unlimited)
    /// @param lockupPeriodSecs Lockup period for depositors (recommended: 86400 = 1 day)
    /// @param maxDrawdownBps Max drawdown before auto-pause (3000 = 30%)
    /// @return vaultId The unique vault identifier
    function createVault(
        string calldata name,
        string calldata description,
        uint256 performanceFeeBps,
        uint256 managementFeeBps,
        uint256 depositCap,
        uint256 lockupPeriodSecs,
        uint256 maxDrawdownBps
    ) external returns (bytes32 vaultId) {
        if (performanceFeeBps > 3000) revert InvalidFees(); // max 30%
        if (managementFeeBps > 500) revert InvalidFees();   // max 5%
        require(maxDrawdownBps > 0 && maxDrawdownBps <= 9000, "Invalid drawdown limit");

        vaultId = keccak256(abi.encodePacked(msg.sender, name, block.timestamp));
        if (vaults[vaultId].createdAt != 0) revert VaultAlreadyExists(vaultId);

        vaults[vaultId] = Vault({
            id: vaultId,
            name: name,
            description: description,
            manager: msg.sender,
            paused: false,
            totalShares: 0,
            totalDeposited: 0,
            totalWithdrawn: 0,
            performanceFeeBps: performanceFeeBps,
            managementFeeBps: managementFeeBps,
            highWaterMark: PRICE_PRECISION, // starts at $1 per share
            lastFeeAccrual: block.timestamp,
            depositCap: depositCap,
            lockupPeriodSecs: lockupPeriodSecs,
            maxDrawdownBps: maxDrawdownBps,
            createdAt: block.timestamp
        });

        vaultIds.push(vaultId);
        emit VaultCreated(vaultId, msg.sender, name, performanceFeeBps, managementFeeBps);
    }

    // ============================================================
    //                    DEPOSITOR FUNCTIONS
    // ============================================================

    /// @notice Deposit USDC into a vault. Receives shares proportional to vault equity.
    /// @param vaultId The vault to deposit into
    /// @param amount USDC amount to deposit (6 decimals)
    function deposit(bytes32 vaultId, uint256 amount)
        external vaultExists(vaultId) vaultNotPaused(vaultId)
    {
        if (amount == 0) revert ZeroAmount();

        Vault storage v = vaults[vaultId];

        // Check deposit cap
        uint256 currentEquity = _getVaultEquity(vaultId);
        if (v.depositCap > 0 && currentEquity + amount > v.depositCap) {
            revert DepositCapExceeded(currentEquity + amount, v.depositCap);
        }

        // Accrue management fees before share calculation
        _accrueManagementFee(vaultId);

        // Calculate shares to issue
        uint256 shares;
        if (v.totalShares == 0) {
            // First deposit: 1 USDC = 1e12 shares (to allow fractional shares)
            shares = amount * (SHARE_PRECISION / PRICE_PRECISION);
        } else {
            // shares = amount * totalShares / totalEquity
            shares = (amount * v.totalShares) / currentEquity;
        }

        require(shares > 0, "Deposit too small");

        // Transfer USDC from depositor to vault's PerpVault account
        // The depositor must have approved this contract
        // 1. USDC goes from depositor → PerpVault (vault.deposit)
        // 2. We then transfer from depositor's PerpVault balance to vault's account
        perpVault.internalTransfer(msg.sender, _vaultAccount(vaultId), amount);

        // Issue shares
        v.totalShares += shares;
        v.totalDeposited += amount;

        Depositor storage d = depositors[vaultId][msg.sender];
        d.shares += shares;
        d.depositTimestamp = block.timestamp;
        d.totalDeposited += amount;

        // Update high water mark if new equity per share is higher
        uint256 equityPerShare = _equityPerShare(vaultId);
        if (equityPerShare > v.highWaterMark) {
            v.highWaterMark = equityPerShare;
        }

        emit VaultDeposit(vaultId, msg.sender, amount, shares, currentEquity + amount);
    }

    /// @notice Withdraw USDC from a vault by burning shares
    /// @param vaultId The vault to withdraw from
    /// @param shares Number of shares to burn
    function withdraw(bytes32 vaultId, uint256 shares) external vaultExists(vaultId) {
        if (shares == 0) revert ZeroAmount();

        Vault storage v = vaults[vaultId];
        Depositor storage d = depositors[vaultId][msg.sender];

        if (d.shares < shares) revert InsufficientShares(shares, d.shares);

        // Check lockup
        uint256 unlockTime = d.depositTimestamp + v.lockupPeriodSecs;
        if (block.timestamp < unlockTime) revert LockupNotExpired(unlockTime);

        // Accrue fees before withdrawal
        _accrueManagementFee(vaultId);
        _collectPerformanceFee(vaultId);

        // Calculate USDC to return: shares / totalShares * totalEquity
        uint256 equity = _getVaultEquity(vaultId);
        uint256 usdcAmount = (shares * equity) / v.totalShares;

        // Burn shares
        v.totalShares -= shares;
        v.totalWithdrawn += usdcAmount;
        d.shares -= shares;
        d.totalWithdrawn += usdcAmount;

        // Transfer USDC from vault account to depositor
        perpVault.internalTransfer(_vaultAccount(vaultId), msg.sender, usdcAmount);

        emit VaultWithdraw(vaultId, msg.sender, shares, usdcAmount, equity - usdcAmount);
    }

    // ============================================================
    //                    MANAGER TRADING
    // ============================================================

    /// @notice Manager opens/modifies a position using vault funds
    /// @dev The vault's PerpVault balance is used as margin
    function trade(
        bytes32 vaultId,
        bytes32 marketId,
        int256 sizeDelta,
        uint256 price
    ) external onlyManager(vaultId) vaultNotPaused(vaultId) {
        // Check drawdown limit
        _checkDrawdown(vaultId);

        // Execute trade via PerpEngine (vault account as trader)
        perpEngine.openPosition(marketId, _vaultAccount(vaultId), sizeDelta, price);

        emit VaultTradeExecuted(vaultId, marketId, sizeDelta, price);
    }

    // ============================================================
    //                    FEE LOGIC
    // ============================================================

    /// @notice Accrue management fee (% of AUM per year, distributed pro-rata over time)
    function _accrueManagementFee(bytes32 vaultId) internal {
        Vault storage v = vaults[vaultId];
        if (v.managementFeeBps == 0 || v.totalShares == 0) {
            v.lastFeeAccrual = block.timestamp;
            return;
        }

        uint256 elapsed = block.timestamp - v.lastFeeAccrual;
        if (elapsed == 0) return;

        // fee = totalEquity * managementFeeBps * elapsed / (BPS * SECONDS_PER_YEAR)
        uint256 equity = _getVaultEquity(vaultId);
        uint256 fee = (equity * v.managementFeeBps * elapsed) / (BPS * SECONDS_PER_YEAR);

        if (fee > 0 && fee < equity) {
            // Pay fee from vault to manager
            perpVault.internalTransfer(_vaultAccount(vaultId), v.manager, fee);
            emit ManagementFeeCollected(vaultId, fee);
        }

        v.lastFeeAccrual = block.timestamp;
    }

    /// @notice Collect performance fee if equity per share exceeds high water mark
    function _collectPerformanceFee(bytes32 vaultId) internal {
        Vault storage v = vaults[vaultId];
        if (v.performanceFeeBps == 0 || v.totalShares == 0) return;

        uint256 equityPerShare = _equityPerShare(vaultId);
        if (equityPerShare <= v.highWaterMark) return; // no profit above HWM

        // Profit per share above HWM
        uint256 profitPerShare = equityPerShare - v.highWaterMark;

        // Total profit = profitPerShare * totalShares / SHARE_PRECISION
        uint256 totalProfit = (profitPerShare * v.totalShares) / SHARE_PRECISION;

        // Fee = profit * performanceFeeBps / BPS
        uint256 fee = (totalProfit * v.performanceFeeBps) / BPS;

        if (fee > 0) {
            uint256 equity = _getVaultEquity(vaultId);
            if (fee < equity) {
                perpVault.internalTransfer(_vaultAccount(vaultId), v.manager, fee);
                emit PerformanceFeeCollected(vaultId, fee);
            }
        }

        // Update HWM
        v.highWaterMark = equityPerShare;
    }

    /// @notice Check if vault has breached max drawdown, auto-pause if so
    function _checkDrawdown(bytes32 vaultId) internal {
        Vault storage v = vaults[vaultId];
        if (v.totalShares == 0) return;

        uint256 equityPerShare = _equityPerShare(vaultId);
        uint256 maxDrop = (v.highWaterMark * v.maxDrawdownBps) / BPS;
        uint256 threshold = v.highWaterMark > maxDrop ? v.highWaterMark - maxDrop : 0;

        if (equityPerShare < threshold) {
            v.paused = true;
            emit VaultPauseChanged(vaultId, true);
            revert MaxDrawdownBreached(_getVaultEquity(vaultId), v.highWaterMark);
        }
    }

    // ============================================================
    //                    INTERNAL
    // ============================================================

    /// @notice Deterministic account address for a vault in PerpVault
    /// @dev Maps vaultId to a unique address for balance tracking
    function _vaultAccount(bytes32 vaultId) internal pure returns (address) {
        return address(uint160(uint256(vaultId)));
    }

    /// @notice Get total equity of a vault (free balance + unrealized PnL)
    /// @dev In a full implementation, this would query PerpEngine for all
    ///      vault positions' unrealized PnL. Simplified here to free balance.
    function _getVaultEquity(bytes32 vaultId) internal view returns (uint256) {
        // Free USDC balance in vault's PerpVault account
        uint256 freeBalance = perpVault.balances(_vaultAccount(vaultId));
        // TODO: Add unrealized PnL from PerpEngine positions
        // In production: equity = freeBalance + sum(margin + unrealizedPnl) for all positions
        return freeBalance;
    }

    /// @notice Equity per share (6 decimals, like USDC)
    function _equityPerShare(bytes32 vaultId) internal view returns (uint256) {
        Vault storage v = vaults[vaultId];
        if (v.totalShares == 0) return PRICE_PRECISION; // $1 per share default
        uint256 equity = _getVaultEquity(vaultId);
        return (equity * SHARE_PRECISION) / v.totalShares;
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /// @notice Get vault details
    function getVaultInfo(bytes32 vaultId) external view vaultExists(vaultId) returns (
        string memory name,
        string memory description,
        address manager,
        bool isPaused,
        uint256 totalShares,
        uint256 totalEquity,
        uint256 equityPerShare,
        uint256 performanceFeeBps,
        uint256 managementFeeBps,
        uint256 depositorCount,
        uint256 createdAt
    ) {
        Vault storage v = vaults[vaultId];
        name = v.name;
        description = v.description;
        manager = v.manager;
        isPaused = v.paused;
        totalShares = v.totalShares;
        totalEquity = _getVaultEquity(vaultId);
        equityPerShare = _equityPerShare(vaultId);
        performanceFeeBps = v.performanceFeeBps;
        managementFeeBps = v.managementFeeBps;
        depositorCount = 0; // would need a counter in production
        createdAt = v.createdAt;
    }

    /// @notice Get depositor's position in a vault
    function getDepositorInfo(bytes32 vaultId, address depositor) external view returns (
        uint256 shares,
        uint256 usdcValue,
        uint256 depositTimestamp,
        uint256 totalDeposited,
        uint256 totalWithdrawn,
        int256 pnl
    ) {
        Depositor storage d = depositors[vaultId][depositor];
        shares = d.shares;
        uint256 equity = _getVaultEquity(vaultId);
        Vault storage v = vaults[vaultId];
        usdcValue = v.totalShares > 0 ? (d.shares * equity) / v.totalShares : 0;
        depositTimestamp = d.depositTimestamp;
        totalDeposited = d.totalDeposited;
        totalWithdrawn = d.totalWithdrawn;
        pnl = int256(usdcValue + d.totalWithdrawn) - int256(d.totalDeposited);
    }

    /// @notice Get total number of vaults
    function vaultCount() external view returns (uint256) {
        return vaultIds.length;
    }

    /// @notice Get vault ID by index
    function getVaultId(uint256 index) external view returns (bytes32) {
        return vaultIds[index];
    }

    // ============================================================
    //                    ADMIN
    // ============================================================

    /// @notice Manager can unpause a vault that was auto-paused by drawdown
    function unpauseVault(bytes32 vaultId) external onlyManager(vaultId) {
        vaults[vaultId].paused = false;
        emit VaultPauseChanged(vaultId, false);
    }

    /// @notice Protocol owner can force-pause any vault (emergency)
    function emergencyPause(bytes32 vaultId) external onlyOwner {
        vaults[vaultId].paused = true;
        emit VaultPauseChanged(vaultId, true);
    }

    function setOperator(address op, bool status) external onlyOwner {
        operators[op] = status;
    }
}
