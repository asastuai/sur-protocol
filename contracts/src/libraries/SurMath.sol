// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @title SurMath - Fixed-point math library for SUR Protocol
/// @notice All internal calculations use 18-decimal precision (WAD).
///         Prices and USDC amounts are 6-decimal externally.
library SurMath {
    /// @notice 1.0 in 18-decimal fixed point
    uint256 internal constant WAD = 1e18;

    /// @notice 1.0 in 6-decimal (USDC precision)
    uint256 internal constant USDC_UNIT = 1e6;

    /// @notice Scale factor from 6-decimal to 18-decimal
    uint256 internal constant SCALE_FACTOR = 1e12; // 1e18 / 1e6

    /// @notice Basis point denominator (10,000 = 100%)
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Multiply two WAD numbers: (a * b) / WAD
    function wadMul(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a * b) / WAD;
    }

    /// @notice Divide two WAD numbers: (a * WAD) / b
    function wadDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        require(b > 0, "SurMath: div by zero");
        return (a * WAD) / b;
    }

    /// @notice Signed multiply: (a * b) / WAD
    function wadMulSigned(int256 a, int256 b) internal pure returns (int256) {
        return (a * b) / int256(WAD);
    }

    /// @notice Convert 6-decimal price/amount to 18-decimal WAD
    function toWad(uint256 value6dec) internal pure returns (uint256) {
        return value6dec * SCALE_FACTOR;
    }

    /// @notice Convert 18-decimal WAD to 6-decimal (truncates)
    function fromWad(uint256 wadValue) internal pure returns (uint256) {
        return wadValue / SCALE_FACTOR;
    }

    /// @notice Convert signed WAD to signed 6-decimal
    function fromWadSigned(int256 wadValue) internal pure returns (int256) {
        return wadValue / int256(SCALE_FACTOR);
    }

    /// @notice Absolute value of int256
    function abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /// @notice Calculate basis points: (amount * bps) / 10000
    function bps(uint256 amount, uint256 basisPoints) internal pure returns (uint256) {
        return (amount * basisPoints) / BPS_DENOMINATOR;
    }

    /// @notice Safe cast uint256 to int256
    function toInt256(uint256 x) internal pure returns (int256) {
        require(x <= uint256(type(int256).max), "SurMath: overflow");
        return int256(x);
    }

    /// @notice Safe cast int256 to uint256 (must be non-negative)
    function toUint256(int256 x) internal pure returns (uint256) {
        require(x >= 0, "SurMath: negative");
        return uint256(x);
    }
}
