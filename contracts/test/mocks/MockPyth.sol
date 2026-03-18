// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PythPrice} from "../../src/interfaces/IPyth.sol";

/// @title MockPyth - Simulated Pyth oracle for testing
contract MockPyth {
    mapping(bytes32 => PythPrice) public prices;
    uint256 public updateFee = 1; // 1 wei

    function setPrice(
        bytes32 feedId,
        int64 price,
        uint64 conf,
        int32 expo,
        uint256 publishTime
    ) external {
        prices[feedId] = PythPrice({
            price: price,
            conf: conf,
            expo: expo,
            publishTime: publishTime
        });
    }

    function getPriceNoOlderThan(bytes32 id, uint256 age)
        external
        view
        returns (PythPrice memory)
    {
        PythPrice memory p = prices[id];
        require(p.publishTime > 0, "Price not set");
        require(block.timestamp - p.publishTime <= age, "Price too stale");
        return p;
    }

    function getPriceUnsafe(bytes32 id)
        external
        view
        returns (PythPrice memory)
    {
        return prices[id];
    }

    function updatePriceFeeds(bytes[] calldata) external payable {
        // No-op in mock - prices set directly via setPrice()
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return updateFee;
    }

    function setUpdateFee(uint256 fee) external {
        updateFee = fee;
    }
}
