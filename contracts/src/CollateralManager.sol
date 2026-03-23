// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";
import {IPerpVault} from "./interfaces/ISurInterfaces.sol";

/// @title SUR Protocol - CollateralManager
/// @author SUR Protocol Team
/// @notice Accepts yield-bearing tokens as margin collateral.
/// @dev Traders deposit yield-bearing tokens (cbETH, wstETH, stUSDC, etc.)
///      and receive USDC-equivalent credit in PerpVault. The yield-bearing tokens
///      continue to accrue yield while locked as collateral.
///
///      Flow:
///      1. Trader deposits 10 cbETH (worth $35,000 at $3,500/cbETH)
///      2. CollateralManager applies 95% haircut → $33,250 credit
///      3. Trader gets $33,250 USDC-equivalent balance in PerpVault
///      4. cbETH stays in CollateralManager, accruing staking yield
///      5. On withdrawal, trader gets back their cbETH (with accumulated yield)
///
///      Oracle:
///      Each collateral has a Pyth/Chainlink price feed.
///      Prices are refreshed by the oracle keeper.
///
///      Haircut:
///      Each collateral has a discount factor (e.g., 9500 = 95%).
///      This protects against collateral depegging.
///      USDC has 10000 (100%) — it's the base asset.

contract CollateralManager {
    // ============================================================
    //                    ERRORS
    // ============================================================

    error NotOwner();
    error NotOperator();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error CollateralNotSupported(address token);
    error CollateralAlreadyExists(address token);
    error CollateralPaused(address token);
    error InsufficientCollateral(uint256 requested, uint256 available);
    error StalePrice(address token);

    // ============================================================
    //                    EVENTS
    // ============================================================

    event CollateralAdded(address indexed token, string symbol, uint256 haircutBps, uint8 decimals);
    event CollateralDeposited(address indexed trader, address indexed token, uint256 amount, uint256 creditedUsdc);
    event CollateralWithdrawn(address indexed trader, address indexed token, uint256 amount, uint256 debitedUsdc);
    event CollateralPriceUpdated(address indexed token, uint256 price, uint256 timestamp);
    event CollateralHaircutUpdated(address indexed token, uint256 oldHaircut, uint256 newHaircut);

    // ============================================================
    //                    STRUCTS
    // ============================================================

    struct CollateralConfig {
        address token;          // ERC20 token address
        string symbol;          // e.g., "cbETH", "wstETH", "stUSDC"
        uint8 decimals;         // token decimals (e.g., 18 for ETH derivatives, 6 for stUSDC)
        uint256 haircutBps;     // 9500 = 95%, 9000 = 90%. Lower = more conservative.
        uint256 price;          // USD price, 6 decimals (same as USDC)
        uint256 lastPriceUpdate;
        uint256 maxPriceAge;    // max seconds before price is considered stale
        bool active;
        uint256 totalDeposited; // total tokens deposited
        uint256 depositCap;     // max tokens depositable (0 = unlimited)
    }

    struct TraderCollateral {
        uint256 amount;         // tokens deposited
        uint256 creditedUsdc;   // USDC-equivalent credited to vault
    }

    // ============================================================
    //                    STATE
    // ============================================================

    address public owner;
    address public pendingOwner;
    bool public paused;
    IPerpVault public vault;

    uint256 public constant BPS = 10_000;
    uint256 public constant PRICE_PRECISION = 1e6;

    /// @dev Reentrancy guard (1 = unlocked, 2 = locked)
    uint256 private _locked = 1;

    // Supported collateral tokens
    address[] public supportedTokens;
    mapping(address => CollateralConfig) public collaterals;

    // Trader deposits: token => trader => TraderCollateral
    mapping(address => mapping(address => TraderCollateral)) public deposits;

    mapping(address => bool) public operators;

    // ============================================================
    //                    MODIFIERS
    // ============================================================

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyOperator() { if (!operators[msg.sender] && msg.sender != owner) revert NotOperator(); _; }
    modifier whenNotPaused() { if (paused) revert Paused(); _; }
    modifier nonReentrant() { require(_locked == 1, "Reentrant"); _locked = 2; _; _locked = 1; }

    // ============================================================
    //                    CONSTRUCTOR
    // ============================================================

    constructor(address _vault, address _owner) {
        if (_vault == address(0) || _owner == address(0)) revert ZeroAddress();
        vault = IPerpVault(_vault);
        owner = _owner;
    }

    // ============================================================
    //                    ADMIN
    // ============================================================

    /// @notice Add a new yield-bearing collateral type
    /// @param token ERC20 token address
    /// @param symbol Human-readable symbol
    /// @param decimals Token decimals
    /// @param haircutBps Discount factor (9500 = 95% of oracle value credited)
    /// @param initialPrice Initial USD price (6 decimals)
    /// @param maxPriceAge Max seconds before price is stale
    /// @param depositCap Max tokens depositable (0 = unlimited)
    function addCollateral(
        address token,
        string calldata symbol,
        uint8 decimals,
        uint256 haircutBps,
        uint256 initialPrice,
        uint256 maxPriceAge,
        uint256 depositCap
    ) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (collaterals[token].token != address(0)) revert CollateralAlreadyExists(token);
        require(haircutBps <= BPS, "Haircut > 100%");
        require(haircutBps >= 5000, "Haircut too aggressive");

        collaterals[token] = CollateralConfig({
            token: token,
            symbol: symbol,
            decimals: decimals,
            haircutBps: haircutBps,
            price: initialPrice,
            lastPriceUpdate: block.timestamp,
            maxPriceAge: maxPriceAge,
            active: true,
            totalDeposited: 0,
            depositCap: depositCap
        });

        supportedTokens.push(token);
        emit CollateralAdded(token, symbol, haircutBps, decimals);
    }

    function setHaircut(address token, uint256 newHaircut) external onlyOwner {
        CollateralConfig storage c = collaterals[token];
        if (c.token == address(0)) revert CollateralNotSupported(token);
        require(newHaircut <= BPS && newHaircut >= 5000, "Invalid haircut");
        uint256 old = c.haircutBps;
        c.haircutBps = newHaircut;
        emit CollateralHaircutUpdated(token, old, newHaircut);
    }

    event CollateralPauseChanged(address indexed token, bool active);

    function pauseCollateral(address token) external onlyOwner {
        if (collaterals[token].token == address(0)) revert CollateralNotSupported(token);
        collaterals[token].active = false;
        emit CollateralPauseChanged(token, false);
    }

    function unpauseCollateral(address token) external onlyOwner {
        if (collaterals[token].token == address(0)) revert CollateralNotSupported(token);
        collaterals[token].active = true;
        emit CollateralPauseChanged(token, true);
    }

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

    event OperatorUpdated(address indexed operator, bool status);
    event PauseStatusChanged(bool isPaused);

    function setOperator(address op, bool status) external onlyOwner {
        if (op == address(0)) revert ZeroAddress();
        operators[op] = status;
        emit OperatorUpdated(op, status);
    }

    function pause() external onlyOwner { paused = true; emit PauseStatusChanged(true); }
    function unpause() external onlyOwner { paused = false; emit PauseStatusChanged(false); }

    // ============================================================
    //                    ORACLE
    // ============================================================

    /// @notice Update the USD price of a collateral token
    /// @dev Called by the oracle keeper
    /// @notice H-13 fix: Max price deviation per update (10% = 1000 BPS)
    uint256 public maxPriceDeviationBps = 1000;

    error PriceDeviationTooHigh(uint256 oldPrice, uint256 newPrice, uint256 deviationBps);

    function updatePrice(address token, uint256 newPrice)
        external onlyOperator
    {
        CollateralConfig storage c = collaterals[token];
        if (c.token == address(0)) revert CollateralNotSupported(token);
        if (newPrice == 0) revert ZeroAmount();

        // H-13 fix: Bound price change per update to prevent manipulation
        if (c.price > 0 && maxPriceDeviationBps > 0) {
            uint256 diff = newPrice > c.price ? newPrice - c.price : c.price - newPrice;
            uint256 deviationBps = (diff * 10_000) / c.price;
            if (deviationBps > maxPriceDeviationBps) {
                revert PriceDeviationTooHigh(c.price, newPrice, deviationBps);
            }
        }

        c.price = newPrice;
        c.lastPriceUpdate = block.timestamp;
        emit CollateralPriceUpdated(token, newPrice, block.timestamp);
    }

    event MaxPriceDeviationUpdated(uint256 oldBps, uint256 newBps);

    function setMaxPriceDeviationBps(uint256 newBps) external onlyOwner {
        require(newBps >= 100 && newBps <= 5000, "Invalid deviation");
        uint256 old = maxPriceDeviationBps;
        maxPriceDeviationBps = newBps;
        emit MaxPriceDeviationUpdated(old, newBps);
    }

    function _requireFreshPrice(CollateralConfig storage c) internal view {
        if (block.timestamp - c.lastPriceUpdate > c.maxPriceAge) {
            revert StalePrice(c.token);
        }
    }

    // ============================================================
    //                    USER FUNCTIONS
    // ============================================================

    /// @notice Deposit yield-bearing tokens as collateral
    /// @param token The collateral token to deposit
    /// @param amount Amount of tokens to deposit (in token's native decimals)
    /// @return creditedUsdc Amount of USDC-equivalent credited to vault
    function depositCollateral(address token, uint256 amount)
        external nonReentrant whenNotPaused returns (uint256 creditedUsdc)
    {
        if (amount == 0) revert ZeroAmount();

        CollateralConfig storage c = collaterals[token];
        if (c.token == address(0)) revert CollateralNotSupported(token);
        if (!c.active) revert CollateralPaused(token);
        _requireFreshPrice(c);

        // Check deposit cap
        if (c.depositCap > 0) {
            require(c.totalDeposited + amount <= c.depositCap, "Deposit cap exceeded");
        }

        // Calculate USDC-equivalent value
        // M-20 fix: Reorder multiplication to reduce precision loss on small deposits
        creditedUsdc = (amount * c.price * c.haircutBps) / (10 ** c.decimals * BPS);
        require(creditedUsdc > 0, "Deposit too small for credit");

        // H-12 fix: CEI pattern — update state BEFORE external calls
        TraderCollateral storage tc = deposits[token][msg.sender];
        tc.amount += amount;
        tc.creditedUsdc += creditedUsdc;
        c.totalDeposited += amount;

        emit CollateralDeposited(msg.sender, token, amount, creditedUsdc);

        // External calls AFTER state updates
        bool success = IERC20(token).transferFrom(msg.sender, address(this), amount);
        require(success, "Transfer failed");

        vault.creditCollateral(msg.sender, creditedUsdc);
    }

    /// @notice Withdraw yield-bearing tokens
    /// @param token The collateral token to withdraw
    /// @param amount Amount of tokens to withdraw
    /// @dev Debits the corresponding USDC-equivalent from vault.
    ///      Will revert if trader has open positions that need the margin.
    function withdrawCollateral(address token, uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        CollateralConfig storage c = collaterals[token];
        if (c.token == address(0)) revert CollateralNotSupported(token);
        _requireFreshPrice(c);

        TraderCollateral storage tc = deposits[token][msg.sender];
        if (tc.amount < amount) {
            revert InsufficientCollateral(amount, tc.amount);
        }

        // Calculate proportional USDC to debit
        uint256 debitUsdc = (tc.creditedUsdc * amount) / tc.amount;

        // Debit from vault (will revert if insufficient free balance)
        vault.debitCollateral(msg.sender, debitUsdc);

        // Update tracking BEFORE external call (CEI pattern)
        tc.amount -= amount;
        tc.creditedUsdc -= debitUsdc;
        c.totalDeposited -= amount;

        emit CollateralWithdrawn(msg.sender, token, amount, debitUsdc);

        // Return tokens to trader (with any accumulated yield!)
        bool success = IERC20(token).transfer(msg.sender, amount);
        require(success, "Transfer failed");
    }

    // ============================================================
    //                 LIQUIDATION (C-7 FIX)
    // ============================================================

    event CollateralLiquidated(
        address indexed trader,
        address indexed token,
        uint256 tokenAmount,
        uint256 usdcDebit,
        address indexed keeper
    );

    error NotUndercollateralized(address trader, address token);

    /// @notice Liquidation threshold BPS — if currentValue / creditedUsdc < this, position is liquidatable
    /// @dev 9000 = 90%, meaning if collateral value drops to 90% of credited USDC, it can be liquidated
    uint256 public liquidationThresholdBps = 9000;

    /// @notice Liquidate undercollateralized collateral position
    /// @dev Callable by operators (keepers). Seizes collateral, debits USDC credit.
    ///      The seized collateral goes to the protocol (this contract) for later auction/sale.
    /// @param trader The trader with undercollateralized position
    /// @param token The collateral token to liquidate
    function liquidateCollateral(address trader, address token)
        external onlyOperator nonReentrant whenNotPaused
    {
        CollateralConfig storage c = collaterals[token];
        if (c.token == address(0)) revert CollateralNotSupported(token);

        TraderCollateral storage tc = deposits[token][trader];
        if (tc.amount == 0) revert InsufficientCollateral(0, 0);

        // Calculate current value with haircut
        uint256 currentValue = (tc.amount * c.price * c.haircutBps) / (10 ** c.decimals * BPS);

        // Check if undercollateralized: currentValue < creditedUsdc * liquidationThreshold
        if (currentValue * BPS >= tc.creditedUsdc * liquidationThresholdBps) {
            revert NotUndercollateralized(trader, token);
        }

        uint256 tokenAmount = tc.amount;
        uint256 usdcDebit = tc.creditedUsdc;

        // Debit the full USDC credit from vault (may use collateral balance)
        vault.debitCollateral(trader, usdcDebit);

        // Clear trader's position
        tc.amount = 0;
        tc.creditedUsdc = 0;
        c.totalDeposited -= tokenAmount;

        // Collateral tokens remain in this contract for protocol to handle
        // (auction, swap to USDC, etc. — handled off-chain or by a separate contract)

        emit CollateralLiquidated(trader, token, tokenAmount, usdcDebit, msg.sender);
    }

    /// @notice Check if a trader's collateral position is liquidatable
    function isLiquidatable(address trader, address token) external view returns (bool) {
        CollateralConfig storage c = collaterals[token];
        TraderCollateral storage tc = deposits[token][trader];
        if (tc.amount == 0) return false;

        uint256 currentValue = (tc.amount * c.price * c.haircutBps) / (10 ** c.decimals * BPS);
        return currentValue * BPS < tc.creditedUsdc * liquidationThresholdBps;
    }

    event LiquidationThresholdUpdated(uint256 oldThreshold, uint256 newThreshold);

    function setLiquidationThresholdBps(uint256 newThreshold) external onlyOwner {
        require(newThreshold >= 5000 && newThreshold <= BPS, "Invalid threshold");
        uint256 old = liquidationThresholdBps;
        liquidationThresholdBps = newThreshold;
        emit LiquidationThresholdUpdated(old, newThreshold);
    }

    // ============================================================
    //                    VIEW FUNCTIONS
    // ============================================================

    /// @notice Get the USDC value of a trader's collateral deposits
    function getCollateralValue(address trader) external view returns (uint256 totalUsdcValue) {
        for (uint256 i = 0; i < supportedTokens.length;) {
            address token = supportedTokens[i];
            TraderCollateral storage tc = deposits[token][trader];
            if (tc.amount > 0) {
                CollateralConfig storage c = collaterals[token];
                totalUsdcValue += (tc.amount * c.price * c.haircutBps) / (10 ** c.decimals * BPS);
            }
            unchecked { ++i; }
        }
    }

    /// @notice Get details of a trader's collateral deposit for a specific token
    function getTraderCollateral(address token, address trader)
        external view returns (uint256 amount, uint256 creditedUsdc, uint256 currentValue)
    {
        TraderCollateral storage tc = deposits[token][trader];
        CollateralConfig storage c = collaterals[token];
        amount = tc.amount;
        creditedUsdc = tc.creditedUsdc;
        currentValue = c.token != address(0)
            ? (tc.amount * c.price * c.haircutBps) / (10 ** c.decimals * BPS)
            : 0;
    }

    /// @notice Get number of supported collateral types
    function supportedTokenCount() external view returns (uint256) {
        return supportedTokens.length;
    }

    /// @notice Get all supported token addresses
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }
}
