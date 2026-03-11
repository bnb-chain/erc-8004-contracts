// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IACPHook
 * @notice EIP-8183 normative hook interface for Agentic Commerce Protocol
 * @dev Hook contracts SHALL implement this interface to extend the core protocol.
 *      The selector parameter identifies which core function is being called.
 *      The data parameter contains function-specific parameters encoded as bytes.
 * 
 * Data encoding per selector:
 *   - setProvider: abi.encode(address provider, bytes optParams)
 *   - setBudget:   abi.encode(uint256 amount, bytes optParams)
 *   - fund:        optParams (raw bytes)
 *   - submit:      abi.encode(bytes32 deliverable, bytes optParams)
 *   - complete:    abi.encode(bytes32 reason, bytes optParams)
 *   - reject:      abi.encode(bytes32 reason, bytes optParams)
 * 
 * NOTE: claimRefund is deliberately NOT hookable (safety mechanism)
 */
interface IACPHook {
    /**
     * @notice Called before the core function executes
     * @dev MAY revert to block the action (e.g., enforce custom validation)
     * @param jobId The job ID
     * @param selector The function selector being called
     * @param data Encoded function parameters (see encoding above)
     */
    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external;

    /**
     * @notice Called after the core function completes (including state changes)
     * @dev MAY revert to roll back the entire transaction
     * @param jobId The job ID
     * @param selector The function selector being called
     * @param data Encoded function parameters (see encoding above)
     */
    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external;
}
