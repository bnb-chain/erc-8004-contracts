// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IIdentityRegistry {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/**
 * @title EscrowUpgradeable
 * @dev ERC-8004 trustless escrow for agent payments (UUPS upgradeable).
 * Funds are locked until released by the client (agent caller).
 */
contract EscrowUpgradeable is OwnableUpgradeable, UUPSUpgradeable {
    struct Payment {
        address client;
        uint256 agentId;
        uint256 amount;
        bool released;
        uint256 timestamp;
    }

    /// @dev Identity registry address stored at slot 0 (matches MinimalUUPS / other registries)
    address private _identityRegistry;

    /// @custom:storage-location erc7201:erc8004.escrow.registry
    struct EscrowStorage {
        mapping(bytes32 => Payment) _payments;
        mapping(uint256 => bytes32[]) _agentPayments;
        mapping(address => bytes32[]) _clientPayments;
        uint256 _minPayment; // minimum payment amount (default 10 gwei)
    }

    // keccak256(abi.encode(uint256(keccak256("erc8004.escrow.registry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ESCROW_STORAGE_LOCATION =
        0x105551c4ee449a31443722016be6b9fc9f89d45ec427fbae7a17a5658a172100;

    function _getEscrowStorage()
        private
        pure
        returns (EscrowStorage storage $)
    {
        assembly {
            $.slot := ESCROW_STORAGE_LOCATION
        }
    }

    event PaymentLocked(
        bytes32 indexed paymentId,
        address indexed client,
        uint256 indexed agentId,
        uint256 amount
    );

    event PaymentReleased(
        bytes32 indexed paymentId,
        address indexed client,
        uint256 indexed agentId,
        address agentOwner,
        uint256 amount
    );

    event PaymentRefunded(
        bytes32 indexed paymentId,
        address indexed client,
        uint256 amount
    );

    event MinPaymentSet(uint256 oldMinPayment, uint256 newMinPayment);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address identityRegistry_
    ) public reinitializer(2) onlyOwner {
        require(identityRegistry_ != address(0), "bad identity");
        _identityRegistry = identityRegistry_;
        EscrowStorage storage $ = _getEscrowStorage();
        if ($._minPayment == 0) $._minPayment = 10 gwei;
    }

    function getIdentityRegistry() external view returns (address) {
        return _identityRegistry;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    /**
     * @dev Set minimum payment amount. Only owner.
     * @param newMinPayment New minimum in wei (must be > 0).
     */
    function setMinPayment(uint256 newMinPayment) external onlyOwner {
        require(newMinPayment > 0, "min payment must be > 0");
        EscrowStorage storage $ = _getEscrowStorage();
        uint256 oldMinPayment = $._minPayment;
        $._minPayment = newMinPayment;
        emit MinPaymentSet(oldMinPayment, newMinPayment);
    }

    /**
     * @dev Lock payment for agent usage
     * @param agentId The agent identifier
     * @return paymentId The unique payment identifier
     */
    function lockPayment(
        uint256 agentId
    ) external payable returns (bytes32 paymentId) {
        EscrowStorage storage $ = _getEscrowStorage();
        require(msg.value >= $._minPayment, "amount below minimum");
        require(
            IIdentityRegistry(_identityRegistry).ownerOf(agentId) != address(0),
            "agent not found"
        );

        paymentId = keccak256(
            abi.encodePacked(msg.sender, agentId, block.timestamp, block.number)
        );
        require(
            $._payments[paymentId].client == address(0),
            "payment ID collision"
        );

        $._payments[paymentId] = Payment({
            client: msg.sender,
            agentId: agentId,
            amount: msg.value,
            released: false,
            timestamp: block.timestamp
        });

        $._agentPayments[agentId].push(paymentId);
        $._clientPayments[msg.sender].push(paymentId);

        emit PaymentLocked(paymentId, msg.sender, agentId, msg.value);
    }

    /**
     * @dev Release payment to agent owner.
     * Only the client who locked the payment can release it.
     */
    function releasePayment(bytes32 paymentId) external {
        EscrowStorage storage $ = _getEscrowStorage();
        Payment storage payment = $._payments[paymentId];
        require(payment.client != address(0), "payment not found");
        require(
            payment.client == msg.sender,
            "only client can release payment"
        );
        _releasePayment($, paymentId);
    }

    function _releasePayment(
        EscrowStorage storage $,
        bytes32 paymentId
    ) internal {
        Payment storage payment = $._payments[paymentId];
        require(payment.client != address(0), "payment not found");
        require(!payment.released, "payment already released");

        address agentOwner = IIdentityRegistry(_identityRegistry).ownerOf(
            payment.agentId
        );
        require(agentOwner != address(0), "agent owner not found");

        payment.released = true;
        (bool success, ) = payable(agentOwner).call{value: payment.amount}("");
        require(success, "transfer failed");

        emit PaymentReleased(
            paymentId,
            payment.client,
            payment.agentId,
            agentOwner,
            payment.amount
        );
    }

    function getPayment(
        bytes32 paymentId
    )
        external
        view
        returns (
            address client,
            uint256 agentId,
            uint256 amount,
            bool released,
            uint256 timestamp
        )
    {
        EscrowStorage storage $ = _getEscrowStorage();
        Payment memory payment = $._payments[paymentId];
        require(payment.client != address(0), "payment not found");
        return (
            payment.client,
            payment.agentId,
            payment.amount,
            payment.released,
            payment.timestamp
        );
    }

    function getAgentPayments(
        uint256 agentId
    ) external view returns (bytes32[] memory) {
        return _getEscrowStorage()._agentPayments[agentId];
    }

    function getClientPayments(
        address client
    ) external view returns (bytes32[] memory) {
        return _getEscrowStorage()._clientPayments[client];
    }

    function getClientLockedPayments(
        address client
    ) external view returns (bytes32[] memory) {
        EscrowStorage storage $ = _getEscrowStorage();
        bytes32[] memory allPayments = $._clientPayments[client];
        uint256 lockedCount = 0;
        for (uint256 i = 0; i < allPayments.length; i++) {
            if (!$._payments[allPayments[i]].released) lockedCount++;
        }
        bytes32[] memory lockedPayments = new bytes32[](lockedCount);
        uint256 index = 0;
        for (uint256 i = 0; i < allPayments.length; i++) {
            if (!$._payments[allPayments[i]].released) {
                lockedPayments[index] = allPayments[i];
                index++;
            }
        }
        return lockedPayments;
    }

    function getMinPayment() external view returns (uint256) {
        return _getEscrowStorage()._minPayment;
    }
}
