// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IERC8183Hook.sol";

/**
 * @title BaseERC8183Hook
 * @notice Convenience base contract for ERC-8183 hook implementations
 * @dev Routes generic beforeAction/afterAction calls to named virtual functions.
 *      Hook developers only override what they need.
 * 
 * NOTE: This is NOT part of the ERC-8183 standard — only IERC8183Hook is normative.
 */
abstract contract BaseERC8183Hook is IERC8183Hook {
    address public immutable erc8183;

    error OnlyERC8183();

    modifier onlyERC8183() {
        if (msg.sender != erc8183) revert OnlyERC8183();
        _;
    }

    constructor(address _erc8183) {
        require(_erc8183 != address(0), "invalid erc8183");
        erc8183 = _erc8183;
    }

    // ============================================================
    //  Function Selectors
    // ============================================================

    bytes4 private constant SET_PROVIDER_SELECTOR = 
        bytes4(keccak256("setProvider(uint256,address,bytes)"));
    bytes4 private constant SET_BUDGET_SELECTOR = 
        bytes4(keccak256("setBudget(uint256,uint256,bytes)"));
    bytes4 private constant FUND_SELECTOR = 
        bytes4(keccak256("fund(uint256,uint256,bytes)"));
    bytes4 private constant SUBMIT_SELECTOR = 
        bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 private constant COMPLETE_SELECTOR = 
        bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    bytes4 private constant REJECT_SELECTOR = 
        bytes4(keccak256("reject(uint256,bytes32,bytes)"));

    // ============================================================
    //  IERC8183Hook Implementation
    // ============================================================

    /**
     * @notice Routes beforeAction to specific _beforeX functions
     */
    function beforeAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external onlyERC8183 {
        if (selector == SET_PROVIDER_SELECTOR) {
            _beforeSetProvider(jobId, data);
        } else if (selector == SET_BUDGET_SELECTOR) {
            _beforeSetBudget(jobId, data);
        } else if (selector == FUND_SELECTOR) {
            _beforeFund(jobId, data);
        } else if (selector == SUBMIT_SELECTOR) {
            _beforeSubmit(jobId, data);
        } else if (selector == COMPLETE_SELECTOR) {
            _beforeComplete(jobId, data);
        } else if (selector == REJECT_SELECTOR) {
            _beforeReject(jobId, data);
        }
    }

    /**
     * @notice Routes afterAction to specific _afterX functions
     */
    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external onlyERC8183 {
        if (selector == SET_PROVIDER_SELECTOR) {
            _afterSetProvider(jobId, data);
        } else if (selector == SET_BUDGET_SELECTOR) {
            _afterSetBudget(jobId, data);
        } else if (selector == FUND_SELECTOR) {
            _afterFund(jobId, data);
        } else if (selector == SUBMIT_SELECTOR) {
            _afterSubmit(jobId, data);
        } else if (selector == COMPLETE_SELECTOR) {
            _afterComplete(jobId, data);
        } else if (selector == REJECT_SELECTOR) {
            _afterReject(jobId, data);
        }
    }

    // ============================================================
    //  Virtual Functions — Before Hooks
    // ============================================================

    /**
     * @dev Override to add custom logic before setProvider
     * @param jobId Job ID
     * @param data abi.encode(address provider, bytes optParams)
     */
    function _beforeSetProvider(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic before setBudget
     * @param jobId Job ID
     * @param data abi.encode(uint256 amount, bytes optParams)
     */
    function _beforeSetBudget(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic before fund
     * @param jobId Job ID
     * @param data optParams (raw bytes)
     */
    function _beforeFund(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic before submit
     * @param jobId Job ID
     * @param data abi.encode(bytes32 deliverable, bytes optParams)
     */
    function _beforeSubmit(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic before complete
     * @param jobId Job ID
     * @param data abi.encode(bytes32 reason, bytes optParams)
     */
    function _beforeComplete(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic before reject
     * @param jobId Job ID
     * @param data abi.encode(bytes32 reason, bytes optParams)
     */
    function _beforeReject(uint256 jobId, bytes calldata data) internal virtual {}

    // ============================================================
    //  Virtual Functions — After Hooks
    // ============================================================

    /**
     * @dev Override to add custom logic after setProvider
     */
    function _afterSetProvider(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic after setBudget
     */
    function _afterSetBudget(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic after fund
     */
    function _afterFund(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic after submit
     */
    function _afterSubmit(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic after complete
     */
    function _afterComplete(uint256 jobId, bytes calldata data) internal virtual {}

    /**
     * @dev Override to add custom logic after reject
     */
    function _afterReject(uint256 jobId, bytes calldata data) internal virtual {}

    // ============================================================
    //  Helper Functions
    // ============================================================

    /**
     * @notice Decode setProvider data
     */
    function _decodeSetProviderData(bytes calldata data) 
        internal 
        pure 
        returns (address provider, bytes memory optParams) 
    {
        (provider, optParams) = abi.decode(data, (address, bytes));
    }

    /**
     * @notice Decode setBudget data
     */
    function _decodeSetBudgetData(bytes calldata data) 
        internal 
        pure 
        returns (uint256 amount, bytes memory optParams) 
    {
        (amount, optParams) = abi.decode(data, (uint256, bytes));
    }

    /**
     * @notice Decode submit data
     */
    function _decodeSubmitData(bytes calldata data) 
        internal 
        pure 
        returns (bytes32 deliverable, bytes memory optParams) 
    {
        (deliverable, optParams) = abi.decode(data, (bytes32, bytes));
    }

    /**
     * @notice Decode complete/reject data
     */
    function _decodeReasonData(bytes calldata data) 
        internal 
        pure 
        returns (bytes32 reason, bytes memory optParams) 
    {
        (reason, optParams) = abi.decode(data, (bytes32, bytes));
    }
}
