### PerpVault
- `CollateralCredited(indexed address trader, uint256 amount)`
- `CollateralDebited(indexed address trader, uint256 amount)`
- `Deposit(indexed address account, uint256 amount, uint256 newBalance)`
- `DepositCapUpdated(uint256 oldCap, uint256 newCap)`
- `InternalTransfer(indexed address from, indexed address to, uint256 amount, indexed address operator)`
- `MaxOperatorTransferUpdated(uint256 oldMax, uint256 newMax)`
- `MaxWithdrawalUpdated(uint256 oldMax, uint256 newMax)`
- `OperatorUpdated(indexed address operator, bool status)`
- `OwnershipTransferStarted(indexed address currentOwner, indexed address pendingOwner)`
- `OwnershipTransferred(indexed address previousOwner, indexed address newOwner)`
- `PauseStatusChanged(bool isPaused)`
- `Withdraw(indexed address account, uint256 amount, uint256 newBalance)`

### PerpEngine
- `CircuitBreakerParamsUpdated(uint256 windowSecs, uint256 thresholdBps, uint256 cooldownSecs)`
- `CircuitBreakerReset(uint256 timestamp)`
- `CircuitBreakerTriggered(indexed bytes32 marketId, uint256 liquidatedNotional, uint256 openInterestNotional, uint256 timestamp)`
- `ExposureLimitUpdated(uint256 newLimitBps)`
- `FeeRecipientUpdated(indexed address oldRecipient, indexed address newRecipient)`
- `FundingApplied(indexed bytes32 marketId, indexed address trader, int256 fundingPayment)`
- `FundingPoolUpdated(indexed address oldPool, indexed address newPool)`
- `FundingRateUpdated(indexed bytes32 marketId, int256 fundingRate, int256 cumulativeFunding, uint256 timestamp)`
- `InsuranceFundUpdated(indexed address oldFund, indexed address newFund)`
- `MarginAdded(indexed bytes32 marketId, indexed address trader, uint256 amount)`
- `MarginModeChanged(indexed address trader, uint8 newMode)`
- `MarginRemoved(indexed bytes32 marketId, indexed address trader, uint256 amount)`
- `MarginTiersUpdated(indexed bytes32 marketId, uint256 tierCount)`
- `MarkPriceUpdated(indexed bytes32 marketId, uint256 oldPrice, uint256 newPrice, uint256 timestamp)`
- `MarketActiveChanged(indexed bytes32 marketId, bool active)`
- `MarketAdded(indexed bytes32 marketId, string name, uint256 initialMarginBps, uint256 maintenanceMarginBps)`
- `MaxPriceAgeUpdated(uint256 oldAge, uint256 newAge)`
- `OiCapUpdated(indexed bytes32 marketId, uint256 newCap)`
- `OiSkewCapUpdated(uint256 newCapBps)`
- `OperatorUpdated(indexed address operator, bool status)`
- `OwnershipTransferStarted(indexed address currentOwner, indexed address pendingOwner)`
- `OwnershipTransferred(indexed address previousOwner, indexed address newOwner)`
- `PauseStatusChanged(bool isPaused)`
- `PositionClosed(indexed bytes32 marketId, indexed address trader, int256 closedSize, uint256 exitPrice, int256 realizedPnl)`
- `PositionLiquidated(indexed bytes32 marketId, indexed address trader, indexed address keeper, int256 size, uint256 markPrice, int256 pnl, uint256 remainingMargin, uint256 keeperReward, uint256 insurancePayout, int256 badDebt)`
- `PositionModified(indexed bytes32 marketId, indexed address trader, int256 oldSize, int256 newSize, uint256 newEntryPrice, uint256 newMargin, int256 realizedPnl)`
- `PositionOpened(indexed bytes32 marketId, indexed address trader, int256 size, uint256 entryPrice, uint256 margin)`
- `PriceImpactApplied(indexed bytes32 marketId, indexed address trader, uint256 impactUsdc, bool worsensSkew)`
- `PriceImpactParamsUpdated(indexed bytes32 marketId, uint256 impactExponentBps, uint256 impactFactorBps)`
- `ReserveFactorUpdated(uint256 newFactorBps)`

### OrderSettlement
- `BatchSettled(indexed uint256 batchId, uint256 tradesCount, uint256 timestamp)`
- `DynamicSpreadApplied(indexed bytes32 marketId, indexed address trader, uint256 extraFeeBps, uint256 skewRatioBps)`
- `DynamicSpreadTiersUpdated(uint32 tier1, uint32 tier2, uint32 tier3)`
- `DynamicSpreadUpdated(bool enabled)`
- `FeeRecipientUpdated(indexed address oldRecipient, indexed address newRecipient)`
- `FeesUpdated(uint32 makerFeeBps, uint32 takerFeeBps)`
- `OperatorUpdated(indexed address operator, bool status)`
- `OwnershipTransferStarted(indexed address currentOwner, indexed address pendingOwner)`
- `OwnershipTransferred(indexed address previousOwner, indexed address newOwner)`
- `PauseStatusChanged(bool isPaused)`
- `TimeLockUpdated(uint256 newMinDelaySeconds)`
- `TradeSettled(indexed bytes32 marketId, indexed address maker, indexed address taker, uint256 price, uint256 size, bool takerIsLong, uint256 makerFee, uint256 takerFee, uint256 timestamp)`

### Liquidator
- `LiquidationExecuted(indexed bytes32 marketId, indexed address trader, indexed address keeper, uint256 timestamp)`
- `LiquidationFailed(indexed bytes32 marketId, indexed address trader, string reason)`
- `OwnershipTransferStarted(indexed address currentOwner, indexed address pendingOwner)`
- `OwnershipTransferred(indexed address oldOwner, indexed address newOwner)`
- `PauseStatusChanged(bool isPaused)`

### OracleRouter
- `DeviationWarning(indexed bytes32 marketId, uint256 pythPrice, uint256 chainlinkPrice, uint256 deviationBps)`
- `FeedConfigured(indexed bytes32 marketId, bytes32 pythFeedId, address chainlinkFeed)`
- `OperatorUpdated(indexed address operator, bool status)`
- `OracleCircuitBreakerReset(uint256 timestamp)`
- `OracleCircuitBreakerTriggered(indexed bytes32 marketId, uint256 oldPrice, uint256 newPrice, uint256 changeBps, uint256 timestamp)`
- `OwnershipTransferStarted(indexed address currentOwner, indexed address pendingOwner)`
- `OwnershipTransferred(indexed address oldOwner, indexed address newOwner)`
- `PriceUpdated(indexed bytes32 marketId, uint256 markPrice, uint256 indexPrice, uint8 source, uint256 timestamp)`
- `PythUpdateSubmitted(uint256 fee, uint256 timestamp)`
- `SequencerFeedUpdated(address feed, uint256 gracePeriod)`

### SurTimelock
- `DelayUpdated(uint256 oldDelay, uint256 newDelay)`
- `EmergencyPause(indexed address guardian, indexed address target)`
- `GuardianUpdated(indexed address oldGuardian, indexed address newGuardian)`
- `OwnershipTransferred(indexed address oldOwner, indexed address newOwner)`
- `SetupCompleted()`
- `TxCancelled(indexed bytes32 txHash)`
- `TxExecuted(indexed bytes32 txHash, indexed address target, uint256 value, bytes data)`
- `TxQueued(indexed bytes32 txHash, indexed address target, uint256 value, bytes data, uint256 eta)`

