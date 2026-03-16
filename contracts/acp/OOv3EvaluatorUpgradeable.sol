// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "./IACPHook.sol";

/**
 * @title IAgenticCommerce
 * @notice Interface for the AgenticCommerceUpgradeable contract
 */
interface IAgenticCommerce {
    enum Status {
        None,
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        address hook;
        uint256 budget;
        uint256 expiredAt;
        Status status;
        bytes32 deliverable;
        string description;
    }

    function getJob(uint256 jobId) external view returns (Job memory);
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function paymentToken() external view returns (address);
}

/**
 * @title IOptimisticOracleV3
 * @notice Interface for UMA's Optimistic Oracle V3
 * @dev The Assertion struct must match the actual OOv3 contract return type exactly
 */
interface IOptimisticOracleV3 {
    function assertTruth(
        bytes memory claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId);

    function settleAssertion(bytes32 assertionId) external;
    function getAssertionResult(bytes32 assertionId) external view returns (bool);
    function getMinimumBond(address currency) external view returns (uint256);
    
    /// @notice Escalation manager settings for assertions
    struct EscalationManagerSettings {
        bool arbitrateViaEscalationManager;
        bool discardOracle;
        bool validateDisputers;
        address assertingCaller;
        address escalationManager;
    }
    
    /// @notice Full assertion data structure as returned by OOv3
    /// @dev This must match the actual struct layout in UMA's OptimisticOracleV3
    struct Assertion {
        EscalationManagerSettings escalationManagerSettings;
        address asserter;
        uint64 assertionTime;
        bool settled;
        address currency;
        uint64 expirationTime;
        bool settlementResolution;
        bytes32 domainId;
        bytes32 identifier;
        uint256 bond;
        address callbackRecipient;
        address disputer;
    }
    
    function getAssertion(bytes32 assertionId) external view returns (Assertion memory);
}

/**
 * @title OOv3EvaluatorUpgradeable
 * @notice UMA OOv3-based evaluator for EIP-8183 Agentic Commerce Protocol (Upgradeable)
 * @dev UUPS upgradeable version with ERC-7201 namespaced storage.
 *      This contract serves as both evaluator AND hook for AgenticCommerce jobs.
 *      It uses UMA's Optimistic Oracle V3 for dispute resolution.
 * 
 * Key Features:
 *   - UUPS upgradeable with stable proxy address
 *   - ERC-7201 namespaced storage for safe upgrades
 *   - Implements IACPHook: afterAction auto-triggers assertion on submit
 *   - Pre-funded bond model: anyone can deposit, contract pays bond
 *   - Disputed state tracking
 *   - Query functions for UI integration
 * 
 * Flow:
 *   1. Client creates job with evaluator=this, hook=this
 *   2. Provider submits work → afterAction auto-initiates assertion
 *   3. Challenge period (liveness) starts
 *   4. After liveness, anyone calls settleJob() → complete/reject
 */
