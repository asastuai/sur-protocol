// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {IERC20} from "./interfaces/IERC20.sol";

/// @title SUR Protocol - PerpVault
/// @author SUR Protocol Team
/// @notice Custodial vault for USDC collateral. All user funds live here.
/// @dev Phase 0: Deposits, withdrawals, operator-based transfers for settlement.
///      The vault ONLY holds balances. Position logic lives in PerpEngine (Phase 1).
///
///      Security model:
///      - Owner: multisig, can set operators and pause
///      - Operators: settlement contracts that can transfer between accounts
///      - Users: deposit/withdraw their own funds freely (when not paused)
///
///      Balance model (Phase 0):
///      - balance: available USDC that can be withdrawn or used as margin
///      - Future phases add: lockedMargin, unrealizedPnl

contract PerpVault {
    // ============================================================
    //                          ERRORS
    // ============================================================

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 requested, uint256 available);
    error TransferFailed();
    error NotOwner();
    error NotOperator();
    error Paused();
    error NotPaused();
    error Reentrancy();
    error DepositCapExceeded(uint256 attempted, uint256 cap);
    error WithdrawalTooLarge(uint256 requested, uint256 maxWithdrawal);

    // ============================================================
    //                          EVENTS
    // ============================================================

    /// @notice Emitted when a user deposits USDC into the vault
    event Deposit(address indexed account, uint256 amount, uint256 newBalance);

    /// @notice Emitted when a user withdraws USDC from the vault
    event Withdraw(address indexed account, uint256 amount, uint256 newBalance);

    /// @notice Emitted when an operator transfers balance between accounts (settlement)
    event InternalTransfer(
        address indexed from,
        address indexed to,
        uint256 amount,
        address indexed operator
    );

    /// @notice Emitted when an operator is added or removed
    event OperatorUpdated(address indexed operator, bool status);

    /// @notice Emitted when the vault is paused or unpaused
    event PauseStatusChanged(bool isPaused);

    /// @notice Emitted when ownership is transferred
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /// @notice Emitted when pending owner is set (two-step transfer)
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);

    /// @notice Emitted when deposit cap is updated
    event DepositCapUpdated(uint256 oldCap, uint256 newCap);

    /// @notice Emitted when max withdrawal per tx is updated
    event MaxWithdrawalUpdated(uint256 oldMax, uint256 newMax);

    // ============================================================
    //                          STATE
    // ============================================================

    /// @notice The USDC token contract
    IERC20 public immutable usdc;

    /// @notice USDC decimals (cached for gas efficiency)
    uint8 public immutable usdcDecimals;

    /// @notice Contract owner (multisig in production)
    address public owner;

    /// @notice Pending owner for two-step transfer
    address public pendingOwner;

    /// @notice Whether the vault is paused
    bool public paused;

    /// @notice Reentrancy lock
    uint256 private _locked = 1;

    /// @notice Maximum total deposits allowed (0 = unlimited)
    /// @dev Safety cap for gradual launch. Set to 0 to remove cap.
    uint256 public depositCap;

    /// @notice Maximum withdrawal per transaction (0 = unlimited)
    /// @dev Safety limit to slow down potential exploits
    uint256 public maxWithdrawalPerTx;

    /// @notice Total USDC deposited across all accounts
    uint256 public totalDeposits;

    /// @notice Total collateral credits (from yield-bearing deposits via CollateralManager)
    uint256 public totalCollateralCredits;

    /// @notice USDC balance per account
    mapping(address => uint256) public balances;

    /// @notice Approved operators (settlement contracts)
    mapping(address => bool) public operators;

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

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_locked == 2) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    /// @param _usdc Address of the USDC token on this chain
    /// @param _owner Initial owner (should be a multisig in production)
    /// @param _depositCap Initial deposit cap in USDC units (0 = unlimited)
    constructor(address _usdc, address _owner, uint256 _depositCap) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        usdcDecimals = IERC20(_usdc).decimals();
        owner = _owner;
        depositCap = _depositCap;

        emit OwnershipTransferred(address(0), _owner);
        if (_depositCap > 0) {
            emit DepositCapUpdated(0, _depositCap);
        }
    }

    // ============================================================
    //                     USER FUNCTIONS
    // ============================================================

    /// @notice Deposit USDC into the vault
    /// @param amount Amount of USDC to deposit (in USDC units, 6 decimals)
    /// @dev Requires prior approval of USDC to this contract
    function deposit(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Check deposit cap
        if (depositCap > 0 && totalDeposits + amount > depositCap) {
            revert DepositCapExceeded(totalDeposits + amount, depositCap);
        }

        // Transfer USDC from user to vault
        bool success = usdc.transferFrom(msg.sender, address(this), amount);
        if (!success) revert TransferFailed();

        // Update state
        balances[msg.sender] += amount;
        totalDeposits += amount;

        emit Deposit(msg.sender, amount, balances[msg.sender]);
    }

    /// @notice Withdraw USDC from the vault
    /// @param amount Amount of USDC to withdraw (in USDC units, 6 decimals)
    /// @dev In future phases, will check that sufficient margin remains for open positions
    function withdraw(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 bal = balances[msg.sender];
        if (amount > bal) {
            revert InsufficientBalance(amount, bal);
        }

        // Check max withdrawal per tx
        if (maxWithdrawalPerTx > 0 && amount > maxWithdrawalPerTx) {
            revert WithdrawalTooLarge(amount, maxWithdrawalPerTx);
        }

        // Update state BEFORE transfer (checks-effects-interactions)
        balances[msg.sender] = bal - amount;
        totalDeposits -= amount;

        // Transfer USDC from vault to user
        bool success = usdc.transfer(msg.sender, amount);
        if (!success) revert TransferFailed();

        emit Withdraw(msg.sender, amount, balances[msg.sender]);
    }

    /// @notice Get the available balance for an account
    /// @param account The account to query
    /// @return The available USDC balance
    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }

    // ============================================================
    //                   OPERATOR FUNCTIONS
    // ============================================================

    /// @notice Transfer balance between two accounts (used for trade settlement)
    /// @param from Account to debit
    /// @param to Account to credit
    /// @param amount Amount of USDC to transfer internally
    /// @dev Only callable by approved operators (settlement contracts).
    ///      No actual USDC movement - just balance accounting within the vault.
    function internalTransfer(address from, address to, uint256 amount)
        external
        onlyOperator
        whenNotPaused
    {
        if (amount == 0) revert ZeroAmount();
        if (from == address(0) || to == address(0)) revert ZeroAddress();

        uint256 fromBal = balances[from];
        if (amount > fromBal) {
            revert InsufficientBalance(amount, fromBal);
        }

        balances[from] = fromBal - amount;
        balances[to] += amount;

        emit InternalTransfer(from, to, amount, msg.sender);
    }

    /// @notice Batch internal transfers for gas-efficient settlement
    /// @param froms Array of accounts to debit
    /// @param tos Array of accounts to credit
    /// @param amounts Array of amounts to transfer
    /// @dev Arrays must have equal length. Reverts entirely if any single transfer fails.
    function batchInternalTransfer(
        address[] calldata froms,
        address[] calldata tos,
        uint256[] calldata amounts
    ) external onlyOperator whenNotPaused {
        uint256 len = froms.length;
        require(len == tos.length && len == amounts.length, "Array length mismatch");

        for (uint256 i = 0; i < len;) {
            uint256 amount = amounts[i];
            address from = froms[i];
            address to = tos[i];

            if (amount == 0) revert ZeroAmount();
            if (from == address(0) || to == address(0)) revert ZeroAddress();

            uint256 fromBal = balances[from];
            if (amount > fromBal) {
                revert InsufficientBalance(amount, fromBal);
            }

            balances[from] = fromBal - amount;
            balances[to] += amount;

            emit InternalTransfer(from, to, amount, msg.sender);

            unchecked { ++i; }
        }
    }

    // ============================================================
    //               COLLATERAL MANAGEMENT
    // ============================================================

    event CollateralCredited(address indexed trader, uint256 amount);
    event CollateralDebited(address indexed trader, uint256 amount);

    /// @notice Credit USDC-equivalent balance for yield-bearing collateral deposits
    /// @dev Only callable by operators (CollateralManager). No actual USDC transfer —
    ///      the collateral backing lives in CollateralManager.
    function creditCollateral(address trader, uint256 usdcAmount)
        external onlyOperator whenNotPaused
    {
        if (usdcAmount == 0) revert ZeroAmount();
        if (trader == address(0)) revert ZeroAddress();

        balances[trader] += usdcAmount;
        totalCollateralCredits += usdcAmount;

        emit CollateralCredited(trader, usdcAmount);
    }

    /// @notice Debit USDC-equivalent balance when withdrawing yield-bearing collateral
    /// @dev Only callable by operators (CollateralManager).
    function debitCollateral(address trader, uint256 usdcAmount)
        external onlyOperator whenNotPaused
    {
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 bal = balances[trader];
        if (usdcAmount > bal) {
            revert InsufficientBalance(usdcAmount, bal);
        }

        balances[trader] = bal - usdcAmount;
        totalCollateralCredits -= usdcAmount;

        emit CollateralDebited(trader, usdcAmount);
    }

    // ============================================================
    //                     ADMIN FUNCTIONS
    // ============================================================

    /// @notice Add or remove an operator
    /// @param operator Address of the operator (settlement contract)
    /// @param status True to add, false to remove
    function setOperator(address operator, bool status) external onlyOwner {
        if (operator == address(0)) revert ZeroAddress();
        operators[operator] = status;
        emit OperatorUpdated(operator, status);
    }

    /// @notice Pause the vault (emergency)
    function pause() external onlyOwner {
        if (paused) revert Paused();
        paused = true;
        emit PauseStatusChanged(true);
    }

    /// @notice Unpause the vault
    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        paused = false;
        emit PauseStatusChanged(false);
    }

    /// @notice Update the deposit cap
    /// @param newCap New deposit cap (0 = unlimited)
    function setDepositCap(uint256 newCap) external onlyOwner {
        uint256 oldCap = depositCap;
        depositCap = newCap;
        emit DepositCapUpdated(oldCap, newCap);
    }

    /// @notice Update max withdrawal per transaction
    /// @param newMax New max withdrawal (0 = unlimited)
    function setMaxWithdrawalPerTx(uint256 newMax) external onlyOwner {
        uint256 oldMax = maxWithdrawalPerTx;
        maxWithdrawalPerTx = newMax;
        emit MaxWithdrawalUpdated(oldMax, newMax);
    }

    /// @notice Start ownership transfer (two-step)
    /// @param newOwner Address of the new owner
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Accept ownership (must be called by pending owner)
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        address oldOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /// @notice Get the actual USDC balance held by this contract
    /// @dev Should always equal totalDeposits. If not, something is wrong.
    function vaultBalance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Health check: verify vault accounting matches actual USDC held
    /// @return isHealthy True if accounting is consistent
    /// @return actualBalance The real USDC balance of the contract
    /// @return accountedBalance The sum tracked by totalDeposits
    /// @dev Note: collateral credits are backed by yield-bearing tokens in CollateralManager,
    ///      NOT by USDC in this vault. So accountedBalance excludes collateral credits.
    function healthCheck()
        external
        view
        returns (bool isHealthy, uint256 actualBalance, uint256 accountedBalance)
    {
        actualBalance = usdc.balanceOf(address(this));
        accountedBalance = totalDeposits;
        // Actual USDC must cover at least the USDC deposits.
        // Collateral credits are backed by yield tokens in CollateralManager.
        isHealthy = actualBalance >= accountedBalance;
    }
}
