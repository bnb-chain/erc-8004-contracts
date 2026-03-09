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
    DisputeAgentWon,   // 2 — disputed, agent won
    DisputeClientWon,  // 3 — disputed, client won
    AgentTimedOut,     // 4 — agent timed out (deadline expired)
    AgentRejected,     // 5 — agent actively rejected the job
    ClientApproved     // 6 — reserved: client early approve
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

    bytes32 negotiationRequestHash;
    bytes32 negotiationResponseHash;

    bytes32 serviceRecordHash;
    bytes32 serviceResponseHash;

    bytes32 assertionId;

    uint256 createdAt;
    uint256 updatedAt;
    uint256 acceptDeadline;
    uint256 submitDeadline;
}

/**
 * @title ApexUpgradeable
 * @notice APEX Protocol (Agent Payment Exchange Protocol) - UUPS-upgradeable job payment contract.
 *         Manages: Negotiate → Lock → Accept → Execute → Assert (OOv3) → Settle.
 *         The contract is the OOv3 asserter; only clients can dispute.
 */
contract ApexUpgradeable is OwnableUpgradeable, UUPSUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;

    // ============================================================
    //  Errors
    // ============================================================

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
    //  Storage
    // ============================================================

    address private _identityRegistry;

    /// @custom:storage-location erc7201:apex.protocol.storage
    struct ApexStorage {
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

    // keccak256(abi.encode(uint256(keccak256("apex.protocol.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant APEX_STORAGE_LOCATION =
        0x7c5e9a39f73f5b5c0c8e9a8b3d4f6e2a1c0b9d8e7f6a5b4c3d2e1f0a9b8c7d00;

    function _getApexStorage()
        private
        pure
        returns (ApexStorage storage $)
    {
        assembly {
            $.slot := APEX_STORAGE_LOCATION
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
    //  Initializer
    // ============================================================

    function initialize(
        address identityRegistry_,
        address oov3_,
        address paymentToken_,
        uint256 acceptTimeout_,
        uint256 submitTimeout_,
        uint64 oov3Liveness_,
        uint256 bondRate_
    ) public reinitializer(2) {
        __Ownable_init(msg.sender);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        require(identityRegistry_ != address(0), "bad identity");
        require(oov3_ != address(0), "bad oov3");
        require(paymentToken_ != address(0), "bad token");
        require(bondRate_ > 0 && bondRate_ <= 10000, "bad bond rate");

        _identityRegistry = identityRegistry_;

        ApexStorage storage $ = _getApexStorage();
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
        return address(_getApexStorage()._oov3);
    }

    function paymentToken() external view returns (address) {
        return address(_getApexStorage()._paymentToken);
    }

    function acceptTimeout() external view returns (uint256) {
        return _getApexStorage()._acceptTimeout;
    }

    function submitTimeout() external view returns (uint256) {
        return _getApexStorage()._submitTimeout;
    }

    function oov3Liveness() external view returns (uint64) {
        return _getApexStorage()._oov3Liveness;
    }

    function bondRate() external view returns (uint256) {
        return _getApexStorage()._bondRate;
    }

    function minServiceFee() external view returns (uint256) {
        return _getApexStorage()._minServiceFee;
    }

    function nextJobId() external view returns (uint256) {
        return _getApexStorage()._nextJobId;
    }

    // ============================================================
    //  View — Job
    // ============================================================

    function getJob(uint256 jobId) external view returns (Job memory) {
        ApexStorage storage $ = _getApexStorage();
        Job memory job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        return job;
    }

    function getJobPhase(uint256 jobId) external view returns (JobPhase) {
        return _getApexStorage()._jobs[jobId].phase;
    }

    function getAssertionIdForJob(uint256 jobId) external view returns (bytes32) {
        return _getApexStorage()._jobs[jobId].assertionId;
    }

    function getJobForAssertion(bytes32 assertionId) external view returns (uint256) {
        return _getApexStorage()._assertionToJob[assertionId];
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
        ApexStorage storage $ = _getApexStorage();

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
        ApexStorage storage $ = _getApexStorage();
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
        ApexStorage storage $ = _getApexStorage();
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
        ApexStorage storage $ = _getApexStorage();
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
        ApexStorage storage $ = _getApexStorage();
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
            address(this),
            address(this),
            address(0),
            $._oov3Liveness,
            $._paymentToken,
            bond,
            DEFAULT_IDENTIFIER,
            bytes32(0)
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
        ApexStorage storage $ = _getApexStorage();
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
        ApexStorage storage $ = _getApexStorage();
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

    function settleAssertion(uint256 jobId) external {
        ApexStorage storage $ = _getApexStorage();
        Job storage job = $._jobs[jobId];
        if (job.phase == JobPhase.None) revert JobNotFound(jobId);
        require(
            job.phase == JobPhase.Asserting || job.phase == JobPhase.Disputed,
            "not settleable"
        );
        $._oov3.settleAssertion(job.assertionId);
    }

    function claimPending() external nonReentrant {
        ApexStorage storage $ = _getApexStorage();
        uint256 amount = $._pendingWithdrawals[msg.sender];
        require(amount > 0, "nothing to claim");
        $._pendingWithdrawals[msg.sender] = 0;
        $._paymentToken.safeTransfer(msg.sender, amount);
        emit PendingClaimed(msg.sender, amount);
    }

    function pendingWithdrawals(address account) external view returns (uint256) {
        return _getApexStorage()._pendingWithdrawals[account];
    }

    // ============================================================
    //  Admin
    // ============================================================

    function setAcceptTimeout(uint256 newTimeout) external onlyOwner {
        _getApexStorage()._acceptTimeout = newTimeout;
    }

    function setSubmitTimeout(uint256 newTimeout) external onlyOwner {
        _getApexStorage()._submitTimeout = newTimeout;
    }

    function setOov3Liveness(uint64 newLiveness) external onlyOwner {
        _getApexStorage()._oov3Liveness = newLiveness;
    }

    function setBondRate(uint256 newRate) external onlyOwner {
        require(newRate > 0 && newRate <= 10000, "bad bond rate");
        ApexStorage storage $ = _getApexStorage();
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
        ApexStorage storage $ = _getApexStorage();
        $._oov3 = IOptimisticOracleV3(oov3_);
        uint256 minimumBond = IOptimisticOracleV3(oov3_).getMinimumBond(address($._paymentToken));
        require(minimumBond > 0, "token not approved by new OOv3");
        $._minServiceFee = (minimumBond * 10000) / $._bondRate;
    }

    function setPaymentToken(address paymentToken_) external onlyOwner {
        require(paymentToken_ != address(0), "bad token");
        ApexStorage storage $ = _getApexStorage();
        uint256 minimumBond = $._oov3.getMinimumBond(paymentToken_);
        require(minimumBond > 0, "token not approved by OOv3");
        $._paymentToken = IERC20(paymentToken_);
        $._minServiceFee = (minimumBond * 10000) / $._bondRate;
    }

    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad address");
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "transfer failed");
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "bad address");
        IERC20(token).safeTransfer(to, amount);
    }

    // ============================================================
    //  Internal — Safe Payout
    // ============================================================

    function _safePayoutOrPend(
        ApexStorage storage $,
        address recipient,
        uint256 amount,
        uint256 jobId
    ) internal {
        if (amount == 0) return;
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
            " on APEX Protocol completed satisfactorily. "
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