contract OOv3EvaluatorUpgradeable is 
    IACPHook, 
    OwnableUpgradeable, 
    ReentrancyGuardUpgradeable, 
    PausableUpgradeable,
    UUPSUpgradeable 
{
    using SafeERC20 for IERC20;

    // ============================================================
    //  Constants
    // ============================================================

    bytes32 public constant DEFAULT_IDENTIFIER = bytes32("ASSERT_TRUTH");
    
    bytes4 private constant SUBMIT_SELECTOR = 
        bytes4(keccak256("submit(uint256,bytes32,bytes)"));

    // ============================================================
    //  Storage (ERC-7201 Namespaced)
    // ============================================================

    /// @custom:storage-location erc7201:oov3evaluator.storage
    struct EvaluatorStorage {
        IAgenticCommerce acp;
        IOptimisticOracleV3 oov3;
        IERC20 bondToken;
        uint64 liveness;
        uint256 bondBalance;
        mapping(bytes32 => uint256) assertionToJob;
        mapping(uint256 => bytes32) jobToAssertion;
        mapping(uint256 => bool) jobAssertionInitiated;
        mapping(uint256 => bool) jobDisputed;
        mapping(uint256 => string) jobDataUrl;
        mapping(bytes32 => bool) assertionExists;  // Fix jobId=0 edge case
    }

    /// @notice Contract version for upgrade tracking
    /// @dev v2: Fixed IOptimisticOracleV3.Assertion struct to match actual OOv3 return type
    uint256 public constant VERSION = 2;

    // keccak256(abi.encode(uint256(keccak256("oov3evaluator.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant EVALUATOR_STORAGE_LOCATION =
        0x25863f74737c6444318a1ee9c2cafd9404b468da6bb07dfde7df502017620300;

    function _getEvaluatorStorage() private pure returns (EvaluatorStorage storage $) {
        assembly {
            $.slot := EVALUATOR_STORAGE_LOCATION
        }
    }

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
    event BondReturned(bytes32 indexed assertionId, uint256 amount);
    event LivenessUpdated(uint64 oldLiveness, uint64 newLiveness);
    event ACPUpdated(address indexed oldAcp, address indexed newAcp);
    event OOv3Updated(address indexed oldOov3, address indexed newOov3);
    event BondTokenUpdated(address indexed oldToken, address indexed newToken);

    // ============================================================
    //  Errors
    // ============================================================

    error JobNotSubmitted(uint256 jobId);
    error NotEvaluatorForJob(uint256 jobId);
    error AssertionAlreadyInitiated(uint256 jobId);
    error InsufficientBondBalance(uint256 required, uint256 available);
    error OnlyOOv3();
    error OnlyACP();
    error NoAssertionForJob(uint256 jobId);

    // ============================================================
    //  Constructor (disabled for proxy)
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============================================================
    //  Initializer
    // ============================================================

    /**
     * @notice Initialize the upgradeable contract
     * @param owner_ Contract owner address
     * @param acp_ AgenticCommerce contract address
     * @param oov3_ UMA Optimistic Oracle V3 address
     * @param bondToken_ Bond token address (e.g., U)
     * @param liveness_ Challenge period in seconds
     */
    function initialize(
        address owner_,
        address acp_,
        address oov3_,
        address bondToken_,
        uint64 liveness_
    ) public initializer {
        require(acp_ != address(0), "invalid acp");
        require(oov3_ != address(0), "invalid oov3");
        require(bondToken_ != address(0), "invalid bond token");
        require(liveness_ > 0, "invalid liveness");

        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __Pausable_init();
        __UUPSUpgradeable_init();

        EvaluatorStorage storage $ = _getEvaluatorStorage();
        $.acp = IAgenticCommerce(acp_);
        $.oov3 = IOptimisticOracleV3(oov3_);
        $.bondToken = IERC20(bondToken_);
        $.liveness = liveness_;
    }

    // ============================================================
    //  UUPS Authorization
    // ============================================================

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ============================================================
    //  Public Getters (for external access to storage)
    // ============================================================

    function acp() external view returns (IAgenticCommerce) {
        return _getEvaluatorStorage().acp;
    }

    function oov3() external view returns (IOptimisticOracleV3) {
        return _getEvaluatorStorage().oov3;
    }

    function bondToken() external view returns (IERC20) {
        return _getEvaluatorStorage().bondToken;
    }

    function liveness() external view returns (uint64) {
        return _getEvaluatorStorage().liveness;
    }

    function bondBalance() external view returns (uint256) {
        return _getEvaluatorStorage().bondBalance;
    }

    function assertionToJob(bytes32 assertionId) external view returns (uint256) {
        return _getEvaluatorStorage().assertionToJob[assertionId];
    }

    function jobToAssertion(uint256 jobId) external view returns (bytes32) {
        return _getEvaluatorStorage().jobToAssertion[jobId];
    }

    function jobAssertionInitiated(uint256 jobId) external view returns (bool) {
        return _getEvaluatorStorage().jobAssertionInitiated[jobId];
    }

    function jobDisputed(uint256 jobId) external view returns (bool) {
        return _getEvaluatorStorage().jobDisputed[jobId];
    }

    function jobDataUrl(uint256 jobId) external view returns (string memory) {
        return _getEvaluatorStorage().jobDataUrl[jobId];
    }

    function assertionExists(bytes32 assertionId) external view returns (bool) {
        return _getEvaluatorStorage().assertionExists[assertionId];
    }

    // ============================================================
    //  IACPHook Implementation
    // ============================================================

    function beforeAction(
        uint256,
        bytes4,
        bytes calldata
    ) external view {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        if (msg.sender != address($.acp)) revert OnlyACP();
    }

    function afterAction(
        uint256 jobId,
        bytes4 selector,
        bytes calldata data
    ) external nonReentrant whenNotPaused {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        if (msg.sender != address($.acp)) revert OnlyACP();

        if (selector == SUBMIT_SELECTOR) {
            _tryStoreDataUrl(jobId, data);
            _initiateAssertionInternal(jobId);
        }
    }

    function _tryStoreDataUrl(uint256 jobId, bytes calldata data) internal {
        if (data.length < 96) return;
        
        uint256 offset;
        assembly {
            offset := calldataload(add(data.offset, 32))
        }
        if (offset != 64) return;
        
        uint256 len;
        assembly {
            len := calldataload(add(data.offset, 64))
        }
        if (len == 0 || len > 256) return;
        
        if (data.length < 96 + len) return;
        
        // Extract optParams using calldatacopy (handles >32 bytes correctly)
        bytes memory optParams = new bytes(len);
        assembly {
            calldatacopy(add(optParams, 32), add(data.offset, 96), len)
        }
        _getEvaluatorStorage().jobDataUrl[jobId] = string(optParams);
    }

    // ============================================================
    //  Bond Management
    // ============================================================

    function depositBond(uint256 amount) external {
        require(amount > 0, "amount must be > 0");
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        $.bondToken.safeTransferFrom(msg.sender, address(this), amount);
        $.bondBalance += amount;
        emit BondDeposited(msg.sender, amount);
    }

    function withdrawBond(uint256 amount) external onlyOwner {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        require($.bondBalance >= amount, "insufficient balance");
        $.bondBalance -= amount;
        $.bondToken.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    // ============================================================
    //  Assertion Functions
    // ============================================================

    function initiateAssertion(uint256 jobId) external nonReentrant whenNotPaused {
        _initiateAssertionInternal(jobId);
    }

    function settleJob(uint256 jobId) external {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        bytes32 assertionId = $.jobToAssertion[jobId];
        if (assertionId == bytes32(0)) revert NoAssertionForJob(jobId);
        $.oov3.settleAssertion(assertionId);
    }

    // ============================================================
    //  OOv3 Callbacks
    // ============================================================

    function assertionResolvedCallback(
        bytes32 assertionId,
        bool assertedTruthfully
    ) external {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        if (msg.sender != address($.oov3)) revert OnlyOOv3();

        // Use assertionExists to handle jobId=0 edge case
        require($.assertionExists[assertionId], "unknown assertion");
        uint256 jobId = $.assertionToJob[assertionId];

        // Bond is returned by OOv3 on successful resolution (no dispute)
        // Update bondBalance to reflect the returned bond
        if (!$.jobDisputed[jobId]) {
            uint256 bond = $.oov3.getMinimumBond(address($.bondToken));
            $.bondBalance += bond;
            emit BondReturned(assertionId, bond);
        }

        emit AssertionResolved(jobId, assertionId, assertedTruthfully);

        if (assertedTruthfully) {
            $.acp.complete(jobId, assertionId, "");
        } else {
            $.acp.reject(jobId, assertionId, "");
        }
    }

    function assertionDisputedCallback(bytes32 assertionId) external {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        if (msg.sender != address($.oov3)) revert OnlyOOv3();

        uint256 jobId = $.assertionToJob[assertionId];
        if (jobId != 0) {
            $.jobDisputed[jobId] = true;
            emit AssertionDisputed(jobId, assertionId);
        }
    }

    // ============================================================
    //  Query Functions
    // ============================================================

    function getAssertionInfo(uint256 jobId) external view returns (
        bytes32 assertionId,
        bool initiated,
        bool disputed,
        uint256 livenessEnd,
        bool settleable
    ) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        assertionId = $.jobToAssertion[jobId];
        initiated = $.jobAssertionInitiated[jobId];
        disputed = $.jobDisputed[jobId];
        
        if (assertionId != bytes32(0)) {
            livenessEnd = getLivenessEnd(jobId);
            settleable = isSettleable(jobId);
        }
    }

    function getLivenessEnd(uint256 jobId) public view returns (uint256) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        bytes32 assertionId = $.jobToAssertion[jobId];
        if (assertionId == bytes32(0)) return 0;
        
        IOptimisticOracleV3.Assertion memory assertion = $.oov3.getAssertion(assertionId);
        return assertion.expirationTime;
    }

    function isSettleable(uint256 jobId) public view returns (bool) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        bytes32 assertionId = $.jobToAssertion[jobId];
        if (assertionId == bytes32(0)) return false;
        
        IOptimisticOracleV3.Assertion memory assertion = $.oov3.getAssertion(assertionId);
        return !assertion.settled && block.timestamp >= assertion.expirationTime;
    }

    function getMinimumBond() external view returns (uint256) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        return $.oov3.getMinimumBond(address($.bondToken));
    }

    /**
     * @notice Batch query assertion info for multiple jobs
     * @param jobIds Array of job IDs to query
     */
    function batchGetAssertionInfo(uint256[] calldata jobIds) external view returns (
        bytes32[] memory assertionIds,
        bool[] memory initiated,
        bool[] memory disputed,
        uint256[] memory livenessEnds,
        bool[] memory settleable
    ) {
        uint256 len = jobIds.length;
        assertionIds = new bytes32[](len);
        initiated = new bool[](len);
        disputed = new bool[](len);
        livenessEnds = new uint256[](len);
        settleable = new bool[](len);

        EvaluatorStorage storage $ = _getEvaluatorStorage();
        
        for (uint256 i = 0; i < len; i++) {
            uint256 jobId = jobIds[i];
            assertionIds[i] = $.jobToAssertion[jobId];
            initiated[i] = $.jobAssertionInitiated[jobId];
            disputed[i] = $.jobDisputed[jobId];
            
            if (assertionIds[i] != bytes32(0)) {
                livenessEnds[i] = getLivenessEnd(jobId);
                settleable[i] = isSettleable(jobId);
            }
        }
    }

    // ============================================================
    //  Admin Functions
    // ============================================================

    function setLiveness(uint64 _liveness) external onlyOwner {
        require(_liveness > 0, "invalid liveness");
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        emit LivenessUpdated($.liveness, _liveness);
        $.liveness = _liveness;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Rescue stuck tokens (only excess beyond bondBalance for bond token)
     * @param token Token address
     * @param to Recipient address
     * @param amount Amount to rescue
     */
    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(to != address(0), "invalid address");
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        
        if (token == address($.bondToken)) {
            // Only allow rescuing excess tokens beyond tracked bondBalance
            uint256 actualBalance = $.bondToken.balanceOf(address(this));
            uint256 excess = actualBalance > $.bondBalance ? actualBalance - $.bondBalance : 0;
            require(amount <= excess, "cannot rescue reserved bond");
        }
        
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Update ACP contract address (for migration)
     * @param newAcp New ACP contract address
     */
    function setACP(address newAcp) external onlyOwner {
        require(newAcp != address(0), "invalid acp");
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        address oldAcp = address($.acp);
        $.acp = IAgenticCommerce(newAcp);
        emit ACPUpdated(oldAcp, newAcp);
    }

    /**
     * @notice Update OOv3 contract address (for migration)
     * @param newOov3 New OOv3 contract address
     */
    function setOOv3(address newOov3) external onlyOwner {
        require(newOov3 != address(0), "invalid oov3");
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        address oldOov3 = address($.oov3);
        $.oov3 = IOptimisticOracleV3(newOov3);
        emit OOv3Updated(oldOov3, newOov3);
    }

    /**
     * @notice Update bond token address
     * @dev Only callable when bondBalance is 0 to prevent locked funds
     *      The new token must be whitelisted by UMA OOv3
     * @param newBondToken New bond token address
     */
    function setBondToken(address newBondToken) external onlyOwner {
        require(newBondToken != address(0), "invalid bond token");
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        require($.bondBalance == 0, "withdraw bond first");
        address oldToken = address($.bondToken);
        $.bondToken = IERC20(newBondToken);
        emit BondTokenUpdated(oldToken, newBondToken);
    }

    /**
     * @notice Sync bondBalance with actual token balance
     * @dev Use when bondBalance gets out of sync (e.g., direct transfers)
     */
    function syncBondBalance() external onlyOwner {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        uint256 actualBalance = $.bondToken.balanceOf(address(this));
        $.bondBalance = actualBalance;
    }

    // ============================================================
    //  Internal Functions
    // ============================================================

    function _initiateAssertionInternal(uint256 jobId) internal {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        IAgenticCommerce.Job memory job = $.acp.getJob(jobId);

        if (msg.sender != address($.acp)) {
            if (job.status != IAgenticCommerce.Status.Submitted) {
                revert JobNotSubmitted(jobId);
            }
        }
        if (job.evaluator != address(this)) {
            revert NotEvaluatorForJob(jobId);
        }
        if ($.jobAssertionInitiated[jobId]) {
            revert AssertionAlreadyInitiated(jobId);
        }

        uint256 bond = $.oov3.getMinimumBond(address($.bondToken));

        if ($.bondBalance < bond) {
            revert InsufficientBondBalance(bond, $.bondBalance);
        }
        $.bondBalance -= bond;

        $.bondToken.forceApprove(address($.oov3), bond);

        bytes memory claim = _buildClaim(jobId, job);

        bytes32 assertionId = $.oov3.assertTruth(
            claim,
            address(this),
            address(this),
            address(0),
            $.liveness,
            $.bondToken,
            bond,
            DEFAULT_IDENTIFIER,
            bytes32(0)
        );

        $.assertionToJob[assertionId] = jobId;
        $.jobToAssertion[jobId] = assertionId;
        $.jobAssertionInitiated[jobId] = true;
        $.assertionExists[assertionId] = true;

        emit AssertionInitiated(jobId, assertionId, msg.sender, bond);
    }

    /**
     * @notice Get payment token address with fallback
     * @dev Uses try-catch for backward compatibility with ACP implementations
     */
    function _getPaymentToken() internal view returns (address) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        try $.acp.paymentToken() returns (address token) {
            return token;
        } catch {
            return address(0);
        }
    }

    /**
     * @notice Build the claim for UMA assertion
     * @dev Split into helper functions to avoid stack too deep
     * @param jobId The job ID
     * @param job The job data
     * @return claim The encoded claim bytes
     */
    function _buildClaim(
        uint256 jobId,
        IAgenticCommerce.Job memory job
    ) internal view returns (bytes memory) {
        return abi.encodePacked(
            _buildClaimHeader(jobId),
            _buildClaimRequest(job),
            _buildClaimResponse(jobId, job)
        );
    }

    function _buildClaimHeader(uint256 jobId) internal view returns (bytes memory) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        return abi.encodePacked(
            "ACP Job Completion Assertion. ",
            "Chain: ", _uint2str(block.chainid),
            ". ACP: ", _addressToHex(address($.acp)),
            ". Job ID: ", _uint2str(jobId),
            ". [REQUEST] "
        );
    }

    function _buildClaimRequest(IAgenticCommerce.Job memory job) internal view returns (bytes memory) {
        return abi.encodePacked(
            _buildClaimParticipants(job),
            _buildClaimTerms(job)
        );
    }

    function _buildClaimParticipants(IAgenticCommerce.Job memory job) internal pure returns (bytes memory) {
        return abi.encodePacked(
            "Client: ", _addressToHex(job.client),
            ". Provider: ", _addressToHex(job.provider),
            ". Evaluator: ", _addressToHex(job.evaluator),
            job.hook != address(0) ? ". Hook: " : "",
            job.hook != address(0) ? _addressToHex(job.hook) : ""
        );
    }

    function _buildClaimTerms(IAgenticCommerce.Job memory job) internal view returns (bytes memory) {
        address token = _getPaymentToken();
        return abi.encodePacked(
            ". Budget: ", _uint2str(job.budget), " wei",
            token != address(0) ? " (" : "",
            token != address(0) ? _addressToHex(token) : "",
            token != address(0) ? ")" : "",
            ". Deadline: ", _uint2str(job.expiredAt),
            ". Description: ", job.description
        );
    }

    function _buildClaimResponse(uint256 jobId, IAgenticCommerce.Job memory job) internal view returns (bytes memory) {
        EvaluatorStorage storage $ = _getEvaluatorStorage();
        string memory dataUrl = $.jobDataUrl[jobId];
        bool hasDataUrl = bytes(dataUrl).length > 0;
        
        return abi.encodePacked(
            ". [RESPONSE] ",
            "Deliverable Hash: ", _bytes32ToHex(job.deliverable),
            hasDataUrl ? ". Deliverable URL: " : "",
            hasDataUrl ? dataUrl : "",
            ". [VERIFY] ",
            hasDataUrl 
                ? "(1) Fetch deliverable from URL. "
                : "(1) Retrieve from IPFS (hash = keccak256(url)). ",
            "(2) Verify keccak256(url) matches Deliverable Hash. ",
            "(3) Compare deliverable against Description. ",
            "(4) TRUE if satisfies, FALSE otherwise."
        );
    }

    // ============================================================
    //  String Helpers
    // ============================================================

    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    function _bytes32ToHex(bytes32 data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(66);
        str[0] = "0";
        str[1] = "x";
        for (uint256 i = 0; i < 32; i++) {
            str[2 + i * 2] = alphabet[uint8(data[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }

    function _addressToHex(address addr) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = "0";
        str[1] = "x";
        bytes20 addrBytes = bytes20(addr);
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(addrBytes[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(addrBytes[i] & 0x0f)];
        }
        return string(str);
    }
}
