// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title SUR Protocol - Timelock Controller
/// @author SUR Protocol Team
/// @notice Enforces a time delay on all admin operations except emergency pause.
/// @dev Deploy this contract, then transfer ownership of ALL protocol contracts to it.
///      The Timelock owner should be a Gnosis Safe multisig.
///
///      Flow: Multisig → queue tx on Timelock → wait delay → execute tx on target contract
///      Exception: pause() can be called immediately by the guardian (for emergencies)
///
///      Architecture:
///      - owner: Gnosis Safe multisig (queues and executes after delay)
///      - guardian: Can ONLY call pause() on target contracts (no other powers)
///      - minDelay: Minimum time between queue and execution (48h default)

contract SurTimelock {
    // ============================================================
    //                          ERRORS
    // ============================================================

    error NotOwner();
    error NotGuardian();
    error NotOwnerOrGuardian();
    error ZeroAddress();
    error TxNotQueued();
    error TxAlreadyQueued();
    error TxNotReady(uint256 readyAt, uint256 currentTime);
    error TxExpired(uint256 expiredAt);
    error TxExecutionFailed(bytes returnData);
    error DelayTooShort(uint256 provided, uint256 minimum);
    error DelayTooLong(uint256 provided, uint256 maximum);
    error GracePeriodTooShort();
    error InvalidPauseTarget();

    // ============================================================
    //                          EVENTS
    // ============================================================

    event TxQueued(
        bytes32 indexed txHash,
        address indexed target,
        uint256 value,
        bytes data,
        uint256 eta
    );

    event TxExecuted(
        bytes32 indexed txHash,
        address indexed target,
        uint256 value,
        bytes data
    );

    event TxCancelled(bytes32 indexed txHash);

    event DelayUpdated(uint256 oldDelay, uint256 newDelay);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event GuardianUpdated(address indexed oldGuardian, address indexed newGuardian);
    event EmergencyPause(address indexed guardian, address indexed target);
    event SetupCompleted();

    // ============================================================
    //                        CONSTANTS
    // ============================================================

    /// @notice Minimum allowed delay (24 hours)
    uint256 public constant MIN_DELAY = 24 hours;

    /// @notice Maximum allowed delay (30 days)
    uint256 public constant MAX_DELAY = 30 days;

    /// @notice Grace period after ETA before tx expires (7 days)
    uint256 public constant GRACE_PERIOD = 7 days;

    /// @notice pause() function selector
    bytes4 private constant PAUSE_SELECTOR = bytes4(keccak256("pause()"));

    // ============================================================
    //                          STATE
    // ============================================================

    /// @notice Owner (should be a Gnosis Safe multisig)
    address public owner;

    /// @notice Guardian - can ONLY trigger emergency pause on targets
    address public guardian;

    /// @notice Current delay for queued transactions
    uint256 public delay;

    /// @notice Queued transactions: txHash => ready timestamp (ETA)
    mapping(bytes32 => uint256) public queuedTxs;

    /// @notice Registered pausable targets (contracts that have pause())
    mapping(address => bool) public pausableTargets;

    /// @notice H-16 fix: Once true, batchSetPausableTargets is permanently disabled
    bool public setupComplete;

    // ============================================================
    //                        MODIFIERS
    // ============================================================

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    // ============================================================
    //                       CONSTRUCTOR
    // ============================================================

    /// @param _owner Initial owner (should be Gnosis Safe multisig)
    /// @param _guardian Emergency pause guardian (can be a hot wallet for fast response)
    /// @param _delay Initial delay in seconds (must be >= 24h, default 48h)
    constructor(address _owner, address _guardian, uint256 _delay) {
        if (_owner == address(0)) revert ZeroAddress();
        if (_guardian == address(0)) revert ZeroAddress();
        if (_delay < MIN_DELAY) revert DelayTooShort(_delay, MIN_DELAY);
        if (_delay > MAX_DELAY) revert DelayTooLong(_delay, MAX_DELAY);

        owner = _owner;
        guardian = _guardian;
        delay = _delay;

        emit OwnershipTransferred(address(0), _owner);
        emit GuardianUpdated(address(0), _guardian);
    }

    // ============================================================
    //                   GUARDIAN FUNCTIONS
    // ============================================================

    /// @notice Emergency pause a target contract (NO delay required)
    /// @param target Address of the contract to pause
    /// @dev Guardian can ONLY call pause(). Cannot unpause, change settings, etc.
    ///      This is the emergency brake that doesn't need multisig consensus.
    function emergencyPause(address target) external onlyGuardian {
        if (!pausableTargets[target]) revert InvalidPauseTarget();

        (bool success, bytes memory returnData) = target.call(
            abi.encodeWithSelector(PAUSE_SELECTOR)
        );
        if (!success) revert TxExecutionFailed(returnData);

        emit EmergencyPause(msg.sender, target);
    }

    // ============================================================
    //                    OWNER FUNCTIONS
    // ============================================================

    /// @notice Queue a transaction for future execution
    /// @param target Contract to call
    /// @param value ETH to send (usually 0)
    /// @param data Encoded function call
    /// @return txHash The hash identifying this queued transaction
    function queueTransaction(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyOwner returns (bytes32 txHash) {
        uint256 eta = block.timestamp + delay;
        txHash = _getTxHash(target, value, data, eta);

        if (queuedTxs[txHash] != 0) revert TxAlreadyQueued();

        queuedTxs[txHash] = eta;

        emit TxQueued(txHash, target, value, data, eta);
    }

    /// @notice Execute a previously queued transaction after the delay
    /// @param target Contract to call
    /// @param value ETH to send
    /// @param data Encoded function call
    /// @param eta The ETA that was set when queuing
    function executeTransaction(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 eta
    ) external onlyOwner returns (bytes memory) {
        bytes32 txHash = _getTxHash(target, value, data, eta);

        if (queuedTxs[txHash] == 0) revert TxNotQueued();
        if (block.timestamp < eta) revert TxNotReady(eta, block.timestamp);
        if (block.timestamp > eta + GRACE_PERIOD) revert TxExpired(eta + GRACE_PERIOD);

        // Clear from queue before execution (prevents reentrancy)
        delete queuedTxs[txHash];

        (bool success, bytes memory returnData) = target.call{value: value}(data);
        if (!success) revert TxExecutionFailed(returnData);

        emit TxExecuted(txHash, target, value, data);
        return returnData;
    }

    /// @notice Cancel a queued transaction
    /// @param target Contract address
    /// @param value ETH value
    /// @param data Encoded function call
    /// @param eta The ETA from when it was queued
    function cancelTransaction(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 eta
    ) external onlyOwner {
        bytes32 txHash = _getTxHash(target, value, data, eta);
        if (queuedTxs[txHash] == 0) revert TxNotQueued();

        delete queuedTxs[txHash];

        emit TxCancelled(txHash);
    }

    // ============================================================
    //                  ADMIN (SELF-GOVERNING)
    // ============================================================
    // These functions modify the Timelock itself. They MUST also go
    // through the queue/execute flow (called via executeTransaction
    // with target = address(this)).

    /// @notice Update the delay period
    /// @dev Can only be called by the Timelock itself (via executeTransaction)
    function setDelay(uint256 newDelay) external {
        if (msg.sender != address(this)) revert NotOwner();
        if (newDelay < MIN_DELAY) revert DelayTooShort(newDelay, MIN_DELAY);
        if (newDelay > MAX_DELAY) revert DelayTooLong(newDelay, MAX_DELAY);

        uint256 oldDelay = delay;
        delay = newDelay;

        emit DelayUpdated(oldDelay, newDelay);
    }

    /// @notice Transfer ownership of the Timelock
    /// @dev Can only be called by the Timelock itself (via executeTransaction)
    function transferOwnership(address newOwner) external {
        if (msg.sender != address(this)) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();

        address oldOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(oldOwner, newOwner);
    }

    /// @notice Update the guardian address
    /// @dev Can only be called by the Timelock itself (via executeTransaction)
    function setGuardian(address newGuardian) external {
        if (msg.sender != address(this)) revert NotOwner();
        if (newGuardian == address(0)) revert ZeroAddress();

        address oldGuardian = guardian;
        guardian = newGuardian;

        emit GuardianUpdated(oldGuardian, newGuardian);
    }

    /// @notice Register a contract as a valid pause target for the guardian
    /// @dev Can only be called by the Timelock itself (via executeTransaction)
    function setPausableTarget(address target, bool status) external {
        if (msg.sender != address(this)) revert NotOwner();
        if (target == address(0)) revert ZeroAddress();

        pausableTargets[target] = status;
    }

    // ============================================================
    //                    SETUP (ONE-TIME)
    // ============================================================

    /// @notice Batch register pausable targets during initial setup
    /// @dev Only callable by owner. Use this right after deployment to register
    ///      all protocol contracts. After setup, use setPausableTarget via timelock.
    error SetupAlreadyComplete();

    /// @dev H-16 fix: disabled after completeSetup() is called
    function batchSetPausableTargets(address[] calldata targets) external onlyOwner {
        if (setupComplete) revert SetupAlreadyComplete();
        for (uint256 i = 0; i < targets.length;) {
            if (targets[i] == address(0)) revert ZeroAddress();
            pausableTargets[targets[i]] = true;
            unchecked { ++i; }
        }
    }

    /// @notice H-16 fix: Permanently disable batchSetPausableTargets
    /// @dev Call this after initial setup. Future target changes must go through timelock.
    function completeSetup() external onlyOwner {
        setupComplete = true;
        emit SetupCompleted();
    }

    // ============================================================
    //                      VIEW FUNCTIONS
    // ============================================================

    /// @notice Check if a transaction is queued and return its ETA
    function getTxEta(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 eta
    ) external view returns (bool isQueued, uint256 readyAt, uint256 expiresAt) {
        bytes32 txHash = _getTxHash(target, value, data, eta);
        uint256 storedEta = queuedTxs[txHash];

        isQueued = storedEta != 0;
        readyAt = storedEta;
        expiresAt = storedEta + GRACE_PERIOD;
    }

    // ============================================================
    //                    INTERNAL FUNCTIONS
    // ============================================================

    function _getTxHash(
        address target,
        uint256 value,
        bytes calldata data,
        uint256 eta
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, eta));
    }

    /// @notice Accept ETH (needed for value transfers)
    receive() external payable {}
}
