// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IAPEXEvaluator
 * @notice Interface for the APEX Evaluator contract
 * @dev Used by SDK and UI to interact with the evaluator
 */
interface IAPEXEvaluator {
    // ============================================================
    //  Events
    // ============================================================

    event AssertionInitiated(
        uint256 indexed jobId,
        bytes32 indexed assertionId,
        address initiator,
        uint256 bond
    );
    event AssertionResolved(
        uint256 indexed jobId,
        bytes32 indexed assertionId,
        bool assertedTruthfully
    );
    event AssertionDisputed(
        uint256 indexed jobId,
        bytes32 indexed assertionId
    );
    event BondDeposited(address indexed depositor, uint256 amount);
    event BondWithdrawn(address indexed recipient, uint256 amount);

    // ============================================================
    //  Bond Management
    // ============================================================

    /**
     * @notice Deposit bond tokens into the contract
     * @param amount Amount of bond tokens to deposit
     */
    function depositBond(uint256 amount) external;

    /**
     * @notice Withdraw bond tokens from the contract (owner only)
     * @param amount Amount to withdraw
     */
    function withdrawBond(uint256 amount) external;

    /**
     * @notice Get current bond balance
     */
    function bondBalance() external view returns (uint256);

    // ============================================================
    //  Assertion Functions
    // ============================================================

    /**
     * @notice Manually initiate an assertion for a submitted job
     * @param jobId The job ID in AgenticCommerce
     */
    function initiateAssertion(uint256 jobId) external;

    /**
     * @notice Settle an assertion and resolve the job
     * @param jobId The job ID
     */
    function settleJob(uint256 jobId) external;

    // ============================================================
    //  Query Functions
    // ============================================================

    /**
     * @notice Get assertion info for a job
     * @param jobId The job ID
     * @return assertionId The assertion ID
     * @return initiated Whether assertion has been initiated
     * @return disputed Whether assertion has been disputed
     * @return livenessEnd Timestamp when liveness period ends
     * @return settleable Whether the assertion can be settled now
     */
    function getAssertionInfo(uint256 jobId) external view returns (
        bytes32 assertionId,
        bool initiated,
        bool disputed,
        uint256 livenessEnd,
        bool settleable
    );

    /**
     * @notice Get the timestamp when liveness period ends
     * @param jobId The job ID
     */
    function getLivenessEnd(uint256 jobId) external view returns (uint256);

    /**
     * @notice Check if an assertion can be settled
     * @param jobId The job ID
     */
    function isSettleable(uint256 jobId) external view returns (bool);

    /**
     * @notice Get the minimum bond required for assertions
     */
    function getMinimumBond() external view returns (uint256);

    /**
     * @notice Get the job ID for an assertion
     * @param assertionId The assertion ID
     */
    function assertionToJob(bytes32 assertionId) external view returns (uint256);

    /**
     * @notice Get the assertion ID for a job
     * @param jobId The job ID
     */
    function jobToAssertion(uint256 jobId) external view returns (bytes32);

    /**
     * @notice Check if assertion has been initiated for a job
     * @param jobId The job ID
     */
    function jobAssertionInitiated(uint256 jobId) external view returns (bool);

    /**
     * @notice Check if a job's assertion has been disputed
     * @param jobId The job ID
     */
    function jobDisputed(uint256 jobId) external view returns (bool);

    /**
     * @notice Get the data URL (IPFS) for a job
     * @param jobId The job ID
     */
    function jobDataUrl(uint256 jobId) external view returns (string memory);

    // ============================================================
    //  Config
    // ============================================================

    /**
     * @notice Get the current liveness period
     */
    function liveness() external view returns (uint64);

    /**
     * @notice Get the number of pending (unresolved) assertions
     */
    function pendingAssertions() external view returns (uint256);
}
