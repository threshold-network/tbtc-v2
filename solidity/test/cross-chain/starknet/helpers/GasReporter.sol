// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

import {Test} from "forge-std/Test.sol";

contract GasReporter is Test {
    struct GasReport {
        string functionName;
        uint256 gasUsed;
        uint256 gasCost; // in wei at 20 gwei
        bool withinLimit;
        uint256 gasLimit;
    }

    GasReport[] public reports;
    uint256 public constant GAS_PRICE = 20 gwei;

    mapping(string => uint256) public gasLimits;

    constructor() {
        // Set gas limits for different operations
        gasLimits["constructor"] = 1_000_000;
        gasLimits["initializeDeposit"] = 200_000;
        gasLimits["finalizeDeposit"] = 300_000;
        gasLimits["_transferTbtc"] = 150_000;
        gasLimits["updateL1ToL2MessageFee"] = 50_000;
        gasLimits["quoteFinalizeDeposit"] = 30_000;
    }

    function measureGas(
        string memory functionName,
        address target,
        bytes memory callData
    ) external returns (uint256 gasUsed) {
        uint256 gasStart = gasleft();

        (bool success, ) = target.call(callData);
        require(success, "Function call failed");

        gasUsed = gasStart - gasleft();

        _recordGasUsage(functionName, gasUsed);
        return gasUsed;
    }

    function measureGasWithValue(
        string memory functionName,
        address target,
        bytes memory callData,
        uint256 value
    ) external payable returns (uint256 gasUsed) {
        uint256 gasStart = gasleft();

        (bool success, ) = target.call{value: value}(callData);
        require(success, "Function call failed");

        gasUsed = gasStart - gasleft();

        _recordGasUsage(functionName, gasUsed);
        return gasUsed;
    }

    function startMeasurement() external view returns (uint256) {
        return gasleft();
    }

    function endMeasurement(string memory functionName, uint256 gasStart)
        external
        returns (uint256 gasUsed)
    {
        gasUsed = gasStart - gasleft();
        _recordGasUsage(functionName, gasUsed);
        return gasUsed;
    }

    function _recordGasUsage(string memory functionName, uint256 gasUsed)
        internal
    {
        uint256 gasCost = gasUsed * GAS_PRICE;
        uint256 limit = gasLimits[functionName];
        bool withinLimit = limit == 0 || gasUsed <= limit;

        reports.push(
            GasReport({
                functionName: functionName,
                gasUsed: gasUsed,
                gasCost: gasCost,
                withinLimit: withinLimit,
                gasLimit: limit
            })
        );

        // Log the measurement
        console.log("Gas Report:");
        console.log("  Function: %s", functionName);
        console.log("  Gas Used: %d", gasUsed);
        console.log("  Gas Cost: %d wei", gasCost);
        console.log("  Within Limit: %s", withinLimit ? "YES" : "NO");
        if (limit > 0) {
            console.log("  Gas Limit: %d", limit);
        }
        console.log("");
    }

    function setGasLimit(string memory functionName, uint256 limit) external {
        gasLimits[functionName] = limit;
    }

    function getReport(uint256 index) external view returns (GasReport memory) {
        require(index < reports.length, "Report index out of bounds");
        return reports[index];
    }

    function getReportCount() external view returns (uint256) {
        return reports.length;
    }

    function getAllReports() external view returns (GasReport[] memory) {
        return reports;
    }

    function clearReports() external {
        delete reports;
    }

    function assertGasWithinLimit(string memory functionName, uint256 gasUsed)
        external
        view
    {
        uint256 limit = gasLimits[functionName];
        if (limit > 0) {
            assertLe(
                gasUsed,
                limit,
                string(abi.encodePacked(functionName, " exceeds gas limit"))
            );
        }
    }

    function printSummary() external view {
        console.log("=== GAS USAGE SUMMARY ===");
        for (uint256 i = 0; i < reports.length; i++) {
            GasReport memory report = reports[i];
            console.log("%s: %d gas", report.functionName, report.gasUsed);
            if (!report.withinLimit) {
                console.log("  WARNING: Exceeds limit of %d", report.gasLimit);
            }
        }
        console.log("========================");
    }
}
