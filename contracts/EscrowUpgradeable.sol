// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

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
}

// ============================================================
//  Enums
// ============================================================

enum JobPhase {
    None,            // 0 — default, job does not exist
    PaymentLocked,   // 1 — client paid, waiting for agent
    InProgress,      // 2 — agent accepted, executing
    Asserting,       // 3 — result submitted, OOv3 assertion active
    Disputed,        // 4 — disputed, awaiting DVM resolution
    Completed,       // 5 — terminal: agent paid
    Refunded,        // 6 — terminal: client refunded
    Cancelled        // 7 — terminal: job cancelled
}

enum SettlementType {
    None,              // 0 — not settled
    Unchallenged,      // 1 — no dispute, liveness expired
    DisputeAgentWon,   // 2 — disputed, agent won (direction-agnostic)
    DisputeClientWon,  // 3 — disputed, client won (direction-agnostic)
    AgentTimedOut,     // 4 — agent timed out (passive, deadline expired)
    AgentRejected,     // 5 — agent actively rejected the job
    ClientApproved     // 6 — reserved V2: client early approve
}

// ============================================================
//  Structs
// ============================================================

struct Job {
    uint256 jobId;
    address client;
    uint256 agentId;
    address agentOwner;

    uint256 agreedPrice;
    uint256 assertionBond;

    JobPhase phase;
    SettlementType settlement;

    // Negotiation phase hashes (anchored by client at createJobAndLock)
    bytes32 negotiationRequestHash;   // keccak256(NegotiationRequest)
    bytes32 negotiationResponseHash;  // keccak256(NegotiationResponse with price)

    // Service phase hashes (set by agent at submitResult)
    bytes32 serviceRecordHash;        // keccak256(full IPFS ServiceRecord)
    bytes32 serviceResponseHash;      // keccak256(agent's service response content)

    bytes32 assertionId;

    uint256 createdAt;
    uint256 updatedAt;
    uint256 acceptDeadline;
    uint256 submitDeadline;
}

/**
 * @title EscrowUpgradeable
 * @notice ERC-8004 UUPS-upgradeable escrow with Bazaar V1 job lifecycle.
 *         Manages: Negotiate → Lock → Accept → Execute → Assert (OOv3) → Settle.
 *         The contract is the OOv3 asserter; only clients can dispute.
 *
 *         V1-V2 legacy escrow payment functions are kept as read-only for backward
 *         compatibility. V3 introduces the full Job lifecycle with ERC-20 payments
 *         and UMA OOv3 dispute resolution.
 */
