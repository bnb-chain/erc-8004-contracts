// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IACPHook.sol";

/**
 * @title AgenticCommerceUpgradeable
 * @notice Pure EIP-8183 Agentic Commerce Protocol - UUPS-upgradeable implementation
 * @dev Job escrow with evaluator attestation for agent commerce.
 *      State machine: Open → Funded → Submitted → Terminal (Completed/Rejected/Expired)
 * 
 * Key features:
 *   - Full EIP-8183 compliance
 *   - Optional per-job hooks (IACPHook)
 *   - Safe payout with pending withdrawals fallback
 */
contract AgenticCommerceUpgradeable is
    OwnableUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;

    // ============================================================
    //  Constants
    // ============================================================

    uint256 public constant HOOK_GAS_LIMIT = 1_000_000;
    uint256 public constant MAX_EXPIRY_DURATION = 365 days;

    // ============================================================
    //  Enums
    // ============================================================

    enum Status {
        None,       // 0 - does not exist
        Open,       // 1 - created, not funded
        Funded,     // 2 - escrowed, awaiting submission
        Submitted,  // 3 - work submitted, awaiting evaluation
        Completed,  // 4 - terminal: provider paid
        Rejected,   // 5 - terminal: client refunded
        Expired     // 6 - terminal: client refunded (timeout)
    }

    // ============================================================
    //  Structs
    // ============================================================

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

    // ============================================================
    //  Storage (ERC-7201 Namespaced)
    // ============================================================

    /// @custom:storage-location erc7201:acp.protocol.storage
    struct ACPStorage {
        mapping(uint256 => Job) _jobs;
        uint256 _nextJobId;
        IERC20 _paymentToken;
        uint256 _minBudget;
        mapping(address => uint256) _pendingWithdrawals;
    }

    // keccak256(abi.encode(uint256(keccak256("acp.protocol.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ACP_STORAGE_LOCATION =
        0x1cbbc7782f686ce40c6c84c345bf826a48795095b45328411e4ddf56ef218f00;

    function _getACPStorage() private pure returns (ACPStorage storage $) {
        assembly {
            $.slot := ACP_STORAGE_LOCATION
        }
    }

    // ============================================================
    //  Errors
    // ============================================================

    error JobNotFound(uint256 jobId);
    error InvalidStatus(uint256 jobId, Status expected, Status actual);
    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error NotClientOrProvider();
    error InvalidEvaluator();
    error InvalidExpiry();
    error InvalidProvider();
    error ProviderAlreadySet();
    error ProviderNotSet();
    error BudgetNotSet();
    error BudgetMismatch();
    error BudgetTooLow(uint256 amount, uint256 minimum);
    error NotExpired();
    error NotRefundable();
    error HookCallFailed();
    error NothingToClaim();

    // ============================================================
    //  Events (per EIP-8183)
    // ============================================================

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address provider,
        address evaluator,
        uint256 expiredAt
    );
    event ProviderSet(uint256 indexed jobId, address provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event TransferFailed(address indexed recipient, uint256 amount, uint256 jobId);
    event PendingClaimed(address indexed recipient, uint256 amount);
    event PaymentTokenUpdated(address indexed oldToken, address indexed newToken);

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

    /**
     * @notice Initialize the contract
     * @param owner_ Contract owner address
     * @param paymentToken_ ERC20 token for payments
     * @param minBudget_ Minimum budget for jobs (0 for no minimum)
     */
    function initialize(
        address owner_,
        address paymentToken_,
        uint256 minBudget_
    ) public initializer {
        __Ownable_init(owner_);
        __UUPSUpgradeable_init();
        __ReentrancyGuard_init();

        require(paymentToken_ != address(0), "invalid token");

        ACPStorage storage $ = _getACPStorage();
        $._paymentToken = IERC20(paymentToken_);
        $._minBudget = minBudget_;
        $._nextJobId = 1;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ============================================================
    //  View — Config
    // ============================================================

    function paymentToken() external view returns (address) {
        return address(_getACPStorage()._paymentToken);
    }

    function minBudget() external view returns (uint256) {
        return _getACPStorage()._minBudget;
    }

    function nextJobId() external view returns (uint256) {
        return _getACPStorage()._nextJobId;
    }

    // ============================================================
    //  View — Job
    // ============================================================

    function getJob(uint256 jobId) external view returns (Job memory) {
        ACPStorage storage $ = _getACPStorage();
        Job memory job = $._jobs[jobId];
        if (job.status == Status.None) revert JobNotFound(jobId);
        return job;
    }

    function getJobStatus(uint256 jobId) external view returns (Status) {
        return _getACPStorage()._jobs[jobId].status;
    }

    // ============================================================
    //  Core Functions — Job Creation
    // ============================================================

    /**
     * @notice Create a new job
     * @param provider Provider address (can be zero, set later via setProvider)
     * @param evaluator Evaluator address (cannot be zero)
     * @param expiredAt Expiry timestamp (must be in future, within MAX_EXPIRY_DURATION)
     * @param description Job description
     * @param hook Optional hook contract address (can be zero)
     * @return jobId The created job ID
     */
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        if (evaluator == address(0)) revert InvalidEvaluator();
        if (expiredAt <= block.timestamp) revert InvalidExpiry();
        if (expiredAt > block.timestamp + MAX_EXPIRY_DURATION) revert InvalidExpiry();

        ACPStorage storage $ = _getACPStorage();
        jobId = $._nextJobId++;

        Job storage job = $._jobs[jobId];
        job.client = msg.sender;
        job.provider = provider;
        job.evaluator = evaluator;
        job.hook = hook;
        job.expiredAt = expiredAt;
        job.status = Status.Open;
        job.description = description;

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt);
    }

    // ============================================================
    //  Core Functions — Setup (Open state only)
    // ============================================================

    /**
     * @notice Set provider for a job created without one
     * @param jobId Job ID
     * @param provider Provider address (cannot be zero)
     * @param optParams Optional parameters forwarded to hook
     */
    function setProvider(
        uint256 jobId,
        address provider,
        bytes calldata optParams
    ) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);
        if (job.status != Status.Open) revert InvalidStatus(jobId, Status.Open, job.status);
        if (msg.sender != job.client) revert NotClient();
        if (job.provider != address(0)) revert ProviderAlreadySet();
        if (provider == address(0)) revert InvalidProvider();

        bytes memory hookData = abi.encode(provider, optParams);

        _callHook(job.hook, jobId, this.setProvider.selector, hookData, true);

        job.provider = provider;

        _callHook(job.hook, jobId, this.setProvider.selector, hookData, false);

        emit ProviderSet(jobId, provider);
    }

    /**
     * @notice Set or update budget (client or provider can call)
     * @param jobId Job ID
     * @param amount Budget amount
     * @param optParams Optional parameters forwarded to hook
     */
    function setBudget(
        uint256 jobId,
        uint256 amount,
        bytes calldata optParams
    ) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);
        if (job.status != Status.Open) revert InvalidStatus(jobId, Status.Open, job.status);
        if (msg.sender != job.client && msg.sender != job.provider) {
            revert NotClientOrProvider();
        }

        bytes memory hookData = abi.encode(amount, optParams);

        _callHook(job.hook, jobId, this.setBudget.selector, hookData, true);

        job.budget = amount;

        _callHook(job.hook, jobId, this.setBudget.selector, hookData, false);

        emit BudgetSet(jobId, amount);
    }

    // ============================================================
    //  Core Functions — Funding
    // ============================================================

    /**
     * @notice Fund the job escrow
     * @param jobId Job ID
     * @param expectedBudget Expected budget (front-running protection)
     * @param optParams Optional parameters forwarded to hook
     */
    function fund(
        uint256 jobId,
        uint256 expectedBudget,
        bytes calldata optParams
    ) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);
        if (job.status != Status.Open) revert InvalidStatus(jobId, Status.Open, job.status);
        if (msg.sender != job.client) revert NotClient();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget == 0) revert BudgetNotSet();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (job.budget < $._minBudget) revert BudgetTooLow(job.budget, $._minBudget);

        _callHook(job.hook, jobId, this.fund.selector, optParams, true);

        job.status = Status.Funded;
        $._paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);

        _callHook(job.hook, jobId, this.fund.selector, optParams, false);

        emit JobFunded(jobId, msg.sender, job.budget);
    }

    // ============================================================
    //  Core Functions — Submission
    // ============================================================

    /**
     * @notice Provider submits work for evaluation
     * @param jobId Job ID
     * @param deliverable Reference to work (hash, CID, etc.)
     * @param optParams Optional parameters forwarded to hook
     */
    function submit(
        uint256 jobId,
        bytes32 deliverable,
        bytes calldata optParams
    ) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);
        if (job.status != Status.Funded) revert InvalidStatus(jobId, Status.Funded, job.status);
        if (msg.sender != job.provider) revert NotProvider();

        bytes memory hookData = abi.encode(deliverable, optParams);

        _callHook(job.hook, jobId, this.submit.selector, hookData, true);

        job.deliverable = deliverable;
        job.status = Status.Submitted;

        _callHook(job.hook, jobId, this.submit.selector, hookData, false);

        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    // ============================================================
    //  Core Functions — Evaluation
    // ============================================================

    /**
     * @notice Evaluator marks job as completed, releasing payment to provider
     * @param jobId Job ID
     * @param reason Optional attestation hash
     * @param optParams Optional parameters forwarded to hook
     */
    function complete(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);
        if (job.status != Status.Submitted) {
            revert InvalidStatus(jobId, Status.Submitted, job.status);
        }
        if (msg.sender != job.evaluator) revert NotEvaluator();

        bytes memory hookData = abi.encode(reason, optParams);

        _callHook(job.hook, jobId, this.complete.selector, hookData, true);

        job.status = Status.Completed;

        // Transfer full budget to provider (pure EIP-8183, no platform fee)
        _safePayoutOrPend($, job.provider, job.budget, jobId);

        _callHook(job.hook, jobId, this.complete.selector, hookData, false);

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    /**
     * @notice Reject the job, refunding client
     * @dev Client can reject when Open; Evaluator can reject when Funded or Submitted
     * @param jobId Job ID
     * @param reason Optional rejection reason
     * @param optParams Optional parameters forwarded to hook
     */
    function reject(
        uint256 jobId,
        bytes32 reason,
        bytes calldata optParams
    ) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);

        bytes memory hookData = abi.encode(reason, optParams);

        if (job.status == Status.Open) {
            // Only client can reject when Open
            if (msg.sender != job.client) revert NotClient();

            _callHook(job.hook, jobId, this.reject.selector, hookData, true);

            job.status = Status.Rejected;

            _callHook(job.hook, jobId, this.reject.selector, hookData, false);
        } else if (job.status == Status.Funded || job.status == Status.Submitted) {
            // Only evaluator can reject when Funded or Submitted
            if (msg.sender != job.evaluator) revert NotEvaluator();

            _callHook(job.hook, jobId, this.reject.selector, hookData, true);

            job.status = Status.Rejected;

            // Refund escrowed funds
            _safePayoutOrPend($, job.client, job.budget, jobId);

            _callHook(job.hook, jobId, this.reject.selector, hookData, false);

            emit Refunded(jobId, job.client, job.budget);
        } else {
            revert NotRefundable();
        }

        emit JobRejected(jobId, msg.sender, reason);
    }

    // ============================================================
    //  Core Functions — Timeout Refund (NOT hookable)
    // ============================================================

    /**
     * @notice Claim refund after job expiry
     * @dev Anyone can call to trigger refund. NOT hookable (safety mechanism).
     * @param jobId Job ID
     */
    function claimRefund(uint256 jobId) external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        Job storage job = $._jobs[jobId];

        if (job.status == Status.None) revert JobNotFound(jobId);
        if (job.status != Status.Funded && job.status != Status.Submitted) {
            revert NotRefundable();
        }
        if (block.timestamp < job.expiredAt) revert NotExpired();

        job.status = Status.Expired;
        $._paymentToken.safeTransfer(job.client, job.budget);

        emit JobExpired(jobId);
        emit Refunded(jobId, job.client, job.budget);
    }

    // ============================================================
    //  Pending Withdrawals
    // ============================================================

    /**
     * @notice Claim pending withdrawals
     */
    function claimPending() external nonReentrant {
        ACPStorage storage $ = _getACPStorage();
        uint256 amount = $._pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToClaim();

        $._pendingWithdrawals[msg.sender] = 0;
        $._paymentToken.safeTransfer(msg.sender, amount);

        emit PendingClaimed(msg.sender, amount);
    }

    function pendingWithdrawals(address account) external view returns (uint256) {
        return _getACPStorage()._pendingWithdrawals[account];
    }

    // ============================================================
    //  Admin Functions
    // ============================================================

    function setMinBudget(uint256 minBudget_) external onlyOwner {
        _getACPStorage()._minBudget = minBudget_;
    }

    /**
     * @notice Update the payment token address
     * @dev Only callable by owner. Use with caution:
     *      - Existing funded/submitted jobs will still use the old token for payouts
     *      - New jobs will use the new token
     *      - Ensure no active jobs exist before changing token in production
     * @param newToken New ERC20 payment token address
     */
    function setPaymentToken(address newToken) external onlyOwner {
        require(newToken != address(0), "invalid token");
        ACPStorage storage $ = _getACPStorage();
        address oldToken = address($._paymentToken);
        $._paymentToken = IERC20(newToken);
        emit PaymentTokenUpdated(oldToken, newToken);
    }

    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "invalid address");
        IERC20(token).safeTransfer(to, amount);
    }

    // ============================================================
    //  Internal — Hook Execution
    // ============================================================

    function _callHook(
        address hook,
        uint256 jobId,
        bytes4 selector,
        bytes memory data,
        bool isBefore
    ) internal {
        if (hook == address(0)) return;

        bytes memory payload = isBefore
            ? abi.encodeCall(IACPHook.beforeAction, (jobId, selector, data))
            : abi.encodeCall(IACPHook.afterAction, (jobId, selector, data));

        (bool success, bytes memory returnData) = hook.call{gas: HOOK_GAS_LIMIT}(payload);

        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            revert HookCallFailed();
        }
    }

    // ============================================================
    //  Internal — Safe Payout
    // ============================================================

    function _safePayoutOrPend(
        ACPStorage storage $,
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
}