contract EscrowUpgradeable is OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ============================================================
    //  Errors
    // ============================================================

    error Deprecated(string replacement);
    error JobNotFound(uint256 jobId);
    error InvalidPhase(uint256 jobId, JobPhase expected, JobPhase actual);
    error Unauthorized();
    error BelowMinimumFee(uint256 amount, uint256 minimum);
    error DeadlineExpired(uint256 jobId);
    error DeadlineNotExpired(uint256 jobId);
    error InvalidAmount();

    // ============================================================
    //  Events
    // ============================================================

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        uint256 indexed agentId,
        uint256 agreedPrice,
        bytes32 negotiationRequestHash,
        bytes32 negotiationResponseHash
    );

    event JobAccepted(uint256 indexed jobId, uint256 indexed agentId);

    event JobRejected(
        uint256 indexed jobId,
        uint256 indexed agentId,
        bytes32 reasonCode,
        string reasonMessage
    );

    event ResultSubmitted(
        uint256 indexed jobId,
        bytes32 serviceRecordHash,
        bytes32 serviceResponseHash,
        string dataUrl,
        bytes32 assertionId
    );

    event JobDisputed(uint256 indexed jobId, bytes32 indexed assertionId);

    event JobSettled(
        uint256 indexed jobId,
        uint256 indexed agentId,
        SettlementType settlement,
        uint256 agentPayout,
        uint256 clientRefund
    );

    event JobCancelled(uint256 indexed jobId, SettlementType settlement);

    event TransferFailed(address indexed recipient, uint256 amount, uint256 jobId);
    event PendingClaimed(address indexed recipient, uint256 amount);

    // ============================================================
    //  LEGACY STORAGE (v1-v2) — DO NOT REMOVE, DO NOT REORDER
    //  Kept for UUPS proxy storage layout compatibility.
    // ============================================================

    /// @dev Identity registry at slot 0 — still used by V3 job functions.
    address private _identityRegistry;

    /// @custom:storage-location erc7201:erc8004.escrow.registry
    struct LegacyPayment {
        address client;
        uint256 agentId;
        uint256 amount;
        bool released;
        uint256 timestamp;
    }

    /// @custom:storage-location erc7201:erc8004.escrow.registry
    struct LegacyEscrowStorage {
        mapping(bytes32 => LegacyPayment) _payments;
        mapping(uint256 => bytes32[]) _agentPayments;
        mapping(address => bytes32[]) _clientPayments;
        uint256 _minPayment;
    }

    bytes32 private constant LEGACY_ESCROW_STORAGE_LOCATION =
        0x105551c4ee449a31443722016be6b9fc9f89d45ec427fbae7a17a5658a172100;

    function _getLegacyEscrowStorage()
        private
        pure
        returns (LegacyEscrowStorage storage $)
    {
        assembly {
            $.slot := LEGACY_ESCROW_STORAGE_LOCATION
        }
    }

    // ============================================================
    //  NEW STORAGE (v3) — Bazaar Job Lifecycle
    // ============================================================

    /// @custom:storage-location erc7201:erc8004.servicemanager
    struct BazaarStorage {
        mapping(uint256 => Job) _jobs;
        mapping(bytes32 => uint256) _assertionToJob;
        uint256 _nextJobId;
        IOptimisticOracleV3 _oov3;
        IERC20 _paymentToken;
        uint256 _acceptTimeout;
        uint256 _submitTimeout;
        uint64 _oov3Liveness;
        uint256 _bondRate;
        uint256 _minServiceFee;
        mapping(address => uint256) _pendingWithdrawals;
    }

    // keccak256(abi.encode(uint256(keccak256("erc8004.servicemanager")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant BAZAAR_STORAGE_LOCATION =
        0xdafdb84b93a60307fbae8683888d5423afec5aa90d8e3d52c97325d829ff3c00;

    function _getBazaarStorage()
        private
        pure
        returns (BazaarStorage storage $)
    {
        assembly {
            $.slot := BAZAAR_STORAGE_LOCATION
        }
    }

    // ============================================================
    //  Constants
    // ============================================================

    bytes32 public constant DEFAULT_IDENTIFIER = bytes32("ASSERT_TRUTH");

    // ============================================================
    //  Constructor (disable initializers for implementation)
    // ============================================================

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ============================================================
    //  Initializers
    // ============================================================

    function initialize(
        address identityRegistry_
    ) public reinitializer(2) onlyOwner {
        require(identityRegistry_ != address(0), "bad identity");
        _identityRegistry = identityRegistry_;
        LegacyEscrowStorage storage $ = _getLegacyEscrowStorage();
        if ($._minPayment == 0) $._minPayment = 10 gwei;
    }

    function initializeV3(
        address oov3_,
        address paymentToken_,
        uint256 acceptTimeout_,
        uint256 submitTimeout_,
        uint64 oov3Liveness_,
        uint256 bondRate_
    ) public reinitializer(3) onlyOwner {
        __ReentrancyGuard_init();

        require(oov3_ != address(0), "bad oov3");
        require(paymentToken_ != address(0), "bad token");
        require(bondRate_ > 0 && bondRate_ <= 10000, "bad bond rate");

        BazaarStorage storage $ = _getBazaarStorage();
        $._oov3 = IOptimisticOracleV3(oov3_);
        $._paymentToken = IERC20(paymentToken_);
        $._acceptTimeout = acceptTimeout_;
        $._submitTimeout = submitTimeout_;
        $._oov3Liveness = oov3Liveness_;
        $._bondRate = bondRate_;
        $._nextJobId = 1;

        uint256 minimumBond = IOptimisticOracleV3(oov3_).getMinimumBond(paymentToken_);
        require(minimumBond > 0, "token not approved by OOv3");
        $._minServiceFee = (minimumBond * 10000) / bondRate_;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ============================================================
    //  View — Config
    // ============================================================

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function oov3() external view returns (address) {
        return address(_getBazaarStorage()._oov3);
    }

    function paymentToken() external view returns (address) {
        return address(_getBazaarStorage()._paymentToken);
    }

    function acceptTimeout() external view returns (uint256) {
        return _getBazaarStorage()._acceptTimeout;
    }

    function submitTimeout() external view returns (uint256) {
        return _getBazaarStorage()._submitTimeout;
    }

    function oov3Liveness() external view returns (uint64) {
        return _getBazaarStorage()._oov3Liveness;
    }

    function bondRate() external view returns (uint256) {
        return _getBazaarStorage()._bondRate;
    }

    function minServiceFee() external view returns (uint256) {
        return _getBazaarStorage()._minServiceFee;
    }

    function nextJobId() external view returns (uint256) {
        return _getBazaarStorage()._nextJobId;
    }

    // ============================================================
    //  View — Job
    // ============================================================

    function getJob(uint256 jobId) external view returns (Job memory) {
        BazaarStorage storage $ = _getBazaarStorage();
        Job memory job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        return job;
    }

    function getJobPhase(uint256 jobId) external view returns (JobPhase) {
        return _getBazaarStorage()._jobs[jobId].phase;
    }

    function getAssertionIdForJob(uint256 jobId) external view returns (bytes32) {
        return _getBazaarStorage()._jobs[jobId].assertionId;
    }

    function getJobForAssertion(bytes32 assertionId) external view returns (uint256) {
        return _getBazaarStorage()._assertionToJob[assertionId];
    }

    // ============================================================
    //  Client Functions
    // ============================================================

    function createJobAndLock(
        uint256 agentId,
        bytes32 negotiationRequestHash,
        bytes32 negotiationResponseHash,
        uint256 amount
    ) external nonReentrant returns (uint256 jobId) {
        BazaarStorage storage $ = _getBazaarStorage();

        if (amount < $._minServiceFee) {
            revert BelowMinimumFee(amount, $._minServiceFee);
        }
        if (negotiationRequestHash == bytes32(0)) revert InvalidAmount();
        if (negotiationResponseHash == bytes32(0)) revert InvalidAmount();

        address agentOwner = IIdentityRegistry(_identityRegistry).ownerOf(agentId);
        require(agentOwner != address(0), "agent not found");

        $._paymentToken.safeTransferFrom(msg.sender, address(this), amount);

        jobId = $._nextJobId++;
        Job storage job = $._jobs[jobId];
        job.jobId = jobId;
        job.client = msg.sender;
        job.agentId = agentId;
        job.agentOwner = agentOwner;
        job.agreedPrice = amount;
        job.phase = JobPhase.PaymentLocked;
        job.negotiationRequestHash = negotiationRequestHash;
        job.negotiationResponseHash = negotiationResponseHash;
        job.createdAt = block.timestamp;
        job.updatedAt = block.timestamp;
        job.acceptDeadline = block.timestamp + $._acceptTimeout;

        emit JobCreated(jobId, msg.sender, agentId, amount, negotiationRequestHash, negotiationResponseHash);
    }

    function cancelExpired(uint256 jobId) external nonReentrant {
        BazaarStorage storage $ = _getBazaarStorage();
        Job storage job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);

        if (job.phase == JobPhase.PaymentLocked) {
            if (block.timestamp <= job.acceptDeadline) {
                revert DeadlineNotExpired(jobId);
            }
        } else if (job.phase == JobPhase.InProgress) {
            if (block.timestamp <= job.submitDeadline) {
                revert DeadlineNotExpired(jobId);
            }
        } else {
            revert InvalidPhase(jobId, JobPhase.PaymentLocked, job.phase);
        }

        job.phase = JobPhase.Cancelled;
        job.settlement = SettlementType.AgentTimedOut;
        job.updatedAt = block.timestamp;

        $._paymentToken.safeTransfer(job.client, job.agreedPrice);

        emit JobCancelled(jobId, SettlementType.AgentTimedOut);
    }

    // ============================================================
    //  Agent Functions
    // ============================================================

    function acceptJob(uint256 jobId) external nonReentrant {
        BazaarStorage storage $ = _getBazaarStorage();
        Job storage job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        if (job.phase != JobPhase.PaymentLocked) {
            revert InvalidPhase(jobId, JobPhase.PaymentLocked, job.phase);
        }
        if (msg.sender != job.agentOwner) revert Unauthorized();
        if (block.timestamp > job.acceptDeadline) revert DeadlineExpired(jobId);

        job.phase = JobPhase.InProgress;
        job.updatedAt = block.timestamp;
        job.submitDeadline = block.timestamp + $._submitTimeout;

        emit JobAccepted(jobId, job.agentId);
    }

    function rejectJob(
        uint256 jobId,
        bytes32 reasonCode,
        string calldata reasonMessage
    ) external nonReentrant {
        BazaarStorage storage $ = _getBazaarStorage();
        Job storage job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        if (job.phase != JobPhase.PaymentLocked) {
            revert InvalidPhase(jobId, JobPhase.PaymentLocked, job.phase);
        }
        if (msg.sender != job.agentOwner) revert Unauthorized();

        job.phase = JobPhase.Cancelled;
        job.settlement = SettlementType.AgentRejected;
        job.updatedAt = block.timestamp;

        $._paymentToken.safeTransfer(job.client, job.agreedPrice);

        emit JobRejected(jobId, job.agentId, reasonCode, reasonMessage);
        emit JobCancelled(jobId, SettlementType.AgentRejected);
    }

    function submitResult(
        uint256 jobId,
        bytes32 serviceRecordHash,
        bytes32 serviceResponseHash,
        string calldata dataUrl
    ) external nonReentrant {
        BazaarStorage storage $ = _getBazaarStorage();
        Job storage job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        if (job.phase != JobPhase.InProgress) {
            revert InvalidPhase(jobId, JobPhase.InProgress, job.phase);
        }
        if (msg.sender != job.agentOwner) revert Unauthorized();
        if (block.timestamp > job.submitDeadline) revert DeadlineExpired(jobId);

        job.serviceRecordHash = serviceRecordHash;
        job.serviceResponseHash = serviceResponseHash;

        uint256 bond = (job.agreedPrice * $._bondRate) / 10000;
        job.assertionBond = bond;

        bytes memory claim = _buildClaim(job, dataUrl);

        $._paymentToken.forceApprove(address($._oov3), bond);

        bytes32 assertionId = $._oov3.assertTruth(
            claim,
            address(this),       // asserter
            address(this),       // callbackRecipient
            address(0),          // escalationManager (default DVM)
            $._oov3Liveness,
            $._paymentToken,
            bond,
            DEFAULT_IDENTIFIER,
            bytes32(0)           // domainId
        );

        job.assertionId = assertionId;
        job.phase = JobPhase.Asserting;
        job.updatedAt = block.timestamp;

        $._assertionToJob[assertionId] = jobId;

        emit ResultSubmitted(jobId, serviceRecordHash, serviceResponseHash, dataUrl, assertionId);
    }

    // ============================================================
    //  OOv3 Callbacks
    // ============================================================

    function assertionResolvedCallback(
        bytes32 assertionId,
        bool assertedTruthfully
    ) external nonReentrant {
        BazaarStorage storage $ = _getBazaarStorage();
        require(msg.sender == address($._oov3), "only oov3");

        uint256 jobId = $._assertionToJob[assertionId];
        Job storage job = $._jobs[jobId];
        require(
            job.phase == JobPhase.Asserting || job.phase == JobPhase.Disputed,
            "invalid phase for callback"
        );

        if (assertedTruthfully) {
            SettlementType st = job.phase == JobPhase.Disputed
                ? SettlementType.DisputeAgentWon
                : SettlementType.Unchallenged;

            job.phase = JobPhase.Completed;
            job.settlement = st;
            job.updatedAt = block.timestamp;

            uint256 agentPayout = job.agreedPrice;

            if (st == SettlementType.DisputeAgentWon) {
                uint256 bonus = job.assertionBond / 2;
                agentPayout = job.agreedPrice + bonus;
            }

            _safePayoutOrPend($, job.agentOwner, agentPayout, jobId);

            emit JobSettled(jobId, job.agentId, st, agentPayout, 0);
        } else {
            job.phase = JobPhase.Refunded;
            job.settlement = SettlementType.DisputeClientWon;
            job.updatedAt = block.timestamp;

            uint256 clientRefund = job.agreedPrice - job.assertionBond;

            _safePayoutOrPend($, job.client, clientRefund, jobId);

            emit JobSettled(jobId, job.agentId, SettlementType.DisputeClientWon, 0, clientRefund);
        }
    }

    function assertionDisputedCallback(bytes32 assertionId) external {
        BazaarStorage storage $ = _getBazaarStorage();
        require(msg.sender == address($._oov3), "only oov3");

        uint256 jobId = $._assertionToJob[assertionId];
        Job storage job = $._jobs[jobId];
        require(job.phase == JobPhase.Asserting, "not asserting");

        job.phase = JobPhase.Disputed;
        job.updatedAt = block.timestamp;

        emit JobDisputed(jobId, assertionId);
    }

    // ============================================================
    //  Permissionless
    // ============================================================

    /// @notice Trigger OOv3 settlement for a job whose liveness has expired.
    function settleAssertion(uint256 jobId) external {
        BazaarStorage storage $ = _getBazaarStorage();
        Job storage job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        require(
            job.phase == JobPhase.Asserting || job.phase == JobPhase.Disputed,
            "not settleable"
        );
        $._oov3.settleAssertion(job.assertionId);
    }

    /// @notice Claim pending withdrawals that failed during OOv3 callback.
    function claimPending() external nonReentrant {
        BazaarStorage storage $ = _getBazaarStorage();
        uint256 amount = $._pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to claim");
        $._pendingWithdrawals[msg.sender] = 0;
        $._paymentToken.safeTransfer(msg.sender, amount);
        emit PendingClaimed(msg.sender, amount);
    }

    function pendingWithdrawals(address account) external view returns (uint256) {
        return _getBazaarStorage()._pendingWithdrawals[account];
    }

    // ============================================================
    //  Admin
    // ============================================================

    function setAcceptTimeout(uint256 newTimeout) external onlyOwner {
        _getBazaarStorage()._acceptTimeout = newTimeout;
    }

    function setSubmitTimeout(uint256 newTimeout) external onlyOwner {
        _getBazaarStorage()._submitTimeout = newTimeout;
    }

    function setOov3Liveness(uint64 newLiveness) external onlyOwner {
        _getBazaarStorage()._oov3Liveness = newLiveness;
    }

    function setBondRate(uint256 newRate) external onlyOwner {
        require(newRate > 0 && newRate <= 10000, "bad bond rate");
        BazaarStorage storage $ = _getBazaarStorage();
        $._bondRate = newRate;
        uint256 minimumBond = $._oov3.getMinimumBond(address($._paymentToken));
        $._minServiceFee = (minimumBond * 10000) / newRate;
    }

    function setIdentityRegistry(address identityRegistry_) external onlyOwner {
        require(identityRegistry_ != address(0), "bad identity");
        _identityRegistry = identityRegistry_;
    }

    function setOov3(address oov3_) external onlyOwner {
        require(oov3_ != address(0), "bad oov3");
        BazaarStorage storage $ = _getBazaarStorage();
        $._oov3 = IOptimisticOracleV3(oov3_);
        uint256 minimumBond = IOptimisticOracleV3(oov3_).getMinimumBond(address($._paymentToken));
        require(minimumBond > 0, "token not approved by new OOv3");
        $._minServiceFee = (minimumBond * 10000) / $._bondRate;
    }

    function setPaymentToken(address paymentToken_) external onlyOwner {
        require(paymentToken_ != address(0), "bad token");
        BazaarStorage storage $ = _getBazaarStorage();
        uint256 minimumBond = $._oov3.getMinimumBond(paymentToken_);
        require(minimumBond > 0, "token not approved by OOv3");
        $._paymentToken = IERC20(paymentToken_);
        $._minServiceFee = (minimumBond * 10000) / $._bondRate;
    }

    /// @notice Rescue native BNB stuck in the contract (e.g. legacy v1-v2 payments).
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad address");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    /// @notice Rescue ERC20 tokens accidentally sent to the contract (not paymentToken held for active jobs).
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad address");
        IERC20(token).safeTransfer(to, amount);
    }

    // ============================================================
    //  Internal — Safe Payout (callback-safe)
    // ============================================================

    /// @dev Transfer tokens to recipient. If transfer fails, queue for manual claim.
    ///      This prevents OOv3 settleAssertion from reverting due to a transfer failure.
    function _safePayoutOrPend(
        BazaarStorage storage $,
        address recipient,
        uint256 amount,
        uint256 jobId
    ) internal {
        if (amount == 0) return;
        // solhint-disable-next-line no-empty-blocks
        try $._paymentToken.transfer(recipient, amount) returns (bool success) {
            if (!success) {
                $._pendingWithdrawals[recipient] += amount;
                emit TransferFailed(recipient, amount, jobId);
            }
        } catch {
            $._pendingWithdrawals[recipient] += amount;
            emit TransferFailed(recipient, amount, jobId);
        }
    }

    // ============================================================
    //  Internal — Claim Builder
    // ============================================================

    function _buildClaim(
        Job storage job,
        string calldata dataUrl
    ) internal view returns (bytes memory) {
        return abi.encodePacked(
            "Agent service for Job #",
            _uint2str(job.jobId),
            " on Agent Bazaar completed satisfactorily. "
            "Agent ID: ", _uint2str(job.agentId),
            ". Negotiation request hash: ", _bytes32ToHex(job.negotiationRequestHash),
            ". Negotiation response hash: ", _bytes32ToHex(job.negotiationResponseHash),
            ". Service record hash: ", _bytes32ToHex(job.serviceRecordHash),
            ". Evidence: ", dataUrl,
            ". Contract: ", _addressToHex(address(this)),
            ". Verify: download evidence, check keccak256 matches serviceRecordHash, judge quality."
        );
    }

    function _uint2str(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
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
        bytes memory str = new bytes(42); // "0x" + 40 hex chars
        str[0] = "0";
        str[1] = "x";
        bytes20 addrBytes = bytes20(addr);
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(addrBytes[i] >> 4)];
            str[3 + i * 2] = alphabet[uint8(addrBytes[i] & 0x0f)];
        }
        return string(str);
    }

    // ============================================================
    //  LEGACY — Deprecated write functions (revert with message)
    // ============================================================

    function lockPayment(uint256) external payable returns (bytes32) {
        revert Deprecated("Use createJobAndLock()");
    }

    function releasePayment(bytes32) external pure {
        revert Deprecated("Use OOv3 settlement");
    }

    function setMinPayment(uint256) external pure {
        revert Deprecated("Use minServiceFee via setBondRate()");
    }

    // ============================================================
    //  LEGACY — Read-only functions (backward compatible)
    // ============================================================

    function getPayment(bytes32 paymentId)
        external
        view
        returns (address client, uint256 agentId, uint256 amount, bool released, uint256 timestamp)
    {
        LegacyEscrowStorage storage $ = _getLegacyEscrowStorage();
        LegacyPayment memory p = $._payments[paymentId];
        require(p.client != address(0), "payment not found");
        return (p.client, p.agentId, p.amount, p.released, p.timestamp);
    }

    function getAgentPayments(uint256 agentId) external view returns (bytes32[] memory) {
        return _getLegacyEscrowStorage()._agentPayments[agentId];
    }

    function getClientPayments(address client) external view returns (bytes32[] memory) {
        return _getLegacyEscrowStorage()._clientPayments[client];
    }
}
